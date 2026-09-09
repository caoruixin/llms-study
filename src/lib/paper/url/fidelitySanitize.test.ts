// @vitest-environment happy-dom
// DOMPurify 需要真实 DOM。补丁与「一份输入只放一个会被删的元素」的写法同源于
// sanitize.test.ts / extractArticle.weixin.test.ts，原因见下面注释。
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * happy-dom 兼容性补丁：DOMPurify 3.4 用 `lookupGetter(Node.prototype, 'nodeName')` 做
 * realm 无关的标签名探针，而 happy-dom 把 `Node.prototype.nodeName` 写成恒返回 '' 的基类桩
 * （真正实现在 Element/Text 子类上）——不打补丁则每个标签名都读成空串，全部判为不在白名单。
 * 补丁必须在 dompurify 模块求值前生效，所以本文件对 ./fidelitySanitize 不做静态 import。
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

/**
 * 已知 happy-dom 限制：其 NodeIterator 未实现规范的 pre-removing steps，DOMPurify 删掉第一个
 * 节点后遍历会中断。因此每条「剥元素」的用例输入里只放一个会被删的元素（属性级用例不受影响）。
 */
let sanitizeFidelityDocumentHtml: (html: string) => string
let FIDELITY_FORBID_TAGS: string[]

beforeAll(async () => {
  const mod = await import('./fidelitySanitize')
  sanitizeFidelityDocumentHtml = mod.sanitizeFidelityDocumentHtml
  FIDELITY_FORBID_TAGS = mod.FIDELITY_FORBID_TAGS
})

/** 输入形态与生产一致：documentElement.outerHTML */
const doc = (head: string, body: string) => `<html lang="en"><head>${head}</head><body>${body}</body></html>`
const sanitizeBody = (body: string) => sanitizeFidelityDocumentHtml(doc('', body))

describe('sanitizeFidelityDocumentHtml：保留原貌', () => {
  it('输出以 <html 开头，整篇结构保留', () => {
    const out = sanitizeFidelityDocumentHtml(doc('<title>T</title>', '<p>正文</p>'))
    expect(out.startsWith('<html')).toBe(true)
    expect(out).toContain('<head>')
    expect(out).toContain('<title>T</title>')
    expect(out).toContain('<p>正文</p>')
  })

  it('保留 <style>（CSS 已用 escapeCssForMarkup 转义过 <）与 style 属性', () => {
    const out = sanitizeFidelityDocumentHtml(
      doc('<style media="screen">.a::before{content:"\\3c "}</style>', '<p style="color:red;font-size:14px">t</p>'),
    )
    expect(out).toContain('<style media="screen">.a::before{content:"\\3c "}</style>')
    expect(out).toContain('style="color:red;font-size:14px"')
  })

  it('未转义的裸 < 会让整个 <style> 被删——这就是 escapeCssForMarkup 存在的原因', () => {
    // SAFE_FOR_XML 的 ELEMENT_MARKUP_PROBE（purify.es.mjs:1564，/<[/\w!]/）同时命中
    // textContent 与 innerHTML 时整元素删除；<style> 是 raw text 元素，两者都是 CSS 原文。
    const raw = sanitizeFidelityDocumentHtml(doc('<style>.a{background:url(data:image/svg+xml,<svg/>)}</style>', '<p>t</p>'))
    expect(raw).not.toContain('<style')
    const escaped = sanitizeFidelityDocumentHtml(
      doc('<style>.a{background:url(data:image/svg+xml,\\3c svg/>)}</style>', '<p>t</p>'),
    )
    expect(escaped).toContain('\\3c svg/>')
  })

  it('保留内联 svg 与指向文档内锚点的 <use>', () => {
    const out = sanitizeBody('<svg viewBox="0 0 24 24"><use href="#icon-a"></use></svg>')
    expect(out).toContain('<svg')
    expect(out).toContain('viewBox="0 0 24 24"')
    expect(out).toContain('<use href="#icon-a">')
  })

  /**
   * MathML 在 happy-dom 下测不了「保留」：happy-dom 的 HTML 解析器不做 MathML 命名空间切换，
   * `<math>` 被建成 XHTML 命名空间（下面第一条断言就是证据，加 xmlns 属性也没用），
   * 于是 DOMPurify 的命名空间混淆防线（真实浏览器里 `<math>` 就是 MathML 命名空间，不会触发）
   * 会把它删掉。这里能证明的是「删除不来自本 profile 的配置」：math/mi/mo 既没进 FORBID_TAGS，
   * 也在 DOMPurify 默认 ALLOWED_TAGS（mathMl 集）里。真实浏览器行为归 E2E（arXiv HTML 用例）。
   */
  it('MathML：本 profile 不禁 math/mi/mo（happy-dom 无 MathML 命名空间，保留行为归 E2E）', () => {
    const parsed = new DOMParser().parseFromString('<html><body><math><mi>x</mi></math></body></html>', 'text/html')
    expect(parsed.querySelector('math')?.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    for (const tag of ['math', 'mi', 'mo', 'mn', 'msup', 'mfrac']) expect(FIDELITY_FORBID_TAGS).not.toContain(tag)
  })

  it('保留 MathJax CHTML 的 mjx-* 自定义元素与其属性', () => {
    const out = sanitizeBody('<mjx-container jax="CHTML" display="true"><mjx-c class="mjx-c31"></mjx-c></mjx-container>')
    expect(out).toContain('<mjx-container')
    expect(out).toContain('jax="CHTML"')
    expect(out).toContain('display="true"')
    expect(out).toContain('<mjx-c class="mjx-c31">')
  })

  it('保留 button/details/picture 与打标属性 data-pc-*、id、class', () => {
    const out = sanitizeBody(
      '<div data-pc-block="3" id="sec-1" class="wrap"><button type="button">展开</button>' +
        '<details><summary>更多</summary>内容</details>' +
        '<picture><img src="https://cdn.example/a.png" data-pc-asset="abc" alt="图" loading="lazy" width="320"></picture></div>',
    )
    expect(out).toContain('data-pc-block="3"')
    expect(out).toContain('id="sec-1"')
    expect(out).toContain('class="wrap"')
    expect(out).toContain('<button type="button">')
    expect(out).toContain('<details>')
    expect(out).toContain('<summary>')
    expect(out).toContain('<picture>')
    expect(out).toContain('data-pc-asset="abc"')
    expect(out).toContain('src="https://cdn.example/a.png"')
  })

  it('保留排版所需的非 URL 属性（窄 ALLOWED_URI_REGEXP 的连带伤害护栏）', () => {
    // 计划原文的 /^(?:https?:|mailto:|tel:|#)/i 会把这些值全判成「不合法 URI」而剥掉，
    // 原貌视图会塌成无样式的裸文本、SVG 变空白；FIDELITY_URI_REGEXP 因此多认「不带协议的值」。
    const out = sanitizeBody(
      '<table><tr><td colspan="2" rowspan="1" width="300" align="center">c</td></tr></table>' +
        '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M0 0L10 10" fill="red" stroke-width="2"></path></svg>' +
        '<p lang="zh-CN" dir="ltr" hidden>t</p>',
    )
    for (const attr of [
      'colspan="2"', 'rowspan="1"', 'width="300"', 'align="center"',
      'viewBox="0 0 10 10"', 'd="M0 0L10 10"', 'fill="red"', 'stroke-width="2"',
      'lang="zh-CN"', 'dir="ltr"', 'hidden',
    ]) expect(out).toContain(attr)
  })

  it('保留 data: 图片（自包含，无需外链）与 http(s)/锚点链接', () => {
    const out = sanitizeBody(
      '<img src="data:image/png;base64,iVBORw0KGgo="><a href="https://x.example/p">a</a><a href="#sec-1">b</a>',
    )
    expect(out).toContain('src="data:image/png;base64,iVBORw0KGgo="')
    expect(out).toContain('href="https://x.example/p"')
    expect(out).toContain('href="#sec-1"')
  })
})

describe('sanitizeFidelityDocumentHtml：剥执行面与外链装载面', () => {
  it('剥 script', () => {
    const out = sanitizeBody('<p>t</p><script>alert(1)</script>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert(1)')
  })

  it('剥事件属性 on*', () => {
    const out = sanitizeBody('<p onclick="alert(1)" onload="alert(2)" onmouseover="x()">t</p>')
    expect(out).not.toMatch(/onclick|onload|onmouseover/)
    expect(out).toContain('<p>t</p>')
  })

  it('剥 href="javascript:"，元素本身保留', () => {
    const out = sanitizeBody('<a href="javascript:alert(1)">x</a>')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('<a>x</a>')
  })

  it('剥 iframe', () => {
    expect(sanitizeBody('<iframe src="https://evil.example/"></iframe><p>t</p>')).not.toContain('<iframe')
  })

  it('剥 object', () => {
    expect(sanitizeBody('<object data="https://evil.example/x.swf"></object><p>t</p>')).not.toContain('<object')
  })

  // form 与 input 分成两条：happy-dom 的 NodeIterator 在删掉第一个元素后会中断（见文件头注），
  // 同一份输入里放两个待删元素只会验到第一个。
  it('剥 form', () => {
    expect(sanitizeBody('<form action="https://evil.example/"><p>t</p></form>')).not.toContain('<form')
  })

  it('剥 input', () => {
    expect(sanitizeBody('<p>t</p><input name="q" value="v">')).not.toContain('<input')
  })

  it('剥 link（样式表已在打包时内联成 <style>）', () => {
    const out = sanitizeFidelityDocumentHtml(doc('<link rel="stylesheet" href="https://cdn.example/a.css">', '<p>t</p>'))
    expect(out).not.toContain('<link')
  })

  it('剥 meta', () => {
    expect(sanitizeFidelityDocumentHtml(doc('<meta http-equiv="refresh" content="0;url=https://evil.example/">', '<p>t</p>')))
      .not.toContain('<meta')
  })

  it('剥 base（否则会改写整篇相对 URL 的基准）', () => {
    expect(sanitizeFidelityDocumentHtml(doc('<base href="https://evil.example/">', '<p>t</p>'))).not.toContain('<base')
  })

  it('剥 video（预处理已换成 poster 图或占位）', () => {
    const out = sanitizeBody('<video src="https://x.example/a.mp4" poster="https://x.example/p.png"></video>')
    expect(out).not.toContain('<video')
  })

  it('剥 foreignObject（SVG 里重开 HTML 命名空间的 mXSS 面）', () => {
    const out = sanitizeBody('<svg><foreignObject><p>x</p></foreignObject></svg>')
    expect(out).not.toMatch(/foreignobject/i)
    expect(out).toContain('<svg>')
  })

  it('剥跨站 sprite 的 use[href]（只留文档内锚点）', () => {
    const out = sanitizeBody('<svg><use href="https://cdn.example/sprite.svg#i"></use></svg>')
    expect(out).toContain('<use>')
    expect(out).not.toContain('sprite.svg')
  })

  it('剥 srcset/sizes（快照只固化 currentSrc 那一张）', () => {
    const out = sanitizeBody('<img src="https://x.example/a.png" srcset="https://x.example/a2.png 2x" sizes="100vw">')
    expect(out).not.toContain('srcset')
    expect(out).not.toContain('sizes')
    expect(out).toContain('src="https://x.example/a.png"')
  })

  it('剥 style 属性里的 expression()/url(javascript:)', () => {
    expect(sanitizeBody('<p style="width:expression(1)">t</p>')).not.toContain('expression(')
    expect(sanitizeBody('<p style="background:url(javascript:alert(1))">t</p>')).not.toContain('javascript:')
  })

  it('剥非 http(s)/mailto/tel/# 协议的链接与图片（含协议相对与 data:text/html）', () => {
    expect(sanitizeBody('<a href="ftp://x.example/f">t</a>')).not.toContain('ftp:')
    expect(sanitizeBody('<a href="//evil.example/x">t</a>')).not.toContain('evil.example')
    expect(sanitizeBody('<img src="data:text/html;base64,PHNjcmlwdD4=">')).not.toContain('data:text/html')
  })

  it('FIDELITY_FORBID_TAGS 是冻结契约的一部分（阅读器 CSP 与之互为纵深）', () => {
    expect(FIDELITY_FORBID_TAGS).toContain('script')
    expect(FIDELITY_FORBID_TAGS).toContain('iframe')
    expect(FIDELITY_FORBID_TAGS).toContain('canvas')
    expect(FIDELITY_FORBID_TAGS).not.toContain('style')
  })
})
