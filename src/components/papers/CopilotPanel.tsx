import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '../../lib/auth/authStore'
import {
  buildStructuredFallbackSpec,
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
} from '../../lib/paper/briefPipeline'
import { getPaperGateway } from '../../lib/paper/gatewaySingleton'
import { getRepos } from '../../lib/paper/repo/repos'
import { createTurnRunner, findOrphanTurns, turnErrorDetail, type TurnError, type TurnState } from '../../lib/paper/turnEngine'
import { KEEP_PAIRS_AFTER_FOLD, MAX_LIVE_TURN_PAIRS, foldMemo, shouldRequestMemo, trimHistoryPairs } from '../../lib/paper/summarizer'
import { formatTokens, formatUsd } from '../../lib/paper/usage'
import { collectIslands, createStreamParserMemo, splitCopilotStream } from '../../lib/paper/streamParser'
import {
  applyEvidenceToStore,
  evidenceFromFeedback,
  evidenceFromLearnerIsland,
  evidenceFromQuestion,
  evidenceFromShortcut,
  evidenceFromVerdict,
  nextProfileHint,
  setPinnedLevel,
  summarizeProfile,
  type ConceptProfile,
  type DepthFeedback,
  type LearnerLevel,
  type ProfileEvidence,
  type ProfileHint,
} from '../../lib/paper/learnerProfile'
import {
  GUIDED_MODE_DEFS,
  LEARNER_DIRECTIVE,
  VERDICT_DIRECTIVE,
  advanceGuided,
  guidedStepAt,
  startGuided,
  type GuidedContext,
  type GuidedRun,
} from '../../lib/paper/guidedModes'
import {
  createTtsPlayer,
  initialTtsState,
  isTtsSupported,
  speakableText,
  takeCompleteSentences,
  ttsReducer,
  type TtsPlayer,
} from '../../lib/paper/tts'
import { createCloudTtsPlayer } from '../../lib/paper/voice/cloudTtsPlayer'
import { VOICE_ANSWER_DIRECTIVE } from '../../lib/paper/voice/prompts'
import { createRecorder, type Recorder } from '../../lib/paper/voice/recorder'
import { micErrorMessage } from '../../lib/paper/voice/recorderMime'
import { TTS_MIN_GROUP_CHARS, groupSentencesForTts } from '../../lib/paper/voice/ttsChunking'
import { transcribeAudio } from '../../lib/paper/voice/voiceApi'
import { personaHintText, type PersonaId } from '../../lib/paper/personas'
import type { RetrievalService } from '../../lib/paper/retrieval'
import type { ScrollTarget } from '../../lib/paper/anchors'
import type {
  CopilotBlockState,
  CopilotMessage as StoredMessage,
  PaperBlock,
  PaperRecord,
  SourceAnchor,
  StoredCiteEntry,
} from '../../lib/paper/types'
import { usePaperUi, type PaperAskAction, type PendingAsk } from '../../pages/papers/paperUiStore'
import type { ChatMessage } from '../../lib/llmClient'
import CopilotMessageView from './CopilotMessage'
import ConsentDialog from './ConsentDialog'
import VoiceConsentDialog from './VoiceConsentDialog'
import CostConfirm, { type CostConfirmInfo } from './CostConfirm'
import PersonaChip from './PersonaChip'
import ProfileChip from './ProfileChip'
import TurnFeedback from './TurnFeedback'

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

/** 本轮任务档位：chat/deep/deepAlt 均走 DeepSeek（用户决策 2026-08-13）；deepAlt 为显式点击的深度解释重发 */
type TurnTask = 'chat' | 'deep' | 'deepAlt'

interface SendParams {
  question: string
  retrievalQuery?: string
  selection?: string | null
  /** 语音提问附带的屏幕可见正文：进指代层 + 无选区时喂检索扩展（contextBuilder/turnEngine） */
  viewportContext?: string | null
  task: TurnTask
  planIsland: boolean
  label?: string
  /** 落库与展示用的用户消息文本（含引用的选区） */
  displayText: string
  /** 逐轮附加指令（引导步脚本 / learner / verdict 岛要求） */
  extraDirectives?: readonly string[]
  /** teach-back 轮：verdict 岛回写画像时的概念 */
  teachBackConcept?: string
  /** 回答来源标注（并列展示深度解释时，如 deepseek-v4-pro · 深度解释） */
  sourceLabel?: string
  /** 问题由用户自己写（不是脚本/模板）：只有这种问题才做抽象度启发式画像 */
  userAuthored?: boolean
}

type GateRequest =
  | { kind: 'consent'; provider: PaperProviderId; resolve: (ok: boolean) => void }
  | { kind: 'voice-consent'; resolve: (ok: boolean) => void }
  | { kind: 'cost'; info: CostConfirmInfo; resolve: (ok: boolean) => void }

const ASK_TEMPLATES: Record<Exclude<PaperAskAction, 'queue'>, { question: string; task: TurnTask }> = {
  explain: { question: '请解释我选中的这段论文内容。', task: 'chat' },
  simpler: {
    question: '请用更简单的方式解释我选中的这段内容：假设我是入门读者，先给直觉和类比，再给必要术语。',
    task: 'chat',
  },
  derive: { question: '请逐步推导/拆解我选中的这段中的公式或方法：给出每一步的依据与每个符号的含义。', task: 'deep' },
  example: { question: '请举一个具体的例子帮助理解我选中的这段内容。', task: 'chat' },
}

const PROVIDER_KEY_LABEL: Record<PaperProviderId, string> = {
  deepseek: 'DeepSeek',
  kimi: 'Kimi (Moonshot)',
}

/** 选区来自应用内译文时注入 question 最前（displayText 不带，用户不可见）：模型须回到英文原文语义作答 */
const TRANSLATED_ASK_NOTE = '以下引用是应用内生成的中文译文，原文为英文，请以原文语义为准。'

/**
 * 错误文案（§QA D-10）：底层 message 已经中文化过一次，这里再套前缀就成了
 * 「网络异常：网络异常：Failed to fetch」；一律走 turnErrorDetail 去重 + 去英文原文。
 * auth 按网关细分码两分支：未登录（401）/ 账号没配该 provider 的 key（403 no-user-key）。
 */
function friendlyTurnError(err: TurnError, provider: PaperProviderId = 'deepseek'): string {
  switch (err.kind) {
    case 'auth':
      if (err.code === 'no-user-key') {
        return `该账号尚未配置 ${PROVIDER_KEY_LABEL[provider]} 的 API key，请到设置页配置`
      }
      if (err.code === 'forbidden') return '访问被拒绝：账号可能被停用或无权限'
      return '请先登录后使用 AI 功能'
    case 'rate-limit':
      return '触发上游限流（429），稍候会自动排队，也可稍后手动重试'
    case 'timeout':
      return '请求超时：可以重试；深度推导可能需要更长时间'
    case 'network':
      return turnErrorDetail(err.message, '网络异常：请求没能送达，请检查网络后重试')
    case 'bad-response':
      return turnErrorDetail(err.message, '上游返回异常，请重试')
    case 'server':
      return turnErrorDetail(err.message, '上游报错，请稍后重试')
    default:
      return turnErrorDetail(err.message, '出错了，请重试')
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
  // 门面引用永不变（repos.ts 单例工厂）：账号切换不重挂组件也能路由到正确的库
  const repo = getRepos().copilot
  const learnerRepo = getRepos().learner

  const [session, setSession] = useState<Awaited<ReturnType<typeof repo.getOrCreateSession>> | null>(null)
  const [messages, setMessages] = useState<StoredMessage[]>([])
  const [live, setLive] = useState<TurnState | null>(null)
  const [error, setError] = useState<TurnError | null>(null)
  const [errorProvider, setErrorProvider] = useState<PaperProviderId>('deepseek')
  const [gate, setGate] = useState<GateRequest | null>(null)
  const [input, setInput] = useState('')
  const [attachedAsk, setAttachedAsk] = useState<PendingAsk | null>(null)
  const [profiles, setProfiles] = useState<ConceptProfile[]>([])
  const [guided, setGuided] = useState<GuidedRun | null>(null)

  const {
    briefUi,
    briefData,
    briefRequestTick,
    setBriefUi,
    setBriefData,
    voiceAsk,
    consumeVoiceAsk,
    setVoiceTurnPhase,
    setVoicePanelBusy,
    voiceStopSpeakTick,
    voiceSpeakTypedTurns,
    voiceTtsEngine,
    voiceTtsVoice,
  } = usePaperUi()

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
  const profilesRef = useRef(profiles)
  profilesRef.current = profiles
  /** 上一版画像文案：层级桶不变时原样复用，system#2 字节稳定（§5.4 前缀缓存） */
  const hintRef = useRef<ProfileHint | null>(null)
  const guidedRef = useRef(guided)
  guidedRef.current = guided
  /** 最近一轮 plan 岛给出的概念：反馈/快捷键等无概念上下文的证据挂到它上面 */
  const lastTurnConceptsRef = useRef<string[]>([])

  // -----------------------------------------------------------------------
  // 学习画像（§6.2）：装载 / 记证据 / pin / 重置
  // -----------------------------------------------------------------------
  useEffect(() => {
    let alive = true
    setProfiles([])
    hintRef.current = null
    void learnerRepo
      .load(paper.id)
      .then((rows) => {
        if (!alive) return
        profilesRef.current = rows
        setProfiles(rows)
      })
      .catch(() => undefined) // 画像读失败不阻断陪读，退回默认层级
    return () => {
      alive = false
    }
  }, [paper.id, learnerRepo])

  const profileSummary = useMemo(() => summarizeProfile(profiles, Date.now()), [profiles])

  const recordEvidence = useCallback(
    (ev: ProfileEvidence) => {
      const now = Date.now()
      const next = applyEvidenceToStore(profilesRef.current, ev, now)
      profilesRef.current = next // 同步写 ref：连续事件不丢
      setProfiles(next)
      const paperId = paperRef.current.id
      void learnerRepo.save(paperId, next).catch(() => undefined)
      void learnerRepo.logEvidence(paperId, ev).catch(() => undefined)
    },
    [learnerRepo],
  )

  const pinLevel = useCallback(
    (level: LearnerLevel | null) => {
      const next = setPinnedLevel(profilesRef.current, level, Date.now())
      profilesRef.current = next
      setProfiles(next)
      void learnerRepo.save(paperRef.current.id, next).catch(() => undefined)
    },
    [learnerRepo],
  )

  const resetProfile = useCallback(() => {
    profilesRef.current = []
    setProfiles([])
    hintRef.current = null
    void learnerRepo.reset(paperRef.current.id).catch(() => undefined)
  }, [learnerRepo])

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

  /** 语音独立授权（consents 表 key 'voice'）：面板内 🎙 听写首次使用前弹出 */
  const ensureVoiceConsent = useCallback(async (): Promise<boolean> => {
    const existing = await repo.getConsent('voice')
    if (existing?.granted) return true
    return new Promise<boolean>((resolve) => setGate({ kind: 'voice-consent', resolve }))
  }, [repo])

  const decideGate = useCallback(
    async (ok: boolean) => {
      if (!gate) return
      if (gate.kind === 'consent' && ok) await repo.setConsent(gate.provider, true)
      if (gate.kind === 'voice-consent' && ok) await repo.setConsent('voice', true)
      setGate(null)
      gate.resolve(ok)
    },
    [gate, repo],
  )

  // -----------------------------------------------------------------------
  // Gateway 与 turn runner（模块级单例：对话 / brief / 全文翻译共享同一令牌桶与熔断，
  // 各自建实例会让合成流量绕过客户端排队直接撞 nginx 429）
  // -----------------------------------------------------------------------
  const gateway = getPaperGateway()

  const runnerRef = useRef<ReturnType<typeof createTurnRunner> | null>(null)
  const getRunner = useCallback(() => {
    runnerRef.current ??= createTurnRunner({
      retrieve: (query, opts) =>
        retrieval.retrieve(paperRef.current.id, query, {
          topK: opts.topK,
          selection: opts.selection,
          viewport: opts.viewport,
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
    setGuided(null)
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

  /**
   * Track 3：售前新人视角开关，落在 CopilotSession.persona 上。
   * sessions 表已被 synced 装饰，updateSession 会自动把这次写入镜像进 outbox——
   * 跨设备同步不需要这里再写一行同步代码。本地 state 同步更新，下一轮发起时
   * runSendTurn 直接从 sessionRefState.current 读到最新值。
   */
  const setPersona = useCallback(
    (persona: PersonaId) => {
      const s = sessionRefState.current
      if (!s) return
      const patch = { persona }
      void repo.updateSession(s.id, patch).catch(() => undefined)
      setSession((prev) => (prev && prev.id === s.id ? { ...prev, ...patch } : prev))
    },
    [repo],
  )

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
      const spec = PAPER_TASKS[params.task]
      const provider = spec.cap.provider
      setErrorProvider(provider)
      const ok = await ensureConsent(provider)
      if (!ok) {
        setError({
          message: `未授权 ${provider === 'kimi' ? 'Moonshot (Kimi)' : 'DeepSeek'}：需要先授权才能发送论文片段`,
          kind: 'no-consent',
        })
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

      // 画像注入（§6.2）：层级桶/来源不变时复用上一版文案，system#2 字节稳定
      const hint = nextProfileHint(hintRef.current, summarizeProfile(profilesRef.current, Date.now()))
      hintRef.current = hint

      const outcome = await getRunner().run(
        {
          question: params.question,
          retrievalQuery: params.retrievalQuery,
          selection: params.selection ?? null,
          viewportContext: params.viewportContext ?? null,
          spec,
          planIsland: params.planIsland,
          memoIsland,
          extraDirectives: params.extraDirectives,
          context: {
            brief,
            profileHint: hint.text,
            personaHint: personaHintText(s.persona),
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
        thinkingDowngraded: st.thinkingDowngraded || undefined,
        insufficient: st.insufficient,
        sourceLabel: params.sourceLabel,
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
        setError({
          message: `响应中断：${friendlyTurnError(st.error!, provider)}（已保留部分内容）`,
          kind: st.error!.kind,
          ...(st.error!.code ? { code: st.error!.code } : {}), // auth 细分码不丢：引导动作照常可用
        })
      }

      // L2 画像（§6.2）：finalize 后从流内岛提取 learner 弱信号与 teach-back 判定
      const planConcepts = collectIslands(outcome.segs, 'plan').flatMap((p) => p.concepts)
      for (const island of collectIslands(outcome.segs, 'learner')) {
        for (const ev of evidenceFromLearnerIsland(island, Date.now())) recordEvidence(ev)
      }
      for (const island of collectIslands(outcome.segs, 'verdict')) {
        recordEvidence(
          evidenceFromVerdict(island, params.teachBackConcept ? [params.teachBackConcept] : planConcepts, Date.now()),
        )
      }
      // L1 抽象度启发式：只对用户自己写的问题生效——引导脚本里的「推导/公式」是模板措辞，不是读者信号
      const abstraction = params.userAuthored ? evidenceFromQuestion(params.question, planConcepts, Date.now()) : null
      if (abstraction) recordEvidence(abstraction)
      lastTurnConceptsRef.current = planConcepts

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
    [briefData, ensureConsent, getRunner, pushLive, recordEvidence, repo],
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
      const fromTranslation = attachedAsk?.translated === true
      setAttachedAsk(null)
      if (attachedAsk) onRemoveAsk(attachedAsk.id)
      void sendTurn({
        question: fromTranslation ? `${TRANSLATED_ASK_NOTE}\n${text}` : text,
        selection: sel,
        task: 'chat',
        planIsland: true,
        extraDirectives: [LEARNER_DIRECTIVE],
        userAuthored: true,
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
      // L1 证据（§6.2）：「更简单 / 推导」这两个快捷键本身就是层级信号
      const shortcut = evidenceFromShortcut(ask.action, lastTurnConceptsRef.current, Date.now())
      if (shortcut) recordEvidence(shortcut)
      void sendTurn({
        question: ask.translated ? `${TRANSLATED_ASK_NOTE}\n${tpl.question}` : tpl.question,
        selection: ask.text,
        task: tpl.task,
        planIsland: false, // (b) 类：意图由按钮完全确定，无 plan 岛，TTFT 最快
        label: ask.label,
        displayText: `【${ask.label}】\n"""\n${ask.text.slice(0, 600)}\n"""`,
      })
    },
    [busy, onRemoveAsk, recordEvidence, sendTurn],
  )

  // -----------------------------------------------------------------------
  // 引导模式（§3.4 七入口 / §6.1c 每步 1 调用）
  // -----------------------------------------------------------------------
  const guidedCtx = useCallback(
    (): GuidedContext => ({
      paperTitle: paperRef.current.title,
      sectionTitles: sectionTitlesRef.current,
      ...(positionRef.current.section ? { currentSection: positionRef.current.section } : {}),
    }),
    [],
  )

  const runGuidedStep = useCallback(
    (run: GuidedRun) => {
      const spec = guidedStepAt(run, guidedCtx())
      if (!spec) return
      void sendTurn({
        question: spec.question,
        retrievalQuery: spec.retrievalQuery,
        task: spec.task,
        planIsland: spec.planIsland,
        extraDirectives: spec.extraDirectives,
        label: spec.label,
        displayText: spec.displayText,
      })
    },
    [guidedCtx, sendTurn],
  )

  const startGuidedMode = useCallback(
    (modeId: string) => {
      if (busy) return
      const run = startGuided(modeId, guidedCtx())
      if (!run) return
      setGuided(run)
      runGuidedStep(run)
    },
    [busy, guidedCtx, runGuidedStep],
  )

  const nextGuidedStep = useCallback(() => {
    const run = guidedRef.current
    if (!run || busy) return
    const next = advanceGuided(run, guidedCtx())
    setGuided(next)
    if (next) runGuidedStep(next) // 用户点击才推进：严格 1 调用/步
  }, [busy, guidedCtx, runGuidedStep])

  // -----------------------------------------------------------------------
  // teach-back / 深度反馈 / 深度解释（deepAlt）
  // -----------------------------------------------------------------------
  const sendTeachBack = useCallback(
    (payload: { prompt: string; answer: string; concept?: string }) => {
      if (busy) return
      void sendTurn({
        question: `我对「${payload.prompt}」的复述如下，请对照论文指出遗漏、错误与讲得好的地方：\n"""\n${payload.answer.slice(0, 2000)}\n"""`,
        retrievalQuery: `${payload.concept ?? ''} ${payload.prompt}`.trim(),
        task: 'chat',
        planIsland: false,
        extraDirectives: [VERDICT_DIRECTIVE],
        label: '复述检查',
        ...(payload.concept ? { teachBackConcept: payload.concept } : {}),
        displayText: `【我的复述】\n${payload.answer.slice(0, 600)}`,
      })
    },
    [busy, sendTurn],
  )

  /**
   * 「有问无答」的中断轮（§QA D-8）：页面在流式中途被关掉时，用户消息已落库而回答没有。
   * 恢复会话后标注「已中断」并给一键重发；末条正在生成回答时不算孤儿。
   */
  // 依赖用 live !== null 而不是 live 本身：否则每个 delta 的 rAF 刷新都要重算一遍（§7.6）
  const hasLiveTurn = live !== null
  const orphanIds = useMemo(() => findOrphanTurns(messages, { liveTail: hasLiveTurn }), [messages, hasLiveTurn])

  const resendOrphan = useCallback(
    (msg: StoredMessage) => {
      if (busy) return
      void sendTurn({
        question: msg.content,
        task: 'chat',
        planIsland: true,
        extraDirectives: [LEARNER_DIRECTIVE],
        userAuthored: true,
        displayText: msg.content,
        ...(msg.actionLabel ? { label: msg.actionLabel } : {}),
      })
    },
    [busy, sendTurn],
  )

  /** 交互块作答状态回写（§QA D-7）：合并进消息元数据并落库，刷新后由块自身恢复 */
  const updateBlockState = useCallback(
    (messageId: string, key: string, patch: CopilotBlockState) => {
      const msg = messagesRef.current.find((m) => m.id === messageId)
      if (!msg) return
      const merged: Record<string, CopilotBlockState> = {
        ...(msg.blockStates ?? {}),
        [key]: { ...(msg.blockStates?.[key] ?? {}), ...patch },
      }
      setMessages((list) => list.map((m) => (m.id === messageId ? { ...m, blockStates: merged } : m)))
      void repo.updateMessage(messageId, { blockStates: merged }).catch(() => undefined)
    },
    [repo],
  )

  const giveFeedback = useCallback(
    (msg: StoredMessage, kind: DepthFeedback) => {
      if (msg.feedback === kind) return
      // 概念取这条回答自己的 plan 岛（可能是历史消息，未必是最近一轮）
      const concepts = collectIslands(splitCopilotStream(msg.content, { open: false }), 'plan').flatMap((p) => p.concepts)
      recordEvidence(evidenceFromFeedback(kind, concepts.length ? concepts : lastTurnConceptsRef.current, Date.now()))
      setMessages((list) => list.map((m) => (m.id === msg.id ? { ...m, feedback: kind } : m)))
      void repo.updateMessage(msg.id, { feedback: kind }).catch(() => undefined)
    },
    [recordEvidence, repo],
  )

  /** 「换一种深度解释」：同轮上下文用 deepAlt 档（deepseek-v4-pro 深思考、更高温度）重发，并列展示并标注来源 */
  const deepAlternative = useCallback(
    (msg: StoredMessage) => {
      if (busy) return
      const list = messagesRef.current
      const idx = list.findIndex((m) => m.id === msg.id)
      const question = [...list.slice(0, idx === -1 ? list.length : idx)].reverse().find((m) => m.role === 'user')?.content
      if (!question) return
      void sendTurn({
        question: `请换一种讲法，给出更有深度的解释（可以补充推导、边界条件与相关方法差异）：\n${question.slice(0, 1500)}`,
        retrievalQuery: question.slice(0, 300),
        task: 'deepAlt',
        planIsland: false,
        label: '深度解释',
        sourceLabel: 'deepseek-v4-pro · 深度解释',
        displayText: '【换一种深度解释】',
      })
    },
    [busy, sendTurn],
  )

  // -----------------------------------------------------------------------
  // 语音（§9）：听写输入 + 朗读回答
  // -----------------------------------------------------------------------
  const [tts, dispatchTts] = useReducer(ttsReducer, initialTtsState)
  const ttsSupported = useMemo(() => isTtsSupported(), [])
  /** 云端朗读降级等一次性提示（aria-live 行展示，下一轮语音提问时清空） */
  const [voiceNotice, setVoiceNotice] = useState('')
  const playerRef = useRef<(TtsPlayer & { dispose?: () => void }) | null>(null)
  /** 当前播放器按哪组偏好构建：引擎/音色变更即重建，否则设置不生效（缓存陈旧实现） */
  const playerKeyRef = useRef('')
  const getPlayer = useCallback(() => {
    const key = `${voiceTtsEngine}:${voiceTtsVoice}`
    if (playerRef.current !== null && playerKeyRef.current === key) return playerRef.current
    playerRef.current?.cancel()
    playerRef.current?.dispose?.()
    playerKeyRef.current = key
    playerRef.current =
      voiceTtsEngine === 'cloud'
        ? createCloudTtsPlayer({
            fallback: createTtsPlayer(),
            ...(voiceTtsVoice ? { voice: voiceTtsVoice } : {}),
            onDegrade: setVoiceNotice,
          })
        : createTtsPlayer()
    return playerRef.current
  }, [voiceTtsEngine, voiceTtsVoice])
  /** 正在朗读的对象：消息 id 或 'live'（流式跟读） */
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  /** 已入队到的字符位置（跟读续接点） */
  const consumedRef = useRef(0)
  const liveSpeechRef = useRef('')
  const liveFlushedRef = useRef(false)
  /** 云端 TTS 成组缓冲：句子攒到 TTS_MIN_GROUP_CHARS 再合成（省调用）；首句立即放行（压首音延迟） */
  const pendingTtsRef = useRef<string[]>([])
  const spokeFirstRef = useRef(false)

  const flushTtsGroups = useCallback(
    (flush: boolean) => {
      const pending = pendingTtsRef.current
      if (pending.length === 0) return
      // 浏览器朗读维持逐句入队的旧行为：成组只有云端有动机（按次计费 + 每次合成的固定延迟）
      if (voiceTtsEngine !== 'cloud') {
        dispatchTts({ type: 'enqueue', sentences: pending.splice(0) })
        return
      }
      if (!spokeFirstRef.current) {
        const first = pending.shift()
        if (first !== undefined) {
          spokeFirstRef.current = true
          dispatchTts({ type: 'enqueue', sentences: [first] })
        }
      }
      if (pending.length === 0) return
      const joined = pending.reduce((n, s) => n + s.length, 0)
      if (!flush && joined < TTS_MIN_GROUP_CHARS) return
      dispatchTts({ type: 'enqueue', sentences: groupSentencesForTts(pending.splice(0), { isFirst: false }) })
    },
    [voiceTtsEngine],
  )

  // 播放驱动：current 变化即朗读一句，结束回 'ended' 取下一句
  useEffect(() => {
    if (tts.status !== 'speaking' || tts.current === null) return
    getPlayer().speak(tts.current, () => dispatchTts({ type: 'ended' }))
  }, [tts.seq, tts.status, tts.current, getPlayer])

  const stopSpeaking = useCallback(() => {
    getPlayer().cancel()
    dispatchTts({ type: 'stop' })
    setSpeakingId(null)
    consumedRef.current = 0
    pendingTtsRef.current = []
    spokeFirstRef.current = false
  }, [getPlayer])

  const speakText = useCallback(
    (id: string, text: string) => {
      if (speakingId === id) {
        stopSpeaking()
        return
      }
      getPlayer().cancel()
      dispatchTts({ type: 'stop' })
      const { sentences } = takeCompleteSentences(text, 0, true)
      consumedRef.current = text.length
      setSpeakingId(id)
      dispatchTts({
        type: 'enqueue',
        sentences: voiceTtsEngine === 'cloud' ? groupSentencesForTts(sentences, { isFirst: true }) : sentences,
      })
      dispatchTts({ type: 'start' })
      dispatchTts({ type: 'source-end' })
    },
    [getPlayer, speakingId, stopSpeaking, voiceTtsEngine],
  )

  const speakMessage = useCallback(
    (msg: StoredMessage) => {
      const parser = createStreamParserMemo()
      speakText(msg.id, speakableText(parser(msg.content, { open: false })))
    },
    [speakText],
  )

  /** 边生成边朗读：队列先空转，等流式句子补进来 */
  const startLiveSpeak = useCallback(() => {
    getPlayer().cancel()
    dispatchTts({ type: 'stop' })
    consumedRef.current = 0
    liveSpeechRef.current = ''
    liveFlushedRef.current = false
    pendingTtsRef.current = []
    spokeFirstRef.current = false
    setSpeakingId('live')
    dispatchTts({ type: 'start' })
  }, [getPlayer])

  /** 流式跟读：完整句子就绪即进成组缓冲；轮次结束时补尾句、清空缓冲并标记源结束（§9） */
  useEffect(() => {
    if (speakingId !== 'live') return
    const streaming = live !== null && live.phase !== 'done' && live.phase !== 'error'
    if (streaming) {
      const text = speakableText(splitCopilotStream(live.text, { open: true }))
      liveSpeechRef.current = text
      const { sentences, consumed } = takeCompleteSentences(text, consumedRef.current)
      if (sentences.length === 0) return
      consumedRef.current = consumed
      pendingTtsRef.current.push(...sentences)
      flushTtsGroups(false)
      return
    }
    if (liveFlushedRef.current) return
    liveFlushedRef.current = true
    const { sentences } = takeCompleteSentences(liveSpeechRef.current, consumedRef.current, true)
    consumedRef.current = liveSpeechRef.current.length
    pendingTtsRef.current.push(...sentences)
    flushTtsGroups(true)
    dispatchTts({ type: 'source-end' })
  }, [live, speakingId, flushTtsGroups])

  const stopTurn = useCallback(() => {
    runnerRef.current?.stop()
    if (speakingId === 'live') stopSpeaking() // Stop 生成时同时清空未读队列
  }, [speakingId, stopSpeaking])

  // 听写输入：云端 ASR（原 webkitSpeechRecognition 依赖 Google 服务，大陆环境实际不可用，
  // 见 PLAN-voice-copilot.md）。转写结果仍只追加进输入框、由用户确认后发送——自动发送
  // 是悬浮球的语义，面板内保持打字流的手动确认心智。录音流走 recorderSingleton，与
  // 悬浮球共享同一条 MediaStream 引用计数。
  const dictationSupported = useMemo(
    () =>
      typeof MediaRecorder !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function',
    [],
  )
  const [dictation, setDictation] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const dictationRecRef = useRef<Recorder | null>(null)
  /** 代数守卫（SelectionAsk 竞态模式）：取消/卸载后迟到的 stop()/fetch 结果一律作废 */
  const dictationGenRef = useRef(0)

  const stopDictation = useCallback(() => {
    dictationGenRef.current += 1
    dictationRecRef.current?.cancel()
    setDictation('idle')
  }, [])

  const toggleDictation = useCallback(async () => {
    if (dictation === 'transcribing') return
    if (dictation === 'recording') {
      const rec = dictationRecRef.current
      if (rec === null) {
        setDictation('idle')
        return
      }
      const gen = ++dictationGenRef.current
      setDictation('transcribing')
      const audio = await rec.stop()
      if (gen !== dictationGenRef.current) return
      if (audio === null || audio.blob.size < 2048 || audio.durationMs < 300) {
        setDictation('idle')
        setError({ message: '没有录到声音，请点击麦克风后多说一会儿', kind: 'speech' })
        return
      }
      try {
        const { text } = await transcribeAudio(audio.blob, { lang: 'auto' })
        if (gen !== dictationGenRef.current) return
        const trimmed = text.trim()
        if (trimmed) setInput((v) => (v ? `${v}${trimmed}` : trimmed))
        else setError({ message: '没听清，请再试一次', kind: 'speech' })
      } catch (e) {
        if (gen !== dictationGenRef.current) return
        setError({ message: e instanceof Error ? e.message : '语音识别失败，请重试', kind: 'speech' })
      } finally {
        if (gen === dictationGenRef.current) setDictation('idle')
      }
      return
    }
    // 起录：敏感论文不采音；首次使用先过语音独立授权
    if (paperRef.current.sensitive) {
      setError({ message: '这篇论文已标记为敏感：语音功能已禁用', kind: 'speech' })
      return
    }
    if (!(await ensureVoiceConsent())) return
    try {
      dictationRecRef.current ??= createRecorder()
      await dictationRecRef.current.start()
      setDictation('recording')
    } catch (e) {
      setError({ message: micErrorMessage(e), kind: 'speech' })
    }
  }, [dictation, ensureVoiceConsent])

  useEffect(
    () => () => {
      dictationGenRef.current += 1
      dictationRecRef.current?.dispose()
      dictationRecRef.current = null
      playerRef.current?.cancel()
      playerRef.current?.dispose?.() // 云端播放器：释放共享 <audio> 的回调与在途请求
    },
    [],
  )

  const retryLast = useCallback(() => {
    const params = lastParamsRef.current
    if (params && !busy) void sendTurn(params)
  }, [busy, sendTurn])

  /** 未登录（401）分支：弹全局登录 gate，成功后用 lastParamsRef 自动重试本轮 */
  const loginAndRetry = useCallback(async () => {
    const ok = await useAuthStore.getState().requireLogin('llm')
    if (ok) retryLast()
  }, [retryLast])

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
              structuredFallback:
                req.task === 'brief-synthesis'
                  ? buildStructuredFallbackSpec(PAPER_TASKS.briefSynthesis.maxOutputTokens)
                  : buildStructuredFallbackSpec(digestSpec.maxOutputTokens),
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
  // 语音陪读（悬浮球 → store → 面板）：消费提问 / 自动跟读 / 阶段回写 / 打断
  // -----------------------------------------------------------------------

  /** 等 live 就绪再 startLiveSpeak 的挂起标记：与 sendTurn 同步调用会在 live===null 时
   *  走 flush 分支立即 source-end 关死队列（PLAN「设计代理抓出的坑」#2） */
  const pendingLiveSpeakRef = useRef(false)
  /** 当前轮次是否语音发起：只有语音轮回写 voiceTurnPhase，打字轮不动它 */
  const voiceTurnRef = useRef(false)
  const voiceTurnDoneRef = useRef(false)
  const voiceTurnSpeakRef = useRef(false)
  const errorRef = useRef(error)
  errorRef.current = error
  const ttsStatusRef = useRef(tts.status)
  ttsStatusRef.current = tts.status
  const speakingIdRef = useRef(speakingId)
  speakingIdRef.current = speakingId

  const maybeFinishVoiceTurn = useCallback(() => {
    if (!voiceTurnRef.current || !voiceTurnDoneRef.current) return
    // 要求朗读的轮次等 TTS 队列排空（仍在 live 跟读且状态未回 idle = 还在读）
    if (voiceTurnSpeakRef.current && speakingIdRef.current === 'live' && ttsStatusRef.current !== 'idle') return
    voiceTurnRef.current = false
    voiceTurnDoneRef.current = false
    voiceTurnSpeakRef.current = false
    pendingLiveSpeakRef.current = false // 流未起就失败的轮次：别把标记漏给下一轮
    const err = errorRef.current
    if (err) setVoiceTurnPhase('error', err.message)
    else setVoiceTurnPhase('done')
  }, [setVoiceTurnPhase])

  // 排空检测：tts 状态回 idle 的那一刻补一次收尾判定
  useEffect(() => {
    maybeFinishVoiceTurn()
  }, [tts.status, maybeFinishVoiceTurn])

  // 面板忙闲回写：悬浮球据此拒绝新提问 / 暂停连续对话重臂
  useEffect(() => {
    setVoicePanelBusy(busy)
  }, [busy, setVoicePanelBusy])

  // 「开口」时刻回写：live 跟读真正读出第一句
  useEffect(() => {
    if (!voiceTurnRef.current) return
    if (speakingId === 'live' && tts.status === 'speaking' && tts.current !== null) setVoiceTurnPhase('speaking')
  }, [speakingId, tts.status, tts.current, setVoiceTurnPhase])

  // 挂起的自动跟读：等第一帧 live 状态落地再启动
  useEffect(() => {
    if (!pendingLiveSpeakRef.current || live === null) return
    pendingLiveSpeakRef.current = false
    startLiveSpeak()
  }, [live, startLiveSpeak])

  // 语音提问消费（consume-and-clear：新挂载的面板也能拿到载荷，见 paperUiStore.VoiceAsk 注释）
  useEffect(() => {
    if (voiceAsk === null) return
    if (voiceAsk.paperId !== paper.id) {
      consumeVoiceAsk() // 陈旧载荷（切论文竞态）：弃掉，不能留给未来的错误论文
      return
    }
    if (session === null) return // 会话装载后本 effect 因 session 变化自动重跑
    consumeVoiceAsk()
    if (getRunner().busy()) {
      setVoiceTurnPhase('error', '回答进行中，说完这轮再问')
      return
    }
    setVoiceNotice('')
    voiceTurnRef.current = true
    voiceTurnDoneRef.current = false
    voiceTurnSpeakRef.current = voiceAsk.speak
    pendingLiveSpeakRef.current = voiceAsk.speak
    setVoiceTurnPhase('thinking')
    stickRef.current = true
    void sendTurn({
      question: voiceAsk.text,
      selection: voiceAsk.selection,
      viewportContext: voiceAsk.viewportContext,
      task: 'chat',
      planIsland: true,
      label: '语音提问',
      extraDirectives: [LEARNER_DIRECTIVE, VOICE_ANSWER_DIRECTIVE],
      userAuthored: true,
      displayText: voiceAsk.text,
    }).then(() => {
      voiceTurnDoneRef.current = true
      maybeFinishVoiceTurn()
    })
  }, [voiceAsk, paper.id, session, consumeVoiceAsk, getRunner, sendTurn, setVoiceTurnPhase, maybeFinishVoiceTurn])

  // 打断信号（ball → panel）：停播清未读队列，但不打断生成（文字继续流入对话）
  const seenStopSpeakRef = useRef(voiceStopSpeakTick)
  useEffect(() => {
    if (voiceStopSpeakTick === seenStopSpeakRef.current) return
    seenStopSpeakRef.current = voiceStopSpeakTick
    stopSpeaking()
  }, [voiceStopSpeakTick, stopSpeaking])

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

  /**
   * 流式期间的第二次提交（§QA P1-2）：不排队（保持单飞语义），但**不清空输入**、
   * 给一行 aria-live 提示。修复前问题会被静默吞掉——输入框清空、没有任何反馈。
   */
  const [sendBlocked, setSendBlocked] = useState(false)
  useEffect(() => {
    if (!busy) setSendBlocked(false)
  }, [busy])

  const submit = useCallback(() => {
    const value = input.trim()
    if (!value) return
    if (busy) {
      setSendBlocked(true)
      return
    }
    if (dictation !== 'idle') stopDictation()
    setInput('')
    setSendBlocked(false)
    stickRef.current = true
    // 「打字提问也朗读」偏好：同一条挂起标记，live 就绪后自动开跟读（不回写语音阶段）
    if (voiceSpeakTypedTurns && ttsSupported) pendingLiveSpeakRef.current = true
    sendFree(value)
  }, [busy, input, dictation, sendFree, stopDictation, voiceSpeakTypedTurns, ttsSupported])

  const sessionCost = session?.costTotal ?? 0
  const lastUsage = live?.usage ?? null
  const paperAsks = asks.filter((a) => a.paperId === paper.id)

  // -----------------------------------------------------------------------
  // 渲染
  // -----------------------------------------------------------------------
  // 根节点带 @container：面板宽度有三档（标准/加宽/超宽）外加专注陪读整列，
  // 块级组件必须按**容器**宽度自适应——视口断点在这里是错的（同一视口下面板可宽可窄）
  return (
    <div className="@container flex h-full flex-col" data-paper-selection-ui="">
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

      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.7rem] text-dim">
        <ProfileChip summary={profileSummary} onPin={pinLevel} onReset={resetProfile} />
        <PersonaChip value={session?.persona} onChange={setPersona} />
        <span>
          {sessionCost > 0 && <>会话累计 {formatUsd(sessionCost)} · </>}
          deepseek-v4-pro
          {paper.sensitive ? ' · 敏感模式（远程调用已禁用）' : ''}
        </span>
        <button
          type="button"
          onClick={() => onToggleSensitive(!paper.sensitive)}
          className="rounded border border-line px-1.5 py-0.5 text-[0.65rem] text-dim transition-colors hover:text-fg"
        >
          {paper.sensitive ? '取消敏感标记' : '标记为敏感'}
        </button>
      </div>

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
                // 整卡可点：只有小标签可点时，用户会以为卡片本身没有动作（§QA D-6）
                <li key={ask.id} className="relative rounded-lg border border-line bg-panel-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => consumeAsk(ask)}
                    title={busy ? '回答进行中，完成后可发起' : '点击发起这条提问'}
                    className="block w-full rounded-lg border border-transparent p-2 pr-12 text-left transition-colors hover:border-accent/40 hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent"
                  >
                    <span className="mb-1 inline-block rounded border border-accent/40 px-1.5 py-0.5 text-[0.65rem] text-accent">
                      {ask.action === 'queue' ? '引用并提问' : ask.label}
                    </span>
                    {ask.translated && (
                      <span className="mb-1 ml-1 inline-block rounded border border-accent-2/40 bg-accent-2/10 px-1.5 py-0.5 text-[0.65rem] text-accent-2">
                        译文
                      </span>
                    )}
                    <span className="line-clamp-2 block text-[0.7rem] leading-relaxed text-fg">{ask.text}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveAsk(ask.id)}
                    className="absolute top-2 right-2 text-[0.7rem] text-dim transition-colors hover:text-bad"
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 引导模式入口（七入口全开；每步 1 次调用，由用户点击推进） */}
        {!guided && !busy && (
          <section>
            <p className="mb-1.5 text-xs font-medium text-fg">引导模式</p>
            <div className="flex flex-wrap gap-1.5">
              {GUIDED_MODE_DEFS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  disabled={busy}
                  title={m.hint}
                  onClick={() => startGuidedMode(m.id)}
                  className="rounded-lg border border-accent/40 px-2.5 py-1 text-xs text-accent transition-colors hover:bg-accent/10 disabled:opacity-40"
                >
                  {m.label}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* 历史消息 */}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="flex flex-col items-end">
              {/* 提问来源标签（语音提问 / 选段快捷键等）：与 assistant 侧 sourceLabel 徽章同族 */}
              {m.actionLabel && (
                <p className="mb-0.5 inline-block rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[0.65rem] text-accent">
                  {m.actionLabel}
                </p>
              )}
              {/* 超宽档下 92% 会拉出一条极长的单行气泡，再加 36rem 绝对上限保住可读行长 */}
              <div className="max-w-[min(92%,36rem)] rounded-lg bg-accent/15 px-3 py-2 text-xs break-words whitespace-pre-wrap text-fg">
                {m.content}
              </div>
              {orphanIds.has(m.id) && (
                <p className="mt-0.5 flex items-center gap-2 text-[0.65rem] text-warn">
                  已中断（这条提问没有得到回答）
                  <button
                    type="button"
                    onClick={() => resendOrphan(m)}
                    disabled={busy}
                    className="rounded border border-line px-1.5 py-0.5 text-accent transition-colors hover:bg-accent/10 disabled:opacity-40"
                  >
                    重新发送
                  </button>
                </p>
              )}
            </div>
          ) : (
            <div key={m.id}>
              {m.sourceLabel && (
                <p className="mb-0.5 inline-block rounded-full border border-accent-2/40 bg-accent-2/10 px-2 py-0.5 text-[0.65rem] text-accent-2">
                  {m.sourceLabel}
                </p>
              )}
              <CopilotMessageView
                content={m.content}
                done
                citeMap={m.citeMap ?? []}
                badges={m.auditBadges ?? null}
                interrupted={m.interrupted}
                thinkingDowngraded={m.thinkingDowngraded}
                insufficient={m.insufficient}
                onJumpCite={jumpEntry}
                onEvidence={recordEvidence}
                onTeachBack={sendTeachBack}
                busy={busy}
                {...(m.blockStates ? { blockStates: m.blockStates } : {})}
                onBlockState={(key, patch) => updateBlockState(m.id, key, patch)}
              />
              {m.usage && (
                <p className="mt-0.5 text-[0.65rem] text-dim">
                  {formatTokens(m.usage.inputTokens)} in / {formatTokens(m.usage.outputTokens)} out ·{' '}
                  {formatUsd(m.usage.cost)}
                  {m.usage.estimated ? '（估算）' : ''}
                </p>
              )}
              <TurnFeedback
                {...(m.feedback ? { value: m.feedback } : {})}
                onFeedback={(kind) => giveFeedback(m, kind)}
                onDeepAlt={m.sourceLabel ? undefined : () => deepAlternative(m)}
                disabled={busy}
                speech={
                  ttsSupported ? { label: speakingId === m.id ? '停止朗读' : '朗读本条', onClick: () => speakMessage(m) } : null
                }
              />
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
                busy
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

        {/* 引导模式进度与推进（每次点击 = 1 次调用） */}
        {guided && (
          <div className="rounded-lg border border-accent/30 bg-panel-2 p-2.5 text-xs">
            <p className="mb-1.5 text-dim">
              {GUIDED_MODE_DEFS.find((m) => m.id === guided.modeId)?.label} · 第 {guided.stepIndex + 1}/{guided.total} 步
            </p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={nextGuidedStep}
                disabled={busy}
                className="rounded-lg bg-accent px-2.5 py-1 text-[0.7rem] font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
              >
                {guided.stepIndex + 1 >= guided.total ? '完成引导' : '继续下一步'}
              </button>
              <button
                type="button"
                onClick={() => setGuided(null)}
                className="rounded-lg border border-line px-2.5 py-1 text-[0.7rem] text-dim transition-colors hover:text-fg"
              >
                退出引导
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="mt-2 border-t border-line pt-2">
        {tts.status !== 'idle' && (
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[0.7rem] text-dim">
            <span className="text-accent">{tts.status === 'paused' ? '朗读已暂停' : '正在朗读…'}</span>
            <button
              type="button"
              onClick={() => {
                if (tts.status === 'paused') {
                  getPlayer().resume()
                  dispatchTts({ type: 'resume' })
                } else {
                  getPlayer().pause()
                  dispatchTts({ type: 'pause' })
                }
              }}
              className="rounded border border-line px-1.5 py-0.5 transition-colors hover:text-fg"
            >
              {tts.status === 'paused' ? '继续' : '暂停'}
            </button>
            <button type="button" onClick={stopSpeaking} className="rounded border border-line px-1.5 py-0.5 transition-colors hover:text-bad">
              停止朗读
            </button>
          </div>
        )}
        {error && (
          <p className="mb-1.5 text-xs text-bad">
            {friendlyTurnError(error, errorProvider)}
            {/* auth 细分动作优先：未登录给「登录后重试」、缺 key 给设置页入口，普通重试按钮让位 */}
            {error.code === 'unauthenticated' ? (
              <button
                type="button"
                onClick={() => void loginAndRetry()}
                className="ml-2 text-accent underline underline-offset-2"
              >
                登录后重试
              </button>
            ) : error.code === 'no-user-key' ? (
              <Link to="/settings" className="ml-2 text-accent underline underline-offset-2">
                去设置页配 key
              </Link>
            ) : (
              error.kind !== 'cost-declined' &&
              error.kind !== 'sensitive-blocked' && (
                <button type="button" onClick={retryLast} className="ml-2 text-accent underline underline-offset-2">
                  重试
                </button>
              )
            )}
            {error.kind === 'no-consent' && (
              <button
                type="button"
                onClick={() => void ensureConsent(errorProvider)}
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
            // IME-safe：中文输入法回车不误发；流式中 submit 只提示不发送、也不清空输入
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          rows={2}
          placeholder="围绕这篇论文提问，Enter 发送 / Shift+Enter 换行"
          className="w-full resize-y rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm leading-relaxed"
        />
        {/* 常驻于 DOM（aria-live 区域先存在才会播报），空时不占高度 */}
        <p aria-live="polite" className="mt-0.5 text-[0.65rem] text-warn">
          {sendBlocked && busy ? '回答进行中，完成后可发送（问题已保留在输入框）' : voiceNotice || null}
        </p>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-[0.65rem] text-dim">
            {dictation === 'recording'
              ? '正在录音…（再次点击麦克风结束）'
              : dictation === 'transcribing'
                ? '识别中…'
                : busy
                  ? live?.reasoning
                    ? '深度思考中…'
                    : '回答中…'
                  : '回答基于本地检索片段，均带可回跳引用'}
          </span>
          {dictationSupported && (
            <button
              type="button"
              onClick={() => void toggleDictation()}
              disabled={dictation === 'transcribing'}
              aria-pressed={dictation === 'recording'}
              title={dictation === 'recording' ? '结束录音并识别' : '语音输入（识别结果进输入框）'}
              className={`shrink-0 rounded-lg border px-2 py-1 text-sm transition-colors disabled:opacity-40 ${
                dictation === 'recording' ? 'border-accent bg-accent/10 text-accent' : 'border-line text-dim hover:text-fg'
              }`}
            >
              🎙
            </button>
          )}
          {ttsSupported && busy && (
            <button
              type="button"
              onClick={() => (speakingId === 'live' ? stopSpeaking() : startLiveSpeak())}
              className="shrink-0 rounded-lg border border-line px-2 py-1 text-[0.7rem] text-dim transition-colors hover:text-fg"
            >
              {speakingId === 'live' ? '停止跟读' : '边生成边朗读'}
            </button>
          )}
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
      {gate?.kind === 'voice-consent' && <VoiceConsentDialog onDecide={(ok) => void decideGate(ok)} />}
      {gate?.kind === 'cost' && <CostConfirm info={gate.info} onDecide={(ok) => void decideGate(ok)} />}
    </div>
  )
}
