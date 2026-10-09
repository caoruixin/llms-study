import { describe, expect, it } from 'vitest'
import { buildPieces, segmentsOnPage, type FlowRow, type PageGeom, type Strip } from '../pdfLayout'
import type { PaperBlock, PaperBlockKind, PdfLayoutSeg } from '../types'
import type { DrawOp, PlanFont } from './exportTypes'
import {
  FLOW_BOX_BAR,
  FLOW_BOX_FILL,
  FLOW_FONT_RATIO,
  FLOW_MARGIN_BOTTOM,
  FLOW_MARGIN_TOP,
  FLOW_PAD_LEFT,
  FLOW_PAD_Y,
  FLOW_PITCH_RATIO,
  OVERLAY_TEXT_COLOR,
  pageBodyLineH,
  planCopiedPage,
  planFlowPage,
  planOverlayPage,
} from './inPlacePlan'
import { isCjkCodePoint } from './textLayout'

/** 假字体：CJK = size、其余 0.5 × size；度量 upm 1000 / 800 / −200 */
const FONT: PlanFont = {
  metrics: { unitsPerEm: 1000, ascent: 800, descent: -200 },
  measureAt: (text, size) => {
    let w = 0
    for (const ch of text) w += isCjkCodePoint(ch.codePointAt(0) ?? 0) ? size : size / 2
    return w
  },
}

const PROSE = 'This is an ordinary English paragraph with enough words to look like running prose text.'

const block = (index: number, kind: PaperBlockKind, text: string, segs: PdfLayoutSeg[]): PaperBlock => ({
  id: `b${index}`,
  paperId: 'p',
  index,
  kind,
  text,
  anchor: { kind: 'pdf', blockIndex: index, page: 1 },
  layout: { segs },
})

/** 行框 [x0, yTop, x1, h]（用户空间 y 向上）：从 yTop 起每行下移 14 */
const lines = (x0: number, x1: number, yTop: number, n: number, last = x1): PdfLayoutSeg['lines'] =>
  Array.from({ length: n }, (_, i) => [x0, yTop - i * 14, i === n - 1 ? last : x1, 12] as [number, number, number, number])

const texts = (ops: readonly DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { kind: 'text' }> => o.kind === 'text')
const rects = (ops: readonly DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { kind: 'rect' }> => o.kind === 'rect')

describe('planOverlayPage', () => {
  // cropbox 原点非零：全部坐标都要加 pageX / pageY
  const GEOM: PageGeom = { pageX: 20, pageY: 30, pageWidth: 600, pageHeight: 800 }
  const BLOCKS: PaperBlock[] = [
    // 0：通栏正文 3 行，首行缩进 20（已译）
    block(0, 'paragraph', PROSE, [{ page: 1, col: 'full', lines: [[100, 760, 540, 12], [80, 746, 540, 12], [80, 732, 400, 12]] }]),
    // 1：左栏正文（未译 → 计 1 次未译，不出 op）
    block(1, 'paragraph', PROSE, [{ page: 1, col: 'left', lines: lines(80, 310, 700, 4, 200) }]),
    // 2：公式（非正文 → 不是覆盖片）
    block(2, 'formula', 'E = mc^2 + 1', [{ page: 1, col: 'left', lines: lines(140, 250, 570, 1) }]),
    // 3：跨栏正文：左栏 2 行 + 右栏 2 行（已译 → 两片按行数拆）
    block(3, 'paragraph', PROSE, [
      { page: 1, col: 'left', lines: lines(80, 310, 540, 2) },
      { page: 1, col: 'right', lines: lines(330, 560, 700, 2, 450) },
    ]),
    // 4：右栏居中的单行标题（已译 → 居中、仿粗）
    block(4, 'heading', 'Short centered heading', [{ page: 1, col: 'right', lines: [[400, 400, 490, 12]] }]),
  ]
  const blockOf = (i: number) => BLOCKS.find((b) => b.index === i)
  const portions = segmentsOnPage(BLOCKS, 1, GEOM)
  const pieces = buildPieces(portions, blockOf, 1, { round: false })
  const TEXTS = new Map<number, string>([
    [0, '这是第一段的中文译文，有一些字。'],
    [3, '第一句译文在左栏，比较长一些。第二句译文接在右栏。'],
    [4, '短标题'],
  ])

  it('已译正文片 → 底色矩形（并集 + 外扩，转 PDF 坐标）+ 逐行文字；缺译按块计一次，公式片不出 op', () => {
    const plan = planOverlayPage({ geom: GEOM, pieces, texts: TEXTS, font: FONT })
    expect(plan.untranslated).toBe(1)
    expect(plan.untranslatedBlocks).toEqual([1])
    const rs = rects(plan.ops)
    // 0、3（两片）、4 四个矩形
    expect(rs).toHaveLength(4)
    const r0 = rs[0]
    const box = pieces.find((p) => p.key === '0:0')!.box
    // x' = cssX + pageX；y'(底) = pageY + pageHeight − (cssY + h)
    expect(r0.x).toBeCloseTo(box.x + GEOM.pageX)
    expect(r0.y).toBeCloseTo(GEOM.pageY + GEOM.pageHeight - (box.y + box.h))
    expect(r0.w).toBeCloseTo(box.w)
    expect(r0.h).toBeCloseTo(box.h)
    expect(r0.fill).toEqual({ r: 1, g: 1, b: 1 })
    // 文字落在矩形之内
    const ts = texts(plan.ops)
    expect(ts.length).toBeGreaterThan(0)
    for (const t of ts) {
      expect(t.color).toEqual(OVERLAY_TEXT_COLOR)
      expect(t.size).toBeGreaterThan(0)
    }
    // 没有块 1 / 块 2 的东西：每个 op 都在某个已译片的矩形内
    for (const t of ts) expect(rs.some((r) => t.x >= r.x - 1e-6 && t.x <= r.x + r.w && t.y >= r.y - 1e-6 && t.y <= r.y + r.h)).toBe(true)
  })

  it('底色取样结果（CSS 颜色）转成 Rgb；不认识的写法回退白', () => {
    const plan = planOverlayPage({
      geom: GEOM,
      pieces,
      texts: TEXTS,
      backgrounds: new Map([
        ['0:0', 'rgb(255, 250, 240)'],
        ['4:0', 'hsl(0 0% 0%)'],
      ]),
      font: FONT,
    })
    const rs = rects(plan.ops)
    expect(rs[0].fill).toEqual({ r: 1, g: 250 / 255, b: 240 / 255 })
    expect(rs[rs.length - 1].fill).toEqual({ r: 1, g: 1, b: 1 })
  })

  it('首行缩进 + Tc 对齐：首行 x 多出 indent；居中片按 (box.w − line.width) / 2 且不加 Tc；heading 仿粗', () => {
    const plan = planOverlayPage({ geom: GEOM, pieces, texts: TEXTS, font: FONT })
    const p0 = pieces.find((p) => p.key === '0:0')!
    expect(p0.indent).toBeCloseTo(20)
    const t0 = texts(plan.ops).filter((t) => t.y > GEOM.pageY + GEOM.pageHeight - (p0.box.y + p0.box.h) - 1e-6 && t.y < GEOM.pageY + GEOM.pageHeight - p0.box.y)
    expect(t0.length).toBeGreaterThanOrEqual(1)
    expect(t0[0].x).toBeCloseTo(p0.box.x + GEOM.pageX + 20)
    expect(t0[0].bold).toBeUndefined()
    // 行从框顶开始：首行基线 = 框顶 + baselineOffset
    const p4 = pieces.find((p) => p.key === '4:0')!
    expect(p4.center).toBe(true)
    const t4 = texts(plan.ops).find((t) => t.text === '短标题')!
    expect(t4.bold).toBe(true)
    expect(t4.charSpacing).toBeUndefined()
    const w = FONT.measureAt('短标题', t4.size)
    expect(t4.x).toBeCloseTo(p4.box.x + GEOM.pageX + (p4.box.w - w) / 2)
  })

  it('跨栏块：两片各取拆分后的那一段，拼回整段', () => {
    const plan = planOverlayPage({ geom: GEOM, pieces, texts: TEXTS, font: FONT })
    const p3a = pieces.find((p) => p.key === '3:0')!
    const p3b = pieces.find((p) => p.key === '3:1')!
    const inBox = (t: { x: number; y: number }, box: { x: number; y: number; w: number; h: number }) =>
      t.x >= box.x + GEOM.pageX - 1e-6 && t.x <= box.x + box.w + GEOM.pageX && t.y <= GEOM.pageY + GEOM.pageHeight - box.y && t.y >= GEOM.pageY + GEOM.pageHeight - box.y - box.h
    const a = texts(plan.ops).filter((t) => inBox(t, p3a.box)).map((t) => t.text).join('')
    const b = texts(plan.ops).filter((t) => inBox(t, p3b.box)).map((t) => t.text).join('')
    expect(a).toBe('第一句译文在左栏，比较长一些。')
    expect(b).toBe('第二句译文接在右栏。')
  })

  it('译文超长：字号缩到下限仍溢出 → 末行以 … 结尾，行数不超过框高', () => {
    const long = new Map([[4, '标题'.repeat(60)]])
    const plan = planOverlayPage({ geom: GEOM, pieces, texts: long, font: FONT })
    const ts = texts(plan.ops)
    expect(ts[ts.length - 1].text.endsWith('…')).toBe(true)
    const p4 = pieces.find((p) => p.key === '4:0')!
    expect(ts[0].size).toBeCloseTo(p4.fMin)
  })

  it('没有覆盖片的页 → 空 ops、0 未译', () => {
    expect(planOverlayPage({ geom: GEOM, pieces: [], texts: TEXTS, font: FONT })).toEqual({ ops: [], untranslated: 0, untranslatedBlocks: [] })
  })

  it('未译按块计：跨栏块两片缺译只算 1 块；公式（不出覆盖片）不算；块号升序给执行器取并集', () => {
    const plan = planOverlayPage({ geom: GEOM, pieces, texts: new Map([[0, '只译了第一段。']]), font: FONT })
    // 块 3 有两片（3:0 / 3:1），块 2 是公式没有片
    expect(pieces.filter((p) => p.block.index === 3)).toHaveLength(2)
    expect(plan.untranslated).toBe(3)
    expect(plan.untranslatedBlocks).toEqual([1, 3, 4])
    // 全部缺译：只有片的块计数，与「可译块总数」不同（公式块 2 不在内）
    const none = planOverlayPage({ geom: GEOM, pieces, texts: new Map(), font: FONT })
    expect(none.untranslatedBlocks).toEqual([0, 1, 3, 4])
    expect(none.ops).toEqual([])
  })
})

describe('planFlowPage', () => {
  const GEOM: PageGeom = { pageX: 10, pageY: 20, pageWidth: 600, pageHeight: 400 }
  const strip = (key: string, x: number, y: number, w: number, h: number, blockIndex?: number, show = false): Strip => ({
    key,
    rect: { x, y, w, h },
    blockIndex,
    showTranslation: show,
  })
  const ROWS: FlowRow[] = [
    { kind: 'full', key: 'A', strip: strip('A', 0, 0, 600, 100, 1, true) },
    {
      kind: 'columns',
      key: 'C',
      top: 100,
      bottom: 300,
      split: 300,
      left: [strip('L1', 0, 100, 300, 100, 2, true), strip('L2', 0, 200, 300, 100)],
      right: [strip('R1', 300, 100, 300, 200, 3, true)],
    },
    { kind: 'full', key: 'F', strip: strip('F', 0, 300, 600, 100) },
  ]
  const TEXTS = new Map([
    [1, '译文一'],
    [2, '译文二'],
  ])
  const BOUNDS = new Map<number, readonly [number, number]>([
    [1, [50, 550]],
    [2, [40, 280]],
  ])
  const bodyLineH = 12
  const fz = FLOW_FONT_RATIO * bodyLineH
  const pitch = FLOW_PITCH_RATIO * fz
  const boxH = 2 * FLOW_PAD_Y + pitch
  const run = () => planFlowPage({ page: 3, geom: GEOM, rows: ROWS, textBounds: BOUNDS, texts: TEXTS, bodyLineH, font: FONT })

  it('页高 = Σ 行（列行取 max）；无译条带精确前进 rect.h；缺译按块计', () => {
    const plan = run()
    const afterA = 100 + FLOW_MARGIN_TOP + boxH + FLOW_MARGIN_BOTTOM
    const yl = afterA + 100 + FLOW_MARGIN_TOP + boxH + FLOW_MARGIN_BOTTOM + 100
    const yr = afterA + 200
    expect(yl).toBeGreaterThan(yr)
    expect(plan.height).toBeCloseTo(yl + 100)
    expect(plan.width).toBe(600)
    expect(plan.base).toEqual({ kind: 'new' })
    expect(plan.untranslated).toBe(1)
    // 只数 showTranslation 的条带：块 3 的 R1 缺译；L2 / F 没有 showTranslation 不算
    expect(plan.untranslatedBlocks).toEqual([3])
  })

  it('条带 op：clip / tx / ty 按 pageX / pageY ≠ 0 的公式；strip 顺序 = 行内阅读序', () => {
    const plan = run()
    const H = plan.height
    const strips = plan.ops.filter((o): o is Extract<DrawOp, { kind: 'strip' }> => o.kind === 'strip')
    expect(strips).toHaveLength(5)
    expect(strips.every((s) => s.srcPage === 3)).toBe(true)
    // A：dst (0, 0)
    expect(strips[0].clip).toEqual({ x: 0, y: H - 100, w: 600, h: 100 })
    expect(strips[0].tx).toBeCloseTo(-10)
    expect(strips[0].ty).toBeCloseTo(H - 20 - 400)
    // L2：src (0, 200)，dst y = A 之后 + L1 + L1 译文框
    const dstL2 = 100 + FLOW_MARGIN_TOP + boxH + FLOW_MARGIN_BOTTOM + 100 + FLOW_MARGIN_TOP + boxH + FLOW_MARGIN_BOTTOM
    const l2 = strips[2]
    expect(l2.clip.x).toBe(0)
    expect(l2.clip.y).toBeCloseTo(H - dstL2 - 100)
    expect(l2.tx).toBeCloseTo(0 - 0 - 10)
    expect(l2.ty).toBeCloseTo(H - dstL2 - 20 - 400 + 200)
    // 验证：源 CSS 点 (0, 200) → 用户空间 (10, 220) → 平移后 = 输出页的 dst 顶（H − dstL2）
    expect(220 + l2.ty).toBeCloseTo(H - dstL2)
    expect(10 + l2.tx).toBeCloseTo(0)
    // R1：x 不变
    expect(strips[3].clip.x).toBe(300)
    expect(strips[3].tx).toBeCloseTo(300 - 300 - 10)
  })

  it('译文框：x 范围 [max(s.x + 4, b0), min(s.x + s.w − 4, b1)]，5% 底 + 1.5 pt 左线 + 文字（左内边 6）', () => {
    const plan = run()
    const H = plan.height
    const rs = rects(plan.ops)
    // 每个译文框两个矩形（底 + 左线）
    expect(rs).toHaveLength(4)
    const [fillA, barA, fillL, barL] = rs
    expect(fillA.fill).toEqual(FLOW_BOX_FILL)
    expect(barA.fill).toEqual(FLOW_BOX_BAR)
    expect(fillA.x).toBe(50)
    expect(fillA.w).toBe(500)
    expect(fillA.h).toBeCloseTo(boxH)
    expect(fillA.y).toBeCloseTo(H - (100 + FLOW_MARGIN_TOP) - boxH)
    expect(barA.w).toBe(1.5)
    expect(barA.x).toBe(50)
    // L1 的 bounds [40, 280] 被条带内缩 4 夹住：max(4, 40) = 40，min(296, 280) = 280
    expect(fillL.x).toBe(40)
    expect(fillL.w).toBe(240)
    expect(barL.x).toBe(40)
    const ts = texts(plan.ops)
    expect(ts.map((t) => t.text)).toEqual(['译文一', '译文二'])
    expect(ts[0].x).toBeCloseTo(50 + FLOW_PAD_LEFT)
    expect(ts[0].size).toBeCloseTo(fz)
    expect(ts[0].y).toBeLessThan(fillA.y + fillA.h)
    expect(ts[0].y).toBeGreaterThan(fillA.y)
  })

  it('没有 bounds 或范围 < 40 → 条带内缩 8', () => {
    const plan = planFlowPage({ page: 1, geom: GEOM, rows: ROWS, textBounds: new Map([[1, [100, 120] as const]]), texts: TEXTS, bodyLineH, font: FONT })
    const rs = rects(plan.ops)
    expect(rs[0].x).toBe(8)
    expect(rs[0].w).toBe(600 - 16)
    expect(rs[2].x).toBe(8)
    expect(rs[2].w).toBe(300 - 16)
  })

  it('字号 clamp 到 [7, 12]', () => {
    const small = planFlowPage({ page: 1, geom: GEOM, rows: ROWS, textBounds: BOUNDS, texts: TEXTS, bodyLineH: 5, font: FONT })
    expect(texts(small.ops)[0].size).toBe(7)
    const big = planFlowPage({ page: 1, geom: GEOM, rows: ROWS, textBounds: BOUNDS, texts: TEXTS, bodyLineH: 30, font: FONT })
    expect(texts(big.ops)[0].size).toBe(12)
  })

  it('全部无译：页高 = 原页高，只有条带 op', () => {
    const plan = planFlowPage({ page: 1, geom: GEOM, rows: ROWS, textBounds: BOUNDS, texts: new Map(), bodyLineH, font: FONT })
    expect(plan.height).toBe(400)
    expect(plan.ops.every((o) => o.kind === 'strip')).toBe(true)
    expect(plan.untranslated).toBe(3)
    expect(plan.untranslatedBlocks).toEqual([1, 2, 3])
  })

  it('showTranslation 为假的条带即使有块号也不计未译（块的非末段 / 图内标签）', () => {
    const rows: FlowRow[] = [
      { kind: 'full', key: 'A', strip: strip('A', 0, 0, 600, 100, 7, false) },
      { kind: 'full', key: 'B', strip: strip('B', 0, 100, 600, 100, 8, true) },
    ]
    const plan = planFlowPage({ page: 1, geom: GEOM, rows, textBounds: new Map(), texts: new Map(), bodyLineH, font: FONT })
    expect(plan.untranslatedBlocks).toEqual([8])
    expect(plan.untranslated).toBe(1)
  })

  it('旋转页 → copy 基底、无 op；pageBodyLineH 取行高中位数、无行回退 12', () => {
    expect(planCopiedPage(4, 500, 700)).toEqual({ width: 500, height: 700, base: { kind: 'copy', srcPage: 4 }, ops: [] })
    expect(pageBodyLineH([])).toBe(12)
    const portions = segmentsOnPage([block(0, 'paragraph', PROSE, [{ page: 1, col: 'full', lines: lines(60, 540, 760, 3) }])], 1, GEOM)
    expect(pageBodyLineH(portions)).toBe(12)
  })
})
