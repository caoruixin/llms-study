import { PROVIDERS } from '../store'
import type { ProviderId } from '../store'
import { createSseParser, extractStreamDelta, extractStreamError } from './sse'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type LlmErrorKind = 'auth' | 'rate-limit' | 'timeout' | 'network' | 'bad-response' | 'server'

export class LlmError extends Error {
  kind: LlmErrorKind
  constructor(kind: LlmErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

export interface ChatOptions {
  provider: ProviderId
  model: string
  userKey?: string
  messages: ChatMessage[]
  wantJson?: boolean
  timeoutMs?: number
}

// 统一 OpenAI 兼容调用：走同源 allowlist 代理；key 经 X-User-Key 头由代理改写为上游鉴权，
// 或代理端从 .env.local 注入（此处不传头）。错误归一化为 LlmError。
export async function chatComplete(opts: ChatOptions): Promise<string> {
  const preset = PROVIDERS.find((p) => p.id === opts.provider)
  if (!preset) throw new LlmError('bad-response', `未知 provider: ${opts.provider}`)

  const controller = new AbortController()
  // 120s：兼容 v4-pro / K3 等思考模式常开的模型（评分可能带较长 reasoning）
  const timeoutMs = opts.timeoutMs ?? 120_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: 0.2,
  }
  if (opts.wantJson && preset.supportsJsonMode) {
    body.response_format = { type: 'json_object' }
  }

  try {
    const res = await fetch(preset.proxyPrefix + preset.chatPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.userKey ? { 'X-User-Key': opts.userKey } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (res.status === 401 || res.status === 403) {
      throw new LlmError('auth', 'API key 无效或未配置（401/403）：请在设置页粘贴 key 或配置 .env.local 后重启 dev')
    }
    if (res.status === 429) throw new LlmError('rate-limit', '触发限流（429），请稍后重试')
    if (!res.ok) throw new LlmError('server', `上游返回 ${res.status}`)
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

export interface ChatStreamOptions {
  provider: ProviderId
  model: string
  userKey?: string
  messages: ChatMessage[]
  signal?: AbortSignal // 外部中止（Stop / 关闭对话框都走此，语义区分在调用方）
  firstByteTimeoutMs?: number // 默认 120_000，fetch 前启动
  idleTimeoutMs?: number // 默认 30_000，首字节后帧间空闲超时，每次 read 后重置
  onDelta: (delta: string) => void
}

// 流式（SSE）调用，返回累计全文。双段超时：首字节沿用 120s 思考模型基线，
// 收到第一个 chunk 后换挡为 30s 帧间空闲计时器（每帧续期），避免长思考被误杀又能及时发现挂死连接。
export async function chatStream(opts: ChatStreamOptions): Promise<string> {
  const preset = PROVIDERS.find((p) => p.id === opts.provider)
  if (!preset) throw new LlmError('bad-response', `未知 provider: ${opts.provider}`)

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

  let acc = ''
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
    const err = extractStreamError(data)
    if (err) throw new LlmError('server', err) // 无论是否已有累计都必须抛，半截内容的取舍交给调用方
    const delta = extractStreamDelta(data)
    if (delta) {
      acc += delta
      opts.onDelta(delta)
    }
    return false
  }

  arm(firstByteTimeoutMs)
  try {
    const res = await fetch(preset.proxyPrefix + preset.chatPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.userKey ? { 'X-User-Key': opts.userKey } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: 0.7,
        stream: true,
      }),
      signal: controller.signal,
    })
    if (res.status === 401 || res.status === 403) {
      throw new LlmError('auth', 'API key 无效或未配置（401/403）：请在设置页粘贴 key 或配置 .env.local 后重启 dev')
    }
    if (res.status === 429) throw new LlmError('rate-limit', '触发限流（429），请稍后重试')
    if (!res.ok) throw new LlmError('server', `上游返回 ${res.status}`)
    if (res.body === null) throw new LlmError('bad-response', '流式响应缺少 body')

    // 厂商忽略 stream 参数、直接返回整包 JSON：走非流式兜底（仍在首字节计时器保护下）
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      const data: unknown = await res.json()
      const content = extractContent(data)
      if (!content) throw new LlmError('bad-response', '返回缺少 choices[0].message.content')
      opts.onDelta(content)
      return content
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
      return acc
    }
    // 自然结束：残留字节与未闭合事件走同一处理路径
    for (const payload of [...parser.push(decoder.decode()), ...parser.flush()]) {
      if (handle(payload)) break
    }
    if (acc) return acc
    throw new LlmError('bad-response', '流式返回为空')
  } catch (e) {
    if (e instanceof LlmError) throw e
    const aborted = (e as { name?: string }).name === 'AbortError'
    if (aborted && opts.signal?.aborted) return acc // 外部中止：把已累计的半截文本正常交回调用方
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

export function extractContent(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const choices = (data as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const message = (choices[0] as { message?: { content?: unknown } }).message
  const content = message?.content
  return typeof content === 'string' && content.length > 0 ? content : null
}
