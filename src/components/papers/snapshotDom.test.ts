// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest'
import { READER_ALIGN_MARGIN } from '../../lib/paper/anchors'
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

describe('currentBlockRootMargin', () => {
  /** rootMargin → 顶层视口坐标下的观察带 [top, bottom]（隐式 root = 视口 [0, viewportHeight]） */
  const band = (margin: string | null, viewportHeight: number): [number, number] => {
    if (margin === null) throw new Error('观察带为空')
    const [top, , bottom] = margin.split(' ').map((s) => Number.parseFloat(s))
    return [0 - top, viewportHeight + bottom]
  }

  it('回归：矮窗口下观察带仍落在阅读窗格里（1000×674，窗格顶边 225）', () => {
    // 旧写法 `-8px 0px -75% 0px` 量的是浏览器视口的上 1/4 = [8, 168.5]，整条在窗格 [225, 673] 上方：
    // 没有块能进带，当前块冻住，译文窗口不跟滚动走，屏幕上的骨架永远等不到译文
    expect(674 * 0.25).toBeLessThan(225)
    const margin = mod.currentBlockRootMargin(225, 448, 674, 8)
    expect(margin).toBe('-233px 0px -337px 0px')
    expect(band(margin, 674)).toEqual([225 + 8, 225 + 448 / 4])
  })

  it('任意几何：带子恒为「窗格上 1/4、顶边内缩 epsilon」，不随视口高与窗格位置跑到窗格外', () => {
    const cases = [
      [147, 720, 868],
      [190, 484, 674],
      [172, 671, 844],
      [225, 974, 1200],
      [300.4, 401.7, 702],
    ]
    for (const [paneTop, paneHeight, viewport] of cases) {
      const [top, bottom] = band(mod.currentBlockRootMargin(paneTop, paneHeight, viewport, 8), viewport)
      expect(top).toBe(Math.round(paneTop + 8))
      expect(bottom).toBe(Math.round(paneTop + paneHeight * 0.25))
      expect(top).toBeGreaterThanOrEqual(paneTop)
      expect(bottom).toBeLessThanOrEqual(paneTop + paneHeight)
      expect(bottom).toBeGreaterThan(top)
    }
  })

  it('窗格占满视口时退化成 BlockReader 那句 -8px / -75%', () => {
    expect(mod.currentBlockRootMargin(0, 800, 800, 8)).toBe('-8px 0px -600px 0px')
  })

  it('取整到 px、四段齐全（rootMargin 只收 px / %）', () => {
    expect(mod.currentBlockRootMargin(300.4, 401.7, 702, 8)).toMatch(/^-?\d+px 0px -?\d+px 0px$/)
    // 顶边恰为 0：不写出 "-0px"
    expect(mod.currentBlockRootMargin(-8, 800, 800, 8)).toBe('0px 0px -608px 0px')
  })

  it('内缩量大于程序化对齐的顶部留白：对齐后的上一块进不了带，重开/切视图不会一格一格往回走', () => {
    // 回归：对齐后目标块顶边在窗格顶边下 16px；块间距为 0（arXiv 参考文献条目）时上一块的底边也在这条线上。
    // 内缩 8 时它仍在带里，min 取到上一块——实测停在 248 存成 247，重开 4 次退到 243
    expect(mod.SNAPSHOT_BAND_INSET).toBeGreaterThan(READER_ALIGN_MARGIN)
    const [top] = band(mod.currentBlockRootMargin(225, 448, 674, mod.SNAPSHOT_BAND_INSET), 674)
    expect(top).toBeGreaterThan(225 + READER_ALIGN_MARGIN)
  })

  it('窗格不可见（display:none，高度 0）或带高不为正：返回 null，调用方不建观察器', () => {
    expect(mod.currentBlockRootMargin(0, 0, 800, 8)).toBeNull()
    expect(mod.currentBlockRootMargin(100, 20, 800, 8)).toBeNull() // 1/4 高 5px < epsilon
    expect(mod.currentBlockRootMargin(Number.NaN, 400, 800, 8)).toBeNull()
    expect(mod.currentBlockRootMargin(100, 400, 0, 8)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 跨 iframe 滚动锚定与 iframe 高度
// ---------------------------------------------------------------------------

describe('pickScrollAnchor', () => {
  // 坐标一律是 iframe 文档坐标：窗格顶 1000、窗格可视高 448（1000×674 窗口下的工作台几何）
  const PANE_TOP = 1000
  const VIEW_BOTTOM = PANE_TOP + 448
  const probe = () => PANE_TOP + mod.SNAPSHOT_BAND_INSET
  const pick = (spans: ({ top: number; bottom: number } | null)[]) => mod.pickScrollAnchor(spans, probe(), VIEW_BOTTOM)

  it('目录跳转：第 N 块顶边对齐在窗格顶 +16，块间距为 0 时也锚 N，不锚 N−1', () => {
    // 回归：锚「第一个底边低于窗格顶的块」会选中 N−1——它的译文挂在它底部，一挂上 N 就被推走
    const aligned = PANE_TOP + READER_ALIGN_MARGIN
    const spans = [
      { top: 600, bottom: 800 },
      { top: 800, bottom: aligned }, // N−1：底边贴着 N 的顶边（arXiv 参考文献条目的块间距就是 0）
      { top: aligned, bottom: aligned + 120 }, // N
      { top: aligned + 120, bottom: aligned + 400 },
    ]
    expect(pick(spans)).toBe(2)
  })

  it('顺读：正在读的块跨着窗格顶，它就是锚点（它自己的译文挂在底部，只推后文）', () => {
    const spans = [
      { top: 400, bottom: 900 },
      { top: 900, bottom: 1300 }, // K：跨着窗格顶
      { top: 1300, bottom: 1700 },
    ]
    expect(pick(spans)).toBe(1)
  })

  it('探测线恰在边界：顶边等于探测线算包含，底边等于探测线不算', () => {
    const p = probe()
    expect(pick([{ top: 500, bottom: p }, { top: p, bottom: p + 50 }])).toBe(1)
  })

  it('嵌套：包含探测线的块取 top 最大的最内层；top 相同取文档序靠后者', () => {
    const outer = { top: 900, bottom: 1400 }
    const inner = { top: 990, bottom: 1100 }
    expect(pick([outer, inner])).toBe(1)
    // 入参顺序反过来（内层在前）也取 top 最大的那个
    expect(pick([inner, outer])).toBe(0)
    // 外层与里层顶边相同：文档序靠后的是里层
    expect(pick([{ top: 990, bottom: 1400 }, { top: 990, bottom: 1100 }])).toBe(1)
  })

  it('探测线落在块间空隙里：取窗格里顶边最靠上的块，不假设入参有序', () => {
    const spans = [
      { top: 500, bottom: 990 }, // 已滚出窗格
      { top: 1200, bottom: 1300 },
      { top: 1050, bottom: 1150 }, // 绝对定位等原因，文档序靠后却更靠上
    ]
    expect(pick(spans)).toBe(2)
  })

  it('窗格里没有块：返回 -1（不补偿）', () => {
    expect(pick([])).toBe(-1)
    // 全在探测线之上，或顶边在窗格底边及以下
    expect(pick([{ top: 100, bottom: 1000 }, { top: VIEW_BOTTOM, bottom: VIEW_BOTTOM + 100 }, { top: 5000, bottom: 5100 }])).toBe(-1)
  })

  it('没有布局的块（null）跳过', () => {
    expect(pick([null, { top: 1100, bottom: 1200 }, null])).toBe(1)
    expect(pick([null, null])).toBe(-1)
  })
})

/** happy-dom 没有布局：矩形手动钉 */
const stubRect = (el: Element, top: number, height: number, width = 600): void => {
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + height, left: 0, right: width, width, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
}

describe('docSpanOf / paneSpanInFrame / findScrollAnchor', () => {
  it('docSpanOf：矩形加上 iframe 窗口的 scrollY；宽高都为 0（没有布局）返回 null，只是高为 0 仍有效', () => {
    const el = document.createElement('p')
    stubRect(el, 120, 40)
    expect(mod.docSpanOf(el, 0)).toEqual({ top: 120, bottom: 160 })
    expect(mod.docSpanOf(el, 30)).toEqual({ top: 150, bottom: 190 })
    stubRect(el, 0, 0, 0)
    expect(mod.docSpanOf(el, 30)).toBeNull()
    stubRect(el, 200, 0, 600)
    expect(mod.docSpanOf(el, 0)).toEqual({ top: 200, bottom: 200 })
  })

  it('paneSpanInFrame：窗格内容盒（含边框修正）换算到 iframe 文档坐标', () => {
    const main = document.createElement('main')
    stubRect(main, 225, 450)
    Object.defineProperty(main, 'clientTop', { value: 1 })
    Object.defineProperty(main, 'clientHeight', { value: 448 })
    const iframe = document.createElement('iframe')
    // main 已滚动 3000：iframe 顶边在视口坐标 226 - 3000
    stubRect(iframe, 226 - 3000, 20000)
    Object.defineProperty(iframe, 'clientTop', { value: 0 })
    expect(mod.paneSpanInFrame(main, iframe, 0)).toEqual({ top: 3000, bottom: 3448 })
    expect(mod.paneSpanInFrame(main, iframe, 5)).toEqual({ top: 3005, bottom: 3453 })
  })

  it('findScrollAnchor：按文档序取宿主、跳过没有布局的块，返回元素与文档坐标顶边', () => {
    const doc = parseBody(
      '<p data-pc-block="0">a</p><p data-pc-block="1">b</p><p data-pc-block="2">c</p><p data-pc-block="3">d</p><p>非块</p>',
    )
    const [b0, b1, b2, b3] = Array.from(doc.querySelectorAll('[data-pc-block]'))
    stubRect(b0, 0, 990)
    // b1 不钉：happy-dom 的默认矩形全 0 = 没有布局（例如随外层原文被包进 .pc-orig[hidden]）
    expect(b1.getBoundingClientRect().width + b1.getBoundingClientRect().height).toBe(0)
    stubRect(b2, 1016, 100)
    stubRect(b3, 1116, 300)
    // 窗格顶 1000 → 探测线 1018：b0 已滚出，b2 顶边在 +16 包含探测线
    const hit = mod.findScrollAnchor(doc, { top: 1000, bottom: 1448 }, 0)
    expect(hit?.el).toBe(b2)
    expect(hit?.top).toBe(1016)
    expect(hit?.contained).toBe(true)
    // 探测线落在 b0 与 b2 之间的空隙里（窗格顶 980 → 探测线 998）：按规则 2 取下方第一个，不算包含
    const below = mod.findScrollAnchor(doc, { top: 980, bottom: 1428 }, 0)
    expect(below?.el).toBe(b2)
    expect(below?.contained).toBe(false)
    // iframe 视口被挪过（scrollY ≠ 0）：同一几何整体平移，仍是 b2
    const shifted = mod.findScrollAnchor(doc, { top: 1010, bottom: 1458 }, 10)
    expect(shifted?.el).toBe(b2)
    expect(shifted?.top).toBe(1026)
    // 窗格里一个块都没有
    expect(mod.findScrollAnchor(doc, { top: 5000, bottom: 5448 }, 0)).toBeNull()
  })
})

describe('frameHeightPass', () => {
  it('内容溢出当前高度：取 scroll（含绝对定位溢出），不复查', () => {
    expect(mod.frameHeightPass({ inFlow: 5000, scroll: 6000, view: 4000 })).toEqual({ height: 6000, recheck: false })
    // 首屏占位（60vh）→ 正文远高于它
    expect(mod.frameHeightPass({ inFlow: 20000, scroll: 20000, view: 404 })).toEqual({ height: 20000, recheck: false })
    // scrollHeight 是四舍五入的整数：流内高 5315.4 → 向上取整 5316，scrollHeight 报 5315——最后那点内容不能裁掉
    expect(mod.frameHeightPass({ inFlow: 5316, scroll: 5315, view: 404 })).toEqual({ height: 5316, recheck: false })
  })

  it('内容装得下（scroll 只是视口下限）：降到 inFlow 并要求复查', () => {
    // 「对照 → 原文」：内容从 33107 缩回 20000，scrollHeight 仍报视口高 33107
    expect(mod.frameHeightPass({ inFlow: 20000, scroll: 33107, view: 33107 })).toEqual({ height: 20000, recheck: true })
  })

  it('相等或差不到 1px：维持现高，不复查（不会自激振荡）', () => {
    expect(mod.frameHeightPass({ inFlow: 4000, scroll: 4000, view: 4000 })).toEqual({ height: 4000, recheck: false })
    expect(mod.frameHeightPass({ inFlow: 3999, scroll: 4000, view: 4000 })).toEqual({ height: 4000, recheck: false })
    expect(mod.frameHeightPass({ inFlow: 4000, scroll: 4001, view: 4000 })).toEqual({ height: 4000, recheck: false })
  })

  /** WebSnapshotView.syncHeight 的编排：第一段要求复查就先写入、再量一次取第二段（最多两段） */
  const twoPass = (measure: (view: number) => { inFlow: number; scroll: number; view: number }, view: number): number => {
    const first = mod.frameHeightPass(measure(view))
    return first.recheck ? mod.frameHeightPass(measure(first.height)).height : first.height
  }

  it('两段编排：降到 inFlow 后再量，绝对定位版式溢出就取第二次的 scroll（高度不被截短）', () => {
    // 模型：流内内容 3000，绝对定位元素底边 3500（只反映在 html.scrollHeight 上），scrollHeight = max(视口高, 3500)
    const absLayout = (view: number) => ({ inFlow: 3000, scroll: Math.max(view, 3500), view })
    expect(mod.frameHeightPass(absLayout(10000))).toEqual({ height: 3000, recheck: true })
    expect(mod.frameHeightPass(absLayout(3000))).toEqual({ height: 3500, recheck: false })
    expect(twoPass(absLayout, 10000)).toBe(3500)
    // 稳态：scrollHeight 恰等于视口高，单段分不清「视口下限」还是「绝对定位撑着」，所以每次都会复查——两段后仍落回 3500
    expect(mod.frameHeightPass(absLayout(3500)).recheck).toBe(true)
    expect(twoPass(absLayout, 3500)).toBe(3500)
    // 纯流内版式：「对照 → 原文」从 33107 一步回到 20000，稳态不再复查
    const flowLayout = (view: number) => ({ inFlow: 20000, scroll: Math.max(view, 20000), view })
    expect(twoPass(flowLayout, 33107)).toBe(20000)
    expect(mod.frameHeightPass(flowLayout(20000))).toEqual({ height: 20000, recheck: false })
  })
})

// ---------------------------------------------------------------------------
// iframe 高度：内容尺寸跟着视口走（耦合）与整次同步的编排
// ---------------------------------------------------------------------------

type Layout = (view: number) => { inFlow: number; scroll: number }

/** 布局模型：视口高 → 一次测量；write 改视口高（差不到 1px 不写、按上限截断，同 WebSnapshotView 的实现） */
const frameModel = (initial: Layout, view0: number, max = Number.POSITIVE_INFINITY) => {
  const s = { view: view0, layout: initial, writes: [] as number[], coupling: null as ReturnType<Mod['syncFrameHeight']> }
  const io = {
    measure: () => ({ ...s.layout(s.view), view: s.view }),
    write: (h: number) => {
      const next = Math.min(Math.ceil(h), max)
      if (next && Math.abs(next - s.view) >= 1) {
        s.view = next
        s.writes.push(next)
      }
      return s.view
    },
  }
  /** 跑一次同步，返回同步后的视口高 */
  const sync = (): number => {
    s.coupling = mod.syncFrameHeight(io, s.coupling)
    return s.view
  }
  return { s, sync }
}

/** 纯流内版式：scrollHeight = max(视口, 内容) */
const flow = (c: number): Layout => (view) => ({ inFlow: c, scroll: Math.max(view, c) })
/** 合法的绝对定位溢出（top 固定）：只反映在 scrollHeight 上，不随视口动 */
const absTail = (c: number, absBottom: number): Layout => (view) => ({ inFlow: c, scroll: Math.max(view, c, absBottom) })
/** 形态 (i)：`position:absolute; bottom:-extra`，包含块是初始包含块——永远挂在视口底边下方 */
const coupledOverflow = (c: number, extra: number): Layout => (view) => ({ inFlow: c, scroll: Math.max(c, view + extra) })
/** 形态 (ii)：正文容器 min-height:100vh + 页脚——文档高 = max(正文, 视口) + 页脚 */
const coupledInFlow = (c: number, foot: number): Layout => (view) => {
  const inFlow = Math.max(c, view) + foot
  return { inFlow, scroll: Math.max(view, inFlow) }
}

describe('probeViewportCoupling / coupledFrameHeight', () => {
  it('刚撑到 scrollHeight 就又溢出 → 耦合，记下两个耦合量；不溢出 → 不耦合', () => {
    // 形态 (i)：视口 5300，元素挂在视口下方 200
    expect(mod.probeViewportCoupling({ inFlow: 5300, scroll: 5500, view: 5300 }, null)).toEqual({ inFlowExtra: 0, scrollExtra: 200 })
    // 形态 (ii)：流内高度 = 视口 + 页脚 168
    expect(mod.probeViewportCoupling({ inFlow: 5602, scroll: 5602, view: 5434 }, null)).toEqual({ inFlowExtra: 168, scrollExtra: 168 })
    // 合法的绝对定位溢出：撑到它的底边就不再溢出
    expect(mod.probeViewportCoupling({ inFlow: 5315, scroll: 6400, view: 6400 }, null)).toBeNull()
    // 取整带来的 1px 不算
    expect(mod.probeViewportCoupling({ inFlow: 5316, scroll: 5316, view: 5315 }, null)).toBeNull()
  })

  it('已知耦合量时复查：扣掉已知量不再溢出就原样返回；还溢出说明耦合量自己变了，改记新量', () => {
    const known = { inFlowExtra: 168, scrollExtra: 168 }
    expect(mod.probeViewportCoupling({ inFlow: 5602, scroll: 5602, view: 5434 }, known)).toBe(known)
    // 页脚换行变高：168 → 248
    expect(mod.probeViewportCoupling({ inFlow: 5762, scroll: 5762, view: 5514 }, known)).toEqual({ inFlowExtra: 248, scrollExtra: 248 })
  })

  it('耦合模式的一步：只长「扣掉耦合量之后还多出」的那截；形态 (i) 能缩回流内高度，形态 (ii) 只长不缩', () => {
    const overflow = { inFlowExtra: 0, scrollExtra: 200 }
    // 稳态：scrollHeight 永远比视口多 200，不追
    expect(mod.coupledFrameHeight({ inFlow: 5300, scroll: 5500, view: 5300 }, overflow)).toBe(5300)
    // 译文落地，流内长到 5600：只长到 5600
    expect(mod.coupledFrameHeight({ inFlow: 5600, scroll: 5600, view: 5300 }, overflow)).toBe(5600)
    // 切回原文，流内缩回 5300：降到流内高度
    expect(mod.coupledFrameHeight({ inFlow: 5300, scroll: 5800, view: 5600 }, overflow)).toBe(5300)

    const inFlow = { inFlowExtra: 168, scrollExtra: 168 }
    // 稳态：流内高度永远比视口多 168（页脚），不追
    expect(mod.coupledFrameHeight({ inFlow: 5602, scroll: 5602, view: 5434 }, inFlow)).toBe(5434)
    // 正文长到 6000（> 视口）：文档高 6168，只长到 6000——正文完整，页脚落在外面
    expect(mod.coupledFrameHeight({ inFlow: 6168, scroll: 6168, view: 5434 }, inFlow)).toBe(6000)
    // 正文缩回去：流内高度含着视口，分不出正文多高——维持现高
    expect(mod.coupledFrameHeight({ inFlow: 6168, scroll: 6168, view: 6000 }, inFlow)).toBe(6000)
  })
})

describe('syncFrameHeight（整次同步的编排，按布局模型跑）', () => {
  it('纯流内：首屏占位撑到内容高；稳态不再写；内容变矮一步缩回；始终不耦合', () => {
    const m = frameModel(flow(20000), 404)
    expect(m.sync()).toBe(20000)
    expect(m.s.coupling).toBeNull()
    m.s.writes.length = 0
    expect(m.sync()).toBe(20000)
    expect(m.s.writes).toEqual([])
    // 「原文 → 对照」33107，再切回原文
    m.s.layout = flow(33107)
    expect(m.sync()).toBe(33107)
    m.s.layout = flow(20000)
    expect(m.sync()).toBe(20000)
    expect(m.s.coupling).toBeNull()
  })

  it('合法的绝对定位溢出（验收 C9）：6400 → 10862 → 6400，不被判成耦合；稳态一降一升后落回原高', () => {
    const m = frameModel(absTail(5315, 6400), 404)
    expect(m.sync()).toBe(6400)
    expect(m.s.coupling).toBeNull()
    // 稳态：scrollHeight 恰等于视口高，分不清是下限还是真实溢出，所以每次都先降到流内再升回来——同一任务里，最终高度不变
    m.s.writes.length = 0
    expect(m.sync()).toBe(6400)
    expect(m.s.writes).toEqual([5315, 6400])
    m.s.layout = absTail(10862, 6400)
    expect(m.sync()).toBe(10862)
    m.s.layout = absTail(5315, 6400)
    expect(m.sync()).toBe(6400)
    expect(m.s.coupling).toBeNull()
  })

  it('形态 (i) 溢出跟着视口（验收 C19）：不棘轮；内容变多只长那一截；切回原文能缩回', () => {
    const m = frameModel(coupledOverflow(5300, 200), 404)
    expect(m.sync()).toBe(5300)
    expect(m.s.coupling).toEqual({ inFlowExtra: 0, scrollExtra: 200 })
    // 回归：原先每同步一次（A、B 各一次）就涨 200，永远追不上
    for (let k = 0; k < 10; k++) expect(m.sync()).toBe(5300)
    for (const c of [5600, 5900, 6400]) {
      m.s.layout = coupledOverflow(c, 200)
      expect(m.sync()).toBe(c)
      expect(m.sync()).toBe(c)
    }
    m.s.layout = coupledOverflow(5300, 200)
    expect(m.sync()).toBe(5300)
  })

  it('形态 (i) 且正文比首屏占位还矮：探到耦合后把刚才多撑的那截还回去', () => {
    const m = frameModel(coupledOverflow(300, 200), 404)
    expect(m.sync()).toBe(300)
    expect(m.s.coupling).toEqual({ inFlowExtra: 0, scrollExtra: 200 })
    expect(m.sync()).toBe(300)
  })

  it('形态 (ii) 流内高度跟着视口（验收 C11）：不失控；正文变多跟着长（正文始终完整），变少不缩', () => {
    // 回归：原先每个 RO 回合涨一截页脚高，直到高度上限，正文区一片空白（实测每 250ms 涨约 5000px）
    const m = frameModel(coupledInFlow(5266, 168), 404)
    expect(m.sync()).toBe(5434)
    expect(m.s.coupling).toEqual({ inFlowExtra: 168, scrollExtra: 168 })
    for (let k = 0; k < 20; k++) expect(m.sync()).toBe(5434)
    // 正文长到 6000：视口跟到 6000（≥ 正文），页脚落在视口外
    m.s.layout = coupledInFlow(6000, 168)
    expect(m.sync()).toBe(6000)
    for (let k = 0; k < 5; k++) expect(m.sync()).toBe(6000)
    // 正文缩回：降级——不再缩（min-height:100vh 自己把正文容器撑满了视口，量不出正文真实高度）
    m.s.layout = coupledInFlow(5266, 168)
    expect(m.sync()).toBe(6000)
  })

  it('样式表晚到才开始耦合：先按普通版式同步，之后多走一步就探到并稳住', () => {
    const m = frameModel(flow(5340), 404)
    expect(m.sync()).toBe(5340)
    expect(m.s.coupling).toBeNull()
    m.s.layout = coupledInFlow(5266, 168)
    expect(m.sync()).toBe(5508)
    expect(m.s.coupling).toEqual({ inFlowExtra: 168, scrollExtra: 168 })
    for (let k = 0; k < 10; k++) expect(m.sync()).toBe(5508)
  })

  it('耦合量自己变了（窗口变窄，页脚换行 168 → 248）：多走一步后改记新量，不会每次再涨一截', () => {
    const m = frameModel(coupledInFlow(5266, 168), 404)
    expect(m.sync()).toBe(5434)
    m.s.layout = coupledInFlow(5266, 248)
    expect(m.sync()).toBe(5514)
    expect(m.s.coupling).toEqual({ inFlowExtra: 248, scrollExtra: 248 })
    for (let k = 0; k < 10; k++) expect(m.sync()).toBe(5514)
  })

  it('写入被高度上限截断：截断后必然还溢出，不能当成耦合', () => {
    const m = frameModel(flow(500_000), 404, 400_000)
    expect(m.sync()).toBe(400_000)
    expect(m.s.coupling).toBeNull()
    expect(m.sync()).toBe(400_000)
  })
})

// ---------------------------------------------------------------------------
// 锚点补偿的判定：理想滚动位置、塌缩重对齐
// ---------------------------------------------------------------------------

describe('理想 scrollTop（补偿不丢小数）', () => {
  it('inheritIdealScrollTop：上一条记录仍新鲜就沿用它的理想值，滚动过就以读回值重新起算', () => {
    expect(mod.inheritIdealScrollTop(1037, null)).toBe(1037)
    expect(mod.inheritIdealScrollTop(1037, { scrollTop: 1037, ideal: 1037.4 })).toBe(1037.4)
    // 差不到 1px 仍算新鲜（Chromium 的小数 scrollTop）
    expect(mod.inheritIdealScrollTop(1037.6, { scrollTop: 1037, ideal: 1037.4 })).toBe(1037.4)
    expect(mod.inheritIdealScrollTop(1100, { scrollTop: 1037, ideal: 1037.4 })).toBe(1100)
  })

  it('resolveIdealScrollTop：读回只是被取整 → 保留想写的值；被钳位 → 以读回值为准', () => {
    expect(mod.resolveIdealScrollTop(1037.4, 1037)).toBe(1037.4)
    expect(mod.resolveIdealScrollTop(1037.9, 1037)).toBe(1037.9)
    expect(mod.resolveIdealScrollTop(1037.4, 1037.4)).toBe(1037.4)
    // 到底了：想写 5000.4，只滚得到 4800
    expect(mod.resolveIdealScrollTop(5000.4, 4800)).toBe(4800)
    // 到顶了
    expect(mod.resolveIdealScrollTop(0, 0)).toBe(0)
  })

  /**
   * 回归（评审 P1-A / 验收 C16）：WebKit 的 scrollTop 只存整数且向下截断。按「读回值 + d」补偿，每次丢掉小数，
   * 块单向下漂；对齐留白 16、探测线 18，只有 2px 余量。这里按 capture → restore → 重新 capture 的顺序把链条走一遍。
   */
  it('WebKit 式截断下反复补偿：按理想值累计，误差恒 <1px；按读回值累计则单向漂过 2px', () => {
    const shifts = [37.4, 21.7, 13.3, 9.6, 180.5, 44.9, 0.7, 263.3, 51.6, 12.9, 88.8, 5.5]
    const store = (v: number): number => Math.floor(v)
    let truth = 1000 // 不取整时 scrollTop 该有的值
    let rec = { docTop: 5000, offsetTop: 16, contained: true, scrollTop: 1000, ideal: 1000 }
    let naive = 1000 // 旧做法：读回的整数当下一次的基准
    let worstNaive = 0
    for (const d of shifts) {
      truth += d
      naive = store(naive + d)
      worstNaive = Math.max(worstNaive, truth - naive)
      const now = { top: rec.docTop + d, bottom: rec.docTop + d + 120 }
      const target = mod.anchorRestoreTarget(rec, now)
      expect(target).not.toBeNull()
      const actual = store(target!.top)
      const restored = { ...rec, scrollTop: actual, ideal: mod.resolveIdealScrollTop(target!.top, actual), docTop: now.top }
      // 重新记录：位置没动过，继承刚补偿过的那条
      rec = { ...restored, ideal: mod.inheritIdealScrollTop(actual, restored) }
      expect(rec.ideal).toBeCloseTo(truth, 6)
      // 屏幕上的误差 = 理想值与实际存下的整数之差，恒在 [0, 1)
      expect(truth - actual).toBeGreaterThanOrEqual(0)
      expect(truth - actual).toBeLessThan(1)
    }
    expect(worstNaive).toBeGreaterThan(2)
  })

  it('anchorRestoreTarget：位移不到 0.5px 不写；负值截到 0；按理想值而不是读回值算', () => {
    const rec = { docTop: 5000, offsetTop: 16, contained: true, ideal: 1037.4 }
    expect(mod.anchorRestoreTarget(rec, { top: 5000.3, bottom: 5100 })).toBeNull()
    const moved = mod.anchorRestoreTarget(rec, { top: 5021.7, bottom: 5100 })
    expect(moved?.top).toBeCloseTo(1037.4 + 21.7, 6)
    expect(moved?.realigned).toBe(false)
    // 上方内容大幅变矮（对照 → 原文）
    expect(mod.anchorRestoreTarget(rec, { top: 3000, bottom: 3100 })).toEqual({ top: 0, realigned: false })
  })
})

describe('collapseRealign（锚点块自己塌缩）', () => {
  it('块原本包含探测线、改动后底边到了探测线之上：改为把顶边对齐到窗格顶 +16', () => {
    // 验收 C20：读到第 200 块中部（顶边在窗格顶 −84），切「中文」而译文未缓存，块塌成 33px 的骨架——底边在 −51
    expect(mod.collapseRealign(-84, 33)).toBe(-100)
    // 没塌（179px，底边在 +95，探测线 +18 仍在块内）
    expect(mod.collapseRealign(-84, 179)).toBe(0)
    // 底边恰在探测线上（包含是左闭右开）：算塌缩
    expect(mod.collapseRealign(-12, mod.SNAPSHOT_BAND_INSET + 12)).toBe(-12 - READER_ALIGN_MARGIN)
    // 已经对齐在 +16 的块：骨架也有二三十像素高，不动
    expect(mod.collapseRealign(READER_ALIGN_MARGIN, 33)).toBe(0)
  })

  it('anchorRestoreTarget 叠加重对齐：只对按规则 1 选中的锚点做', () => {
    // 上方内容变矮 300（都塌成骨架），锚点块自己也塌成 33px
    const rec = { docTop: 5000, offsetTop: -84, contained: true, ideal: 4916 }
    const now = { top: 4700, bottom: 4733 }
    expect(mod.anchorRestoreTarget(rec, now)).toEqual({ top: 4916 - 300 - 100, realigned: true })
    // 按规则 2 选中的（探测线在它上方的空隙里）：只补位移
    expect(mod.anchorRestoreTarget({ ...rec, contained: false, offsetTop: 40 }, now)).toEqual({ top: 4916 - 300, realigned: false })
    // 位移与重对齐恰好抵消：上方变高 100，块自己塌缩——不写，它已经落在 +16
    expect(mod.anchorRestoreTarget(rec, { top: 5100, bottom: 5133 })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// A 的时序：先按共享记录补偿待处理的外部重排，再现量锚点
// ---------------------------------------------------------------------------

describe('sharedRecordVerdict（共享记录还能不能拿来补偿）', () => {
  it('没有记录 / 拿不到 scrollTop → none；记录之后滚动过 → stale；平滑跳转中 → smooth；其余 → use', () => {
    const rec = { scrollTop: 17017 }
    expect(mod.sharedRecordVerdict(null, 17017, false)).toBe('none')
    expect(mod.sharedRecordVerdict(rec, null, false)).toBe('none')
    expect(mod.sharedRecordVerdict(rec, 17017, false)).toBe('use')
    // 差不到 1px 仍算没动过（小数 scrollTop、取整）
    expect(mod.sharedRecordVerdict(rec, 17017.6, false)).toBe('use')
    // 用户滚过，或程序化滚动刚写过而 scroll 事件还没派发：按旧记录去补会把那次滚动抵消掉
    expect(mod.sharedRecordVerdict(rec, 17018, false)).toBe('stale')
    expect(mod.sharedRecordVerdict(rec, 12823, false)).toBe('stale')
    expect(mod.sharedRecordVerdict(rec, 17017, true)).toBe('smooth')
    // 过期先于平滑跳转：跳转途中 scrollTop 一直在变，记录本来就该作废
    expect(mod.sharedRecordVerdict(rec, 17500, true)).toBe('stale')
  })
})

describe('runAnchoredMutation（A 的时序）', () => {
  it('顺序：补偿待处理的外部重排 → 现量锚点 → 改 DOM → 同步高度 → 补偿 → 刷新记录', () => {
    const calls: string[] = []
    const anchor = { id: 'a' }
    mod.runAnchoredMutation({
      compensatePending: () => void calls.push('compensatePending'),
      capture: () => (calls.push('capture'), anchor),
      mutate: () => void calls.push('mutate'),
      syncHeight: () => void calls.push('syncHeight'),
      restore: (a) => void calls.push(a === anchor ? 'restore' : 'restore(wrong anchor)'),
      commit: (a) => void calls.push(a === anchor ? 'commit' : 'commit(wrong anchor)'),
    })
    expect(calls).toEqual(['compensatePending', 'capture', 'mutate', 'syncHeight', 'restore', 'commit'])
  })

  it('窗格里没有可锚的块：照样改 DOM、同步高度、刷新记录，只是不补偿', () => {
    const calls: string[] = []
    mod.runAnchoredMutation<object>({
      compensatePending: () => void calls.push('compensatePending'),
      capture: () => (calls.push('capture'), null),
      mutate: () => void calls.push('mutate'),
      syncHeight: () => void calls.push('syncHeight'),
      restore: () => void calls.push('restore'),
      commit: (a) => void calls.push(a === null ? 'commit(null)' : 'commit'),
    })
    expect(calls).toEqual(['compensatePending', 'capture', 'mutate', 'syncHeight', 'commit(null)'])
  })

  /**
   * 一维模型：锚点块在文档里的顶边 anchorTop、容器的 scrollTop、共享记录。各步用的都是组件用的那些纯函数
   * （sharedRecordVerdict / anchorRestoreTarget / inheritIdealScrollTop），所以这里跑的就是组件的判定 + 时序。
   */
  type Rec = { docTop: number; offsetTop: number; contained: boolean; scrollTop: number; ideal: number }
  const BLOCK_H = 120
  const world = (opts: { compensate: boolean } = { compensate: true }) => {
    const w = { anchorTop: 5000, scrollTop: 4984, record: null as Rec | null }
    const capture = (): Rec => {
      const offsetTop = w.anchorTop - w.scrollTop
      return {
        docTop: w.anchorTop,
        offsetTop,
        contained: offsetTop <= mod.SNAPSHOT_BAND_INSET && mod.SNAPSHOT_BAND_INSET < offsetTop + BLOCK_H,
        scrollTop: w.scrollTop,
        ideal: mod.inheritIdealScrollTop(w.scrollTop, w.record),
      }
    }
    const restore = (a: Rec): void => {
      const target = mod.anchorRestoreTarget(a, { top: w.anchorTop, bottom: w.anchorTop + BLOCK_H })
      if (!target) return
      w.scrollTop = target.top
      a.scrollTop = target.top
      a.ideal = target.top
      a.docTop = w.anchorTop
    }
    /** 组件的 A：改 DOM（mutate）并带着锚定 */
    const apply = (mutate: () => void): void =>
      mod.runAnchoredMutation<Rec>({
        compensatePending: () => {
          if (opts.compensate && w.record && mod.sharedRecordVerdict(w.record, w.scrollTop, false) === 'use') restore(w.record)
        },
        capture,
        mutate,
        syncHeight: () => undefined,
        restore,
        commit: (a) => {
          if (a) w.record = a
          w.record = capture()
        },
      })
    /** 程序化对齐后记录（续读对齐）；锚点块顶边离窗格顶 16px */
    w.record = capture()
    return { w, apply, offset: () => w.anchorTop - w.scrollTop }
  }

  it('回归（验收 C22）：外部重排之后、B 的回调到来之前 A 先跑——位置不被吸收，也不累计', () => {
    for (const step of [8.7, -8.7]) {
      const { w, apply, offset } = world()
      expect(offset()).toBe(16)
      for (let k = 0; k < 6; k++) {
        w.anchorTop += step // 外部重排（字体换上、图片解码）：不经过组件，共享记录还是旧的
        apply(() => (w.anchorTop += 30)) // 紧接着译文落在上方
        expect(offset()).toBeCloseTo(16, 6)
      }
    }
  })

  it('对照：去掉「先按共享记录补偿」这一步，每次外部重排都被现量吸收，单向累计（改前 16.4 → 25.1 → … → 68.6）', () => {
    const { w, apply, offset } = world({ compensate: false })
    for (let k = 0; k < 6; k++) {
      w.anchorTop += 8.7
      apply(() => (w.anchorTop += 30))
    }
    expect(offset()).toBeCloseTo(16 + 6 * 8.7, 6)
  })

  it('全应用里的那次：续读对齐后字体换上、上方矮了 52px，随后才挂缓存译文——块回到对齐的位置', () => {
    const { w, apply, offset } = world()
    w.anchorTop -= 52
    expect(offset()).toBe(-36) // 这时 B 的回调还没来
    apply(() => (w.anchorTop -= 4000)) // 「中文」+ 缓存译文：上方整体变矮
    expect(offset()).toBeCloseTo(16, 6)
  })

  it('记录之后用户滚动过：不按旧记录补（那会把滚动抵消掉），就地按现在的位置锚', () => {
    const { w, apply, offset } = world()
    w.anchorTop += 40 // 外部重排
    w.scrollTop += 300 // 随后用户滚走了：记录过期
    const before = offset()
    apply(() => (w.anchorTop += 30))
    expect(offset()).toBeCloseTo(before, 6)
  })
})

// ---------------------------------------------------------------------------
// 平滑跳转、滚动来源与暂缓的判定
// ---------------------------------------------------------------------------

describe('smoothStartsInPlace（平滑跳转发起时要不要立刻起静止计时）', () => {
  it('目标已在原位才起；目标截到最大滚动位置后再比', () => {
    // 回归（评审 P1-B / 验收 C17）：无条件起计时，发起后主线程卡 140ms 以上，计时器先于第一个 scroll 事件到点，跳转被判成结束
    expect(mod.smoothStartsInPlace(20000, 6400, 90000)).toBe(false)
    expect(mod.smoothStartsInPlace(6400.4, 6400, 90000)).toBe(true)
    // 目标超出可滚范围、而当前已经在底：不会有 scroll 事件
    expect(mod.smoothStartsInPlace(9000, 8000, 8000)).toBe(true)
    expect(mod.smoothStartsInPlace(9000, 7000, 8000)).toBe(false)
    // 内容不满一屏（最大滚动位置为负）
    expect(mod.smoothStartsInPlace(0, 0, -50)).toBe(true)
  })
})

describe('trackSmoothProgress（平滑跳转中用户是否已接管）', () => {
  /** 依次喂距离，返回每一步是否判定接管 */
  const feed = (dists: number[]): boolean[] => {
    let p = mod.SMOOTH_PROGRESS_START
    return dists.map((d) => {
      const r = mod.trackSmoothProgress(p, d)
      p = r.progress
      return r.takenOver
    })
  }

  it('动画一路逼近：从不判接管', () => {
    expect(feed([13000, 12400, 10100, 6000, 2200, 300, 0, 0])).toEqual(new Array(8).fill(false))
  })

  it('逼近中距离反而变大超过 2px：用户接管（WebKit 收不到 iframe 里的滚轮 / 触摸）', () => {
    expect(feed([13000, 12400, 10100, 10140])).toEqual([false, false, false, true])
    // 2px 以内的抖动不算；之后相对「到过的最近距离」累计超过 2px 才算
    expect(feed([1000, 800, 801.5, 802, 802.5])).toEqual([false, false, false, false, true])
    // 已经到位（距离 0）、状态还没来得及清，用户又滚走
    expect(feed([500, 100, 0, 30])).toEqual([false, false, false, true])
  })

  it('刚重新瞄准到身后的目标：引擎会先沿旧方向再走一帧，开始变近之前距离变大不算接管', () => {
    // 实测（Chromium）：重新瞄准时在 5422，目标 3000；随后的事件 5614（+192）→ 5611 → 5603 → …
    expect(feed([5614, 5611, 5603, 5588].map((v) => Math.abs(v - 3000)))).toEqual([false, false, false, false])
    // 多带了两帧也一样
    expect(feed([2600, 2750, 2790, 2760, 2500])).toEqual([false, false, false, false, false])
    // 掉头之后再变远才算
    expect(feed([2600, 2750, 2700, 2710])).toEqual([false, false, false, true])
  })
})

describe('classifyScroll / shouldHoldMutation（原生滚动进行中暂缓改 DOM）', () => {
  it('滚动来源：平滑跳转进行中不算原生；与自己最后写入的值一致算自己的；其余是原生滚动', () => {
    expect(mod.classifyScroll(1200, 1200, true)).toBe('smooth')
    expect(mod.classifyScroll(1500, 1200, true)).toBe('smooth')
    // 补偿 / 瞬时对齐 / 滚轮转发桥写的：读回值与事件里的值一致（差不到 1px）
    expect(mod.classifyScroll(1200, 1200, false)).toBe('own')
    expect(mod.classifyScroll(1200.4, 1200, false)).toBe('own')
    // 触摸惯性、键盘翻页、拖滚动条、WebKit 的原生滚轮
    expect(mod.classifyScroll(1206, 1200, false)).toBe('native')
    expect(mod.classifyScroll(1206, null, false)).toBe('native')
  })

  it('原生滚动刚发生过（不到 holdMs）就暂缓；平滑跳转中、窗格不可见、早就停了都不暂缓', () => {
    const base = { smooth: false, paneVisible: true, sinceNativeMs: 40, holdMs: 120 }
    // 回归（验收 C18 / C15）：WebKit 键盘 PageDown 途中落地，翻页被截断、补偿丢失
    expect(mod.shouldHoldMutation(base)).toBe(true)
    expect(mod.shouldHoldMutation({ ...base, sinceNativeMs: 119 })).toBe(true)
    // 停稳时的冲刷发生在最后一次滚动 150ms 之后：holdMs 必须小于它，冲刷才不会被再次暂缓
    expect(mod.shouldHoldMutation({ ...base, sinceNativeMs: 150 })).toBe(false)
    expect(mod.shouldHoldMutation({ ...base, sinceNativeMs: Number.POSITIVE_INFINITY })).toBe(false)
    expect(mod.shouldHoldMutation({ ...base, smooth: true })).toBe(false)
    expect(mod.shouldHoldMutation({ ...base, paneVisible: false })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 滚动：内部滚动容器与滚轮归属
// ---------------------------------------------------------------------------

/** 造一个带滚动度量的元素（happy-dom 没有布局，scrollHeight/clientHeight 得手动钉） */
function scrollBox(opts: { overflowY?: string; overflowX?: string; scrollHeight: number; clientHeight: number; scrollTop?: number }): HTMLElement {
  const el = document.createElement('div')
  if (opts.overflowY) el.style.overflowY = opts.overflowY
  if (opts.overflowX) el.style.overflowX = opts.overflowX
  Object.defineProperty(el, 'scrollHeight', { value: opts.scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: opts.clientHeight, configurable: true })
  el.scrollTop = opts.scrollTop ?? 0
  return el
}

describe('READER_CSS 滚动复位', () => {
  it('解除站点的 overscroll-behavior / touch-action，并解除内部纵向滚动口', () => {
    // 站点的 `html{overscroll-behavior-y:none}` 会掐断滚动链式传递，触摸板整页滚不动
    expect(mod.READER_CSS).toMatch(/html, body \{[^}]*overscroll-behavior: auto !important/)
    expect(mod.READER_CSS).toMatch(/html, body \{[^}]*touch-action: auto !important/)
    // 两轴一起解：overflow-x 非 visible 时规范会把 overflow-y:visible 计算成 auto，只解纵向会被打回
    expect(mod.READER_CSS).toContain(
      '[data-pc-scroller] { overflow: visible !important; max-height: none !important; height: auto !important; }',
    )
  })
})

describe('wheelScrollTarget', () => {
  const root = () => document.documentElement

  it('没有可滚祖先：返回 null（该转发给外层容器）', () => {
    const p = document.createElement('p')
    document.body.appendChild(p)
    expect(mod.wheelScrollTarget(p, 120, root())).toBeNull()
    p.remove()
  })

  it('祖先还能往下滚：让位给它', () => {
    const box = scrollBox({ overflowY: 'auto', scrollHeight: 2940, clientHeight: 611, scrollTop: 0 })
    const inner = document.createElement('span')
    box.appendChild(inner)
    document.body.appendChild(box)
    expect(mod.wheelScrollTarget(inner, 120, root())).toBe(box)
    box.remove()
  })

  it('祖先已滚到底：向下返回 null（转发），向上仍让位', () => {
    const box = scrollBox({ overflowY: 'scroll', scrollHeight: 2940, clientHeight: 611, scrollTop: 2329 })
    const inner = document.createElement('span')
    box.appendChild(inner)
    document.body.appendChild(box)
    expect(mod.wheelScrollTarget(inner, 120, root())).toBeNull()
    expect(mod.wheelScrollTarget(inner, -120, root())).toBe(box)
    box.remove()
  })

  it('overflow:hidden 不响应用户滚动，不算陷阱', () => {
    const box = scrollBox({ overflowY: 'hidden', scrollHeight: 2940, clientHeight: 611, scrollTop: 0 })
    const inner = document.createElement('span')
    box.appendChild(inner)
    document.body.appendChild(box)
    expect(mod.wheelScrollTarget(inner, 120, root())).toBeNull()
    box.remove()
  })

  it('走到 root 就停：root 自己不作为让位目标', () => {
    const box = scrollBox({ overflowY: 'auto', scrollHeight: 2940, clientHeight: 611, scrollTop: 0 })
    const inner = document.createElement('span')
    box.appendChild(inner)
    document.body.appendChild(box)
    // 以 box 自己为 root：向上找不到别人
    expect(mod.wheelScrollTarget(inner, 120, box)).toBeNull()
    box.remove()
  })

  it('文本节点作为 target 也能向上找（滚轮 target 未必是元素）', () => {
    const box = scrollBox({ overflowY: 'auto', scrollHeight: 2940, clientHeight: 611, scrollTop: 0 })
    const text = document.createTextNode('hi')
    box.appendChild(text)
    document.body.appendChild(box)
    expect(mod.wheelScrollTarget(text, 120, root())).toBe(box)
    box.remove()
  })
})

/** 生产里 stampScrollers 拿到的是 iframe 的 contentDocument；createHTMLDocument 没有 defaultView，取不到计算样式 */
function iframeDoc(): { doc: Document; done: () => void } {
  const f = document.createElement('iframe')
  document.body.appendChild(f)
  const doc = f.contentDocument as Document
  return { doc, done: () => f.remove() }
}

describe('stampScrollers', () => {
  it('给真有纵向溢出的滚动容器打标，返回个数', () => {
    const { doc, done } = iframeDoc()
    const box = doc.createElement('div')
    box.style.overflowY = 'auto'
    Object.defineProperty(box, 'scrollHeight', { value: 2940, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: 611, configurable: true })
    doc.body.appendChild(box)
    expect(mod.stampScrollers(doc)).toBe(1)
    expect(box.getAttribute('data-pc-scroller')).toBe('1')
    // 幂等：已打标的不重复计数
    expect(mod.stampScrollers(doc)).toBe(0)
    done()
  })

  it('overflow-x:auto 的长代码块纵向没溢出，不打标', () => {
    const { doc, done } = iframeDoc()
    const pre = doc.createElement('pre')
    // CSS overflow 规范：overflow-x 非 visible 时 overflow-y 的 visible 计算成 auto
    pre.style.overflowX = 'auto'
    pre.style.overflowY = 'auto'
    Object.defineProperty(pre, 'scrollHeight', { value: 40, configurable: true })
    Object.defineProperty(pre, 'clientHeight', { value: 40, configurable: true })
    doc.body.appendChild(pre)
    expect(mod.stampScrollers(doc)).toBe(0)
    expect(pre.hasAttribute('data-pc-scroller')).toBe(false)
    done()
  })

  it('两轴都 scroll 且真有纵向溢出：照样打标（站点 Radix ScrollArea 的形状）', () => {
    const { doc, done } = iframeDoc()
    const area = doc.createElement('div')
    // 站点写的是内联 `overflow:scroll` 简写；happy-dom 不把简写展开到 overflowY，这里写成等价的长写法
    // （真实 Chrome 会展开——llm-pro.cn 上这个元素确实被打上了 data-pc-scroller）
    area.style.overflowX = 'scroll'
    area.style.overflowY = 'scroll'
    Object.defineProperty(area, 'scrollHeight', { value: 2941, configurable: true })
    Object.defineProperty(area, 'clientHeight', { value: 480, configurable: true })
    doc.body.appendChild(area)
    expect(mod.stampScrollers(doc)).toBe(1)
    expect(area.getAttribute('data-pc-scroller')).toBe('1')
    done()
  })

  it('不碰 html / body（整页的滚动口由 READER_CSS 统一管）', () => {
    const { doc, done } = iframeDoc()
    for (const el of [doc.documentElement, doc.body]) {
      ;(el as HTMLElement).style.overflowY = 'auto'
      Object.defineProperty(el, 'scrollHeight', { value: 9999, configurable: true })
      Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
    }
    expect(mod.stampScrollers(doc)).toBe(0)
    expect(doc.documentElement.hasAttribute('data-pc-scroller')).toBe(false)
    expect(doc.body.hasAttribute('data-pc-scroller')).toBe(false)
    done()
  })
})
