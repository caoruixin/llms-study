/**
 * 文本排版版的表格：HTML（已过 sanitizeArticleHtml）→ 行列文本模型（需要 DOM，happy-dom 测）+ 列宽规划（纯函数）。
 * V1 口径：忽略 colspan / rowspan，单元格取 textContent 折叠空白；表头 = thead 里的行，或开头全是 th 的行。
 */

export interface TableModel {
  /** 每行等长（短行补空串） */
  rows: string[][]
  /** 前几行是表头 */
  headerRows: number
  cols: number
}

/** 超过这么多行只保留前 N 行 + 一行 `…` */
export const MAX_TABLE_ROWS = 12
/** 列宽 ∝ clamp(平均内容宽, 40, 200)，归一到内容宽 */
export const COL_MIN = 40
export const COL_MAX = 200
/** > 8 列降到 7 pt；列均宽低于 24 pt 则放弃网格（退回 block.text 段落） */
export const MANY_COLS = 8
export const SMALL_FONT = 7
export const MIN_COL_WIDTH = 24

const collapse = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

/** `dom` 只用作解析宿主（浏览器传 document，测试传 happy-dom 的 document）；没有 table / 没有行 → null */
export function parseTableHtml(html: string, dom: Document): TableModel | null {
  const host = dom.createElement('div')
  host.innerHTML = html
  const table = host.querySelector('table')
  if (!table) return null
  const rows: string[][] = []
  let headerRows = 0
  let seenBody = false
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    // 嵌套表格的行不算本表的行
    if (tr.closest('table') !== table) continue
    const cells = Array.from(tr.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
    if (cells.length === 0) continue
    const texts = cells.map((c) => collapse(c.textContent))
    const thead = tr.closest('thead')
    const inHead = thead !== null && thead.closest('table') === table
    const allTh = cells.every((c) => c.tagName === 'TH')
    if (!seenBody && (inHead || allTh)) headerRows += 1
    else seenBody = true
    rows.push(texts)
  }
  if (rows.length === 0) return null
  const cols = Math.max(...rows.map((r) => r.length))
  if (cols === 0) return null
  for (const r of rows) while (r.length < cols) r.push('')
  return { rows, headerRows, cols }
}

export interface TableColumns {
  widths: number[]
  fontSize: number
}

/**
 * 列宽：每列平均内容宽（measure 各单元格）clamp 到 [40, 200] 后归一到 totalWidth；> 8 列字号降到 7。
 * 列均宽 < 24 pt（放不下 3 个字）→ null，调用方退回 block.text 段落。
 */
export function planTableColumns(
  table: Pick<TableModel, 'rows' | 'cols'>,
  totalWidth: number,
  measure: (text: string, size: number) => number,
  baseSize: number,
): TableColumns | null {
  const { cols, rows } = table
  if (cols === 0 || rows.length === 0) return null
  if (totalWidth / cols < MIN_COL_WIDTH) return null
  const fontSize = cols > MANY_COLS ? SMALL_FONT : baseSize
  const avg: number[] = []
  for (let c = 0; c < cols; c += 1) {
    let sum = 0
    for (const r of rows) sum += measure(r[c] ?? '', fontSize)
    avg.push(Math.min(COL_MAX, Math.max(COL_MIN, sum / rows.length)))
  }
  const total = avg.reduce((a, b) => a + b, 0)
  return { widths: avg.map((w) => (w / total) * totalWidth), fontSize }
}
