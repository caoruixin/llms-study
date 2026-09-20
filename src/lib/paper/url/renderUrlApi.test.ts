import { afterEach, describe, expect, it } from 'vitest'
import { ApiRequestError } from '../../auth/apiClient'
import { renderUrl } from './renderUrlApi'

const realFetch = globalThis.fetch

interface Call {
  url: string
  init: RequestInit
}

let calls: Call[] = []

afterEach(() => {
  globalThis.fetch = realFetch
  calls = []
})

interface StubInit {
  status?: number
  json?: unknown
  /** 让 res.json() 抛（nginx 的 HTML 404 页、被截断的响应体等） */
  brokenJson?: boolean
}

function stub(init: StubInit): void {
  const status = init.status ?? 200
  globalThis.fetch = (async (url: RequestInfo | URL, opts: RequestInit = {}) => {
    calls.push({ url: String(url), init: opts })
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => {
        if (init.brokenJson) throw new SyntaxError('Unexpected token <')
        return init.json
      },
    } as unknown as Response
  }) as typeof globalThis.fetch
}

const OK = {
  html: '<html><body><p>hello</p></body></html>',
  title: 'T',
  finalUrl: 'https://z.ai/blog/x',
  viewportWidth: 1280,
  hidden: 0,
  fixed: 0,
  blockedScripts: 0,
  agentVersion: 2,
}

async function failure(run: Promise<unknown>): Promise<ApiRequestError> {
  try {
    await run
  } catch (e) {
    expect(e).toBeInstanceOf(ApiRequestError)
    return e as ApiRequestError
  }
  throw new Error('expected renderUrl to reject')
}

describe('renderUrl', () => {
  it('POSTs {url} to /api/app/render-url with the session cookie and returns the payload', async () => {
    stub({ json: OK })
    const controller = new AbortController()
    const out = await renderUrl('https://z.ai/blog/x', { signal: controller.signal })
    expect(out).toEqual(OK)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/app/render-url')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.credentials).toBe('same-origin')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ url: 'https://z.ai/blog/x' })
    expect(calls[0].init.signal).toBe(controller.signal)
  })

  it('503 render-unavailable（部署没装渲染服务）→ render-unavailable', async () => {
    stub({ status: 503, json: { error: 'render-unavailable' } })
    const e = await failure(renderUrl('https://z.ai/blog/x'))
    expect(e.code).toBe('render-unavailable')
    expect(e.status).toBe(503)
    expect(e.message).toBe('本部署未启用')
  })

  it('404（老服务端没有这条路由，响应体也不是我们的 JSON）→ 同样归一成 render-unavailable', async () => {
    stub({ status: 404, brokenJson: true })
    const e = await failure(renderUrl('https://z.ai/blog/x'))
    expect(e.code).toBe('render-unavailable')
    expect(e.status).toBe(404)
  })

  it('其余错误码原样带出，文案走本地映射', async () => {
    stub({ status: 429, json: { error: 'rate-limited', message: 'server text' } })
    expect((await failure(renderUrl('https://a.example/'))).code).toBe('rate-limited')
    stub({ status: 403, json: { error: 'fetch-denied' } })
    expect((await failure(renderUrl('https://a.example/'))).message).toContain('不允许抓取')
    stub({ status: 502, json: { error: 'fetch-failed' } })
    expect((await failure(renderUrl('https://a.example/'))).code).toBe('fetch-failed')
  })

  it('错误响应体不是 JSON → internal，带上状态码', async () => {
    stub({ status: 500, brokenJson: true })
    const e = await failure(renderUrl('https://a.example/'))
    expect(e.code).toBe('internal')
    expect(e.message).toContain('500')
  })

  it('成功响应形状不对 → internal（不把半截数据交给原貌管线）', async () => {
    stub({ json: { title: 'no html' } })
    expect((await failure(renderUrl('https://a.example/'))).code).toBe('internal')
    stub({ brokenJson: true })
    expect((await failure(renderUrl('https://a.example/'))).code).toBe('internal')
  })

  it('网络错误 → network；主动取消原样抛 AbortError', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof globalThis.fetch
    expect((await failure(renderUrl('https://a.example/'))).code).toBe('network')

    const abort = new DOMException('aborted', 'AbortError')
    globalThis.fetch = (async () => {
      throw abort
    }) as typeof globalThis.fetch
    await expect(renderUrl('https://a.example/')).rejects.toBe(abort)
  })
})
