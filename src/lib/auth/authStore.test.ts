import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MeResponse } from '../../../shared/apiTypes'
import { ApiRequestError } from './apiClient'
import { useAuthStore } from './authStore'

/**
 * authStore 单测（stub fetch，循 llmClient.test.ts 惯例）：
 * refresh 的 401/网络分支、requireLogin promise-gate 的 resolve/reject 行为。
 */

const realFetch = globalThis.fetch

const ME: MeResponse = {
  id: 1,
  username: 'alice',
  role: 'user',
  storageQuotaBytes: 2147483648,
  storageUsedBytes: 0,
  llmKeys: { deepseek: null, moonshot: null, zhipu: null, jina: null, 'openai-compat': null },
}

let calls: { url: string; init?: RequestInit }[] = []

function stubFetch(handler: (url: string) => { status: number; json?: unknown } | 'network') {
  calls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({ url, ...(init ? { init } : {}) })
    const r = handler(url)
    if (r === 'network') throw new TypeError('Failed to fetch')
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json,
    } as unknown as Response
  }) as typeof fetch
}

beforeEach(() => {
  useAuthStore.setState({ status: 'unknown', user: null, loginPrompt: null })
})

afterEach(() => {
  // 兜底 settle：本用例残留的 gate 不能把 pending resolver 泄漏进下一个用例
  useAuthStore.getState().dismissLoginPrompt()
  globalThis.fetch = realFetch
})

describe('refresh', () => {
  it('me 200 → authed + user', async () => {
    stubFetch(() => ({ status: 200, json: ME }))
    await useAuthStore.getState().refresh()
    expect(useAuthStore.getState().status).toBe('authed')
    expect(useAuthStore.getState().user?.username).toBe('alice')
    expect(calls[0].url).toBe('/api/app/auth/me')
  })

  it('me 401 → anon 且清空 user', async () => {
    useAuthStore.setState({ status: 'authed', user: ME })
    stubFetch(() => ({ status: 401, json: { error: 'unauthenticated' } }))
    await useAuthStore.getState().refresh()
    expect(useAuthStore.getState().status).toBe('anon')
    expect(useAuthStore.getState().user).toBeNull()
  })

  it('网络失败：unknown → anon（不阻塞首屏）；已 authed 不降级', async () => {
    stubFetch(() => 'network')
    await useAuthStore.getState().refresh()
    expect(useAuthStore.getState().status).toBe('anon')

    useAuthStore.setState({ status: 'authed', user: ME })
    await useAuthStore.getState().refresh()
    expect(useAuthStore.getState().status).toBe('authed') // 断网抖动不闪成未登录
  })
})

describe('requireLogin promise-gate', () => {
  it('已登录：立即 true，不弹窗', async () => {
    useAuthStore.setState({ status: 'authed', user: ME })
    await expect(useAuthStore.getState().requireLogin('llm')).resolves.toBe(true)
    expect(useAuthStore.getState().loginPrompt).toBeNull()
  })

  it('未登录：挂起并打开弹窗；登录成功 → resolve(true) 且弹窗关闭', async () => {
    useAuthStore.setState({ status: 'anon' })
    stubFetch(() => ({ status: 200, json: ME }))
    const gate = useAuthStore.getState().requireLogin('upload')
    expect(useAuthStore.getState().loginPrompt).toEqual({ reason: 'upload' })

    await useAuthStore.getState().login('alice', 'password-1')
    await expect(gate).resolves.toBe(true)
    expect(useAuthStore.getState().loginPrompt).toBeNull()
    expect(useAuthStore.getState().status).toBe('authed')
    expect(calls[0].url).toBe('/api/app/auth/login')
  })

  it('取消弹窗 → resolve(false)', async () => {
    useAuthStore.setState({ status: 'anon' })
    const gate = useAuthStore.getState().requireLogin('llm')
    useAuthStore.getState().dismissLoginPrompt()
    await expect(gate).resolves.toBe(false)
    expect(useAuthStore.getState().loginPrompt).toBeNull()
  })

  it('并发多个 requireLogin：共用一个弹窗（保留首个 reason），一次登录全部 resolve', async () => {
    useAuthStore.setState({ status: 'anon' })
    stubFetch(() => ({ status: 200, json: ME }))
    const g1 = useAuthStore.getState().requireLogin('upload')
    const g2 = useAuthStore.getState().requireLogin('llm')
    expect(useAuthStore.getState().loginPrompt).toEqual({ reason: 'upload' })

    await useAuthStore.getState().login('alice', 'password-1')
    await expect(g1).resolves.toBe(true)
    await expect(g2).resolves.toBe(true)
  })

  it('登录失败：login 抛 ApiRequestError，gate 保持挂起，取消后收到 false', async () => {
    useAuthStore.setState({ status: 'anon' })
    stubFetch(() => ({ status: 401, json: { error: 'invalid-credentials', message: '用户名或密码错误' } }))
    const gate = useAuthStore.getState().requireLogin('llm')

    const err = await useAuthStore
      .getState()
      .login('alice', 'wrong')
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(ApiRequestError)
    expect((err as ApiRequestError).code).toBe('invalid-credentials')
    expect(useAuthStore.getState().status).toBe('anon')
    expect(useAuthStore.getState().loginPrompt).toEqual({ reason: 'llm' }) // 弹窗留着让用户改输入

    useAuthStore.getState().dismissLoginPrompt()
    await expect(gate).resolves.toBe(false)
  })
})
