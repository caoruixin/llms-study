import { hasTranslatableText } from '../translate/translateBatch'
import type { PaperBlock, PaperRecord } from '../types'
import { rgbHex, type DrawOp, type PagePlan, type PlanFont, type Rgb } from './exportTypes'
import { FLOW_BOX_BAR, FLOW_BOX_FILL } from './inPlacePlan'
import { baselineOffset, justifySpacing, wrapText } from './textLayout'
import { MAX_TABLE_ROWS, planTableColumns, type TableModel } from './textDocTables'

/**
 * 文本排版版（PLAN A.6）：A4 重排的纯规划器——块 → Chunk（行列表 + 分页约束）→ `paginate` → `renderTextDoc` → PagePlan[]。
 * 页 595 × 842、边距 54、页脚 `i / N`；全篇单字体（Noto Serif SC 的拉丁字形排英文与代码）。
 * 中文模式：可译块有译文 → 译文按类别排，缺译 → 原文（计未译）；不可译类别 → 原文。
 * 对照模式：原文行 + 译文框（同对照流配色，左内边 8）放同一 Chunk、keepTogether，跨页时框装饰按页段开合。
 * 坐标：行的 `render(top)` 收页面 CSS 顶 y（含页边距，y 向下），产出 PDF 用户空间 op（y 向上）。
 */

export const PAGE_W = 595
export const PAGE_H = 842
export const MARGIN = 54
export const CONTENT_W = PAGE_W - 2 * MARGIN
export const CONTENT_H = PAGE_H - 2 * MARGIN
/** 页脚：8 pt，基线在 CSS y 812 */
export const FOOTER_BASELINE = 812
export const FOOTER_SIZE = 8

const FG: Rgb = rgbHex(0x211f1a)
const DIM: Rgb = rgbHex(0x6e6a60)
const LINE: Rgb = rgbHex(0xc8c4bc)
const CODE_BG: Rgb = rgbHex(0xf4f4f5)
const TABLE_HEAD_BG: Rgb = rgbHex(0xf4f4f5)

export interface TextStyle {
  size: number
  pitch: number
  color: Rgb
  bold?: boolean
  align: 'left' | 'justify' | 'center'
}

const style = (size: number, lh: number, color: Rgb, align: TextStyle['align'], bold = false): TextStyle => ({
  size,
  pitch: size * lh,
  color,
  align,
  ...(bold ? { bold: true } : {}),
})

/** 版式表（A.6） */
export const STYLES = {
  title: style(18, 1.4, FG, 'left', true),
  meta: style(8.5, 1.5, DIM, 'left'),
  h1: style(16, 1.35, FG, 'left', true),
  h2: style(13.5, 1.35, FG, 'left', true),
  h3: style(12, 1.35, FG, 'left', true),
  paragraph: style(10.5, 1.65, FG, 'justify'),
  list: style(10.5, 1.65, FG, 'justify'),
  caption: style(9, 1.5, DIM, 'center'),
  code: style(8.5, 1.5, FG, 'left'),
  formula: style(9.5, 1.5, DIM, 'center'),
  table: style(8.5, 1.4, FG, 'left'),
} as const

const HEADING_SPACE = [16, 12, 10] as const
const SPACE_BEFORE: Record<string, number> = { paragraph: 6, list: 3, caption: 6, code: 8, formula: 6, table: 8, image: 8 }
/** 列表：`•` + 悬挂 12 */
const LIST_HANGING = 12
const LIST_BULLET = '•'
/** 代码块灰底内边 6 */
const CODE_PAD = 6
/** 译文框：左内边 8、右 4、上下 3、框外上 2 */
const ZH_PAD_LEFT = 8
const ZH_PAD_RIGHT = 4
const ZH_PAD_Y = 3
const ZH_GAP = 2
const ZH_BAR_W = 1.5
/** 表格单元格内边 3、线宽 0.5 */
const CELL_PAD = 3
const GRID_W = 0.5
/** 图：宽 ≤ 内容宽、高 ≤ 0.6 × 内容高；占位框高 40 */
const IMAGE_MAX_H_RATIO = 0.6
const PLACEHOLDER_H = 40
/** 孤寡保护：块 ≥ 4 行时每页至少 2 行 */
const ORPHAN_MIN_LINES = 4
const ORPHAN_KEEP = 2
const EPS = 1e-6

/** 装饰框：同一引用的连续行在一页段上合为一个底色 / 左线 */
export interface Frame {
  x: number
  w: number
  fill?: Rgb
  bar?: { w: number; color: Rgb }
}

export interface DocLine {
  /** 行高（含该行的内边距） */
  h: number
  frame?: Frame
  /** 在页面 CSS 顶 y 处渲染本行 → PDF 空间 ops */
  render: (top: number) => DrawOp[]
}

export interface Chunk {
  kind: string
  blockIndex?: number
  spaceBefore: number
  keepTogether: boolean
  keepWithNext: boolean
  lines: DocLine[]
}

interface Ctx {
  font: PlanFont
}

const spacer = (h: number, frame?: Frame): DocLine => ({ h, frame, render: () => [] })

const textOp = (x: number, baselineCss: number, text: string, st: TextStyle, cs = 0): DrawOp => ({
  kind: 'text',
  x,
  y: PAGE_H - baselineCss,
  text,
  size: st.size,
  color: st.color,
  ...(cs > 0 ? { charSpacing: cs } : {}),
  ...(st.bold ? { bold: true } : {}),
})

interface TextBoxOpts {
  bullet?: string
  hanging?: number
  frame?: Frame
  breakAll?: boolean
}

/** 一段文字折行成 DocLine[]（box 是文字区：x 左缘、w 宽） */
function textLines(ctx: Ctx, text: string, st: TextStyle, box: { x: number; w: number }, opts: TextBoxOpts = {}): DocLine[] {
  const t = ctx.font.sanitize ? ctx.font.sanitize(text) : text
  const hanging = opts.hanging ?? 0
  const maxW = Math.max(1, box.w - hanging)
  const wrapped = wrapText(t, maxW, (s) => ctx.font.measureAt(s, st.size), { breakAll: opts.breakAll })
  return wrapped.map((line, k) => ({
    h: st.pitch,
    frame: opts.frame,
    render: (top) => {
      const ops: DrawOp[] = []
      const baseline = top + baselineOffset(st.size, st.pitch, ctx.font.metrics)
      if (k === 0 && opts.bullet) ops.push(textOp(box.x, baseline, opts.bullet, st))
      let x = box.x + hanging + line.indent
      let cs = 0
      if (st.align === 'center') x = box.x + hanging + (maxW - line.width) / 2
      else if (st.align === 'justify') cs = justifySpacing(line, maxW, st.size)
      if (line.text !== '') ops.push(textOp(x, baseline, line.text, st, cs))
      return ops
    },
  }))
}

const chunk = (kind: string, lines: DocLine[], o: Partial<Omit<Chunk, 'kind' | 'lines'>> = {}): Chunk => ({
  kind,
  lines,
  spaceBefore: o.spaceBefore ?? SPACE_BEFORE[kind] ?? 6,
  keepTogether: o.keepTogether ?? false,
  keepWithNext: o.keepWithNext ?? false,
  blockIndex: o.blockIndex,
})

const CONTENT_BOX = { x: MARGIN, w: CONTENT_W }

const headingStyle = (level: number | undefined): TextStyle => (level === undefined || level <= 1 ? STYLES.h1 : level === 2 ? STYLES.h2 : STYLES.h3)
const headingSpace = (level: number | undefined): number => HEADING_SPACE[Math.min(2, Math.max(0, (level ?? 1) - 1))]

/** 可译类别的正文行（heading / paragraph / list / caption），文字可以是原文也可以是译文 */
function proseLines(ctx: Ctx, b: PaperBlock, text: string, box = CONTENT_BOX, inBox = false): DocLine[] {
  switch (b.kind) {
    case 'heading':
      return textLines(ctx, text, headingStyle(b.level), box)
    case 'list':
      return inBox
        ? textLines(ctx, text, STYLES.list, box)
        : textLines(ctx, text, STYLES.list, box, { bullet: LIST_BULLET, hanging: LIST_HANGING })
    case 'caption':
      return textLines(ctx, text, inBox ? { ...STYLES.caption, align: 'left' } : STYLES.caption, box)
    default:
      return textLines(ctx, text, STYLES.paragraph, box)
  }
}

function proseChunk(ctx: Ctx, b: PaperBlock, text: string): Chunk {
  const lines = proseLines(ctx, b, text)
  if (b.kind === 'heading') return chunk('heading', lines, { spaceBefore: headingSpace(b.level), keepWithNext: true, blockIndex: b.index })
  return chunk(b.kind, lines, { blockIndex: b.index })
}

function codeChunk(ctx: Ctx, b: PaperBlock): Chunk {
  const frame: Frame = { x: MARGIN, w: CONTENT_W, fill: CODE_BG }
  const body = textLines(ctx, b.text, STYLES.code, { x: MARGIN + CODE_PAD, w: CONTENT_W - 2 * CODE_PAD }, { frame, breakAll: true })
  return chunk('code', [spacer(CODE_PAD, frame), ...body, spacer(CODE_PAD, frame)], { blockIndex: b.index })
}

function formulaChunk(ctx: Ctx, b: PaperBlock): Chunk {
  return chunk('formula', textLines(ctx, b.text, STYLES.formula, CONTENT_BOX), { blockIndex: b.index, keepTogether: true })
}

/** 网格表：每行一个 DocLine（行可跨页、单元格不拆）；> 12 行截断为 `…` 行；列规划失败 → null（退回段落） */
function tableChunk(ctx: Ctx, b: PaperBlock, table: TableModel): Chunk | null {
  const cols = planTableColumns(table, CONTENT_W, (t, s) => ctx.font.measureAt(t, s), STYLES.table.size)
  if (!cols) return null
  const st: TextStyle = { ...STYLES.table, size: cols.fontSize, pitch: cols.fontSize * 1.4 }
  let rows = table.rows
  if (rows.length > MAX_TABLE_ROWS) rows = [...rows.slice(0, MAX_TABLE_ROWS), ['…', ...new Array<string>(table.cols - 1).fill('')]]
  const xs: number[] = [MARGIN]
  for (const w of cols.widths) xs.push(xs[xs.length - 1] + w)
  const lines: DocLine[] = rows.map((row, r) => {
    const cells = row.map((cell, c) => {
      const t = ctx.font.sanitize ? ctx.font.sanitize(cell) : cell
      return wrapText(t, Math.max(1, cols.widths[c] - 2 * CELL_PAD), (s) => ctx.font.measureAt(s, st.size))
    })
    const n = Math.max(1, ...cells.map((c) => c.length))
    const h = n * st.pitch + 2 * CELL_PAD
    const header = r < table.headerRows
    return {
      h,
      render: (top) => {
        const ops: DrawOp[] = []
        const bottom = top + h
        if (header) ops.push({ kind: 'rect', x: MARGIN, y: PAGE_H - bottom, w: CONTENT_W, h, fill: TABLE_HEAD_BG })
        if (r === 0) ops.push({ kind: 'line', x1: MARGIN, y1: PAGE_H - top, x2: MARGIN + CONTENT_W, y2: PAGE_H - top, width: GRID_W, color: LINE })
        ops.push({ kind: 'line', x1: MARGIN, y1: PAGE_H - bottom, x2: MARGIN + CONTENT_W, y2: PAGE_H - bottom, width: GRID_W, color: LINE })
        for (const x of xs) ops.push({ kind: 'line', x1: x, y1: PAGE_H - top, x2: x, y2: PAGE_H - bottom, width: GRID_W, color: LINE })
        cells.forEach((cl, c) => {
          cl.forEach((line, k) => {
            if (line.text === '') return
            const baseline = top + CELL_PAD + k * st.pitch + baselineOffset(st.size, st.pitch, ctx.font.metrics)
            ops.push(textOp(xs[c] + CELL_PAD, baseline, line.text, header ? { ...st, bold: true } : st))
          })
        })
        return ops
      },
    }
  })
  return chunk('table', lines, { blockIndex: b.index })
}

function imageChunk(b: PaperBlock, nat: { w: number; h: number }): Chunk {
  const scale = Math.min(1, CONTENT_W / Math.max(1, nat.w), (IMAGE_MAX_H_RATIO * CONTENT_H) / Math.max(1, nat.h))
  const w = Math.max(1, nat.w * scale)
  const h = Math.max(1, nat.h * scale)
  const line: DocLine = {
    h,
    render: (top) => [{ kind: 'image', blockIndex: b.index, x: MARGIN + (CONTENT_W - w) / 2, y: PAGE_H - (top + h), w, h }],
  }
  return chunk('image', [line], { blockIndex: b.index, keepTogether: true })
}

/** 图加载失败 / 没有图：虚线占位框「[图片] + 图注」 */
function imagePlaceholderChunk(ctx: Ctx, b: PaperBlock): Chunk {
  const label = `[图片] ${b.text.replace(/^\[图:\s*/, '').replace(/\]$/, '')}`.trim()
  const st = STYLES.caption
  const t = ctx.font.sanitize ? ctx.font.sanitize(label) : label
  const inner = wrapText(t, CONTENT_W - 16, (s) => ctx.font.measureAt(s, st.size))
  const h = Math.max(PLACEHOLDER_H, inner.length * st.pitch + 12)
  const line: DocLine = {
    h,
    render: (top) => {
      const ops: DrawOp[] = [{ kind: 'rect', x: MARGIN, y: PAGE_H - (top + h), w: CONTENT_W, h, stroke: LINE, strokeWidth: 0.75, dash: [3, 2] }]
      const textTop = top + (h - inner.length * st.pitch) / 2
      inner.forEach((line, k) => {
        if (line.text === '') return
        const baseline = textTop + k * st.pitch + baselineOffset(st.size, st.pitch, ctx.font.metrics)
        ops.push(textOp(MARGIN + (CONTENT_W - line.width) / 2, baseline, line.text, st))
      })
      return ops
    },
  }
  return chunk('image', [line], { blockIndex: b.index, keepTogether: true })
}

/** 对照：原文行 + 译文框（同对照流配色，左内边 8）同一 Chunk、keepTogether */
function bothChunk(ctx: Ctx, b: PaperBlock, zh: string): Chunk {
  const orig = proseLines(ctx, b, b.text)
  const frame: Frame = { x: MARGIN, w: CONTENT_W, fill: FLOW_BOX_FILL, bar: { w: ZH_BAR_W, color: FLOW_BOX_BAR } }
  const box = { x: MARGIN + ZH_PAD_LEFT, w: CONTENT_W - ZH_PAD_LEFT - ZH_PAD_RIGHT }
  const zhLines = proseLines(ctx, b, zh, box, true).map((l) => ({ ...l, frame }))
  const lines = [...orig, spacer(ZH_GAP), spacer(ZH_PAD_Y, frame), ...zhLines, spacer(ZH_PAD_Y, frame)]
  const kind = b.kind === 'heading' ? 'heading' : b.kind
  return chunk(kind, lines, {
    blockIndex: b.index,
    keepTogether: true,
    spaceBefore: b.kind === 'heading' ? headingSpace(b.level) : undefined,
    keepWithNext: b.kind === 'heading',
  })
}

/** 文首：标题 18/1.4 粗 → meta 行 8.5 + 0.5 pt 分隔线 */
function titleChunk(ctx: Ctx, title: string, meta: string): Chunk {
  const sep: DocLine = {
    h: 12,
    render: (top) => [{ kind: 'line', x1: MARGIN, y1: PAGE_H - (top + 6), x2: MARGIN + CONTENT_W, y2: PAGE_H - (top + 6), width: 0.5, color: LINE }],
  }
  return chunk('title', [...textLines(ctx, title, STYLES.title, CONTENT_BOX), spacer(4), ...textLines(ctx, meta, STYLES.meta, CONTENT_BOX), sep], {
    spaceBefore: 0,
    keepWithNext: true,
  })
}

const fmtDate = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface TextDocInput {
  paper: Pick<PaperRecord, 'title' | 'fileName' | 'pageCount'>
  blocks: readonly PaperBlock[]
  texts: ReadonlyMap<number, string>
  flavor: 'text-zh' | 'text-both'
  font: PlanFont
  /** 已解析的表格（blockIndex → 模型）；没有 → 退回 block.text 段落 */
  tables?: ReadonlyMap<number, TableModel>
  /** 已加载的图的自然尺寸（blockIndex → {w, h}）；没有 → 占位框 */
  images?: ReadonlyMap<number, { w: number; h: number }>
  now?: Date
  /** meta 行里的译文模型名 */
  model?: string
}

export interface TextDocChunks {
  chunks: Chunk[]
  /** 可译但缺译（保留原文）的块数 */
  untranslated: number
}

export const TEXT_FLAVOR_NAME: Record<TextDocInput['flavor'], string> = { 'text-zh': '中文', 'text-both': '中英对照' }

export function buildTextDocChunks(input: TextDocInput): TextDocChunks {
  const ctx: Ctx = { font: input.font }
  const chunks: Chunk[] = []
  let untranslated = 0
  const title = (input.paper.title || input.paper.fileName || 'paper').trim()
  const meta = [
    input.paper.fileName,
    input.paper.pageCount !== undefined ? `${input.paper.pageCount} 页` : '',
    `${input.blocks.length} 段`,
    `导出于 ${fmtDate(input.now ?? new Date())}`,
    TEXT_FLAVOR_NAME[input.flavor],
    `译文为 ${input.model ?? 'deepseek-v4-pro'} 机器翻译`,
  ]
    .filter((s) => s !== '')
    .join(' · ')
  chunks.push(titleChunk(ctx, title, meta))

  for (const b of input.blocks) {
    if (hasTranslatableText(b)) {
      const zh = input.texts.get(b.index)
      if (zh === undefined) {
        untranslated += 1
        chunks.push(proseChunk(ctx, b, b.text))
      } else if (input.flavor === 'text-zh') {
        chunks.push(proseChunk(ctx, b, zh))
      } else {
        chunks.push(bothChunk(ctx, b, zh))
      }
      continue
    }
    switch (b.kind) {
      case 'code':
        if (b.text.trim()) chunks.push(codeChunk(ctx, b))
        break
      case 'formula':
        if (b.text.trim()) chunks.push(formulaChunk(ctx, b))
        break
      case 'table': {
        const model = input.tables?.get(b.index)
        const c = model ? tableChunk(ctx, b, model) : null
        if (c) chunks.push(c)
        else if (b.text.trim()) chunks.push(chunk('table', textLines(ctx, b.text, STYLES.paragraph, CONTENT_BOX), { blockIndex: b.index }))
        break
      }
      case 'image': {
        const nat = input.images?.get(b.index)
        chunks.push(nat ? imageChunk(b, nat) : imagePlaceholderChunk(ctx, b))
        break
      }
      default:
        // 可译类别但文本为空：不出块
        break
    }
  }
  return { chunks, untranslated }
}

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

export interface PageSegment {
  chunk: Chunk
  /** 行区间 [from, to) */
  from: number
  to: number
  /** 页内容区顶起的 y */
  top: number
}

export type DocPage = PageSegment[]

const heightOf = (c: Chunk, from: number, to: number): number => {
  let h = 0
  for (let k = from; k < to; k += 1) h += c.lines[k].h
  return h
}

/**
 * 分页：页顶丢 spaceBefore；`keepTogether && 整块 ≤ 页高` → 换页整放，否则按行拆（≥ 4 行时 2 行孤寡保护）；
 * `keepWithNext` 的块要求后继至少首 2 行（或整块）能跟在同页，否则随后继一起换页（已在页顶则照放）。
 */
export function paginate(chunks: readonly Chunk[], contentH: number = CONTENT_H): DocPage[] {
  const pages: DocPage[] = [[]]
  let y = 0
  const newPage = () => {
    pages.push([])
    y = 0
  }
  const cur = () => pages[pages.length - 1]

  for (let i = 0; i < chunks.length; i += 1) {
    const c = chunks[i]
    if (c.lines.length === 0) continue
    let from = 0
    while (from < c.lines.length) {
      const atTop = y === 0
      const sb = atTop || from > 0 ? 0 : c.spaceBefore
      const remain = contentH - y - sb
      const total = heightOf(c, from, c.lines.length)
      if (total <= remain + EPS) {
        if (from === 0 && c.keepWithNext && !atTop && i + 1 < chunks.length) {
          const n = chunks[i + 1]
          const needNext = n.spaceBefore + heightOf(n, 0, Math.min(n.lines.length, ORPHAN_KEEP))
          if (total + needNext > remain + EPS) {
            newPage()
            continue
          }
        }
        cur().push({ chunk: c, from, to: c.lines.length, top: y + sb })
        y += sb + total
        break
      }
      if (c.keepTogether && from === 0 && total <= contentH + EPS && !atTop) {
        newPage()
        continue
      }
      let fit = 0
      let acc = 0
      for (let k = from; k < c.lines.length; k += 1) {
        if (acc + c.lines[k].h > remain + EPS) break
        acc += c.lines[k].h
        fit += 1
      }
      const rest = c.lines.length - from
      if (from === 0 && rest >= ORPHAN_MIN_LINES) {
        if (fit < ORPHAN_KEEP) fit = 0
        else if (rest - fit < ORPHAN_KEEP) fit = rest - ORPHAN_KEEP
      }
      if (fit === 0) {
        if (!atTop) {
          newPage()
          continue
        }
        // 单行比整页还高：硬放一行，避免死循环
        fit = 1
      }
      cur().push({ chunk: c, from, to: from + fit, top: y + sb })
      from += fit
      newPage()
    }
  }
  if (pages.length > 1 && pages[pages.length - 1].length === 0) pages.pop()
  return pages
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

export interface RenderTextDocOptions {
  footer?: boolean
}

/** 页段 → ops：先画装饰框（同一 Frame 的连续行合为一个），再逐行 render；页脚 `i / N` */
export function renderTextDoc(pages: readonly DocPage[], font: PlanFont, opts: RenderTextDocOptions = {}): PagePlan[] {
  const N = pages.length
  return pages.map((segments, pi) => {
    const ops: DrawOp[] = []
    for (const seg of segments) {
      let top = MARGIN + seg.top
      // 装饰框
      let k = seg.from
      let fy = top
      while (k < seg.to) {
        const frame = seg.chunk.lines[k].frame
        let end = k
        let h = 0
        while (end < seg.to && seg.chunk.lines[end].frame === frame) {
          h += seg.chunk.lines[end].h
          end += 1
        }
        if (frame && h > 0) {
          if (frame.fill) ops.push({ kind: 'rect', x: frame.x, y: PAGE_H - (fy + h), w: frame.w, h, fill: frame.fill })
          if (frame.bar) ops.push({ kind: 'rect', x: frame.x, y: PAGE_H - (fy + h), w: frame.bar.w, h, fill: frame.bar.color })
        }
        fy += h
        k = end
      }
      // 行
      for (let j = seg.from; j < seg.to; j += 1) {
        const line = seg.chunk.lines[j]
        ops.push(...line.render(top))
        top += line.h
      }
    }
    if (opts.footer !== false) {
      const label = `${pi + 1} / ${N}`
      const w = font.measureAt(label, FOOTER_SIZE)
      ops.push({ kind: 'text', x: (PAGE_W - w) / 2, y: PAGE_H - FOOTER_BASELINE, text: label, size: FOOTER_SIZE, color: DIM })
    }
    return { width: PAGE_W, height: PAGE_H, base: { kind: 'new' }, ops }
  })
}
