/**
 * safeFetchHop:单跳语义(30x 原样交还、4xx/5xx 透传、禁区照拒),以及 safeFetchUrl 架在它之上后旧行为不变。
 *
 * 这里用纯内存的假 transport,而不是 fetchUrl.test.ts 那种"本机 stub + 真 nodeTransport":
 * 被测的是单跳的**裁决逻辑**——跟不跟、抛不抛、Location 怎么绝对化、transport 被叫了几次;
 * 字节闸门/超时/真实建连那层已由 fetchUrl.test.ts 经 safeFetchUrl → safeFetchHop 整条覆盖,
 * 不必再起一个上游重测。lookup 照样注入**地址**而非结论:解析结果仍走真实的禁区判定,
 * 校验路径不被绕过;拒绝类用例一律断言 transport 一次都没被叫到。
 */
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  FetchDeniedError,
  FetchFailedError,
  safeFetchHop,
  safeFetchUrl,
  type FetchLookup,
  type FetchTransport,
  type FetchTransportRequest,
  type FetchTransportResponse,
} from '../src/lib/fetchRaw.js'

/** 公网占位地址:只用来通过禁区校验,假 transport 根本不建连 */
const PUBLIC_ADDR = '93.184.216.34'
const publicLookup: FetchLookup = async () => [{ address: PUBLIC_ADDR, family: 4 }]

const reply = (
  status: number,
  headers: Record<string, string> = {},
  body: string | Buffer = '',
): FetchTransportResponse => ({
  status,
  headers,
  bytes: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
})

function fakeTransport(respond: (req: FetchTransportRequest) => FetchTransportResponse): {
  transport: FetchTransport
  calls: FetchTransportRequest[]
} {
  const calls: FetchTransportRequest[] = []
  return {
    calls,
    transport: async (req) => {
      calls.push(req)
      return respond(req)
    },
  }
}

describe('safeFetchHop:重定向原样交还,不跟随', () => {
  it('302 → kind:redirect,transport 恰好被调用一次', async () => {
    const t = fakeTransport(() => reply(302, { location: 'http://origin.test/next' }))
    const res = await safeFetchHop('http://origin.test/start', {
      transport: t.transport,
      lookup: publicLookup,
    })
    expect(res).toEqual({
      kind: 'redirect',
      status: 302,
      location: 'http://origin.test/next',
      url: 'http://origin.test/start',
    })
    expect(t.calls).toHaveLength(1)
  })

  it.each([301, 302, 303, 307, 308])('%i 都按重定向交还,状态码原样保留', async (status) => {
    const t = fakeTransport(() => reply(status, { location: '/next' }))
    const res = await safeFetchHop('http://origin.test/', { transport: t.transport, lookup: publicLookup })
    expect(res).toMatchObject({ kind: 'redirect', status })
    expect(t.calls).toHaveLength(1)
  })

  it.each([
    ['同目录相对', 'chunk.js?v=2', 'https://origin.test/a/b/chunk.js?v=2'],
    ['上级目录相对', '../mod/chunk.js', 'https://origin.test/a/mod/chunk.js'],
    ['根相对', '/login?from=%2Fa', 'https://origin.test/login?from=%2Fa'],
    // 协议相对:沿用本跳的 scheme,这正是"必须以本跳 URL 为基准"的原因
    ['协议相对', '//cdn.test/x.js', 'https://cdn.test/x.js'],
    ['已是绝对', 'http://other.test/y', 'http://other.test/y'],
  ])('相对 Location 以本跳 URL 为基准绝对化:%s', async (_name, location, expected) => {
    const t = fakeTransport(() => reply(302, { location }))
    const res = await safeFetchHop('https://origin.test/a/b/page?x=1', {
      transport: t.transport,
      lookup: publicLookup,
    })
    expect(res).toMatchObject({ kind: 'redirect', location: expected })
  })

  it('跳转目标在本跳不校验;真去请求它的那一跳才拒(防线只在"要出网"的地方)', async () => {
    const t = fakeTransport(() => reply(302, { location: 'http://192.168.0.5/admin' }))
    const first = await safeFetchHop('http://origin.test/start', {
      transport: t.transport,
      lookup: publicLookup,
    })
    expect(first).toMatchObject({ kind: 'redirect', location: 'http://192.168.0.5/admin' })
    if (first.kind !== 'redirect') throw new Error('unreachable')
    await expect(
      safeFetchHop(first.location, { transport: t.transport, lookup: publicLookup }),
    ).rejects.toBeInstanceOf(FetchDeniedError)
    expect(t.calls).toHaveLength(1)
  })

  it('302 缺 Location → FetchFailedError', async () => {
    const t = fakeTransport(() => reply(302))
    const p = safeFetchHop('http://origin.test/', { transport: t.transport, lookup: publicLookup })
    await expect(p).rejects.toBeInstanceOf(FetchFailedError)
    await expect(p).rejects.toThrow('上游返回 302 但缺少 Location')
  })

  it('Location 解析不出 URL → FetchFailedError', async () => {
    const t = fakeTransport(() => reply(302, { location: 'http://[bad' }))
    const p = safeFetchHop('http://origin.test/', { transport: t.transport, lookup: publicLookup })
    await expect(p).rejects.toBeInstanceOf(FetchFailedError)
    await expect(p).rejects.toThrow('重定向目标不是合法 URL')
  })
})

describe('safeFetchHop:非重定向状态一律作为响应透传', () => {
  it.each([403, 404, 500])('%i → kind:response,不抛', async (status) => {
    const t = fakeTransport(() =>
      reply(status, { 'content-type': 'text/html; charset=utf-8' }, '<html>nope</html>'),
    )
    const res = await safeFetchHop('http://origin.test/missing', {
      transport: t.transport,
      lookup: publicLookup,
    })
    expect(res).toEqual({
      kind: 'response',
      status,
      bytes: Buffer.from('<html>nope</html>'),
      contentType: 'text/html; charset=utf-8',
      url: 'http://origin.test/missing',
    })
  })

  it('200:仍压缩的 body 解压后交回;content-type 缺失为 null', async () => {
    const t = fakeTransport(() => reply(200, { 'content-encoding': 'gzip' }, gzipSync('export const a = 1')))
    const res = await safeFetchHop('http://origin.test/m.js', {
      transport: t.transport,
      lookup: publicLookup,
    })
    if (res.kind !== 'response') throw new Error('unreachable')
    expect(res.status).toBe(200)
    expect(res.bytes.toString('utf8')).toBe('export const a = 1')
    expect(res.contentType).toBeNull()
  })

  it('2xx 的 body 解不开 → FetchFailedError;非 2xx 解不开 → 空 body,状态照常透传', async () => {
    const broken = Buffer.from('not gzip at all')
    const ok = fakeTransport(() => reply(200, { 'content-encoding': 'gzip' }, broken))
    await expect(
      safeFetchHop('http://origin.test/', { transport: ok.transport, lookup: publicLookup }),
    ).rejects.toBeInstanceOf(FetchFailedError)

    const notFound = fakeTransport(() => reply(404, { 'content-encoding': 'gzip' }, broken))
    const res = await safeFetchHop('http://origin.test/', {
      transport: notFound.transport,
      lookup: publicLookup,
    })
    expect(res).toMatchObject({ kind: 'response', status: 404 })
    if (res.kind !== 'response') throw new Error('unreachable')
    expect(res.bytes).toHaveLength(0)
  })
})

describe('safeFetchHop:SSRF 防线与 safeFetchUrl 同一条', () => {
  it.each([
    ['环回', '127.0.0.1'],
    ['私网', '10.0.0.1'],
    ['链路本地云元数据', '169.254.169.254'],
    // 阿里云元数据地址:落在 100.64/10 CGNAT 段里,线上这台 ECS 上它是真能通的
    ['CGNAT 段云元数据', '100.100.100.200'],
    ['v4-mapped 环回', '::ffff:127.0.0.1'],
  ])('域名解析到%s(%s)→ FetchDeniedError,transport 一次都不叫', async (_name, address) => {
    const t = fakeTransport(() => reply(200))
    const p = safeFetchHop('http://intranet.test/secret', {
      transport: t.transport,
      lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
    })
    await expect(p).rejects.toBeInstanceOf(FetchDeniedError)
    expect(t.calls).toHaveLength(0)
  })

  it('多值 A 记录里只要有一个内网地址就整体拒绝', async () => {
    const t = fakeTransport(() => reply(200))
    const p = safeFetchHop('http://mixed.test/', {
      transport: t.transport,
      lookup: async () => [
        { address: PUBLIC_ADDR, family: 4 },
        { address: '192.168.1.10', family: 4 },
      ],
    })
    await expect(p).rejects.toBeInstanceOf(FetchDeniedError)
    expect(t.calls).toHaveLength(0)
  })

  it.each([
    'http://127.0.0.1/',
    'http://10.0.0.1/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.200/latest/meta-data/',
    'http://[::1]/',
    'http://[::ffff:10.0.0.1]/',
    // 十进制整数别名:URL 解析会把它归一成 127.0.0.1,照样落禁区
    'http://2130706433/',
  ])('字面禁区 IP %s → FetchDeniedError,不解析也不出网', async (url) => {
    const t = fakeTransport(() => reply(200))
    let lookups = 0
    const p = safeFetchHop(url, {
      transport: t.transport,
      lookup: async () => {
        lookups += 1
        return [{ address: PUBLIC_ADDR, family: 4 }]
      },
    })
    await expect(p).rejects.toBeInstanceOf(FetchDeniedError)
    expect(lookups).toBe(0)
    expect(t.calls).toHaveLength(0)
  })

  it.each(['file:///etc/passwd', 'http://origin.test:9200/', 'http://user:pw@origin.test/', 'not a url'])(
    '过不了 URL 白名单的 %s → FetchDeniedError',
    async (url) => {
      const t = fakeTransport(() => reply(200))
      await expect(
        safeFetchHop(url, { transport: t.transport, lookup: publicLookup }),
      ).rejects.toBeInstanceOf(FetchDeniedError)
      expect(t.calls).toHaveLength(0)
    },
  )

  it('dev 逃生阀只放宽"解析结果落禁区":字面 IP 依旧拒', async () => {
    const t = fakeTransport(() => reply(200, {}, 'ok'))
    const fakeIp: FetchLookup = async () => [{ address: '198.18.1.141', family: 4 }]
    const res = await safeFetchHop('http://origin.test/', {
      transport: t.transport,
      lookup: fakeIp,
      allowForbiddenAddresses: true,
    })
    expect(res).toMatchObject({ kind: 'response', status: 200 })
    await expect(
      safeFetchHop('http://127.0.0.1/', {
        transport: t.transport,
        lookup: fakeIp,
        allowForbiddenAddresses: true,
      }),
    ).rejects.toBeInstanceOf(FetchDeniedError)
    expect(t.calls).toHaveLength(1)
  })

  it('建连只认校验过的那个 IP;出站头最小化,accept 可覆盖而其余不可', async () => {
    const t = fakeTransport(() => reply(200, {}, 'ok'))
    await safeFetchHop('https://origin.test/app.js?v=3', {
      transport: t.transport,
      lookup: publicLookup,
      accept: '*/*',
      maxBytes: 1234,
      timeoutMs: 4321,
    })
    const sent = t.calls[0]
    expect(sent.address).toBe(PUBLIC_ADDR)
    expect(sent.family).toBe(4)
    expect(sent.port).toBe(443)
    expect(sent.url.toString()).toBe('https://origin.test/app.js?v=3')
    expect(sent.maxBytes).toBe(1234)
    expect(sent.timeoutMs).toBe(4321)
    expect(sent.headers.accept).toBe('*/*')
    expect(sent.headers['accept-encoding']).toBe('identity')
    expect(Object.keys(sent.headers).sort()).toEqual([
      'accept',
      'accept-encoding',
      'accept-language',
      'user-agent',
    ])
  })

  it('域名解析失败 / 解析为空 → FetchFailedError', async () => {
    const t = fakeTransport(() => reply(200))
    await expect(
      safeFetchHop('http://nx.test/', {
        transport: t.transport,
        lookup: async () => {
          throw new Error('ENOTFOUND')
        },
      }),
    ).rejects.toThrow('域名解析失败:ENOTFOUND')
    await expect(
      safeFetchHop('http://nx.test/', { transport: t.transport, lookup: async () => [] }),
    ).rejects.toThrow('域名无法解析')
    expect(t.calls).toHaveLength(0)
  })

  it('预算 ≤0 → 抓取超时、不出网;但 URL 本身不合法时 denied 优先', async () => {
    const t = fakeTransport(() => reply(200))
    const timedOut = safeFetchHop('http://origin.test/', {
      transport: t.transport,
      lookup: publicLookup,
      timeoutMs: 0,
    })
    await expect(timedOut).rejects.toBeInstanceOf(FetchFailedError)
    await expect(timedOut).rejects.toThrow('抓取超时')
    await expect(
      safeFetchHop('http://127.0.0.1/', { transport: t.transport, lookup: publicLookup, timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(FetchDeniedError)
    expect(t.calls).toHaveLength(0)
  })
})

describe('safeFetchUrl:架在单跳之上,旧行为不变', () => {
  /** /hopN → 302 到 /hop(N+1),直到第 hops 个才给最终响应 */
  const chain =
    (hops: number, final: FetchTransportResponse) =>
    (req: FetchTransportRequest): FetchTransportResponse => {
      const n = Number(/^\/hop(\d+)$/.exec(req.url.pathname)?.[1] ?? 0)
      return n < hops ? reply(302, { location: `/hop${n + 1}` }) : final
    }

  it('302 → 200 照常跟随,finalUrl 是跳转后的地址', async () => {
    const t = fakeTransport(chain(1, reply(200, { 'content-type': 'text/html' }, '<html>final</html>')))
    const res = await safeFetchUrl('http://origin.test/hop0', {
      transport: t.transport,
      lookup: publicLookup,
    })
    expect(res).toEqual({
      bytes: Buffer.from('<html>final</html>'),
      contentType: 'text/html',
      finalUrl: 'http://origin.test/hop1',
    })
    expect(t.calls.map((c) => c.url.pathname)).toEqual(['/hop0', '/hop1'])
  })

  it('最终 404 仍然抛 FetchFailedError,message 带上游状态', async () => {
    const t = fakeTransport(chain(1, reply(404, { 'content-type': 'text/html' }, '<html>nope</html>')))
    const p = safeFetchUrl('http://origin.test/hop0', { transport: t.transport, lookup: publicLookup })
    await expect(p).rejects.toBeInstanceOf(FetchFailedError)
    await expect(p).rejects.toThrow('上游返回 404')
  })

  it('非 2xx 的压缩体坏了也还是报上游状态,不被解压错误顶替', async () => {
    const t = fakeTransport(() => reply(404, { 'content-encoding': 'gzip' }, Buffer.from('not gzip')))
    await expect(
      safeFetchUrl('http://origin.test/', { transport: t.transport, lookup: publicLookup }),
    ).rejects.toThrow('上游返回 404')
  })

  it('maxRedirects 语义不变:第 N+1 个 302 拿到就停,不再发下一个请求', async () => {
    const t = fakeTransport(chain(99, reply(200)))
    const p = safeFetchUrl('http://origin.test/hop0', {
      transport: t.transport,
      lookup: publicLookup,
      maxRedirects: 2,
    })
    await expect(p).rejects.toBeInstanceOf(FetchFailedError)
    await expect(p).rejects.toThrow('重定向超过 2 跳')
    expect(t.calls).toHaveLength(3)
  })

  it('中途跳到私网 → FetchDeniedError(每跳都重跑校验)', async () => {
    const t = fakeTransport(() => reply(302, { location: 'http://192.168.0.5/admin' }))
    await expect(
      safeFetchUrl('http://origin.test/start', { transport: t.transport, lookup: publicLookup }),
    ).rejects.toBeInstanceOf(FetchDeniedError)
    expect(t.calls).toHaveLength(1)
  })

  it('总预算跨跳共享:后一跳拿到的是剩余量,耗尽后不再出网', async () => {
    const budgets: number[] = []
    const respond = chain(99, reply(200))
    const slow: FetchTransport = async (req) => {
      budgets.push(req.timeoutMs)
      await new Promise((r) => setTimeout(r, 40))
      return respond(req)
    }
    const p = safeFetchUrl('http://origin.test/hop0', {
      transport: slow,
      lookup: publicLookup,
      timeoutMs: 100,
      maxRedirects: 50,
    })
    await expect(p).rejects.toThrow('抓取超时')
    expect(budgets[0]).toBeLessThanOrEqual(100)
    for (let i = 1; i < budgets.length; i++) expect(budgets[i]).toBeLessThan(budgets[i - 1])
    // 100ms 预算、每跳 40ms:无论计时怎么抖,都远到不了 50 跳
    expect(budgets.length).toBeLessThan(6)
  })
})
