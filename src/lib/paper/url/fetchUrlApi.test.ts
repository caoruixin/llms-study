import { afterEach, describe, expect, it } from 'vitest'
import { ApiRequestError } from '../../auth/apiClient'
import { fetchUrlWithBusyRetry } from './fetchUrlApi'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

interface Step {
  status: number
  json?: unknown
  retryAfter?: string
}

/** 依次应答；返回每次调用收到的 init，便于断言 signal/次数 */
function script(steps: Step[]): RequestInit[] {
  const calls: RequestInit[] = []
  let i = 0
  globalThis.fetch = (async (_url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push(init)
    const step = steps[Math.min(i++, steps.length - 1)]
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: new Headers({
        'content-type': 'text/html; charset=utf-8',
        ...(step.retryAfter ? { 'Retry-After': step.retryAfter } : {}),
      }),
      json: async () => step.json ?? {},
      arrayBuffer: async () => new TextEncoder().encode('<html></html>').buffer,
    } as unknown as Response
  }) as typeof globalThis.fetch
  return calls
}

const BUSY: Step = { status: 429, json: { error: 'rate-limited', message: '已有抓取任务进行中' }, retryAfter: '5' }
const OK: Step = { status: 200 }

describe('fetchUrlWithBusyRetry', () => {
  it('首次就成功 → 不等待、只发一次', async () => {
    const calls = script([OK])
    const waits: number[] = []
    await fetchUrlWithBusyRetry('https://a.example/', {}, { sleep: async (ms) => void waits.push(ms) })
    expect(calls).toHaveLength(1)
    expect(waits).toEqual([])
  })

  it('取消后立刻再导：429「名额被占」→ 短暂等待后重试成功（等待取 Retry-After 与步长中更短的）', async () => {
    const calls = script([BUSY, BUSY, OK])
    const waits: number[] = []
    const out = await fetchUrlWithBusyRetry('https://a.example/', {}, { sleep: async (ms) => void waits.push(ms) })
    expect(out.finalUrl).toBe('https://a.example/')
    expect(calls).toHaveLength(3)
    // Retry-After 是 5000ms，步长 1500ms × 第 n 次：1500、3000
    expect(waits).toEqual([1500, 3000])
  })

  it('Retry-After 比步长还短 → 听服务端的', async () => {
    script([{ ...BUSY, retryAfter: '1' }, OK])
    const waits: number[] = []
    await fetchUrlWithBusyRetry('https://a.example/', {}, { sleep: async (ms) => void waits.push(ms) })
    expect(waits).toEqual([1000])
  })

  it('一直被占 → 试满 maxAttempts 后把最后一次的 429 原样抛出', async () => {
    const calls = script([BUSY])
    const err = await fetchUrlWithBusyRetry('https://a.example/', {}, { maxAttempts: 3, sleep: async () => {} }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiRequestError)
    expect((err as ApiRequestError).code).toBe('rate-limited')
    expect(calls).toHaveLength(3)
  })

  it('429 但没有 Retry-After、以及其它错误码 → 不重试', async () => {
    let calls = script([{ status: 429, json: { error: 'rate-limited' } }])
    await expect(fetchUrlWithBusyRetry('https://a.example/', {}, { sleep: async () => {} })).rejects.toBeInstanceOf(ApiRequestError)
    expect(calls).toHaveLength(1)

    calls = script([{ status: 502, json: { error: 'fetch-failed' }, retryAfter: '5' }])
    await expect(fetchUrlWithBusyRetry('https://a.example/', {}, { sleep: async () => {} })).rejects.toBeInstanceOf(ApiRequestError)
    expect(calls).toHaveLength(1)
  })

  it('主动取消原样抛 AbortError，不当成「忙」去重试；signal 每次都带上', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    let n = 0
    const seen: (AbortSignal | null | undefined)[] = []
    globalThis.fetch = (async (_u: RequestInfo | URL, init: RequestInit = {}) => {
      seen.push(init.signal)
      n++
      throw abort
    }) as typeof globalThis.fetch
    const controller = new AbortController()
    await expect(fetchUrlWithBusyRetry('https://a.example/', { signal: controller.signal }, { sleep: async () => {} })).rejects.toBe(abort)
    expect(n).toBe(1)
    expect(seen[0]).toBe(controller.signal)
  })
})
