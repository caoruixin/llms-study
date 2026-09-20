/**
 * 渲染服务的 http 层(src/render/server.ts):真的在临时 unix socket 上监听、真的用 node:http 打它,
 * 渲染器换成假的——入参校验、错误映射、单飞、断连取消全部不需要浏览器。
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http, { type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RenderUrlResponse } from '../../shared/apiTypes.js'
import { FetchDeniedError, FetchFailedError, FetchTooLargeError } from '../src/lib/fetchRaw.js'
import { createRenderServer, listenOnSocket } from '../src/render/server.js'
import { RenderLaunchError, type Renderer } from '../src/render/types.js'

const OK: RenderUrlResponse = {
  html: '<html><body><p>rendered</p></body></html>',
  title: 'T',
  finalUrl: 'https://example.com/post',
  viewportWidth: 1280,
  hidden: 0,
  fixed: 0,
  blockedScripts: 0,
  agentVersion: 2,
}

interface Started {
  socketPath: string
  server: Server
  logs: string[]
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

/** macOS 的 sun_path 只有 104 字节:目录名压到最短 */
function tempSocketPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pcr-'))
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 's.sock')
}

async function start(renderer: Renderer, socketPath = tempSocketPath()): Promise<Started> {
  const logs: string[] = []
  const server = createRenderServer({ renderer, log: (line) => logs.push(line) })
  await listenOnSocket(server, socketPath)
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  return { socketPath, server, logs }
}

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  json: unknown
}

function call(
  socketPath: string,
  opts: { method?: string; path?: string; body?: string | Buffer; headers?: Record<string, string> } = {},
): { done: Promise<Reply>; request: http.ClientRequest } {
  const request = http.request({
    socketPath,
    method: opts.method ?? 'POST',
    path: opts.path ?? '/render',
    headers: { 'content-type': 'application/json', ...opts.headers },
    agent: false,
  })
  const done = new Promise<Reply>((resolve, reject) => {
    request.on('error', reject)
    request.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json: unknown = null
        try {
          json = JSON.parse(text)
        } catch {
          json = text
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json })
      })
    })
  })
  request.end(opts.body ?? '')
  return { done, request }
}

const render = (socketPath: string, url: unknown): Promise<Reply> =>
  call(socketPath, { body: JSON.stringify({ url }) }).done

async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时:${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('监听', () => {
  it('socket 文件权限 0660;残留的旧 socket 会被清掉重建', async () => {
    const first = await start(async () => OK)
    expect(statSync(first.socketPath).mode & 0o777).toBe(0o660)
    expect(statSync(first.socketPath).isSocket()).toBe(true)

    // 模拟上次进程被 SIGKILL:监听者没了、socket 文件还在。node 正常 close 会自己 unlink,
    // 所以用"同一路径再起一个"来验证——旧文件在的情况下第二次 listen 仍然成功
    const second = createRenderServer({ renderer: async () => OK, log: () => {} })
    await listenOnSocket(second, first.socketPath)
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          second.closeAllConnections()
          second.close(() => resolve())
        }),
    )
    expect((await call(first.socketPath, { method: 'GET', path: '/health' }).done).status).toBe(200)
  })

  it('路径上是个普通文件 → 拒绝启动,绝不删它', async () => {
    const socketPath = tempSocketPath()
    writeFileSync(socketPath, 'precious')
    const server = createRenderServer({ renderer: async () => OK, log: () => {} })
    expect(() => listenOnSocket(server, socketPath)).toThrow(/不是 socket/)
    expect(statSync(socketPath).isFile()).toBe(true)
  })
})

describe('路由', () => {
  it('GET /health → {ok:true}', async () => {
    const s = await start(async () => OK)
    const res = await call(s.socketPath, { method: 'GET', path: '/health' }).done
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true })
  })

  it('未知路径 / 方法不对 → 404 not-found', async () => {
    const s = await start(async () => OK)
    expect((await call(s.socketPath, { method: 'GET', path: '/render' }).done).status).toBe(404)
    expect((await call(s.socketPath, { method: 'POST', path: '/health' }).done).status).toBe(404)
    const res = await call(s.socketPath, { method: 'GET', path: '/nope' }).done
    expect(res.status).toBe(404)
    expect(res.json).toEqual({ error: 'not-found' })
  })
})

describe('POST /render', () => {
  it('成功:原样回渲染器的结果,no-store', async () => {
    const seen: string[] = []
    const s = await start(async (url) => {
      seen.push(url)
      return OK
    })
    const res = await render(s.socketPath, 'https://example.com/post')
    expect(res.status).toBe(200)
    expect(res.json).toEqual(OK)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(seen).toEqual(['https://example.com/post'])
  })

  it('入参:非 JSON / 缺字段 / 类型不对 / 空串 → 400 invalid-input,不触达渲染器', async () => {
    let calls = 0
    const s = await start(async () => {
      calls++
      return OK
    })
    for (const body of ['not json', '{}', JSON.stringify({ url: 42 }), JSON.stringify({ url: '' })]) {
      const res = await call(s.socketPath, { body }).done
      expect(res.status).toBe(400)
      expect(res.json).toMatchObject({ error: 'invalid-input' })
    }
    expect(calls).toBe(0)
  })

  it('body 超 4KB → 413(声明超限与实读超限两条路)', async () => {
    let calls = 0
    const s = await start(async () => {
      calls++
      return OK
    })
    const big = JSON.stringify({ url: 'https://example.com/' + 'a'.repeat(5000) })
    const declared = await call(s.socketPath, { body: big }).done
    expect(declared.status).toBe(413)
    // 分块传输:没有 content-length,只能靠实读累计兜住
    const chunked = call(s.socketPath, { headers: { 'transfer-encoding': 'chunked' }, body: big })
    expect((await chunked.done).status).toBe(413)
    expect(calls).toBe(0)
  })

  it('URL 策略拒绝在起渲染器之前:字面内网 IP / 元数据 / 非常规端口 / 带凭据 → 403;file: 等 → 400', async () => {
    let calls = 0
    const s = await start(async () => {
      calls++
      return OK
    })
    for (const url of [
      'http://127.0.0.1:8787/api/app/health',
      'http://127.0.0.1/',
      'http://100.100.100.200/latest/meta-data/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://localhost:5173/',
      'https://example.com:8443/',
      'https://user:pw@example.com/',
    ]) {
      const res = await render(s.socketPath, url)
      expect(res.status, url).toBe(403)
      expect(res.json).toMatchObject({ error: 'fetch-denied' })
    }
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'ftp://example.com/', 'not a url']) {
      const res = await render(s.socketPath, url)
      expect(res.status, url).toBe(400)
      expect(res.json).toMatchObject({ error: 'invalid-input' })
    }
    expect(calls).toBe(0)
  })

  it('渲染器错误 → 状态码/错误码映射', async () => {
    const cases: [Error, number, string][] = [
      [new FetchDeniedError('目标地址指向内网或保留地址'), 403, 'fetch-denied'],
      [new FetchTooLargeError('渲染后的页面超过大小上限'), 413, 'fetch-too-large'],
      [new FetchFailedError('渲染超时'), 502, 'fetch-failed'],
      [new RenderLaunchError('浏览器启动失败'), 503, 'render-unavailable'],
    ]
    for (const [error, status, code] of cases) {
      const s = await start(async () => {
        throw error
      })
      const res = await render(s.socketPath, 'https://example.com/')
      expect(res.status).toBe(status)
      expect(res.json).toEqual({ error: code, message: error.message })
    }
  })

  it('认不出的异常 → 500 internal,细节不出进程,日志只记类名', async () => {
    const s = await start(async () => {
      throw new TypeError('secret internal detail\n[render] forged line')
    })
    const res = await render(s.socketPath, 'https://example.com/')
    expect(res.status).toBe(500)
    expect(res.json).toEqual({ error: 'internal' })
    expect(s.logs.join('\n')).toContain('TypeError')
    expect(s.logs.join('\n')).not.toContain('secret internal detail')
  })

  it('单飞:渲染进行中再来一个 → 429 + Retry-After;渲染器 settle 后才放行下一个', async () => {
    let release: (v: RenderUrlResponse) => void = () => {}
    let calls = 0
    const s = await start(
      () =>
        new Promise<RenderUrlResponse>((resolve) => {
          calls++
          release = resolve
        }),
    )
    const first = render(s.socketPath, 'https://example.com/a')
    await waitFor(() => calls === 1, '第一个请求进入渲染器')

    const second = await render(s.socketPath, 'https://example.com/b')
    expect(second.status).toBe(429)
    expect(second.json).toMatchObject({ error: 'rate-limited' })
    expect(second.headers['retry-after']).toBe('5')
    expect(calls).toBe(1)

    release(OK)
    expect((await first).status).toBe(200)

    const third = render(s.socketPath, 'https://example.com/c')
    await waitFor(() => calls === 2, '名额归还后第三个请求进入渲染器')
    release(OK)
    expect((await third).status).toBe(200)
  })

  it('出错后名额同样归还', async () => {
    let n = 0
    const s = await start(async () => {
      if (n++ === 0) throw new FetchFailedError('渲染超时')
      return OK
    })
    expect((await render(s.socketPath, 'https://example.com/')).status).toBe(502)
    expect((await render(s.socketPath, 'https://example.com/')).status).toBe(200)
  })

  it('调用方中途断开 → 渲染器的 signal abort;名额等渲染器真正收尾后才还', async () => {
    let signalSeen: AbortSignal | null = null
    let finishCleanup: () => void = () => {}
    let invocations = 0
    const s = await start((_url, signal) => {
      invocations++
      if (invocations > 1) return Promise.resolve(OK)
      return new Promise<RenderUrlResponse>((_resolve, reject) => {
        signalSeen = signal
        // 模拟"关浏览器要花一点时间":abort 之后要等测试放行才 reject
        finishCleanup = () => reject(Object.assign(new Error('渲染已取消'), { name: 'AbortError' }))
      })
    })
    const aborted = (): boolean => (signalSeen as AbortSignal | null)?.aborted === true

    const pending = call(s.socketPath, { body: JSON.stringify({ url: 'https://example.com/' }) })
    pending.done.catch(() => {})
    await waitFor(() => signalSeen !== null, '请求进入渲染器')
    expect(aborted()).toBe(false)

    pending.request.destroy()
    await waitFor(aborted, 'signal 被 abort')

    // 浏览器还没关完:此刻仍然占着单飞名额
    expect((await render(s.socketPath, 'https://example.com/x')).status).toBe(429)
    expect(invocations).toBe(1)

    // 收尾完成 → 名额归还,下一个请求进得来
    finishCleanup()
    await new Promise((r) => setTimeout(r, 20))
    expect((await render(s.socketPath, 'https://example.com/y')).status).toBe(200)
    expect(invocations).toBe(2)
  })

  it('正常写完响应后的 close 不会误触发 abort', async () => {
    let signalSeen: AbortSignal | null = null
    const s = await start(async (_url, signal) => {
      signalSeen = signal
      return OK
    })
    expect((await render(s.socketPath, 'https://example.com/')).status).toBe(200)
    await new Promise((r) => setTimeout(r, 30))
    expect((signalSeen as AbortSignal | null)?.aborted).toBe(false)
  })
})
