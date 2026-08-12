import { describe, expect, it } from 'vitest'
import { buildChatBody } from './providerAdapters'
import { buildKimiStructuredSpec, DEEPSEEK_V4_PRO, KIMI_K3, PAPER_TASKS } from '../../data/paperPolicy'
import type { ChatMessage } from '../llmClient'

const messages: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: '问题' },
]

describe('buildChatBody · DeepSeek 契约（逐字段）', () => {
  it('普通问答（chat）：thinking 显式 disabled + stream_options + max_tokens + temperature', () => {
    const body = buildChatBody(PAPER_TASKS.chat, messages, true)
    expect(body).toEqual({
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '问题' },
      ],
      stream: true,
      max_tokens: 1500,
      thinking: { type: 'disabled' },
      temperature: 0.5,
      stream_options: { include_usage: true },
    })
  })

  it('深度任务（deep）：thinking enabled + reasoning_effort high', () => {
    const body = buildChatBody(PAPER_TASKS.deep, messages, true)
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('high')
    expect(body.max_tokens).toBe(3000)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('非流式：不带 stream_options', () => {
    const body = buildChatBody(PAPER_TASKS.chat, messages, false)
    expect(body.stream).toBe(false)
    expect(body).not.toHaveProperty('stream_options')
  })

  it('结构任务（briefDigest）：response_format json_object', () => {
    const body = buildChatBody(PAPER_TASKS.briefDigest, messages, false)
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.temperature).toBe(0.2)
  })

  it('json_schema 请求落在 json_object 能力的模型上 → 降级为 json_object', () => {
    const body = buildChatBody(
      {
        cap: DEEPSEEK_V4_PRO,
        thinking: 'off',
        responseFormat: { type: 'json_schema', name: 'x', schema: { type: 'object' } },
        maxOutputTokens: 500,
      },
      messages,
      false,
    )
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('spec 未带 temperature 时不发送该字段', () => {
    const body = buildChatBody({ cap: DEEPSEEK_V4_PRO, thinking: 'off', maxOutputTokens: 100 }, messages, true)
    expect(body).not.toHaveProperty('temperature')
  })
})

describe('buildChatBody · Kimi 契约（逐字段）', () => {
  const kimiSpec = buildKimiStructuredSpec('unit_digest', { type: 'object' }, 900)

  it('结构任务：json_schema strict + max_completion_tokens + effort low，全部采样参数省略', () => {
    const body = buildChatBody(kimiSpec, messages, false)
    expect(body).toEqual({
      model: 'kimi-k3',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '问题' },
      ],
      stream: false,
      max_completion_tokens: 900,
      reasoning_effort: 'low',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'unit_digest', schema: { type: 'object' }, strict: true },
      },
    })
  })

  it('禁发字段核对：temperature/top_p/presence_penalty/frequency_penalty/thinking/stream_options/max_tokens', () => {
    // 即使 spec 误带 temperature，fixed sampling 也必须剥掉
    const body = buildChatBody({ ...kimiSpec, temperature: 0.7 }, messages, true)
    for (const banned of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'thinking', 'stream_options', 'max_tokens']) {
      expect(body, `不应包含 ${banned}`).not.toHaveProperty(banned)
    }
    expect(body.max_completion_tokens).toBe(900)
  })

  it('深度升级：effort high；on-high 也映射为 high', () => {
    expect(buildChatBody({ cap: KIMI_K3, thinking: 'effort-high', maxOutputTokens: 3000 }, messages, true).reasoning_effort).toBe('high')
    expect(buildChatBody({ cap: KIMI_K3, thinking: 'on-high', maxOutputTokens: 3000 }, messages, true).reasoning_effort).toBe('high')
    expect(buildChatBody({ cap: KIMI_K3, thinking: 'off', maxOutputTokens: 3000 }, messages, true).reasoning_effort).toBe('low')
  })

  it('messages 只保留 role/content（剥掉调用方多余字段）', () => {
    const dirty = [{ role: 'user', content: 'hi', extra: 'x' }] as unknown as ChatMessage[]
    const body = buildChatBody(kimiSpec, dirty, false)
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })
})
