import { LlmError, runSseChat, extractContent } from '../llmClient'
import { extractStreamDelta, extractStreamError, extractStreamUsage, type StreamUsage } from '../sse'

/**
 * Paper 专属流式（§5.2/§5.5）：在 runSseChat 传输核心上叠加 paper 需要的帧解释——
 * usage 尾帧捕获（DS/Kimi 两形归一）、reasoning_content 事件化。
 *
 * `delta.reasoning_content` 只触发 onReasoningTick（驱动「正在分析」提示）：
 * 绝不并入正文、不写日志、不落 IndexedDB。帧间空闲计时器的续期发生在 runSseChat
 * 的 read 层（每个网络 chunk 都续期），reasoning 帧天然续命，无需在此额外处理。
 */

/** 逐层守卫读 choices[0].delta.reasoning_content（paper 专用，不进共享 sse.ts） */
export function extractReasoningDelta(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const choices = (data as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (typeof first !== 'object' || first === null) return null
  const reasoning = (first as { delta?: { reasoning_content?: unknown } }).delta?.reasoning_content
  return typeof reasoning === 'string' && reasoning.length > 0 ? reasoning : null
}

export interface PaperStreamRequest {
  url: string
  headers?: Record<string, string>
  body: Record<string, unknown>
  signal?: AbortSignal
  firstByteTimeoutMs?: number
  idleTimeoutMs?: number
  onDelta: (delta: string) => void
  onReasoningTick?: () => void
}

export interface PaperStreamResult {
  text: string
  /** 外部 Abort（Stop/关闭）：半截文本已交付 */
  aborted: boolean
  /** provider 返回的 usage 尾帧；缺失为 null（上层估算并标记） */
  usage: StreamUsage | null
  jsonFallback: boolean
}

export async function runPaperStream(req: PaperStreamRequest): Promise<PaperStreamResult> {
  let text = ''
  let usage: StreamUsage | null = null

  const result = await runSseChat({
    url: req.url,
    headers: req.headers,
    body: req.body,
    signal: req.signal,
    firstByteTimeoutMs: req.firstByteTimeoutMs,
    idleTimeoutMs: req.idleTimeoutMs,
    onFrame: (data) => {
      const err = extractStreamError(data)
      if (err) throw new LlmError('server', err)
      const u = extractStreamUsage(data)
      if (u) usage = u
      const delta = extractStreamDelta(data)
      if (delta) {
        text += delta
        req.onDelta(delta)
        return
      }
      if (extractReasoningDelta(data)) req.onReasoningTick?.()
    },
    onJson: (data) => {
      const content = extractContent(data)
      if (!content) throw new LlmError('bad-response', '返回缺少 choices[0].message.content')
      text = content
      req.onDelta(content)
      const u = extractStreamUsage(data)
      if (u) usage = u
    },
  })

  if (!result.aborted && !result.jsonFallback && !text) {
    throw new LlmError('bad-response', '流式返回为空')
  }
  return { text, aborted: result.aborted, usage, jsonFallback: result.jsonFallback }
}
