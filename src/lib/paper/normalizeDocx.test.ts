import { describe, expect, it } from 'vitest'
import { normalizeDocxHtml } from './normalizeDocx'

describe('normalizeDocxHtml', () => {
  it('标题与段落各成一块，heading 带 level', () => {
    const blocks = normalizeDocxHtml('<h1>论文标题</h1><p>第一段正文。</p><h2>1 方法</h2><p>方法细节。</p>')
    expect(blocks.map((b) => [b.kind, b.level, b.text])).toEqual([
      ['heading', 1, '论文标题'],
      ['paragraph', undefined, '第一段正文。'],
      ['heading', 2, '1 方法'],
      ['paragraph', undefined, '方法细节。'],
    ])
  })

  it('最近标题写进后续块的 anchor.section，并随新标题切换', () => {
    const blocks = normalizeDocxHtml('<h1>引言</h1><p>A</p><h1>方法</h1><p>B</p>')
    expect(blocks.map((b) => b.anchor.section)).toEqual(['引言', '引言', '方法', '方法'])
    expect(blocks.every((b) => b.anchor.kind === 'docx')).toBe(true)
  })

  it('ul / ol 拆成逐条 list 块', () => {
    const blocks = normalizeDocxHtml('<ul><li>第一条</li><li>第二条</li></ul><ol><li>步骤一</li></ol>')
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ['list', '第一条'],
      ['list', '第二条'],
      ['list', '步骤一'],
    ])
  })

  it('table 文本化为 ` | ` 连接的行，并保留清洗后的 html', () => {
    const blocks = normalizeDocxHtml(
      '<table><tr><th>方法</th><th>准确率</th></tr><tr><td>Ours</td><td>91.2</td></tr></table>',
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('table')
    expect(blocks[0].text).toBe('方法 | 准确率\nOurs | 91.2')
    expect(blocks[0].html).toContain('<table>')
  })

  it('pre → code 块', () => {
    const blocks = normalizeDocxHtml('<pre>for i in range(10):\n    print(i)</pre>')
    expect(blocks[0].kind).toBe('code')
    expect(blocks[0].text).toContain('print(i)')
  })

  it('空块（只含被剥掉的图片的段落、空段落）被跳过，index 保持连续', () => {
    const blocks = normalizeDocxHtml('<p>A</p><p></p><p>   </p><p>B</p>')
    expect(blocks.map((b) => b.text)).toEqual(['A', 'B'])
    blocks.forEach((b, i) => {
      expect(b.index).toBe(i)
      expect(b.anchor.blockIndex).toBe(i)
    })
  })

  describe('伪标题（整段加粗）', () => {
    // scripts/paper-eval/fixtures/kv-cache-note.docx 经 mammoth 转换后的真实 HTML 形状
    const KV_NOTE_HTML =
      '<p><strong>KV Cache 显存占用分析</strong></p>' +
      '<p>本文分析大语言模型推理阶段 KV cache 的显存占用规律。</p>' +
      '<p><strong>1. 背景</strong></p>' +
      '<p>自回归解码时，每生成一个 token 都需要与历史全部 token 做注意力计算。</p>' +
      '<p><strong>2. 显存占用公式</strong></p>' +
      '<p>KV cache 的字节数为：2 × n_layers × n_kv_heads × d_head × L × bytes_per_elem。</p>'

    it('整段加粗的短段落按标题处理：数字前缀走编号层级，无前缀统一 level 2', () => {
      const blocks = normalizeDocxHtml(KV_NOTE_HTML)
      expect(blocks.filter((b) => b.kind === 'heading').map((b) => [b.text, b.level])).toEqual([
        ['KV Cache 显存占用分析', 2],
        ['1. 背景', 1],
        ['2. 显存占用公式', 1],
      ])
      // 修复前整篇 section 全是 undefined（→ 全文坍缩成 1 个 chunk）
      expect(blocks.map((b) => b.anchor.section)).toEqual([
        'KV Cache 显存占用分析',
        'KV Cache 显存占用分析',
        '1. 背景',
        '1. 背景',
        '2. 显存占用公式',
        '2. 显存占用公式',
      ])
    })

    it('多级编号前缀按深度定级', () => {
      const blocks = normalizeDocxHtml('<p><b>3.2.1 分页注意力</b></p>')
      expect(blocks[0]).toMatchObject({ kind: 'heading', level: 3, text: '3.2.1 分页注意力' })
    })

    it('行内强调不算标题：段内还有加粗之外的正文时仍是 paragraph', () => {
      const blocks = normalizeDocxHtml('<p><strong>KV cache</strong> 是推理引擎的显存大户</p>')
      expect(blocks[0]).toMatchObject({ kind: 'paragraph', text: 'KV cache 是推理引擎的显存大户' })
    })

    it('整段加粗但过长或以句末标点结尾 → 仍是 paragraph', () => {
      const long = `<p><strong>${'很长的加粗强调句'.repeat(9)}</strong></p>` // 72 字 > 60
      expect(normalizeDocxHtml(long)[0].kind).toBe('paragraph')
      expect(normalizeDocxHtml('<p><strong>这是一句被整体加粗的结论。</strong></p>')[0].kind).toBe('paragraph')
      expect(normalizeDocxHtml('<p><strong>Bold sentence ends here.</strong></p>')[0].kind).toBe('paragraph')
    })

    it('h1..h6 的既有行为不变（真标题优先，不受伪标题规则影响）', () => {
      const blocks = normalizeDocxHtml('<h2><strong>1 方法</strong></h2>')
      expect(blocks[0]).toMatchObject({ kind: 'heading', level: 2, text: '1 方法' })
    })
  })

  it('内联标签被抹平为纯文本，中文不会被插入多余空格', () => {
    const blocks = normalizeDocxHtml('<p>注意<strong>力</strong>机制与 <em>KV</em> cache</p>')
    expect(blocks[0].text).toBe('注意力机制与 KV cache')
  })

  it('实体在去标签之后解码：&lt;script&gt; 只会还原成普通文本', () => {
    const blocks = normalizeDocxHtml('<p>写作 &lt;script&gt; 时需转义 &amp; 符号&nbsp;结束&#65;</p>')
    expect(blocks[0].text).toBe('写作 <script> 时需转义 & 符号 结束A')
  })

  it('纵深防御：恶意 HTML 漏过 sanitize 时，去标签后只剩纯文本，无脚本正文残留', () => {
    const evil =
      '<p onclick="steal()">正文开始<script>fetch("//evil")</script><img src=x onerror="alert(1)">正文结束</p>' +
      '<style>body{display:none}</style>'
    const blocks = normalizeDocxHtml(evil)
    expect(blocks).toHaveLength(1)
    // script 整段（含其正文）被替换为一个空格，因此中间留下分隔空格而非脚本内容
    expect(blocks[0].text).toBe('正文开始 正文结束')
    expect(blocks[0].text).not.toContain('onclick')
    expect(blocks[0].text).not.toContain('onerror')
    expect(blocks[0].text).not.toContain('fetch')
    expect(blocks[0].text).not.toContain('<')
  })

  it('包裹 div 与未闭合标签都不会吞掉正文', () => {
    expect(normalizeDocxHtml('<div><p>包在 div 里的段落</p></div>')[0].text).toBe('包在 div 里的段落')
    expect(normalizeDocxHtml('<p>未闭合的段落')[0].text).toBe('未闭合的段落')
  })
})
