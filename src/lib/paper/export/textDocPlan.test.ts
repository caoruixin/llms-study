import { describe, expect, it } from 'vitest'
import type { PaperBlock, PaperBlockKind } from '../types'
import type { DrawOp, PlanFont } from './exportTypes'
import { FLOW_BOX_BAR, FLOW_BOX_FILL } from './inPlacePlan'
import {
  buildTextDocChunks,
  CONTENT_H,
  CONTENT_W,
  FOOTER_BASELINE,
  FOOTER_SIZE,
  MARGIN,
  PAGE_H,
  PAGE_W,
  paginate,
  renderTextDoc,
  STYLES,
  type Chunk,
  type DocLine,
} from './textDocPlan'
import type { TableModel } from './textDocTables'
import { isCjkCodePoint } from './textLayout'

const FONT: PlanFont = {
  metrics: { unitsPerEm: 1000, ascent: 800, descent: -200 },
  measureAt: (text, size) => {
    let w = 0
    for (const ch of text) w += isCjkCodePoint(ch.codePointAt(0) ?? 0) ? size : size / 2
    return w
  },
}

const block = (index: number, kind: PaperBlockKind, text: string, extra: Partial<PaperBlock> = {}): PaperBlock => ({
  id: `b${index}`,
  paperId: 'p',
  index,
  kind,
  text,
  anchor: { kind: 'docx', blockIndex: index },
  ...extra,
})

const PAPER = { title: 'A Study', fileName: 'study.docx', pageCount: 3 }
const NOW = new Date(2026, 9, 8)

const texts = (ops: readonly DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { kind: 'text' }> => o.kind === 'text')
const rects = (ops: readonly DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { kind: 'rect' }> => o.kind === 'rect')

const line = (h = 10): DocLine => ({ h, render: () => [] })
const chunk = (n: number, o: Partial<Chunk> = {}): Chunk => ({
  kind: 'paragraph',
  spaceBefore: 6,
  keepTogether: false,
  keepWithNext: false,
  lines: Array.from({ length: n }, () => line()),
  ...o,
})

describe('paginate', () => {
  it('页顶丢 spaceBefore；整块放得下就整放并累加 spaceBefore', () => {
    const pages = paginate([chunk(3), chunk(2)], 100)
    expect(pages).toHaveLength(1)
    expect(pages[0].map((s) => [s.from, s.to, s.top])).toEqual([
      [0, 3, 0],
      [0, 2, 36],
    ])
  })

  it('放不下按行拆：≥ 4 行时每页至少 2 行（孤寡保护）', () => {
    // 第一块占 70 + 第二块 spaceBefore 6 → 余 24：只能放 2 行（恰好 2 行，允许）
    const a = paginate([chunk(7), chunk(6)], 100)
    expect(a[0][1]).toMatchObject({ from: 0, to: 2, top: 76 })
    expect(a[1][0]).toMatchObject({ from: 2, to: 6, top: 0 })
    // 余 14：只能放 1 行 → 孤行，整块下页
    const b = paginate([chunk(8), chunk(6)], 100)
    expect(b[0]).toHaveLength(1)
    expect(b[1][0]).toMatchObject({ from: 0, to: 6, top: 0 })
    // 余 54：放 5 行会剩 1 行孤寡 → 只放 4 行
    const c = paginate([chunk(4), chunk(6)], 100)
    expect(c[0][1]).toMatchObject({ from: 0, to: 4 })
    expect(c[1][0]).toMatchObject({ from: 4, to: 6 })
    // 3 行的短块不受孤寡保护：能放 1 行就放 1 行
    const d = paginate([chunk(8), chunk(3)], 100)
    expect(d[0][1]).toMatchObject({ from: 0, to: 1 })
  })

  it('keepTogether 且整块 ≤ 页高 → 换页整放；比页还高则照拆', () => {
    const a = paginate([chunk(5), chunk(6, { keepTogether: true })], 100)
    expect(a[0]).toHaveLength(1)
    expect(a[1][0]).toMatchObject({ from: 0, to: 6, top: 0 })
    const b = paginate([chunk(5), chunk(12, { keepTogether: true })], 100)
    expect(b[0]).toHaveLength(2)
    expect(b[0][1].to - b[0][1].from).toBeGreaterThan(0)
  })

  it('keepWithNext：后继首 2 行跟不上就随后继换页；已在页顶照放', () => {
    // 标题 1 行放得下但后继放不下 → 标题下页
    const a = paginate([chunk(8), chunk(1, { keepWithNext: true, spaceBefore: 10 }), chunk(5)], 100)
    expect(a[0]).toHaveLength(1)
    expect(a[1][0]).toMatchObject({ from: 0, to: 1, top: 0 })
    expect(a[1][1]).toMatchObject({ from: 0, to: 5, top: 16 })
    // 页顶的标题不会无限换页
    const b = paginate([chunk(1, { keepWithNext: true }), chunk(30)], 100)
    expect(b[0][0]).toMatchObject({ from: 0, to: 1, top: 0 })
  })

  it('单行比整页还高：硬放一行不死循环；末页为空则丢弃；空块跳过', () => {
    const pages = paginate([chunk(1, { lines: [line(500)] }), chunk(0), chunk(1)], 100)
    expect(pages).toHaveLength(2)
    expect(pages[0][0]).toMatchObject({ from: 0, to: 1 })
    expect(pages[1][0].chunk.lines).toHaveLength(1)
    expect(paginate([chunk(10)], 100)).toHaveLength(1)
  })
})

describe('buildTextDocChunks', () => {
  const BLOCKS: PaperBlock[] = [
    block(0, 'heading', 'Introduction', { level: 1 }),
    block(1, 'paragraph', 'This is the first paragraph of the paper.'),
    block(2, 'paragraph', 'Second paragraph without translation.'),
    block(3, 'formula', 'E = mc^2'),
    block(4, 'code', 'let x = 1\nlet y = 2'),
    block(5, 'image', '[图: a cat]', { src: 'https://x/cat.png' }),
    block(6, 'list', 'first item'),
    block(7, 'caption', 'Figure 1. A cat'),
    block(8, 'table', 'a b c', { html: '<table><tr><th>a</th></tr></table>' }),
    block(9, 'heading', '', { level: 2 }),
  ]
  const TEXTS = new Map<number, string>([
    [0, '引言'],
    [1, '这是论文的第一段。'],
    [6, '第一项'],
    [7, '图 1. 一只猫'],
  ])

  it('中文模式：有译文的可译块排译文、缺译排原文并计未译；不可译类别排原文；空标题不出块', () => {
    const { chunks, untranslated } = buildTextDocChunks({ paper: PAPER, blocks: BLOCKS, texts: TEXTS, flavor: 'text-zh', font: FONT, now: NOW })
    expect(untranslated).toBe(1)
    expect(chunks[0].kind).toBe('title')
    expect(chunks.slice(1).map((c) => c.kind)).toEqual(['heading', 'paragraph', 'paragraph', 'formula', 'code', 'image', 'list', 'caption', 'table'])
    const textOf = (c: Chunk) => c.lines.flatMap((l) => texts(l.render(100)).map((t) => t.text)).join('')
    expect(textOf(chunks[1])).toBe('引言')
    expect(textOf(chunks[2])).toBe('这是论文的第一段。')
    expect(textOf(chunks[3])).toBe('Second paragraph without translation.')
    // 标题：keepWithNext、前距 16、粗体 16 pt
    expect(chunks[1]).toMatchObject({ keepWithNext: true, spaceBefore: 16 })
    expect(texts(chunks[1].lines[0].render(100))[0]).toMatchObject({ size: 16, bold: true })
    // 列表：• + 悬挂 12
    const listOps = texts(chunks[7].lines[0].render(100))
    expect(listOps.map((t) => t.text)).toEqual(['•', '第一项'])
    expect(listOps[1].x - listOps[0].x).toBe(12)
    // 代码：灰底 frame + 上下 6 内边
    expect(chunks[5].lines[0].h).toBe(6)
    expect(chunks[5].lines.every((l) => l.frame !== undefined)).toBe(true)
    expect(chunks[5].lines.filter((l) => l.h === STYLES.code.pitch)).toHaveLength(2)
    // 图：没加载到 → 占位框（虚线矩形 + 「[图片] a cat」）
    const ph = chunks[6].lines[0].render(100)
    expect(rects(ph)[0]).toMatchObject({ stroke: expect.any(Object), dash: [3, 2], w: CONTENT_W })
    expect(texts(ph)[0].text).toBe('[图片] a cat')
    // 表格没解析 → 退回 block.text 段落
    expect(textOf(chunks[9])).toBe('a b c')
  })

  it('未译计数（文本排版版的 ExportResult.untranslated）：只数可译体裁且非空、无译文的块；两种语言同口径', () => {
    for (const flavor of ['text-zh', 'text-both'] as const) {
      // 全部无译：heading 0 / paragraph 1、2 / list 6 / caption 7 = 5；公式 / 代码 / 图 / 表格不可译，空标题 9 不算
      expect(buildTextDocChunks({ paper: PAPER, blocks: BLOCKS, texts: new Map(), flavor, font: FONT, now: NOW }).untranslated).toBe(5)
      expect(buildTextDocChunks({ paper: PAPER, blocks: BLOCKS, texts: TEXTS, flavor, font: FONT, now: NOW }).untranslated).toBe(1)
      // 给不可译块配了「译文」也不影响计数
      const extra = new Map([...TEXTS, [2, '第二段。'], [3, '公式'], [8, '表']])
      expect(buildTextDocChunks({ paper: PAPER, blocks: BLOCKS, texts: extra, flavor, font: FONT, now: NOW }).untranslated).toBe(0)
    }
  })

  it('标题 + meta 行：文件名 · N 页 · M 段 · 导出于 · 版本 · 模型；分隔线', () => {
    const { chunks } = buildTextDocChunks({ paper: PAPER, blocks: BLOCKS, texts: TEXTS, flavor: 'text-both', font: FONT, now: NOW })
    const ops = chunks[0].lines.flatMap((l) => l.render(100))
    const ts = texts(ops)
    expect(ts[0]).toMatchObject({ text: 'A Study', size: 18, bold: true })
    expect(ts.map((t) => t.text).join('')).toContain('study.docx · 3 页 · 10 段 · 导出于 2026-10-08 · 中英对照 · 译文为 deepseek-v4-pro 机器翻译')
    expect(ops.some((o) => o.kind === 'line')).toBe(true)
    expect(chunks[0].keepWithNext).toBe(true)
  })

  it('对照模式：原文行 + 译文框同一 Chunk、keepTogether；框行带 frame（5% 底 + 左线），左内边 8', () => {
    const { chunks, untranslated } = buildTextDocChunks({ paper: PAPER, blocks: BLOCKS, texts: TEXTS, flavor: 'text-both', font: FONT, now: NOW })
    expect(untranslated).toBe(1)
    const para = chunks[2]
    expect(para.keepTogether).toBe(true)
    const framed = para.lines.filter((l) => l.frame)
    expect(framed.length).toBeGreaterThanOrEqual(3)
    expect(framed[0].frame).toMatchObject({ x: MARGIN, w: CONTENT_W, fill: FLOW_BOX_FILL, bar: { w: 1.5, color: FLOW_BOX_BAR } })
    const zhText = framed.flatMap((l) => texts(l.render(100)))
    expect(zhText.map((t) => t.text).join('')).toBe('这是论文的第一段。')
    expect(zhText[0].x).toBe(MARGIN + 8)
    const orig = para.lines.filter((l) => !l.frame).flatMap((l) => texts(l.render(100)))
    expect(orig.map((t) => t.text).join(' ')).toBe('This is the first paragraph of the paper.')
    // 缺译块只有原文、无 frame
    expect(chunks[3].lines.every((l) => !l.frame)).toBe(true)
    // 标题对照：仍 keepWithNext
    expect(chunks[1]).toMatchObject({ keepWithNext: true, keepTogether: true })
  })

  it('表格：每行一个 DocLine（表头灰底、网格线），> 12 行截断为 … 行；列规划失败退回段落', () => {
    const rows = [['Name', 'Value'], ...Array.from({ length: 14 }, (_, i) => [`row ${i}`, String(i)])]
    const table: TableModel = { rows, headerRows: 1, cols: 2 }
    const { chunks } = buildTextDocChunks({
      paper: PAPER,
      blocks: [block(0, 'table', 'fallback', { html: '<table/>' })],
      texts: new Map(),
      flavor: 'text-zh',
      font: FONT,
      tables: new Map([[0, table]]),
      now: NOW,
    })
    const t = chunks[1]
    expect(t.kind).toBe('table')
    expect(t.lines).toHaveLength(13)
    const head = t.lines[0].render(100)
    expect(rects(head)).toHaveLength(1)
    expect(head.filter((o) => o.kind === 'line').length).toBe(2 + 3)
    expect(texts(head).map((x) => x.text)).toEqual(['Name', 'Value'])
    expect(texts(head)[0].bold).toBe(true)
    const last = texts(t.lines[12].render(100))
    expect(last[0].text).toBe('…')
    // 行高 = 行数 × 行距 + 2 × 3
    expect(t.lines[1].h).toBeCloseTo(STYLES.table.pitch + 6)
    // 列太多 → 退回段落
    const wide: TableModel = { rows: [Array.from({ length: 30 }, (_, i) => `c${i}`)], headerRows: 0, cols: 30 }
    const fb = buildTextDocChunks({
      paper: PAPER,
      blocks: [block(0, 'table', 'fallback', { html: '<table/>' })],
      texts: new Map(),
      flavor: 'text-zh',
      font: FONT,
      tables: new Map([[0, wide]]),
      now: NOW,
    })
    expect(texts(fb.chunks[1].lines[0].render(100))[0].text).toBe('fallback')
  })

  it('图：按自然尺寸缩到 w ≤ 487、h ≤ 0.6 × 内容高，居中，keepTogether', () => {
    const { chunks } = buildTextDocChunks({
      paper: PAPER,
      blocks: [block(0, 'image', '[图: x]', { src: 'https://x/a.png' })],
      texts: new Map(),
      flavor: 'text-zh',
      font: FONT,
      images: new Map([[0, { w: 974, h: 1000 }]]),
      now: NOW,
    })
    const c = chunks[1]
    expect(c.keepTogether).toBe(true)
    const op = c.lines[0].render(100)[0]
    expect(op.kind).toBe('image')
    if (op.kind !== 'image') return
    const maxH = 0.6 * CONTENT_H
    expect(op.h).toBeCloseTo(maxH)
    expect(op.w).toBeCloseTo((974 * maxH) / 1000)
    expect(op.x).toBeCloseTo(MARGIN + (CONTENT_W - op.w) / 2)
    expect(op.y).toBeCloseTo(PAGE_H - (100 + op.h))
    expect(c.lines[0].h).toBeCloseTo(maxH)
  })
})

describe('renderTextDoc', () => {
  it('每页 595 × 842 新页、页脚 i / N（8 pt，基线 CSS 812，居中）；装饰框合并连续同 frame 行', () => {
    const { chunks } = buildTextDocChunks({
      paper: PAPER,
      blocks: [block(0, 'paragraph', 'Hello world.'), block(1, 'paragraph', 'word '.repeat(1500))],
      texts: new Map([[0, '你好世界。']]),
      flavor: 'text-both',
      font: FONT,
      now: NOW,
    })
    const pages = paginate(chunks)
    expect(pages.length).toBeGreaterThanOrEqual(2)
    const plans = renderTextDoc(pages, FONT)
    expect(plans).toHaveLength(pages.length)
    for (const [i, plan] of plans.entries()) {
      expect(plan).toMatchObject({ width: PAGE_W, height: PAGE_H, base: { kind: 'new' } })
      const footer = texts(plan.ops).find((t) => t.text === `${i + 1} / ${plans.length}`)!
      expect(footer).toMatchObject({ size: FOOTER_SIZE, y: PAGE_H - FOOTER_BASELINE })
      expect(footer.x).toBeCloseTo((PAGE_W - FONT.measureAt(footer.text, FOOTER_SIZE)) / 2)
    }
    // 第 1 页：译文框底 + 左线各一个矩形，高度覆盖框内全部行（上下内边 3 + 1 行）
    const frames = rects(plans[0].ops)
    expect(frames).toHaveLength(2)
    expect(frames[0].h).toBeCloseTo(6 + STYLES.paragraph.pitch)
    expect(frames[1].w).toBe(1.5)
  })

  it('footer: false 不出页脚', () => {
    const plans = renderTextDoc([[{ chunk: chunk(1), from: 0, to: 1, top: 0 }]], FONT, { footer: false })
    expect(plans[0].ops).toEqual([])
  })
})
