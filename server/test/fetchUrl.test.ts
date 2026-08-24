/**
 * URL 抓取路由:鉴权、URL 校验、SSRF 拒绝、字节双闸、内容类型闸门、重定向逐跳重验、限流。
 *
 * 上游一律打本机 http.createServer,不 mock 网络层:
 * - `lookup` 注入返回一个**公网占位地址**,让 DNS 结果照常过禁区校验(校验路径不被绕过);
 * - `transport` 注入只改写"连哪个 IP/端口",内部仍复用生产的 nodeTransport,
 *   所以 Content-Length 预检、实读累计、超时、解压这些真逻辑都被真实执行。
 * 403 用例反过来:不注入 transport,让请求死在校验上,并断言 stub 一次都没被触达。
 */
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { FETCH_URL_HEADER_FINAL_URL } from '../../shared/apiRoutes.js'
import { nodeTransport, type FetchLookup, type FetchTransport } from '../src/lib/fetchRaw.js'
import { createTestApp, createUser, login, postJson, withSid, type TestCtx } from './helpers.js'

const PATH = '/api/app/fetch-url'
/** 公网占位地址:只用来通过禁区校验,真正连到哪里由 transport 决定 */
const PUBLIC_ADDR = '93.184.216.34'

interface OriginStub {
  port: number
  requests: { url: string; headers: IncomingHttpHeaders }[]
  respond(fn: (url: string, res: ServerResponse) => void): void
  close(): Promise<void>
}

async function startOrigin(): Promise<OriginStub> {
  const requests: { url: string; headers: IncomingHttpHeaders }[] = []
  let responder = (_url: string, res: ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><body>hello</body></html>')
  }
  const server: Server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers })
    req.resume()
    responder(req.url ?? '', res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    respond(fn) {
      responder = fn
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
  }
}

const origins: OriginStub[] = []
afterEach(async () => {
  for (const o of origins.splice(0)) await o.close()
})

interface FetchCtx {
  ctx: TestCtx
  sid: string
  origin: OriginStub
  post(url: unknown, headers?: Record<string, string>): Promise<Response>
}

async function setup(
  opts: { maxBytes?: number; lookup?: FetchLookup; production?: boolean } = {},
): Promise<FetchCtx> {
  const origin = await startOrigin()
  origins.push(origin)
  // 生产 transport 原样复用,只把"连哪儿"换成本机 stub
  const transport: FetchTransport = (req) =>
    nodeTransport({ ...req, address: '127.0.0.1', family: 4, port: origin.port })
  const ctx = createTestApp(undefined, {
    fetchTuning: {
      maxBytes: opts.maxBytes,
      timeoutMs: 5000,
      // production:两个注入口都不给,跑完全生产路径(真实 dns.lookup + 真实建连)
      lookup: opts.production ? undefined : (opts.lookup ?? (async () => [{ address: PUBLIC_ADDR, family: 4 }])),
      transport: opts.production ? undefined : transport,
    },
  })
  await createUser(ctx.db, 'alice', 'password-1')
  const sid = await login(ctx.app, 'alice', 'password-1')
  return {
    ctx,
    sid,
    origin,
    post: async (url, headers = {}) =>
      await ctx.app.request(PATH, postJson({ url }, { ...withSid(sid), ...headers })),
  }
}

describe('鉴权与入参校验', () => {
  it('未登录 → 401,不触达上游', async () => {
    const f = await setup()
    const res = await f.ctx.app.request(PATH, postJson({ url: 'http://origin.test/' }))
    expect(res.status).toBe(401)
    expect(f.origin.requests).toHaveLength(0)
  })

  it('畸形 URL / file: scheme / 缺字段 / 非 JSON → 400 invalid-input', async () => {
    const f = await setup()
    // 一个用例内最多发 5 个请求(令牌桶容量),scheme 矩阵的其余分支在 ssrf.test.ts 覆盖
    for (const url of ['not a url', 'file:///etc/passwd', '']) {
      const res = await f.post(url)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'invalid-input' })
    }
    const missing = await f.ctx.app.request(PATH, postJson({}, withSid(f.sid)))
    expect(missing.status).toBe(400)
    const notJson = await f.ctx.app.request(PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...withSid(f.sid) },
      body: 'x'.repeat(10),
    })
    expect(notJson.status).toBe(400)
    expect(f.origin.requests).toHaveLength(0)
  })

  it('请求体超过 4KB → 413', async () => {
    const f = await setup()
    const res = await f.ctx.app.request(
      PATH,
      postJson({ url: 'http://origin.test/', pad: 'x'.repeat(5000) }, withSid(f.sid)),
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: 'invalid-input' })
  })
})

describe('SSRF 拒绝(走真实校验路径)', () => {
  it('字面内网 IP → 403 fetch-denied,一次都不出网', async () => {
    const f = await setup()
    for (const url of [
      'http://127.0.0.1/',
      'http://10.0.0.1/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
    ]) {
      const res = await f.post(url)
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'fetch-denied' })
    }
    expect(f.origin.requests).toHaveLength(0)
  })

  it('域名解析到环回/私网 → 403(DNS 结果同样过禁区判定)', async () => {
    for (const addr of ['127.0.0.1', '10.0.0.1']) {
      const f = await setup({ lookup: async () => [{ address: addr, family: 4 }] })
      const res = await f.post('http://intranet.test/secret')
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'fetch-denied' })
      expect(f.origin.requests).toHaveLength(0)
    }
  })

  it('零注入的生产路径:localhost 经真实 DNS 解析到环回 → 403', async () => {
    const f = await setup({ production: true })
    const res = await f.post('http://localhost/admin')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'fetch-denied' })
  })

  it('多值 A 记录里只要有一个内网地址就整体拒绝', async () => {
    const f = await setup({
      lookup: async () => [
        { address: PUBLIC_ADDR, family: 4 },
        { address: '192.168.1.10', family: 4 },
      ],
    })
    const res = await f.post('http://mixed.test/')
    expect(res.status).toBe(403)
    expect(f.origin.requests).toHaveLength(0)
  })

  it('非 80/443 端口与 userinfo → 403', async () => {
    const f = await setup()
    expect((await f.post('http://origin.test:9200/')).status).toBe(403)
    expect((await f.post('http://user:pw@origin.test/')).status).toBe(403)
    expect(f.origin.requests).toHaveLength(0)
  })
})

describe('正常抓取', () => {
  it('HTML 回环:原始字节、重构 Content-Type、最终 URL 头、no-store', async () => {
    const f = await setup()
    const body = '<html><head><title>白皮书</title></head><body><p>正文</p></body></html>'
    f.origin.respond((_url, res) => {
      res.writeHead(200, {
        // 多余参数(boundary)与上游 set-cookie 都不该出现在我们的响应里
        'content-type': 'text/html; charset=UTF-8; boundary=zz',
        'set-cookie': 'sess=leak; Path=/',
        'x-powered-by': 'evil',
      })
      res.end(body)
    })
    const res = await f.post('http://origin.test/paper?a=1')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get(FETCH_URL_HEADER_FINAL_URL)).toBe('http://origin.test/paper?a=1')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('x-powered-by')).toBeNull()
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(bytes.equals(Buffer.from(body, 'utf8'))).toBe(true)
    expect(res.headers.get('content-length')).toBe(String(bytes.length))

    // 出站头最小化:固定 UA、identity 编码、不带任何凭据
    const sent = f.origin.requests[0]
    expect(sent.url).toBe('/paper?a=1')
    expect(sent.headers['user-agent']).toBe('llm-pro.cn paper-copilot/1.0 (+https://llm-pro.cn)')
    expect(sent.headers['accept-encoding']).toBe('identity')
    expect(sent.headers.cookie).toBeUndefined()
    expect(sent.headers.authorization).toBeUndefined()
  })

  it('PDF 直链原样回传', async () => {
    const f = await setup()
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 9)])
    f.origin.respond((_url, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(pdf.length) })
      res.end(pdf)
    })
    const res = await f.post('http://origin.test/a.pdf')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(Buffer.from(await res.arrayBuffer()).equals(pdf)).toBe(true)
  })

  it('上游无视 identity 仍压缩 → zlib 兜底解压', async () => {
    const f = await setup()
    const body = '<html><body>压缩正文</body></html>'
    f.origin.respond((_url, res) => {
      const gz = gzipSync(Buffer.from(body, 'utf8'))
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
      res.end(gz)
    })
    const res = await f.post('http://origin.test/gz')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(body)
  })

  it('content-type 缺失时按魔数/启发式嗅探:%PDF- → pdf,可打印且含 < → html', async () => {
    const f = await setup()
    f.origin.respond((url, res) => {
      if (url === '/pdf') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 1)]))
      } else {
        // 显式清掉 node 默认的 text/html,模拟"上游什么都不说"
        res.writeHead(200, {})
        res.end('<html><body>no content type</body></html>')
      }
    })
    const pdf = await f.post('http://origin.test/pdf')
    expect(pdf.status).toBe(200)
    expect(pdf.headers.get('content-type')).toBe('application/pdf')
    const html = await f.post('http://origin.test/html')
    expect(html.status).toBe(200)
    expect(html.headers.get('content-type')).toBe('text/html')
  })
})

describe('内容类型闸门', () => {
  it('图片等非白名单类型 → 415 unsupported-content', async () => {
    const f = await setup()
    f.origin.respond((_url, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    })
    const res = await f.post('http://origin.test/a.png')
    expect(res.status).toBe(415)
    expect(await res.json()).toMatchObject({ error: 'unsupported-content' })
  })

  it('octet-stream + 二进制字节(嗅不出来)→ 415', async () => {
    const f = await setup()
    f.origin.respond((_url, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]))
    })
    const res = await f.post('http://origin.test/a.zip')
    expect(res.status).toBe(415)
  })
})

describe('字节上限双闸', () => {
  it('Content-Length 预检:声明超限即拒,不读 body', async () => {
    const f = await setup({ maxBytes: 100 })
    const body = 'x'.repeat(500)
    f.origin.respond((_url, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(body.length) })
      res.end(body)
    })
    const res = await f.post('http://origin.test/big')
    expect(res.status).toBe(413)
    const json = (await res.json()) as { error: string; message: string }
    expect(json.error).toBe('fetch-too-large')
    expect(json.message).toContain('声明')
  })

  it('无 Content-Length(分块)时按实读累计拒绝', async () => {
    const f = await setup({ maxBytes: 100 })
    f.origin.respond((_url, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }) // 无 content-length → chunked
      res.write('y'.repeat(400))
      res.end('y'.repeat(400))
    })
    const res = await f.post('http://origin.test/chunked')
    expect(res.status).toBe(413)
    const json = (await res.json()) as { error: string; message: string }
    expect(json.error).toBe('fetch-too-large')
    expect(json.message).toBe('目标内容超过大小上限')
  })

  it('上限之内正常返回(边界不误伤)', async () => {
    const f = await setup({ maxBytes: 100 })
    f.origin.respond((_url, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('z'.repeat(100))
    })
    const res = await f.post('http://origin.test/ok')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('z'.repeat(100))
  })
})

describe('重定向', () => {
  const chainResponder =
    (hops: number) =>
    (url: string, res: ServerResponse): void => {
      const n = Number(/^\/hop(\d+)$/.exec(url)?.[1] ?? 0)
      if (n < hops) {
        res.writeHead(302, { location: `/hop${n + 1}` })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<html>final ${n}</html>`)
    }

  it('3 跳以内跟随成功,最终 URL 头反映跳转后的地址', async () => {
    const f = await setup()
    f.origin.respond(chainResponder(3))
    const res = await f.post('http://origin.test/hop0')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>final 3</html>')
    expect(res.headers.get(FETCH_URL_HEADER_FINAL_URL)).toBe('http://origin.test/hop3')
    expect(f.origin.requests.map((r) => r.url)).toEqual(['/hop0', '/hop1', '/hop2', '/hop3'])
  })

  it('第 4 跳 → 502 fetch-failed', async () => {
    const f = await setup()
    f.origin.respond(chainResponder(4))
    const res = await f.post('http://origin.test/hop0')
    expect(res.status).toBe(502)
    const json = (await res.json()) as { error: string; message: string }
    expect(json.error).toBe('fetch-failed')
    expect(json.message).toContain('重定向')
    // 第 4 跳的 302 拿到就停,不会再发第 5 个请求
    expect(f.origin.requests).toHaveLength(4)
  })

  it('中途跳到私网 → 403(每跳都重跑校验)', async () => {
    const f = await setup()
    f.origin.respond((_url, res) => {
      res.writeHead(302, { location: 'http://192.168.0.5/admin' })
      res.end()
    })
    const res = await f.post('http://origin.test/start')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'fetch-denied' })
    expect(f.origin.requests).toHaveLength(1)
  })

  it('中途跳到解析进内网的域名 → 403', async () => {
    let calls = 0
    const f = await setup({
      // 第一跳公网、第二跳(重定向目标)解析到内网:典型的重定向 rebinding
      lookup: async () => {
        calls += 1
        return calls === 1
          ? [{ address: PUBLIC_ADDR, family: 4 }]
          : [{ address: '10.1.2.3', family: 4 }]
      },
    })
    f.origin.respond((_url, res) => {
      res.writeHead(301, { location: 'http://intranet.test/admin' })
      res.end()
    })
    const res = await f.post('http://origin.test/start')
    expect(res.status).toBe(403)
    expect(f.origin.requests).toHaveLength(1)
  })

  it('跳到 file: 等非 http scheme → 403', async () => {
    const f = await setup()
    f.origin.respond((_url, res) => {
      res.writeHead(302, { location: 'file:///etc/passwd' })
      res.end()
    })
    const res = await f.post('http://origin.test/start')
    expect(res.status).toBe(403)
  })
})

describe('上游异常', () => {
  it('上游 4xx/5xx → 502 fetch-failed,message 带上游状态', async () => {
    for (const status of [403, 404, 500]) {
      const f = await setup()
      f.origin.respond((_url, res) => {
        res.writeHead(status, { 'content-type': 'text/html' })
        res.end('<html>nope</html>')
      })
      const res = await f.post('http://origin.test/x')
      expect(res.status).toBe(502)
      const json = (await res.json()) as { error: string; message: string }
      expect(json.error).toBe('fetch-failed')
      expect(json.message).toContain(String(status))
    }
  })

  it('域名解析失败 → 502', async () => {
    const f = await setup({
      lookup: async () => {
        throw new Error('ENOTFOUND')
      },
    })
    const res = await f.post('http://nx.test/')
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: 'fetch-failed' })
  })
})

describe('限流', () => {
  it('令牌桶耗尽 → 429 + Retry-After(超限请求不进入抓取)', async () => {
    const f = await setup()
    // 用畸形 URL 消耗令牌:桶在参数校验之前扣,所以前 5 次是 400、第 6 次才是 429
    for (let i = 0; i < 5; i++) {
      expect((await f.post('not a url')).status).toBe(400)
    }
    const limited = await f.post('not a url')
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: 'rate-limited' })
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('并发名额在每条出口都归还:连续请求不会被闸门卡死', async () => {
    const f = await setup()
    // 400(提前 return)、200(正常)交替各来一次,再来一次仍应成功
    expect((await f.post('not a url')).status).toBe(400)
    expect((await f.post('http://origin.test/a')).status).toBe(200)
    expect((await f.post('http://origin.test/b')).status).toBe(200)
  })
})
