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

  describe('figure → image / caption 块', () => {
    it('figure 拆成 image 块 + caption 块：顺序、text 占位与 src 字段', () => {
      const html =
        '<p>前文</p>' +
        '<figure><img src="https://arxiv.org/html/2406.00001v1/x1.png" alt="Overview"><figcaption>图 1：总览</figcaption></figure>' +
        '<p>后文</p>'
      const blocks = normalizeHtmlSections([{ html }])
      expect(blocks.map((b) => [b.kind, b.text])).toEqual([
        ['paragraph', '前文'],
        ['image', '[图: Overview]'],
        ['caption', '图 1：总览'],
        ['paragraph', '后文'],
      ])
      expect(blocks[1].src).toBe('https://arxiv.org/html/2406.00001v1/x1.png')
      expect(blocks[2].src).toBeUndefined()
    })

    it('无 alt 的图占位为 [图]；src 属性值做 HTML 实体解码（&amp; 等）', () => {
      const blocks = normalizeHtmlSections([
        { html: '<figure><img src="https://x.org/a.png?w=1&amp;h=2&quot;"></figure>' },
      ])
      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toMatchObject({ kind: 'image', text: '[图]', src: 'https://x.org/a.png?w=1&h=2"' })
    })

    it('一个 figure 多张图逐图成块，figcaption 归并为殿后的一个 caption 块', () => {
      const blocks = normalizeHtmlSections([
        {
          html:
            '<figure><img src="https://x.org/a.png" alt="A"><img src="https://x.org/b.png" alt="B">' +
            '<figcaption>双图并排</figcaption></figure>',
        },
      ])
      expect(blocks.map((b) => [b.kind, b.text, b.src])).toEqual([
        ['image', '[图: A]', 'https://x.org/a.png'],
        ['image', '[图: B]', 'https://x.org/b.png'],
        ['caption', '双图并排', undefined],
      ])
    })

    it('无 src 的图仍成 image 块（占位文本、无 src 字段，渲染层降级为纯占位）', () => {
      const blocks = normalizeHtmlSections([{ html: '<figure><img alt="lost"></figure>' }])
      expect(blocks).toHaveLength(1)
      expect(blocks[0].kind).toBe('image')
      expect(blocks[0].text).toBe('[图: lost]')
      expect(blocks[0].src).toBeUndefined()
    })

    it('figure 内 img/figcaption 之外的内容忽略', () => {
      const blocks = normalizeHtmlSections([
        { html: '<figure><p>杂项说明</p><img src="https://x.org/a.png"></figure>' },
      ])
      expect(blocks.map((b) => [b.kind, b.text])).toEqual([['image', '[图]']])
    })

    it('image / caption 块的 blockIndex 全局连续，anchor.section 沿用最近标题', () => {
      const blocks = normalizeHtmlSections([
        { html: '<h2>方法</h2><figure><img src="https://x.org/a.png" alt="架构"><figcaption>图 2</figcaption></figure><p>正文</p>' },
      ])
      blocks.forEach((b, i) => {
        expect(b.index).toBe(i)
        expect(b.anchor.blockIndex).toBe(i)
      })
      expect(blocks.map((b) => b.anchor.section)).toEqual(['方法', '方法', '方法', '方法'])
    })
  })

  it('纯图表格不再被整块丢弃：text 为空但保留结构 html，blockIndex 连续', () => {
    const html = '<p>A</p><table><tr><td><img src="https://x.org/a.png"></td></tr></table><p>B</p>'
    const blocks = normalizeHtmlSections([{ html }])
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ['paragraph', 'A'],
      ['table', ''],
      ['paragraph', 'B'],
    ])
    expect(blocks[1].html).toContain('<img')
    blocks.forEach((b, i) => {
      expect(b.index).toBe(i)
      expect(b.anchor.blockIndex).toBe(i)
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
