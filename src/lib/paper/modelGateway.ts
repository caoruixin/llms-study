import { LlmError, extractContent, throwForHttpStatus, type ChatMessage } from '../llmClient'
import { extractStreamUsage, type StreamUsage } from '../sse'
import { buildChatBody } from './providerAdapters'
import { runPaperStream } from './stream'
import { normalizeUsage, type GatewayUsage } from './usage'
import {
  PAPER_CIRCUIT,
  PAPER_PROVIDER_LABELS,
  PAPER_RATE_LIMIT,
  type PaperCallSpec,
  type PaperProviderId,
} from '../../data/paperPolicy'

/**
 * ModelGateway（§4.3/§5.2/§5.5）：Paper 专属模型路由的执行层。
 * llmClient 不背策略——重试、熔断、令牌桶、授权检查、usage/cost 归一化全部在这里。
 * 全部依赖（时钟/睡眠/随机/授权/usage 落库）可注入，node 环境直接单测（stub fetch）。
 */

export type GatewayErrorKind = 'no-consent' | 'circuit-open' | 'sensitive-blocked'

export class GatewayError extends Error {
  kind: GatewayErrorKind
  provider: PaperProviderId
  /** circuit-open 时的剩余冷却毫秒 */
  remainingMs?: number
  constructor(kind: GatewayErrorKind, provider: PaperProviderId, message: string) {
    super(message)
    this.kind = kind
    this.provider = provider
  }
}

/** usage 落库草稿：不含任何问题/正文/key（§8） */
export interface UsageDraft extends GatewayUsage {
  paperId: string
  ts: number
  status: 'ok' | 'aborted' | 'error'
  latencyMs: number
  task?: string
}

export interface GatewayDeps {
  /** provider 独立授权检查（§8：不跨 provider 继承） */
  hasConsent: (provider: PaperProviderId) => boolean | Promise<boolean>
  /** usage 记录（落 Dexie）；失败不阻断主流程 */
  recordUsage?: (draft: UsageDraft) => void | Promise<void>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  rate?: { capacity: number; refillMs: number }
  circuit?: { failures: number; cooldownMs: number }
  firstByteTimeoutMs?: number
  idleTimeoutMs?: number
  /** completePaperJson 的整体超时（每次调用） */
  jsonTimeoutMs?: number
}

export interface StreamPaperChatRequest {
  spec: PaperCallSpec
  messages: ChatMessage[]
  paperId: string
  /** 敏感论文：禁全部远程调用（§8） */
  sensitive?: boolean
  signal?: AbortSignal
  task?: string
  onDelta: (delta: string) => void
  onReasoningTick?: () => void
  /** 令牌桶排队时报告等待毫秒（UI 显示「排队中」） */
  onWait?: (waitMs: number) => void
  /** 自动重试前回调（UI 可提示「正在重试」） */
  onRetry?: (reason: string) => void
}

export type StreamPaperChatResult = GatewayUsage & { text: string; aborted: boolean }

export interface CompletePaperJsonRequest {
  spec: PaperCallSpec
  messages: ChatMessage[]
  paperId: string
  sensitive?: boolean
  signal?: AbortSignal
  task?: string
  /** 返回 null 表示结构不合法（触发修复阶梯）；不传则不校验 */
  validate?: (raw: string) => unknown | null
  /** §5.5：结构化失败且已授权 Moonshot 时的跨厂兜底 spec；未授权时静默跳过 */
  kimiFallback?: PaperCallSpec | null
  onWait?: (waitMs: number) => void
}

export type CompletePaperJsonResult = GatewayUsage & {
  raw: string
  /** null → 修复与兜底全失败，调用方按纯文本降级处理 raw */
  parsed: unknown | null
  repaired: boolean
  usedFallbackModel: boolean
}

export interface ModelGateway {
  streamPaperChat(req: StreamPaperChatRequest): Promise<StreamPaperChatResult>
  completePaperJson(req: CompletePaperJsonRequest): Promise<CompletePaperJsonResult>
}

const REPAIR_INSTRUCTION =
  '你上一条回复不是合法的 JSON 或缺少必需字段。请重新输出**同一内容**的 JSON 对象：只输出一个 JSON object，不要 markdown 围栏，不要任何解释文字。'

/** 技术性失败（计入熔断）：server / network / timeout / bad-response；auth 与 429 不算 */
const isTechnical = (e: unknown): boolean =>
  e instanceof LlmError && (e.kind === 'server' || e.kind === 'network' || e.kind === 'timeout' || e.kind === 'bad-response')

export function createModelGateway(deps: GatewayDeps): ModelGateway {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = deps.random ?? Math.random
  const rate = deps.rate ?? PAPER_RATE_LIMIT
  const circuitCfg = deps.circuit ?? PAPER_CIRCUIT

  // -------------------------------------------------------------------------
  // 客户端令牌桶（§5.5）：与生产 nginx 同参，brief 与对话共享，FIFO 排队而非撞 429
  // -------------------------------------------------------------------------
  let tokens = rate.capacity
  let lastRefill = now()
  let queueTail: Promise<void> = Promise.resolve()

  const refill = () => {
    const add = Math.floor((now() - lastRefill) / rate.refillMs)
    if (add > 0) {
      tokens = Math.min(rate.capacity, tokens + add)
      lastRefill += add * rate.refillMs
    }
  }

  const takeToken = (onWait?: (ms: number) => void): Promise<void> => {
    const turn = queueTail.then(async () => {
      refill()
      while (tokens < 1) {
        const waitMs = Math.max(1, lastRefill + rate.refillMs - now())
        onWait?.(waitMs)
        await sleep(waitMs)
        refill()
      }
      tokens -= 1
    })
    queueTail = turn.catch(() => undefined) // 队列不因单个等待者异常而断链
    return turn
  }

  // -------------------------------------------------------------------------
  // 按 provider 熔断（内存态，§5.5：连续 3 次技术失败 → 冷却 5 分钟）
  // -------------------------------------------------------------------------
  const breakers = new Map<PaperProviderId, { fails: number; openUntil: number }>()
  const breakerOf = (p: PaperProviderId) => {
    let b = breakers.get(p)
    if (!b) {
      b = { fails: 0, openUntil: 0 }
      breakers.set(p, b)
    }
    return b
  }
  const checkBreaker = (p: PaperProviderId) => {
    const b = breakerOf(p)
    if (b.openUntil > now()) {
      const remainingMs = b.openUntil - now()
      const err = new GatewayError(
        'circuit-open',
        p,
        `${PAPER_PROVIDER_LABELS[p]} 连续失败已熔断，约 ${Math.ceil(remainingMs / 1000)} 秒后可重试`,
      )
      err.remainingMs = remainingMs
      throw err
    }
  }
  const noteFailure = (p: PaperProviderId, e: unknown) => {
    if (!isTechnical(e)) return
    const b = breakerOf(p)
    b.fails += 1
    if (b.fails >= circuitCfg.failures) {
      b.openUntil = now() + circuitCfg.cooldownMs
      b.fails = 0
    }
  }
  const noteSuccess = (p: PaperProviderId) => {
    const b = breakerOf(p)
    b.fails = 0
  }

  // -------------------------------------------------------------------------
  // 通用护栏：敏感论文 → 全禁；未授权 provider → 不发起任何请求
  // -------------------------------------------------------------------------
  async function guard(provider: PaperProviderId, sensitive: boolean | undefined) {
    if (sensitive) {
      throw new GatewayError('sensitive-blocked', provider, '这篇论文已标记为敏感：所有远程模型调用被禁用，仅可本地阅读与检索')
    }
    if (!(await deps.hasConsent(provider))) {
      throw new GatewayError(
        'no-consent',
        provider,
        `尚未授权向 ${PAPER_PROVIDER_LABELS[provider]} 发送论文内容`,
      )
    }
    checkBreaker(provider)
  }

  const record = async (draft: UsageDraft) => {
    try {
      await deps.recordUsage?.(draft)
    } catch {
      // usage 记录失败不影响主流程
    }
  }

  /**
   * 重试判定（§5.5）。返回延迟毫秒；null = 不重试。
   * - auth：不重试（配置问题）。
   * - 429：尊重 Retry-After，缺失时抖动退避。
   * - 技术失败：仅在尚未有正文 token 时重试。
   */
  const retryDelayFor = (e: unknown, textSoFar: string): number | null => {
    if (!(e instanceof LlmError)) return null
    if (e.kind === 'auth') return null
    if (e.kind === 'rate-limit') return e.retryAfterMs ?? Math.round(1200 + random() * 1800)
    if (isTechnical(e)) return textSoFar === '' ? Math.round(400 + random() * 600) : null
    return null
  }

  // -------------------------------------------------------------------------
  // 流式对话
  // -------------------------------------------------------------------------
  async function streamPaperChat(req: StreamPaperChatRequest): Promise<StreamPaperChatResult> {
    const { spec } = req
    const provider = spec.cap.provider
    await guard(provider, req.sensitive)

    const startedAt = now()
    let text = ''

    const attempt = async () => {
      await takeToken(req.onWait)
      if (req.signal?.aborted) return { text, aborted: true, usage: null, jsonFallback: false }
      return runPaperStream({
        url: spec.cap.proxyPrefix + spec.cap.chatPath,
        body: buildChatBody(spec, req.messages, true),
        signal: req.signal,
        firstByteTimeoutMs: deps.firstByteTimeoutMs,
        idleTimeoutMs: deps.idleTimeoutMs,
        onDelta: (d) => {
          text += d
          req.onDelta(d)
        },
        onReasoningTick: req.onReasoningTick,
      })
    }

    let result: Awaited<ReturnType<typeof attempt>>
    try {
      try {
        result = await attempt()
      } catch (e) {
        const delay = retryDelayFor(e, text)
        if (delay === null) throw e
        req.onRetry?.(e instanceof LlmError ? e.kind : 'error')
        await sleep(delay)
        if (req.signal?.aborted) {
          result = { text, aborted: true, usage: null, jsonFallback: false }
        } else {
          result = await attempt()
        }
      }
    } catch (e) {
      noteFailure(provider, e)
      // 失败也记 usage（半截输出按估算），供成本页与评测汇总；不含正文
      const usage = normalizeUsage(spec.cap, null, { messages: req.messages, outputText: text })
      await record({ ...usage, paperId: req.paperId, ts: now(), status: 'error', latencyMs: now() - startedAt, task: req.task })
      throw e
    }

    noteSuccess(provider)
    const usage = normalizeUsage(spec.cap, result.usage as StreamUsage | null, {
      messages: req.messages,
      outputText: result.text,
    })
    await record({
      ...usage,
      paperId: req.paperId,
      ts: now(),
      status: result.aborted ? 'aborted' : 'ok',
      latencyMs: now() - startedAt,
      task: req.task,
    })
    return { ...usage, text: result.text, aborted: result.aborted }
  }

  // -------------------------------------------------------------------------
  // 非流式 JSON（论文地图等结构任务）：修复一次 → （已授权才）Kimi → 纯文本降级
  // -------------------------------------------------------------------------
  async function callJsonOnce(
    spec: PaperCallSpec,
    messages: ChatMessage[],
    req: CompletePaperJsonRequest,
  ): Promise<{ raw: string; usage: GatewayUsage }> {
    checkBreaker(spec.cap.provider)
    await takeToken(req.onWait)
    if (req.signal?.aborted) throw new LlmError('network', '请求已取消')

    const controller = new AbortController()
    const timeoutMs = deps.jsonTimeoutMs ?? 120_000
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onExternalAbort = () => controller.abort()
    req.signal?.addEventListener('abort', onExternalAbort)

    const startedAt = now()
    try {
      const res = await fetch(spec.cap.proxyPrefix + spec.cap.chatPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildChatBody(spec, messages, false)),
        signal: controller.signal,
      })
      throwForHttpStatus(res)
      const data: unknown = await res.json()
      const raw = extractContent(data)
      if (!raw) throw new LlmError('bad-response', '返回缺少 choices[0].message.content')
      const usage = normalizeUsage(spec.cap, extractStreamUsage(data), { messages, outputText: raw })
      noteSuccess(spec.cap.provider)
      await record({ ...usage, paperId: req.paperId, ts: now(), status: 'ok', latencyMs: now() - startedAt, task: req.task })
      return { raw, usage }
    } catch (e) {
      if (e instanceof LlmError) {
        noteFailure(spec.cap.provider, e)
        const usage = normalizeUsage(spec.cap, null, { messages, outputText: '' })
        await record({ ...usage, paperId: req.paperId, ts: now(), status: 'error', latencyMs: now() - startedAt, task: req.task })
        throw e
      }
      if ((e as { name?: string }).name === 'AbortError') {
        noteFailure(spec.cap.provider, new LlmError('timeout', ''))
        throw req.signal?.aborted
          ? new LlmError('network', '请求已取消')
          : new LlmError('timeout', `请求超时（${Math.round(timeoutMs / 1000)}s）`)
      }
      noteFailure(spec.cap.provider, new LlmError('network', ''))
      throw new LlmError('network', `网络错误：${(e as Error).message}`)
    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  /** 带一次技术重试的 JSON 调用（非流式没有半截概念，429/技术失败均可重试一次） */
  async function callJsonWithRetry(spec: PaperCallSpec, messages: ChatMessage[], req: CompletePaperJsonRequest) {
    try {
      return await callJsonOnce(spec, messages, req)
    } catch (e) {
      const delay = retryDelayFor(e, '')
      if (delay === null || req.signal?.aborted) throw e
      await sleep(delay)
      return callJsonOnce(spec, messages, req)
    }
  }

  async function completePaperJson(req: CompletePaperJsonRequest): Promise<CompletePaperJsonResult> {
    const { spec } = req
    await guard(spec.cap.provider, req.sensitive)

    const validate = req.validate ?? ((raw: string) => raw as unknown)
    let totalCost = 0
    let totalIn = 0
    let totalOut = 0
    let anyEstimated = false
    const track = (u: GatewayUsage) => {
      totalCost += u.cost
      totalIn += u.inputTokens
      totalOut += u.outputTokens
      anyEstimated = anyEstimated || u.estimated
    }
    const finish = (
      last: GatewayUsage,
      raw: string,
      parsed: unknown | null,
      repaired: boolean,
      usedFallbackModel: boolean,
    ): CompletePaperJsonResult => ({
      provider: last.provider,
      model: last.model,
      inputTokens: totalIn,
      outputTokens: totalOut,
      estimated: anyEstimated,
      cost: totalCost,
      raw,
      parsed,
      repaired,
      usedFallbackModel,
    })

    // 第一次
    const first = await callJsonWithRetry(spec, req.messages, req)
    track(first.usage)
    let parsed = validate(first.raw)
    if (parsed !== null) return finish(first.usage, first.raw, parsed, false, false)

    // 同模型修复一次
    let lastRaw = first.raw
    let lastUsage = first.usage
    try {
      const repairMessages: ChatMessage[] = [
        ...req.messages,
        { role: 'assistant', content: first.raw.slice(0, 4000) },
        { role: 'user', content: REPAIR_INSTRUCTION },
      ]
      const repair = await callJsonWithRetry(spec, repairMessages, req)
      track(repair.usage)
      lastRaw = repair.raw
      lastUsage = repair.usage
      parsed = validate(repair.raw)
      if (parsed !== null) return finish(repair.usage, repair.raw, parsed, true, false)
    } catch {
      // 修复调用本身失败：继续走跨厂兜底判定
    }

    // 已授权才切 Kimi strict schema（未授权禁跨厂回退）
    if (req.kimiFallback && !req.signal?.aborted) {
      const fbProvider = req.kimiFallback.cap.provider
      if (await deps.hasConsent(fbProvider)) {
        try {
          checkBreaker(fbProvider)
          const fb = await callJsonWithRetry(req.kimiFallback, req.messages, req)
          track(fb.usage)
          lastRaw = fb.raw
          lastUsage = fb.usage
          parsed = validate(fb.raw)
          if (parsed !== null) return finish(fb.usage, fb.raw, parsed, false, true)
        } catch {
          // 兜底也失败 → 降级纯文本
        }
      }
    }

    return finish(lastUsage, lastRaw, null, true, false)
  }

  return { streamPaperChat, completePaperJson }
}
