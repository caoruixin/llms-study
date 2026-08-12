import { GatewayError } from './modelGateway'
import { LlmError, type ChatMessage } from '../llmClient'
import { assembleContext, type BudgetReport } from './contextBuilder'
import { auditCitations, type CitationAudit } from './citations'
import { memoDirective } from './summarizer'
import { splitCopilotStream, type CopilotSeg } from './streamParser'
import type { EvidenceIsland, MemoIsland } from './blockSchemas'
import type { CiteMapEntry, RetrievedChunk, RetrieveResult } from './retrieval'
import type { StreamPaperChatResult } from './modelGateway'
import type { GatewayUsage } from './usage'
import { COST_CONFIRM_THRESHOLDS, RETRIEVE_TOP_K, type PaperTaskSpec } from '../../data/paperPolicy'
import { estimateCallCost } from './usage'

/**
 * 每轮编排（§6.1 单调用拓扑 + §6.3）：
 * idle → retrieving → streaming → finalizing → done/error 的 reducer +
 * sessionRef 代数 / abortRef 所有权（照搬 SelectionAsk 竞态模式）。
 * 全部 IO 依赖注入，node 环境可测；React 层只消费 onState 快照。
 */

export type TurnPhase = 'idle' | 'retrieving' | 'streaming' | 'finalizing' | 'done' | 'error'

export interface TurnError {
  message: string
  /** LlmError.kind / GatewayError.kind / 'cost-declined' / null */
  kind: string | null
}

const HAS_CJK = /[一-鿿]/

/**
 * 底层 message → 面向用户的明细。
 *
 * 上游已经中文化过一次（llmClient 抛的是「网络错误：Failed to fetch」），UI 再套一层
 * 「网络异常：」就成了双前缀，且把 fetch 的英文原文直接怼给用户。规则：
 * - 纯英文 message → 换成调用方给的中文兜底，原文只进 console.debug；
 * - 「中文前缀：英文原文」→ 只保留中文前缀，英文同样只进 console.debug；
 * - 已经是完整中文文案 → 原样返回（调用方不再叠加前缀）。
 */
export function turnErrorDetail(raw: string | null | undefined, fallback: string): string {
  const s = (raw ?? '').trim()
  if (!s) return fallback
  const debug = () => console.debug('[paper-copilot] 原始错误：', s)
  if (!HAS_CJK.test(s)) {
    debug()
    return fallback
  }
  const split = /^([^：:]*[一-鿿][^：:]*)[：:]\s*([\s\S]+)$/.exec(s)
  if (split && !HAS_CJK.test(split[2])) {
    debug()
    return split[1]
  }
  return s
}

/**
 * 「有问无答」的孤儿轮：页面在流式中途被关掉/刷新时，用户消息已落库而回答没有。
 * 恢复会话时据此标注「已中断」并给一键重发（§QA D-8）。
 * liveTail=true 表示末条用户消息正在生成回答，不算孤儿。
 */
export function findOrphanTurns<T extends { id: string; role: 'user' | 'assistant' }>(
  messages: readonly T[],
  opts: { liveTail?: boolean } = {},
): Set<string> {
  const orphans = new Set<string>()
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const isLast = i === messages.length - 1
    if (isLast && opts.liveTail) continue
    if (isLast || messages[i + 1].role === 'user') orphans.add(m.id)
  }
  return orphans
}

export interface TurnState {
  phase: TurnPhase
  /** 累计正文（流式中实时增长；Stop 后保留半截） */
  text: string
  /** 模型正在思考（reasoning tick 驱动「正在分析」提示） */
  reasoning: boolean
  /** 令牌桶排队等待毫秒（null = 未在排队） */
  waitMs: number | null
  retrying: boolean
  /** evidence 岛触发的扩检索重试（第二次流式）进行中 */
  evidenceRetry: boolean
  citeMap: CiteMapEntry[]
  chunks: RetrievedChunk[]
  audit: CitationAudit | null
  usage: GatewayUsage | null
  /** 最终仍证据不足：UI 显示「证据不足」+ 检索原文 */
  insufficient: boolean
  /** Stop / 中途断流：半截保留并标记「响应中断」 */
  interrupted: boolean
  error: TurnError | null
}

export const initialTurnState: TurnState = {
  phase: 'idle',
  text: '',
  reasoning: false,
  waitMs: null,
  retrying: false,
  evidenceRetry: false,
  citeMap: [],
  chunks: [],
  audit: null,
  usage: null,
  insufficient: false,
  interrupted: false,
  error: null,
}

export type TurnEvent =
  | { type: 'start' }
  | { type: 'retrieved'; citeMap: CiteMapEntry[]; chunks: RetrievedChunk[] }
  | { type: 'delta'; delta: string }
  | { type: 'reasoning' }
  | { type: 'wait'; ms: number }
  | { type: 'retry' }
  | { type: 'stream-end'; aborted: boolean; usage: GatewayUsage | null }
  | { type: 'evidence-retry'; citeMap: CiteMapEntry[]; chunks: RetrievedChunk[] }
  | { type: 'finalized'; audit: CitationAudit | null; insufficient: boolean }
  | { type: 'failed'; error: TurnError }

/** 纯 reducer：状态迁移表即文档（非法迁移原样返回，防御迟到事件） */
export function turnReducer(state: TurnState, ev: TurnEvent): TurnState {
  switch (ev.type) {
    case 'start':
      return { ...initialTurnState, phase: 'retrieving' }
    case 'retrieved':
      if (state.phase !== 'retrieving') return state
      return { ...state, phase: 'streaming', citeMap: ev.citeMap, chunks: ev.chunks }
    case 'delta':
      if (state.phase !== 'streaming') return state
      return { ...state, text: state.text + ev.delta, reasoning: false, waitMs: null, retrying: false }
    case 'reasoning':
      if (state.phase !== 'streaming') return state
      return { ...state, reasoning: true }
    case 'wait':
      if (state.phase !== 'streaming') return state
      return { ...state, waitMs: ev.ms }
    case 'retry':
      if (state.phase !== 'streaming') return state
      return { ...state, retrying: true, text: '' }
    case 'stream-end':
      if (state.phase !== 'streaming') return state
      return {
        ...state,
        phase: 'finalizing',
        reasoning: false,
        waitMs: null,
        usage: ev.usage ?? state.usage,
        interrupted: state.interrupted || ev.aborted,
      }
    case 'evidence-retry':
      if (state.phase !== 'finalizing') return state
      return {
        ...state,
        phase: 'streaming',
        text: '',
        evidenceRetry: true,
        citeMap: ev.citeMap,
        chunks: ev.chunks,
      }
    case 'finalized':
      if (state.phase !== 'finalizing') return state
      return { ...state, phase: 'done', audit: ev.audit, insufficient: ev.insufficient }
    case 'failed':
      return { ...state, phase: 'error', reasoning: false, waitMs: null, error: ev.error }
  }
}

// ---------------------------------------------------------------------------
// Runner：代数 + abort 所有权 + 每轮流程编排
// ---------------------------------------------------------------------------

export interface TurnRequest {
  question: string
  /** 检索查询（默认 = question；速览等入口可自定义） */
  retrievalQuery?: string
  selection?: string | null
  spec: PaperTaskSpec
  /** (b) 选段快捷：无 plan 岛指令；自由问答带 plan 岛指令 */
  planIsland: boolean
  /** 本轮是否要求 memo 尾岛（summarizer.shouldRequestMemo） */
  memoIsland: boolean
  extraDirectives?: readonly string[]
  context: {
    brief?: string | null
    profileHint?: string | null
    rollingSummary?: string | null
    history: readonly ChatMessage[]
    currentSection?: string
    sectionTitles?: readonly string[]
  }
}

export interface TurnOutcome {
  state: TurnState
  report: BudgetReport | null
  segs: CopilotSeg[]
  memo: MemoIsland | null
  /** true 表示本轮被 Stop（半截保留） */
  stopped: boolean
}

export interface TurnRunnerDeps {
  retrieve(
    query: string,
    opts: { topK: number; selection?: string; currentSection?: string; sectionTitles?: readonly string[] },
  ): Promise<RetrieveResult>
  stream(req: {
    spec: PaperTaskSpec
    messages: ChatMessage[]
    signal: AbortSignal
    task: string
    onDelta(d: string): void
    onReasoningTick(): void
    onWait(ms: number): void
    onRetry(): void
  }): Promise<StreamPaperChatResult>
  /** 超过成本阈值时的二次确认；未注入视为放行 */
  confirmCost?(info: { provider: string; estCost: number; threshold: number; inputTokens: number }): Promise<boolean>
}

export interface TurnRunner {
  /** 单飞行守卫：已有进行中的轮次返回 null；被 discard 的轮次也返回 null */
  run(req: TurnRequest, onState: (s: TurnState) => void): Promise<TurnOutcome | null>
  /** Stop：保留半截并标记「响应中断」（不动代数） */
  stop(): void
  /** 关闭面板/切论文：升代数 + 交出所有权后 abort，旧轮次任何迟到写入都被丢弃 */
  discard(): void
  busy(): boolean
}

const friendlyOf = (e: unknown): TurnError => {
  if (e instanceof GatewayError) return { message: e.message, kind: e.kind }
  if (e instanceof LlmError) return { message: e.message, kind: e.kind }
  return { message: e instanceof Error ? e.message : '未知错误', kind: null }
}

const findIsland = <T extends MemoIsland | EvidenceIsland>(segs: readonly CopilotSeg[], kind: T['kind']): T | null => {
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i]
    if (seg.type === 'island' && seg.closed && seg.block?.kind === kind) return seg.block as T
  }
  return null
}

const EVIDENCE_RETRY_DIRECTIVE = '上一次检索片段不足，本次已扩大检索范围。若白名单仍不足以回答，直接输出 evidence 岛并只说明缺少什么，不要编造。'
const PLAN_DIRECTIVE =
  '在正文开始前先输出一个 copilot:plan 岛（≤80 token）：本轮涉及概念、讲解层级与策略、拟使用的展示块。'

export function createTurnRunner(deps: TurnRunnerDeps): TurnRunner {
  let gen = 0
  let abortRef: AbortController | null = null

  async function run(req: TurnRequest, onState: (s: TurnState) => void): Promise<TurnOutcome | null> {
    if (abortRef) return null // 单会话单 in-flight 硬守卫
    const myGen = gen
    const ctrl = new AbortController()
    abortRef = ctrl

    let state = initialTurnState
    const dispatch = (ev: TurnEvent) => {
      state = turnReducer(state, ev)
      if (myGen === gen) onState(state) // 迟到写入丢弃（代数不匹配）
    }

    let report: BudgetReport | null = null
    let stopped = false

    const streamOnce = async (chunks: RetrievedChunk[], extra: readonly string[]): Promise<StreamPaperChatResult> => {
      const directives: string[] = []
      if (req.planIsland) directives.push(PLAN_DIRECTIVE)
      directives.push(...(req.extraDirectives ?? []))
      if (req.memoIsland) directives.push(memoDirective())
      directives.push(...extra)

      const built = assembleContext({
        brief: req.context.brief,
        profileHint: req.context.profileHint,
        rollingSummary: req.context.rollingSummary,
        history: req.context.history,
        selection: req.selection,
        chunks,
        question: req.question,
        directives,
        inputBudgetTokens: req.spec.inputBudgetTokens,
      })
      report = built.report
      if (built.report.overBudget) {
        throw new LlmError('bad-response', '本轮上下文超出预算且无法继续裁剪，请缩短选区或问题后重试')
      }

      // 成本阈值二次确认（§5.4）
      const est = estimateCallCost(req.spec.cap, built.messages, req.spec.maxOutputTokens)
      const threshold = COST_CONFIRM_THRESHOLDS.turn[req.spec.cap.provider]
      if (est.cost > threshold && deps.confirmCost) {
        const ok = await deps.confirmCost({
          provider: req.spec.cap.provider,
          estCost: est.cost,
          threshold,
          inputTokens: est.inputTokens,
        })
        if (!ok) {
          const e = new Error('已取消：本轮预估成本超过确认阈值')
          ;(e as Error & { kind: string }).kind = 'cost-declined'
          throw e
        }
      }

      return deps.stream({
        spec: req.spec,
        messages: built.messages,
        signal: ctrl.signal,
        task: req.planIsland ? 'chat' : 'quick',
        onDelta: (d) => dispatch({ type: 'delta', delta: d }),
        onReasoningTick: () => dispatch({ type: 'reasoning' }),
        onWait: (ms) => dispatch({ type: 'wait', ms }),
        onRetry: () => dispatch({ type: 'retry' }),
      })
    }

    try {
      dispatch({ type: 'start' })
      const topK = req.spec.thinking === 'on-high' ? RETRIEVE_TOP_K.deep : RETRIEVE_TOP_K.normal
      const retrieval = await deps.retrieve(req.retrievalQuery ?? req.question, {
        topK,
        selection: req.selection ?? undefined,
        currentSection: req.context.currentSection,
        sectionTitles: req.context.sectionTitles,
      })
      dispatch({ type: 'retrieved', citeMap: retrieval.citeMapEntries, chunks: retrieval.chunks })

      let result = await streamOnce(retrieval.chunks, [])
      stopped = result.aborted
      dispatch({ type: 'stream-end', aborted: result.aborted, usage: result })

      // finalize：解析 → evidence 岛自报不足 → 扩检索重试一次（§6.1 唯一自动二次调用之一）
      let citeMap = retrieval.citeMapEntries
      let chunks = retrieval.chunks
      let segs = splitCopilotStream(state.text, { open: false })
      const evidence = findIsland<EvidenceIsland>(segs, 'evidence')
      let insufficient = evidence?.status === 'insufficient'

      if (insufficient && !result.aborted) {
        const wider = await deps.retrieve(req.retrievalQuery ?? req.question, {
          topK: RETRIEVE_TOP_K.deep,
          selection: req.selection ?? undefined,
          currentSection: req.context.currentSection,
          sectionTitles: req.context.sectionTitles,
        })
        dispatch({ type: 'evidence-retry', citeMap: wider.citeMapEntries, chunks: wider.chunks })
        citeMap = wider.citeMapEntries
        chunks = wider.chunks
        result = await streamOnce(chunks, [EVIDENCE_RETRY_DIRECTIVE])
        stopped = stopped || result.aborted
        dispatch({ type: 'stream-end', aborted: result.aborted, usage: result })
        segs = splitCopilotStream(state.text, { open: false })
        insufficient = findIsland<EvidenceIsland>(segs, 'evidence')?.status === 'insufficient'
      }

      const chunkTextByAlias: Record<string, string> = {}
      for (const c of chunks) chunkTextByAlias[c.alias] = c.chunk.text
      const audit = auditCitations(segs, citeMap, chunkTextByAlias)
      dispatch({ type: 'finalized', audit, insufficient })

      if (myGen !== gen) return null // 已被 discard：结果不落任何持久化
      return {
        state,
        report,
        segs,
        memo: findIsland<MemoIsland>(segs, 'memo'),
        stopped,
      }
    } catch (e) {
      const kind = (e as { kind?: string }).kind
      dispatch({
        type: 'failed',
        error: kind === 'cost-declined' ? { message: (e as Error).message, kind: 'cost-declined' } : friendlyOf(e),
      })
      if (myGen !== gen) return null
      return { state, report, segs: splitCopilotStream(state.text, { open: false }), memo: null, stopped }
    } finally {
      if (abortRef === ctrl) abortRef = null // 所有权匹配才交还（SelectionAsk 模式）
    }
  }

  return {
    run,
    stop() {
      abortRef?.abort() // 不动代数：gateway 正常返回半截，状态机走 stream-end(aborted)
    },
    discard() {
      gen++
      const old = abortRef
      abortRef = null
      old?.abort()
    },
    busy: () => abortRef !== null,
  }
}
