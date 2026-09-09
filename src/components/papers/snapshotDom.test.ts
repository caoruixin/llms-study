// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest'
import type { NormalizedBlock, PaperHighlight } from '../../lib/paper/types'
import type { WebSnapshotHeader, WebSnapshotInput } from '../../lib/paper/url/webSnapshot'

/**
 * happy-dom 兼容性补丁：与 stampBlocks.test.ts / extractArticle.weixin.test.ts 同源
 * （DOMPurify 3.4 依赖 Node.prototype.nodeName getter，happy-dom 的基类桩恒返回 ''）。
 * snapshotDom 静态 import stampBlocks（→ sanitize → dompurify），补丁必须先于模块求值，故走 beforeAll 动态 import。
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

type Mod = typeof import('./snapshotDom')
let mod: Mod
let hostText: (host: Element) => string
let encodeWebSnapshot: typeof import('../../lib/paper/url/webSnapshot')['encodeWebSnapshot']
let decodeWebSnapshot: typeof import('../../lib/paper/url/webSnapshot')['decodeWebSnapshot']

beforeAll(async () => {
  mod = await import('./snapshotDom')
  ;({ hostText } = await import('../../lib/paper/url/stampBlocks'))
  ;({ encodeWebSnapshot, decodeWebSnapshot } = await import('../../lib/paper/url/webSnapshot'))
})

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const BLOCKS: NormalizedBlock[] = [
  { index: 0, kind: 'heading', level: 1, text: 'Title', anchor: { kind: 'html', blockIndex: 0 } },
  { index: 1, kind: 'paragraph', text: 'Hello world', anchor: { kind: 'html', blockIndex: 1, section: 'Title' } },
  { index: 2, kind: 'image', text: '[图: x]', src: 'https://a.com/b.png', anchor: { kind: 'html', blockIndex: 2, section: 'Title' } },
  { index: 3, kind: 'table', text: 'a | b', html: '<table><tr><td>a</td><td>b</td></tr></table>', anchor: { kind: 'html', blockIndex: 3, section: 'Title' } },
]

const HTML =
  '<html><head><title>t</title><style>.a{background:url("pc-asset:aaa")}.b{min-height:100vh}</style></head>' +
  '<body><h1 data-pc-block="0">Title</h1><p data-pc-block="1" style="height:50vh">Hello <b>wor</b>ld</p>' +
  '<img data-pc-block="2" data-pc-asset="bbb" src="https://a.com/b.png" alt="x">' +
  '<table data-pc-block="3"><tr><td>a</td><td>b</td></tr></table>' +
  '<a id="l1" href="#sec">frag</a></body></html>'

function fixtureHeader(katex = false): WebSnapshotHeader {
  const input: WebSnapshotInput = {
    header: {
      url: 'https://a.com/page',
      finalUrl: 'https://a.com/page?x=1',
      title: 'A',
      capture: { mode: 'rendered', katex, viewportWidth: 1280, agentVersion: 1 },
      html: HTML,
      blocks: BLOCKS,
      stats: { assetBytes: 0, skipped: [] },
    },
    assets: [
      { id: 'aaa', url: 'https://a.com/a.css', mime: 'text/css', bytes: new Uint8Array([1]) },
      { id: 'bbb', url: 'https://a.com/b.png', mime: 'image/png', bytes: new Uint8Array([2, 3]) },
    ],
  }
  const { bytes } = encodeWebSnapshot(input)
  return decodeWebSnapshot(bytes).header
}

const parseDoc = (srcdoc: string): Document => new DOMParser().parseFromString(srcdoc, 'text/html')

const parseBody = (body: string): Document =>
  new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${body}</body></html>`, 'text/html')

const hl = (id: string, blockIndex: number, lang: 'orig' | 'zh', start: number, end: number, text: string): PaperHighlight => ({
  id,
  paperId: 'p1',
  blockIndex,
  blockId: `p1:${blockIndex}`,
  lang,
  start,
  end,
  text,
  createdAt: 1,
})

// ---------------------------------------------------------------------------
// buildReaderSrcdoc
// ---------------------------------------------------------------------------

describe('buildReaderSrcdoc', () => {
  it('doctype + 样式占位与 img 资源水合成 blob；无 blob 的资源保留原 https', () => {
    const header = fixtureHeader()
    const urls: Record<string, string> = { aaa: 'blob:http://x/aaa' }
    const srcdoc = mod.buildReaderSrcdoc(header, (id) => urls[id] ?? null)
    expect(srcdoc.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(srcdoc).toContain('url("blob:http://x/aaa")')
    expect(srcdoc).not.toContain('pc-asset:aaa')
    // bbb 没有 blob：img src 保留原 https 兜底
    expect(srcdoc).toContain('src="https://a.com/b.png"')

    const hydrated = mod.buildReaderSrcdoc(header, (id) => (id === 'bbb' ? 'blob:http://x/bbb' : null))
    expect(hydrated).toContain('src="blob:http://x/bbb"')
    // 没有 blob 的 CSS 占位原样保留（不写成 url("")）
    expect(hydrated).toContain('pc-asset:aaa')
  })

  it('CSP meta 在 head 最前，阅读器样式在 head 末尾', () => {
    const doc = parseDoc(mod.buildReaderSrcdoc(fixtureHeader(), () => null))
    const head = doc.head
    const first = head.firstElementChild
    expect(first?.localName).toBe('meta')
    expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(first?.getAttribute('content')).toBe(mod.READER_CSP)
    expect(mod.READER_CSP).toContain("default-src 'none'")
    expect(mod.READER_CSP).toContain("frame-src 'none'")
    expect(mod.READER_CSP).not.toContain('script-src')
    const last = head.lastElementChild
    expect(last?.localName).toBe('style')
    expect(last?.id).toBe(mod.READER_STYLE_ID)
    expect(last?.textContent).toContain('.pc-zh')
    expect(last?.textContent).toContain('.paper-flash')
    expect(last?.textContent).toContain('[data-pc-fixed]')
  })

  it('打标元素镜像 data-block-index；文本块带 data-hl-host=orig，image/table 不带', () => {
    const doc = parseDoc(mod.buildReaderSrcdoc(fixtureHeader(), () => null))
    const h1 = doc.querySelector('[data-pc-block="0"]')!
    const p = doc.querySelector('[data-pc-block="1"]')!
    const img = doc.querySelector('[data-pc-block="2"]')!
    const table = doc.querySelector('[data-pc-block="3"]')!
    expect(h1.getAttribute('data-block-index')).toBe('0')
    expect(p.getAttribute('data-block-index')).toBe('1')
    expect(img.getAttribute('data-block-index')).toBe('2')
    expect(table.getAttribute('data-block-index')).toBe('3')
    expect(h1.getAttribute('data-hl-host')).toBe('orig')
    expect(p.getAttribute('data-hl-host')).toBe('orig')
    expect(img.hasAttribute('data-hl-host')).toBe(false)
    expect(table.hasAttribute('data-hl-host')).toBe(false)
    // id 不动：快照里没有 paper-block-N 这种 id
    expect(p.id).toBe('')
  })

  it('KaTeX 样式只在 capture.katex 为真且给了 href 时注入', () => {
    const on = parseDoc(mod.buildReaderSrcdoc(fixtureHeader(true), () => null, { katexCssHref: 'https://x/katex.css' }))
    expect(on.querySelector('link[rel="stylesheet"][href="https://x/katex.css"]')).not.toBeNull()
    const off = parseDoc(mod.buildReaderSrcdoc(fixtureHeader(false), () => null, { katexCssHref: 'https://x/katex.css' }))
    expect(off.querySelector('link[rel="stylesheet"]')).toBeNull()
    const noHref = parseDoc(mod.buildReaderSrcdoc(fixtureHeader(true), () => null))
    expect(noHref.querySelector('link[rel="stylesheet"]')).toBeNull()
  })

  it('给了参考视口高度时，<style> 与 style 属性里的 vh 钉成 px（自适应高度 iframe 的回环根因）', () => {
    const srcdoc = mod.buildReaderSrcdoc(fixtureHeader(), () => null, { viewportHeightPx: 800 })
    expect(srcdoc).toContain('min-height:800px')
    expect(srcdoc).toContain('style="height:400px"')
    expect(srcdoc).not.toMatch(/\dvh/)
  })
})

describe('neutralizeViewportUnits', () => {
  it('vh/dvh/svh/lvh → px；vmin/vmax → min()/max() 混 vw；无 vh 的原样返回', () => {
    expect(mod.neutralizeViewportUnits('a{height:100vh;top:.5dvh;b:20svh;c:1.5lvh}', 700)).toBe(
      'a{height:700px;top:3.5px;b:140px;c:10.5px}',
    )
    expect(mod.neutralizeViewportUnits('a{w:50vmin;h:50vmax}', 800)).toBe('a{w:min(50vw, 400px);h:max(50vw, 400px)}')
    const plain = 'a{width:100vw;height:100%}'
    expect(mod.neutralizeViewportUnits(plain, 800)).toBe(plain)
  })

  it('只改声明值：Tailwind 转义选择器 `\\[100dvh\\]` 原样，声明里的 100dvh 才钉成 px', () => {
    const css = String.raw`.min-h-\[100dvh\]{min-height:100dvh}.h-\[calc\(100vh-4rem\)\]{height:calc(100vh - 4rem)}`
    expect(mod.neutralizeViewportUnits(css, 720)).toBe(
      String.raw`.min-h-\[100dvh\]{min-height:720px}.h-\[calc\(100vh-4rem\)\]{height:calc(720px - 4rem)}`,
    )
  })

  it('url(data:…base64) 载荷与字符串里的 `9vh/` 形态不碰', () => {
    const css = '.a{background:url(data:image/png;base64,AAAA9vh/BBBB+9VH=);content:"100vh";height:10vh}'
    expect(mod.neutralizeViewportUnits(css, 720)).toBe(
      '.a{background:url(data:image/png;base64,AAAA9vh/BBBB+9VH=);content:"100vh";height:72px}',
    )
  })

  it('嵌套 @media 里的声明照改', () => {
    expect(mod.neutralizeViewportUnits('@media screen{.a{height:100vh}.b{top:50vmin}}', 720)).toBe(
      '@media screen{.a{height:720px}.b{top:min(50vw, 360px)}}',
    )
  })
})

// ---------------------------------------------------------------------------
// applyLangState
// ---------------------------------------------------------------------------

const P_BLOCK: NormalizedBlock[] = [
  { index: 0, kind: 'paragraph', text: 'Hello world', anchor: { kind: 'html', blockIndex: 0 } },
  { index: 1, kind: 'image', text: '[图]', anchor: { kind: 'html', blockIndex: 1 } },
]
const P_HTML = '<p data-pc-block="0" data-block-index="0" data-hl-host="orig">Hello <b>wor</b>ld</p><img data-pc-block="1" data-block-index="1">'

describe('applyLangState', () => {
  it('orig → both → zh → orig：宿主 innerHTML 完全复原；both 下原始节点不动', () => {
    const doc = parseBody(P_HTML)
    const p = doc.querySelector('[data-pc-block="0"]')!
    const original = p.innerHTML
    const firstText = p.firstChild

    mod.applyLangState(doc, P_BLOCK, { langMode: 'orig' })
    expect(p.innerHTML).toBe(original)

    mod.applyLangState(doc, P_BLOCK, { langMode: 'both', translations: new Map([[0, '你好世界']]) })
    const zh = p.querySelector('.pc-zh')!
    expect(zh).not.toBeNull()
    expect(zh.parentElement).toBe(p)
    expect(zh.getAttribute('data-hl-host')).toBe('zh')
    expect(zh.getAttribute('data-translated')).toBe('zh')
    expect(zh.getAttribute('lang')).toBe('zh-CN')
    expect(zh.textContent).toBe('你好世界')
    // 原始节点零改动：仍是同一个文本节点，且译文之前的 HTML 与原来逐字相同
    expect(p.firstChild).toBe(firstText)
    expect(p.innerHTML.startsWith(original)).toBe(true)
    expect(p.querySelector('.pc-orig')).toBeNull()

    mod.applyLangState(doc, P_BLOCK, { langMode: 'zh', translations: new Map([[0, '你好世界']]) })
    const wrapper = p.querySelector('.pc-orig')!
    expect(wrapper).not.toBeNull()
    expect(wrapper.hasAttribute('hidden')).toBe(true)
    expect(wrapper.innerHTML).toBe(original)
    expect(wrapper.nextElementSibling?.classList.contains('pc-zh')).toBe(true)
    // 同一译文不重建译文节点
    expect(p.querySelector('.pc-zh')).toBe(zh)

    mod.applyLangState(doc, P_BLOCK, { langMode: 'orig' })
    expect(p.innerHTML).toBe(original)
    expect(p.firstChild).toBe(firstText)
    // image 块从头到尾没被碰
    expect(doc.querySelector('[data-pc-block="1"]')!.outerHTML).toBe('<img data-pc-block="1" data-block-index="1">')
  })

  it('zh → both 只解包不重建；both 下 hostText 排除译文', () => {
    const doc = parseBody(P_HTML)
    const p = doc.querySelector('[data-pc-block="0"]')!
    mod.applyLangState(doc, P_BLOCK, { langMode: 'zh', translations: new Map([[0, '你好世界']]) })
    const zh = p.querySelector('.pc-zh')
    mod.applyLangState(doc, P_BLOCK, { langMode: 'both', translations: new Map([[0, '你好世界']]) })
    expect(p.querySelector('.pc-orig')).toBeNull()
    expect(p.querySelector('.pc-zh')).toBe(zh)
    expect(hostText(p)).toBe('Hello world')
    expect(p.textContent).toBe('Hello world你好世界')
  })

  it('骨架 / 失败 chip / 授权引导：chip 不带 hl-host，重试按钮带块序号，设置页链接带 data-pc-nav', () => {
    const doc = parseBody(P_HTML)
    const p = doc.querySelector('[data-pc-block="0"]')!

    mod.applyLangState(doc, P_BLOCK, { langMode: 'both' })
    expect(p.querySelector('.pc-zh > .pc-skel')).not.toBeNull()
    expect(p.querySelector('.pc-zh')!.hasAttribute('data-hl-host')).toBe(false)

    mod.applyLangState(doc, P_BLOCK, { langMode: 'both', failed: new Set([0]) })
    expect(p.querySelector('.pc-skel')).toBeNull()
    const fail = p.querySelector('.pc-zh > .pc-fail')!
    expect(fail.textContent).toContain('这一段翻译失败')
    expect(fail.querySelector('button[data-pc-retry="0"]')?.textContent).toBe('重试')
    expect(fail.querySelector('[data-pc-nav]')).toBeNull()

    mod.applyLangState(doc, P_BLOCK, { langMode: 'both', failed: new Set([0]), authIssue: 'no-user-key' })
    const auth = p.querySelector('.pc-zh > .pc-fail')!
    expect(auth.textContent).toContain('尚未配置 DeepSeek Key')
    expect(auth.querySelector('a[data-pc-nav="/settings"]')?.textContent).toBe('去设置页配置')

    mod.applyLangState(doc, P_BLOCK, { langMode: 'both', failed: new Set([0]), authIssue: 'unauthenticated' })
    expect(p.querySelector('.pc-fail')!.textContent).toContain('登录已过期')
    expect(p.querySelector('[data-pc-nav]')).toBeNull()

    // zh 模式失败：原文可见（不包 .pc-orig）+ chip，与 BlockReader 同语义
    mod.applyLangState(doc, P_BLOCK, { langMode: 'zh', failed: new Set([0]) })
    expect(p.querySelector('.pc-orig')).toBeNull()
    expect(p.querySelector('.pc-fail')).not.toBeNull()
    // zh 模式骨架：原文藏起来
    mod.applyLangState(doc, P_BLOCK, { langMode: 'zh' })
    expect(p.querySelector('.pc-orig[hidden]')).not.toBeNull()
    expect(p.querySelector('.pc-skel')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// applyHighlights
// ---------------------------------------------------------------------------

describe('applyHighlights', () => {
  it('跨文本节点包 mark（同 id 多段），解包幂等且 innerHTML 复原', () => {
    const doc = parseBody(P_HTML)
    const p = doc.querySelector('[data-pc-block="0"]')!
    const original = p.innerHTML
    // 'Hello world'[4..9) = 'o wor'：跨 "Hello " 文本节点与 <b>wor</b>
    const rows = new Map([[0, [hl('h1', 0, 'orig', 4, 9, 'o wor')]]])
    mod.applyHighlights(doc, rows)
    const marks = Array.from(p.querySelectorAll('mark[data-highlight-id="h1"]'))
    expect(marks.map((m) => m.textContent)).toEqual(['o ', 'wor'])
    expect(p.innerHTML).toBe('Hell<mark data-highlight-id="h1">o </mark><b><mark data-highlight-id="h1">wor</mark></b>ld')
    expect(hostText(p)).toBe('Hello world')

    // 幂等：再来一次仍是两段，不会套娃
    mod.applyHighlights(doc, rows)
    expect(p.querySelectorAll('mark').length).toBe(2)

    // 清空 → 解包 + normalize 后逐字复原
    mod.applyHighlights(doc, new Map())
    expect(p.innerHTML).toBe(original)
    expect(p.childNodes.length).toBe(3)
  })

  it('多条区间：降序处理，各落各位；快照失配的行被过滤', () => {
    const doc = parseBody(P_HTML)
    const p = doc.querySelector('[data-pc-block="0"]')!
    mod.applyHighlights(
      doc,
      new Map([[0, [hl('a', 0, 'orig', 0, 2, 'He'), hl('b', 0, 'orig', 9, 11, 'ld'), hl('stale', 0, 'orig', 0, 5, '对不上')]]]),
    )
    expect(p.innerHTML).toBe('<mark data-highlight-id="a">He</mark>llo <b>wor</b><mark data-highlight-id="b">ld</mark>')
    expect(p.querySelector('[data-highlight-id="stale"]')).toBeNull()
  })

  it('对照模式：zh 行只进译文宿主，orig 行只进原文；译文节点重建后重放仍正确', () => {
    const doc = parseBody(P_HTML)
    const p = doc.querySelector('[data-pc-block="0"]')!
    mod.applyLangState(doc, P_BLOCK, { langMode: 'both', translations: new Map([[0, '你好世界']]) })
    const rows = new Map([[0, [hl('ho', 0, 'orig', 0, 5, 'Hello'), hl('hz', 0, 'zh', 2, 4, '世界')]]])
    mod.applyHighlights(doc, rows)
    const zh = p.querySelector('.pc-zh')!
    expect(zh.innerHTML).toBe('你好<mark data-highlight-id="hz">世界</mark>')
    expect(zh.querySelector('[data-highlight-id="ho"]')).toBeNull()
    expect(p.querySelector(':not(.pc-zh) > mark[data-highlight-id="ho"]')?.textContent).toBe('Hello')
    expect(hostText(p)).toBe('Hello world')
    expect(hostText(zh)).toBe('你好世界')

    // 译文变了 → 节点重建（mark 丢失）→ 重放高亮：失配的 zh 行被过滤，orig 行照常
    mod.applyLangState(doc, P_BLOCK, { langMode: 'both', translations: new Map([[0, '完全不同的译文']]) })
    mod.applyHighlights(doc, rows)
    expect(p.querySelector('.pc-zh mark')).toBeNull()
    expect(p.querySelector('mark[data-highlight-id="ho"]')).not.toBeNull()
  })

  it('骨架/失败态的译文节点没有 hl-host，不会被当成宿主', () => {
    const doc = parseBody(P_HTML)
    const p = doc.querySelector('[data-pc-block="0"]')!
    mod.applyLangState(doc, P_BLOCK, { langMode: 'both', failed: new Set([0]) })
    mod.applyHighlights(doc, new Map([[0, [hl('hz', 0, 'zh', 0, 2, '这一')]]]))
    expect(p.querySelector('.pc-zh mark')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// hostText / blockElements / pickLinkAction / hostRectInParent
// ---------------------------------------------------------------------------

describe('hostText 与 blockElements', () => {
  it('hostText 排除 .pc-zh 与嵌套 hl-host', () => {
    const doc = parseBody('<p id="h">A<span class="pc-zh">译</span>B<span data-hl-host="zh">译2</span>C</p>')
    expect(hostText(doc.getElementById('h')!)).toBe('ABC')
  })

  it('blockElements 按序号建稀疏数组，畸形序号跳过', () => {
    const doc = parseBody('<p data-pc-block="2">c</p><p data-pc-block="x">?</p><p data-pc-block="0">a</p>')
    const els = mod.blockElements(doc)
    expect(els.length).toBe(3)
    expect(els[0]?.textContent).toBe('a')
    expect(els[1]).toBeUndefined()
    expect(els[2]?.textContent).toBe('c')
  })
})

describe('pickLinkAction', () => {
  const FINAL = 'https://a.com/dir/page?x=1'
  const link = (href: string | null): Element => {
    const a = document.createElement('a')
    if (href !== null) a.setAttribute('href', href)
    return a
  }
  it('页内锚：#frag、指回本页的绝对 URL（含 %XX 解码）', () => {
    expect(mod.pickLinkAction(link('#sec-2'), FINAL)).toEqual({ kind: 'fragment', id: 'sec-2' })
    expect(mod.pickLinkAction(link('https://a.com/dir/page?x=1#intro'), FINAL)).toEqual({ kind: 'fragment', id: 'intro' })
    expect(mod.pickLinkAction(link('#%E4%B8%AD'), FINAL)).toEqual({ kind: 'fragment', id: '中' })
  })
  it('http(s) 外链：相对路径按 finalUrl 解析；其他页面带 hash 也是外链', () => {
    expect(mod.pickLinkAction(link('../other.html'), FINAL)).toEqual({ kind: 'external', href: 'https://a.com/other.html' })
    expect(mod.pickLinkAction(link('http://b.org/x#y'), FINAL)).toEqual({ kind: 'external', href: 'http://b.org/x#y' })
    expect(mod.pickLinkAction(link('https://a.com/dir/page?x=2#y'), FINAL)).toEqual({ kind: 'external', href: 'https://a.com/dir/page?x=2#y' })
  })
  it('忽略：空 href、裸 #、mailto/tel/javascript、解析失败', () => {
    expect(mod.pickLinkAction(link(null), FINAL)).toEqual({ kind: 'ignore' })
    expect(mod.pickLinkAction(link('   '), FINAL)).toEqual({ kind: 'ignore' })
    expect(mod.pickLinkAction(link('#'), FINAL)).toEqual({ kind: 'ignore' })
    expect(mod.pickLinkAction(link('mailto:a@b.c'), FINAL)).toEqual({ kind: 'ignore' })
    expect(mod.pickLinkAction(link('tel:123'), FINAL)).toEqual({ kind: 'ignore' })
    expect(mod.pickLinkAction(link('javascript:alert(1)'), FINAL)).toEqual({ kind: 'ignore' })
    expect(mod.pickLinkAction(link('http://[bad'), FINAL)).toEqual({ kind: 'ignore' })
  })
})

describe('hostRectInParent', () => {
  it('元素矩形加上 iframe 位置与边框', () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    iframe.getBoundingClientRect = () => ({ top: 100, left: 20, bottom: 700, right: 620, width: 600, height: 600 }) as DOMRect
    Object.defineProperty(iframe, 'clientTop', { value: 1 })
    Object.defineProperty(iframe, 'clientLeft', { value: 2 })
    const el = document.createElement('div')
    el.getBoundingClientRect = () => ({ top: 10, left: 5, bottom: 30, right: 55, width: 50, height: 20 }) as DOMRect
    expect(mod.hostRectInParent(iframe, el)).toEqual({ top: 111, left: 27, bottom: 131, right: 77, width: 50, height: 20 })
    iframe.remove()
  })
})
