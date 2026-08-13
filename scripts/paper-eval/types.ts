// 评测 harness 内部共享类型。独立于 harness.ts / checks.ts，避免两者互相 import 造成循环依赖
// （run.ts 同时使用两者：harness 产出 TurnResult[]，checks 消费 TurnResult[] 产出 GateResult[]）。

import type { CopilotSeg } from '../../src/lib/paper/streamParser'
import type { CitationAudit } from '../../src/lib/paper/citations'
import type { BudgetReport } from '../../src/lib/paper/contextBuilder'
import type { CiteMapEntry } from '../../src/lib/paper/retrieval'
import type { GatewayUsage } from '../../src/lib/paper/usage'
import type { EvalPaperId, TaskId } from './questions'

export interface RetrieveDebug {
  expandedQuery: string
  chunkIds: string[]
  usedRerank: boolean
  /** 本题若为注入题：金丝雀实际落在哪个 chunkId；null 表示 matchText 未命中任何 chunk（注入失败，需要在报告里标红） */
  injectedChunkId: string | null
  /** 注入命中的 chunk 是否真的进入了本轮白名单（即模型是否有机会看到金丝雀段落） */
  injectedChunkRetrieved: boolean
}

export interface IslandOutcome {
  islandType: string
  ok: boolean
  failure?: string
}

export type TurnErrorKind = 'auth' | 'rate-limit' | 'timeout' | 'network' | 'bad-response' | 'server' | 'other'

export interface TurnError {
  kind: TurnErrorKind
  message: string
}

export interface TurnResult {
  questionId: string
  paperId: EvalPaperId
  taskId: TaskId
  /** --full 每题 3 次重复中的第几次（0-based）；--smoke 恒为 0 */
  runIndex: number
  startedAt: number
  firstDeltaAt: number | null
  endedAt: number
  ttftMs: number | null
  totalMs: number
  aborted: boolean
  retryCount: number
  error: TurnError | null
  rawText: string
  segs: CopilotSeg[]
  citeMapEntries: CiteMapEntry[]
  retrieve: RetrieveDebug
  citeAudit: CitationAudit | null
  islands: IslandOutcome[]
  /** copilot:evidence 岛且 status=insufficient 是否出现（§8.1「证据不足」机器可查状态，非正则匹配 prose）；
   *  取最后一个闭合 evidence 岛（与 turnEngine.findIsland 语义一致），若发生了扩检索重试，反映的是重试后的结果 */
  evidenceInsufficient: boolean
  /** 是否触发了 §6.1/turnEngine「evidence 岛不足 → 扩检索(top-12)同模型重试一次」路径；
   *  触发时本记录的 retrieve/citeMapEntries/segs/rawText/usage 全部是重试后的最终结果（完整替换首次结果，与产品一致） */
  usedEvidenceRetry: boolean
  /** commit 41d0bb3：深度轮（thinking on-high）空流后已降级为 thinking off 重试成功；
   *  两阶段（首轮/evidence 重试）任一命中都算 true，与 turnEngine reducer 的 OR 语义一致 */
  thinkingDowngraded: boolean
  /** 本轮回复原文中检测到的金丝雀 token（可能属于任意论文，用于跨论文泄漏检测） */
  canaryHits: string[]
  budget: BudgetReport | null
  /** 累计 usage（若触发 evidence 重试，为两次调用之和，如实反映本轮实际花费） */
  usage: GatewayUsage | null
}

export interface GateResult {
  id: string
  label: string
  judgment: 'auto' | 'manual' | 'not-covered'
  status: 'pass' | 'fail' | 'manual-pending' | 'not-covered'
  detail: string
}

export interface RunSummary {
  mode: 'smoke' | 'full'
  startedAt: string
  endedAt: string
  totalTurns: number
  turns: TurnResult[]
  gates: GateResult[]
}
