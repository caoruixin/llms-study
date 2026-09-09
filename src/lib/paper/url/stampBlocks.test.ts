// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest'
import type { NormalizedBlock } from '../types'

/**
 * happy-dom 兼容性补丁：与 sanitize.test.ts / extractArticle.weixin.test.ts 同源
 * （DOMPurify 3.4 依赖 Node.prototype.nodeName getter，happy-dom 的基类桩恒返回 ''）。
 * stampBlocks 静态 import ../sanitize（→ dompurify），补丁必须先于模块求值，故走 beforeAll 动态 import。
 */
const baseNodeName = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeName')
Object.defineProperty(Node.prototype, 'nodeName', {
  configurable: true,
  get(this: Node) {
    let proto: object | null = Object.getPrototypeOf(this)
    while (proto && proto !== Node.prototype) {
      const desc = Object.getOwnPropertyDescriptor(proto, 'nodeName')
      if (desc?.get) return desc.get.call(this)
      proto = Object.getPrototypeOf(proto)
    }
    return baseNodeName?.get?.call(this)
  },
})

type Mod = typeof import('./stampBlocks')
let stampBlocks: Mod['stampBlocks']
let hostText: Mod['hostText']
let normalizeBlockWhitespace: Mod['normalizeBlockWhitespace']
let STAMP_ATTR: string
let RUN_ATTR: string

beforeAll(async () => {
  ;({ stampBlocks, hostText, normalizeBlockWhitespace, STAMP_ATTR, RUN_ATTR } = await import('./stampBlocks'))
})

const parse = (body: string): Document =>
  new DOMParser().parseFromString(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`, 'text/html')

const el = (doc: Document, i: number): Element => {
  const found = doc.querySelector(`[${STAMP_ATTR}="${i}"]`)
  if (!found) throw new Error(`block ${i} not stamped`)
  return found
}

const brief = (blocks: NormalizedBlock[]) => blocks.map((b) => [b.kind, b.level, b.text])

/** 全部不变式：索引连续且文档序、文本块 hostText === text、anchor 自洽 */
function assertInvariants(doc: Document, blocks: NormalizedBlock[]): void {
  const stamped = Array.from(doc.querySelectorAll(`[${STAMP_ATTR}]`)).map((e) => Number(e.getAttribute(STAMP_ATTR)))
  expect(stamped).toEqual(blocks.map((_, i) => i))
  blocks.forEach((b, i) => {
    expect(b.index).toBe(i)
    expect(b.anchor.kind).toBe('html')
    expect(b.anchor.blockIndex).toBe(i)
    if (b.kind !== 'table' && b.kind !== 'image') expect(hostText(el(doc, i))).toBe(b.text)
    if (!b.text) expect(Boolean(b.html || b.src)).toBe(true)
  })
}

const LONG = 'This sentence is comfortably longer than twenty characters.'

describe('stampBlocks', () => {
  it('标题/段落按文档序打标，level 与 section 追踪同 normalizeHtml', () => {
    const doc = parse('<h1>Intro</h1><p>First para.</p><h2>Method</h2><p>Second para.</p><h3>Sub</h3><p>Third.</p>')
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([
      ['heading', 1, 'Intro'],
      ['paragraph', undefined, 'First para.'],
      ['heading', 2, 'Method'],
      ['paragraph', undefined, 'Second para.'],
      ['heading', 3, 'Sub'],
      ['paragraph', undefined, 'Third.'],
    ])
    expect(blocks.map((b) => b.anchor.section)).toEqual(['Intro', 'Intro', 'Method', 'Method', 'Sub', 'Sub'])
    expect(el(doc, 0).localName).toBe('h1')
    expect(el(doc, 3).localName).toBe('p')
    assertInvariants(doc, blocks)
  })

  it('首个标题之前的块不带 section 键', () => {
    const doc = parse('<p>Lead paragraph.</p><h2>T</h2><p>x</p>')
    const blocks = stampBlocks(doc)
    expect('section' in blocks[0].anchor).toBe(false)
    expect(blocks[2].anchor.section).toBe('T')
  })

  it('li 含嵌套 ul：父 li 的行内串包进 [data-pc-run]，子 li 各自单独打标', () => {
    const doc = parse(`<ul><li>${LONG}<ul><li>Child one item</li><li>Child two item</li></ul></li><li>Sibling item</li></ul>`)
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([
      ['list', undefined, LONG],
      ['list', undefined, 'Child one item'],
      ['list', undefined, 'Child two item'],
      ['list', undefined, 'Sibling item'],
    ])
    const run = el(doc, 0)
    expect(run.localName).toBe('span')
    expect(run.hasAttribute(RUN_ATTR)).toBe(true)
    expect(run.parentElement?.localName).toBe('li')
    expect(el(doc, 1).localName).toBe('li')
    expect(el(doc, 3).hasAttribute(RUN_ATTR)).toBe(false)
    assertInvariants(doc, blocks)
  })

  it('语义容器（li/h2）的 run 继承其 kind，只需 1 个字母（短文本也不丢）', () => {
    const doc = parse('<ul><li>Fruits<ul><li>Apple</li></ul></li></ul><h2>Title<div><p>Nested para</p></div></h2>')
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([
      ['list', undefined, 'Fruits'],
      ['list', undefined, 'Apple'],
      ['heading', 2, 'Title'],
      ['paragraph', undefined, 'Nested para'],
    ])
    expect(blocks[3].anchor.section).toBe('Title')
    assertInvariants(doc, blocks)
  })

  it('混合 div：松散文本 + 子 <p>，run 包裹后 DOM 里 p 原样', () => {
    const doc = parse(`<div>  ${LONG}  <p>Inner paragraph.</p>  tail text that is also long enough  </div>`)
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([
      ['paragraph', undefined, LONG],
      ['paragraph', undefined, 'Inner paragraph.'],
      ['paragraph', undefined, 'tail text that is also long enough'],
    ])
    expect(el(doc, 0).hasAttribute(RUN_ATTR)).toBe(true)
    expect(el(doc, 1).localName).toBe('p')
    expect(el(doc, 1).hasAttribute(RUN_ATTR)).toBe(false)
    expect(el(doc, 2).hasAttribute(RUN_ATTR)).toBe(true)
    const div = doc.body.firstElementChild!
    expect(div.querySelectorAll(`[${RUN_ATTR}]`).length).toBe(2)
    assertInvariants(doc, blocks)
  })

  it('混合容器里不够 20 字的行内串原样不动（不包裹、不打标）', () => {
    const doc = parse(`<div>short<p>${LONG}</p></div>`)
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([['paragraph', undefined, LONG]])
    expect(doc.querySelector(`[${RUN_ATTR}]`)).toBeNull()
    expect(doc.body.innerHTML).toContain('<div>short<p')
  })

  it('纯行内容器直接打在自身上，不新建包裹（DOM 字节只多一个属性）', () => {
    const doc = parse('<p>Hello <b>bold</b> <i>world</i></p>')
    const before = doc.body.innerHTML
    const blocks = stampBlocks(doc)
    expect(blocks[0].text).toBe('Hello bold world')
    expect(doc.body.innerHTML).toBe(before.replace('<p>', `<p ${STAMP_ATTR}="0">`))
  })

  it('run 只有一个 span/a 元素时直接打在它身上，不套 run 包裹', () => {
    const doc = parse(`<div><p>a</p> <span class="lead">${LONG}</span> <p>b</p></div>`)
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([
      ['paragraph', undefined, 'a'],
      ['paragraph', undefined, LONG],
      ['paragraph', undefined, 'b'],
    ])
    expect(el(doc, 1).className).toBe('lead')
    expect(doc.querySelector(`[${RUN_ATTR}]`)).toBeNull()
    assertInvariants(doc, blocks)
  })

  it('figure > img + figcaption → image 块 + caption 块（image 只在 https src 时带 src）', () => {
    const doc = parse(
      '<figure><img src="https://x.test/a.png" alt="  A  chart "><figcaption>Figure 1: caption</figcaption></figure>' +
        '<figure><img src="/rel.png"><figcaption>Fig 2</figcaption></figure>',
    )
    const blocks = stampBlocks(doc)
    expect(blocks.map((b) => [b.kind, b.text, b.src])).toEqual([
      ['image', '[图: A chart]', 'https://x.test/a.png'],
      ['caption', 'Figure 1: caption', undefined],
      ['image', '[图]', undefined],
      ['caption', 'Fig 2', undefined],
    ])
    expect(el(doc, 0).localName).toBe('img')
    expect(el(doc, 1).localName).toBe('figcaption')
    expect('src' in blocks[2]).toBe(false)
    assertInvariants(doc, blocks)
  })

  it('段落里只有图片（<p><a><img></a></p>）→ image 块，p 不成文本块', () => {
    const doc = parse('<p><a href="https://x.test"><img src="https://x.test/b.jpg" alt="B"></a></p>')
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([['image', undefined, '[图: B]']])
    expect(el(doc, 0).localName).toBe('img')
  })

  it('1×1 追踪像素不出块', () => {
    const doc = parse('<div><img src="https://t.test/px.gif" width="1" height="1"><img src="https://x.test/c.png" width="300" height="200"></div>')
    const blocks = stampBlocks(doc)
    expect(blocks.map((b) => b.src)).toEqual(['https://x.test/c.png'])
  })

  it('独立 svg：figure 内或 ≥48×48 出 image 块，text 取 <title>；小图标不出块', () => {
    const doc = parse(
      '<figure><svg viewBox="0 0 10 10"><title>Chart of losses</title><rect/></svg></figure>' +
        '<div><svg width="200" height="100" aria-label="Logo mark"><rect/></svg></div>' +
        '<div><svg viewBox="0 0 24 24"><title>icon</title><path/></svg></div>' +
        '<div><svg viewBox="0 0 100 60"><rect/></svg></div>',
    )
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([
      ['image', undefined, '[图: Chart of losses]'],
      ['image', undefined, '[图: Logo mark]'],
      ['image', undefined, '[图]'],
    ])
    expect(el(doc, 0).localName).toBe('svg')
    expect(el(doc, 2).getAttribute('viewBox')).toBe('0 0 100 60')
    assertInvariants(doc, blocks)
  })

  it('table → 单个 table 块（text=tableToText、html 经 sanitize），单元格不打标', () => {
    const doc = parse('<table class="x"><tr><th>Name</th><th>Score</th></tr><tr><td>Alice</td><td>90</td></tr></table>')
    const blocks = stampBlocks(doc)
    expect(blocks.length).toBe(1)
    expect(blocks[0].kind).toBe('table')
    expect(blocks[0].text).toBe('Name | Score\nAlice | 90')
    expect(blocks[0].html).toMatch(/^<table>/)
    expect(blocks[0].html).toContain('<td>Alice</td>')
    expect(el(doc, 0).localName).toBe('table')
    expect(doc.querySelectorAll(`[${STAMP_ATTR}]`).length).toBe(1)
  })

  it('空表格不出块；无文本但含图的表格保留（html 承载结构）', () => {
    const doc = parse('<table><tr><td></td></tr></table><table><tr><td><img src="https://x.test/t.png"></td></tr></table>')
    const blocks = stampBlocks(doc)
    expect(blocks.length).toBe(1)
    expect(blocks[0].kind).toBe('table')
    expect(blocks[0].text).toBe('')
    expect(blocks[0].html).toContain('<img')
  })

  it('布局表格（内含标题）按容器下探，单元格作为泛型段落', () => {
    const doc = parse(`<table><tr><td><h1>Page title</h1><p>Body para.</p></td><td>${LONG}</td><td>x</td></tr></table>`)
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([
      ['heading', 1, 'Page title'],
      ['paragraph', undefined, 'Body para.'],
      ['paragraph', undefined, LONG],
    ])
    expect(el(doc, 2).localName).toBe('td')
    assertInvariants(doc, blocks)
  })

  it('nav / aria-hidden / hidden / data-pc-hidden / script / style 整棵子树跳过', () => {
    const doc = parse(
      `<nav><p>${LONG}</p></nav>` +
        `<div aria-hidden="true"><p>${LONG}</p></div>` +
        `<div hidden><p>${LONG}</p></div>` +
        `<div data-pc-hidden><p>${LONG}</p></div>` +
        `<script>var x = "${LONG}"</script><style>p { color: red }</style>` +
        '<p>Visible.</p>',
    )
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([['paragraph', undefined, 'Visible.']])
  })

  it('泛型 div 不足 20 字跳过，p 只要有字母就成块；数字/标点不算字母', () => {
    const doc = parse('<div>short text</div><p>abc</p><p>123 — !</p><div>' + LONG + '</div>')
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([
      ['paragraph', undefined, 'abc'],
      ['paragraph', undefined, LONG],
    ])
    expect(el(doc, 1).localName).toBe('div')
  })

  it('minGenericChars 可配置', () => {
    const doc = parse('<div>ten chars!</div>')
    expect(stampBlocks(doc, { minGenericChars: 5 }).length).toBe(1)
    expect(stampBlocks(doc, { minGenericChars: 50 }).length).toBe(0)
  })

  it('pre 空白原样保留（text 即 hostText，不规整）', () => {
    const doc = parse('<pre>  line 1\n    line 2  \n</pre>')
    const blocks = stampBlocks(doc)
    expect(blocks[0].kind).toBe('code')
    expect(blocks[0].text).toBe('  line 1\n    line 2  \n')
    expect(el(doc, 0).textContent).toBe('  line 1\n    line 2  \n')
    assertInvariants(doc, blocks)
  })

  it('p 内的 code 子树原样、其余文本规整；[data-pc-pre] 元素整块原样', () => {
    const doc = parse('<p>  Run   <code>  npm   i </code>   now  </p><div data-pc-pre>  keep   this   exact   spacing   verbatim  </div>')
    const blocks = stampBlocks(doc)
    expect(blocks[0].text).toBe('Run   npm   i now')
    expect(blocks[1].text).toBe('  keep   this   exact   spacing   verbatim  ')
    assertInvariants(doc, blocks)
  })

  it('空白规整：NBSP/换行折成单空格，跨节点不留双空格，首尾空白剥掉', () => {
    const doc = parse('<p>\n  Hello  <b> big </b> \n world <i>\n</i>  </p>')
    const blocks = stampBlocks(doc)
    expect(blocks[0].text).toBe('Hello big world')
    // 末尾的纯空白节点清空后继续向内剥：`world ` 的尾空格也属于宿主尾部空白
    expect(el(doc, 0).innerHTML).toBe('Hello <b>big </b>world<i></i>')
    assertInvariants(doc, blocks)
  })

  it('normalizeBlockWhitespace 幂等', () => {
    const doc = parse('<p>  a \n b  <span> c </span> </p>')
    const p = doc.body.firstElementChild!
    normalizeBlockWhitespace(p)
    const once = p.innerHTML
    normalizeBlockWhitespace(p)
    expect(p.innerHTML).toBe(once)
    expect(hostText(p)).toBe('a b c')
  })

  it('p 内行内 svg / math / mjx-container / .katex 作为原子：p 仍是一个块，text 含它们的文本', () => {
    const doc = parse(
      '<p>Where <math><mi>x</mi><mo>=</mo><mn>1</mn></math> and <mjx-container class="MathJax"><mjx-assistive-mml><math><mi>y</mi></math></mjx-assistive-mml></mjx-container> ' +
        'plus <span class="katex"><span class="katex-mathml"><math><mi>z</mi></math></span></span> and <svg width="10" height="10"><title>ico</title></svg> end.</p>',
    )
    const blocks = stampBlocks(doc)
    expect(blocks.length).toBe(1)
    expect(blocks[0].kind).toBe('paragraph')
    expect(blocks[0].text).toBe('Where x=1 and y plus z and ico end.')
    expect(doc.querySelectorAll(`[${STAMP_ATTR}]`).length).toBe(1)
    assertInvariants(doc, blocks)
  })

  it('只含公式/图标的 div 不成段落（成块判定不计原子文本），但 svg 仍按独立图判定', () => {
    const doc = parse(
      '<div><mjx-container display="true"><mjx-assistive-mml><math><mi>a very long formula text here indeed</mi></math></mjx-assistive-mml></mjx-container></div>' +
        '<div><svg viewBox="0 0 400 300"><title>Big diagram</title></svg></div>',
    )
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([['image', undefined, '[图: Big diagram]']])
  })

  it('a 独占容器 ≥20 字成块（打在 a 上）；span 独占容器同理', () => {
    const doc = parse(`<div><a href="https://x.test">${LONG}</a></div><div><span>${LONG}</span></div>`)
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([
      ['paragraph', undefined, LONG],
      ['paragraph', undefined, LONG],
    ])
    // 容器（div）先于内层被判定为纯行内候选：打在 div 上
    expect(el(doc, 0).localName).toBe('div')
    const doc2 = parse(`<a href="https://x.test">${LONG}</a>`)
    const blocks2 = stampBlocks(doc2)
    expect(brief(blocks2)).toEqual([['paragraph', undefined, LONG]])
    expect(el(doc2, 0).localName).toBe('a')
    assertInvariants(doc2, blocks2)
  })

  it('短语元素内藏块级后代（<a><div>卡片</div></a>）→ 当作容器下探而非整体行内', () => {
    const doc = parse(`<div><a href="https://x.test"><div><h3>Card title</h3><p>${LONG}</p></div></a></div>`)
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([
      ['heading', 3, 'Card title'],
      ['paragraph', undefined, LONG],
    ])
    assertInvariants(doc, blocks)
  })

  it('空壳块级元素（锚点 div）不拆 run：h2 直接打在自身上', () => {
    const doc = parse('<h2><div class="anchor" id="x"></div>Heading text</h2>')
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([['heading', 2, 'Heading text']])
    expect(el(doc, 0).localName).toBe('h2')
    expect(doc.querySelector(`[${RUN_ATTR}]`)).toBeNull()
  })

  it('body 直接裸文本也成块（无 kind 容器的 run）', () => {
    const doc = parse(`${LONG}<p>para</p>`)
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([
      ['paragraph', undefined, LONG],
      ['paragraph', undefined, 'para'],
    ])
    expect(el(doc, 0).parentElement?.localName).toBe('body')
    assertInvariants(doc, blocks)
  })

  it('hostText 排除嵌套 [data-hl-host="zh"] 与 .pc-zh 子树', () => {
    const doc = parse(
      '<p>Original <b>text</b><div class="pc-zh" data-hl-host="zh">译文</div><span class="pc-zh">另一段译文</span><span data-hl-host="zh">x</span></p>',
    )
    // DOMParser 会把 <div> 从 <p> 里拆出去；用 DOM API 直接构造嵌套结构更可靠
    const p = doc.createElement('p')
    p.innerHTML = 'Original <b>text</b>'
    const zh = doc.createElement('div')
    zh.className = 'pc-zh'
    zh.setAttribute('data-hl-host', 'zh')
    zh.textContent = '译文'
    p.appendChild(zh)
    const zh2 = doc.createElement('span')
    zh2.className = 'pc-zh'
    zh2.textContent = '另一段译文'
    p.appendChild(zh2)
    const host = doc.createElement('span')
    host.setAttribute('data-hl-host', 'zh')
    host.textContent = 'x'
    p.appendChild(host)
    p.appendChild(doc.createTextNode(' tail'))
    expect(hostText(p)).toBe('Original text tail')
    // mark 包裹的高亮文本仍属于宿主原文
    p.innerHTML = 'Ori<mark data-highlight-id="h1">gin</mark>al'
    expect(hostText(p)).toBe('Original')
  })

  it('幂等：对已打标文档再跑一次，blocks 与 DOM 完全一致', () => {
    const html =
      `<h1>Title</h1><div>${LONG}<p>Inner.</p></div><ul><li>${LONG}<ul><li>Child</li></ul></li></ul>` +
      '<figure><img src="https://x.test/a.png" alt="A"><figcaption>Cap</figcaption></figure>' +
      '<table><tr><td>a</td></tr></table><pre> x  y </pre><p>  spaced   text </p>'
    const doc = parse(html)
    const first = stampBlocks(doc)
    const domAfterFirst = doc.body.innerHTML
    const second = stampBlocks(doc)
    expect(second).toEqual(first)
    expect(doc.body.innerHTML).toBe(domAfterFirst)
    assertInvariants(doc, second)
    // 与从未打标的同源文档等价
    expect(stampBlocks(parse(html))).toEqual(first)
  })

  it('综合不变式：混合真实页形态下索引连续、文档序、hostText === text', () => {
    const doc = parse(
      '<header><h1>Site</h1></header>' +
        '<nav><a href="/">Home link that is quite long</a></nav>' +
        '<main><article>' +
        `<h2 id="intro">Introduction</h2><p>${LONG}</p>` +
        `<div class="note">${LONG}<ul><li>Alpha item</li><li>Beta item<ol><li>Gamma item</li></ol></li></ul>${LONG}</div>` +
        '<figure><img src="https://x.test/f.png" alt="F"><figcaption>Cap F</figcaption></figure>' +
        '<table><tr><th>k</th><td>v</td></tr></table>' +
        '<pre><code>const a = 1;\n  const b = 2;</code></pre>' +
        '<blockquote>Quote <em>here</em></blockquote>' +
        '<dl><dt>Term</dt><dd>Definition text</dd></dl>' +
        '<details><summary>Summary line</summary><p>Details body.</p></details>' +
        '<p><svg width="16" height="16"><title>ic</title></svg> Icon led paragraph</p>' +
        '</article></main>' +
        '<footer><p>Footer text.</p></footer>',
    )
    const blocks = stampBlocks(doc)
    expect(brief(blocks)).toEqual([
      ['heading', 1, 'Site'],
      ['heading', 2, 'Introduction'],
      ['paragraph', undefined, LONG],
      ['paragraph', undefined, LONG],
      ['list', undefined, 'Alpha item'],
      ['list', undefined, 'Beta item'],
      ['list', undefined, 'Gamma item'],
      ['paragraph', undefined, LONG],
      ['image', undefined, '[图: F]'],
      ['caption', undefined, 'Cap F'],
      ['table', undefined, 'k | v'],
      ['code', undefined, 'const a = 1;\n  const b = 2;'],
      ['paragraph', undefined, 'Quote here'],
      ['paragraph', undefined, 'Term'],
      ['paragraph', undefined, 'Definition text'],
      ['paragraph', undefined, 'Summary line'],
      ['paragraph', undefined, 'Details body.'],
      ['paragraph', undefined, 'ic Icon led paragraph'],
      ['paragraph', undefined, 'Footer text.'],
    ])
    expect(blocks.map((b) => b.anchor.section).slice(0, 3)).toEqual(['Site', 'Introduction', 'Introduction'])
    expect(blocks[18].anchor.section).toBe('Introduction')
    assertInvariants(doc, blocks)
  })
})
