import type { PaperHighlight } from '../types'

/**
 * 划词高亮的纯函数层：区间合并、区间切分与快照校验。
 * 不碰 DOM 也不碰 Dexie——node 环境直接单测；DOM 捕获在 selectionOffsets，
 * 持久化在 highlightRepo，状态编排在 useHighlights。
 */

/** 跨块选区最多拆到 50 块：防止「全选整篇」一次造出上千条记录 */
export const MAX_HIGHLIGHT_BLOCKS = 50

/** uuid（合并会改写区间，确定性拼接键无意义）；fallback 沿 paperUiStore.askId 先例 */
export const newHighlightId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `hl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export interface MergedRange {
  start: number
  end: number
  /** 被新区间吞并的旧行 id（删旧行 + 写合并行，单事务见 highlightRepo.applyMerge） */
  toDelete: string[]
}

/**
 * 新区间吞并所有相交/相邻（端点相接也算）的旧区间——相邻不合并会留下
 * 视觉上连成一片、数据上却各自独立的碎片。
 * 既有行的不变式是「彼此不相交不相邻」（每次写入都经过这里），一趟即可收敛；
 * 仍循环到不动点，容忍历史脏数据触发的连锁吞并。
 */
export function mergeRanges(existing: readonly PaperHighlight[], start: number, end: number): MergedRange {
  let s = start
  let e = end
  const swallowed = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const row of existing) {
      if (swallowed.has(row.id)) continue
      if (row.start > e || row.end < s) continue
      swallowed.add(row.id)
      if (row.start < s) s = row.start
      if (row.end > e) e = row.end
      changed = true
    }
  }
  return { start: s, end: e, toDelete: [...swallowed] }
}

/**
 * 渲染前一致性校验：区间越界或快照与源字符串失配（重解析/译文重生成）的行
 * 不渲染正文 mark——列表仍展示快照并可跳块，不静默丢数据。
 */
export function validRanges(source: string, rows: readonly PaperHighlight[]): PaperHighlight[] {
  return rows.filter(
    (r) => r.start >= 0 && r.end > r.start && r.end <= source.length && source.slice(r.start, r.end) === r.text,
  )
}

export interface HighlightSegment {
  text: string
  /** 有值 = 高亮段（渲染成 <mark data-highlight-id>），缺省 = 普通文本段 */
  id?: string
}

/**
 * 区间切分（照 retrieval.splitHighlight 模式）：纯函数返回段数组，不产出 HTML——
 * 正文是不可信输入，渲染端逐段建 React 节点，杜绝字符串注入。
 * 入参不要求有序；越界区间钳位；重叠区间（不变式下不该出现）后者防御性跳过。
 */
export function splitByRanges(text: string, rows: readonly PaperHighlight[]): HighlightSegment[] {
  const sorted = rows
    .map((r) => ({ id: r.id, start: Math.max(0, r.start), end: Math.min(text.length, r.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start)
  const out: HighlightSegment[] = []
  let at = 0
  for (const r of sorted) {
    if (r.start < at) continue
    if (r.start > at) out.push({ text: text.slice(at, r.start) })
    out.push({ text: text.slice(r.start, r.end), id: r.id })
    at = r.end
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}
