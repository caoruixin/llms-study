/**
 * 网页原貌导入链路的取消约定（与 fetchUrlApi.ts 一致）：主动取消一律以 `name === 'AbortError'`
 * 的错误冒出去，调用方据此静默收尾、不当作故障上报。渲染捕获 / 资源抓取 / 快照编排三处共用，
 * 避免各写一份「DOMException 有没有」的判断。
 */

export const isAbortError = (e: unknown): boolean =>
  (e as { name?: unknown } | null)?.name === 'AbortError'

/**
 * 造一个 AbortError。优先复用 `signal.reason`（调用方 `controller.abort(reason)` 传进来的、
 * 已是 AbortError 的对象——保持同一实例，便于上层 `===` 比对）；否则按运行时挑 DOMException
 * （浏览器 / happy-dom）或普通 Error（node）。
 */
export function abortError(message: string, signal?: AbortSignal): Error {
  const reason = (signal as { reason?: unknown } | undefined)?.reason
  if (reason instanceof Error && isAbortError(reason)) return reason
  if (typeof DOMException !== 'undefined') return new DOMException(message, 'AbortError')
  const e = new Error(message)
  e.name = 'AbortError'
  return e
}

/** `signal` 已取消则立刻抛 AbortError，否则什么都不做——放在每个耗时阶段的入口 */
export function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) throw abortError(message, signal)
}
