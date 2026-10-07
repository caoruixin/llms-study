import type { PaperBlock, PaperBlockKind, PaperRecord, PdfColumn } from './types'

/**
 * 原版 PDF 就地译文的共享几何模块——解析器产出的 `PaperBlock.layout` 与查看器（中文覆盖 / 段落对照流）
 * 之间的唯一契约。纯函数，无 DOM、无 pdf.js；全部可在 node 下单测。
 *
 * 坐标系约定（与 types.ts 的 PdfLineBox 对应）：
 * - 输入行框是 PDF 用户空间（y 向上），`segmentsOnPage` 用 `viewport.rawDims` 把它换到**页面 CSS 空间**
 *   （scale = 1，页面左上角为原点，y 向下）；之后所有函数都只认 CSS 空间的 `Rect`。
 * - 查看器按实际 scale 调 `scaleRect` 取整；分区（`partitionPageFlow`）在 scale = 1 下做，与缩放无关。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** = pdf.js `viewport.rawDims`（cropbox 原点非零的 PDF 才需要 pageX/pageY，TextLayer 自己也这么换算） */
export interface PageGeom {
  pageX: number
  pageY: number
  pageWidth: number
  pageHeight: number
}

/** 页面 CSS 空间矩形：scale = 1，页面左上角为原点，y 向下 */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 一个块在某页某栏上的「段落片」：rect = 行框并集；跨栏 / 跨页的块在一页上可有多个 */
export interface PortionRect {
  blockIndex: number
  /** 在 `layout.segs` 里的下标 / 总数；译文只挂在最后一个 seg（对照流）或按行数比例拆到各 seg（覆盖） */
  segIndex: number
  segCount: number
  col: PdfColumn
  rect: Rect
  lines: Rect[]
  /** 版面像正文（可整段覆盖译文）；公式行、表格行、作者块等留原文 */
  prose: boolean
  /**
   * 图内文字（示意图标签 / 图内副标题，`isLabelLike`）：就地译文一律不给——中文不覆盖、不出骨架，
   * 对照不挂译文行。只影响原版视图；文本视图照常翻译这些块。
   */
  label: boolean
}

/** 块在滚动容器坐标系里的上下边（覆盖模式来自几何，对照流来自 DOM 矩形聚合） */
export interface BlockEdges {
  blockIndex: number
  top: number
  bottom: number
}

/** 对照流条带：页位图的一个裁切矩形；有 blockIndex 的条带承载该块的文字层，showTranslation 的条带之后挂译文 */
export interface Strip {
  key: string
  rect: Rect
  blockIndex?: number
  showTranslation: boolean
}

export type FlowRow =
  | { kind: 'full'; key: string; strip: Strip }
  | { kind: 'columns'; key: string; top: number; bottom: number; split: number; left: Strip[]; right: Strip[] }

// ---------------------------------------------------------------------------
// 阈值（全部 scale = 1 的页面 CSS 空间）
// ---------------------------------------------------------------------------

/** 条带边界离前块底最多 0.6 行高：普通段间距取中点，大空隙（插图）紧贴前块底、空隙归下一条带 */
const CUT_MAX_LINE_RATIO = 0.6
/** 页眉 / 页脚 / 列末空隙 ≥ 2 行高才独立成无块条带，否则并入相邻条带（避免碎条带） */
const RUNNING_BAND_MIN_LINES = 2
/** 没有任何行框可量时的行高兜底（10pt 正文的典型行高） */
const DEFAULT_LINE_H = 12

/** 正文判定：去首行后 ≥ 80% 的行 x0 与众数差 < 3% 栏宽（首行缩进不作数） */
const PROSE_LEFT_ALIGN_TOL = 0.03
const PROSE_LEFT_ALIGN_MIN = 0.8
/** 相邻行距 max / median ≤ 1.6：公式行、表格行的行距跳变被排除 */
const PROSE_PITCH_MAX_RATIO = 1.6
/** 行高 max / min ≤ 1.5：混有大字标题或上下标行的块不整段覆盖 */
const PROSE_HEIGHT_MAX_RATIO = 1.5
/** 中位行宽 ≥ 45% 栏宽：居中公式、短表格行填不满栏 */
const PROSE_MIN_FILL = 0.45
/** 数字 / 符号占比 ≤ 35%：纯数据行、公式行没有可翻译的正文 */
const PROSE_MAX_SYMBOL_RATIO = 0.35
const NON_PROSE_KINDS: ReadonlySet<PaperBlockKind> = new Set(['table', 'code', 'formula', 'image'])
const SYMBOL_CHARS: ReadonlySet<string> = new Set('0123456789.,%()+-×/=<>')
const LETTER_OR_CJK = /[A-Za-z㐀-鿿]/

/**
 * 孤立标签规则：去空白后短于 60 字符。示意图里的标签是几个词（主样本第 3 / 4 页实测 5–30 字符）；
 * 60 以上基本是一整句话（双栏正文一整行 ≈ 55–65 字符、通栏图注更长），宁可照常翻译。
 */
const LABEL_MAX_CHARS = 60
/**
 * 粘连标签 / 离栏短文本规则：整块去空白后短于 120 字符。解析器会把同一 y 上的几个图内标签拼成一块
 * （主样本「can perform AI R&D more AI R&D」30 字符、「Governments and/or Evaluate …」64 字符），
 * 图内副标题也只是一句话（72 字符）；两行以上的正文段落远超 120。
 */
const LABEL_GLUED_MAX_CHARS = 120
/** 离栏短文本规则：每个 seg 至多 2 行（图内副标题 / 致谢行；再多就是正文段落了） */
const LABEL_OFFCOL_MAX_LINES = 2
/**
 * 离栏短文本规则：每一行的左缘都离栏左缘 > 10% 栏宽。LaTeX 首行缩进 ≈ 1.5em ≈ 6% 栏宽，正文行贴栏左缘；
 * 图内居中的副标题、示意图里的文字都离栏左缘 15% 以上。
 */
const LABEL_X_OFFSET_RATIO = 0.1
/** 离栏短文本规则：每一行都窄于 80% 栏宽（两端对齐的正文行几乎占满栏宽，段末短行又贴栏左缘） */
const LABEL_MAX_WIDTH_RATIO = 0.8
/**
 * 离栏短文本规则：正上方 1 行高之内紧贴着一段贴栏左缘的多行正文 → 是悬挂缩进的续行（解析器把参考文献条目的
 * 尾行「DOI: … (cit. on p. 5).」切成了单独的块，缩进 ≈ 11.7% 栏宽，与图内标签的偏移区间重叠），不是标签。
 * 正文行间空隙 ≈ 0.2 行高，续行贴着上一行；插图与上方正文之间至少空出一行。
 */
const LABEL_ATTACH_PITCHES = 1
/**
 * 图内标签：上下最近的同栏内容都远于 2.5 × 本行行高。正文行距 ≈ 1.2 行高、段间距 ≤ 1 行高、
 * 小节标题上下留白 ≈ 1.5–2 行高；上下都空出 2.5 行高以上的单行只出现在插图里（标签之间隔着图形）。
 */
const LABEL_ISOLATION_PITCHES = 2.5
/** 图注前缀：单行图注同样孤立在图下，但它是正文的一部分，必须照常翻译 */
const CAPTION_PREFIX = /^(figure|fig\.|table|图|表)\s*\d/i
/** 列表项前缀：单行列表项（含参考文献编号）是正文，不当标签 */
const LIST_MARKER = /^(?:[•\-–*]|\d+[.)])/

/** 字号拟合：按 √(boxH/scrollH) 缩、再打 2% 安全余量（行高取整会多吃一点） */
const FONT_FIT_SAFETY = 0.98
/** 单轮最多缩到 50%（溢出量离谱时不一步缩成蚂蚁字），最少缩 3%（保证每轮有进展） */
const FONT_FIT_MIN_STEP = 0.5
const FONT_FIT_MAX_STEP = 0.97

/** 译文拆分：在目标点 ±15% 全文长度内找最近标点 */
const SPLIT_WINDOW_RATIO = 0.15
const SPLIT_PUNCTUATION: ReadonlySet<string> = new Set('。；！？，、.;,')

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

const median = (nums: readonly number[]): number => {
  if (nums.length === 0) return NaN
  const s = [...nums].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const unionRects = (rects: readonly Rect[]): Rect => {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    if (r.x < x0) x0 = r.x
    if (r.y < y0) y0 = r.y
    if (r.x + r.w > x1) x1 = r.x + r.w
    if (r.y + r.h > y1) y1 = r.y + r.h
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

const bottomOf = (r: Rect): number => r.y + r.h

// ---------------------------------------------------------------------------
// 数据判定
// ---------------------------------------------------------------------------

/** blocks 是否带版面几何（v3 解析器产出）：任一块有非空 layout 即可——同一篇论文不会混出两种版本 */
export const hasPdfLayout = (blocks: readonly Pick<PaperBlock, 'layout'>[]): boolean =>
  blocks.some((b) => (b.layout?.segs.length ?? 0) > 0)

/**
 * 存量 PDF 是否需要「重新解析」才能用就地译文：以 blocks 是否带 layout 为准，不看 parserVersion——
 * 另一台设备拉到 v3 blocks 时本机 papers 行可能仍是 v2。
 */
export function needsLayoutReparse(
  paper: Pick<PaperRecord, 'format' | 'status'>,
  blocks: readonly Pick<PaperBlock, 'layout'>[],
): boolean {
  return paper.format === 'pdf' && paper.status === 'ready' && blocks.length > 0 && !hasPdfLayout(blocks)
}

// ---------------------------------------------------------------------------
// 几何映射
// ---------------------------------------------------------------------------

/**
 * 某页上所有块的段落片，阅读序（按 blocks 数组顺序、seg 顺序）。
 *
 * 行框 `[x0, yTop, x1, h]` → `Rect{ x: x0 − pageX, y: pageY + pageHeight − yTop, w: x1 − x0, h }`。
 * `prose` 用 `isProseLayout` 判定，栏宽来自 `columnExtents`：left / right 片用各自栏宽，
 * full / span 片以及没有双栏的页用该页所有行框的 x 并集宽度。
 * `label` 用 `isLabelLike` 判定，页级上下文（邻居、栏左缘与栏宽）= `labelContextOf(本页全部段落片)`。
 */
export function segmentsOnPage(blocks: readonly PaperBlock[], page: number, geom: PageGeom): PortionRect[] {
  const out: PortionRect[] = []
  const kinds: PaperBlockKind[] = []
  const texts: string[] = []
  for (const b of blocks) {
    const segs = b.layout?.segs
    if (!segs) continue
    for (let i = 0; i < segs.length; i += 1) {
      const seg = segs[i]
      if (seg.page !== page || seg.lines.length === 0) continue
      const lines = seg.lines.map(([x0, yTop, x1, h]) => ({
        x: x0 - geom.pageX,
        y: geom.pageY + geom.pageHeight - yTop,
        w: x1 - x0,
        h,
      }))
      out.push({
        blockIndex: b.index,
        segIndex: i,
        segCount: segs.length,
        col: seg.col,
        rect: unionRects(lines),
        lines,
        prose: false,
        label: false,
      })
      kinds.push(b.kind)
      texts.push(b.text)
    }
  }
  if (out.length === 0) return out

  // 栏宽 / 全页文字范围 / 邻居：prose 与 label 共用一份页级上下文
  const lctx = labelContextOf(out)
  for (let i = 0; i < out.length; i += 1) {
    const p = out[i]
    p.prose = isProseLayout(p.lines, kinds[i], columnFrameOf(p, lctx)[1], texts[i])
  }
  // 标签判定要看同块其它片与全页邻居：等全部片就位后再判
  for (let i = 0; i < out.length; i += 1) out[i].label = isLabelLike(out[i], lctx, texts[i], kinds[i])
  return out
}

/**
 * 该页左右栏的 x 范围（各栏行盒 x 并集）与分栏位置 `split = (left.x1 + right.x0) / 2`。
 * 只看 col 为 left / right 的片；任一侧缺失 → null（整页按 full 处理）。
 */
export function columnExtents(
  rects: readonly PortionRect[],
): { left: [number, number]; right: [number, number]; split: number } | null {
  let l0 = Infinity
  let l1 = -Infinity
  let r0 = Infinity
  let r1 = -Infinity
  for (const p of rects) {
    if (p.col === 'left') {
      l0 = Math.min(l0, p.rect.x)
      l1 = Math.max(l1, p.rect.x + p.rect.w)
    } else if (p.col === 'right') {
      r0 = Math.min(r0, p.rect.x)
      r1 = Math.max(r1, p.rect.x + p.rect.w)
    }
  }
  if (!Number.isFinite(l0) || !Number.isFinite(r0)) return null
  return { left: [l0, l1], right: [r0, r1], split: (l1 + r0) / 2 }
}

/** 文本是否像正文：数字 / 符号占比 ≤ 35% 且含字母或 CJK（对单行块同样生效：纯公式行没有可译正文） */
const isProseText = (text: string): boolean => {
  if (!LETTER_OR_CJK.test(text)) return false
  const chars = Array.from(text.replace(/\s+/g, ''))
  if (chars.length === 0) return false
  let symbols = 0
  for (const c of chars) if (SYMBOL_CHARS.has(c)) symbols += 1
  return symbols / chars.length <= PROSE_MAX_SYMBOL_RATIO
}

/**
 * 一个段落片的版面是否像正文（可用译文整段覆盖）：
 * - kind ∈ {table, code, formula, image} → false；无行 / 文本不像正文 → false；单行 → true；
 * - 多行需同时满足：左对齐（去首行后 ≥ 80% 行的 x0 与众数差 < 3% 栏宽）、行距规整（相邻行距 max/median ≤ 1.6）、
 *   行高规整（max/min ≤ 1.5）、填充（中位行宽 ≥ 45% 栏宽）。
 * 公式行、表格行、作者块都留原文。
 */
export function isProseLayout(lines: readonly Rect[], kind: PaperBlockKind, colWidth: number, text: string): boolean {
  if (NON_PROSE_KINDS.has(kind)) return false
  if (lines.length === 0) return false
  if (!isProseText(text)) return false
  if (lines.length === 1) return true
  if (!(colWidth > 0)) return false

  const sorted = [...lines].sort((a, b) => a.y - b.y)

  // 左对齐：首行可缩进，不作数；「众数」取容差内最大簇
  const rest = sorted.slice(1)
  const tol = PROSE_LEFT_ALIGN_TOL * colWidth
  let cluster = 0
  for (const a of rest) {
    let n = 0
    for (const b of rest) if (Math.abs(a.x - b.x) < tol) n += 1
    if (n > cluster) cluster = n
  }
  if (cluster < PROSE_LEFT_ALIGN_MIN * rest.length) return false

  // 行距规整
  const pitches: number[] = []
  for (let i = 1; i < sorted.length; i += 1) pitches.push(sorted[i].y - sorted[i - 1].y)
  if (Math.max(...pitches) > PROSE_PITCH_MAX_RATIO * median(pitches)) return false

  // 行高规整
  const heights = sorted.map((l) => l.h)
  const minH = Math.min(...heights)
  if (!(minH > 0) || Math.max(...heights) > PROSE_HEIGHT_MAX_RATIO * minH) return false

  // 填充
  return median(sorted.map((l) => l.w)) >= PROSE_MIN_FILL * colWidth
}

const isBandCol = (c: PdfColumn): boolean => c === 'full' || c === 'span'
const overlapsX = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w

/** `columnExtents` 的返回：left / right 栏的 x 范围与分栏位置 */
export type ColumnExtents = NonNullable<ReturnType<typeof columnExtents>>

/** `isLabelLike` 的页级上下文（`labelContextOf` 由本页全部段落片算出） */
export interface LabelContext {
  /** 本页全部段落片（任何块、任何 kind）：邻居与同块其它片都从这里取 */
  portions: readonly PortionRect[]
  /** = columnExtents(portions)：left / right 片的栏左缘与栏宽；null = 本页没有双栏 */
  columns: ColumnExtents | null
  /** 本页全部行框的 x 并集 [x0, x1]：full / span 片（以及没有双栏的页）的「栏」 */
  extent: readonly [number, number]
}

export function labelContextOf(portions: readonly PortionRect[]): LabelContext {
  let x0 = Infinity
  let x1 = -Infinity
  for (const p of portions) {
    x0 = Math.min(x0, p.rect.x)
    x1 = Math.max(x1, p.rect.x + p.rect.w)
  }
  return { portions, columns: columnExtents(portions), extent: Number.isFinite(x0) ? [x0, x1] : [0, 0] }
}

/** 段落片所在的「栏」[左缘, 宽]：left / right 片用该栏行盒并集，full / span 片与无双栏页用全页文字范围 */
const columnFrameOf = (p: PortionRect, ctx: LabelContext): readonly [number, number] => {
  const c = ctx.columns
  const [x0, x1] = c && p.col === 'left' ? c.left : c && p.col === 'right' ? c.right : ctx.extent
  return [x0, x1 - x0]
}

/**
 * 对照流译文框的横向范围 [x0, x1]（scale = 1 的页面 CSS 空间），按块号：只看块在本页的**最后一片**（译文挂在它之后）。
 * 左缘 = 该片文字左缘。右缘：
 * - left / right 片、多行片 → 该片所在「栏」的右缘（`columnFrameOf`：left / right 片取 columnExtents 的栏右缘，
 *   full / span 片与无双栏页取全页文字范围右缘）——末片只有一行短尾时（图注末行「feedback loop.」），
 *   按片自己的右缘算会把译文框压成一条又高又窄的竖条；
 * - 标题（`kindOf(i) === 'heading'`）与单行的 span / full 片 → 片自己的文字右缘：图内副标题 / 居中短标题的
 *   译文条若伸到全页右缘，会横穿插图边框。
 * 栏右缘不越过栏的文字范围：不伸进分栏槽 / 页边距。
 */
export function translationBounds(
  portions: readonly PortionRect[],
  kindOf?: (blockIndex: number) => PaperBlockKind | undefined,
): Map<number, readonly [number, number]> {
  const out = new Map<number, readonly [number, number]>()
  if (portions.length === 0) return out
  const ctx = labelContextOf(portions)
  for (const p of portions) {
    if (p.segIndex !== p.segCount - 1) continue
    const own = p.rect.x + p.rect.w
    const keepOwn = kindOf?.(p.blockIndex) === 'heading' || (isBandCol(p.col) && p.lines.length <= 1)
    if (keepOwn) {
      out.set(p.blockIndex, [p.rect.x, own])
      continue
    }
    const [cx, cw] = columnFrameOf(p, ctx)
    out.set(p.blockIndex, [p.rect.x, Math.max(own, cx + cw)])
  }
  return out
}

/**
 * 判「同栏邻居」：两片都在左 / 右栏 → 同栏即是（栏内上下文）；任一片是 full / span → 横向有交叠才算
 * （通栏片上下的内容可能在任一栏，只有压在它正上 / 正下方的才构成「上下文」）。
 */
const sharesColumn = (a: PortionRect, b: PortionRect): boolean =>
  !isBandCol(a.col) && !isBandCol(b.col) ? a.col === b.col : overlapsX(a.rect, b.rect)

/** 规则 1「孤立短标签」：单片单行、短于 LABEL_MAX_CHARS、上下最近的同栏邻居都远于 2.5 行高 */
function isIsolatedLabel(portion: PortionRect, ctx: LabelContext, chars: number): boolean {
  if (portion.segCount !== 1 || portion.lines.length !== 1 || chars >= LABEL_MAX_CHARS) return false
  const lineH = portion.lines[0].h > 0 ? portion.lines[0].h : portion.rect.h
  const limit = LABEL_ISOLATION_PITCHES * lineH
  const top = portion.rect.y
  const bottom = bottomOf(portion.rect)
  const mid = top + portion.rect.h / 2
  for (const q of ctx.portions) {
    if (q === portion || !sharesColumn(portion, q)) continue
    // 按中线分上下；交叠时间隙为负，自然不孤立
    const qMid = q.rect.y + q.rect.h / 2
    const gap = qMid < mid ? top - bottomOf(q.rect) : q.rect.y - bottom
    if (gap <= limit) return false
  }
  return true
}

/** 规则 3「离栏短文本」的逐行判定：左缘离栏左缘 > 10% 栏宽，且窄于 80% 栏宽 */
const isOffColumnLine = (line: Rect, frame: readonly [number, number]): boolean => {
  const [colX, colW] = frame
  return colW > 0 && line.x - colX > LABEL_X_OFFSET_RATIO * colW && line.w < LABEL_MAX_WIDTH_RATIO * colW
}

/** 贴栏左缘的多行正文（任一行离栏左缘 ≤ 10% 栏宽）：悬挂缩进续行的「母段」 */
const isColumnBody = (p: PortionRect, ctx: LabelContext): boolean => {
  if (p.lines.length < 2) return false
  const [colX, colW] = columnFrameOf(p, ctx)
  return p.lines.some((l) => l.x - colX <= LABEL_X_OFFSET_RATIO * colW)
}

/** 规则 3 的排除：段落片正上方 LABEL_ATTACH_PITCHES 行高之内紧贴着一段同栏正文（悬挂缩进续行） */
const hangsUnderBody = (p: PortionRect, ctx: LabelContext): boolean => {
  const lineH = median(p.lines.map((l) => l.h))
  const limit = LABEL_ATTACH_PITCHES * (lineH > 0 ? lineH : p.rect.h)
  const mid = p.rect.y + p.rect.h / 2
  return ctx.portions.some(
    (q) =>
      q.blockIndex !== p.blockIndex &&
      sharesColumn(p, q) &&
      q.rect.y + q.rect.h / 2 < mid &&
      p.rect.y - bottomOf(q.rect) <= limit &&
      isColumnBody(q, ctx),
  )
}

/**
 * 段落片是不是「图内文字」（示意图的标签、图内副标题）：就地译文不给它——中文模式盖一个译文框会糊住图，
 * 对照模式每个标签挂一行译文会把图切成一条条（QA r1 Remaining 4）。原版视图专用，文本视图照常翻译。
 *
 * 先排除：heading（标题进目录、本来就该译）、空文本、图注前缀（`Figure 2.` / `表 3`，图注是正文）、
 * 列表符号 / 编号起头（单行列表项、参考文献条目是正文）。之后任一规则命中即是：
 * 1. **孤立短标签**：块只有这一片且只有一行，短于 LABEL_MAX_CHARS，纵向孤立——上下两侧最近的同栏邻居
 *    （`sharesColumn`）都远于 LABEL_ISOLATION_PITCHES × 本行行高；某一侧没有邻居算该侧孤立，
 *    所以「一侧空、另一侧紧贴一行」仍不是（正文段落首尾的单行）。
 * 2. **粘连标签**：块有 ≥ 2 片、整块短于 LABEL_GLUED_MAX_CHARS，且「每片恰 1 行」或「通栏片（span / full）
 *    与栏内片（left / right）混在一块里」——解析器把同一 y 上散在几栏的图内标签拼成了一块（主样本第 4 页
 *    「More AI R&D leads … Humans …」是 left 3 行 → span 1 行 → right 2 行）。正文只会 left → right 或跨页续，
 *    不会在同一页里进出通栏；真正的跨栏段落「两边各一行且很短」极少见，误判也只是原版视图不就地译（文本视图照常）。
 * 3. **离栏短文本**：每片至多 LABEL_OFFCOL_MAX_LINES 行，整块短于 LABEL_GLUED_MAX_CHARS，且**每一行**
 *    都离栏左缘 > LABEL_X_OFFSET_RATIO 栏宽、窄于 LABEL_MAX_WIDTH_RATIO 栏宽（`columnFrameOf`）——
 *    图内居中的副标题；正文行贴栏左缘（首行缩进 ≈ 6% 栏宽，不到 10%）。
 *    但紧贴在一段贴栏左缘的多行正文正下方的不算（`hangsUnderBody`：悬挂缩进续行，如参考文献条目尾行）。
 * 规则 2 / 3 是块级的：要求整块都在本页（同块各片判定一致，对照流按块挂译文、覆盖层按片盖，两种模式同一结论）；
 * 插图里的文字不会跨页。纯函数；`ctx.portions` 含 `portion` 自身（按引用跳过）。
 */
export function isLabelLike(portion: PortionRect, ctx: LabelContext, text: string, kind: PaperBlockKind): boolean {
  if (kind === 'heading') return false
  const t = text.trim()
  if (t === '' || CAPTION_PREFIX.test(t) || LIST_MARKER.test(t)) return false
  const chars = Array.from(t).length
  if (isIsolatedLabel(portion, ctx, chars)) return true

  if (chars >= LABEL_GLUED_MAX_CHARS) return false
  const own = ctx.portions.filter((q) => q.blockIndex === portion.blockIndex)
  if (own.length !== portion.segCount) return false
  if (own.length >= 2) {
    const oneLineEach = own.every((q) => q.lines.length === 1)
    const mixesBandAndColumn = own.some((q) => isBandCol(q.col)) && own.some((q) => !isBandCol(q.col))
    if (oneLineEach || mixesBandAndColumn) return true
  }
  return own.every(
    (q) =>
      q.lines.length >= 1 &&
      q.lines.length <= LABEL_OFFCOL_MAX_LINES &&
      q.lines.every((l) => isOffColumnLine(l, columnFrameOf(q, ctx))) &&
      !hangsUnderBody(q, ctx),
  )
}

/** 页面 CSS 空间 → 实际 scale：四条边先乘后取整，相邻条带共用同一边界值 → 取整后仍严丝合缝（无 1px 缝） */
export function scaleRect(r: Rect, scale: number): Rect {
  const x0 = Math.round(r.x * scale)
  const y0 = Math.round(r.y * scale)
  const x1 = Math.round((r.x + r.w) * scale)
  const y1 = Math.round((r.y + r.h) * scale)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// ---------------------------------------------------------------------------
// 当前块 / 可见区间
// ---------------------------------------------------------------------------

/** 块与带是否有正面积相交（零面积相切不算，与 pickCurrentPage 的「贴边归下一页」同口径） */
const intersectsBand = (e: BlockEdges, top: number, bottom: number): boolean => e.bottom > top && e.top < bottom

/**
 * 「当前块」= 与观察带 `[bandTop, bandBottom]` 相交的块里序号最小者；没有 → undefined（调用方沿用上次）。
 * 入参不要求有序。
 */
export function pickCurrentBlock(edges: readonly BlockEdges[], bandTop: number, bandBottom: number): number | undefined {
  let best: number | undefined
  for (const e of edges) {
    if (intersectsBand(e, bandTop, bandBottom) && (best === undefined || e.blockIndex < best)) best = e.blockIndex
  }
  return best
}

/**
 * 观察带里一个块都没有时（整页插图 / 页间空隙 / 只有图的页）的兜底：报「刚读过的」那块——底边在带顶之上、
 * 离带最近者；上方没有 → 带下方最近的一块；都没有 → undefined。工作台的 {blockIndex, page} 由此保持一致，
 * 不会出现「页已翻到插图页、块序号还停在几页之前」（审查项 5）。入参通常是当前页及前后各一页的块边。
 */
export function pickNearestBlock(edges: readonly BlockEdges[], bandTop: number, bandBottom: number): number | undefined {
  let above: BlockEdges | undefined
  let below: BlockEdges | undefined
  for (const e of edges) {
    if (e.bottom <= bandTop) {
      if (!above || e.bottom > above.bottom || (e.bottom === above.bottom && e.blockIndex > above.blockIndex)) above = e
    } else if (e.top >= bandBottom) {
      if (!below || e.top < below.top || (e.top === below.top && e.blockIndex < below.blockIndex)) below = e
    }
  }
  return (above ?? below)?.blockIndex
}

/**
 * 对照流：块的译文现在挂出来会不会推动读者视线处的内容（PdfViewer 据此延后挂出，QA r1 C13）。
 * 只有「插入点（块最后一条图条的底边）在视线之上（含正好贴着视线）」且「插入点所在的双栏行与窗格相交」才会：
 * 双栏行里两栏各自一叠，单一 scrollTop 补偿只保得住一栏；插入点在通栏条带（row = null）或整行已离开窗格时，
 * 插入只造成整体位移，原生 overflow-anchor / WebKit 补偿兜得住，不必延后。
 * 视线取「窗格顶 + 20px」而不是观察带顶：跳转把目标块对齐在 +16，它上一块的底边正好在 +16——按带顶判会放行，
 * 上一块的译文落地就把刚跳到的目标推出观察带（QA r1 E22：跳到 Conclusion 记成左栏的 99）。入参都是视口坐标。
 */
export function insertionPushesReader(
  ins: { stripBottom: number; row: { top: number; bottom: number } | null },
  pane: { top: number; bottom: number },
  readingLine: number,
): boolean {
  if (!ins.row) return false
  return ins.stripBottom <= readingLine && ins.row.bottom > pane.top && ins.row.top < pane.bottom
}

/** 与 `[top, bottom]` 相交的块序号区间（语音播报用）；没有 → null */
export function visibleBlockRange(
  edges: readonly BlockEdges[],
  top: number,
  bottom: number,
): { min: number; max: number } | null {
  let min = Infinity
  let max = -Infinity
  for (const e of edges) {
    if (!intersectsBand(e, top, bottom)) continue
    if (e.blockIndex < min) min = e.blockIndex
    if (e.blockIndex > max) max = e.blockIndex
  }
  return Number.isFinite(min) ? { min, max } : null
}

// ---------------------------------------------------------------------------
// 段落对照流分区
// ---------------------------------------------------------------------------

/** 一个段落片的行高：自身行高中位数，无行时用页级兜底 */
const lineHeightOf = (p: PortionRect, fallback: number): number => {
  const m = median(p.lines.map((l) => l.h))
  return m > 0 ? m : fallback
}

/**
 * 相邻两段内容之间的条带边界：`prev.bottom + clamp(gap / 2, 0, 0.6 × prevLineH)`。
 * 普通段间距 → 中点；大空隙（插图）→ 紧贴前块底，空隙归下一条带。
 */
const cutAfter = (prevBottom: number, prevLineH: number, nextTop: number): number =>
  prevBottom + clamp((nextTop - prevBottom) / 2, 0, CUT_MAX_LINE_RATIO * prevLineH)

type StripKeyer = (col: string, y: number) => string

/** key = `${page}:${col}:${round(y)}`；极端退化（亚像素高的条带）才会撞 key，撞了加后缀保证唯一 */
const makeKeyer = (page: number): StripKeyer => {
  const used = new Map<string, number>()
  return (col, y) => {
    const base = `${page}:${col}:${Math.round(y)}`
    const n = used.get(base) ?? 0
    used.set(base, n + 1)
    return n === 0 ? base : `${base}#${n + 1}`
  }
}

/**
 * 段落对照流分区：把一页切成条带（`full` 行通栏，`columns` 行左右并排各自一叠），译文挂在 showTranslation 的条带之后。
 * 三条不变量（单测逐例断言）：铺满（条带并集 = 页矩形，列条带 x 固定为 [0, split) / [split, pageWidth)）、无重叠、阅读序。
 *
 * 规则：
 * 1. 没有 left / right 片 → 单栏：每片一个 full 行，首行从 0 起、末行到页底；无片 → 整页一个无块 full 行。
 * 2. 双栏：span / full 片为「带」（full 行），带的上下边界用 cut 对最近内容（任一列）求得；带之间含列片 → columns 行。
 * 3. 页眉：最上方列内容顶部减去 cut 余量后仍 > 2 行高 → 无块 full 行 [0, cut)；页脚同理到页底。
 *    页码独立成行，不会被两列不同高度的译文撕成两半；不足 2 行高则并入相邻 columns 行。
 * 4. columns 行内每侧：首条带从行顶起；相邻片用 cut；末条带到 prev.bottom + cut，剩余 > 2 行高则加无块 trailing 条带
 *    （列末插图留在原位，译文紧跟文字），否则延伸到行底；某侧无片 → 整侧一个 trailing 条带。
 * 5. `showTranslation = 有 blockIndex ∧ 是该块最后一个 seg ∧ 不是图内标签（!label）∧ isTranslatable(blockIndex)`。
 *    查看器传真正的谓词（`isTranslatableBlock(kind) && text 非空`）；缺省 `() => true`。
 *    图内标签不挂译文行：否则示意图被一行行译文切成碎条（`isLabelLike`）。
 * 6. 片按 rect.y 排序后处理（同列 DOM 序必须是纵向序）；解析器产出本就自上而下，正常页与阅读序一致。
 *
 * `geom.page` 只用于 key（`${page}:${col}:${round(y)}`），缺省 0。退化输入（片重叠）下边界单调钳位，零高条带丢弃。
 */
export function partitionPageFlow(
  geom: { pageWidth: number; pageHeight: number; page?: number },
  rects: readonly PortionRect[],
  opts?: { isTranslatable: (blockIndex: number) => boolean },
): FlowRow[] {
  const { pageWidth, pageHeight } = geom
  const isTranslatable = opts?.isTranslatable ?? (() => true)
  const key = makeKeyer(geom.page ?? 0)
  const pageLineH = (() => {
    const m = median(rects.flatMap((p) => p.lines.map((l) => l.h)))
    return m > 0 ? m : DEFAULT_LINE_H
  })()
  const minBand = RUNNING_BAND_MIN_LINES * pageLineH

  const sorted = rects
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.rect.y - b.p.rect.y || a.i - b.i)
    .map((e) => e.p)

  const showFor = (p: PortionRect): boolean => p.segIndex === p.segCount - 1 && !p.label && isTranslatable(p.blockIndex)

  const strip = (col: string, x: number, w: number, top: number, bottom: number, p?: PortionRect): Strip | null => {
    if (!(bottom > top)) return null
    return {
      key: key(col, top),
      rect: { x, y: top, w, h: bottom - top },
      blockIndex: p?.blockIndex,
      showTranslation: p ? showFor(p) : false,
    }
  }

  const fullRow = (top: number, bottom: number, p?: PortionRect): FlowRow | null => {
    const s = strip('full', 0, pageWidth, top, bottom, p)
    return s ? { kind: 'full', key: s.key, strip: s } : null
  }

  const rows: FlowRow[] = []
  const push = (row: FlowRow | null) => {
    if (row) rows.push(row)
  }

  // ---- 1. 单栏 ----
  const ext = columnExtents(sorted)
  if (!ext) {
    if (sorted.length === 0) {
      push(fullRow(0, pageHeight))
      return rows
    }
    let top = 0
    for (let i = 0; i < sorted.length; i += 1) {
      const p = sorted[i]
      const next = sorted[i + 1]
      const bottom = next ? clamp(cutAfter(bottomOf(p.rect), lineHeightOf(p, pageLineH), next.rect.y), top, pageHeight) : pageHeight
      push(fullRow(top, bottom, p))
      top = bottom
    }
    return rows
  }

  // ---- 2. 双栏：按纵向序分组为「带」与「列组」 ----
  type Group = { kind: 'band'; p: PortionRect } | { kind: 'cols'; items: PortionRect[] }
  const groups: Group[] = []
  for (const p of sorted) {
    if (p.col === 'left' || p.col === 'right') {
      const last = groups[groups.length - 1]
      if (last && last.kind === 'cols') last.items.push(p)
      else groups.push({ kind: 'cols', items: [p] })
    } else {
      groups.push({ kind: 'band', p })
    }
  }

  // 组与组之间的边界：对最近内容求 cut（列组取最靠近带的那一片）
  const lowest = (items: readonly PortionRect[]): PortionRect =>
    items.reduce((a, b) => (bottomOf(b.rect) > bottomOf(a.rect) ? b : a))
  const highest = (items: readonly PortionRect[]): PortionRect =>
    items.reduce((a, b) => (b.rect.y < a.rect.y ? b : a))
  const boundaryBetween = (a: Group, b: Group): number => {
    const prev = a.kind === 'band' ? a.p : lowest(a.items)
    const next = b.kind === 'band' ? b.p : highest(b.items)
    return cutAfter(bottomOf(prev.rect), lineHeightOf(prev, pageLineH), next.rect.y)
  }

  // ---- 3. 页眉 / 页脚（只在首 / 末组是列组时才有「两列撕裂页码」的问题；带本身就是通栏条带） ----
  const first = groups[0]
  const last = groups[groups.length - 1]
  let cursor = 0
  if (first.kind === 'cols') {
    const topContent = highest(first.items).rect.y
    const headerCut = topContent - clamp(topContent / 2, 0, CUT_MAX_LINE_RATIO * pageLineH)
    if (headerCut > minBand) {
      push(fullRow(0, headerCut))
      cursor = headerCut
    }
  }
  let footerTop = pageHeight
  if (last.kind === 'cols') {
    const lowestP = lowest(last.items)
    const bottomContent = bottomOf(lowestP.rect)
    const footerCut = cutAfter(bottomContent, lineHeightOf(lowestP, pageLineH), pageHeight)
    if (pageHeight - footerCut > minBand) footerTop = footerCut
  }

  // ---- 4. 逐组出行 ----
  const columnStrips = (items: readonly PortionRect[], col: 'left' | 'right', rowTop: number, rowBottom: number): Strip[] => {
    const x = col === 'left' ? 0 : ext.split
    const w = col === 'left' ? ext.split : pageWidth - ext.split
    const out: Strip[] = []
    const add = (top: number, bottom: number, p?: PortionRect) => {
      const s = strip(col, x, w, top, bottom, p)
      if (s) out.push(s)
    }
    const mine = items.filter((p) => p.col === col)
    if (mine.length === 0) {
      add(rowTop, rowBottom)
      return out
    }
    let top = rowTop
    for (let i = 0; i < mine.length; i += 1) {
      const p = mine[i]
      const next = mine[i + 1]
      const lh = lineHeightOf(p, pageLineH)
      if (next) {
        const bottom = clamp(cutAfter(bottomOf(p.rect), lh, next.rect.y), top, rowBottom)
        add(top, bottom, p)
        top = bottom
      } else {
        const end = clamp(cutAfter(bottomOf(p.rect), lh, rowBottom), top, rowBottom)
        if (rowBottom - end > minBand) {
          add(top, end, p)
          add(end, rowBottom)
        } else {
          add(top, rowBottom, p)
        }
      }
    }
    return out
  }

  for (let gi = 0; gi < groups.length; gi += 1) {
    const g = groups[gi]
    const next = groups[gi + 1]
    const top = cursor
    const bottom = next ? clamp(boundaryBetween(g, next), top, footerTop) : footerTop
    if (g.kind === 'band') {
      push(fullRow(top, bottom, g.p))
    } else if (bottom > top) {
      rows.push({
        kind: 'columns',
        key: key('cols', top),
        top,
        bottom,
        split: ext.split,
        left: columnStrips(g.items, 'left', top, bottom),
        right: columnStrips(g.items, 'right', top, bottom),
      })
    }
    cursor = bottom
  }
  if (footerTop < pageHeight) push(fullRow(footerTop, pageHeight))
  return rows
}

/**
 * 文本项基线点 → 条带归属（Int32Array，下标对应 strips 下标）。每个点恰好归一个条带：
 * 纵向按 `(top, bottom]` 判（共享边界上的点归上方条带——基线点在文字底部，cut 在其下方）；横向按 `[x, x + w)`。
 * 落在所有条带之外的点（页外、亚像素误差）归纵向距离最近的条带，再按横向距离、再按下标。
 */
export function assignPointsToStrips(
  points: readonly { x: number; y: number }[],
  strips: readonly { rect: Rect }[],
): Int32Array {
  const out = new Int32Array(points.length)
  if (strips.length === 0) return out
  for (let i = 0; i < points.length; i += 1) {
    const { x, y } = points[i]
    let best = -1
    let bestDy = Infinity
    let bestDx = Infinity
    for (let s = 0; s < strips.length; s += 1) {
      const r = strips[s].rect
      const insideY = y > r.y && y <= r.y + r.h
      const insideX = x >= r.x && x < r.x + r.w
      if (insideY && insideX) {
        best = s
        break
      }
      // 条带外：到最近边的距离（恰在开边界上的点距离为 0 但不算「在内」，由区间开闭决定归属）
      const dy = insideY ? 0 : Math.min(Math.abs(y - r.y), Math.abs(y - (r.y + r.h)))
      const dx = insideX ? 0 : Math.min(Math.abs(x - r.x), Math.abs(x - (r.x + r.w)))
      if (dy < bestDy || (dy === bestDy && dx < bestDx)) {
        best = s
        bestDy = dy
        bestDx = dx
      }
    }
    out[i] = best
  }
  return out
}

// ---------------------------------------------------------------------------
// 中文覆盖：字号拟合与译文拆分
// ---------------------------------------------------------------------------

/**
 * 覆盖字号拟合的纯数学部分：译文在原段落框里溢出（scrollH > boxH）时给出下一轮字号。
 * 已放得下、或已到下限 → null（停止）；否则 `max(fMin, f × clamp(√(boxH / scrollH) × 0.98, 0.5, 0.97))`。
 * 面积按字号平方缩，所以按 √ 缩一步基本到位；上下钳位保证每轮有进展又不会一步缩成蚂蚁字。
 */
export function planFontFit(boxH: number, scrollH: number, f: number, fMin: number): number | null {
  if (!Number.isFinite(boxH) || !Number.isFinite(scrollH) || !Number.isFinite(f)) return null
  if (scrollH <= boxH) return null
  if (f <= fMin) return null
  const ratio = clamp(Math.sqrt(Math.max(0, boxH) / scrollH) * FONT_FIT_SAFETY, FONT_FIT_MIN_STEP, FONT_FIT_MAX_STEP)
  return Math.max(fMin, f * ratio)
}

/**
 * 跨栏 / 跨页块的译文按各 seg 行数比例拆成 `weights.length` 段：目标点取累计比例，在 ±15% 全文长度窗口内
 * 找离目标最近的 `。；！？，、.;,`（切在标点之后；等距取靠前者），找不到就硬切。
 * 不变量：`join('') === text`；`weights = [n]` → `[text]`；空文本 → 等长的空串数组；
 * 文本码点数 ≥ 段数时每段非空（空段会在原文行上盖一个空白框）。按码点切，不会劈开代理对。
 */
export function splitTranslation(text: string, weights: readonly number[]): string[] {
  const n = weights.length
  if (n === 0) return []
  if (n === 1) return [text]
  const chars = Array.from(text)
  const len = chars.length
  if (len === 0) return new Array<string>(n).fill('')
  // 字比段还少：前 len 段各一字，其余空串
  if (len < n) return chars.concat(new Array<string>(n - len).fill(''))

  const positive = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0))
  const total = positive.reduce((a, b) => a + b, 0)
  const effective = total > 0 ? positive : weights.map(() => 1)
  const sum = total > 0 ? total : n

  const window = Math.max(1, Math.round(len * SPLIT_WINDOW_RATIO))
  const cuts: number[] = []
  let acc = 0
  let prevCut = 0
  for (let k = 0; k < n - 1; k += 1) {
    acc += effective[k]
    // 切点可行区间：本段至少 1 字，后面每段也各留 1 字
    const loCut = prevCut + 1
    const hiCut = len - (n - 1 - k)
    const target = clamp(Math.round((len * acc) / sum), loCut, hiCut)
    let cut = target
    let bestDist = Infinity
    const from = Math.max(loCut, target - window)
    const to = Math.min(hiCut, target + window)
    // 切点 c 落在 chars[c − 1] 之后
    for (let c = from; c <= to; c += 1) {
      if (!SPLIT_PUNCTUATION.has(chars[c - 1])) continue
      const dist = Math.abs(c - target)
      if (dist < bestDist) {
        bestDist = dist
        cut = c
      }
    }
    cuts.push(cut)
    prevCut = cut
  }

  const pieces: string[] = []
  let start = 0
  for (const c of cuts) {
    pieces.push(chars.slice(start, c).join(''))
    start = c
  }
  pieces.push(chars.slice(start).join(''))
  return pieces
}
