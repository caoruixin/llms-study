import type { NormalizedBlock, PdfBlockLayout, PdfColumn, PdfLayoutSeg, PdfLineBox } from './types'

/**
 * PDF 文字层规范化：纯函数，输入是 pdf.js `getTextContent()` 产出的形状，
 * 与 pdfjs 运行时完全解耦（parsePdf.ts 才碰二进制），因此可直接进 node 单测。
 */
export interface PdfTextItem {
  str: string
  /** [a, b, c, d, e, f]：e = x，f = y（PDF 坐标系 y 向上增大） */
  transform: number[]
  width: number
  height: number
  hasEOL?: boolean
  /**
   * 字体上伸比例（pdf.js `styles[fontName].ascent`，parsePdf.ts 钳到 [0.5, 1.2]）；
   * 缺省 DEFAULT_ASCENT。行框 yTop = 基线 + ascent × 字号。
   */
  ascent?: number
}

/** 字体没有可用 ascent 时的回退值，与 pdf.js TextLayer 自己的回退值一致 */
export const DEFAULT_ASCENT = 0.8

export interface PdfPageText {
  page: number
  items: PdfTextItem[]
}

/** pdf.js `getTextContent().items` 的元素（混有 TextMarkedContent，字段一律按 unknown 校验） */
export interface RawTextItem {
  str?: unknown
  transform?: unknown
  width?: unknown
  height?: unknown
  hasEOL?: unknown
  fontName?: unknown
}

/** pdf.js `getTextContent().styles[fontName]` */
export interface RawTextStyle {
  ascent?: unknown
  descent?: unknown
}

/** ascent 的合理区间：超出即字体度量损坏，退回缺省 */
const ASCENT_MIN = 0.5
const ASCENT_MAX = 1.2

/**
 * 镜像 pdf.js `TextLayer.#getAscent` 拿不到 canvas 度量时的回退：`ascent || (descent ? 1 + descent : 缺省)`
 * （descent 为负数），钳到 [0.5, 1.2]；无效则返回 undefined（不写字段，toLine 用 DEFAULT_ASCENT）。
 */
export function styleAscent(style: RawTextStyle | undefined): number | undefined {
  if (!style) return undefined
  let ratio: number | undefined
  if (typeof style.ascent === 'number' && style.ascent) ratio = style.ascent
  else if (typeof style.descent === 'number' && style.descent) ratio = 1 + style.descent
  if (ratio === undefined || !Number.isFinite(ratio)) return undefined
  return Math.min(ASCENT_MAX, Math.max(ASCENT_MIN, ratio))
}

/** pdf.js 的 items 混有 TextMarkedContent，用结构判定过滤出真正的文本项；ascent 取自 styles[fontName] */
export function toTextItem(raw: RawTextItem, styles?: Record<string, RawTextStyle>): PdfTextItem | null {
  if (typeof raw.str !== 'string' || !Array.isArray(raw.transform)) return null
  const item: PdfTextItem = {
    str: raw.str,
    transform: raw.transform as number[],
    width: typeof raw.width === 'number' ? raw.width : 0,
    height: typeof raw.height === 'number' ? raw.height : 0,
    hasEOL: raw.hasEOL === true,
  }
  const ascent = styles && typeof raw.fontName === 'string' ? styleAscent(styles[raw.fontName]) : undefined
  if (ascent !== undefined) item.ascent = ascent
  return item
}

interface Line {
  page: number
  /** 基线 = 行内各项 y 的最大值 */
  y: number
  x0: number
  x1: number
  /** 主导字号：按 str 长度加权的 height 中位数（上标 / 脚注标不拉偏；原为 max） */
  height: number
  /** 行框上沿 = max(y_i + ascent_i × h_i) */
  yTop: number
  /** 行框下沿 = min(y_i + (ascent_i − 1) × h_i) */
  yBottom: number
  text: string
  col: PdfColumn
  /** 原始文本项（页眉页脚的项级剥离要重建行） */
  items: PdfTextItem[]
}

const xOf = (it: PdfTextItem) => it.transform[4] ?? 0
const yOf = (it: PdfTextItem) => it.transform[5] ?? 0
const rightOf = (it: PdfTextItem) => xOf(it) + (it.width || 0)

/** 中日韩字符与全角标点：拼接时两侧只要有一个是 CJK 就不补空格 */
const CJK = /[　-鿿豈-﫿＀-￯]/
const isCjkAt = (s: string, i: number) => (i >= 0 && i < s.length ? CJK.test(s[i]) : false)

/** 句末终止标点：用于判断段落是否已结束（跨页合并与断段都依赖它） */
const ENDS_SENTENCE = /[.。!！?？;；:：]["'”’)）]?$/
/** 纯页码行：常见于页眉页脚，规范化时直接丢弃 */
const PAGE_NUMBER_ONLY = /^\d{1,4}$/
/** 编号标题：1 / 2.3 / 4.1.2 起头；首段数字限制 2 位，避免把 "2020. ..." 误判为标题 */
const NUMBERED_HEADING = /^(\d{1,2}(?:\.\d{1,2})*)[.、]?\s+(\S.*)$/
/**
 * 编号标题的最小字号 = 正文的 95%：尾注 / 脚注（9pt 的「1. Machine-learning venues …」）也是「数字. 文字」形状，
 * 一篇论文十几条全进了目录与 anchor.section。标题从不比正文小；关键词标题（Abstract / References）不受此限。
 */
const NUMBERED_HEADING_MIN_HEIGHT_RATIO = 0.95
/**
 * 编号标题的正文须以字母 / CJK 起头：「2 · 10⁶–2 · 10⁸. As in the main text…」里的「编号」其实是数量表达的数字，
 * 正文以 `·` / `×` / `–` / `(` / 数字起头的都不是章节标题。
 */
const headingBodyStartsWithWord = (body: string) => LATIN_LETTER.test(body[0] ?? '') || CJK.test(body[0] ?? '')
/** 标题正文不含「句末标点 + 空格 + 大写」的句界：一句完整句子后面接下一句的，是正文不是标题 */
const MID_SENTENCE_BOUNDARY = /[.!?]\s+[A-Z]/

const LATIN_LETTER = /[A-Za-z]/
const DIGIT = /[0-9]/
/** 标题正文的最小「实词量」：拉丁字母记 1 分，CJK 记 2 分（「方法」「结论」两字即成章节名） */
const MIN_HEADING_CONTENT_SCORE = 3
/** 数字 + 空白在标题正文中的占比上限（表格数字行、公式碎片几乎全由这两类字符构成） */
const MAX_HEADING_NUMERIC_RATIO = 0.5

/**
 * 标题正文的实词密度守卫。
 *
 * 为什么必须有这一层：`NUMBERED_HEADING` 只看「数字起头 + 后面还有字符」，于是 PDF 文字层里
 * 表格的数字行（`1 512 512 5.29 24.9`）、公式碎片（`1 n 1 n i i`）、图表轴标签（`1 2 4 8 16`）
 * 全都能匹配。它们一旦被判成标题，就会污染目录、`anchor.section`、buildCiteMap 的 § 标签。
 * 判据：正文部分要有足够的字母/CJK 内容，且不能几乎全是数字与空白。
 */
function hasHeadingContent(body: string): boolean {
  const s = body.trim()
  if (!s) return false
  let score = 0
  let numericLike = 0
  for (const ch of s) {
    if (CJK.test(ch)) score += 2
    else if (LATIN_LETTER.test(ch)) score += 1
    else if (DIGIT.test(ch) || /\s/.test(ch)) numericLike += 1
  }
  if (score < MIN_HEADING_CONTENT_SCORE) return false
  return numericLike / s.length < MAX_HEADING_NUMERIC_RATIO
}

const HEADING_WORDS = new Set([
  'abstract', 'introduction', 'background', 'related work', 'method', 'methods', 'methodology',
  'approach', 'experiment', 'experiments', 'experimental setup', 'results', 'evaluation',
  'discussion', 'conclusion', 'conclusions', 'references', 'acknowledgments', 'acknowledgements',
  'appendix', 'limitations',
  '摘要', '引言', '绪论', '背景', '相关工作', '方法', '实验', '结果', '评估', '讨论', '结论',
  '参考文献', '致谢', '附录', '局限性',
])

function median(nums: number[]): number {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** 行内按 x 升序拼接：修复公式 / 多列排版下文本项乱序，按 x 间距决定是否补空格 */
function joinLineItems(items: PdfTextItem[]): string {
  const sorted = [...items].sort((a, b) => xOf(a) - xOf(b))
  let text = ''
  let prevRight = 0
  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i]
    const s = it.str
    if (!s) continue
    if (text) {
      const gap = xOf(it) - prevRight
      const threshold = Math.max(0.6, (it.height || 10) * 0.18)
      const leftCjk = isCjkAt(text, text.length - 1)
      const rightCjk = isCjkAt(s, 0)
      const alreadySpaced = /\s$/.test(text) || /^\s/.test(s)
      if (gap > threshold && !alreadySpaced && !leftCjk && !rightCjk) text += ' '
    }
    text += s
    prevRight = xOf(it) + (it.width || 0)
  }
  return text.replace(/\s+/g, ' ').trim()
}

/** 按 y 值把文本项聚成「行」（±容差），自上而下 */
function clusterRows(items: PdfTextItem[]): PdfTextItem[][] {
  const sorted = [...items].sort((a, b) => yOf(b) - yOf(a) || xOf(a) - xOf(b))
  const groups: PdfTextItem[][] = []
  let current: PdfTextItem[] = [sorted[0]]
  let currentY = yOf(sorted[0])

  for (let i = 1; i < sorted.length; i++) {
    const it = sorted[i]
    const tol = Math.max(2, (it.height || 10) * 0.5)
    if (Math.abs(yOf(it) - currentY) <= tol) {
      current.push(it)
    } else {
      groups.push(current)
      current = [it]
      currentY = yOf(it)
    }
  }
  groups.push(current)
  return groups
}

/**
 * 旋转文本项（竖排水印、旋转图注）：arXiv 左缘的竖排 `arXiv:2609.36054v1 [cs.CY]` 水印
 * 若不剔除，会以一条「横跨版心」的假行参与分栏与断段。
 */
const isRotated = (it: PdfTextItem) => Math.abs(it.transform[1] ?? 0) > Math.abs(it.transform[0] ?? 0)

/** 页 → 行（文本项分组）：过滤空白项与旋转项后按 y 聚类 */
function prepareRows(page: PdfPageText): PdfTextItem[][] {
  const items = page.items.filter((it) => it.str && it.str.trim().length > 0 && !isRotated(it))
  return items.length ? clusterRows(items) : []
}

/**
 * 主导字号：按 str 长度加权的 height 中位数。
 * 带上标引用 [12] / 脚注标的行不再因一个 7pt 小字或一个大字符被判成字号变化。
 */
function dominantHeight(items: PdfTextItem[]): number {
  const pairs = items
    .filter((it) => (it.height || 0) > 0)
    .map((it) => ({ h: it.height, w: Math.max(1, it.str.trim().length) }))
    .sort((a, b) => a.h - b.h)
  if (!pairs.length) return 0
  const total = pairs.reduce((s, p) => s + p.w, 0)
  let acc = 0
  for (const p of pairs) {
    acc += p.w
    if (acc * 2 >= total) return p.h
  }
  return pairs[pairs.length - 1].h
}

function toLine(page: number, items: PdfTextItem[], col: PdfColumn): Line | null {
  const text = joinLineItems(items)
  if (!text) return null
  let yTop = -Infinity
  let yBottom = Infinity
  for (const it of items) {
    const h = it.height || 0
    const a = it.ascent ?? DEFAULT_ASCENT
    const y = yOf(it)
    yTop = Math.max(yTop, y + a * h)
    yBottom = Math.min(yBottom, y + (a - 1) * h)
  }
  return {
    page,
    y: Math.max(...items.map(yOf)),
    x0: Math.min(...items.map(xOf)),
    x1: Math.max(...items.map(rightOf)),
    height: dominantHeight(items),
    yTop,
    yBottom,
    text,
    col,
    items,
  }
}

// ---------------------------------------------------------------------------
// 分栏槽检测
// ---------------------------------------------------------------------------

/** 版心中部允许出现分栏槽的横向区间 */
const GUTTER_SEARCH_LO = 0.35
const GUTTER_SEARCH_HI = 0.65
/**
 * 分栏槽最小宽度：取「版心宽 1.2%」与「页面主导字号 0.65em」的较大者。
 * LaTeX `\columnsep` 默认 10pt ≈ 1em，pdf.js 项宽略有溢出后净空仍 ≥ 0.75em；词间距（含句末加宽）≤ 0.6em，
 * 且词间空隙不会在 90% 的行上纵向对齐。原来的「版心 3%」在 A4 上是 15pt，会把 10pt 槽的标准双栏论文整篇判成单栏。
 */
const MIN_GUTTER_RATIO = 0.012
const MIN_GUTTER_EM = 0.65
/** 分箱分辨率：A4 版心约 500pt → 每箱 0.25pt，量化误差远小于槽宽与词间距之差（≈ 2pt） */
const GUTTER_BINS = 2000
/** 行内连续 run 跨度超过版心宽的 70% = 通栏行（标题、通栏框、图注），不参与分栏槽直方图 */
const WIDE_RUN_RATIO = 0.7
/**
 * 同一行里相邻项间距 ≤ 0.5em 视为同一个 run。词级碎片间距 ≤ 0.3em；而分栏槽净空 ≥ 0.75em——
 * 取 1em 会把 10pt 槽两侧的左右栏项并成一个「通栏 run」，整页退回单栏（即逐行交错的根源）。
 */
const RUN_GAP_EM = 0.5
/** 窄行太少（绝对数 / 占比）就不做双栏判定：单栏页几乎每行都是通栏 run → 直接否决 */
const MIN_NARROW_ROWS = 6
const MIN_NARROW_SHARE = 0.5
/** 允许跨过槽位的窄行占比（上标、图内标签之类的零星跨槽项） */
const CROSS_TOLERANCE = 0.1

interface Gutter {
  split: number
  width: number
}

/** 行内按 x 排序、间距 ≤ max(2, h × RUN_GAP_EM) 的项合并成连续 run */
function rowRuns(row: PdfTextItem[]): { x0: number; x1: number }[] {
  const sorted = [...row].sort((a, b) => xOf(a) - xOf(b))
  const runs: { x0: number; x1: number }[] = []
  for (const it of sorted) {
    const x0 = xOf(it)
    const x1 = rightOf(it)
    const last = runs[runs.length - 1]
    if (last && x0 - last.x1 <= Math.max(2, (it.height || 10) * RUN_GAP_EM)) {
      last.x1 = Math.max(last.x1, x1)
    } else {
      runs.push({ x0, x1 })
    }
  }
  return runs
}

/**
 * 按 run 而不是行跨度判「宽」：双栏页的「行」是 y 聚类，天然含左右两栏的项——
 * 二栏行 = 两个 ≈ 0.47 宽的 run（窄），通栏框行 = 一个 ≈ 0.85 宽的 run（宽）。
 */
const isWideRow = (row: PdfTextItem[], width: number) =>
  rowRuns(row).some((r) => r.x1 - r.x0 > width * WIDE_RUN_RATIO)

/**
 * 双栏检测：把版心横向分箱统计文本覆盖，在中部找一条足够宽的空白竖槽。
 *
 * 为什么按「覆盖直方图」而不是「有没有文本项跨过某条竖线」：pdf.js 的文本项是词级碎片，
 * 任意一条竖线几乎总能落进某个词间空隙，逐项判定会把单栏页也误判成双栏。
 * 直方图**只统计窄行**：一页里的通栏框 / 通栏标题 / 图注再多也抹不平分栏槽
 * （修复前跨槽行只容忍 15%，一个多行通栏框就让整页退回单栏，左右栏同 y 的项被拼成一行）。
 */
function detectGutter(rows: PdfTextItem[][]): Gutter | null {
  const items = rows.flat()
  if (items.length < 12 || rows.length < 4) return null
  const left = Math.min(...items.map(xOf))
  const right = Math.max(...items.map(rightOf))
  const width = right - left
  if (width <= 0) return null

  const narrow = rows.filter((row) => !isWideRow(row, width))
  if (narrow.length < MIN_NARROW_ROWS || narrow.length < rows.length * MIN_NARROW_SHARE) return null

  // 逐**行**统计覆盖（而不是逐项）：一行只贡献 1 次覆盖
  const binWidth = width / GUTTER_BINS
  const counts = new Uint16Array(GUTTER_BINS)
  const rowBins = new Uint8Array(GUTTER_BINS)
  for (const row of narrow) {
    rowBins.fill(0)
    for (const it of row) {
      const from = Math.max(0, Math.floor((xOf(it) - left) / binWidth))
      const to = Math.min(GUTTER_BINS - 1, Math.ceil((rightOf(it) - left) / binWidth) - 1)
      for (let b = from; b <= to; b++) rowBins[b] = 1
    }
    for (let b = 0; b < GUTTER_BINS; b++) if (rowBins[b]) counts[b]++
  }
  const tolerance = Math.max(1, Math.floor(narrow.length * CROSS_TOLERANCE))

  const lo = Math.floor(GUTTER_BINS * GUTTER_SEARCH_LO)
  const hi = Math.ceil(GUTTER_BINS * GUTTER_SEARCH_HI)
  let best = { from: -1, len: 0 }
  let runFrom = -1
  for (let b = lo; b <= hi; b++) {
    if (counts[b] <= tolerance) {
      if (runFrom < 0) runFrom = b
      const len = b - runFrom + 1
      if (len > best.len) best = { from: runFrom, len }
    } else {
      runFrom = -1
    }
  }
  const minGutter = Math.max(width * MIN_GUTTER_RATIO, median(items.map((it) => it.height || 0)) * MIN_GUTTER_EM)
  if (best.len * binWidth < minGutter) return null

  const split = left + (best.from + best.len / 2) * binWidth
  // 两侧都要有足够文本，否则只是居中排版或宽公式留白
  const leftCount = items.filter((it) => rightOf(it) <= split).length
  const rightCount = items.filter((it) => xOf(it) >= split).length
  const minShare = items.length * 0.2
  if (leftCount < minShare || rightCount < minShare) return null
  return { split, width: best.len * binWidth }
}

/** 文档级分栏槽：≥ 2 页各自检出时取中位数，供检不出的页回退 */
function consensusGutter(found: (Gutter | null)[]): Gutter | null {
  const hits = found.filter((g): g is Gutter => g !== null)
  if (hits.length < 2) return null
  return { split: median(hits.map((g) => g.split)), width: median(hits.map((g) => g.width)) }
}

/** 跨槽行占比上限：超过即这页更像单栏（通栏表格 / 单栏摘要页），不沿用文档槽 */
const DOC_GUTTER_MAX_CROSSING = 0.5

/**
 * 某页自己检不出分栏槽（行太少 / 通栏元素太多）时，能否沿用文档槽：
 * 行数 ≥ 2、跨槽行 ≤ 50%、两侧项各 ≥ 20%。解决「只剩 3 行二栏正文 + 一条通栏图注」的页。
 */
function acceptDocGutter(rows: PdfTextItem[][], g: Gutter): boolean {
  if (rows.length < 2) return false
  const items = rows.flat()
  if (!items.length) return false
  const half = g.width / 2
  let crossing = 0
  for (const row of rows) {
    if (row.some((it) => xOf(it) < g.split - half && rightOf(it) > g.split + half)) crossing++
  }
  if (crossing > rows.length * DOC_GUTTER_MAX_CROSSING) return false
  const leftCount = items.filter((it) => rightOf(it) <= g.split).length
  const rightCount = items.filter((it) => xOf(it) >= g.split).length
  const minShare = items.length * 0.2
  return leftCount >= minShare && rightCount >= minShare
}

/**
 * 双栏页的阅读序：通栏行把页面切成若干「带」，每条带内先读完左栏再读右栏。
 * 典型论文首页 = 通栏标题/摘要 → 左栏 → 右栏，正好由此还原。
 */
function orderColumns(lines: Line[]): Line[] {
  const byY = (a: Line, b: Line) => b.y - a.y
  const spans = lines.filter((l) => l.col === 'span').sort(byY)
  let rest = lines.filter((l) => l.col !== 'span').sort(byY)
  const out: Line[] = []

  for (const s of spans) {
    const above = rest.filter((l) => l.y > s.y)
    out.push(...above.filter((l) => l.col === 'left'), ...above.filter((l) => l.col === 'right'))
    out.push(s)
    rest = rest.filter((l) => l.y <= s.y)
  }
  out.push(...rest.filter((l) => l.col === 'left'), ...rest.filter((l) => l.col === 'right'))
  return out
}

/**
 * 行组 → 有序行。单栏页与 Phase 1 行为完全一致；双栏页把「同一 y 上左右栏被拼在一起」的行
 * 按分栏槽拆开，最后按栏重排阅读序。
 */
function rowsToLines(page: number, rows: PdfTextItem[][], gutter: Gutter | null): Line[] {
  if (!rows.length) return []
  if (!gutter) {
    return rows.map((g) => toLine(page, g, 'full')).filter((l): l is Line => l !== null)
  }

  const lines: Line[] = []
  for (const row of rows) {
    const leftItems = row.filter((it) => rightOf(it) <= gutter.split)
    const rightItems = row.filter((it) => xOf(it) >= gutter.split)
    const crossing = row.length - leftItems.length - rightItems.length

    if (crossing > 0 || !leftItems.length || !rightItems.length) {
      const col: PdfColumn = crossing > 0 ? 'span' : leftItems.length ? 'left' : 'right'
      const line = toLine(page, row, col)
      if (line) lines.push(line)
      continue
    }

    // 两侧都有文本且无跨槽项：只有当中间空隙确实有分栏槽那么宽时才判定为「两栏被拼成一行」，
    // 否则是一条恰好在槽位有词间空隙的通栏行（如居中标题）。
    const gap = Math.min(...rightItems.map(xOf)) - Math.max(...leftItems.map(rightOf))
    if (gap < gutter.width * 0.6) {
      const line = toLine(page, row, 'span')
      if (line) lines.push(line)
      continue
    }
    const l = toLine(page, leftItems, 'left')
    const r = toLine(page, rightItems, 'right')
    if (l) lines.push(l)
    if (r) lines.push(r)
  }

  return orderColumns(lines)
}

// ---------------------------------------------------------------------------
// 页眉页脚
// ---------------------------------------------------------------------------

/** 候选带：页面文本纵向跨度上下各 8%，且自上 / 自下排名 ≤ 3（按 y 去重后的名次，左右栏同 y 同名次） */
const RUNNING_BAND_RATIO = 0.08
const RUNNING_BAND_MAX_RANK = 3
/** 只删不大于正文字号 1.05 倍的候选：首页大字标题即使与页眉同文也保留 */
const MAX_RUNNING_HEIGHT_RATIO = 1.05
/** 按文本形状直接命中的页眉页脚（不依赖跨页重复，单页文档也能删） */
const RUNNING_PATTERNS = [
  /^page\s+\d+\s+of\s+\d+$/i,
  /\bpage\s+\d+\s+of\s+\d+$/i,
  /^\d+\s*\/\s*\d+$/,
  /^第\s*\d+\s*页(\s*共\s*\d+\s*页)?$/,
]
/**
 * 「page N of M」在 LaTeX fancyhdr 里是独立的文本 run，常与页眉标题（或首页脚注的末行）同一行：
 * 候选行若首 / 末项恰是它，只剥掉这一项再做整行判定——首页脚注不会因为尾巴带页码被整行删掉。
 */
const PAGE_OF_ITEM = /^page\s+\d+\s+of\s+\d+$/i
/** 重复页眉页脚的归一键：小写、数字 → #、空白折叠（「page 4 of 14」与「page 5 of 14」同键） */
const runningKey = (t: string) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
/** 同键在 ≥ max(2, min(3, ceil(0.4 × 页数)) 页的候选里出现即视为页眉页脚 */
const repeatThreshold = (pageCount: number) => Math.max(2, Math.min(3, Math.ceil(0.4 * pageCount)))

/** 剥掉首 / 末项的「page N of M」；整行只剩它则返回 null（整行删） */
function stripPageOfItem(line: Line): Line | null {
  if (line.items.length < 2) return line
  const sorted = [...line.items].sort((a, b) => xOf(a) - xOf(b))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  let rest: PdfTextItem[] | null = null
  if (PAGE_OF_ITEM.test(last.str.trim())) rest = sorted.slice(0, -1)
  else if (PAGE_OF_ITEM.test(first.str.trim())) rest = sorted.slice(1)
  if (!rest) return line
  return toLine(line.page, rest, line.col)
}

/**
 * 删除页眉页脚：候选 = 每页上下 8% 带内、名次 ≤ 3 的行；只删字号不超过正文 1.05 倍的候选；
 * 删除条件 = 匹配 RUNNING_PATTERNS，或归一键在足够多页的候选里重复。
 * 修复前只有纯数字页码（PAGE_NUMBER_ONLY）能删，「标题 … page 4 of 14」整行并进了段落。
 */
function dropRunningLines(perPage: Line[][], bodyHeight: number): Line[][] {
  const threshold = repeatThreshold(perPage.length)
  const maxHeight = bodyHeight > 0 ? bodyHeight * MAX_RUNNING_HEIGHT_RATIO : Infinity

  interface Candidate {
    page: number
    index: number
    deletable: boolean
    /** 剥掉「page N of M」项后的行；null = 剥完没剩下东西 */
    stripped: Line | null
  }
  const candidates: Candidate[] = []
  const pagesByKey = new Map<string, Set<number>>()

  perPage.forEach((lines, pi) => {
    if (!lines.length) return
    const ys = lines.map((l) => l.y)
    const yMax = Math.max(...ys)
    const yMin = Math.min(...ys)
    const band = (yMax - yMin) * RUNNING_BAND_RATIO
    // 去重后的 y 名次：同一行拆成左右两条 Line 时共享名次
    const distinct: number[] = []
    for (const y of [...ys].sort((a, b) => b - a)) {
      if (!distinct.length || Math.abs(distinct[distinct.length - 1] - y) > 1) distinct.push(y)
    }
    const rankOf = (y: number) => distinct.findIndex((d) => Math.abs(d - y) <= 1)

    lines.forEach((line, index) => {
      const r = rankOf(line.y)
      const top = line.y >= yMax - band && r < RUNNING_BAND_MAX_RANK
      const bottom = line.y <= yMin + band && distinct.length - r <= RUNNING_BAND_MAX_RANK
      if (!top && !bottom) return
      const deletable = line.height <= maxHeight
      const stripped = deletable ? stripPageOfItem(line) : line
      candidates.push({ page: pi, index, deletable, stripped })
      if (stripped) {
        const key = runningKey(stripped.text)
        if (!pagesByKey.has(key)) pagesByKey.set(key, new Set())
        pagesByKey.get(key)!.add(pi)
      }
    })
  })

  const replace = new Map<Line, Line | null>()
  for (const c of candidates) {
    if (!c.deletable) continue
    const original = perPage[c.page][c.index]
    if (!c.stripped) {
      replace.set(original, null)
      continue
    }
    const text = c.stripped.text.trim()
    const repeated = (pagesByKey.get(runningKey(text))?.size ?? 0) >= threshold
    if (RUNNING_PATTERNS.some((p) => p.test(text)) || repeated) replace.set(original, null)
    else if (c.stripped !== original) replace.set(original, c.stripped)
  }
  if (!replace.size) return perPage
  return perPage.map((lines) =>
    lines.map((l) => (replace.has(l) ? replace.get(l)! : l)).filter((l): l is Line => l !== null),
  )
}

// ---------------------------------------------------------------------------
// 标题 / 段落
// ---------------------------------------------------------------------------

interface HeadingInfo {
  level: number
  text: string
  /** 命中的规则：只有「大字号」标题会与下一行合并成多行标题（编号 / 关键词标题天生一行） */
  rule: 'numbered' | 'keyword' | 'bigger'
}

/** 「大字号」标题：主导字号 ≥ 正文 × 1.15 */
const BIGGER_HEADING_RATIO = 1.15
/** 「大字号」标题单行最长 60 字符（更长的大字行是引言 / 宣传语，不是标题） */
const BIGGER_HEADING_MAX_CHARS = 60

/** 标题识别优先级：编号标题 > 关键词标题 > 短行且字号偏大且无终止标点 */
function detectHeading(line: Line, bodyHeight: number): HeadingInfo | null {
  const t = line.text.trim()
  if (!t) return null

  const numbered = NUMBERED_HEADING.exec(t)
  const bodySized = bodyHeight <= 0 || line.height >= bodyHeight * NUMBERED_HEADING_MIN_HEIGHT_RATIO
  if (
    numbered &&
    bodySized &&
    t.length <= 80 &&
    !ENDS_SENTENCE.test(t) &&
    headingBodyStartsWithWord(numbered[2]) &&
    !MID_SENTENCE_BOUNDARY.test(numbered[2]) &&
    hasHeadingContent(numbered[2])
  ) {
    return { level: Math.min(6, numbered[1].split('.').length), text: t, rule: 'numbered' }
  }

  const key = t.replace(/[:：.。\s]+$/, '').toLowerCase()
  if (HEADING_WORDS.has(key)) return { level: 1, text: t, rule: 'keyword' }

  if (isBiggerLine(line, t, bodyHeight) && !ENDS_SENTENCE.test(t) && !/[,，、]$/.test(t)) {
    return { level: 2, text: t, rule: 'bigger' }
  }
  return null
}

/** 字号明显大于正文、不长、有实词的行（「大字号」标题的几何 + 内容条件，不看行尾标点） */
const isBiggerLine = (line: Line, t: string, bodyHeight: number): boolean =>
  bodyHeight > 0 && line.height >= bodyHeight * BIGGER_HEADING_RATIO && t.length <= BIGGER_HEADING_MAX_CHARS && hasHeadingContent(t)

/**
 * 多行大字标题合并：大字号标题排成两行时（「What if automating AI R&D triggers an」/「intelligence explosion?」）
 * 原先成两个 heading——目录出现两条半句，原版视图就地译文也逐行各译各的。
 * 两行字号相差 ≤ 5%（同一个标题字体），基线间距 ≤ 1.6 × 行高（标题行距通常 1.1–1.25；两个独立标题之间
 * 至少隔一行空白），合并后 ≤ 120 字符（两行大字标题的上限）。
 */
const HEADING_MERGE_HEIGHT_TOL = 0.05
const HEADING_MERGE_MAX_GAP = 1.6
const HEADING_MERGE_MAX_CHARS = 120

/**
 * `line` 是否是上一条「大字号」标题 `prev` 的续行：
 * - prev 是大字号规则命中的标题（编号 / 关键词标题不合并），且没有以句末标点收尾；
 * - 本行是大字号标题，或「除了行尾标点外都像大字号标题」——标题的最后一行常以 `?` / `.` 结尾
 *   （本行若被编号 / 关键词规则命中则不算续行）；
 * - 同页同栏、在 prev 末行之下，字号相差 ≤ 5%，基线间距 ≤ HEADING_MERGE_MAX_GAP × 行高，合并后不超长。
 */
function continuesHeading(prev: Draft | undefined, line: Line, heading: HeadingInfo | null, bodyHeight: number): boolean {
  if (!prev || prev.kind !== 'heading' || prev.headingRule !== 'bigger') return false
  const t = line.text.trim()
  if (heading ? heading.rule !== 'bigger' : !isBiggerLine(line, t, bodyHeight)) return false
  const last = lastLineOf(prev)
  if (last.page !== line.page || last.col !== line.col || !(last.y > line.y)) return false
  const h = Math.max(last.height, line.height)
  if (Math.abs(last.height - line.height) > h * HEADING_MERGE_HEIGHT_TOL) return false
  if (last.y - line.y > h * HEADING_MERGE_MAX_GAP) return false
  if (ENDS_SENTENCE.test(prev.text.trim())) return false
  return joinHeadingLines(prev.text, t).length <= HEADING_MERGE_MAX_CHARS
}

/** 标题拼行：中文不补空格；行尾连字符照留（标题里的连字符多是复合词，不是断词） */
const joinHeadingLines = (acc: string, next: string): string =>
  isCjkAt(acc, acc.length - 1) || isCjkAt(next, 0) || acc.endsWith('-') ? acc + next : `${acc} ${next}`

/** 段落内拼行：英文连字符换行还原，中文不补空格 */
function appendLine(acc: string, next: string): string {
  if (!acc) return next
  if (/[A-Za-z]-$/.test(acc)) return acc.slice(0, -1) + next
  if (isCjkAt(acc, acc.length - 1) || isCjkAt(next, 0)) return acc + next
  return acc + ' ' + next
}

/**
 * 字号断段阈值：相差超过较大者的 8% 即视为不同字号。
 * LaTeX 10pt 正文的 `\small` 图注 9pt 差 10%、`\footnotesize` 脚注 8pt 差 20%；
 * 同字体同字号在 pdf.js 里稳定到 0.01，8% 不会被噪声触发。
 */
const HEIGHT_BREAK_RATIO = 0.08
const heightDiffers = (a: number, b: number) => a > 0 && b > 0 && Math.abs(a - b) > Math.max(a, b) * HEIGHT_BREAK_RATIO

/** 段落左边界容差：max(3pt, 正文字号一半)；LaTeX 首行缩进 ≈ 1.5em，悬挂缩进 ≈ 1em，都远大于它 */
const INDENT_TOL_MIN = 3
const INDENT_TOL_EM = 0.5

interface Draft {
  kind: 'heading' | 'paragraph'
  level?: number
  /** heading 命中的规则（多行大字标题合并只认 'bigger'） */
  headingRule?: HeadingInfo['rule']
  text: string
  page: number
  section: string
  lines: Line[]
  /** 当前页 / 栏段里段落确立的左边界：由第 2 行确立（首行缩进不作数），换页 / 换栏重置 */
  edge?: { page: number; col: PdfColumn; x0: number; count: number }
}

function newDraft(line: Line, section: string): Draft {
  return {
    kind: 'paragraph',
    text: line.text,
    page: line.page,
    section,
    lines: [line],
    edge: { page: line.page, col: line.col, x0: line.x0, count: 1 },
  }
}

function appendToDraft(d: Draft, line: Line): void {
  d.text = appendLine(d.text, line.text)
  d.lines.push(line)
  const e = d.edge
  if (!e || e.page !== line.page || e.col !== line.col) {
    d.edge = { page: line.page, col: line.col, x0: line.x0, count: 1 }
  } else {
    e.count++
    if (e.count === 2) e.x0 = line.x0
  }
}

/** 同页同栏、边界已由 ≥ 2 行确立时，左边界跳变超过容差 → 新段落（首行缩进 / 悬挂缩进列表项） */
function indentBreak(d: Draft, line: Line, tol: number): boolean {
  const e = d.edge
  if (!e || e.page !== line.page || e.col !== line.col || e.count < 2) return false
  return Math.abs(line.x0 - e.x0) > tol
}

const lastLineOf = (d: Draft): Line => d.lines[d.lines.length - 1]

/**
 * 通栏段落的短尾行：图注 / 通栏摘要的末行只占左半版（「feedback loop.」），rowsToLines 把它判成 'left'，
 * 块的 layout 就多出一个单行 left seg——对照视图里这段的译文被塞进左栏、宽度只按这一短行算，成了又高又窄的一条。
 * 判据：本页阅读序的上一行就是本段末行且是通栏行（span / full）；本行是 left、在它下方、左边界与它对齐（±tol）；
 * 段落尚未收句（已收句的通栏图注之后是左栏新段，照旧走跨栏断段）。命中则返回上一行的 col，本行按它判断与并入：
 * 既不触发跨栏断段，也不新开 seg。只认「宽 → 左对齐短尾」这一个方向，left / right → span 从不改写。
 */
function wideTailCol(d: Draft, prev: Line | null, line: Line, tol: number): PdfColumn | null {
  // prev = 本页阅读序上一行（原行）且必须就是本段末行：短尾之后的下一行看到的是 left 原行，不会接力改写
  if (!prev || lastLineOf(d) !== prev) return null
  if (line.col !== 'left' || (prev.col !== 'span' && prev.col !== 'full')) return null
  if (prev.page !== line.page || !(prev.y > line.y)) return null
  if (Math.abs(line.x0 - prev.x0) > tol) return null
  if (ENDS_SENTENCE.test(d.text.trim())) return null
  return prev.col
}

/** 1 位小数；`+ 0` 把 -0 归一成 0（JSON 与 toEqual 都不想看到 -0） */
const r1 = (n: number) => Math.round(n * 10) / 10 + 0

/** 块的行框：连续同 (page, col) 的行归为一个 seg，阅读序自上而下 */
function toLayout(lines: Line[]): PdfBlockLayout {
  const segs: PdfLayoutSeg[] = []
  for (const l of lines) {
    const box: PdfLineBox = [r1(l.x0), r1(l.yTop), r1(l.x1), r1(l.yTop - l.yBottom)]
    const last = segs[segs.length - 1]
    if (last && last.page === l.page && last.col === l.col) last.lines.push(box)
    else segs.push({ page: l.page, col: l.col, lines: [box] })
  }
  return { segs }
}

/**
 * 把 PDF 各页文字项规范化为有序块。步骤：
 * 行聚类（剔除旋转项）→ 分栏（窄行直方图 + 文档级回退）→ 行内按 x 排序拼接 → 丢弃纯页码行与页眉页脚
 * → 标题识别 → 段落合并（含跨页 / 跨栏合并；字号变化与缩进跳变断段）→ 附带每块的行框几何。
 */
export function normalizePdf(pages: PdfPageText[]): NormalizedBlock[] {
  const pageRows = pages.map(prepareRows)
  const found = pageRows.map(detectGutter)
  const doc = consensusGutter(found)
  let perPage = pageRows.map((rows, i) =>
    rowsToLines(pages[i].page, rows, found[i] ?? (doc && acceptDocGutter(rows, doc) ? doc : null)).filter(
      (l) => !PAGE_NUMBER_ONLY.test(l.text.trim()),
    ),
  )
  if (!perPage.some((lines) => lines.length)) return []

  const bodyHeight = median(perPage.flat().map((l) => l.height).filter((h) => h > 0))
  perPage = dropRunningLines(perPage, bodyHeight)
  const allLines = perPage.flat()
  if (!allLines.length) return []

  // 行间距中位数用于判定「空行断段」：同页同栏相邻行的 y 差值
  // （跨栏相邻行的 y 差是「栏底 → 栏顶」的跳变，混进来会把中位数抬高）
  const gaps: number[] = []
  for (const lines of perPage) {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].col !== lines[i - 1].col) continue
      gaps.push(Math.abs(lines[i - 1].y - lines[i].y))
    }
  }
  const bodyGap = median(gaps.filter((g) => g > 0))
  // 「满行宽」按栏统计：双栏正文只有半页宽，用全页最大宽度会把每一行都判成短行
  const maxWidthByCol = new Map<PdfColumn, number>()
  for (const l of allLines) {
    const w = l.x1 - l.x0
    if (w > (maxWidthByCol.get(l.col) ?? 0)) maxWidthByCol.set(l.col, w)
  }
  const indentTol = Math.max(INDENT_TOL_MIN, bodyHeight * INDENT_TOL_EM)

  const drafts: Draft[] = []
  let section = ''
  // open = 当前尚未收尾的段落草稿；跨页时它会存活到下一页，从而实现跨页段落合并
  let open: Draft | null = null

  for (let pi = 0; pi < perPage.length; pi++) {
    const lines = perPage[pi]
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]
      const heading = detectHeading(line, bodyHeight)

      // 多行大字标题：上一条草稿就是那条标题（中间没有段落）时，续行并进去，目录 / 章节名用整条标题
      const prevDraft = open && open.text.trim() ? undefined : drafts[drafts.length - 1]
      if (prevDraft && continuesHeading(prevDraft, line, heading, bodyHeight)) {
        prevDraft.text = joinHeadingLines(prevDraft.text, line.text.trim())
        prevDraft.lines.push(line)
        prevDraft.section = prevDraft.text
        section = prevDraft.text
        open = null
        continue
      }

      if (heading) {
        if (open && open.text.trim()) drafts.push(open)
        open = null
        section = heading.text
        drafts.push({
          kind: 'heading',
          level: heading.level,
          headingRule: heading.rule,
          text: heading.text,
          page: line.page,
          section,
          lines: [line],
        })
        continue
      }

      const prevOpen = open
      if (!prevOpen) {
        open = newDraft(line, section)
        continue
      }

      // 断段判据：同栏大行距 / 字号变化 / 左边界跳变 → 断；跨页（li === 0）或换栏则看上一行是否已收句
      // 或字号是否变化（栏底 8pt 脚注不再吞下一栏首行），未收句就并入同段，anchor 保留段落起始页。
      const prev = li > 0 ? lines[li - 1] : null
      // 通栏段落的左对齐短尾：按上一行的 col 判断与并入（副本；lines 里的原行不动，下一行仍按真实栏位比较）
      const tailCol = wideTailCol(prevOpen, prev, line, indentTol)
      const cur = tailCol ? { ...line, col: tailCol } : line
      let breakHere: boolean
      if (!prev || prev.col !== cur.col) {
        breakHere = ENDS_SENTENCE.test(prevOpen.text.trim()) || heightDiffers(lastLineOf(prevOpen).height, line.height)
      } else {
        const gap = Math.abs(prev.y - line.y)
        breakHere = bodyGap > 0 && gap > bodyGap * 1.6
        // 上一行明显不满行宽且已收句 → 段落自然结束
        const maxWidth = maxWidthByCol.get(prev.col) ?? 0
        if (!breakHere && ENDS_SENTENCE.test(prev.text.trim()) && prev.x1 - prev.x0 < maxWidth * 0.85) {
          breakHere = true
        }
        if (!breakHere && heightDiffers(prev.height, line.height)) breakHere = true
        if (!breakHere && indentBreak(prevOpen, cur, indentTol)) breakHere = true
      }

      if (breakHere) {
        if (prevOpen.text.trim()) drafts.push(prevOpen)
        open = newDraft(line, section)
      } else {
        appendToDraft(prevOpen, cur)
      }
    }
  }
  if (open && open.text.trim()) drafts.push(open)

  return drafts.map((d, index) => {
    const block: NormalizedBlock = {
      index,
      kind: d.kind,
      text: d.text.trim(),
      anchor: { kind: 'pdf', blockIndex: index, page: d.page, section: d.section || undefined },
      layout: toLayout(d.lines),
    }
    if (d.kind === 'heading') block.level = d.level
    return block
  })
}

/**
 * 元数据标题「坏了」的信号：两个以上连续空白，或含控制字符。生成器把标题里的特殊字符写坏时就是这个样子——
 * 主样本的 Info.Title 是「What if automating AI R   D triggers…」（`&` 变成了三个空格，pdf.js getMetadata 实测）。
 */
const BROKEN_META_TITLE = /\s{2,}|[\u0000-\u001f\u007f]/

/**
 * PDF 标题取舍（parsePdf 用；放这里是因为 parsePdf.ts 引了 `?worker&url`，vitest 加载不了）：
 * - 元数据标题干净 → 用它（作者 / 出版方填的标题通常最准）；
 * - 元数据标题坏了（BROKEN_META_TITLE）→ 有首个 heading 就用 heading（正文里的标题是排版出来的真字），
 *   没有 heading 就把元数据标题的空白折叠成单个空格凑合用；
 * - 没有元数据标题 → 首个 heading；都没有 → undefined（调用方回落到文件名）。
 */
export function pickPdfTitle(metaTitle: string | undefined, firstHeading: string | undefined): string | undefined {
  const meta = metaTitle?.trim() || undefined
  const heading = firstHeading?.trim() || undefined
  if (!meta) return heading
  if (!BROKEN_META_TITLE.test(meta)) return meta
  return heading ?? (meta.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim() || undefined)
}

export function countChars(blocks: NormalizedBlock[]): number {
  let n = 0
  for (const b of blocks) n += b.text.length
  return n
}
