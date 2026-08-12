import { afterEach, describe, expect, it } from 'vitest'
import { createModelGateway, GatewayError, type GatewayDeps, type UsageDraft } from './modelGateway'
import { buildKimiStructuredSpec, PAPER_TASKS } from '../../data/paperPolicy'
import { DONE, dsContent, dsUsageTail, errorFrame } from './fixtures/sseTranscripts'
import type { ChatMessage } from '../llmClient'

const realFetch = globalThis.fetch
const encoder = new TextEncoder()

afterEach(() => {
  globalThis.fetch = realFetch
})

const messages: ChatMessage[] = [{ role: 'user', content: '问题' }]

interface Call {
  url: string
  body: Record<string, unknown>
}

type Responder = (call: Call, index: number) => Response | Promise<Response>

const sseResponse = (frames: readonly string[]): Response =>
  ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (const f of frames) ctrl.enqueue(encoder.encode(f))
        ctrl.close()
      },
    }),
  }) as unknown as Response

const jsonResponse = (json: unknown): Response =>
  ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: null,
    json: async () => json,
  }) as unknown as Response

const statusResponse = (status: number, headers: Record<string, string> = {}): Response =>
  ({
    ok: false,
    status,
    headers: new Headers(headers),
    body: null,
  }) as unknown as Response

function stubFetch(responder: Responder): { calls: Call[] } {
  const calls: Call[] = []
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = { url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> }
    calls.push(call)
    return responder(call, calls.length - 1)
  }
  return { calls }
}

/** 虚拟时钟：sleep 立即推进时间，测试不等待真实计时器 */
function makeClock() {
  let t = 0
  const waits: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms)
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    },
    waits,
  }
}

function makeGateway(overrides: Partial<GatewayDeps> = {}) {
  const clock = makeClock()
  const usage: UsageDraft[] = []
  const deps: GatewayDeps = {
    hasConsent: () => true,
    recordUsage: (d) => {
      usage.push(d)
    },
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
    ...overrides,
  }
  return { gateway: createModelGateway(deps), clock, usage }
}

const streamReq = (_gw: ReturnType<typeof makeGateway>, extra: Record<string, unknown> = {}) => ({
  spec: PAPER_TASKS.chat,
  messages,
  paperId: 'p1',
  onDelta: () => {},
  ...extra,
})

describe('modelGateway · streamPaperChat', () => {
  it('成功路径：真实 usage、成本计算、usage 落库（不含正文）', async () => {
    stubFetch(() => sseResponse([dsContent('你好'), dsUsageTail(1000, 100), DONE]))
    const gw = makeGateway()
    const r = await gw.gateway.streamPaperChat(streamReq(gw))
    expect(r.text).toBe('你好')
    expect(r.inputTokens).toBe(1000)
    expect(r.outputTokens).toBe(100)
    expect(r.estimated).toBe(false)
    expect(r.cost).toBeCloseTo((1000 / 1e6) * 0.435 + (100 / 1e6) * 0.87, 10)
    expect(gw.usage).toHaveLength(1)
    expect(gw.usage[0].status).toBe('ok')
    expect(Object.keys(gw.usage[0])).not.toContain('text')
    expect(Object.keys(gw.usage[0])).not.toContain('messages')
  })

  it('未授权 → no-consent，不发任何请求', async () => {
    const { calls } = stubFetch(() => sseResponse([DONE]))
    const gw = makeGateway({ hasConsent: () => false })
    await expect(gw.gateway.streamPaperChat(streamReq(gw))).rejects.toBeInstanceOf(GatewayError)
    expect(calls).toHaveLength(0)
  })

  it('敏感论文 → sensitive-blocked，不发任何请求', async () => {
    const { calls } = stubFetch(() => sseResponse([DONE]))
    const gw = makeGateway()
    await expect(gw.gateway.streamPaperChat(streamReq(gw, { sensitive: true }))).rejects.toMatchObject({
      kind: 'sensitive-blocked',
    })
    expect(calls).toHaveLength(0)
  })

  it('429：尊重 Retry-After 后重试一次成功', async () => {
    const { calls } = stubFetch((_c, i) =>
      i === 0 ? statusResponse(429, { 'retry-after': '2' }) : sseResponse([dsContent('ok'), DONE]),
    )
    const gw = makeGateway()
    let retried = false
    const r = await gw.gateway.streamPaperChat(streamReq(gw, { onRetry: () => (retried = true) }))
    expect(r.text).toBe('ok')
    expect(retried).toBe(true)
    expect(calls).toHaveLength(2)
    expect(gw.clock.waits).toContain(2000) // Retry-After: 2s
  })

  it('429 无 Retry-After：抖动退避（random 注入可断言）后重试', async () => {
    const { calls } = stubFetch((_c, i) => (i === 0 ? statusResponse(429) : sseResponse([dsContent('ok'), DONE])))
    const gw = makeGateway()
    await gw.gateway.streamPaperChat(streamReq(gw))
    expect(calls).toHaveLength(2)
    expect(gw.clock.waits).toContain(1200 + 0.5 * 1800)
  })

  it('5xx 且无正文：自动重试一次', async () => {
    const { calls } = stubFetch((_c, i) => (i === 0 ? statusResponse(502) : sseResponse([dsContent('ok'), DONE])))
    const gw = makeGateway()
    const r = await gw.gateway.streamPaperChat(streamReq(gw))
    expect(r.text).toBe('ok')
    expect(calls).toHaveLength(2)
  })

  // 深度轮空流专项：DeepSeek thinking 模式下推理可耗尽整个 max_tokens 预算，
  // 正文零 token 即「流式返回为空」；同参重试必然复现（评测 11/12 实证），须降级 thinking off 重试。
  it('deep 空流：降级 thinking off 重试一次，标记 thinkingDowngraded', async () => {
    const { calls } = stubFetch((_c, i) => (i === 0 ? sseResponse([DONE]) : sseResponse([dsContent('答案'), DONE])))
    const gw = makeGateway()
    const reasons: string[] = []
    const r = await gw.gateway.streamPaperChat(
      streamReq(gw, { spec: PAPER_TASKS.deep, onRetry: (why: string) => reasons.push(why) }),
    )
    expect(r.text).toBe('答案')
    expect(r.thinkingDowngraded).toBe(true)
    expect(reasons).toEqual(['thinking-downgrade'])
    expect(calls).toHaveLength(2)
    expect(calls[0].body.thinking).toEqual({ type: 'enabled' })
    expect(calls[0].body.reasoning_effort).toBe('high')
    expect(calls[1].body.thinking).toEqual({ type: 'disabled' }) // 降级：关思考
    expect(calls[1].body.reasoning_effort).toBeUndefined()
    expect(calls[1].body.max_tokens).toBe(calls[0].body.max_tokens) // 输出预算不变
  })

  it('deep 空流两次：降级重试仍空 → 抛 bad-response，不无限重试', async () => {
    const { calls } = stubFetch(() => sseResponse([DONE]))
    const gw = makeGateway()
    await expect(gw.gateway.streamPaperChat(streamReq(gw, { spec: PAPER_TASKS.deep }))).rejects.toMatchObject({
      kind: 'bad-response',
    })
    expect(calls).toHaveLength(2)
  })

  it('chat（thinking 本就 off）空流：同参重试，不标记降级', async () => {
    const { calls } = stubFetch((_c, i) => (i === 0 ? sseResponse([DONE]) : sseResponse([dsContent('ok'), DONE])))
    const gw = makeGateway()
    const r = await gw.gateway.streamPaperChat(streamReq(gw))
    expect(r.text).toBe('ok')
    expect(r.thinkingDowngraded).toBeUndefined()
    expect(calls).toHaveLength(2)
    expect(calls[1].body.thinking).toEqual(calls[0].body.thinking)
  })

  it('流中错误但已有半截正文：不重试，半截经 onDelta 保留在调用方', async () => {
    const { calls } = stubFetch(() => sseResponse([dsContent('半截'), errorFrame('炸了')]))
    const gw = makeGateway()
    const deltas: string[] = []
    await expect(
      gw.gateway.streamPaperChat(streamReq(gw, { onDelta: (d: string) => deltas.push(d) })),
    ).rejects.toMatchObject({ kind: 'server' })
    expect(calls).toHaveLength(1) // 有正文 → 不再重试
    expect(deltas).toEqual(['半截'])
    expect(gw.usage[0].status).toBe('error') // 失败也记 usage（估算）
    expect(gw.usage[0].estimated).toBe(true)
  })

  it('auth 错误：不重试不切换', async () => {
    const { calls } = stubFetch(() => statusResponse(401))
    const gw = makeGateway()
    await expect(gw.gateway.streamPaperChat(streamReq(gw))).rejects.toMatchObject({ kind: 'auth' })
    expect(calls).toHaveLength(1)
  })

  it('熔断：连续 3 次技术失败 → 第 4 次不发请求；冷却后恢复', async () => {
    const { calls } = stubFetch((_c, i) => (i < 6 ? statusResponse(500) : sseResponse([dsContent('恢复'), DONE])))
    const gw = makeGateway()
    for (let i = 0; i < 3; i++) {
      await expect(gw.gateway.streamPaperChat(streamReq(gw))).rejects.toMatchObject({ kind: 'server' })
    }
    const before = calls.length // 3 次调用 × (1 尝试 + 1 重试) = 6
    expect(before).toBe(6)
    await expect(gw.gateway.streamPaperChat(streamReq(gw))).rejects.toMatchObject({ kind: 'circuit-open' })
    expect(calls).toHaveLength(before) // 熔断中零请求
    gw.clock.advance(5 * 60_000 + 1)
    const r = await gw.gateway.streamPaperChat(streamReq(gw))
    expect(r.text).toBe('恢复')
  })

  it('令牌桶：burst 3 后第 4 个排队 ≥10s，并向 UI 报告等待', async () => {
    stubFetch(() => sseResponse([dsContent('x'), DONE]))
    const gw = makeGateway()
    const waited: number[] = []
    for (let i = 0; i < 3; i++) await gw.gateway.streamPaperChat(streamReq(gw))
    expect(gw.clock.waits).toHaveLength(0) // burst 3 全放行
    await gw.gateway.streamPaperChat(streamReq(gw, { onWait: (ms: number) => waited.push(ms) }))
    expect(waited).toHaveLength(1)
    expect(waited[0]).toBeGreaterThanOrEqual(9000)
    expect(waited[0]).toBeLessThanOrEqual(10_000)
  })

  it('provider 无 usage 尾帧：chars/3 估算 + estimated 标记', async () => {
    stubFetch(() => sseResponse([dsContent('一二三四五六'), DONE]))
    const gw = makeGateway()
    const r = await gw.gateway.streamPaperChat(streamReq(gw))
    expect(r.estimated).toBe(true)
    expect(r.outputTokens).toBe(Math.ceil(6 / 3))
  })
})

describe('modelGateway · completePaperJson（修复阶梯）', () => {
  const goodJson = jsonResponse({
    choices: [{ message: { content: '{"v":1}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
  const badJson = jsonResponse({
    choices: [{ message: { content: '不是 JSON' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
  const validate = (raw: string): unknown | null => {
    try {
      const v: unknown = JSON.parse(raw)
      return typeof v === 'object' && v !== null ? v : null
    } catch {
      return null
    }
  }
  const jsonReq = (extra: Record<string, unknown> = {}) => ({
    spec: PAPER_TASKS.briefDigest,
    messages,
    paperId: 'p1',
    validate,
    ...extra,
  })

  it('首次合法：一次调用，不修复', async () => {
    const { calls } = stubFetch(() => goodJson)
    const gw = makeGateway()
    const r = await gw.gateway.completePaperJson(jsonReq())
    expect(r.parsed).toEqual({ v: 1 })
    expect(r.repaired).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' })
  })

  it('坏结构 → 同模型修复一次成功', async () => {
    const { calls } = stubFetch((_c, i) => (i === 0 ? badJson : goodJson))
    const gw = makeGateway()
    const r = await gw.gateway.completePaperJson(jsonReq())
    expect(r.parsed).toEqual({ v: 1 })
    expect(r.repaired).toBe(true)
    expect(calls).toHaveLength(2)
    const repairMsgs = calls[1].body.messages as { role: string; content: string }[]
    expect(repairMsgs.some((m) => m.role === 'assistant' && m.content.includes('不是 JSON'))).toBe(true)
  })

  it('修复仍坏 + 已授权 Kimi → strict schema 兜底', async () => {
    const { calls } = stubFetch((c) => (c.url.startsWith('/api/moonshot') ? goodJson : badJson))
    const gw = makeGateway()
    const r = await gw.gateway.completePaperJson(
      jsonReq({ kimiFallback: buildKimiStructuredSpec('digest', { type: 'object' }, 900) }),
    )
    expect(r.parsed).toEqual({ v: 1 })
    expect(r.usedFallbackModel).toBe(true)
    expect(calls).toHaveLength(3)
    expect(calls[2].url).toBe('/api/moonshot/v1/chat/completions')
    const rf = calls[2].body.response_format as { type: string; json_schema: { strict: boolean } }
    expect(rf.type).toBe('json_schema')
    expect(rf.json_schema.strict).toBe(true)
  })

  it('未授权 Moonshot：禁跨厂回退 → 纯文本降级（parsed null，raw 保留）', async () => {
    const { calls } = stubFetch(() => badJson)
    const gw = makeGateway({ hasConsent: (p) => p === 'deepseek' })
    const r = await gw.gateway.completePaperJson(
      jsonReq({ kimiFallback: buildKimiStructuredSpec('digest', { type: 'object' }, 900) }),
    )
    expect(r.parsed).toBeNull()
    expect(r.raw).toBe('不是 JSON')
    expect(calls.every((c) => c.url.startsWith('/api/deepseek'))).toBe(true)
    expect(calls).toHaveLength(2) // 原调用 + 修复，无第三方请求
  })

  it('成本跨调用累计（原调用 + 修复）', async () => {
    stubFetch((_c, i) => (i === 0 ? badJson : goodJson))
    const gw = makeGateway()
    const r = await gw.gateway.completePaperJson(jsonReq())
    const oneCall = (10 / 1e6) * 0.435 + (5 / 1e6) * 0.87
    expect(r.cost).toBeCloseTo(oneCall * 2, 10)
    expect(r.inputTokens).toBe(20)
  })
})
