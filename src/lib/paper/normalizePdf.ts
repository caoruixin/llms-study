import type { NormalizedBlock } from './types'

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
}

export interface PdfPageText {
  page: number
  items: PdfTextItem[]
}

/** 行所属的版面区域：单栏页恒为 full，双栏页分 left / right，跨栏元素（标题、通栏图表）为 span */
type Column = 'full' | 'left' | 'right' | 'span'

interface Line {
  page: number
  y: number
  x0: number
  x1: number
  height: number
  text: string
  col: Column
}

const xOf = (it: PdfTextItem) => it.transform[4] ?? 0
const yOf = (it: PdfTextItem) => it.transform[5] ?? 0

/** 中日韩字符与全角标点：拼接时两侧只要有一个是 CJK 就不补空格 */
const CJK = /[　-鿿豈-﫿＀-￯]/
const isCjkAt = (s: string, i: number) => (i >= 0 && i < s.length ? CJK.test(s[i]) : false)

/** 句末终止标点：用于判断段落是否已结束（跨页合并与断段都依赖它） */
const ENDS_SENTENCE = /[.。!！?？;；:：]["'”’)）]?$/
/** 纯页码行：常见于页眉页脚，规范化时直接丢弃 */
const PAGE_NUMBER_ONLY = /^\d{1,4}$/
/** 编号标题：1 / 2.3 / 4.1.2 起头；首段数字限制 2 位，避免把 "2020. ..." 误判为标题 */
const NUMBERED_HEADING = /^(\d{1,2}(?:\.\d{1,2})*)[.、]?\s+(\S.*)$/

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

const rightOf = (it: PdfTextItem) => xOf(it) + (it.width || 0)

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

function toLine(page: number, items: PdfTextItem[], col: Column): Line | null {
  const text = joinLineItems(items)
  if (!text) return null
  return {
    page,
    y: Math.max(...items.map(yOf)),
    x0: Math.min(...items.map(xOf)),
    x1: Math.max(...items.map(rightOf)),
    height: Math.max(...items.map((it) => it.height || 0)),
    text,
    col,
  }
}

/** 版心中部允许出现分栏槽的横向区间，以及分栏槽的最小宽度（占版心宽度比例） */
const GUTTER_SEARCH_LO = 0.35
const GUTTER_SEARCH_HI = 0.65
const MIN_GUTTER_RATIO = 0.03
const GUTTER_BINS = 200

/**
 * 双栏检测：把版心横向分箱统计文本覆盖，在中部找一条足够宽的空白竖槽。
 *
 * 为什么按「覆盖直方图」而不是「有没有文本项跨过某条竖线」：pdf.js 的文本项是词级碎片，
 * 任意一条竖线几乎总能落进某个词间空隙，逐项判定会把单栏页也误判成双栏。
 * 分箱后要求空白**连续**达到版心宽度的 3%（A4 上约 18pt，远大于词间距 3pt 左右），
 * 才认定是分栏槽；通栏标题会让中部箱被占满，于是该页自动退回单栏处理。
 */
function detectGutter(rows: PdfTextItem[][]): { split: number; width: number } | null {
  const items = rows.flat()
  if (items.length < 12 || rows.length < 4) return null
  const left = Math.min(...items.map(xOf))
  const right = Math.max(...items.map(rightOf))
  const width = right - left
  if (width <= 0) return null

  // 逐**行**统计覆盖（而不是逐项）：通栏标题只贡献 1 次覆盖，
  // 不会像布尔占用那样让整页的分栏槽被一条标题抹平。
  const binWidth = width / GUTTER_BINS
  const counts = new Uint16Array(GUTTER_BINS)
  const rowBins = new Uint8Array(GUTTER_BINS)
  for (const row of rows) {
    rowBins.fill(0)
    for (const it of row) {
      const from = Math.max(0, Math.floor((xOf(it) - left) / binWidth))
      const to = Math.min(GUTTER_BINS - 1, Math.ceil((rightOf(it) - left) / binWidth) - 1)
      for (let b = from; b <= to; b++) rowBins[b] = 1
    }
    for (let b = 0; b < GUTTER_BINS; b++) if (rowBins[b]) counts[b]++
  }
  // 允许少量通栏行跨过槽位（标题、通栏图表说明）
  const tolerance = Math.max(1, Math.floor(rows.length * 0.15))

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
  if (best.len * binWidth < width * MIN_GUTTER_RATIO) return null

  const split = left + (best.from + best.len / 2) * binWidth
  // 两侧都要有足够文本，否则只是居中排版或宽公式留白
  const leftCount = items.filter((it) => rightOf(it) <= split).length
  const rightCount = items.filter((it) => xOf(it) >= split).length
  const minShare = items.length * 0.2
  if (leftCount < minShare || rightCount < minShare) return null
  return { split, width: best.len * binWidth }
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
 * 页 → 有序行。单栏页与 Phase 1 行为完全一致；双栏页先按 y 聚行，
 * 再把「同一 y 上左右栏被拼在一起」的行按分栏槽拆开，最后按栏重排阅读序。
 */
function pageToLines(page: PdfPageText): Line[] {
  const items = page.items.filter((it) => it.str && it.str.trim().length > 0)
  if (!items.length) return []

  const rows = clusterRows(items)
  const gutter = detectGutter(rows)
  if (!gutter) {
    return rows.map((g) => toLine(page.page, g, 'full')).filter((l): l is Line => l !== null)
  }

  const lines: Line[] = []
  for (const row of rows) {
    const leftItems = row.filter((it) => rightOf(it) <= gutter.split)
    const rightItems = row.filter((it) => xOf(it) >= gutter.split)
    const crossing = row.length - leftItems.length - rightItems.length

    if (crossing > 0 || !leftItems.length || !rightItems.length) {
      const col: Column = crossing > 0 ? 'span' : leftItems.length ? 'left' : 'right'
      const line = toLine(page.page, row, col)
      if (line) lines.push(line)
      continue
    }

    // 两侧都有文本且无跨槽项：只有当中间空隙确实有分栏槽那么宽时才判定为「两栏被拼成一行」，
    // 否则是一条恰好在槽位有词间空隙的通栏行（如居中标题）。
    const gap = Math.min(...rightItems.map(xOf)) - Math.max(...leftItems.map(rightOf))
    if (gap < gutter.width * 0.6) {
      const line = toLine(page.page, row, 'span')
      if (line) lines.push(line)
      continue
    }
    const l = toLine(page.page, leftItems, 'left')
    const r = toLine(page.page, rightItems, 'right')
    if (l) lines.push(l)
    if (r) lines.push(r)
  }

  return orderColumns(lines)
}

interface HeadingInfo {
  level: number
  text: string
}

/** 标题识别优先级：编号标题 > 关键词标题 > 短行且字号偏大且无终止标点 */
function detectHeading(line: Line, bodyHeight: number): HeadingInfo | null {
  const t = line.text.trim()
  if (!t) return null

  const numbered = NUMBERED_HEADING.exec(t)
  if (numbered && t.length <= 80 && !ENDS_SENTENCE.test(t)) {
    return { level: Math.min(6, numbered[1].split('.').length), text: t }
  }

  const key = t.replace(/[:：.。\s]+$/, '').toLowerCase()
  if (HEADING_WORDS.has(key)) return { level: 1, text: t }

  const bigger = bodyHeight > 0 && line.height >= bodyHeight * 1.15
  if (bigger && t.length <= 60 && !ENDS_SENTENCE.test(t) && !/[,，、]$/.test(t)) {
    return { level: 2, text: t }
  }
  return null
}

/** 段落内拼行：英文连字符换行还原，中文不补空格 */
function appendLine(acc: string, next: string): string {
  if (!acc) return next
  if (/[A-Za-z]-$/.test(acc)) return acc.slice(0, -1) + next
  if (isCjkAt(acc, acc.length - 1) || isCjkAt(next, 0)) return acc + next
  return acc + ' ' + next
}

interface Draft {
  kind: 'heading' | 'paragraph'
  level?: number
  text: string
  page: number
  section: string
}

/**
 * 把 PDF 各页文字项规范化为有序块。步骤：
 * 行聚类 → 行内按 x 排序拼接 → 丢弃纯页码行 → 标题识别 → 段落合并（含跨页合并）。
 */
export function normalizePdf(pages: PdfPageText[]): NormalizedBlock[] {
  const perPage = pages.map((p) => pageToLines(p).filter((l) => !PAGE_NUMBER_ONLY.test(l.text.trim())))
  const allLines = perPage.flat()
  if (!allLines.length) return []

  const bodyHeight = median(allLines.map((l) => l.height).filter((h) => h > 0))
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
  const maxWidthByCol = new Map<Column, number>()
  for (const l of allLines) {
    const w = l.x1 - l.x0
    if (w > (maxWidthByCol.get(l.col) ?? 0)) maxWidthByCol.set(l.col, w)
  }

  const drafts: Draft[] = []
  let section = ''
  // open = 当前尚未收尾的段落草稿；跨页时它会存活到下一页，从而实现跨页段落合并
  let open: Draft | null = null

  for (let pi = 0; pi < perPage.length; pi++) {
    const lines = perPage[pi]
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]
      const heading = detectHeading(line, bodyHeight)

      if (heading) {
        if (open && open.text.trim()) drafts.push(open)
        open = null
        section = heading.text
        drafts.push({ kind: 'heading', level: heading.level, text: heading.text, page: line.page, section })
        continue
      }

      const prevOpen = open
      if (!prevOpen) {
        open = { kind: 'paragraph', text: line.text, page: line.page, section }
        continue
      }

      // 断段判据：同栏大行距 → 断；跨页（li === 0）或换栏则看上一行是否已收句，
      // 未收句就并入同段（跨页 / 跨栏续段），anchor 保留段落起始页。
      const prev = li > 0 ? lines[li - 1] : null
      let breakHere: boolean
      if (!prev || prev.col !== line.col) {
        breakHere = ENDS_SENTENCE.test(prevOpen.text.trim())
      } else {
        const gap = Math.abs(prev.y - line.y)
        breakHere = bodyGap > 0 && gap > bodyGap * 1.6
        // 上一行明显不满行宽且已收句 → 段落自然结束
        const maxWidth = maxWidthByCol.get(prev.col) ?? 0
        if (!breakHere && ENDS_SENTENCE.test(prev.text.trim()) && prev.x1 - prev.x0 < maxWidth * 0.85) {
          breakHere = true
        }
      }

      if (breakHere) {
        if (prevOpen.text.trim()) drafts.push(prevOpen)
        open = { kind: 'paragraph', text: line.text, page: line.page, section }
      } else {
        prevOpen.text = appendLine(prevOpen.text, line.text)
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
    }
    if (d.kind === 'heading') block.level = d.level
    return block
  })
}

export function countChars(blocks: NormalizedBlock[]): number {
  let n = 0
  for (const b of blocks) n += b.text.length
  return n
}
