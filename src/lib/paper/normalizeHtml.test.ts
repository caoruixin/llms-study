import { describe, expect, it } from 'vitest'
import { normalizeDocxHtml } from './normalizeDocx'
import { normalizeHtmlSections } from './normalizeHtml'

describe('normalizeHtmlSections', () => {
  describe('单节（单 URL 导入）', () => {
    it('不下压标题、不合成任何 heading：与 normalizeDocxHtml 同一 html 的输出等价（除 anchor.kind）', () => {
      const html = '<h1>标题</h1><p>第一段。</p><h2>1 方法</h2><p>方法细节。</p>'
      const fromHtml = normalizeHtmlSections([{ title: '标题', html }])
      const fromDocx = normalizeDocxHtml(html)

      expect(fromHtml.map((b) => [b.kind, b.level, b.text])).toEqual(fromDocx.map((b) => [b.kind, b.level, b.text]))
      expect(fromHtml.every((b) => b.anchor.kind === 'html')).toBe(true)
      expect(fromHtml.map((b) => b.anchor.section)).toEqual(fromDocx.map((b) => b.anchor.section))
    })

    it('title 字段在单节场景下被忽略（即便与正文首个标题不同也不合成/不去重）', () => {
      const blocks = normalizeHtmlSections([{ title: '完全不同的标题', html: '<h1>正文标题</h1><p>内容</p>' }])
      expect(blocks.map((b) => [b.kind, b.level, b.text])).toEqual([
        ['heading', 1, '正文标题'],
        ['paragraph', undefined, '内容'],
      ])
    })

    it('anchor.blockIndex 与 index 一致、连续', () => {
      const blocks = normalizeHtmlSections([{ html: '<p>A</p><p>B</p><p>C</p>' }])
      blocks.forEach((b, i) => {
        expect(b.index).toBe(i)
        expect(b.anchor.blockIndex).toBe(i)
      })
    })
  })

  describe('多节（多 URL 合并）', () => {
    it('每节前合成 level-1 heading（节 title），节内标题统一下压一级', () => {
      const blocks = normalizeHtmlSections([
        { title: '第一页', html: '<h1>引言</h1><p>A</p><h2>细节</h2><p>B</p>' },
        { title: '第二页', html: '<h1>背景</h1><p>C</p>' },
      ])
      expect(blocks.map((b) => [b.kind, b.level, b.text])).toEqual([
        ['heading', 1, '第一页'],
        ['heading', 2, '引言'], // 原 h1 下压到 level 2
        ['paragraph', undefined, 'A'],
        ['heading', 3, '细节'], // 原 h2 下压到 level 3
        ['paragraph', undefined, 'B'],
        ['heading', 1, '第二页'],
        ['heading', 2, '背景'],
        ['paragraph', undefined, 'C'],
      ])
    })

    it('下压后 level 封顶在 6', () => {
      const blocks = normalizeHtmlSections([
        { title: 'S1', html: '<h6>深层标题</h6><p>x</p>' },
        { title: 'S2', html: '<p>y</p>' },
      ])
      const h6 = blocks.find((b) => b.text === '深层标题')
      expect(h6?.level).toBe(6)
    })

    it('节首标题与节 title 文本相同时去重：不会连续出现两次同名标题', () => {
      const blocks = normalizeHtmlSections([
        { title: 'NVIDIA AI Factory', html: '<h1>NVIDIA AI Factory</h1><p>正文一。</p>' },
        { title: '第二章', html: '<h1>第二章</h1><p>正文二。</p>' },
      ])
      expect(blocks.map((b) => [b.kind, b.level, b.text])).toEqual([
        ['heading', 1, 'NVIDIA AI Factory'], // 合成的节标题
        ['paragraph', undefined, '正文一。'], // 原来重复的 h1 被跳过，直接是段落
        ['heading', 1, '第二章'],
        ['paragraph', undefined, '正文二。'],
      ])
    })

    it('去重只发生一次：节首去重后，节内后续再出现同名标题不再被跳过', () => {
      const blocks = normalizeHtmlSections([
        { title: 'T', html: '<h1>T</h1><p>a</p><h2>T</h2><p>b</p>' },
        { title: 'S2', html: '<p>c</p>' },
      ])
      expect(blocks.map((b) => [b.kind, b.level, b.text])).toEqual([
        ['heading', 1, 'T'], // 合成节标题
        // 原 h1「T」与节 title 相同 → 节首去重，跳过
        ['paragraph', undefined, 'a'],
        ['heading', 3, 'T'], // 原 h2「T」下压到 level 3，dedupPending 已消费，不再去重
        ['paragraph', undefined, 'b'],
        ['heading', 1, 'S2'],
        ['paragraph', undefined, 'c'],
      ])
    })

    it('去重判据只看第一个非空块，非标题打头的节不触发去重', () => {
      const blocks = normalizeHtmlSections([
        { title: 'X', html: '<p>先来一段正文</p><h1>X</h1>' },
        { title: 'Y', html: '<p>另一段</p>' },
      ])
      expect(blocks.map((b) => [b.kind, b.text])).toEqual([
        ['heading', 'X'],
        ['paragraph', '先来一段正文'],
        ['heading', 'X'], // 不是节首块（前面已有段落），不去重
        ['heading', 'Y'],
        ['paragraph', '另一段'],
      ])
    })

    it('anchor.blockIndex 跨节全局连续；anchor.section 随合成 heading 与节内标题刷新', () => {
      const blocks = normalizeHtmlSections([
        { title: 'Page A', html: '<p>a1</p>' },
        { title: 'Page B', html: '<h1>子标题</h1><p>b1</p>' },
      ])
      blocks.forEach((b, i) => expect(b.anchor.blockIndex).toBe(i))
      expect(blocks.map((b) => [b.text, b.anchor.section])).toEqual([
        ['Page A', 'Page A'],
        ['a1', 'Page A'],
        ['Page B', 'Page B'],
        ['子标题', '子标题'],
        ['b1', '子标题'],
      ])
    })

    it('缺省 title（空字符串/undefined）的节不合成 heading，也不参与去重', () => {
      const blocks = normalizeHtmlSections([
        { title: '', html: '<p>无标题节的正文</p>' },
        { title: 'B', html: '<p>b</p>' },
      ])
      expect(blocks.map((b) => [b.kind, b.text])).toEqual([
        ['paragraph', '无标题节的正文'],
        ['heading', 'B'],
        ['paragraph', 'b'],
      ])
    })
  })

  it('列表 / 表格 / pre 与 normalizeDocxHtml 行为一致（单节透传）', () => {
    const html = '<ul><li>项一</li><li>项二</li></ul><table><tr><th>A</th></tr><tr><td>1</td></tr></table><pre>code()</pre>'
    const blocks = normalizeHtmlSections([{ html }])
    expect(blocks.map((b) => b.kind)).toEqual(['list', 'list', 'table', 'code'])
    expect(blocks[2].html).toContain('<table>')
  })

  it('空输入（sources 为空数组）返回空块数组', () => {
    expect(normalizeHtmlSections([])).toEqual([])
  })
})
