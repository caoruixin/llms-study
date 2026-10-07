import { describe, expect, it } from 'vitest'
import {
  assignPointsToStrips,
  columnExtents,
  hasPdfLayout,
  isLabelLike,
  isProseLayout,
  labelContextOf,
  needsLayoutReparse,
  partitionPageFlow,
  pickCurrentBlock,
  pickNearestBlock,
  insertionPushesReader,
  planFontFit,
  scaleRect,
  segmentsOnPage,
  splitTranslation,
  translationBounds,
  visibleBlockRange,
  type BlockEdges,
  type FlowRow,
  type PageGeom,
  type PortionRect,
  type Rect,
  type Strip,
} from './pdfLayout'
import type { PaperBlock, PaperBlockKind, PdfColumn, PdfLayoutSeg, PdfLineBox } from './types'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 页面尺寸（CSS 空间，scale = 1）与合成行的行高 / 行距 */
const W = 600
const H = 800
const LH = 10
const PITCH = 12

/** 从 top 起自上而下 n 行，行高 lh、行距 pitch */
const lines = (x: number, w: number, top: number, n: number, lh = LH, pitch = PITCH): Rect[] =>
  Array.from({ length: n }, (_, i) => ({ x, y: top + i * pitch, w, h: lh }))

const union = (rs: readonly Rect[]): Rect => {
  const x0 = Math.min(...rs.map((r) => r.x))
  const y0 = Math.min(...rs.map((r) => r.y))
  const x1 = Math.max(...rs.map((r) => r.x + r.w))
  const y1 = Math.max(...rs.map((r) => r.y + r.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** CSS 空间的段落片（partitionPageFlow 等不经过 segmentsOnPage） */
const portion = (blockIndex: number, col: PdfColumn, ls: Rect[], seg: [number, number] = [0, 1]): PortionRect => ({
  blockIndex,
  segIndex: seg[0],
  segCount: seg[1],
  col,
  rect: union(ls),
  lines: ls,
  prose: true,
  label: false,
})

const left = (i: number, top: number, n: number, seg?: [number, number]) => portion(i, 'left', lines(50, 240, top, n), seg)
const right = (i: number, top: number, n: number, seg?: [number, number]) => portion(i, 'right', lines(310, 240, top, n), seg)
const span = (i: number, top: number, n: number) => portion(i, 'span', lines(50, 500, top, n))
const full = (i: number, top: number, n: number) => portion(i, 'full', lines(60, 480, top, n))

const bottomOf = (p: PortionRect): number => p.rect.y + p.rect.h
/** 测试侧镜像：prev.bottom + clamp(gap/2, 0, 0.6·行高) */
const cutAfter = (prev: PortionRect, nextTop: number): number =>
  bottomOf(prev) + Math.max(0, Math.min((nextTop - bottomOf(prev)) / 2, 0.6 * LH))

/** 用户空间行框 → PdfLayoutSeg（segmentsOnPage 用） */
const seg = (page: number, col: PdfColumn, ls: PdfLineBox[]): PdfLayoutSeg => ({ page, col, lines: ls })
const block = (index: number, kind: PaperBlockKind, text: string, segs?: PdfLayoutSeg[]): PaperBlock => ({
  id: `p:${index}`,
  paperId: 'p',
  index,
  kind,
  text,
  anchor: { kind: 'pdf', blockIndex: index, page: segs?.[0]?.page },
  ...(segs ? { layout: { segs } } : {}),
})

// ---------------------------------------------------------------------------
// 不变量
// ---------------------------------------------------------------------------

const domStrips = (rows: readonly FlowRow[]): Strip[] =>
  rows.flatMap((r) => (r.kind === 'full' ? [r.strip] : [...r.left, ...r.right]))

const rowSpan = (r: FlowRow): [number, number] =>
  r.kind === 'full' ? [r.strip.rect.y, r.strip.rect.y + r.strip.rect.h] : [r.top, r.bottom]

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9)

/** 一叠条带首尾相接铺满 [top, bottom)，x / w 固定 */
const expectStack = (strips: readonly Strip[], x: number, w: number, top: number, bottom: number) => {
  expect(strips.length).toBeGreaterThan(0)
  near(strips[0].rect.y, top)
  for (let i = 0; i < strips.length; i += 1) {
    const r = strips[i].rect
    expect(r.x).toBe(x)
    expect(r.w).toBe(w)
    expect(r.h).toBeGreaterThan(0)
    if (i > 0) near(strips[i - 1].rect.y + strips[i - 1].rect.h, r.y)
  }
  const last = strips[strips.length - 1].rect
  near(last.y + last.h, bottom)
}

/** 三条不变量：铺满（含列条带 x 固定）、无重叠、阅读序；外加 key 唯一 */
const assertInvariants = (rows: readonly FlowRow[]) => {
  expect(rows.length).toBeGreaterThan(0)
  // 铺满：行首尾相接 0 → H
  near(rowSpan(rows[0])[0], 0)
  for (let i = 1; i < rows.length; i += 1) near(rowSpan(rows[i - 1])[1], rowSpan(rows[i])[0])
  near(rowSpan(rows[rows.length - 1])[1], H)
  let area = 0
  for (const r of rows) {
    if (r.kind === 'full') {
      expect(r.strip.rect.x).toBe(0)
      expect(r.strip.rect.w).toBe(W)
      expect(r.strip.rect.h).toBeGreaterThan(0)
      area += r.strip.rect.w * r.strip.rect.h
    } else {
      expect(r.bottom).toBeGreaterThan(r.top)
      expectStack(r.left, 0, r.split, r.top, r.bottom)
      expectStack(r.right, r.split, W - r.split, r.top, r.bottom)
      for (const s of [...r.left, ...r.right]) area += s.rect.w * s.rect.h
    }
  }
  // 无重叠：首尾相接 + 正高已保证；面积和 = 页面积再兜一次底
  near(area, W * H)
  const strips = domStrips(rows)
  for (let i = 0; i < strips.length; i += 1) {
    for (let j = i + 1; j < strips.length; j += 1) {
      const a = strips[i].rect
      const b = strips[j].rect
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      expect(ox <= 1e-9 || oy <= 1e-9).toBe(true)
    }
  }
  // 阅读序：DOM 序的 blockIndex 非递减
  const order = strips.map((s) => s.blockIndex).filter((i): i is number => i !== undefined)
  for (let i = 1; i < order.length; i += 1) expect(order[i]).toBeGreaterThanOrEqual(order[i - 1])
  // 无块条带不挂译文
  for (const s of strips) if (s.blockIndex === undefined) expect(s.showTranslation).toBe(false)
  // key 唯一（行之间、条带之间各自唯一；full 行的 key 就是它那条条带的 key）
  const rowKeys = rows.map((r) => r.key)
  expect(new Set(rowKeys).size).toBe(rowKeys.length)
  const stripKeys = strips.map((s) => s.key)
  expect(new Set(stripKeys).size).toBe(stripKeys.length)
  expect(stripKeys.every((k) => k.startsWith('3:'))).toBe(true)
}

const stripsOf = (rows: readonly FlowRow[], blockIndex: number): Strip[] =>
  domStrips(rows).filter((s) => s.blockIndex === blockIndex)

const PAGE = { pageWidth: W, pageHeight: H, page: 3 }

// ---------------------------------------------------------------------------
// hasPdfLayout / needsLayoutReparse
// ---------------------------------------------------------------------------

describe('hasPdfLayout / needsLayoutReparse', () => {
  const withLayout = [block(0, 'paragraph', 'a', [seg(1, 'full', [[50, 700, 250, 12]])])]
  const without = [block(0, 'paragraph', 'a'), block(1, 'paragraph', 'b')]

  it('任一块带非空 layout 即有版面；空数组 / 无 layout / 空 segs 都没有', () => {
    expect(hasPdfLayout(withLayout)).toBe(true)
    expect(hasPdfLayout(without)).toBe(false)
    expect(hasPdfLayout([])).toBe(false)
    expect(hasPdfLayout([{ layout: { segs: [] } }])).toBe(false)
  })

  it('needsLayoutReparse = pdf ∧ ready ∧ 有块 ∧ 无 layout（不看 parserVersion）', () => {
    expect(needsLayoutReparse({ format: 'pdf', status: 'ready' }, without)).toBe(true)
    expect(needsLayoutReparse({ format: 'pdf', status: 'ready' }, withLayout)).toBe(false)
    expect(needsLayoutReparse({ format: 'pdf', status: 'parsing' }, without)).toBe(false)
    expect(needsLayoutReparse({ format: 'docx', status: 'ready' }, without)).toBe(false)
    expect(needsLayoutReparse({ format: 'pdf', status: 'ready' }, [])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// segmentsOnPage / columnExtents
// ---------------------------------------------------------------------------

describe('segmentsOnPage', () => {
  it('rawDims 原点非零：cssX = x − pageX，cssY = pageY + pageHeight − yTop', () => {
    const geom: PageGeom = { pageX: 10, pageY: 20, pageWidth: 600, pageHeight: 800 }
    const blocks = [block(0, 'paragraph', 'Hello world text here', [seg(1, 'full', [[50, 700, 250, 12]])])]
    const [p] = segmentsOnPage(blocks, 1, geom)
    expect(p.rect).toEqual({ x: 40, y: 120, w: 200, h: 12 })
    expect(p.lines).toEqual([{ x: 40, y: 120, w: 200, h: 12 }])
    expect(p.col).toBe('full')
    expect(p.blockIndex).toBe(0)
  })

  it('多 seg：同页跨栏两片 segIndex 0/1、segCount 2；跨页块在第 2 页是 segIndex 1', () => {
    const geom: PageGeom = { pageX: 0, pageY: 0, pageWidth: 600, pageHeight: 800 }
    const blocks = [
      block(0, 'paragraph', 'cross column paragraph text', [
        seg(1, 'left', [[50, 100, 290, 10], [50, 88, 290, 10]]),
        seg(1, 'right', [[310, 780, 550, 10]]),
      ]),
      block(1, 'paragraph', 'cross page paragraph text', [
        seg(1, 'right', [[310, 100, 550, 10]]),
        seg(2, 'left', [[50, 780, 290, 10]]),
      ]),
      block(2, 'paragraph', 'no layout at all'),
    ]
    const page1 = segmentsOnPage(blocks, 1, geom)
    expect(page1.map((p) => [p.blockIndex, p.segIndex, p.segCount, p.col])).toEqual([
      [0, 0, 2, 'left'],
      [0, 1, 2, 'right'],
      [1, 0, 2, 'right'],
    ])
    expect(page1[0].rect).toEqual({ x: 50, y: 700, w: 240, h: 22 })
    const page2 = segmentsOnPage(blocks, 2, geom)
    expect(page2.map((p) => [p.blockIndex, p.segIndex, p.segCount])).toEqual([[1, 1, 2]])
    expect(segmentsOnPage(blocks, 3, geom)).toEqual([])
  })

  it('prose 按栏宽判：双栏页左栏段落填满栏 → true；table → false；无双栏时用全页行框并集宽', () => {
    const geom: PageGeom = { pageX: 0, pageY: 0, pageWidth: 600, pageHeight: 800 }
    const text = 'The quick brown fox jumps over the lazy dog and keeps running across the open field'
    const twoCol = [
      block(0, 'paragraph', text, [seg(1, 'left', [[50, 700, 290, 10], [50, 688, 290, 10], [50, 676, 200, 10]])]),
      block(1, 'table', '1 2 3', [seg(1, 'right', [[310, 700, 550, 10], [310, 688, 550, 10]])]),
    ]
    const ps = segmentsOnPage(twoCol, 1, geom)
    expect(ps.map((p) => p.prose)).toEqual([true, false])
    expect(ps.map((p) => p.label)).toEqual([false, false])
    // 单栏页：三行只占全页并集宽的 40% → 填充不足 → false
    const narrow = [
      block(0, 'paragraph', text, [seg(1, 'full', [[60, 700, 540, 10]])]),
      block(1, 'paragraph', text, [seg(1, 'full', [[60, 600, 250, 10], [60, 588, 250, 10], [60, 576, 250, 10]])]),
    ]
    expect(segmentsOnPage(narrow, 1, geom).map((p) => p.prose)).toEqual([true, false])
  })
})

describe('segmentsOnPage × label', () => {
  it('页级上下文取本页全部段落片：插图里的孤立短行、粘连标签 = true；正文段落、紧贴正文的单行 = false', () => {
    const geom: PageGeom = { pageX: 0, pageY: 0, pageWidth: 600, pageHeight: 800 }
    const text = 'The quick brown fox jumps over the lazy dog and keeps running across the open field'
    const blocks = [
      block(0, 'paragraph', text, [seg(1, 'full', [[60, 760, 540, 10], [60, 748, 540, 10], [60, 736, 540, 10]])]),
      // 插图标签：离上方正文 ≈ 136px、离下方图注 ≈ 90px
      block(1, 'paragraph', 'AI R&D', [seg(1, 'full', [[280, 590, 330, 10]])]),
      block(2, 'paragraph', 'Figure 1. The mechanism', [seg(1, 'full', [[60, 490, 540, 10]])]),
      // 紧跟图注的单行短正文（贴左缘）
      block(3, 'paragraph', 'Evidence', [seg(1, 'full', [[60, 476, 120, 10]])]),
      // 粘连标签：同块两片各一行（左栏贴边 + 右栏贴边，规则 2）
      block(4, 'paragraph', 'can perform AI R&D more AI R&D', [
        seg(1, 'left', [[60, 300, 200, 10]]),
        seg(1, 'right', [[310, 300, 400, 10]]),
      ]),
      // 两栏正文：左右栏各 3 行（给本页定出栏界）
      block(5, 'paragraph', text, [seg(1, 'left', [[60, 280, 290, 10], [60, 268, 290, 10], [60, 256, 290, 10]])]),
      block(6, 'paragraph', text, [seg(1, 'right', [[310, 280, 540, 10], [310, 268, 540, 10], [310, 256, 540, 10]])]),
    ]
    expect(segmentsOnPage(blocks, 1, geom).map((p) => [p.blockIndex, p.label])).toEqual([
      [0, false],
      [1, true],
      [2, false],
      [3, false],
      [4, true],
      [4, true],
      [5, false],
      [6, false],
    ])
  })
})

describe('columnExtents', () => {
  it('双栏：各栏 x 并集，split 取左栏右缘与右栏左缘中点', () => {
    const ext = columnExtents([left(0, 10, 2), right(1, 10, 2), span(2, 100, 1), portion(3, 'left', lines(40, 100, 200, 1))])
    expect(ext).toEqual({ left: [40, 290], right: [310, 550], split: 300 })
  })

  it('单侧缺失 / 只有通栏 / 空 → null', () => {
    expect(columnExtents([left(0, 10, 2), span(1, 100, 1)])).toBeNull()
    expect(columnExtents([right(0, 10, 2)])).toBeNull()
    expect(columnExtents([full(0, 10, 2), span(1, 100, 1)])).toBeNull()
    expect(columnExtents([])).toBeNull()
  })
})

describe('translationBounds', () => {
  // 页文字范围 x 50–550；左栏 50–290、右栏 310–550
  const portions = [
    portion(0, 'span', lines(200, 200, 20, 1)), // 图内副标题（heading，单行通栏）200–400
    portion(1, 'span', lines(150, 300, 50, 1)), // 单行通栏段落 150–450
    portion(2, 'span', [
      { x: 50, y: 80, w: 470, h: LH },
      { x: 90, y: 92, w: 425, h: LH },
      { x: 90, y: 104, w: 110, h: LH },
    ]), // 3 行通栏图注，自身右缘 520
    portion(3, 'left', lines(50, 70, 150, 1)), // 左栏单行短尾 50–120
    left(4, 200, 2),
    right(5, 200, 2),
    portion(6, 'right', lines(310, 70, 240, 1)), // 右栏 heading 310–380
  ]
  const kinds = new Map<number, PaperBlockKind>([[0, 'heading'], [6, 'heading']])
  const kindOf = (i: number) => kinds.get(i) ?? 'paragraph'

  it('标题与单行 span 保留自身宽度；多行 span 伸到全页文字右缘；左 / 右栏片伸到栏右缘', () => {
    const b = translationBounds(portions, kindOf)
    expect(b.get(0)).toEqual([200, 400]) // heading：自身宽度
    expect(b.get(6)).toEqual([310, 380]) // 栏内 heading 同样不伸
    expect(b.get(1)).toEqual([150, 450]) // 单行 span：自身宽度
    expect(b.get(2)).toEqual([50, 550]) // 3 行 span：520 → 全页文字右缘 550
    expect(b.get(3)).toEqual([50, 290]) // 单行 left：120 → 左栏右缘 290
    expect(b.get(4)).toEqual([50, 290])
    expect(b.get(5)).toEqual([310, 550])
  })

  it('只给最后一片；不传 kindOf 时栏内标题按栏片处理（伸到栏右缘）', () => {
    const b = translationBounds([left(0, 10, 2, [0, 2]), right(0, 10, 2, [1, 2]), portion(6, 'right', lines(310, 70, 60, 1))])
    expect(b.get(0)).toEqual([310, 550])
    expect(b.get(6)).toEqual([310, 550])
    expect(translationBounds([])).toEqual(new Map())
  })
})

// ---------------------------------------------------------------------------
// isProseLayout
// ---------------------------------------------------------------------------

describe('isProseLayout', () => {
  const COL = 240
  const prose = 'The quick brown fox jumps over the lazy dog and keeps running across the open field for a while'

  it('段落：左对齐、行距行高规整、填满栏 → true', () => {
    const ls = [...lines(50, 240, 10, 3), ...lines(50, 150, 46, 1)]
    expect(isProseLayout(ls, 'paragraph', COL, prose)).toBe(true)
  })

  it('首行缩进不作数 → true', () => {
    const ls = [{ x: 68, y: 10, w: 222, h: LH }, ...lines(50, 240, 22, 3)]
    expect(isProseLayout(ls, 'paragraph', COL, prose)).toBe(true)
  })

  it('居中公式行：单行符号占比过高 → false；两行居中填不满栏 → false', () => {
    expect(isProseLayout(lines(120, 100, 10, 1), 'paragraph', COL, 'Σ wᵢ xᵢ = y + b (3)')).toBe(false)
    const centered = [{ x: 120, y: 10, w: 100, h: LH }, { x: 125, y: 22, w: 90, h: LH }]
    expect(isProseLayout(centered, 'paragraph', COL, 'where alpha equals beta plus gamma')).toBe(false)
  })

  it('表格数字行：数字 / 符号占比 > 35% → false', () => {
    expect(isProseLayout(lines(50, 240, 10, 3), 'paragraph', COL, '12.3 45.6 78.9 0.12 34.5 67.8')).toBe(false)
  })

  it('单行标题 → true', () => {
    expect(isProseLayout(lines(50, 120, 10, 1), 'heading', COL, '3 Method')).toBe(true)
  })

  it('kind = table / code / formula / image → false，不看几何', () => {
    for (const kind of ['table', 'code', 'formula', 'image'] as const) {
      expect(isProseLayout(lines(50, 240, 10, 3), kind, COL, prose)).toBe(false)
    }
  })

  it('作者块（各行居中、x0 不齐）/ 行距跳变 / 行高混杂 / 空行 / 空文本 → false', () => {
    const authors = [{ x: 100, y: 10, w: 200, h: LH }, { x: 150, y: 22, w: 150, h: LH }, { x: 120, y: 34, w: 180, h: LH }]
    expect(isProseLayout(authors, 'paragraph', COL, 'Alice Smith and Bob Jones, University of Somewhere')).toBe(false)
    const gap = [...lines(50, 240, 10, 2), ...lines(50, 240, 60, 2)]
    expect(isProseLayout(gap, 'paragraph', COL, prose)).toBe(false)
    const mixed = [{ x: 50, y: 10, w: 240, h: 16 }, ...lines(50, 240, 30, 2)]
    expect(isProseLayout(mixed, 'paragraph', COL, prose)).toBe(false)
    expect(isProseLayout([], 'paragraph', COL, prose)).toBe(false)
    expect(isProseLayout(lines(50, 240, 10, 2), 'paragraph', COL, '   ')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isLabelLike（图内孤立短标签：原版视图不就地译）
// ---------------------------------------------------------------------------

describe('isLabelLike', () => {
  // 一页双栏：左栏正文 [100, 218]、留白（插图）、左栏正文 [400, 518]；右栏正文铺满 [100, 518]。
  // 左栏 x ∈ [50, 290]（栏宽 240，10% = 24），右栏 x ∈ [310, 550]，全页文字范围 [50, 550]（宽 500）。
  const above = left(0, 100, 10)
  const below = left(1, 400, 10)
  const rightBody = right(2, 100, 35)
  const page = (...extra: PortionRect[]) => [above, below, rightBody, ...extra]
  const is = (p: PortionRect, all: readonly PortionRect[], text: string, kind: PaperBlockKind = 'paragraph') =>
    isLabelLike(p, labelContextOf(all), text, kind)
  /** 一行（单片块）：默认贴左栏左缘、宽 60——只有规则 1（孤立）能命中，规则 3（离栏）不会 */
  const line1 = (i: number, top: number, col: PdfColumn = 'left', x = 50, w = 60, seg?: [number, number]) =>
    portion(i, col, [{ x, y: top, w, h: LH }], seg)

  describe('规则 1：孤立短标签', () => {
    it('插图留白里的孤立短行 → true（右栏同高的正文不算邻居）', () => {
      const l = line1(9, 300)
      expect(is(l, page(l), 'Incentivize')).toBe(true)
    })

    it('正文里的列表行：紧挨上下行 → false；即便孤立，以列表符号 / 编号起头也 → false', () => {
      const item = line1(9, bottomOf(above) + 2, 'left', 50, 200)
      const next = line1(10, item.rect.y + PITCH, 'left', 50, 200)
      expect(is(item, page(item, next), '• Obtain visibility')).toBe(false)
      // 没有列表符号、但上下各紧贴一行 → 仍不孤立
      expect(is(item, page(item, next), 'Obtain visibility')).toBe(false)
      const lone = line1(9, 300)
      for (const t of ['• item', '- item', '– item', '* item', '1. item', '2) item']) {
        expect(is(lone, page(lone), t)).toBe(false)
      }
    })

    it('孤立的单行图注（Figure 2. / Fig. 3 / Table 1 / 图 4 / 表 5）→ false：图注是正文，照常翻译', () => {
      const cap = line1(9, 300)
      for (const t of ['Figure 2. Overview', 'Fig. 3 Results', 'table 1: data', '图 4 架构', '表5 结果']) {
        expect(is(cap, page(cap), t)).toBe(false)
      }
    })

    it('heading → false（标题进目录，就地照译）；同样几何的 paragraph → true', () => {
      const h = line1(9, 300)
      expect(is(h, page(h), 'Evidence', 'heading')).toBe(false)
      expect(is(h, page(h), 'Evidence')).toBe(true)
    })

    it('长单行（≥ 60 字符）→ false；两行 / 块的另一片不在本页 → false', () => {
      const l = line1(9, 300, 'left', 50, 240)
      const long = 'AI R&D automation creates a feedback loop, leading to ever-improving AIs'
      expect(long.length).toBeGreaterThanOrEqual(60)
      expect(is(l, page(l), long)).toBe(false)
      expect(is(l, page(l), long.slice(0, 59))).toBe(true)
      const twoLines = portion(9, 'left', lines(50, 240, 300, 2))
      expect(is(twoLines, page(twoLines), 'AI R&D')).toBe(false)
      const otherPage = line1(9, 300, 'left', 50, 60, [1, 2])
      expect(is(otherPage, page(otherPage), 'AI R&D')).toBe(false)
    })

    it('一侧没有邻居、另一侧 1 行距内紧贴一行 → false（两侧都要孤立）', () => {
      // 栏顶单行：上方无邻居，下方 2px 处紧贴一段
      const top = line1(9, 20)
      const para = left(10, 20 + LH + 2, 5)
      expect(is(top, [top, para], 'Overview')).toBe(false)
      // 栏底单行：下方无邻居，上方紧贴
      const end = line1(9, bottomOf(below) + 2)
      expect(is(end, page(end), 'Overview')).toBe(false)
      // 两侧都空 → 孤立
      expect(is(top, [top], 'Overview')).toBe(true)
      // 恰好 2.5 行高 → 不算孤立（须严格远于）；再远一点 → 孤立
      expect(is(top, [top, left(10, 20 + LH + 2.5 * LH, 3)], 'Overview')).toBe(false)
      expect(is(top, [top, left(10, 20 + LH + 2.5 * LH + 1, 3)], 'Overview')).toBe(true)
    })

    it('通栏片的邻居按横向交叠算：正下方的左栏正文算，横向错开的不算；左栏短行也认正上 / 下方的通栏片', () => {
      const band = line1(9, 300, 'span')
      const under = portion(10, 'left', lines(50, 240, 300 + LH + 3, 3))
      expect(is(band, page(band, under), 'Humans')).toBe(false)
      const aside = portion(10, 'left', lines(150, 100, 300 + LH + 3, 3))
      expect(is(band, page(band, aside), 'Humans')).toBe(true)
      const l = line1(11, 300)
      const caption = span(12, 300 + LH + 3, 2)
      expect(is(l, page(l, caption), 'Build')).toBe(false)
    })
  })

  describe('规则 2：粘连标签（≥ 2 片、整块 < 120 字符、每片 1 行或通栏 / 栏内混排）', () => {
    // 同一 y 上散在几栏的图内标签被拼成一块；各片都贴栏左缘、彼此紧挨（规则 1 / 3 都不命中）
    const X: Record<PdfColumn, number> = { left: 50, span: 50, full: 50, right: 310 }
    const glued = (segs: [PdfColumn, number][] = [['left', 1], ['span', 1], ['right', 1]]) =>
      segs.map(([col, k], i) => portion(20, col, lines(X[col], 200, 250 + i * PITCH * 4, k), [i, segs.length]))
    const TEXT = 'More AI R&D leads Humans An expanding R&D workforce'

    it('左 / 通栏 / 右各一行 → 每片都 true；左右两片各一行 → true', () => {
      const g = glued()
      for (const p of g) expect(is(p, page(...g), TEXT)).toBe(true)
      const two = glued([['left', 1], ['right', 1]])
      expect(is(two[0], page(...two), 'can perform AI R&D more AI R&D')).toBe(true)
    })

    it('通栏片与栏内片混在一块（主样本 left 3 行 → span 1 行 → right 2 行）→ true', () => {
      const g = glued([['left', 3], ['span', 1], ['right', 2]])
      for (const p of g) expect(is(p, page(...g), TEXT)).toBe(true)
    })

    it('真正的跨栏段落（left → right、多行）/ 整块 ≥ 120 字符 / 块的片不全在本页 → false', () => {
      const para = glued([['left', 2], ['right', 1]])
      expect(is(para[1], page(...para), TEXT)).toBe(false)
      const g = glued()
      expect(is(g[0], page(...g), 'x'.repeat(120))).toBe(false)
      expect(is(g[0], page(g[0], g[1]), TEXT)).toBe(false)
    })

    it('豁免照旧：heading / 图注 / 列表符号', () => {
      const g = glued()
      expect(is(g[0], page(...g), TEXT, 'heading')).toBe(false)
      expect(is(g[0], page(...g), 'Figure 2. The mechanism')).toBe(false)
      expect(is(g[0], page(...g), '1. First item continues')).toBe(false)
    })
  })

  describe('规则 3：离栏短文本（每片 ≤ 2 行、整块 < 120 字符、每行离栏左缘 > 10% 且窄于 80% 栏宽）', () => {
    const SUB = 'AI R&D automation creates a feedback loop, leading to ever-improving AIs'

    it('图内居中副标题（通栏、72 字符、紧挨上下内容）→ true；两行居中 → true', () => {
      // 全页文字范围 [50, 550]：x 150 离左缘 20%，宽 300 = 60%
      const sub = portion(9, 'span', [{ x: 150, y: 300, w: 300, h: LH }])
      const near = portion(10, 'span', [{ x: 200, y: 300 - LH - 2, w: 200, h: LH }])
      expect(is(sub, page(sub, near), SUB)).toBe(true)
      const two = portion(9, 'left', lines(120, 100, 300, 2))
      expect(is(two, page(two), 'More AI R&D leads to better AIs')).toBe(true)
    })

    it('首行缩进 6% 的单行正文 → false；贴栏左缘的两端对齐两行段落 → false', () => {
      const indented = portion(9, 'left', [{ x: 50 + 0.06 * 240, y: 300, w: 0.7 * 240, h: LH }])
      expect(is(indented, page(indented), SUB)).toBe(false)
      const justified = portion(9, 'left', lines(50, 240, 300, 2))
      expect(is(justified, page(justified), 'A short two-line paragraph that sits flush at the column edge.')).toBe(false)
    })

    it('任一行贴栏左缘 / 任一行宽 ≥ 80% 栏宽 / 3 行 / 整块 ≥ 120 字符 → false', () => {
      const mixed = portion(9, 'left', [
        { x: 120, y: 300, w: 100, h: LH },
        { x: 50, y: 300 + PITCH, w: 100, h: LH },
      ])
      expect(is(mixed, page(mixed), SUB)).toBe(false)
      const wide = portion(9, 'left', [{ x: 80, y: 300, w: 200, h: LH }])
      expect(is(wide, page(wide), SUB)).toBe(false)
      const three = portion(9, 'left', lines(120, 100, 300, 3))
      expect(is(three, page(three), SUB)).toBe(false)
      const sub = portion(9, 'span', [{ x: 150, y: 300, w: 300, h: LH }])
      expect(is(sub, page(sub), 'y'.repeat(120))).toBe(false)
    })

    it('悬挂缩进续行（紧贴在贴栏左缘的多行正文正下方，如参考文献尾行「DOI: … (cit. on p. 5).」）→ false', () => {
      // 右栏正文之下：条目 [17] 两行贴右栏左缘，下方 2px 处是缩进 12% 的尾行（右栏 x ∈ [310, 550]）
      const entry = portion(30, 'right', lines(310, 240, 560, 2))
      const tail = portion(31, 'right', [{ x: 310 + 0.12 * 240, y: bottomOf(entry) + 2, w: 110, h: LH }])
      const all = [above, below, rightBody, entry, tail]
      expect(is(tail, all, 'Sep. 2026 (cit. on pp. 2, 7).')).toBe(false)
      // 同样的尾行若离上方正文超过 1 行高（插图与正文之间的留白）→ 仍是离栏短文本
      const far = portion(31, 'right', [{ x: 310 + 0.12 * 240, y: bottomOf(entry) + LH + 1, w: 110, h: LH }])
      expect(is(far, [above, below, rightBody, entry, far], 'Sep. 2026 (cit. on pp. 2, 7).')).toBe(true)
      // 上方紧贴的是另一个图内标签（单行 / 本身离栏）→ 不算「母段」，照样是标签
      const tag = portion(32, 'right', [{ x: 400, y: 560, w: 60, h: LH }])
      const query = portion(33, 'right', [{ x: 340, y: 560 + LH + 2, w: 40, h: LH }])
      expect(is(query, [above, below, rightBody, tag, query], 'Query')).toBe(true)
    })

    it('左 / 右栏片按该栏行盒并集量（不按全页）：右栏里离右栏左缘 > 10% 的短行 → true，贴右栏左缘 → false', () => {
      const offR = portion(9, 'right', [{ x: 310 + 60, y: 560, w: 100, h: LH }])
      expect(is(offR, page(offR), SUB)).toBe(true)
      const flushR = portion(9, 'right', [{ x: 310, y: 560, w: 100, h: LH }])
      expect(is(flushR, page(flushR), SUB)).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// scaleRect
// ---------------------------------------------------------------------------

describe('scaleRect', () => {
  it('四条边先乘后取整，w/h 由取整后的边相减', () => {
    expect(scaleRect({ x: 10.2, y: 20.6, w: 100.3, h: 50.1 }, 1.5)).toEqual({ x: 15, y: 31, w: 151, h: 75 })
    expect(scaleRect({ x: 0, y: 0, w: W, h: H }, 1)).toEqual({ x: 0, y: 0, w: W, h: H })
  })
})

// ---------------------------------------------------------------------------
// pickCurrentBlock / visibleBlockRange
// ---------------------------------------------------------------------------

describe('pickCurrentBlock / visibleBlockRange', () => {
  const edges: BlockEdges[] = [
    { blockIndex: 3, top: 300, bottom: 400 },
    { blockIndex: 0, top: 0, bottom: 100 },
    { blockIndex: 2, top: 200, bottom: 300 },
    { blockIndex: 1, top: 100, bottom: 200 },
  ]

  it('与带相交者中序号最小；入参无序也行', () => {
    expect(pickCurrentBlock(edges, 150, 250)).toBe(1)
    expect(pickCurrentBlock(edges, 95, 105)).toBe(0)
    expect(pickCurrentBlock(edges, 250, 350)).toBe(2)
  })

  it('零面积相切不算相交（块底 == 带顶 归下一块）；带外 → undefined', () => {
    expect(pickCurrentBlock(edges, 100, 150)).toBe(1)
    expect(pickCurrentBlock(edges, 400, 500)).toBeUndefined()
    expect(pickCurrentBlock([], 0, 100)).toBeUndefined()
  })

  it('visibleBlockRange：相交块的 min / max；无 → null', () => {
    expect(visibleBlockRange(edges, 150, 350)).toEqual({ min: 1, max: 3 })
    expect(visibleBlockRange(edges, 0, 1000)).toEqual({ min: 0, max: 3 })
    expect(visibleBlockRange(edges, 500, 600)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// partitionPageFlow —— 八个合成页，每例断言三不变量
// ---------------------------------------------------------------------------

describe('pickNearestBlock（观察带落空时的兜底）', () => {
  const e = (blockIndex: number, top: number, bottom: number) => ({ blockIndex, top, bottom })
  it('带里没有块：报底边在带顶之上、离带最近的那块（刚读过的）', () => {
    expect(pickNearestBlock([e(3, 0, 40), e(4, 50, 90), e(9, 400, 500)], 100, 200)).toBe(4)
  })
  it('双栏同高的两块底边一样：取序号大的（读到更后面）', () => {
    expect(pickNearestBlock([e(4, 0, 90), e(7, 10, 90)], 100, 200)).toBe(7)
  })
  it('上方没有块：报带下方最近的一块', () => {
    expect(pickNearestBlock([e(12, 600, 700), e(11, 300, 380)], 100, 200)).toBe(11)
  })
  it('与带相交的块不参与（那是 pickCurrentBlock 的事）；全空 → undefined', () => {
    expect(pickNearestBlock([e(1, 90, 150)], 100, 200)).toBeUndefined()
    expect(pickNearestBlock([], 100, 200)).toBeUndefined()
  })
})

describe('insertionPushesReader（对照流译文延后挂出的判定）', () => {
  const pane = { top: 100, bottom: 900 }
  const bandTop = 120 // 视线 = 窗格顶 + 20
  it('双栏行与窗格相交、插入点在视线之上 → 会推动读者（延后）', () => {
    expect(insertionPushesReader({ stripBottom: 60, row: { top: -400, bottom: 1500 } }, pane, bandTop)).toBe(true)
  })
  it('跳转对齐在 +16 的目标块：它上一块的底边正好贴在 +16 → 也算视线之上（否则目标被推出观察带）', () => {
    expect(insertionPushesReader({ stripBottom: 116, row: { top: -400, bottom: 1500 } }, pane, bandTop)).toBe(true)
  })
  it('插入点在视线之下（读者正看着它 / 它在下方）→ 不延后', () => {
    expect(insertionPushesReader({ stripBottom: 121, row: { top: -400, bottom: 1500 } }, pane, bandTop)).toBe(false)
    expect(insertionPushesReader({ stripBottom: 700, row: { top: -400, bottom: 1500 } }, pane, bandTop)).toBe(false)
  })
  it('通栏条带（单栏页 / 跨栏块，row = null）→ 不延后（整体位移交给锚定）', () => {
    expect(insertionPushesReader({ stripBottom: 60, row: null }, pane, bandTop)).toBe(false)
  })
  it('所在双栏行整个在窗格之上 / 之下 → 不延后', () => {
    expect(insertionPushesReader({ stripBottom: 20, row: { top: -900, bottom: 100 } }, pane, bandTop)).toBe(false)
    expect(insertionPushesReader({ stripBottom: 20, row: { top: 900, bottom: 1700 } }, pane, bandTop)).toBe(false)
  })
})

describe('partitionPageFlow', () => {
  it('1. 单栏 3 段：每段一个 full 行，首行从 0、末行到页底，相邻用 cut（段间距中点）', () => {
    const a = full(0, 50, 5)
    const b = full(1, 120, 5)
    const c = full(2, 200, 5)
    const rows = partitionPageFlow(PAGE, [a, b, c])
    assertInvariants(rows)
    expect(rows.map((r) => r.kind)).toEqual(['full', 'full', 'full'])
    const strips = domStrips(rows)
    expect(strips.map((s) => s.blockIndex)).toEqual([0, 1, 2])
    expect(strips[0].rect.y).toBe(0)
    near(strips[0].rect.h, cutAfter(a, b.rect.y))
    near(strips[1].rect.y, cutAfter(a, b.rect.y))
    near(strips[2].rect.y, cutAfter(b, c.rect.y))
    near(strips[2].rect.y + strips[2].rect.h, H)
    expect(strips.every((s) => s.showTranslation)).toBe(true)
    expect(strips[0].key).toBe('3:full:0')
  })

  it('2. 双栏 + 中间通栏图注 → columns / full / columns；带边界对最近内容求 cut', () => {
    const l1 = left(0, 10, 5)
    const r1 = right(1, 10, 5)
    const cap = span(2, 300, 2)
    const l2 = left(3, 350, 36)
    const r2 = right(4, 350, 36)
    const rows = partitionPageFlow(PAGE, [l1, r1, cap, l2, r2])
    assertInvariants(rows)
    expect(rows.map((r) => r.kind)).toEqual(['columns', 'full', 'columns'])
    const [top, mid, bot] = rows
    if (top.kind !== 'columns' || mid.kind !== 'full' || bot.kind !== 'columns') throw new Error('unreachable')
    expect(top.split).toBe(300)
    near(top.bottom, cutAfter(l1, cap.rect.y))
    expect(mid.strip.blockIndex).toBe(2)
    near(mid.strip.rect.y + mid.strip.rect.h, cutAfter(cap, l2.rect.y))
    expect(top.left.map((s) => s.blockIndex)).toEqual([0])
    expect(top.right.map((s) => s.blockIndex)).toEqual([1])
    expect(bot.left.map((s) => s.blockIndex)).toEqual([3])
    expect(bot.right.map((s) => s.blockIndex)).toEqual([4])
    expect(domStrips(rows).map((s) => s.blockIndex)).toEqual([0, 1, 2, 3, 4])
    expect(mid.key).toBe(mid.strip.key)
    expect(top.key).toBe('3:cols:0')
  })

  it('3. 跨栏块（左栏底 → 右栏顶）：译文只挂在右栏那条（最后一个 seg），左栏那条不挂', () => {
    const l1 = left(0, 10, 10)
    const l2 = left(1, 140, 50, [0, 2])
    const r1 = right(1, 10, 3, [1, 2])
    const r2 = right(2, 60, 55)
    const rows = partitionPageFlow(PAGE, [l1, l2, r1, r2])
    assertInvariants(rows)
    const [row] = rows
    if (row.kind !== 'columns') throw new Error('unreachable')
    expect(row.left.map((s) => [s.blockIndex, s.showTranslation])).toEqual([
      [0, true],
      [1, false],
    ])
    expect(row.right.map((s) => [s.blockIndex, s.showTranslation])).toEqual([
      [1, true],
      [2, true],
    ])
    // isTranslatable 谓词（查看器传 isTranslatableBlock ∧ 文本非空）
    const gated = partitionPageFlow(PAGE, [l1, l2, r1, r2], { isTranslatable: (i) => i !== 1 })
    assertInvariants(gated)
    const blockStrips = domStrips(gated).filter((s) => s.blockIndex !== undefined)
    expect(blockStrips.map((s) => s.showTranslation)).toEqual([true, false, false, true])
  })

  it('4. 列内大空隙（插图）归下一条带：前块条带只多 0.6 行高', () => {
    const a = left(0, 10, 5)
    const b = left(1, 400, 32) // 底 782，距行底 18 < 2 行高 → 不出 trailing
    const r = right(2, 10, 64)
    const rows = partitionPageFlow(PAGE, [a, b, r])
    assertInvariants(rows)
    const [row] = rows
    if (row.kind !== 'columns') throw new Error('unreachable')
    expect(row.left.map((s) => s.blockIndex)).toEqual([0, 1])
    near(row.left[0].rect.h, bottomOf(a) + 0.6 * LH)
    near(row.left[1].rect.y, bottomOf(a) + 0.6 * LH)
    expect(row.left[1].rect.h).toBeGreaterThan(300)
  })

  it('5. 列末插图：末块后剩余 > 2 行高 → 无块 trailing 条带，译文紧跟文字', () => {
    const a = left(0, 10, 5)
    const r = right(1, 10, 64)
    const rows = partitionPageFlow(PAGE, [a, r])
    assertInvariants(rows)
    const [row] = rows
    if (row.kind !== 'columns') throw new Error('unreachable')
    expect(row.left.map((s) => [s.blockIndex, s.showTranslation])).toEqual([
      [0, true],
      [undefined, false],
    ])
    near(row.left[0].rect.h, bottomOf(a) + 0.6 * LH)
    near(row.left[1].rect.y + row.left[1].rect.h, row.bottom)
    // 剩余不足 2 行高 → 末条带延伸到行底，不加 trailing
    const tight = partitionPageFlow(PAGE, [left(0, 10, 65), r])
    assertInvariants(tight)
    const [row2] = tight
    if (row2.kind !== 'columns') throw new Error('unreachable')
    expect(row2.left.map((s) => s.blockIndex)).toEqual([0])
  })

  it('6. 页眉 / 页脚独立成无块 full 行；不足 2 行高则并入 columns 行', () => {
    const spaced = partitionPageFlow(PAGE, [left(0, 60, 30), right(1, 60, 29)])
    assertInvariants(spaced)
    expect(spaced.map((r) => r.kind)).toEqual(['full', 'columns', 'full'])
    const [header, body, footer] = spaced
    if (header.kind !== 'full' || body.kind !== 'columns' || footer.kind !== 'full') throw new Error('unreachable')
    expect(header.strip.blockIndex).toBeUndefined()
    expect(header.strip.showTranslation).toBe(false)
    near(header.strip.rect.h, 60 - 0.6 * LH)
    expect(footer.strip.blockIndex).toBeUndefined()
    near(footer.strip.rect.y, bottomOf(left(0, 60, 30)) + 0.6 * LH)
    near(footer.strip.rect.y + footer.strip.rect.h, H)
    // 页眉只有 20 − 6 = 14 < 20、页脚 800 − 781 = 19 < 20 → 都并入
    const tight = partitionPageFlow(PAGE, [left(0, 20, 63), right(1, 20, 10)])
    assertInvariants(tight)
    expect(tight.map((r) => r.kind)).toEqual(['columns'])
    const [only] = tight
    if (only.kind !== 'columns') throw new Error('unreachable')
    expect(only.top).toBe(0)
    expect(only.bottom).toBe(H)
  })

  it('7. 一侧空列：该侧整段一个无块 trailing 条带（下半页右栏被整幅插图占满）', () => {
    // 左栏末块底 788，距页底不足 2 行高 → 无页脚行
    const rows = partitionPageFlow(PAGE, [left(0, 10, 5), right(1, 10, 5), span(2, 100, 1), left(3, 130, 55)])
    assertInvariants(rows)
    expect(rows.map((r) => r.kind)).toEqual(['columns', 'full', 'columns'])
    const bot = rows[2]
    if (bot.kind !== 'columns') throw new Error('unreachable')
    expect(bot.left.map((s) => s.blockIndex)).toEqual([3])
    expect(bot.right.map((s) => [s.blockIndex, s.showTranslation])).toEqual([[undefined, false]])
    near(bot.right[0].rect.y, bot.top)
    near(bot.right[0].rect.h, bot.bottom - bot.top)
  })

  it('8. 边界取整无缝：scaleRect 后相邻条带共享整数边、列条带左右严丝合缝', () => {
    const rows = partitionPageFlow(PAGE, [left(0, 60, 10), left(1, 190, 20), right(2, 60, 29), span(3, 450, 2), left(4, 500, 20), right(5, 500, 20)])
    assertInvariants(rows)
    const scale = 1.37
    let prevBottom = 0
    for (const r of rows) {
      if (r.kind === 'full') {
        const s = scaleRect(r.strip.rect, scale)
        expect(s.y).toBe(prevBottom)
        expect(s.x).toBe(0)
        expect(s.w).toBe(Math.round(W * scale))
        prevBottom = s.y + s.h
        continue
      }
      const splitPx = Math.round(r.split * scale)
      for (const side of [r.left, r.right]) {
        let y = prevBottom
        for (const st of side) {
          const s = scaleRect(st.rect, scale)
          expect(s.y).toBe(y)
          expect(s.h).toBeGreaterThan(0)
          y = s.y + s.h
          if (side === r.left) expect(s.x + s.w).toBe(splitPx)
          else expect(s.x).toBe(splitPx)
        }
        expect(y).toBe(Math.round(r.bottom * scale))
      }
      prevBottom = Math.round(r.bottom * scale)
    }
    expect(prevBottom).toBe(Math.round(H * scale))
  })

  it('空页 → 整页一个无块 full 行；只有通栏片（无 left/right）→ 按单栏处理', () => {
    const empty = partitionPageFlow(PAGE, [])
    assertInvariants(empty)
    expect(empty).toHaveLength(1)
    expect(domStrips(empty)[0]).toMatchObject({ blockIndex: undefined, showTranslation: false, rect: { x: 0, y: 0, w: W, h: H } })
    const spansOnly = partitionPageFlow(PAGE, [span(0, 10, 3), span(1, 100, 3)])
    assertInvariants(spansOnly)
    expect(spansOnly.map((r) => r.kind)).toEqual(['full', 'full'])
  })

  it('图内标签（label）的条带不挂译文：图不被译文行切开，条带照常铺满', () => {
    const a = full(0, 50, 5)
    const tag = { ...portion(1, 'full', [{ x: 280, y: 200, w: 40, h: LH }]), label: true }
    const c = full(2, 300, 5)
    const rows = partitionPageFlow(PAGE, [a, tag, c])
    assertInvariants(rows)
    expect(domStrips(rows).map((s) => [s.blockIndex, s.showTranslation])).toEqual([
      [0, true],
      [1, false],
      [2, true],
    ])
  })

  it('退化输入（片纵向重叠）仍满足不变量，且每个块至少保住一条带', () => {
    const rows = partitionPageFlow(PAGE, [left(0, 10, 10), left(1, 50, 10), right(2, 10, 30)])
    assertInvariants(rows)
    expect(stripsOf(rows, 0)).toHaveLength(1)
    expect(stripsOf(rows, 1)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// assignPointsToStrips
// ---------------------------------------------------------------------------

describe('assignPointsToStrips', () => {
  const strips = [
    { rect: { x: 0, y: 0, w: 300, h: 100 } },
    { rect: { x: 300, y: 0, w: 300, h: 100 } },
    { rect: { x: 0, y: 100, w: 600, h: 100 } },
  ]

  it('共享边界上的点归上方条带；边界下一丁点归下方', () => {
    const r = assignPointsToStrips([{ x: 10, y: 100 }, { x: 10, y: 100.01 }, { x: 10, y: 50 }], strips)
    expect(Array.from(r)).toEqual([0, 2, 0])
  })

  it('横向按 [x, x+w)：x == split 归右条带', () => {
    const r = assignPointsToStrips([{ x: 300, y: 50 }, { x: 299.9, y: 50 }], strips)
    expect(Array.from(r)).toEqual([1, 0])
  })

  it('落在所有条带之外 → 纵向距离最近，再按横向距离', () => {
    const r = assignPointsToStrips([{ x: 10, y: 0 }, { x: 10, y: 250 }, { x: 700, y: 50 }, { x: -5, y: 150 }], strips)
    expect(Array.from(r)).toEqual([0, 2, 1, 2])
    expect(assignPointsToStrips([], strips)).toHaveLength(0)
    expect(Array.from(assignPointsToStrips([{ x: 1, y: 1 }], []))).toEqual([0])
  })
})

// ---------------------------------------------------------------------------
// planFontFit
// ---------------------------------------------------------------------------

describe('planFontFit', () => {
  it('已放得下或已到下限 → null', () => {
    expect(planFontFit(100, 100, 12, 6)).toBeNull()
    expect(planFontFit(100, 90, 12, 6)).toBeNull()
    expect(planFontFit(100, 200, 6, 6)).toBeNull()
    expect(planFontFit(100, Number.NaN, 12, 6)).toBeNull()
  })

  it('按 √(boxH/scrollH)×0.98 缩，钳到 [0.5, 0.97]，再不低于 fMin', () => {
    expect(planFontFit(100, 150, 12, 6)).toBeCloseTo(12 * Math.sqrt(100 / 150) * 0.98, 6)
    expect(planFontFit(100, 101, 12, 6)).toBeCloseTo(12 * 0.97, 9)
    expect(planFontFit(100, 1000, 12, 4)).toBeCloseTo(6, 9)
    expect(planFontFit(100, 400, 12, 8)).toBe(8)
  })

  it('序列：溢出量按字号平方缩时，逐轮单调下降、不低于 fMin、最终放得下或停在下限', () => {
    const boxH = 100
    const fMin = 6
    const scrollAt = (f: number) => (f * f * 100) / 64 // f = 8 时恰好放下
    let f = 16
    const seen: number[] = []
    for (let round = 0; round < 10; round += 1) {
      const next = planFontFit(boxH, scrollAt(f), f, fMin)
      if (next === null) break
      expect(next).toBeLessThan(f)
      expect(next).toBeGreaterThanOrEqual(fMin)
      seen.push(next)
      f = next
    }
    expect(seen.length).toBeLessThanOrEqual(4)
    expect(scrollAt(f)).toBeLessThanOrEqual(boxH)
  })
})

// ---------------------------------------------------------------------------
// splitTranslation
// ---------------------------------------------------------------------------

describe('splitTranslation', () => {
  it('weights=[n] 原样；空权重 → []；空文本 → 等长空串', () => {
    expect(splitTranslation('一二三', [7])).toEqual(['一二三'])
    expect(splitTranslation('一二三', [])).toEqual([])
    expect(splitTranslation('', [1, 1, 1])).toEqual(['', '', ''])
  })

  it('按累计比例在 ±15% 窗口内就近标点切，切在标点之后，join 恒等', () => {
    const text = '第一句。第二句。第三句。'
    expect(splitTranslation(text, [1, 1, 1])).toEqual(['第一句。', '第二句。', '第三句。'])
    const long = '一二三四五六七八九，十一二三四五六七八九。'
    const pieces = splitTranslation(long, [1, 1])
    expect(pieces).toEqual(['一二三四五六七八九，', '十一二三四五六七八九。'])
    expect(pieces.join('')).toBe(long)
  })

  it('窗口内无标点 → 硬切；窗口外的标点不用', () => {
    expect(splitTranslation('abcdefghij', [1, 1])).toEqual(['abcde', 'fghij'])
    // len 21，目标 11，窗口 ±3 → 末尾逗号（切点 21）不在窗口内
    expect(splitTranslation('abcdefghijklmnopqrst,', [1, 1])).toEqual(['abcdefghijk', 'lmnopqrst,'])
  })

  it('等距取靠前的标点；更近的优先', () => {
    // len 20，目标 10，窗口 ±3：切点 8 与 12 等距 → 8
    expect(splitTranslation('aaaaaaa,aaa.aaaaaaaa', [1, 1])).toEqual(['aaaaaaa,', 'aaa.aaaaaaaa'])
    // 切点 11（距 1）优于 8（距 2）
    expect(splitTranslation('aaaaaaa,aa.aaaaaaaaa', [1, 1])).toEqual(['aaaaaaa,aa.', 'aaaaaaaaa'])
  })

  it('权重不均（3:1）、非法权重回退等分、码点数 ≥ 段数时每段非空、不劈代理对', () => {
    expect(splitTranslation('abcdefghijklmnopqrst', [3, 1])).toEqual(['abcdefghijklmno', 'pqrst'])
    expect(splitTranslation('abcdefgh', [0, 0])).toEqual(['abcd', 'efgh'])
    expect(splitTranslation('abcdefghij.', [100, 1])).toEqual(['abcdefghij', '.'])
    expect(splitTranslation('。。。', [1, 1, 1])).toEqual(['。', '。', '。'])
    expect(splitTranslation('ab', [1, 1, 1])).toEqual(['a', 'b', ''])
    expect(splitTranslation('😀😀😀😀', [1, 1])).toEqual(['😀😀', '😀😀'])
  })
})
