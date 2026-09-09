// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SHEET_ATTR,
  captureDocument,
  captureStatic,
  detectMathDelimiters,
  preprocessFidelity,
  resolveDocumentBase,
} from './captureStatic'

/**
 * KaTeX auto-render 的替身：不真的排版（happy-dom 下 katex 的 DOM 依赖不可靠，且渲染正确性不是
 * 本模块的职责），只模拟其**输出形态**——把含 `\(` 的文本节点换成 KaTeX 典型结构
 * （.katex > .katex-mathml(math > annotation) + .katex-html），好断言渲染后的清理步骤。
 */
interface RenderOpts {
  delimiters: { left: string; right: string; display: boolean }[]
}

const renderMock = vi.fn((elem: HTMLElement, _opts?: RenderOpts) => {
  const doc = elem.ownerDocument
  const walker: Text[] = []
  const collect = (n: Node): void => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) walker.push(c as Text)
      else collect(c)
    }
  }
  collect(elem)
  for (const t of walker) {
    if (!t.data.includes('\\(')) continue
    const span = doc.createElement('span')
    span.className = 'katex'
    span.innerHTML =
      '<span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x</annotation></semantics></math></span>' +
      '<span class="katex-html" aria-hidden="true">x</span>'
    t.replaceWith(span)
  }
})

vi.mock('katex/contrib/auto-render', () => ({ default: renderMock }))

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')
const page = (head: string, body: string): string => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

const FINAL = 'https://arxiv.org/html/2412.06464v1'

beforeEach(() => {
  renderMock.mockClear()
})

describe('preprocessFidelity：URL 绝对化', () => {
  it('尊重 <base href>（相对 finalUrl 解析），图片/链接按它绝对化，<base> 本身删除，页内锚点保留', () => {
    const doc = parse(page('<base href="/papers/2412/">', '<img src="x1.png"><a href="../other">o</a><a href="#sec1">s</a><a href="mailto:a@b.c">m</a>'))
    expect(resolveDocumentBase(doc, FINAL)).toBe('https://arxiv.org/papers/2412/')
    preprocessFidelity(doc, FINAL)
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('https://arxiv.org/papers/2412/x1.png')
    const hrefs = Array.from(doc.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(['https://arxiv.org/papers/other', '#sec1', 'mailto:a@b.c'])
    expect(doc.querySelector('base')).toBeNull()
  })

  it('无 <base> 时相对 finalUrl；poster / svg image / use[href 非 #] 一并绝对化，use[href=#] 不动', () => {
    const doc = parse(
      page(
        '',
        '<video poster="p.jpg"></video><svg><image href="i.png"></image><use href="#icon"></use><use xlink:href="sprite.svg#a"></use></svg>',
      ),
    )
    preprocessFidelity(doc, FINAL)
    // video 已换成 poster 图
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('https://arxiv.org/html/p.jpg')
    expect(doc.querySelector('image')?.getAttribute('href')).toBe('https://arxiv.org/html/i.png')
    const uses = Array.from(doc.querySelectorAll('use'))
    expect(uses[0].getAttribute('href')).toBe('#icon')
    expect(uses[1].getAttribute('xlink:href')).toBe('https://arxiv.org/html/sprite.svg#a')
  })
})

describe('preprocessFidelity：图片', () => {
  it('懒加载提升：src 为空/占位 data: 时取 data-src / data-lazy-src / data-srcset 首候选；srcset/sizes 删除', () => {
    const doc = parse(
      page(
        '',
        '<img src="" data-src="/img/a.png">' +
          '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-lazy-src="b.png" srcset="b-2x.png 2x" sizes="100vw">' +
          '<img data-srcset="c-400.png 400w, c-800.png 800w">' +
          '<img src="real.png" data-src="ignored.png">',
      ),
    )
    preprocessFidelity(doc, 'https://site.test/dir/page')
    const srcs = Array.from(doc.querySelectorAll('img')).map((i) => i.getAttribute('src'))
    expect(srcs).toEqual([
      'https://site.test/img/a.png',
      'https://site.test/dir/b.png',
      'https://site.test/dir/c-400.png',
      'https://site.test/dir/real.png',
    ])
    expect(doc.querySelector('[srcset], [sizes]')).toBeNull()
  })

  it('picture 只留 img；img 无 src 时退到首个 source 的 srcset 首候选', () => {
    const doc = parse(
      page(
        '',
        '<picture><source srcset="a.webp" type="image/webp"><img src="a.jpg" alt="A"></picture>' +
          '<picture><source srcset="b.avif 1x, b-2x.avif 2x"><img alt="B"></picture>',
      ),
    )
    preprocessFidelity(doc, 'https://site.test/p/')
    expect(doc.querySelector('picture, source')).toBeNull()
    const imgs = Array.from(doc.querySelectorAll('img'))
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['https://site.test/p/a.jpg', 'https://site.test/p/b.avif'])
    expect(imgs[0].getAttribute('alt')).toBe('A')
  })
})

describe('preprocessFidelity：媒体占位', () => {
  it('video 有 poster → img；无 poster → [视频：文件名] 占位；audio → [音频]', () => {
    const doc = parse(
      page(
        '',
        '<video poster="/cover.jpg" width="640"><source src="a.mp4"></video>' +
          '<video><source src="/media/talk%20intro.mp4" type="video/mp4"></video>' +
          '<video src="clip.webm"></video>' +
          '<audio src="a.mp3"></audio>',
      ),
    )
    preprocessFidelity(doc, 'https://site.test/x/')
    expect(doc.querySelector('video, audio, source')).toBeNull()
    const img = doc.querySelector('img')!
    expect(img.getAttribute('src')).toBe('https://site.test/cover.jpg')
    expect(img.getAttribute('width')).toBe('640')
    const placeholders = Array.from(doc.querySelectorAll('.pc-placeholder'))
    expect(placeholders.map((p) => [p.getAttribute('data-pc-placeholder'), p.textContent])).toEqual([
      ['video', '[视频：talk intro.mp4]'],
      ['video', '[视频：clip.webm]'],
      ['audio', '[音频]'],
    ])
  })

  it('iframe/object/embed/canvas → [嵌入内容] 占位；1×1 / hidden 的 iframe 与 canvas 直接删', () => {
    const doc = parse(
      page(
        '',
        '<iframe src="https://www.youtube.com/embed/x"></iframe><iframe src="https://t.co/px" width="1" height="1"></iframe>' +
          '<object data="a.swf"></object><embed src="b.swf"><canvas width="300" height="150"></canvas><canvas hidden></canvas>',
      ),
    )
    preprocessFidelity(doc, 'https://site.test/')
    expect(doc.querySelector('iframe, object, embed, canvas')).toBeNull()
    const kinds = Array.from(doc.querySelectorAll('.pc-placeholder')).map((p) => p.getAttribute('data-pc-placeholder'))
    expect(kinds).toEqual(['embed', 'embed', 'embed', 'canvas'])
    expect(doc.querySelectorAll('.pc-placeholder')[0].textContent).toBe('[嵌入内容]')
  })
})

describe('preprocessFidelity：删噪与样式表', () => {
  it('annotation / annotation-xml 连内容一起删，<math> 主体保留', () => {
    const doc = parse(
      page(
        '',
        '<math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x^2</annotation><annotation-xml encoding="MathML-Content"><ci>x</ci></annotation-xml></semantics></math>',
      ),
    )
    preprocessFidelity(doc, 'https://site.test/')
    expect(doc.querySelector('annotation, annotation-xml')).toBeNull()
    expect(doc.querySelector('math mi')?.textContent).toBe('x')
    expect(doc.body.textContent).not.toContain('x^2')
  })

  it('rel=stylesheet 标 data-pc-sheet 且 href 绝对化、media 保留；icon/preload/alternate/disabled 删除；meta/script/noscript/template 删除', () => {
    const doc = parse(
      page(
        '<meta charset="utf-8"><title>T</title>' +
          '<link rel="stylesheet" href="/css/main.css" media="screen">' +
          '<link rel="icon" href="/favicon.ico"><link rel="preload" as="font" href="/f.woff2">' +
          '<link rel="alternate stylesheet" href="/dark.css"><link rel="stylesheet" href="/off.css" disabled>' +
          '<link rel="stylesheet" href="chrome-extension://abc/x.css">' +
          '<script src="/app.js"></script><script>window.x = 1</script>',
        '<noscript><img src="px.gif"></noscript><template><p>t</p></template><p>body</p>',
      ),
    )
    preprocessFidelity(doc, 'https://site.test/a/b')
    const links = Array.from(doc.querySelectorAll('link'))
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('href')).toBe('https://site.test/css/main.css')
    expect(links[0].getAttribute(SHEET_ATTR)).toBe('1')
    expect(links[0].getAttribute('media')).toBe('screen')
    expect(doc.querySelector('meta, script, noscript, template')).toBeNull()
    expect(doc.querySelector('title')?.textContent).toBe('T')
    expect(doc.querySelector('p')?.textContent).toBe('body')
  })

  it('捕获代理形态的 <link data-pc-sheet href>（无 rel）视为样式表保留——Tier 2 产物再过一遍不丢样式', () => {
    const doc = parse(page('<link data-pc-sheet="" href="https://site.test/agent.css">', '<p>x</p>'))
    preprocessFidelity(doc, 'https://site.test/')
    const link = doc.querySelector('link')!
    expect(link.getAttribute('href')).toBe('https://site.test/agent.css')
    expect(link.hasAttribute(SHEET_ATTR)).toBe(true)
  })
})

describe('detectMathDelimiters', () => {
  it('MathJax v3 内联配置：按 inlineMath / displayMath', () => {
    const doc = parse(
      page(
        `<script>window.MathJax = { tex: { inlineMath: [['$', '$'], ['\\\\(', '\\\\)']], displayMath: [['$$', '$$']] } };</script>`,
        '<p>no math text</p>',
      ),
    )
    expect(detectMathDelimiters(doc)).toEqual({ inline: [['$', '$'], ['\\(', '\\)']], display: [['$$', '$$']] })
  })

  it('MathJax v2 tex2jax 配置：只写了 inlineMath 时 displayMath 用 MathJax 默认', () => {
    const doc = parse(
      page(
        `<script type="text/x-mathjax-config">MathJax.Hub.Config({ tex2jax: { inlineMath: [["$","$"]], processEscapes: true } });</script>`,
        '<p>x</p>',
      ),
    )
    expect(detectMathDelimiters(doc)).toEqual({ inline: [['$', '$']], display: [['$$', '$$'], ['\\[', '\\]']] })
  })

  it('KaTeX auto-render 的 delimiters 配置：display:true 归 display', () => {
    const doc = parse(
      page(
        `<script>renderMathInElement(document.body, { delimiters: [{left: "$$", right: "$$", display: true}, {left: "\\\\(", right: "\\\\)", display: false}] });</script>`,
        '<p>x</p>',
      ),
    )
    expect(detectMathDelimiters(doc)).toEqual({ inline: [['\\(', '\\)']], display: [['$$', '$$']] })
  })

  it('无配置但正文含 \\( → MathJax 默认分隔符；既无配置也无分隔符 → null', () => {
    const withMath = parse(page('', '<p>令 \\(x\\) 为变量</p>'))
    expect(detectMathDelimiters(withMath)).toEqual({ inline: [['\\(', '\\)']], display: [['$$', '$$'], ['\\[', '\\]']] })
    const noMath = parse(page('<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>', '<p>plain</p>'))
    expect(detectMathDelimiters(noMath)).toBeNull()
  })
})

describe('captureStatic', () => {
  it('默认不跑 KaTeX：katex=false 且不 import auto-render', async () => {
    const out = await captureStatic({ html: page('<title>T</title>', '<p>令 \\(x\\) 为变量</p>'), finalUrl: 'https://site.test/p' })
    expect(out.mode).toBe('static')
    expect(out.katex).toBe(false)
    expect(renderMock).not.toHaveBeenCalled()
    expect(out.doc.body.textContent).toContain('\\(x\\)')
  })

  it('katex:true 且检测到分隔符 → 渲染、katex=true；渲染后 annotation 与 .katex-mathml 被删、.katex-html 保留', async () => {
    const out = await captureStatic({ html: page('<title>T</title>', '<p>令 \\(x\\) 为变量</p>'), finalUrl: 'https://site.test/p', katex: true })
    expect(renderMock).toHaveBeenCalledTimes(1)
    // 分隔符来自正文探测（默认集）：display 在前、inline 在后
    const opts = renderMock.mock.calls[0][1]
    expect(opts?.delimiters.map((d) => [d.left, d.right, d.display])).toEqual([
      ['$$', '$$', true],
      ['\\[', '\\]', true],
      ['\\(', '\\)', false],
    ])
    expect(out.katex).toBe(true)
    expect(out.doc.querySelector('.katex')).not.toBeNull()
    expect(out.doc.querySelector('annotation')).toBeNull()
    expect(out.doc.querySelector('.katex-mathml')).toBeNull()
    expect(out.doc.querySelector('.katex-html')?.textContent).toBe('x')
  })

  it('katex:true 但页面没有公式 → 不 import auto-render，katex=false', async () => {
    const out = await captureStatic({ html: page('', '<p>plain text</p>'), finalUrl: 'https://site.test/p', katex: true })
    expect(renderMock).not.toHaveBeenCalled()
    expect(out.katex).toBe(false)
  })

  it('标题：<title> → h1 → hostname+path；baseUrl 随结果带出', async () => {
    const a = await captureStatic({ html: page('<title> 标 题 </title>', '<h1>H</h1>'), finalUrl: 'https://site.test/p' })
    expect(a.title).toBe('标 题')
    const b = await captureStatic({ html: page('<base href="/root/">', '<h1> 一级  标题 </h1>'), finalUrl: 'https://site.test/p' })
    expect(b.title).toBe('一级 标题')
    expect(b.baseUrl).toBe('https://site.test/root/')
    const c = await captureStatic({ html: page('', '<p>x</p>'), finalUrl: 'https://site.test/docs/intro' })
    expect(c.title).toBe('site.test/docs/intro')
    expect(c.finalUrl).toBe('https://site.test/docs/intro')
  })
})

describe('captureDocument（rendered 模式）', () => {
  it('页面已有 mjx-container 时跳过 KaTeX，标题优先取捕获代理带回的值', async () => {
    const out = await captureDocument({
      html: page('<title>doc</title>', '<p>见 \\(y\\)</p><mjx-container jax="CHTML"><mjx-math></mjx-math></mjx-container>'),
      finalUrl: 'https://site.test/p',
      katex: true,
      mode: 'rendered',
      title: ' 代理标题 ',
    })
    expect(out.mode).toBe('rendered')
    expect(out.title).toBe('代理标题')
    expect(renderMock).not.toHaveBeenCalled()
    expect(out.katex).toBe(false)
  })
})
