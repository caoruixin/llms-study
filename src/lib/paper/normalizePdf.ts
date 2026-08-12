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

interface Line {
  page: number
  y: number
  x0: number
  x1: number
  height: number
  text: string
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

/** 按 y 值聚类成行（±容差），行序自上而下 */
function pageToLines(page: PdfPageText): Line[] {
  const items = page.items.filter((it) => it.str && it.str.trim().length > 0)
  if (!items.length) return []

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

  const lines: Line[] = []
  for (const g of groups) {
    const text = joinLineItems(g)
    if (!text) continue
    lines.push({
      page: page.page,
      y: Math.max(...g.map(yOf)),
      x0: Math.min(...g.map(xOf)),
      x1: Math.max(...g.map((it) => xOf(it) + (it.width || 0))),
      height: Math.max(...g.map((it) => it.height || 0)),
      text,
    })
  }
  return lines
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
  // 行间距中位数用于判定「空行断段」：同页相邻行的 y 差值
  const gaps: number[] = []
  for (const lines of perPage) {
    for (let i = 1; i < lines.length; i++) gaps.push(Math.abs(lines[i - 1].y - lines[i].y))
  }
  const bodyGap = median(gaps.filter((g) => g > 0))
  const maxWidth = Math.max(...allLines.map((l) => l.x1 - l.x0))

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

      // 断段判据：同页大行距 → 断；跨页（li === 0）则看上页末行是否已收句，
      // 未收句就并入同段（跨页段落合并），anchor 保留段落起始页。
      let breakHere: boolean
      if (li === 0) {
        breakHere = ENDS_SENTENCE.test(prevOpen.text.trim())
      } else {
        const prev = lines[li - 1]
        const gap = Math.abs(prev.y - line.y)
        breakHere = bodyGap > 0 && gap > bodyGap * 1.6
        // 上一行明显不满行宽且已收句 → 段落自然结束
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
