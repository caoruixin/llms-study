// SSE 流解析（纯函数，无 DOM 依赖，可在 node 环境单测）

export interface SseParser {
  push(chunk: string): string[]
  flush(): string[]
}

// 按「事件」而非「行」解析：空行为事件边界，同一事件的多个 data: 行以 \n 合并；
// [DONE] 哨兵原样透出，交由调用方判断；: 注释 / event: / id: / retry: 一律忽略。
export function createSseParser(): SseParser {
  let buffer = ''
  let dataLines: string[] = []

  const emit = (out: string[]) => {
    if (dataLines.length === 0) return
    out.push(dataLines.join('\n'))
    dataLines = []
  }

  const consume = (raw: string, out: string[]) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw // CRLF 容错
    if (line === '') {
      emit(out)
      return
    }
    if (line.startsWith(':')) return
    if (line.startsWith('data:')) {
      const value = line.slice(5)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value) // 仅去掉一个前导空格
    }
  }

  return {
    push(chunk) {
      const out: string[] = []
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // 尾段可能是半行，留到下个 chunk
      for (const line of lines) consume(line, out)
      return out
    },
    flush() {
      const out: string[] = []
      if (buffer !== '') {
        const rest = buffer
        buffer = ''
        consume(rest, out)
      }
      emit(out) // 末尾无空行时补发最后一个事件
      return out
    },
  }
}

// 逐层守卫读 choices[0].delta.content：首帧可能只有 role、尾部 usage 帧 choices 为空数组
export function extractStreamDelta(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const choices = (data as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (typeof first !== 'object' || first === null) return null
  const content = (first as { delta?: { content?: unknown } }).delta?.content
  return typeof content === 'string' && content.length > 0 ? content : null
}

/**
 * 逐层守卫读 choices[0].finish_reason。'length' = 被 max_tokens 截断——上游照样 200 收尾、
 * delta.content 也正常，不看这个字段就只能得到一段句子中间断掉的「完整」回答。
 * 首帧/中间帧该字段为 null，只有终帧带值；usage 帧 choices 为空数组。
 */
export function extractFinishReason(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const choices = (data as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (typeof first !== 'object' || first === null) return null
  const reason = (first as { finish_reason?: unknown }).finish_reason
  return typeof reason === 'string' && reason.length > 0 ? reason : null
}

export interface StreamUsage {
  inputTokens: number
  outputTokens: number
}

function readUsageShape(usage: unknown): StreamUsage | null {
  if (typeof usage !== 'object' || usage === null) return null
  const prompt = (usage as { prompt_tokens?: unknown }).prompt_tokens
  const completion = (usage as { completion_tokens?: unknown }).completion_tokens
  if (typeof prompt !== 'number' || typeof completion !== 'number') return null
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null
  return { inputTokens: prompt, outputTokens: completion }
}

/**
 * 流式 usage 尾帧（Phase 3 加法）。两家形状归一：
 * - DeepSeek（OpenAI stream_options 形）：choices 为空数组/缺失 + 顶层 usage；
 * - Kimi/Moonshot：末帧 choices[0] 内带 usage（finish_reason 帧）。
 * 均归一为 { inputTokens, outputTokens }；无 usage 或字段非法 → null。
 */
export function extractStreamUsage(data: unknown): StreamUsage | null {
  if (typeof data !== 'object' || data === null) return null
  const top = readUsageShape((data as { usage?: unknown }).usage)
  if (top) return top
  const choices = (data as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (typeof first !== 'object' || first === null) return null
  return readUsageShape((first as { usage?: unknown }).usage)
}

// 流中错误帧：{"error":{"message":...}} 或 {"error":"..."}
export function extractStreamError(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const error = (data as { error?: unknown }).error
  if (typeof error === 'string') return error.length > 0 ? error : null
  if (typeof error !== 'object' || error === null) return null
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.length > 0 ? message : null
}
