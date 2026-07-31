import { describe, expect, it } from 'vitest'
import { splitFences } from './liteMd'

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
      { type: 'code', lang: 'ts', text: 'const a = 1' },
    ])
  })

  it('无语言的围栏', () => {
    expect(splitFences('```\nplain\n```')).toEqual([{ type: 'code', lang: '', text: 'plain' }])
  })

  it('多个围栏交替', () => {
    const segs = splitFences('a\n```py\nx=1\n```\nb\n```sh\nls\n```\nc')
    expect(segs).toEqual([
      { type: 'text', text: 'a' },
      { type: 'code', lang: 'py', text: 'x=1' },
      { type: 'text', text: 'b' },
      { type: 'code', lang: 'sh', text: 'ls' },
      { type: 'text', text: 'c' },
    ])
  })

  it('未闭合围栏一直算 code 到末尾（流式半截）', () => {
    const segs = splitFences('看代码：\n```js\nconst a =')
    expect(segs).toEqual([
      { type: 'text', text: '看代码：' },
      { type: 'code', lang: 'js', text: 'const a =' },
    ])
  })

  it('刚开围栏还没内容 → 空 code 段', () => {
    expect(splitFences('```js')).toEqual([{ type: 'code', lang: 'js', text: '' }])
  })

  it('围栏后接文本', () => {
    const segs = splitFences('```\ncode\n```\n收尾说明')
    expect(segs).toEqual([
      { type: 'code', lang: '', text: 'code' },
      { type: 'text', text: '收尾说明' },
    ])
  })

  it('围栏内多行原样保留（含空行）', () => {
    const segs = splitFences('```go\nfunc main() {\n\n}\n```')
    expect(segs).toEqual([{ type: 'code', lang: 'go', text: 'func main() {\n\n}' }])
  })
})
