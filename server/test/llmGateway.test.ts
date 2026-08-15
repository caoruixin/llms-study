/**
 * LLM 网关(P2):鉴权、allowlist、key 注入与多 key 故障转移、SSE 透传、限流、审计日志。
 * 上游一律打本地 http stub(upstreamStub.ts),不 mock fetch。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import { createTestApp, createUser, login, postJson, withSid, type TestCtx } from './helpers.js'
import { startUpstreamStub, type UpstreamStub } from './upstreamStub.js'

const CHAT = '/api/deepseek/chat/completions'
const chatBody = (extra: Record<string, unknown> = {}) => ({
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
})

interface GatewayCtx {
  ctx: TestCtx
  stub: UpstreamStub
}

const stubs: UpstreamStub[] = []
afterEach(async () => {
  for (const s of stubs.splice(0)) await s.close()
})

async function setupGateway(opts: {
  serverKeys?: Partial<Config['serverLlmKeys']>
  adminDailyCallLimit?: number
  llmTuning?: { rateCapacity?: number; rateRefillMs?: number; maxStreams?: number }
} = {}): Promise<GatewayCtx> {
  const stub = await startUpstreamStub()
  stubs.push(stub)
  const upstream = {
    deepseek: stub.url,
    moonshot: stub.url,
    zhipu: stub.url,
    jina: stub.url,
    'openai-compat': stub.url,
  }
  const ctx = createTestApp(
    {
      llmUpstreams: upstream,
      serverLlmKeys: {
        deepseek: [],
        moonshot: [],
        zhipu: [],
        jina: [],
        'openai-compat': [],
        ...opts.serverKeys,
      },
      adminDailyCallLimit: opts.adminDailyCallLimit ?? 0,
    },
    { llmTuning: opts.llmTuning },
  )
  return { ctx, stub }
}

async function loginAdmin(ctx: TestCtx): Promise<string> {
  await createUser(ctx.db, 'boss', 'password-1', 'admin')
  return login(ctx.app, 'boss', 'password-1')
}

async function loginUserWithKey(ctx: TestCtx, key?: string): Promise<string> {
  await createUser(ctx.db, 'alice', 'password-1', 'user')
  const sid = await login(ctx.app, 'alice', 'password-1')
  if (key) {
    const res = await ctx.app.request(
      '/api/app/me/llm-keys/deepseek',
      { ...postJson({ key }, withSid(sid)), method: 'PUT' },
    )
    expect(res.status).toBe(200)
  }
  return sid
}

function callLogRows(ctx: TestCtx): { status: number | null; key_source: string; model: string | null }[] {
  return ctx.db
    .prepare('SELECT status, key_source, model FROM llm_call_log ORDER BY id')
    .all() as { status: number | null; key_source: string; model: string | null }[]
}

describe('鉴权与 allowlist', () => {
  it('未登录 → 401 unauthenticated,不触达上游', async () => {
    const { ctx, stub } = await setupGateway({ serverKeys: { deepseek: ['k1'] } })
    const res = await ctx.app.request(CHAT, postJson(chatBody()))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
    expect(stub.requests).toHaveLength(0)
  })

  it('path 不在 allowlist → 404(即使已登录)', async () => {
    const { ctx, stub } = await setupGateway({ serverKeys: { deepseek: ['k1'] } })
    const sid = await loginAdmin(ctx)
    // deepseek 的 chat 路径没有 /v1 前缀,带上就是未知 path
    const res = await ctx.app.request(
      '/api/deepseek/v1/chat/completions',
      postJson(chatBody(), withSid(sid)),
    )
    expect(res.status).toBe(404)
    expect(stub.requests).toHaveLength(0)
  })

  it('allowlist 路径的非 POST → 404', async () => {
    const { ctx } = await setupGateway({ serverKeys: { deepseek: ['k1'] } })
    const sid = await loginAdmin(ctx)
    const res = await ctx.app.request(CHAT, { method: 'GET', headers: withSid(sid) })
    expect(res.status).toBe(404)
  })

  it('jina 双端点在 allowlist 内,chat 形状的 path 不在', async () => {
    const { ctx, stub } = await setupGateway({ serverKeys: { jina: ['jk'] } })
    const sid = await loginAdmin(ctx)
    const ok = await ctx.app.request(
      '/api/jina/v1/embeddings',
      postJson({ model: 'jina-embeddings-v3', input: ['x'] }, withSid(sid)),
    )
    expect(ok.status).toBe(200)
    expect(stub.requests[0].path).toBe('/v1/embeddings')
    const bad = await ctx.app.request('/api/jina/chat/completions', postJson({}, withSid(sid)))
    expect(bad.status).toBe(404)
  })

  it('body 超过 2MB → 413', async () => {
    const { ctx, stub } = await setupGateway({ serverKeys: { deepseek: ['k1'] } })
    const sid = await loginAdmin(ctx)
    const res = await ctx.app.request(
      CHAT,
      postJson(chatBody({ padding: 'x'.repeat(2 * 1024 * 1024) }), withSid(sid)),
    )
    expect(res.status).toBe(413)
    expect(stub.requests).toHaveLength(0)
  })
})

describe('key 注入', () => {
  it('普通用户无 key → 403 + X-LLM-Deny + provider 字段', async () => {
    const { ctx, stub } = await setupGateway({ serverKeys: { deepseek: ['server-key'] } })
    const sid = await loginUserWithKey(ctx) // 不配 key
    const res = await ctx.app.request(CHAT, postJson(chatBody(), withSid(sid)))
    expect(res.status).toBe(403)
    expect(res.headers.get('x-llm-deny')).toBe('no-user-key')
    expect(await res.json()).toEqual({ error: 'no-user-key', provider: 'deepseek' })
    expect(stub.requests).toHaveLength(0)
  })

  it('普通用户注入本人 key;入站 Authorization/X-User-Key 被 strip', async () => {
    const { ctx, stub } = await setupGateway()
    const sid = await loginUserWithKey(ctx, 'sk-user-key-123')
    const res = await ctx.app.request(
      CHAT,
      postJson(chatBody(), {
        ...withSid(sid),
        authorization: 'Bearer evil-token',
        'x-user-key': 'evil-key',
      }),
    )
    expect(res.status).toBe(200)
    expect(stub.requests).toHaveLength(1)
    expect(stub.requests[0].auth).toBe('Bearer sk-user-key-123')
    expect(stub.requests[0].userKey).toBeNull()
    expect(callLogRows(ctx)).toEqual([
      { status: 200, key_source: 'user', model: 'deepseek-v4-flash' },
    ])
  })

  it('普通用户单 key 不轮换:上游 401 原样透出', async () => {
    const { ctx, stub } = await setupGateway()
    const sid = await loginUserWithKey(ctx, 'sk-bad-key-000')
    stub.respond((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }))
    })
    const res = await ctx.app.request(CHAT, postJson(chatBody(), withSid(sid)))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: { message: 'Invalid API key' } })
    expect(stub.requests).toHaveLength(1)
  })
})

describe('多 key 按序故障转移(admin 服务端 key)', () => {
  it('k1 上游 401 → 剔除并换 k2 → 客户端拿 200,日志两行', async () => {
    const { ctx, stub } = await setupGateway({ serverKeys: { deepseek: ['k1', 'k2'] } })
    const sid = await loginAdmin(ctx)
    stub.respond((req, res) => {
      if (req.auth === 'Bearer k1') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid key' }))
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, via: 'k2' }))
      }
    })
    const res = await ctx.app.request(CHAT, postJson(chatBody(), withSid(sid)))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, via: 'k2' })
    expect(stub.requests.map((r) => r.auth)).toEqual(['Bearer k1', 'Bearer k2'])
    expect(callLogRows(ctx).map((r) => r.status)).toEqual([401, 200])
    expect(callLogRows(ctx).every((r) => r.key_source === 'server')).toBe(true)

    // k1 已被进程内剔除:下一请求直接从 k2 试起
    const res2 = await ctx.app.request(CHAT, postJson(chatBody(), withSid(sid)))
    expect(res2.status).toBe(200)
    expect(stub.requests[2].auth).toBe('Bearer k2')
  })

  it('k1 上游 402(quota)→ 冷却 60s:下一请求跳过 k1', async () => {
    const { ctx, stub } = await setupGateway({ serverKeys: { deepseek: ['k1', 'k2'] } })
    const sid = await loginAdmin(ctx)
    stub.respond((req, res) => {
      if (req.auth === 'Bearer k1') {
        res.writeHead(402, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'insufficient balance' }))
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      }
    })
    const res1 = await ctx.app.request(CHAT, postJson(chatBody(), withSid(sid)))
    expect(res1.status).toBe(200)
    expect(stub.requests.map((r) => r.auth)).toEqual(['Bearer k1', 'Bearer k2'])

    const res2 = await ctx.app.request(CHAT, postJson(chatBody(), withSid(sid)))
    expect(res2.status).toBe(200)
    // 冷却期内 k1 不再被尝试
    expect(stub.requests).toHaveLength(3)
    expect(stub.requests[2].auth).toBe('Bearer k2')
  })

  it('全部 key 失败 → 透出最后一次上游错误', async () => {
    const { ctx, stub } = await setupGateway({ serverKeys: { deepseek: ['k1', 'k2'] } })
    const sid = await loginAdmin(ctx)
    stub.respond((req, res) => {
      if (req.auth === 'Bearer k1') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'k1 invalid' }))
      } else {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'k2 rate limited' }))
      }
    })
    const res = await ctx.app.request(CHAT, postJson(chatBody(), withSid(sid)))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'k2 rate limited' })
    expect(stub.requests).toHaveLength(2)
    expect(callLogRows(ctx).map((r) => r.status)).toEqual([401, 429])
  })

  it('服务端 key 列表为空时 admin 回落到本人 user key', async () => {
    const { ctx, stub } = await setupGateway()
    await createUser(ctx.db, 'boss', 'password-1', 'admin')
    const sid = await login(ctx.app, 'boss', 'password-1')
    const put = await ctx.app.request('/api/app/me/llm-keys/deepseek', {
      ...postJson({ key: 'sk-admin-own-1' }, withSid(sid)),
      method: 'PUT',
    })
    expect(put.status).toBe(200)
    const res = await ctx.app.request(CHAT, postJson(chatBody(), withSid(sid)))
    expect(res.status).toBe(200)
    expect(stub.requests[0].auth).toBe('Bearer sk-admin-own-1')
    expect(callLogRows(ctx)[0].key_source).toBe('user')
  })
})

describe('SSE 透传', () => {
  it('event-stream 逐帧透传,响应头带 X-Accel-Buffering: no', async () => {
    const { ctx, stub } = await setupGateway({ serverKeys: { deepseek: ['k1'] } })
    const sid = await loginAdmin(ctx)
    const frames = [
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: [DONE]\n\n',
    ]
    stub.respond((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // 帧间隔开写:验证网关不聚帧不缓冲,客户端能分片收到
      let i = 0
      const tick = () => {
        res.write(frames[i])
        i += 1
        if (i < frames.length) setTimeout(tick, 15)
        else res.end()
      }
      tick()
    })
    const res = await ctx.app.request(CHAT, postJson(chatBody({ stream: true }), withSid(sid)))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    expect(res.headers.get('cache-control')).toBe('no-store')

    const reader = res.body!.getReader()
    const chunks: string[] = []
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(decoder.decode(value, { stream: true }))
    }
    // 分片到达(≥2 块)且拼接后与上游逐字节一致
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.join('')).toBe(frames.join(''))
  })

  it('SSE 场景的多 key 重试:失败发生在转发首字节之前,客户端只看到成功流', async () => {
    const { ctx, stub } = await setupGateway({ serverKeys: { deepseek: ['k1', 'k2'] } })
    const sid = await loginAdmin(ctx)
    stub.respond((req, res) => {
      if (req.auth === 'Bearer k1') {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'quota' }))
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: {"ok":true}\n\ndata: [DONE]\n\n')
      }
    })
    const res = await ctx.app.request(CHAT, postJson(chatBody({ stream: true }), withSid(sid)))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('data: {"ok":true}\n\ndata: [DONE]\n\n')
    expect(stub.requests.map((r) => r.auth)).toEqual(['Bearer k1', 'Bearer k2'])
  })
})

describe('限流', () => {
  it('每用户令牌桶:容量 3,第 4 个请求 429 + Retry-After', async () => {
    const { ctx, stub } = await setupGateway({ serverKeys: { deepseek: ['k1'] } })
    const sid = await loginAdmin(ctx)
    for (let i = 0; i < 3; i++) {
      const res = await ctx.app.request(CHAT, postJson(chatBody(), withSid(sid)))
      expect(res.status).toBe(200)
    }
    const res = await ctx.app.request(CHAT, postJson(chatBody(), withSid(sid)))
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: 'rate-limited' })
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(stub.requests).toHaveLength(3)
  })

  it('每用户并发 SSE ≤ 上限;流结束后名额归还', async () => {
    const { ctx, stub } = await setupGateway({
      serverKeys: { deepseek: ['k1'] },
      // 桶容量放大,只测并发闸门;闸门上限压成 2 让测试轻量
      llmTuning: { rateCapacity: 100, maxStreams: 2 },
    })
    const sid = await loginAdmin(ctx)
    stub.respond((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: start\n\n')
      stub.hold(res) // 挂住不结束,占住并发名额
    })
    const r1 = await ctx.app.request(CHAT, postJson(chatBody({ stream: true }), withSid(sid)))
    const r2 = await ctx.app.request(CHAT, postJson(chatBody({ stream: true }), withSid(sid)))
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const r3 = await ctx.app.request(CHAT, postJson(chatBody({ stream: true }), withSid(sid)))
    expect(r3.status).toBe(429)
    expect(stub.requests).toHaveLength(2)

    // 上游收尾 + 客户端读完 → tapStream 触发 release → 名额回来
    stub.endHeld()
    await r1.text()
    await r2.text()
    const r4 = await ctx.app.request(CHAT, postJson(chatBody({ stream: true }), withSid(sid)))
    expect(r4.status).toBe(200)
    stub.endHeld()
    await r4.text()
  })

  it('ADMIN_DAILY_CALL_LIMIT 限制 admin 走服务端 key 的日调用数', async () => {
    const { ctx, stub } = await setupGateway({
      serverKeys: { deepseek: ['k1'] },
      adminDailyCallLimit: 2,
      llmTuning: { rateCapacity: 100 },
    })
    const sid = await loginAdmin(ctx)
    for (let i = 0; i < 2; i++) {
      const res = await ctx.app.request(CHAT, postJson(chatBody(), withSid(sid)))
      expect(res.status).toBe(200)
    }
    const res = await ctx.app.request(CHAT, postJson(chatBody(), withSid(sid)))
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: 'rate-limited' })
    expect(stub.requests).toHaveLength(2)
  })
})
