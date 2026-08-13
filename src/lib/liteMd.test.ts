import { describe, expect, it } from 'vitest'
import { splitFences } from './liteMd'

// 注：Phase 3 给 code 段加了 closed 字段（加法式）。toEqual 是全字段严格比较，
// 因此原有 code 段期望字面量同步补上 closed——每条断言只增强（多断言一个字段值），未删改语义。

describe('splitFences', () => {
  it('纯文本 → 单个 text 段（保留换行）', () => {
    expect(splitFences('第一行\n第二行')).toEqual([{ type: 'text', text: '第一行\n第二行' }])
  })

  it('空串 → 空数组', () => {
    expect(splitFences('')).toEqual([])
  })

  it('带语言的围栏', () => {
    const segs = splitFences('说明：\n```ts\nconst a = 1\n```')
    expect(segs).toEqual([
      { type: 'text', text: '说明：' },
      { type: 'code', lang: 'ts', text: 'const a = 1', closed: true },
    ])
  })

  it('无语言的围栏', () => {
    expect(splitFences('```\nplain\n```')).toEqual([{ type: 'code', lang: '', text: 'plain', closed: true }])
  })

  it('多个围栏交替', () => {
    const segs = splitFences('a\n```py\nx=1\n```\nb\n```sh\nls\n```\nc')
    expect(segs).toEqual([
      { type: 'text', text: 'a' },
      { type: 'code', lang: 'py', text: 'x=1', closed: true },
      { type: 'text', text: 'b' },
      { type: 'code', lang: 'sh', text: 'ls', closed: true },
      { type: 'text', text: 'c' },
    ])
  })

  it('未闭合围栏一直算 code 到末尾（流式半截）', () => {
    const segs = splitFences('看代码：\n```js\nconst a =')
    expect(segs).toEqual([
      { type: 'text', text: '看代码：' },
      { type: 'code', lang: 'js', text: 'const a =', closed: false },
    ])
  })

  it('刚开围栏还没内容 → 空 code 段', () => {
    expect(splitFences('```js')).toEqual([{ type: 'code', lang: 'js', text: '', closed: false }])
  })

  it('围栏后接文本', () => {
    const segs = splitFences('```\ncode\n```\n收尾说明')
    expect(segs).toEqual([
      { type: 'code', lang: '', text: 'code', closed: true },
      { type: 'text', text: '收尾说明' },
    ])
  })

  it('围栏内多行原样保留（含空行）', () => {
    const segs = splitFences('```go\nfunc main() {\n\n}\n```')
    expect(segs).toEqual([{ type: 'code', lang: 'go', text: 'func main() {\n\n}', closed: true }])
  })
})

describe('splitFences closed 标志（Phase 3 加法）', () => {
  it('闭合围栏 closed=true，EOF 未闭合 closed=false', () => {
    const closedSeg = splitFences('```json\n{"a":1}\n```')[0]
    expect(closedSeg).toEqual({ type: 'code', lang: 'json', text: '{"a":1}', closed: true })
    const openSeg = splitFences('```copilot:formula\n{"expr":"a+')[0]
    expect(openSeg).toEqual({ type: 'code', lang: 'copilot:formula', text: '{"expr":"a+', closed: false })
  })

  it('多段时只有最后一个未闭合段 closed=false', () => {
    const segs = splitFences('```a\n1\n```\n中间\n```b\n2')
    expect(segs.map((s) => (s.type === 'code' ? s.closed : null))).toEqual([true, null, false])
  })

  it('info-string 原样进 lang（copilot 岛识别交给上层）', () => {
    const seg = splitFences('```copilot:plan\n{}\n```')[0]
    expect(seg).toEqual({ type: 'code', lang: 'copilot:plan', text: '{}', closed: true })
  })
})
