import type { QuizBlockData } from './blockSchemas'
import type { QuizOutcome } from './learnerProfile'

/**
 * quiz 本地判分（§6.1e：0 次 LLM 调用）。
 * 模型只下发声明式数据（选项 + answer 键 + 解析），判定完全在客户端——
 * 与 grading.ts「模型给数据、决策留客户端」一致。简答题不本地判分，由用户自评。
 */

export interface ChoiceGrade {
  outcome: QuizOutcome
  /** 正确答案下标（升序） */
  correct: number[]
  /** 应选未选 */
  missed: number[]
  /** 多选错选 */
  extra: number[]
}

const asAnswerSet = (block: QuizBlockData): number[] =>
  block.answer === null ? [] : Array.isArray(block.answer) ? [...block.answer].sort((a, b) => a - b) : [block.answer]

/**
 * 单选/多选判分：
 * - 单选：命中即 correct，否则 wrong。
 * - 多选：完全一致 correct；有交集但漏选/多选 partial；零交集 wrong。
 */
export function gradeChoice(block: QuizBlockData, selected: readonly number[]): ChoiceGrade {
  const correct = asAnswerSet(block)
  const picked = [...new Set(selected)].filter((i) => i >= 0 && i < block.options.length).sort((a, b) => a - b)
  const missed = correct.filter((i) => !picked.includes(i))
  const extra = picked.filter((i) => !correct.includes(i))
  const hit = picked.filter((i) => correct.includes(i))

  let outcome: QuizOutcome
  if (correct.length > 0 && missed.length === 0 && extra.length === 0) outcome = 'correct'
  else if (hit.length > 0) outcome = block.variant === 'single' ? 'correct' : 'partial'
  else outcome = 'wrong'
  // 单选命中即完全正确（hit>0 且 correct.length===1 时上面第一分支已覆盖），
  // 这里的分支只在模型给了多个 answer 的畸形单选题时生效。
  return { outcome, correct, missed, extra }
}

/**
 * 确定性洗牌（可选特性）：同一岛序号得到同一顺序，重渲不跳动；
 * shuffle=false 时返回自然顺序（默认——解析文案可能引用原始选项顺序）。
 */
export function optionOrder(count: number, seed: number, shuffle: boolean): number[] {
  const order = Array.from({ length: count }, (_, i) => i)
  if (!shuffle || count < 2) return order
  // xorshift32：无依赖、可复现
  let state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0
  const rand = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}
