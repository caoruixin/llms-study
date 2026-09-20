/**
 * 服务端渲染路由 POST /api/app/render-url:鉴权、功能开关、限流(每用户桶 + 全站闸)、URL 校验、
 * 以及经 unix socket 调渲染服务的全部结局(透传/超时/超限/错误映射/断连取消/名额归还)。
 *
 * 渲染服务用一个**真的 node:http 服务**顶替,监听在临时 unix socket 上——不 mock 网络层,
 * 路由里的 http.request({socketPath})、字节上限、超时、abort 传播都被真实执行。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RENDER_URL_RATE_CAPACITY } from '../../shared/apiRoutes.js'
import type { RenderUrlResponse } from '../../shared/apiTypes.js'
import { createTestApp, createUser, login, postJson, withSid, type TestCtx } from './helpers.js'

const PATH = '/api/app/render-url'
const TARGET = 'https://z.ai/blog/glm-built-its-inference-infrastructure'

const OK: RenderUrlResponse = {
  html: '<html><body><article>rendered</article></body></html>',
  title: 'GLM',
  finalUrl: TARGET,
  viewportWidth: 1280,
  hidden: 2,
  fixed: 1,
  blockedScripts: 0,
  agentVersion: 2,
}

interface StubRequest {
  method: string
  url: string
  body: string
  closedEarly: boolean
}

interface ServiceStub {
  socketPath: string
  requests: StubRequest[]
  /** 决定怎么回;默认回 200 + OK。不调 res.end 就是"一直不回话" */
  respond(fn: (req: StubRequest, res: ServerResponse) => void): void
  close(): Promise<void>
}

/** macOS 的 sun_path 只有 104 字节:目录名压到最短 */
function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'pcu-'))
}

async function startService(): Promise<ServiceStub> {
  const dir = tempDir()
  const socketPath = path.join(dir, 's.sock')
  const requests: StubRequest[] = []
  let responder = (_req: StubRequest, res: ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(OK))
  }
  const server: Server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const record: StubRequest = { method: req.method ?? '', url: req.url ?? '', body: '', closedEarly: false }
    requests.push(record)
    res.on('error', () => {})
    res.on('close', () => {
      if (!res.writableFinished) record.closedEarly = true
    })
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      record.body = Buffer.concat(chunks).toString('utf8')
      responder(record, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return {
    socketPath,
    requests,
    respond(fn) {
      responder = fn
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          rmSync(dir, { recursive: true, force: true })
          resolve()
        })
      })
    },
  }
}

const stubs: ServiceStub[] = []
afterEach(async () => {
  for (const s of stubs.splice(0)) await s.close()
})

interface RenderCtx {
  ctx: TestCtx
  sid: string
  service: ServiceStub
  post(url: unknown, init?: { sid?: string; signal?: AbortSignal }): Promise<Response>
  loginAs(username: string): Promise<string>
}

async function setup(
  opts: {
    /** 'off' = 不配 RENDER_SERVICE_SOCKET;'missing' = 配了但 socket 不存在 */
    socket?: 'stub' | 'off' | 'missing'
    timeoutMs?: number
    maxResponseBytes?: number
    rateCapacity?: number
  } = {},
): Promise<RenderCtx> {
  const service = await startService()
  stubs.push(service)
  const mode = opts.socket ?? 'stub'
  const renderServiceSocket =
    mode === 'off' ? null : mode === 'missing' ? path.join(path.dirname(service.socketPath), 'nope.sock') : service.socketPath
  const ctx = createTestApp(
    { renderServiceSocket },
    {
      renderTuning: {
        timeoutMs: opts.timeoutMs ?? 5000,
        maxResponseBytes: opts.maxResponseBytes,
        rateCapacity: opts.rateCapacity,
      },
    },
  )
  await createUser(ctx.db, 'alice', 'password-1')
  const sid = await login(ctx.app, 'alice', 'password-1')
  return {
    ctx,
    sid,
    service,
    post: async (url, init = {}) =>
      await ctx.app.request(PATH, { ...postJson({ url }, withSid(init.sid ?? sid)), signal: init.signal }),
    loginAs: async (username) => {
      await createUser(ctx.db, username, 'password-1')
      return await login(ctx.app, username, 'password-1')
    },
  }
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时:${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('鉴权与功能开关', () => {
  it('未登录 → 401,不触达渲染服务', async () => {
    const f = await setup()
    const res = await f.ctx.app.request(PATH, postJson({ url: TARGET }))
    expect(res.status).toBe(401)
    expect(f.service.requests).toHaveLength(0)
  })

  it('未登录且功能关闭 → 仍是 401(不向未登录者透露部署形态)', async () => {
    const f = await setup({ socket: 'off' })
    expect((await f.ctx.app.request(PATH, postJson({ url: TARGET }))).status).toBe(401)
  })

  it('没配 RENDER_SERVICE_SOCKET → 503 render-unavailable,且不扣令牌', async () => {
    const f = await setup({ socket: 'off', rateCapacity: 1 })
    for (let i = 0; i < 3; i++) {
      const res = await f.post(TARGET)
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ error: 'render-unavailable' })
    }
    expect(f.service.requests).toHaveLength(0)
  })

  it('配了但 socket 不存在(渲染服务没起/已 failed)→ 503 render-unavailable', async () => {
    const f = await setup({ socket: 'missing' })
    const res = await f.post(TARGET)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'render-unavailable' })
  })

  it('RENDER_SERVICE_SOCKET 必须是绝对路径(loadConfig fail-fast);缺省 = 关', async () => {
    const { loadConfig } = await import('../src/config.js')
    const base = { LLM_KEY_MASTER: 'ab'.repeat(32) }
    expect(loadConfig(base).renderServiceSocket).toBeNull()
    expect(loadConfig({ ...base, RENDER_SERVICE_SOCKET: '' }).renderServiceSocket).toBeNull()
    expect(
      loadConfig({ ...base, RENDER_SERVICE_SOCKET: '/run/llms-study-render/render.sock' }).renderServiceSocket,
    ).toBe('/run/llms-study-render/render.sock')
    expect(() => loadConfig({ ...base, RENDER_SERVICE_SOCKET: 'render.sock' })).toThrow(/绝对路径/)
  })
})

describe('入参与 URL 校验', () => {
  it('非 JSON / 缺字段 / 空串 / 畸形 URL / file: → 400 invalid-input,不触达渲染服务', async () => {
    const f = await setup({ rateCapacity: 10 })
    const notJson = await f.ctx.app.request(PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...withSid(f.sid) },
      body: 'x'.repeat(10),
    })
    expect(notJson.status).toBe(400)
    expect((await f.ctx.app.request(PATH, postJson({}, withSid(f.sid)))).status).toBe(400)
    for (const url of ['', 'not a url', 'file:///etc/passwd', 'chrome://settings']) {
      const res = await f.post(url)
      expect(res.status, url).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'invalid-input' })
    }
    expect(f.service.requests).toHaveLength(0)
  })

  it('body 超 4KB → 413', async () => {
    const f = await setup()
    const res = await f.post('https://example.com/' + 'a'.repeat(5000))
    expect(res.status).toBe(413)
    expect(f.service.requests).toHaveLength(0)
  })

  it('禁区 URL → 403 fetch-denied,**不触达渲染服务**', async () => {
    const f = await setup({ rateCapacity: 10 })
    for (const url of [
      'http://127.0.0.1:8787/api/app/health',
      'http://100.100.100.200/latest/meta-data/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://localhost:5173/',
      'https://user:pw@example.com/',
    ]) {
      const res = await f.post(url)
      expect(res.status, url).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'fetch-denied' })
    }
    expect(f.service.requests).toHaveLength(0)
  })
})

describe('透传', () => {
  it('成功:渲染服务的 JSON 原样回给前端,no-store;转给它的是规范化后的 URL', async () => {
    const f = await setup()
    const res = await f.post(`  ${TARGET}  `)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual(OK)

    expect(f.service.requests).toHaveLength(1)
    expect(f.service.requests[0]).toMatchObject({ method: 'POST', url: '/render' })
    expect(JSON.parse(f.service.requests[0].body)).toEqual({ url: TARGET })
  })

  it('渲染服务的响应头一个不透传', async () => {
    const f = await setup()
    f.service.respond((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'a=b', 'x-internal': '1' })
      res.end(JSON.stringify(OK))
    })
    const res = await f.post(TARGET)
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('x-internal')).toBeNull()
  })
})

describe('渲染服务的错误映射', () => {
  it('四个抓取类错误码原样转(状态码按我们自己的表给,message 带上)', async () => {
    const f = await setup({ rateCapacity: 10 })
    const cases: [number, string, number][] = [
      [400, 'invalid-input', 400],
      [403, 'fetch-denied', 403],
      [413, 'fetch-too-large', 413],
      [502, 'fetch-failed', 502],
      // 状态码与错误码对不上:以错误码为准
      [500, 'fetch-failed', 502],
    ]
    for (const [upstreamStatus, code, expected] of cases) {
      f.service.respond((_req, res) => {
        res.writeHead(upstreamStatus, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: code, message: '上游返回 404' }))
      })
      const res = await f.post(TARGET)
      expect(res.status, code).toBe(expected)
      expect(await res.json()).toEqual({ error: code, message: '上游返回 404' })
    }
  })

  it('渲染服务自己的单飞 429 → 429 rate-limited + Retry-After', async () => {
    const f = await setup()
    f.service.respond((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' })
      res.end(JSON.stringify({ error: 'rate-limited', message: '已有渲染任务进行中' }))
    })
    const res = await f.post(TARGET)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('5')
    expect(await res.json()).toMatchObject({ error: 'rate-limited' })
  })

  it('其余一切(500 internal / 它自己的 503 / 认不出的码 / 非 JSON / 超大错误体)→ 503 render-unavailable', async () => {
    const f = await setup({ rateCapacity: 10 })
    const bodies: [number, string][] = [
      [500, JSON.stringify({ error: 'internal' })],
      [503, JSON.stringify({ error: 'render-unavailable', message: '浏览器启动失败' })],
      [500, JSON.stringify({ error: 'unauthenticated' })],
      [502, '<html>bad gateway</html>'],
      [500, JSON.stringify({ error: 'fetch-failed', message: 'x'.repeat(20_000) })],
      [404, JSON.stringify({ error: 'not-found' })],
    ]
    for (const [status, body] of bodies) {
      f.service.respond((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(body)
      })
      const res = await f.post(TARGET)
      expect(res.status, body.slice(0, 40)).toBe(503)
      expect(await res.json()).toMatchObject({ error: 'render-unavailable' })
    }
  })

  it('渲染服务不回话 → API 侧超时 → 502 fetch-failed,并掐断连接让它中止渲染', async () => {
    const f = await setup({ timeoutMs: 150 })
    f.service.respond(() => {
      // 永不应答
    })
    const res = await f.post(TARGET)
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: 'fetch-failed' })
    await waitFor(() => f.service.requests[0]?.closedEarly === true, '渲染服务看到连接被掐断')
  })

  it('响应超过上限 → 413 fetch-too-large(声明超限与实读超限两条路)', async () => {
    const f = await setup({ maxResponseBytes: 2048 })
    const big = JSON.stringify({ ...OK, html: 'x'.repeat(10_000) })
    f.service.respond((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(big)) })
      res.end(big)
    })
    const declared = await f.post(TARGET)
    expect(declared.status).toBe(413)
    expect(await declared.json()).toMatchObject({ error: 'fetch-too-large' })

    // 不给 content-length(分块传输):只能靠实读累计兜住
    f.service.respond((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write(big.slice(0, 5000))
      res.end(big.slice(5000))
    })
    const streamed = await f.post(TARGET)
    expect(streamed.status).toBe(413)
  })

  it('渲染服务中途断开(崩溃 / 被 OOM 杀)→ 502 fetch-failed', async () => {
    const f = await setup()
    f.service.respond((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"html":"<p>half')
      res.destroy()
    })
    const res = await f.post(TARGET)
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: 'fetch-failed' })
  })
})

describe('限流', () => {
  // 次数跟着共享常量走:容量调过一次(3 → 5),用例不该再写死
  it('每用户令牌桶:窗口内用满容量后的下一次 → 429 + Retry-After;别的用户不受影响', async () => {
    const f = await setup()
    for (let i = 0; i < RENDER_URL_RATE_CAPACITY; i++) expect((await f.post(TARGET)).status).toBe(200)
    const over = await f.post(TARGET)
    expect(over.status).toBe(429)
    expect(await over.json()).toMatchObject({ error: 'rate-limited' })
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(f.service.requests).toHaveLength(RENDER_URL_RATE_CAPACITY)

    const bob = await f.loginAs('bob')
    expect((await f.post(TARGET, { sid: bob })).status).toBe(200)
  })

  it('畸形请求同样消耗令牌(与 fetch-url 同一语义)', async () => {
    const f = await setup()
    for (let i = 0; i < RENDER_URL_RATE_CAPACITY; i++) expect((await f.post('not a url')).status).toBe(400)
    expect((await f.post(TARGET)).status).toBe(429)
  })

  it('全站并发 1:一个用户渲染进行中,**另一个用户**立刻 429(不排队)', async () => {
    const f = await setup()
    let release: () => void = () => {}
    f.service.respond((_req, res) => {
      release = () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(OK))
      }
    })
    const bob = await f.loginAs('bob')

    const first = f.post(TARGET)
    await waitFor(() => f.service.requests.length === 1, '第一个请求抵达渲染服务')

    const started = Date.now()
    const second = await f.post(TARGET, { sid: bob })
    expect(second.status).toBe(429)
    expect(await second.json()).toMatchObject({ error: 'rate-limited' })
    expect(second.headers.get('retry-after')).toBe('10')
    expect(Date.now() - started).toBeLessThan(500)
    expect(f.service.requests).toHaveLength(1)

    release()
    expect((await first).status).toBe(200)
    // 名额归还后 bob 进得来
    f.service.respond((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(OK))
    })
    expect((await f.post(TARGET, { sid: bob })).status).toBe(200)
  })
})

describe('全站名额在每一种结局之后都归还', () => {
  it('400 / 403 / 502(超时)/ 413 / 503(服务错误)/ 502(断流)之后,下一个请求都进得来', async () => {
    const f = await setup({ timeoutMs: 150, maxResponseBytes: 2048, rateCapacity: 50 })
    const okResponder = (_req: StubRequest, res: ServerResponse): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(OK))
    }
    const expectFree = async (label: string): Promise<void> => {
      f.service.respond(okResponder)
      const res = await f.post(TARGET)
      expect(res.status, `名额未归还:${label}`).toBe(200)
    }

    expect((await f.post('not a url')).status).toBe(400)
    await expectFree('400')

    expect((await f.post('http://127.0.0.1/')).status).toBe(403)
    await expectFree('403')

    f.service.respond(() => {})
    expect((await f.post(TARGET)).status).toBe(502)
    await expectFree('超时')

    f.service.respond((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('x'.repeat(10_000))
    })
    expect((await f.post(TARGET)).status).toBe(413)
    await expectFree('413')

    f.service.respond((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal' }))
    })
    expect((await f.post(TARGET)).status).toBe(503)
    await expectFree('503')

    f.service.respond((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{')
      res.destroy()
    })
    expect((await f.post(TARGET)).status).toBe(502)
    await expectFree('断流')
  })
})

describe('客户端断开', () => {
  it('前端取消请求 → 掐断到渲染服务的连接(让它中止渲染),名额归还', async () => {
    const f = await setup()
    f.service.respond(() => {
      // 渲染中:一直不回
    })
    const controller = new AbortController()
    const pending = f.post(TARGET, { signal: controller.signal })
    await waitFor(() => f.service.requests.length === 1, '请求抵达渲染服务')
    expect(f.service.requests[0].closedEarly).toBe(false)

    controller.abort()
    await waitFor(() => f.service.requests[0].closedEarly === true, '渲染服务看到连接被掐断')
    // 这个响应没人收;只要不是挂死就行
    await pending.catch(() => {})

    f.service.respond((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(OK))
    })
    expect((await f.post(TARGET)).status).toBe(200)
  })

  it('请求一进来就已经是 aborted → 根本不连渲染服务', async () => {
    const f = await setup()
    const controller = new AbortController()
    controller.abort()
    await f.post(TARGET, { signal: controller.signal }).catch(() => {})
    expect(f.service.requests).toHaveLength(0)
    expect((await f.post(TARGET)).status).toBe(200)
  })
})
