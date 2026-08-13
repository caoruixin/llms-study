import { afterEach, describe, expect, it } from 'vitest'
import { extractReasoningDelta, runPaperStream } from './stream'
import { LlmError } from '../llmClient'
import {
  DONE,
  dsContent,
  dsFinishWithTopUsage,
  dsHappyTranscript,
  dsReasoning,
  dsRole,
  dsUsageTail,
  errorFrame,
  kimiHappyTranscript,
  wholeJsonResponse,
} from './fixtures/sseTranscripts'

const realFetch = globalThis.fetch
const encoder = new TextEncoder()

afterEach(() => {
  globalThis.fetch = realFetch
})

function streamOf(frames: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const f of frames) ctrl.enqueue(encoder.encode(f))
      ctrl.close()
    },
  })
}

function stubSse(frames: readonly string[]): void {
  globalThis.fetch = async () =>
    ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: streamOf(frames),
    }) as unknown as Response
}

function stubJson(json: unknown): void {
  globalThis.fetch = async () =>
    ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: streamOf([]),
      json: async () => json,
    }) as unknown as Response
}

const base = { url: '/api/deepseek/chat/completions', body: { stream: true } }

describe('extractReasoningDelta', () => {
  it('reasoning_content 帧 → 文本', () => {
    expect(extractReasoningDelta({ choices: [{ delta: { reasoning_content: '思考' } }] })).toBe('思考')
  })
  it('content 帧 / role 帧 / 非法结构 → null', () => {
    expect(extractReasoningDelta({ choices: [{ delta: { content: 'hi' } }] })).toBeNull()
    expect(extractReasoningDelta({ choices: [{ delta: { role: 'assistant' } }] })).toBeNull()
    expect(extractReasoningDelta(null)).toBeNull()
    expect(extractReasoningDelta({ choices: [] })).toBeNull()
  })
})

describe('runPaperStream（DeepSeek 转录）', () => {
  it('完整转录：role-only 忽略、reasoning 只走 tick、usage 尾帧捕获、[DONE] 收尾', async () => {
    stubSse(dsHappyTranscript)
    const deltas: string[] = []
    let ticks = 0
    const r = await runPaperStream({ ...base, onDelta: (d) => deltas.push(d), onReasoningTick: () => ticks++ })
    expect(r.text).toBe('这段在讲 KV cache 的显存占用 [[cite:c1]]。')
    expect(deltas).toEqual(['这段在讲', ' KV cache', ' 的显存占用 [[cite:c1]]。'])
    expect(ticks).toBe(2)
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 45 })
    expect(r.aborted).toBe(false)
  })

  it('reasoning 文本绝不并入正文', async () => {
    stubSse([dsRole, dsReasoning('内心独白'), dsContent('正文'), DONE])
    const r = await runPaperStream({ ...base, onDelta: () => {} })
    expect(r.text).toBe('正文')
    expect(r.text).not.toContain('内心独白')
  })

  it('无 usage 尾帧 → usage null（上层估算）', async () => {
    stubSse([dsContent('hi'), DONE])
    const r = await runPaperStream({ ...base, onDelta: () => {} })
    expect(r.usage).toBeNull()
  })

  it('错误帧 → LlmError(server)，半截 delta 已交付', async () => {
    stubSse([dsContent('半截'), errorFrame('上游炸了')])
    const deltas: string[] = []
    await expect(runPaperStream({ ...base, onDelta: (d) => deltas.push(d) })).rejects.toMatchObject({
      kind: 'server',
    })
    expect(deltas).toEqual(['半截'])
  })

  it('空流 → bad-response', async () => {
    stubSse([DONE])
    await expect(runPaperStream({ ...base, onDelta: () => {} })).rejects.toMatchObject({ kind: 'bad-response' })
  })

  it('外部 abort → aborted:true + 半截保留', async () => {
    const ctrl = new AbortController()
    let sendMore: (() => void) | null = null
    globalThis.fetch = async (_i: RequestInfo | URL, ri?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode(dsContent('半截')))
          sendMore = () => c.error(new DOMException('The operation was aborted.', 'AbortError'))
          ri?.signal?.addEventListener('abort', () => sendMore?.())
        },
      })
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body,
      } as unknown as Response
    }
    const r = await runPaperStream({
      ...base,
      signal: ctrl.signal,
      onDelta: () => ctrl.abort(),
    })
    expect(r.aborted).toBe(true)
    expect(r.text).toBe('半截')
  })

  it('整包 JSON 兜底：text + usage 一并取出', async () => {
    stubJson(wholeJsonResponse)
    const deltas: string[] = []
    const r = await runPaperStream({ ...base, onDelta: (d) => deltas.push(d) })
    expect(r.jsonFallback).toBe(true)
    expect(r.text).toBe('整包回答')
    expect(deltas).toEqual(['整包回答'])
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 12 })
  })
})

describe('runPaperStream（Kimi 转录）', () => {
  it('usage 从 finish 帧内取出（Kimi 形状归一）', async () => {
    stubSse(kimiHappyTranscript)
    const r = await runPaperStream({ url: '/api/moonshot/v1/chat/completions', body: {}, onDelta: () => {} })
    expect(r.text).toBe('结论：线性增长。')
    expect(r.usage).toEqual({ inputTokens: 800, outputTokens: 30 })
  })

  it('usage 尾帧也接在 [DONE] 前的 DS 形（空 choices）', async () => {
    stubSse([dsContent('x'), dsUsageTail(9, 1), DONE])
    const r = await runPaperStream({ ...base, onDelta: () => {} })
    expect(r.usage).toEqual({ inputTokens: 9, outputTokens: 1 })
  })

  it('DS 实测形：finish 帧非空 choices + 顶层 usage（冒烟录得）', async () => {
    stubSse([dsContent('x'), dsFinishWithTopUsage(7, 5), DONE])
    const r = await runPaperStream({ ...base, onDelta: () => {} })
    expect(r.text).toBe('x')
    expect(r.usage).toEqual({ inputTokens: 7, outputTokens: 5 })
  })

  it('LlmError 是 llmClient 的类（错误归一化不分叉）', async () => {
    stubSse([errorFrame('boom')])
    try {
      await runPaperStream({ ...base, onDelta: () => {} })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
    }
  })
})
