import type { MemoIsland } from './blockSchemas'

/**
 * 滚动摘要（§6.3）：搭车计算，0 额外调用。
 * turnsSinceMemo ≥ 6 时在逐轮指令中要求 copilot:memo 尾岛；
 * 收到 → 替换 rolling summary 并裁旧轮；漏发/坏岛 → 本地降级（丢旧轮 + 一行占位），下轮再试。
 */

export const MEMO_TURN_INTERVAL = 6
/** 上下文保留的最近轮数上限（与 §5.4 第 4 层一致） */
export const MAX_LIVE_TURN_PAIRS = 6
/** memo 生效（或降级）后保留的最近轮数：更早的轮次已被摘要覆盖 */
export const KEEP_PAIRS_AFTER_FOLD = 3

const DEGRADE_PLACEHOLDER = '（注：更早的部分对话未能自动摘要，已省略。）'

export const shouldRequestMemo = (turnsSinceMemo: number): boolean => turnsSinceMemo >= MEMO_TURN_INTERVAL

/** 逐轮指令文案（进 contextBuilder 的 directives） */
export const memoDirective = (): string =>
  '在回答的最末尾追加一个 copilot:memo 岛：{"summary":"…"}，用不超过 150 token 概括此前对话要点（用户关注的概念、已讲清的结论、未决问题）。不要在正文中提及该岛。'

export interface FoldInput {
  rollingSummary: string | null
  turnsSinceMemo: number
  /** 本轮是否发出了 memo 指令 */
  requested: boolean
  /** 流内收到的 memo 岛（坏岛/缺失为 null） */
  memo: MemoIsland | null
}

export interface FoldResult {
  rollingSummary: string | null
  turnsSinceMemo: number
  /** 上下文历史应保留的最近轮数（1 轮 = user+assistant 一对） */
  keepPairs: number
  /** 本地降级发生（memo 缺失/坏），UI 无感，仅测试与诊断可见 */
  degraded: boolean
}

/** 每轮结束后调用：折叠滚动摘要并给出历史裁剪指示（纯函数） */
export function foldMemo(input: FoldInput): FoldResult {
  if (!input.requested) {
    return {
      rollingSummary: input.rollingSummary,
      turnsSinceMemo: input.turnsSinceMemo + 1,
      keepPairs: MAX_LIVE_TURN_PAIRS,
      degraded: false,
    }
  }
  if (input.memo && input.memo.summary.trim()) {
    return {
      rollingSummary: input.memo.summary.trim(),
      turnsSinceMemo: 0,
      keepPairs: KEEP_PAIRS_AFTER_FOLD,
      degraded: false,
    }
  }
  // 降级：丢旧轮 + 占位说明（不重复追加），turnsSinceMemo 继续累计 → 下轮再试
  const base = input.rollingSummary?.trim() ?? ''
  const rollingSummary = base.endsWith(DEGRADE_PLACEHOLDER)
    ? base
    : [base, DEGRADE_PLACEHOLDER].filter(Boolean).join('\n')
  return {
    rollingSummary,
    turnsSinceMemo: input.turnsSinceMemo + 1,
    keepPairs: KEEP_PAIRS_AFTER_FOLD,
    degraded: true,
  }
}

/** 按 keepPairs 裁剪历史消息（最旧在前，成对计） */
export function trimHistoryPairs<T>(history: readonly T[], keepPairs: number): T[] {
  const keepMsgs = keepPairs * 2
  return history.length <= keepMsgs ? [...history] : [...history.slice(history.length - keepMsgs)]
}
