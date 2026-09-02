import { PROVIDERS } from '../store'
import type { ProviderId } from '../store'
import { createSseParser, extractFinishReason, extractStreamDelta, extractStreamError } from './sse'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type LlmErrorKind = 'auth' | 'rate-limit' | 'timeout' | 'network' | 'bad-response' | 'server'

/** kind='auth' 的细分（加法字段）：后端网关的 401/403 语义，UI 据此分支引导 */
export type LlmAuthCode = 'unauthenticated' | 'no-user-key' | 'forbidden'

export class LlmError extends Error {
  kind: LlmErrorKind
  /** HTTP 状态码（仅 kind=server 且来自 HTTP 响应时携带；加法字段，既有调用方不读） */
  status?: number
  /** 429 响应的 Retry-After 解析结果（毫秒；加法字段，供 paper gateway 的退避策略用） */
  retryAfterMs?: number
  /** auth 细分码（加法字段）：unauthenticated=未登录，no-user-key=已登录但该 provider 未配 key */
  code?: LlmAuthCode
  constructor(kind: LlmErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

/** 思考档：'off' 显式关闭（默认），'low' / 'high' 开启并指定 reasoning_effort */
export type ThinkingLevel = 'off' | 'low' | 'high'

export interface ChatOptions {
  provider: ProviderId
  model: string
  messages: ChatMessage[]
  wantJson?: boolean
  timeoutMs?: number
  /** 思考档，默认 'off'（不依赖上游默认值，详见 applyThinkingAndLimit） */
  thinking?: ThinkingLevel
  /** 输出上限；不传则不发送该参数，由上游默认值决定 */
  maxOutputTokens?: number
}

/**
 * 按 provider 写入思考档与输出上限。参数语义照抄 src/lib/paper/providerAdapters.ts 的 buildChatBody
 * （论文陪读链路已实弹验证），但**刻意复制而非 import**：src/lib/paper/** 在 flag-off 构建里被
 * vite 插件解析成空模块（见 vite.config.ts 的 paperCopilotOffPlugin 与 src/data/paperPolicy.ts 文件头），
 * 主入口静态图一旦引用它，flag-off 产物就会拿到空模块而爆掉。
 *
 * - deepseek：思考可关。'off' → thinking:{type:'disabled'}；'low'/'high' → thinking:{type:'enabled'} + reasoning_effort。
 *   必须显式关——DeepSeek V4 两档默认思考都是开的，不发这个字段实测出现过 24.8K reasoning token /
 *   195s 才回包（直接撞穿超时）；思考长度还极不稳定，简单题百来个 token、中等题就上万。
 * - moonshot（Kimi）：思考不可关，只发 reasoning_effort，'off' 降级为 'low'；输出上限参数名是 max_completion_tokens。
 * - zhipu / openai-compat：无实测依据，一律不发思考字段（猜错参数名上游直接 400），只发 max_tokens。
 */
function applyThinkingAndLimit(
  body: Record<string, unknown>,
  provider: ProviderId,
  thinking: ThinkingLevel,
  maxOutputTokens: number | undefined,
): void {
  if (provider === 'deepseek') {
    if (thinking === 'off') {
      body.thinking = { type: 'disabled' }
    } else {
      body.thinking = { type: 'enabled' }
      body.reasoning_effort = thinking
    }
  } else if (provider === 'moonshot') {
    body.reasoning_effort = thinking === 'high' ? 'high' : 'low'
  }
  if (maxOutputTokens !== undefined) {
    body[provider === 'moonshot' ? 'max_completion_tokens' : 'max_tokens'] = maxOutputTokens
  }
}

/** Retry-After 支持秒数与 HTTP-date 两种形态；解析失败返回 undefined */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(header)
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
  return undefined
}

/**
 * HTTP 状态 → LlmError 归一化（chatComplete / runSseChat 共用）。
 * 401/403 语义来自后端网关（P2 收口后 LLM 调用一律登录态 + 服务端注入 key）：
 * kind 仍是 'auth'（既有重试/熔断判定不变），细分走加法字段 code。
 */
export function throwForHttpStatus(res: Response): void {
  if (res.status === 401) {
    const err = new LlmError('auth', '请先登录后使用 AI 功能')
    err.code = 'unauthenticated'
    throw err
  }
  if (res.status === 403) {
    // 网关约定：X-LLM-Deny: no-user-key = 已登录但该 provider 未配用户 key
    const noKey = res.headers.get('X-LLM-Deny') === 'no-user-key'
    const err = new LlmError(
      'auth',
      noKey ? '该账号尚未配置此服务商的 API key，请到设置页配置' : '访问被拒绝（403）：账号可能被停用或无权限',
    )
    err.code = noKey ? 'no-user-key' : 'forbidden'
    throw err
  }
  if (res.status === 429) {
    const err = new LlmError('rate-limit', '触发限流（429），请稍后重试')
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'))
    if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs
    throw err
  }
  if (!res.ok) {
    const err = new LlmError('server', `上游返回 ${res.status}`)
    err.status = res.status
    throw err
  }
}

// 统一 OpenAI 兼容调用：走同源 allowlist 代理转发到后端网关，key 由服务端按登录账号注入
// （admin 用站点 key，普通用户用本人托管的 key），浏览器不再携带任何 key。错误归一化为 LlmError。
export async function chatComplete(opts: ChatOptions): Promise<string> {
  const preset = PROVIDERS.find((p) => p.id === opts.provider)
  if (!preset) throw new LlmError('bad-response', `未知 provider: ${opts.provider}`)

  const controller = new AbortController()
  // 60s：思考档现在由 applyThinkingAndLimit 显式下发（默认 off），实测 P99 在 20s 内。
  // 旧的 120s 是给「思考常开、reasoning 长度不可控」留的余量，那条路已经堵死——
  // 再留 120s 只会让真正失败的请求多干等一分钟。
  const timeoutMs = opts.timeoutMs ?? 60_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: 0.2,
  }
  applyThinkingAndLimit(body, opts.provider, opts.thinking ?? 'off', opts.maxOutputTokens)
  if (opts.wantJson && preset.supportsJsonMode) {
    body.response_format = { type: 'json_object' }
  }

  try {
    const res = await fetch(preset.proxyPrefix + preset.chatPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    throwForHttpStatus(res)
    const data: unknown = await res.json()
    const content = extractContent(data)
    if (!content) throw new LlmError('bad-response', '返回缺少 choices[0].message.content')
    return content
  } catch (e) {
    if (e instanceof LlmError) throw e
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new LlmError('timeout', `请求超时（${Math.round(timeoutMs / 1000)}s）`)
    }
    throw new LlmError('network', `网络错误：${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// SSE 流式核心（Phase 3 内部抽取）：chatStream 与 paper 专属流共享同一条传输管线。
// 抽取物只搬运原 chatStream 的传输层行为，帧的业务解释（delta/error/usage）交给 onFrame。
// ---------------------------------------------------------------------------

export interface RunSseChatOptions {
  url: string
  /** 额外请求头；Content-Type: application/json 由内部固定携带 */
  headers?: Record<string, string>
  /** 请求体对象，内部 JSON.stringify */
  body: Record<string, unknown>
  signal?: AbortSignal // 外部中止（Stop / 关闭对话框都走此，语义区分在调用方）
  firstByteTimeoutMs?: number // 默认 120_000，fetch 前启动
  idleTimeoutMs?: number // 默认 30_000，首字节后帧间空闲超时，每次 read 后重置
  /**
   * 每个成功 JSON.parse 的 SSE 帧回调（[DONE] 哨兵不进来；坏 payload 静默跳过）。
   * 抛出 LlmError 会中止整个流并原样上抛——错误帧的取舍语义由调用方决定。
   */
  onFrame: (data: unknown) => void
  /** 上游忽略 stream 参数、直接返回整包 JSON 时回调（整包兜底路径） */
  onJson?: (data: unknown) => void
}

export interface RunSseChatResult {
  /** 外部 signal 中止：半截内容已经通过 onFrame 交付，调用方自行决定保留策略 */
  aborted: boolean
  /** 走了整包 JSON 兜底路径 */
  jsonFallback: boolean
}

/**
 * SSE 传输核心。保住的行为（与抽取前的 chatStream 逐条对应）：
 * 双段超时换挡（首字节 120s → 帧间 30s，每次 read 续期）、[DONE] 哨兵后主动 cancel 连接、
 * content-type 为 json 时的整包兜底、外部 Abort 不抛错正常返回（半截交回调用方）、
 * releaseLock 容错（挂起 read 时会抛，忽略）。
 */
export async function runSseChat(opts: RunSseChatOptions): Promise<RunSseChatResult> {
  const firstByteTimeoutMs = opts.firstByteTimeoutMs ?? 120_000
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000

  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = (ms: number) => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, ms)
  }
  const onExternalAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onExternalAbort)
  if (opts.signal?.aborted) controller.abort() // 已中止的 signal 不会补发 abort 事件

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

  // 返回 true 表示收到 [DONE] 哨兵
  const handle = (payload: string): boolean => {
    const text = payload.trim()
    if (text === '') return false
    if (text === '[DONE]') return true
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      return false // 坏 payload 跳过（心跳/厂商私货）
    }
    opts.onFrame(data)
    return false
  }

  arm(firstByteTimeoutMs)
  try {
    const res = await fetch(opts.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    })
    throwForHttpStatus(res)
    if (res.body === null) throw new LlmError('bad-response', '流式响应缺少 body')

    // 厂商忽略 stream 参数、直接返回整包 JSON：走非流式兜底（仍在首字节计时器保护下）
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      const data: unknown = await res.json()
      opts.onJson?.(data)
      return { aborted: false, jsonFallback: true }
    }

    reader = res.body.getReader()
    const decoder = new TextDecoder()
    const parser = createSseParser()
    let sentinel = false

    while (!sentinel) {
      const { done, value } = await reader.read()
      if (done) break
      arm(idleTimeoutMs) // 首个 chunk 后换挡，之后每帧续期
      for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
        if (handle(payload)) {
          sentinel = true
          break
        }
      }
    }

    if (sentinel) {
      await reader.cancel() // 上游发完哨兵未必主动断开，主动关连接
      return { aborted: false, jsonFallback: false }
    }
    // 自然结束：残留字节与未闭合事件走同一处理路径
    for (const payload of [...parser.push(decoder.decode()), ...parser.flush()]) {
      if (handle(payload)) break
    }
    return { aborted: false, jsonFallback: false }
  } catch (e) {
    if (e instanceof LlmError) throw e
    const aborted = (e as { name?: string }).name === 'AbortError'
    if (aborted && opts.signal?.aborted) return { aborted: true, jsonFallback: false } // 外部中止：正常返回
    if (timedOut) {
      throw new LlmError(
        'timeout',
        `流式响应超时（首字节 ${Math.round(firstByteTimeoutMs / 1000)}s / 帧间 ${Math.round(idleTimeoutMs / 1000)}s）`,
      )
    }
    throw new LlmError('network', `网络错误：${(e as Error).message}`)
  } finally {
    if (timer !== null) clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onExternalAbort)
    try {
      reader?.releaseLock()
    } catch {
      // 已有挂起的 read 时 releaseLock 会抛，忽略即可
    }
  }
}

export interface ChatStreamOptions {
  provider: ProviderId
  model: string
  messages: ChatMessage[]
  signal?: AbortSignal // 外部中止（Stop / 关闭对话框都走此，语义区分在调用方）
  firstByteTimeoutMs?: number // 默认 120_000，fetch 前启动
  idleTimeoutMs?: number // 默认 30_000，首字节后帧间空闲超时，每次 read 后重置
  /** 思考档，默认 'off'（详见 applyThinkingAndLimit；思考期间 delta.content 为空，面板会一直空白） */
  thinking?: ThinkingLevel
  /** 输出上限；不传则不发送该参数，由上游默认值决定 */
  maxOutputTokens?: number
  onDelta: (delta: string) => void
  /**
   * 上游 finish_reason === 'length'（撞 maxOutputTokens 被截断）时回调一次。
   * 截断在协议层是「正常收尾」：HTTP 200、无 error 帧、内容也不带任何标记，
   * 不显式接住这个信号，用户看到的就是一段句子中间断掉却毫无提示的回答。
   */
  onTruncated?: () => void
}

// 流式（SSE）调用，返回累计全文。签名与行为不变：传输层已抽取为 runSseChat，
// 这里只保留「delta 累计 / error 帧上抛 / 整包与空流判定」的业务薄壳。
export async function chatStream(opts: ChatStreamOptions): Promise<string> {
  const preset = PROVIDERS.find((p) => p.id === opts.provider)
  if (!preset) throw new LlmError('bad-response', `未知 provider: ${opts.provider}`)

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: 0.7,
    stream: true,
  }
  applyThinkingAndLimit(body, opts.provider, opts.thinking ?? 'off', opts.maxOutputTokens)

  let acc = ''
  const result = await runSseChat({
    url: preset.proxyPrefix + preset.chatPath,
    body,
    signal: opts.signal,
    firstByteTimeoutMs: opts.firstByteTimeoutMs,
    idleTimeoutMs: opts.idleTimeoutMs,
    onFrame: (data) => {
      const err = extractStreamError(data)
      if (err) throw new LlmError('server', err) // 无论是否已有累计都必须抛，半截内容的取舍交给调用方
      const delta = extractStreamDelta(data)
      if (delta) {
        acc += delta
        opts.onDelta(delta)
      }
      if (extractFinishReason(data) === 'length') opts.onTruncated?.()
    },
    onJson: (data) => {
      const content = extractContent(data)
      if (!content) throw new LlmError('bad-response', '返回缺少 choices[0].message.content')
      acc = content
      opts.onDelta(content)
    },
  })

  if (result.aborted || result.jsonFallback) return acc // 外部中止交回半截；整包兜底已在 onJson 校验
  if (acc) return acc
  throw new LlmError('bad-response', '流式返回为空')
}

export function extractContent(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const choices = (data as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const message = (choices[0] as { message?: { content?: unknown } }).message
  const content = message?.content
  return typeof content === 'string' && content.length > 0 ? content : null
}
