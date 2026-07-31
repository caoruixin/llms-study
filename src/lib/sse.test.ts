import { describe, expect, it } from 'vitest'
import { createSseParser, extractStreamDelta, extractStreamError } from './sse'

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
