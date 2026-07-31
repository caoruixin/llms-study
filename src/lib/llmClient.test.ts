import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatStream, LlmError } from './llmClient'

const realFetch = globalThis.fetch
const encoder = new TextEncoder()

afterEach(() => {
  globalThis.fetch = realFetch
  vi.useRealTimers()
})

const base = {
  provider: 'deepseek' as const,
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user' as const, content: '你好' }],
}

const frame = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`

interface FakeStream {
  stream: ReadableStream<Uint8Array>
  send(text: string): void
  close(): void
  fail(e: unknown): void
}

// 可手动投喂的流：模拟上游按帧推送、发完 [DONE] 不断开、abort 时读取报错等场景
function makeStream(): FakeStream {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  let dead = false
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c
    },
    cancel() {
      dead = true
    },
  })
  return {
    stream,
    send: (text) => {
      if (!dead) ctrl.enqueue(encoder.encode(text))
    },
    close: () => {
      if (!dead) {
        dead = true
        ctrl.close()
      }
    },
    fail: (e) => {
      if (!dead) {
        dead = true
        ctrl.error(e)
      }
    },
  }
}

interface StubInit {
  status?: number
  contentType?: string
  body?: ReadableStream<Uint8Array> | null
  json?: unknown
  stream?: FakeStream
}

let lastUrl = ''
let lastInit: RequestInit | undefined

function stubFetch(init: StubInit) {
  const status = init.status ?? 200
  lastUrl = ''
  lastInit = undefined
  globalThis.fetch = async (input: RequestInfo | URL, ri?: RequestInit): Promise<Response> => {
    lastUrl = String(input)
    lastInit = ri
    // 真实 fetch 中止时挂起的 read 会以 AbortError 失败，这里照做
    ri?.signal?.addEventListener('abort', () => {
      init.stream?.fail(new DOMException('The operation was aborted.', 'AbortError'))
    })
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(init.contentType ? { 'content-type': init.contentType } : {}),
      body: init.body === undefined ? (init.stream?.stream ?? null) : init.body,
      json: async () => init.json,
    } as unknown as Response
  }
}

// 提前挂上 rejection 处理，避免 fake timers 推进期间出现 unhandled rejection
function settled<T>(p: Promise<T>): Promise<{ value?: T; err?: unknown }> {
  return p.then(
    (value) => ({ value }),
    (err: unknown) => ({ err }),
  )
}

function expectKind(err: unknown, kind: LlmError['kind']): LlmError {
  expect(err).toBeInstanceOf(LlmError)
  expect((err as LlmError).kind).toBe(kind)
  return err as LlmError
}

// fake timers 下只跑微任务不推进时钟，等待流式读取推进到期望状态
async function waitUntil(cond: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await vi.advanceTimersByTimeAsync(0)
  }
  throw new Error(`waitUntil 超时：${label}`)
}

describe('chatStream（流式）', () => {
  it('多帧流式：onDelta 序列正确、返回累计全文', async () => {
    const s = makeStream()
    stubFetch({ contentType: 'text/event-stream', stream: s })
    const deltas: string[] = []
    const p = chatStream({ ...base, onDelta: (d) => deltas.push(d) })
    s.send('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n') // role-only 首帧
    s.send(frame('你') + frame('好'))
    s.send('data: {"choices":[],"usage":{"total_tokens":9}}\n\n') // 空 choices 尾帧
    s.close()
    await expect(p).resolves.toBe('你好')
    expect(deltas).toEqual(['你', '好'])
  })

  it('请求体与头部：stream=true / temperature 0.7 / X-User-Key', async () => {
    const s = makeStream()
    s.send(frame('hi'))
    s.close()
    stubFetch({ contentType: 'text/event-stream', stream: s })
    await chatStream({ ...base, userKey: 'sk-test', onDelta: () => {} })
    expect(lastUrl).toBe('/api/deepseek/chat/completions')
    const sent = JSON.parse(String(lastInit?.body)) as {
      model: string
      temperature: number
      stream: boolean
      messages: unknown[]
    }
    expect(sent.stream).toBe(true)
    expect(sent.temperature).toBe(0.7)
    expect(sent.model).toBe('deepseek-v4-flash')
    expect(sent.messages).toHaveLength(1)
    expect((lastInit?.headers as Record<string, string>)['X-User-Key']).toBe('sk-test')
  })

  it('[DONE] 终止：上游不断开也能收尾', async () => {
    const s = makeStream()
    stubFetch({ contentType: 'text/event-stream', stream: s })
    const p = chatStream({ ...base, onDelta: () => {} })
    s.send(frame('你') + frame('好') + 'data: [DONE]\n\n')
    // 故意不 close：哨兵路径必须自己 cancel 掉连接
    await expect(p).resolves.toBe('你好')
  })

  it('坏 payload 跳过，不影响后续帧', async () => {
    const s = makeStream()
    stubFetch({ contentType: 'text/event-stream', stream: s })
    const p = chatStream({ ...base, onDelta: () => {} })
    s.send(': keep-alive\n\ndata: not-json\n\n' + frame('ok'))
    s.close()
    await expect(p).resolves.toBe('ok')
  })

  it('外部 abort → resolve 已累计的半截文本', async () => {
    const s = makeStream()
    stubFetch({ contentType: 'text/event-stream', stream: s })
    const ext = new AbortController()
    const deltas: string[] = []
    const p = chatStream({
      ...base,
      signal: ext.signal,
      onDelta: (d) => {
        deltas.push(d)
        ext.abort() // 收到第一帧就 Stop
      },
    })
    s.send(frame('半截'))
    await expect(p).resolves.toBe('半截')
    expect(deltas).toEqual(['半截'])
  })

  it('流中 error 帧：已有累计也必须抛 server', async () => {
    const s = makeStream()
    stubFetch({ contentType: 'text/event-stream', stream: s })
    const deltas: string[] = []
    const p = settled(chatStream({ ...base, onDelta: (d) => deltas.push(d) }))
    s.send(frame('半截'))
    s.send('data: {"error":{"message":"上游炸了"}}\n\n')
    s.close()
    const r = await p
    expect(deltas).toEqual(['半截'])
    expect(expectKind(r.err, 'server').message).toContain('上游炸了')
  })

  it('厂商忽略 stream 直接返回 JSON → 整包兜底，一次 onDelta', async () => {
    const s = makeStream()
    s.send('{"choices":[{"message":{"content":"整包回答"}}]}')
    s.close()
    stubFetch({
      contentType: 'application/json; charset=utf-8',
      stream: s,
      json: { choices: [{ message: { content: '整包回答' } }] },
    })
    const deltas: string[] = []
    await expect(chatStream({ ...base, onDelta: (d) => deltas.push(d) })).resolves.toBe('整包回答')
    expect(deltas).toEqual(['整包回答'])
  })

  it('401 → auth', async () => {
    stubFetch({ status: 401, body: null })
    const r = await settled(chatStream({ ...base, onDelta: () => {} }))
    expectKind(r.err, 'auth')
  })

  it('429 → rate-limit', async () => {
    stubFetch({ status: 429, body: null })
    const r = await settled(chatStream({ ...base, onDelta: () => {} }))
    expectKind(r.err, 'rate-limit')
  })

  it('res.body 为 null → bad-response', async () => {
    stubFetch({ contentType: 'text/event-stream', body: null })
    const r = await settled(chatStream({ ...base, onDelta: () => {} }))
    expectKind(r.err, 'bad-response')
  })

  it('流为空（无任何 delta）→ bad-response', async () => {
    const s = makeStream()
    stubFetch({ contentType: 'text/event-stream', stream: s })
    const p = settled(chatStream({ ...base, onDelta: () => {} }))
    s.close()
    const r = await p
    expect(expectKind(r.err, 'bad-response').message).toContain('流式返回为空')
  })
})

describe('chatStream 双段超时（fake timers）', () => {
  it('首字节超时 → timeout', async () => {
    vi.useFakeTimers()
    const s = makeStream()
    stubFetch({ contentType: 'text/event-stream', stream: s }) // 建连成功但一直不推送
    const p = settled(chatStream({ ...base, firstByteTimeoutMs: 1_000, idleTimeoutMs: 30_000, onDelta: () => {} }))
    await vi.advanceTimersByTimeAsync(1_100)
    expectKind((await p).err, 'timeout')
  })

  it('首帧之后换挡为帧间 idle 超时（远未到首字节上限）', async () => {
    vi.useFakeTimers()
    const s = makeStream()
    stubFetch({ contentType: 'text/event-stream', stream: s })
    const deltas: string[] = []
    const p = settled(
      chatStream({ ...base, firstByteTimeoutMs: 600_000, idleTimeoutMs: 1_000, onDelta: (d) => deltas.push(d) }),
    )
    s.send(frame('半截'))
    await waitUntil(() => deltas.length === 1, '首帧到达')
    await vi.advanceTimersByTimeAsync(1_100)
    expectKind((await p).err, 'timeout')
  })

  it('每帧续期 idle 计时器：累计时长超过 idle 也不误杀', async () => {
    vi.useFakeTimers()
    const s = makeStream()
    stubFetch({ contentType: 'text/event-stream', stream: s })
    const deltas: string[] = []
    const p = settled(
      chatStream({ ...base, firstByteTimeoutMs: 600_000, idleTimeoutMs: 1_000, onDelta: (d) => deltas.push(d) }),
    )
    for (const c of ['a', 'b', 'c']) {
      s.send(frame(c))
      await waitUntil(() => deltas[deltas.length - 1] === c, `帧 ${c} 到达`)
      await vi.advanceTimersByTimeAsync(800) // 帧间 800ms < 1000ms，续期后不应超时
    }
    s.send('data: [DONE]\n\n')
    const r = await p
    expect(r.err).toBeUndefined()
    expect(r.value).toBe('abc')
  })
})
