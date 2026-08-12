import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildKimiStructuredSpec,
  COST_CONFIRM_THRESHOLDS,
  DEEPSEEK_V4_PRO,
  PAPER_TASKS,
  type PaperProviderId,
} from '../../data/paperPolicy'
import {
  BriefAbortError,
  briefCacheKey,
  briefContextText,
  estimateBriefCost,
  runBriefPipeline,
  sectionizeUnits,
  UNIT_DIGEST_JSON_SCHEMA,
  BRIEF_JSON_SCHEMA,
} from '../../lib/paper/briefPipeline'
import { createModelGateway } from '../../lib/paper/modelGateway'
import { createCopilotRepository } from '../../lib/paper/repo/copilotRepo'
import { getPaperDb } from '../../lib/paper/repo/db'
import { createTurnRunner, type TurnError, type TurnState } from '../../lib/paper/turnEngine'
import { KEEP_PAIRS_AFTER_FOLD, MAX_LIVE_TURN_PAIRS, foldMemo, shouldRequestMemo, trimHistoryPairs } from '../../lib/paper/summarizer'
import { formatTokens, formatUsd } from '../../lib/paper/usage'
import type { RetrievalService } from '../../lib/paper/retrieval'
import type { ScrollTarget } from '../../lib/paper/anchors'
import type { CopilotMessage as StoredMessage, PaperBlock, PaperRecord, SourceAnchor, StoredCiteEntry } from '../../lib/paper/types'
import { usePaperUi, type PaperAskAction, type PendingAsk } from '../../pages/papers/paperUiStore'
import type { ChatMessage } from '../../lib/llmClient'
import CopilotMessageView from './CopilotMessage'
import ConsentDialog from './ConsentDialog'
import CostConfirm, { type CostConfirmInfo } from './CostConfirm'

/**
 * Paper Copilot 面板（Phase 3 真实现）：会话消息、流式轮次、pendingAsks 消费、
 * 引导模式入口（本阶段仅「论文速览」）、论文地图管线、授权与成本确认、usage 显示。
 * 竞态模型：turnEngine 的代数/所有权 runner + 面板侧 rAF 批量刷新。
 */

interface Props {
  paper: PaperRecord
  blocks: PaperBlock[]
  retrieval: RetrievalService
  position: { blockIndex: number; page?: number; section?: string }
  sectionTitles: readonly string[]
  asks: PendingAsk[]
  onRemoveAsk: (id: string) => void
  onClearAsks: () => void
  onJumpAnchor: (anchor: SourceAnchor) => ScrollTarget
  onClose: () => void
  onToggleSensitive: (sensitive: boolean) => void
}

interface SendParams {
  question: string
  retrievalQuery?: string
  selection?: string | null
  task: 'chat' | 'deep'
  planIsland: boolean
  label?: string
  /** 落库与展示用的用户消息文本（含引用的选区） */
  displayText: string
}

type GateRequest =
  | { kind: 'consent'; provider: PaperProviderId; resolve: (ok: boolean) => void }
  | { kind: 'cost'; info: CostConfirmInfo; resolve: (ok: boolean) => void }

const ASK_TEMPLATES: Record<Exclude<PaperAskAction, 'queue'>, { question: string; task: 'chat' | 'deep' }> = {
  explain: { question: '请解释我选中的这段论文内容。', task: 'chat' },
  simpler: {
    question: '请用更简单的方式解释我选中的这段内容：假设我是入门读者，先给直觉和类比，再给必要术语。',
    task: 'chat',
  },
  derive: { question: '请逐步推导/拆解我选中的这段中的公式或方法：给出每一步的依据与每个符号的含义。', task: 'deep' },
  example: { question: '请举一个具体的例子帮助理解我选中的这段内容。', task: 'chat' },
}

const GUIDED_MODES = [
  { id: 'overview', label: '论文速览', enabled: true },
  { id: 'section', label: '逐节精读', enabled: false },
  { id: 'method', label: '方法拆解', enabled: false },
  { id: 'derive', label: '公式推导', enabled: false },
  { id: 'experiment', label: '实验复盘', enabled: false },
  { id: 'review', label: '批判性审阅', enabled: false },
] as const

function friendlyTurnError(err: TurnError): string {
  switch (err.kind) {
    case 'auth':
      return 'API key 无效或未配置：请在 .env.local 配置 DEEPSEEK_API_KEY 后重启 dev'
    case 'rate-limit':
      return '触发上游限流（429），稍候会自动排队，也可稍后手动重试'
    case 'timeout':
      return '请求超时：可以重试；深度推导可能需要更长时间'
    case 'network':
      return `网络异常：${err.message}`
    case 'bad-response':
      return `上游返回异常：${err.message}`
    case 'server':
      return `上游报错：${err.message}`
    default:
      return err.message || '出错了，请重试'
  }
}

export default function CopilotPanel({
  paper,
  blocks,
  retrieval,
  position,
  sectionTitles,
  asks,
  onRemoveAsk,
  onClearAsks,
  onJumpAnchor,
  onClose,
  onToggleSensitive,
}: Props) {
  const repo = useMemo(() => createCopilotRepository(getPaperDb()), [])

  const [session, setSession] = useState<Awaited<ReturnType<typeof repo.getOrCreateSession>> | null>(null)
  const [messages, setMessages] = useState<StoredMessage[]>([])
  const [live, setLive] = useState<TurnState | null>(null)
  const [error, setError] = useState<TurnError | null>(null)
  const [gate, setGate] = useState<GateRequest | null>(null)
  const [input, setInput] = useState('')
  const [attachedAsk, setAttachedAsk] = useState<PendingAsk | null>(null)

  const { briefUi, briefData, briefRequestTick, setBriefUi, setBriefData } = usePaperUi()

  // 渲染期同步 ref（事件回调不重挂）
  const paperRef = useRef(paper)
  paperRef.current = paper
  const positionRef = useRef(position)
  positionRef.current = position
  const sectionTitlesRef = useRef(sectionTitles)
  sectionTitlesRef.current = sectionTitles
  const sessionRefState = useRef(session)
  sessionRefState.current = session
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const lastParamsRef = useRef<SendParams | null>(null)

  // -----------------------------------------------------------------------
  // 授权 / 成本确认（promise 化对话框）
  // -----------------------------------------------------------------------
  const ensureConsent = useCallback(
    async (provider: PaperProviderId): Promise<boolean> => {
      const existing = await repo.getConsent(provider)
      if (existing?.granted) return true
      return new Promise<boolean>((resolve) => setGate({ kind: 'consent', provider, resolve }))
    },
    [repo],
  )

  const confirmCost = useCallback(
    (info: CostConfirmInfo): Promise<boolean> => new Promise<boolean>((resolve) => setGate({ kind: 'cost', info, resolve })),
    [],
  )

  const decideGate = useCallback(
    async (ok: boolean) => {
      if (!gate) return
      if (gate.kind === 'consent' && ok) await repo.setConsent(gate.provider, true)
      setGate(null)
      gate.resolve(ok)
    },
    [gate, repo],
  )

  // -----------------------------------------------------------------------
  // Gateway 与 turn runner（同一实例：brief 与对话共享令牌桶）
  // -----------------------------------------------------------------------
  const gateway = useMemo(
    () =>
      createModelGateway({
        hasConsent: async (p) => (await repo.getConsent(p))?.granted === true,
        recordUsage: (d) => repo.addUsage(d),
      }),
    [repo],
  )

  const runnerRef = useRef<ReturnType<typeof createTurnRunner> | null>(null)
  const getRunner = useCallback(() => {
    runnerRef.current ??= createTurnRunner({
      retrieve: (query, opts) =>
        retrieval.retrieve(paperRef.current.id, query, {
          topK: opts.topK,
          selection: opts.selection,
          currentSection: opts.currentSection,
          sectionTitles: opts.sectionTitles ? [...opts.sectionTitles] : undefined,
        }),
      stream: (req) =>
        gateway.streamPaperChat({
          spec: req.spec,
          messages: req.messages,
          paperId: paperRef.current.id,
          sensitive: paperRef.current.sensitive,
          signal: req.signal,
          task: req.task,
          onDelta: req.onDelta,
          onReasoningTick: req.onReasoningTick,
          onWait: req.onWait,
          onRetry: req.onRetry,
        }),
      confirmCost: (info) =>
        confirmCost({
          provider: info.provider as PaperProviderId,
          estCost: info.estCost,
          threshold: info.threshold,
          inputTokens: info.inputTokens,
          reason: '本轮上下文较大（检索片段 + 历史 + 选区）',
        }),
    })
    return runnerRef.current
  }, [retrieval, gateway, confirmCost])

  // rAF 批量合并 live 状态（§7.6）
  const liveRef = useRef<TurnState | null>(null)
  const rafRef = useRef(0)
  const pushLive = useCallback((s: TurnState) => {
    liveRef.current = s
    if (rafRef.current !== 0) return
    const schedule =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb: () => void) => setTimeout(cb, 16) as unknown as number
    rafRef.current = schedule(() => {
      rafRef.current = 0
      setLive(liveRef.current)
    }) as number
  }, [])

  // -----------------------------------------------------------------------
  // 会话装载 / 切论文清理
  // -----------------------------------------------------------------------
  useEffect(() => {
    let alive = true
    setSession(null)
    setMessages([])
    setLive(null)
    setError(null)
    setAttachedAsk(null)
    void (async () => {
      const s = await repo.getOrCreateSession(paper.id, paper.title)
      if (!alive) return
      setSession(s)
      const msgs = await repo.listMessages(s.id)
      if (alive) setMessages(msgs)
    })()
    return () => {
      alive = false
      runnerRef.current?.discard() // 切论文/卸载：迟到写入全部丢弃
      runnerRef.current = null
    }
  }, [paper.id, paper.title, repo])

  // -----------------------------------------------------------------------
  // 发起一轮
  // -----------------------------------------------------------------------
  const busy = live !== null && live.phase !== 'done' && live.phase !== 'error'

  const runSendTurn = useCallback(
    async (params: SendParams) => {
      const s = sessionRefState.current
      if (!s || getRunner().busy()) return
      if (paperRef.current.sensitive) {
        setError({ message: '这篇论文已标记为敏感：远程模型调用被禁用，仅可本地阅读与检索', kind: 'sensitive-blocked' })
        return
      }
      setError(null)
      lastParamsRef.current = params
      const ok = await ensureConsent('deepseek')
      if (!ok) {
        setError({ message: '未授权 DeepSeek：陪读对话需要先授权发送论文片段', kind: 'no-consent' })
        return
      }

      // 历史快照（在插入本轮用户消息之前取，SelectionAsk 先例）
      const turnsSinceMemo = s.turnsSinceMemo ?? 0
      const keepPairs = s.rollingSummary
        ? Math.min(MAX_LIVE_TURN_PAIRS, KEEP_PAIRS_AFTER_FOLD + turnsSinceMemo)
        : MAX_LIVE_TURN_PAIRS
      const history: ChatMessage[] = trimHistoryPairs(
        messagesRef.current.map(({ role, content }) => ({ role, content })),
        keepPairs,
      )
      const memoIsland = shouldRequestMemo(turnsSinceMemo)

      const userMsg = await repo.addMessage({
        sessionId: s.id,
        role: 'user',
        content: params.displayText,
        createdAt: Date.now(),
        actionLabel: params.label,
      })
      setMessages((m) => [...m, userMsg])

      const brief = briefData && briefData.paperId === paperRef.current.id ? briefContextText(briefData.data) : null

      const outcome = await getRunner().run(
        {
          question: params.question,
          retrievalQuery: params.retrievalQuery,
          selection: params.selection ?? null,
          spec: PAPER_TASKS[params.task],
          planIsland: params.planIsland,
          memoIsland,
          context: {
            brief,
            profileHint: '讲解层次：进阶（自适应画像 Phase 4 接入，当前固定）',
            rollingSummary: s.rollingSummary ?? null,
            history,
            currentSection: positionRef.current.section,
            sectionTitles: sectionTitlesRef.current,
          },
        },
        pushLive,
      )
      if (!outcome) return // 被 discard / 已有轮次

      const st = outcome.state
      if (st.phase === 'error' && !st.text) {
        setError(st.error)
        setLive(null)
        return
      }

      const assistantMsg = await repo.addMessage({
        sessionId: s.id,
        role: 'assistant',
        content: st.text,
        createdAt: Date.now(),
        citeMap: st.citeMap as StoredCiteEntry[],
        auditBadges: st.audit?.badges,
        interrupted: st.interrupted || st.phase === 'error',
        insufficient: st.insufficient,
        usage: st.usage
          ? {
              provider: st.usage.provider,
              model: st.usage.model,
              inputTokens: st.usage.inputTokens,
              outputTokens: st.usage.outputTokens,
              estimated: st.usage.estimated,
              cost: st.usage.cost,
            }
          : undefined,
      })
      if (st.phase === 'error') {
        setError({ message: `响应中断：${friendlyTurnError(st.error!)}（已保留部分内容）`, kind: st.error!.kind })
      }

      const fold = foldMemo({
        rollingSummary: s.rollingSummary ?? null,
        turnsSinceMemo,
        requested: memoIsland,
        memo: outcome.memo,
      })
      const costTotal = (s.costTotal ?? 0) + (st.usage?.cost ?? 0)
      const patch = {
        rollingSummary: fold.rollingSummary ?? undefined,
        turnsSinceMemo: fold.turnsSinceMemo,
        costTotal,
      }
      await repo.updateSession(s.id, patch)
      setSession((prev) => (prev && prev.id === s.id ? { ...prev, ...patch } : prev))
      setMessages((m) => [...m, assistantMsg])
      setLive(null)
    },
    [briefData, ensureConsent, getRunner, pushLive, repo],
  )

  /** runSendTurn 的兜底外壳：持久化等意外失败不留下无响应的挂起态 */
  const sendTurn = useCallback(
    async (params: SendParams) => {
      try {
        await runSendTurn(params)
      } catch (e) {
        setError({ message: e instanceof Error ? e.message : '本轮处理失败，请重试', kind: null })
        setLive(null)
      }
    },
    [runSendTurn],
  )

  const sendFree = useCallback(
    (text: string) => {
      const sel = attachedAsk?.text ?? null
      setAttachedAsk(null)
      if (attachedAsk) onRemoveAsk(attachedAsk.id)
      void sendTurn({
        question: text,
        selection: sel,
        task: 'chat',
        planIsland: true,
        displayText: sel ? `"""\n${sel.slice(0, 600)}\n"""\n${text}` : text,
      })
    },
    [attachedAsk, onRemoveAsk, sendTurn],
  )

  const consumeAsk = useCallback(
    (ask: PendingAsk) => {
      if (busy) return
      if (ask.action === 'queue') {
        setAttachedAsk(ask)
        return
      }
      const tpl = ASK_TEMPLATES[ask.action]
      onRemoveAsk(ask.id)
      void sendTurn({
        question: tpl.question,
        selection: ask.text,
        task: tpl.task,
        planIsland: false, // (b) 类：意图由按钮完全确定，无 plan 岛，TTFT 最快
        label: ask.label,
        displayText: `【${ask.label}】\n"""\n${ask.text.slice(0, 600)}\n"""`,
      })
    },
    [busy, onRemoveAsk, sendTurn],
  )

  const startOverview = useCallback(() => {
    if (busy) return
    void sendTurn({
      question: '请给出这篇论文的速览：一句话结论、研究问题、方法要点、主要实验结果与局限，最后给出建议的阅读顺序。',
      retrievalQuery: `${paperRef.current.title} 结论 方法 贡献 实验 局限`,
      task: 'chat',
      planIsland: true,
      label: '论文速览',
      displayText: '【论文速览】请带我快速过一遍这篇论文。',
    })
  }, [busy, sendTurn])

  const stopTurn = useCallback(() => runnerRef.current?.stop(), [])

  const retryLast = useCallback(() => {
    const params = lastParamsRef.current
    if (params && !busy) void sendTurn(params)
  }, [busy, sendTurn])

  const clearSession = useCallback(async () => {
    const s = sessionRefState.current
    if (!s || busy) return
    await repo.resetSession(s.id)
    const fresh = await repo.getOrCreateSession(paper.id, paper.title)
    setSession(fresh)
    setMessages([])
    setError(null)
  }, [busy, paper.id, paper.title, repo])

  // -----------------------------------------------------------------------
  // 论文地图管线
  // -----------------------------------------------------------------------
  const units = useMemo(() => sectionizeUnits(blocks), [blocks])
  const briefEstimate = useMemo(() => estimateBriefCost(units, DEEPSEEK_V4_PRO.pricing), [units])
  const briefRunning = briefUi?.status === 'running' && briefUi.paperId === paper.id
  const hasBrief = briefData?.paperId === paper.id
  const briefAbortRef = useRef<AbortController | null>(null)

  const startBrief = useCallback(async () => {
    const p = paperRef.current
    if (briefAbortRef.current || !units.length) return
    if (p.sensitive) {
      setError({ message: '敏感论文：论文地图等远程调用已禁用', kind: 'sensitive-blocked' })
      return
    }
    if (!(await ensureConsent('deepseek'))) return
    if (briefEstimate.cost > COST_CONFIRM_THRESHOLDS.brief.deepseek) {
      const ok = await confirmCost({
        provider: 'deepseek',
        estCost: briefEstimate.cost,
        threshold: COST_CONFIRM_THRESHOLDS.brief.deepseek,
        inputTokens: briefEstimate.inputTokens,
        reason: `论文地图需要 ${briefEstimate.calls} 次调用（${units.length} 个单元 + 1 次综合）`,
      })
      if (!ok) return
    }
    const ctrl = new AbortController()
    briefAbortRef.current = ctrl
    setBriefUi({ paperId: p.id, status: 'running', done: 0, total: units.length + 1 })
    try {
      const digestSpec = PAPER_TASKS.briefDigest
      const result = await runBriefPipeline(
        {
          completeJson: (req) =>
            gateway.completePaperJson({
              spec: req.task === 'brief-synthesis' ? PAPER_TASKS.briefSynthesis : digestSpec,
              messages: req.messages,
              paperId: p.id,
              sensitive: p.sensitive,
              signal: ctrl.signal,
              task: req.task,
              validate: req.validate,
              kimiFallback:
                req.task === 'brief-synthesis'
                  ? buildKimiStructuredSpec('paper_brief', BRIEF_JSON_SCHEMA, PAPER_TASKS.briefSynthesis.maxOutputTokens)
                  : buildKimiStructuredSpec('unit_digest', UNIT_DIGEST_JSON_SCHEMA, digestSpec.maxOutputTokens),
            }),
          loadUnitDigest: (key) => repo.getUnitDigest(p.id, key),
          saveUnitDigest: (key, digest) => repo.saveUnitDigest(p.id, key, digest),
          onProgress: (done, total) => setBriefUi({ paperId: p.id, status: 'running', done, total }),
          signal: ctrl.signal,
        },
        { paperTitle: p.title, fileHash: p.sha256, provider: digestSpec.cap.provider, model: digestSpec.cap.model, units },
      )
      await repo.saveBrief(p.id, briefCacheKey(p.sha256, digestSpec.cap.provider, digestSpec.cap.model), result.data)
      setBriefData({ paperId: p.id, data: result.data })
      setBriefUi({ paperId: p.id, status: 'done', done: units.length + 1, total: units.length + 1 })
    } catch (e) {
      if (e instanceof BriefAbortError) {
        setBriefUi(null) // 中断：进度已缓存，重开续跑
      } else {
        setBriefUi({
          paperId: p.id,
          status: 'error',
          done: 0,
          total: units.length + 1,
          error: e instanceof Error ? e.message : '论文地图生成失败',
        })
      }
    } finally {
      briefAbortRef.current = null
    }
  }, [briefEstimate, confirmCost, ensureConsent, gateway, repo, setBriefData, setBriefUi, units])

  // OutlinePane 的生成入口（store tick）
  const seenTick = useRef(briefRequestTick)
  useEffect(() => {
    if (briefRequestTick !== seenTick.current) {
      seenTick.current = briefRequestTick
      void startBrief()
    }
  }, [briefRequestTick, startBrief])

  // 卸载中断 brief（缓存续跑）
  useEffect(
    () => () => {
      briefAbortRef.current?.abort()
      briefAbortRef.current = null
    },
    [paper.id],
  )

  // -----------------------------------------------------------------------
  // 滚动粘底（AskDialog 48px 阈值先例）
  // -----------------------------------------------------------------------
  const listRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  useEffect(() => {
    const el = listRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages, live])

  const jumpEntry = useCallback((entry: StoredCiteEntry) => onJumpAnchor(entry.anchor), [onJumpAnchor])

  const submit = useCallback(() => {
    const value = input.trim()
    if (!value || busy) return
    setInput('')
    stickRef.current = true
    sendFree(value)
  }, [busy, input, sendFree])

  const sessionCost = session?.costTotal ?? 0
  const lastUsage = live?.usage ?? null
  const paperAsks = asks.filter((a) => a.paperId === paper.id)

  // -----------------------------------------------------------------------
  // 渲染
  // -----------------------------------------------------------------------
  return (
    <div className="flex h-full flex-col" data-paper-selection-ui="">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-semibold text-accent">Paper Copilot</h2>
        <div className="flex items-center gap-2">
          {messages.length > 0 && !busy && (
            <button type="button" onClick={() => void clearSession()} className="text-xs text-dim transition-colors hover:text-fg">
              清空重开
            </button>
          )}
          <button type="button" onClick={onClose} className="text-sm text-dim transition-colors hover:text-fg">
            收起
          </button>
        </div>
      </div>

      <p className="mb-2 text-[0.7rem] text-dim">
        {sessionCost > 0 && <>会话累计 {formatUsd(sessionCost)} · </>}
        deepseek-v4-pro
        {paper.sensitive ? ' · 敏感模式（远程调用已禁用）' : ''}
        <button
          type="button"
          onClick={() => onToggleSensitive(!paper.sensitive)}
          className="ml-2 rounded border border-line px-1.5 py-0.5 text-[0.65rem] text-dim transition-colors hover:text-fg"
        >
          {paper.sensitive ? '取消敏感标记' : '标记为敏感'}
        </button>
      </p>

      <div
        ref={listRef}
        onScroll={() => {
          const el = listRef.current
          if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1"
      >
        {/* 论文地图入口（首次展开提示） */}
        {!hasBrief && !briefRunning && (
          <div className="rounded-lg border border-dashed border-line p-3">
            <p className="mb-1 text-xs font-medium text-fg">还没有论文地图</p>
            <p className="mb-2 text-[0.7rem] leading-relaxed text-dim">
              生成后左栏会展示一句话结论、贡献、方法与推荐阅读路径。预计 {briefEstimate.calls} 次调用、约{' '}
              {formatTokens(briefEstimate.inputTokens)} tokens 输入（≈{formatUsd(briefEstimate.cost)}）。
            </p>
            <button
              type="button"
              onClick={() => void startBrief()}
              disabled={paper.sensitive || !units.length}
              className="rounded-lg bg-accent px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
            >
              生成论文地图
            </button>
          </div>
        )}
        {briefRunning && briefUi && (
          <div className="rounded-lg border border-line bg-panel-2 p-3 text-xs text-dim">
            正在生成论文地图：{briefUi.done}/{briefUi.total} 单元完成…（中断或刷新后会从缓存续跑）
          </div>
        )}
        {briefUi?.status === 'error' && briefUi.paperId === paper.id && (
          <div className="rounded-lg border border-bad/40 bg-panel-2 p-3 text-xs">
            <p className="mb-1 text-bad">{briefUi.error}</p>
            <button type="button" onClick={() => void startBrief()} className="text-accent underline underline-offset-2">
              重试（已完成单元不重复调用）
            </button>
          </div>
        )}

        {/* 待提问队列 */}
        {paperAsks.length > 0 && (
          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-xs font-medium text-fg">待提问（{paperAsks.length}）· 点击发起</p>
              <button type="button" onClick={onClearAsks} className="text-xs text-dim transition-colors hover:text-fg">
                清空
              </button>
            </div>
            <ul className="space-y-1.5">
              {paperAsks.map((ask) => (
                <li key={ask.id} className="rounded-lg border border-line bg-panel-2 p-2">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => consumeAsk(ask)}
                      className="rounded border border-accent/40 px-1.5 py-0.5 text-[0.65rem] text-accent transition-colors hover:bg-accent/10 disabled:opacity-40"
                    >
                      {ask.action === 'queue' ? '引用并提问' : ask.label}
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveAsk(ask.id)}
                      className="text-[0.7rem] text-dim transition-colors hover:text-bad"
                    >
                      移除
                    </button>
                  </div>
                  <p className="line-clamp-2 text-[0.7rem] leading-relaxed text-fg">{ask.text}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 引导模式入口 */}
        {messages.length === 0 && !busy && (
          <section>
            <p className="mb-1.5 text-xs font-medium text-fg">引导模式</p>
            <div className="flex flex-wrap gap-1.5">
              {GUIDED_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  disabled={!m.enabled || busy}
                  title={m.enabled ? undefined : 'Phase 4 开放'}
                  onClick={m.id === 'overview' ? startOverview : undefined}
                  className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                    m.enabled
                      ? 'border-accent/40 text-accent hover:bg-accent/10'
                      : 'cursor-not-allowed border-line text-dim opacity-60'
                  }`}
                >
                  {m.label}
                  {!m.enabled && <span className="ml-1 text-[0.6rem]">P4</span>}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* 历史消息 */}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[92%] rounded-lg bg-accent/15 px-3 py-2 text-xs break-words whitespace-pre-wrap text-fg">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={m.id}>
              <CopilotMessageView
                content={m.content}
                done
                citeMap={m.citeMap ?? []}
                badges={m.auditBadges ?? null}
                interrupted={m.interrupted}
                insufficient={m.insufficient}
                onJumpCite={jumpEntry}
              />
              {m.usage && (
                <p className="mt-0.5 text-[0.65rem] text-dim">
                  {formatTokens(m.usage.inputTokens)} in / {formatTokens(m.usage.outputTokens)} out ·{' '}
                  {formatUsd(m.usage.cost)}
                  {m.usage.estimated ? '（估算）' : ''}
                </p>
              )}
            </div>
          ),
        )}

        {/* 进行中的轮次 */}
        {live && live.phase !== 'done' && live.phase !== 'error' && (
          <div>
            {live.phase === 'retrieving' && <p className="animate-pulse text-xs text-dim">检索原文片段…</p>}
            {live.phase !== 'retrieving' && live.text === '' && (
              <p className="animate-pulse text-xs text-dim">
                {live.waitMs !== null
                  ? `请求排队中（约 ${Math.ceil(live.waitMs / 1000)}s）…`
                  : live.retrying
                    ? '正在自动重试…'
                    : live.reasoning
                      ? '正在深入分析…'
                      : live.evidenceRetry
                        ? '证据不足，扩大检索后重试…'
                        : '等待回答…'}
              </p>
            )}
            {live.text !== '' && (
              <CopilotMessageView
                content={live.text}
                done={false}
                citeMap={live.citeMap}
                badges={null}
                onJumpCite={jumpEntry}
              />
            )}
            {lastUsage && (
              <p className="mt-0.5 text-[0.65rem] text-dim">
                本轮 {formatTokens(lastUsage.inputTokens)} in / {formatTokens(lastUsage.outputTokens)} out ·{' '}
                {formatUsd(lastUsage.cost)}
              </p>
            )}
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="mt-2 border-t border-line pt-2">
        {error && (
          <p className="mb-1.5 text-xs text-bad">
            {friendlyTurnError(error)}
            {error.kind !== 'cost-declined' && error.kind !== 'sensitive-blocked' && (
              <button type="button" onClick={retryLast} className="ml-2 text-accent underline underline-offset-2">
                重试
              </button>
            )}
            {error.kind === 'no-consent' && (
              <button
                type="button"
                onClick={() => void ensureConsent('deepseek')}
                className="ml-2 text-accent underline underline-offset-2"
              >
                重新授权
              </button>
            )}
          </p>
        )}
        {attachedAsk && (
          <div className="mb-1.5 flex items-start gap-2 border-l-2 border-accent bg-panel-2 px-2 py-1.5 text-[0.7rem] text-dim">
            <span className="line-clamp-2 min-w-0 flex-1">已引用选区：{attachedAsk.text}</span>
            <button type="button" onClick={() => setAttachedAsk(null)} className="shrink-0 hover:text-bad">
              移除
            </button>
          </div>
        )}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // IME-safe：中文输入法回车不误发；流式中吞掉 Enter
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (!busy) submit()
            }
          }}
          rows={2}
          placeholder="围绕这篇论文提问，Enter 发送 / Shift+Enter 换行"
          className="w-full resize-y rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm leading-relaxed"
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-[0.65rem] text-dim">
            {busy ? (live?.reasoning ? '深度思考中…' : '回答中…') : '回答基于本地检索片段，均带可回跳引用'}
          </span>
          {busy ? (
            <button
              type="button"
              onClick={stopTurn}
              className="rounded-lg border border-line bg-panel px-3 py-1 text-sm font-medium text-bad transition-colors hover:bg-panel-2"
            >
              ■ 停止
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!input.trim() || !session}
              className="rounded-lg bg-accent px-3 py-1 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
            >
              发送
            </button>
          )}
        </div>
      </div>

      {gate?.kind === 'consent' && <ConsentDialog provider={gate.provider} onDecide={(ok) => void decideGate(ok)} />}
      {gate?.kind === 'cost' && <CostConfirm info={gate.info} onDecide={(ok) => void decideGate(ok)} />}
    </div>
  )
}
