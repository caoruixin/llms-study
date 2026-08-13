import { describe, expect, it } from 'vitest'
import { createSseParser, extractStreamDelta, extractStreamError, extractStreamUsage } from './sse'

describe('createSseParser（事件级解析）', () => {
  it('单事件单 data 行', () => {
    const p = createSseParser()
    expect(p.push('data: {"a":1}\n\n')).toEqual(['{"a":1}'])
    expect(p.flush()).toEqual([])
  })

  it('一个 chunk 内多个事件', () => {
    const p = createSseParser()
    expect(p.push('data: one\n\ndata: two\n\ndata: three\n\n')).toEqual(['one', 'two', 'three'])
  })

  it('事件跨 chunk 断开（含 JSON 被切两半）', () => {
    const p = createSseParser()
    expect(p.push('data: {"cho')).toEqual([])
    expect(p.push('ices":[]}')).toEqual([])
    expect(p.push('\n\n')).toEqual(['{"choices":[]}'])
  })

  it('多个 data: 行合并为一个 payload（\\n join）', () => {
    const p = createSseParser()
    expect(p.push('data: line1\ndata: line2\ndata: line3\n\n')).toEqual(['line1\nline2\nline3'])
  })

  it('CRLF 换行容错', () => {
    const p = createSseParser()
    expect(p.push('data: hi\r\n\r\n')).toEqual(['hi'])
  })

  it('[DONE] 哨兵原样透传', () => {
    const p = createSseParser()
    expect(p.push('data: {"x":1}\n\ndata: [DONE]\n\n')).toEqual(['{"x":1}', '[DONE]'])
  })

  it('忽略 : 注释行、event: 与 id: 字段行', () => {
    const p = createSseParser()
    expect(p.push(': keep-alive\n\n')).toEqual([])
    expect(p.push('event: message\nid: 42\ndata: payload\n\n')).toEqual(['payload'])
  })

  it('只去掉 data: 后的一个前导空格', () => {
    const p = createSseParser()
    expect(p.push('data:  两个空格\n\n')).toEqual([' 两个空格'])
    expect(p.push('data:无空格\n\n')).toEqual(['无空格'])
  })

  it('末尾无换行时 flush 收尾', () => {
    const p = createSseParser()
    expect(p.push('data: tail')).toEqual([])
    expect(p.flush()).toEqual(['tail'])
    expect(p.flush()).toEqual([]) // flush 幂等，不重复发
  })

  it('末尾有 data 行但缺空行时 flush 补发', () => {
    const p = createSseParser()
    expect(p.push('data: a\n\ndata: b\n')).toEqual(['a'])
    expect(p.flush()).toEqual(['b'])
  })
})

describe('extractStreamDelta', () => {
  it('正常 delta', () => {
    expect(extractStreamDelta({ choices: [{ delta: { content: '你好' } }] })).toBe('你好')
  })

  it('role-only 首帧 → null', () => {
    expect(extractStreamDelta({ choices: [{ delta: { role: 'assistant' } }] })).toBeNull()
  })

  it('空 choices 的 usage 尾帧 → null', () => {
    expect(extractStreamDelta({ choices: [], usage: { total_tokens: 12 } })).toBeNull()
  })

  it('忽略 reasoning_content（只取 content）', () => {
    expect(extractStreamDelta({ choices: [{ delta: { reasoning_content: '思考中' } }] })).toBeNull()
  })

  it('缺失 / 非法结构 → null', () => {
    expect(extractStreamDelta(null)).toBeNull()
    expect(extractStreamDelta('[DONE]')).toBeNull()
    expect(extractStreamDelta({})).toBeNull()
    expect(extractStreamDelta({ choices: [null] })).toBeNull()
    expect(extractStreamDelta({ choices: [{ delta: { content: 42 } }] })).toBeNull()
    expect(extractStreamDelta({ choices: [{ delta: { content: '' } }] })).toBeNull()
  })
})

describe('extractStreamError', () => {
  it('error.message', () => {
    expect(extractStreamError({ error: { message: '上游炸了', type: 'server_error' } })).toBe('上游炸了')
  })

  it('error 为字符串', () => {
    expect(extractStreamError({ error: 'boom' })).toBe('boom')
  })

  it('无 error 字段 / 非法结构 → null', () => {
    expect(extractStreamError({ choices: [{ delta: { content: 'hi' } }] })).toBeNull()
    expect(extractStreamError(null)).toBeNull()
    expect(extractStreamError({ error: { code: 500 } })).toBeNull()
  })
})

describe('extractStreamUsage（Phase 3 加法）', () => {
  it('DeepSeek 形：choices 空数组 + 顶层 usage', () => {
    expect(
      extractStreamUsage({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 } }),
    ).toEqual({ inputTokens: 120, outputTokens: 45 })
  })

  it('choices 缺失 + 顶层 usage 也识别', () => {
    expect(extractStreamUsage({ usage: { prompt_tokens: 8, completion_tokens: 2 } })).toEqual({
      inputTokens: 8,
      outputTokens: 2,
    })
  })

  it('Kimi 形：usage 挂在 choices[0] 内（finish_reason 帧）', () => {
    expect(
      extractStreamUsage({
        choices: [
          { index: 0, delta: {}, finish_reason: 'stop', usage: { prompt_tokens: 300, completion_tokens: 77 } },
        ],
      }),
    ).toEqual({ inputTokens: 300, outputTokens: 77 })
  })

  it('普通 delta 帧（无 usage）→ null', () => {
    expect(extractStreamUsage({ choices: [{ delta: { content: '你好' } }] })).toBeNull()
  })

  it('usage 字段残缺 / 非数值 → null', () => {
    expect(extractStreamUsage({ choices: [], usage: { prompt_tokens: 12 } })).toBeNull()
    expect(extractStreamUsage({ choices: [], usage: { prompt_tokens: '12', completion_tokens: 3 } })).toBeNull()
    expect(extractStreamUsage({ choices: [], usage: { prompt_tokens: NaN, completion_tokens: 3 } })).toBeNull()
    expect(extractStreamUsage(null)).toBeNull()
    expect(extractStreamUsage('[DONE]')).toBeNull()
    expect(extractStreamUsage({})).toBeNull()
    expect(extractStreamUsage({ choices: [null] })).toBeNull()
  })

  it('顶层 usage 优先于 choice 内 usage', () => {
    expect(
      extractStreamUsage({
        choices: [{ usage: { prompt_tokens: 1, completion_tokens: 1 } }],
        usage: { prompt_tokens: 9, completion_tokens: 9 },
      }),
    ).toEqual({ inputTokens: 9, outputTokens: 9 })
  })

  it('DeepSeek v4-pro 实测形：finish 帧 choices 非空 + 顶层 usage（2026-08-12 冒烟录得）', () => {
    expect(
      extractStreamUsage({
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      }),
    ).toEqual({ inputTokens: 7, outputTokens: 5 })
  })
})
