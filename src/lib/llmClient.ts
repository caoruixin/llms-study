import { PROVIDERS } from '../store'
import type { ProviderId } from '../store'

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

export function extractContent(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const choices = (data as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const message = (choices[0] as { message?: { content?: unknown } }).message
  const content = message?.content
  return typeof content === 'string' && content.length > 0 ? content : null
}
