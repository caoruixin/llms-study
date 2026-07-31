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

// 流中错误帧：{"error":{"message":...}} 或 {"error":"..."}
export function extractStreamError(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const error = (data as { error?: unknown }).error
  if (typeof error === 'string') return error.length > 0 ? error : null
  if (typeof error !== 'object' || error === null) return null
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.length > 0 ? message : null
}
