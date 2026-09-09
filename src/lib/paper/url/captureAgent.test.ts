// @vitest-environment happy-dom
// @vitest-environment-options { "settings": { "disableCSSFileLoading": true, "disableJavaScriptFileLoading": true, "disableJavaScriptEvaluation": true } }
import { describe, expect, it } from 'vitest'
import {
  buildCaptureSrcdoc,
  captureAgentMain,
  CAPTURE_AGENT_VERSION,
  CAPTURE_CSP,
  DEFAULT_CAPTURE_CONFIG,
  FIXED_ATTR,
  HIDDEN_ATTR,
  PRE_ATTR,
  SHEET_ATTR,
  type CaptureAgentConfig,
  type CaptureAgentMessage,
} from './captureAgent'
import { stampBlocks } from './stampBlocks'

/**
 * captureAgent 的三条契约在这里锁死：
 * ① `captureAgentMain` 自包含（要被 toString() 注进 srcdoc，闭包/import 一律不行）；
 * ② `buildCaptureSrcdoc` 的注入顺序（charset → CSP → base → 代理脚本，且在 `<head>` 最前）；
 * ③ `serialize()/annotate()/run()` 的行为。
 *
 * 全部跑在 happy-dom：用 `document.implementation.createHTMLDocument()` 造被捕获的文档
 * （不接到主文档上，免得 happy-dom 真的去拉 link/img），窗口用手写的假窗口，
 * 因为 happy-dom 的 getComputedStyle 不实现 UA 默认样式（`<pre>` 读出来是空串）。
 */

const cfgOf = (over: Partial<CaptureAgentConfig> = {}): CaptureAgentConfig => ({
  ...DEFAULT_CAPTURE_CONFIG,
  parentOrigin: 'https://app.example',
  ...over,
})

const BASE = 'https://ex.com/a/b.html'

function makeDoc(body: string, head = '', base = BASE): Document {
  const doc = document.implementation.createHTMLDocument('')
  doc.head.innerHTML = `<base href="${base}">${head}`
  doc.body.innerHTML = body
  doc.title = '快照标题'
  return doc
}

interface FakeStyle {
  display?: string
  visibility?: string
  position?: string
  whiteSpace?: string
}
const NORMAL_STYLE: Required<FakeStyle> = {
  display: 'block',
  visibility: 'visible',
  position: 'static',
  whiteSpace: 'normal',
}

interface Posted {
  msg: CaptureAgentMessage
  origin: string
}

/** 假窗口：只提供代理真正用到的那几个成员，计算样式与 postMessage 完全可控 */
function fakeWin(
  doc: Document | null,
  styleFor: (el: Element) => FakeStyle = () => ({}),
): { win: Window; posted: Posted[] } {
  const posted: Posted[] = []
  const win = {
    document: doc,
    innerWidth: 1280,
    innerHeight: 800,
    location: { href: 'about:srcdoc' },
    parent: {
      postMessage: (msg: CaptureAgentMessage, origin: string) => {
        posted.push({ msg, origin })
      },
    },
    getComputedStyle: (el: Element) => ({ ...NORMAL_STYLE, ...styleFor(el) }),
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    // 被捕获文档是 createHTMLDocument（readyState 恒为 interactive），load 由假窗口代发
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'load') setTimeout(fn, 0)
    },
    scrollTo: () => {},
    MutationObserver: globalThis.MutationObserver,
  }
  return { win: win as unknown as Window, posted }
}

async function waitPost(posted: Posted[], budgetMs = 3000): Promise<Posted> {
  const started = Date.now()
  while (posted.length === 0) {
    if (Date.now() - started > budgetMs) throw new Error('超时：代理没有 postMessage')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return posted[0]
}

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')

describe('captureAgentMain 自包含性', () => {
  const src = captureAgentMain.toString()

  it('序列化后的函数体不含任何打包器/模块系统的痕迹', () => {
    expect(src).not.toContain('import(')
    expect(src).not.toContain('__vite')
    expect(src).not.toContain('require(')
    expect(src).not.toContain('exports.')
  })

  it('不引用模块作用域的常量（否则注入后是 ReferenceError）', () => {
    expect(src).not.toContain('HIDDEN_ATTR')
    expect(src).not.toContain('FIXED_ATTR')
    expect(src).not.toContain('PRE_ATTR')
    expect(src).not.toContain('SHEET_ATTR')
    expect(src).not.toContain('CAPTURE_CSP')
    expect(src).not.toContain('DEFAULT_CAPTURE_CONFIG')
    expect(src).not.toContain('CAPTURE_AGENT_VERSION')
  })

  it('内联的属性名字面量与导出常量逐一相等', () => {
    // 引号形式由 esbuild 决定（当前输出双引号），所以判定与引号无关
    for (const attr of [HIDDEN_ATTR, FIXED_ATTR, PRE_ATTR, SHEET_ATTR]) {
      expect(src).toMatch(new RegExp(`['"\`]${attr}['"\`]`))
    }
    expect(HIDDEN_ATTR).toBe('data-pc-hidden')
    expect(FIXED_ATTR).toBe('data-pc-fixed')
    expect(PRE_ATTR).toBe('data-pc-pre')
    expect(SHEET_ATTR).toBe('data-pc-sheet')
    expect(src).toMatch(new RegExp(`agentVersion:\\s*${CAPTURE_AGENT_VERSION}\\b`))
  })

  it('函数体里没有 `</script`（否则注入时会提前闭合脚本标签）', () => {
    expect(/<\/script/i.test(src)).toBe(false)
  })
})

describe('buildCaptureSrcdoc', () => {
  const cfg = cfgOf()
  const order = (out: string): number[] => [
    out.indexOf('<meta charset="utf-8">'),
    out.indexOf('http-equiv="Content-Security-Policy"'),
    out.indexOf('<base href='),
    out.indexOf('<script>'),
  ]

  it('注入顺序为 charset → CSP → base → 代理脚本，且紧贴 `<head>` 之后', () => {
    const out = buildCaptureSrcdoc('<!DOCTYPE html><html><head><title>T</title></head><body>x</body></html>', BASE, cfg)
    const [charset, csp, base, script] = order(out)
    expect(charset).toBeGreaterThan(-1)
    expect(csp).toBeGreaterThan(charset)
    expect(base).toBeGreaterThan(csp)
    expect(script).toBeGreaterThan(base)
    expect(out).toContain('<head><meta charset="utf-8">')
    // 站点原有的 head 内容留在注入之后
    expect(out.indexOf('<title>T</title>')).toBeGreaterThan(script)
    expect(out).toContain('.run()</script>')
  })

  it('带属性的 `<head class="x">` 与大写 `<HEAD>` 同样插在开标签之后', () => {
    const attrs = buildCaptureSrcdoc('<html><head class="x" data-a="1"><title>T</title></head><body></body></html>', BASE, cfg)
    expect(attrs).toContain('<head class="x" data-a="1"><meta charset="utf-8">')
    const upper = buildCaptureSrcdoc('<HTML><HEAD><TITLE>T</TITLE></HEAD><BODY></BODY></HTML>', BASE, cfg)
    expect(upper).toContain('<HEAD><meta charset="utf-8">')
  })

  it('没有 `<head>` 时自己造一个：有 `<html>` 插其后，什么都没有则插在 doctype 之后', () => {
    const headless = buildCaptureSrcdoc('<html lang="en"><body>hi</body></html>', BASE, cfg)
    expect(headless).toContain('<html lang="en"><head><meta charset="utf-8">')
    expect(headless).toContain('</script></head><body>hi</body>')

    const bare = buildCaptureSrcdoc('<!DOCTYPE html>\n<p>hi</p>', BASE, cfg)
    expect(bare.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(bare.indexOf('<head>')).toBe('<!DOCTYPE html>'.length)
    expect(bare).toContain('</head>\n<p>hi</p>')
  })

  it('删掉站点原有的 `<base>`，只留我们注入的那个', () => {
    const out = buildCaptureSrcdoc(
      '<html><head><base href="https://old.example/x/"><base target="_blank"></head><body></body></html>',
      BASE,
      cfg,
    )
    expect(out).not.toContain('https://old.example')
    expect(out).not.toContain('target="_blank"')
    expect(out.match(/<base /g)).toHaveLength(1)
    expect(out).toContain(`<base href="${BASE}">`)
  })

  it('删掉站点自带的 CSP meta（属性顺序/引号/大小写任意），只留我们注入的那一份', () => {
    const cspCount = (out: string): number => out.match(/http-equiv\s*=\s*["']?\s*content-security-policy/gi)?.length ?? 0

    const plain = buildCaptureSrcdoc(
      '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"><title>T</title></head><body></body></html>',
      BASE,
      cfg,
    )
    expect(plain).not.toContain("script-src 'self'")
    expect(cspCount(plain)).toBe(1)
    expect(plain).toContain(`content="${CAPTURE_CSP}"`)

    // 属性倒序 + 裸值 + 大写；单引号；report-only 一并摘掉（留着无害，但没有保留的理由）
    const variants = buildCaptureSrcdoc(
      [
        '<html><head>',
        '<META CONTENT="default-src \'none\'" HTTP-EQUIV=Content-Security-Policy>',
        "<meta http-equiv='content-security-policy' content='img-src none'>",
        '<meta http-equiv="Content-Security-Policy-Report-Only" content="report-uri /r">',
        '</head><body>x</body></html>',
      ].join(''),
      BASE,
      cfg,
    )
    expect(variants).not.toContain('default-src')
    expect(variants).not.toContain('img-src none')
    expect(variants).not.toContain('report-uri')
    expect(cspCount(variants)).toBe(1)

    // 其它 http-equiv（refresh / charset 声明）不受牵连
    const others = buildCaptureSrcdoc(
      '<html><head><meta http-equiv="content-type" content="text/html; charset=gbk"></head><body></body></html>',
      BASE,
      cfg,
    )
    expect(others).toContain('http-equiv="content-type"')
  })

  it('finalUrl 按属性上下文转义', () => {
    const out = buildCaptureSrcdoc('<html><head></head><body></body></html>', 'https://ex.com/a?q="1"&x=<b>', cfg)
    expect(out).toContain('<base href="https://ex.com/a?q=&quot;1&quot;&amp;x=&lt;b&gt;">')
    expect(out).not.toContain('href="https://ex.com/a?q="1"')
  })

  it('CSP 显式带 unsafe-inline / unsafe-eval，cfg 以 JSON 注入且 `<` 被转义', () => {
    expect(CAPTURE_CSP).toContain("script-src https: 'unsafe-inline' 'unsafe-eval'")
    const out = buildCaptureSrcdoc('<html><head></head><body></body></html>', BASE, cfgOf({ parentOrigin: 'https://a<b' }))
    expect(out).toContain(`content="${CAPTURE_CSP}"`)
    expect(out).toContain('\\u003c')
    expect(out).toContain('"quietMs":700')
  })
})

describe('serialize()', () => {
  it('剥掉脚本执行面与嵌入内容，保留 style 与内联 svg', () => {
    const doc = makeDoc(
      [
        '<script>window.x=1</script>',
        '<noscript><span>ns</span></noscript>',
        '<iframe src="https://ex.com/f"></iframe>',
        '<object data="x.swf"></object>',
        '<embed src="y.swf">',
        '<template><b>tpl</b></template>',
        '<p>正文</p>',
        '<svg viewBox="0 0 10 10"><title>图</title><circle cx="5" cy="5" r="4"/></svg>',
      ].join(''),
      '<style>.a{color:red}</style><link rel="preload" href="p.js" as="script">',
    )
    const html = captureAgentMain(cfgOf(), fakeWin(doc).win).serialize()

    expect(html).not.toContain('<script')
    expect(html).not.toContain('noscript')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<object')
    expect(html).not.toContain('<embed')
    expect(html).not.toContain('<template')
    expect(html).not.toContain('p.js')
    expect(html).not.toContain('<base')
    expect(html).toContain('<style>.a{color:red}</style>')
    expect(html).toContain('<svg viewBox="0 0 10 10">')
    expect(html).toContain('<p>正文</p>')
    expect(html.startsWith('<html')).toBe(true)
  })

  it('剥 on* 事件属性与 javascript: URL（含 `java\\tscript:` 变形），元素本身留下', () => {
    const doc = makeDoc(
      '<a id="a1" href="javascript:alert(1)" onclick="boom()" onMouseOver="boom()">链接</a>' +
        '<a id="a2" href="JaVa\tscript:alert(2)">变形</a>' +
        '<a id="a3" href="https://ex.com/ok">正常</a>',
    )
    const out = parse(captureAgentMain(cfgOf(), fakeWin(doc).win).serialize())
    const a1 = out.getElementById('a1')!
    expect(a1.getAttribute('href')).toBeNull()
    expect(a1.getAttribute('onclick')).toBeNull()
    expect(a1.getAttribute('onmouseover')).toBeNull()
    expect(a1.textContent).toBe('链接')
    expect(out.getElementById('a2')!.getAttribute('href')).toBeNull()
    expect(out.getElementById('a3')!.getAttribute('href')).toBe('https://ex.com/ok')
  })

  it('link[rel~=stylesheet] → data-pc-sheet 占位（绝对 URL + media），其余 link 一律删', () => {
    const doc = makeDoc(
      '',
      '<link rel="stylesheet" href="../s.css" media="screen and (min-width:0)">' +
        '<link rel="Stylesheet" href="https://cdn.example/x.css">' +
        '<link rel="preload" href="f.woff2" as="font">' +
        '<link rel="icon" href="favicon.ico">' +
        '<link rel="stylesheet">',
    )
    const out = parse(captureAgentMain(cfgOf(), fakeWin(doc).win).serialize())
    const sheets = Array.from(out.querySelectorAll(`link[${SHEET_ATTR}]`))
    expect(sheets).toHaveLength(2)
    expect(sheets[0].getAttribute('href')).toBe('https://ex.com/s.css')
    expect(sheets[0].getAttribute('media')).toBe('screen and (min-width:0)')
    expect(sheets[0].getAttribute('rel')).toBeNull()
    // rel 大小写不敏感
    expect(sheets[1].getAttribute('href')).toBe('https://cdn.example/x.css')
    expect(sheets[1].getAttribute('media')).toBeNull()
    expect(out.querySelectorAll('link')).toHaveLength(2)
    expect(out.documentElement.outerHTML).not.toContain('favicon.ico')
  })

  it('img 固化成 currentSrc 并丢掉 srcset/sizes/loading', () => {
    const doc = makeDoc(
      '<img id="i1" src="https://cdn.example/small.png" srcset="https://cdn.example/2x.png 2x" sizes="100vw" loading="lazy">' +
        '<img id="i2" src="rel.png">',
    )
    Object.defineProperty(doc.getElementById('i1')!, 'currentSrc', {
      value: 'https://cdn.example/2x.png',
      configurable: true,
    })
    // happy-dom 的 currentSrc/src 按窗口 location 解析（浏览器按 document.baseURI），
    // 置空后走我们自己的 baseURI 绝对化分支——这条分支正是为了不依赖宿主实现才存在的
    Object.defineProperty(doc.getElementById('i2')!, 'currentSrc', { value: '', configurable: true })
    const out = parse(captureAgentMain(cfgOf(), fakeWin(doc).win).serialize())
    const i1 = out.getElementById('i1')!
    expect(i1.getAttribute('src')).toBe('https://cdn.example/2x.png')
    expect(i1.getAttribute('srcset')).toBeNull()
    expect(i1.getAttribute('sizes')).toBeNull()
    expect(i1.getAttribute('loading')).toBeNull()
    expect(out.getElementById('i2')!.getAttribute('src')).toBe('https://ex.com/a/rel.png')
  })

  it('video 有 poster 变 img，没有则变占位；audio 一律占位', () => {
    const doc = makeDoc(
      '<video id="v1" poster="../shot.jpg"><source src="https://cdn.example/v/movie.mp4?t=1"></video>' +
        '<video id="v2"><source src="https://cdn.example/v/clip.webm"></video>' +
        '<video id="v3"></video>' +
        '<audio id="a1"><source src="https://cdn.example/a/track.mp3"></audio>',
    )
    const out = parse(captureAgentMain(cfgOf(), fakeWin(doc).win).serialize())
    expect(out.querySelectorAll('video')).toHaveLength(0)
    expect(out.querySelectorAll('audio')).toHaveLength(0)
    const poster = out.querySelector('img')!
    expect(poster.getAttribute('src')).toBe('https://ex.com/shot.jpg')
    const holders = Array.from(out.querySelectorAll('.pc-placeholder'))
    expect(holders.map((el) => el.getAttribute('data-pc-placeholder'))).toEqual(['video', 'video', 'audio'])
    expect(holders[0].textContent).toBe('[视频：clip.webm]')
    expect(holders[1].textContent).toBe('[视频]')
    expect(holders[2].textContent).toBe('[音频：track.mp3]')
  })

  it('canvas 取 toDataURL，污染（抛错）时退化成占位', () => {
    const doc = makeDoc('<canvas id="c1" width="20" height="10"></canvas><canvas id="c2"></canvas>')
    const tainted = doc.getElementById('c2')!
    Object.defineProperty(tainted, 'toDataURL', {
      value: () => {
        throw new Error('SecurityError')
      },
      configurable: true,
    })
    const out = parse(captureAgentMain(cfgOf(), fakeWin(doc).win).serialize())
    expect(out.querySelectorAll('canvas')).toHaveLength(0)
    const img = out.querySelector('img')!
    expect(img.getAttribute('src')?.startsWith('data:image/')).toBe(true)
    expect(img.getAttribute('width')).toBe('20')
    const holder = out.querySelector('.pc-placeholder')!
    expect(holder.getAttribute('data-pc-placeholder')).toBe('canvas')
  })

  it('活树的 annotate 结果会随克隆带进输出', () => {
    const doc = makeDoc('<div id="ghost">影子</div><p id="ok">正文</p>')
    const agent = captureAgentMain(cfgOf(), fakeWin(doc, (el) => (el.id === 'ghost' ? { display: 'none' } : {})).win)
    agent.annotate()
    const out = parse(agent.serialize())
    expect(out.getElementById('ghost')!.hasAttribute(HIDDEN_ATTR)).toBe(true)
    expect(out.getElementById('ok')!.hasAttribute(HIDDEN_ATTR)).toBe(false)
  })
})

describe('annotate()', () => {
  it('标出隐藏文本元素 / fixed-sticky / white-space:pre，并跳过已被祖先覆盖的子树', () => {
    const doc = makeDoc(
      '<div id="wrap"><p id="inner">藏起来的</p></div>' +
        '<p id="invisible">看不见</p>' +
        '<header id="bar">吸顶</header>' +
        '<aside id="sticky">粘住</aside>' +
        '<div id="prewrap">保留空白</div>' +
        '<pre id="realpre">本来就是 pre</pre>' +
        '<p id="normal">正常</p>',
    )
    const styleFor = (el: Element): FakeStyle => {
      if (el.id === 'wrap' || el.id === 'inner') return { display: 'none' }
      if (el.id === 'invisible') return { visibility: 'hidden' }
      if (el.id === 'bar') return { position: 'fixed' }
      if (el.id === 'sticky') return { position: 'sticky' }
      if (el.id === 'prewrap') return { whiteSpace: 'pre-wrap' }
      if (el.id === 'realpre') return { whiteSpace: 'pre' }
      return {}
    }
    const counts = captureAgentMain(cfgOf(), fakeWin(doc, styleFor).win).annotate()

    expect(doc.getElementById('wrap')!.hasAttribute(HIDDEN_ATTR)).toBe(true)
    // 祖先已标 → 子元素不再重复标（省 computed style 之外的写入）
    expect(doc.getElementById('inner')!.hasAttribute(HIDDEN_ATTR)).toBe(false)
    expect(doc.getElementById('invisible')!.hasAttribute(HIDDEN_ATTR)).toBe(true)
    expect(doc.getElementById('normal')!.hasAttribute(HIDDEN_ATTR)).toBe(false)
    expect(counts.hidden).toBe(2)

    expect(doc.getElementById('bar')!.getAttribute(FIXED_ATTR)).toBe('1')
    expect(doc.getElementById('sticky')!.getAttribute(FIXED_ATTR)).toBe('1')
    expect(counts.fixed).toBe(2)

    expect(doc.getElementById('prewrap')!.getAttribute(PRE_ATTR)).toBe('1')
    // pre/code/textarea 的 pre 是 UA 默认值，stampBlocks 按标签名兜住，不重复标
    expect(doc.getElementById('realpre')!.hasAttribute(PRE_ATTR)).toBe(false)
    expect(counts.pre).toBe(1)
  })

  it('非文本承载标签（header 之类容器以外的 hr/img）不进 hidden 集合', () => {
    const doc = makeDoc('<hr id="line"><img id="pic" src="https://cdn.example/a.png">')
    const counts = captureAgentMain(cfgOf(), fakeWin(doc, () => ({ display: 'none' })).win).annotate()
    expect(doc.getElementById('line')!.hasAttribute(HIDDEN_ATTR)).toBe(false)
    expect(doc.getElementById('pic')!.hasAttribute(HIDDEN_ATTR)).toBe(false)
    // body/html 与 head 里的 title/base 也不标
    expect(counts.hidden).toBe(0)
  })

  it('隐藏的非文本容器（ul / table）整棵标掉：display 不继承，里面的 li/td 自身可见也不能成块', () => {
    const doc = makeDoc(
      '<ul id="menu"><li id="m1">Account settings page</li><li id="m2">Sign out of session</li></ul>' +
        '<table id="tbl"><tr><td id="cell">Hidden table cell content</td></tr></table>' +
        '<p id="normal">Visible paragraph text stays</p>',
    )
    const styleFor = (el: Element): FakeStyle => {
      if (el.id === 'menu') return { display: 'none' }
      if (el.id === 'tbl') return { visibility: 'hidden' }
      if (el.localName === 'li') return { display: 'list-item' }
      if (el.localName === 'td') return { display: 'table-cell' }
      return {}
    }
    const counts = captureAgentMain(cfgOf(), fakeWin(doc, styleFor).win).annotate()

    expect(doc.getElementById('menu')!.hasAttribute(HIDDEN_ATTR)).toBe(true)
    expect(doc.getElementById('tbl')!.hasAttribute(HIDDEN_ATTR)).toBe(true)
    // 后代不重复标（祖先已覆盖）
    expect(doc.getElementById('m1')!.hasAttribute(HIDDEN_ATTR)).toBe(false)
    expect(doc.getElementById('cell')!.hasAttribute(HIDDEN_ATTR)).toBe(false)
    expect(doc.getElementById('normal')!.hasAttribute(HIDDEN_ATTR)).toBe(false)
    expect(counts.hidden).toBe(2)

    // 打标阶段按 [data-pc-hidden] 整棵剪枝：隐藏菜单与表格一块都不出
    const texts = stampBlocks(doc).map((b) => b.text)
    expect(texts).toEqual(['Visible paragraph text stays'])
  })
})

describe('run()', () => {
  it('走完整流程后只发一条 ok 消息，带标注计数与视口宽度', async () => {
    const doc = makeDoc('<div id="ghost">影子</div><p>正文</p>')
    const { win, posted } = fakeWin(doc, (el) => (el.id === 'ghost' ? { display: 'none' } : {}))
    captureAgentMain(cfgOf({ quietMs: 5, maxAfterLoadMs: 20, sweep: false }), win).run()

    const first = await waitPost(posted)
    expect(first.origin).toBe('https://app.example')
    const msg = first.msg
    expect(msg.ok).toBe(true)
    if (!msg.ok) throw new Error('unreachable')
    expect(msg.type).toBe('pc-capture')
    expect(msg.agentVersion).toBe(CAPTURE_AGENT_VERSION)
    expect(msg.title).toBe('快照标题')
    expect(msg.finalUrl).toBe(BASE)
    expect(msg.viewportWidth).toBe(1280)
    expect(msg.hidden).toBe(1)
    expect(msg.fixed).toBe(0)
    expect(msg.html).toContain(`<div id="ghost" ${HIDDEN_ATTR}="1">`)

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(posted).toHaveLength(1)
  })

  it('滚动扫描把 loading=lazy 提升为 eager，并把 data-src 提升为 src', async () => {
    const doc = makeDoc(
      '<img id="i1" loading="lazy" data-src="https://cdn.example/real.png" src="data:image/gif;base64,R0lGOD">' +
        '<img id="i2" data-original="https://cdn.example/orig.png">' +
        '<img id="i3" src="https://cdn.example/keep.png" data-src="https://cdn.example/nope.png">',
    )
    const { win, posted } = fakeWin(doc)
    captureAgentMain(cfgOf({ quietMs: 5, maxAfterLoadMs: 20, sweep: true }), win).run()
    const msg = (await waitPost(posted)).msg
    if (!msg.ok) throw new Error('capture failed: ' + msg.reason)
    const out = parse(msg.html)
    expect(out.getElementById('i1')!.getAttribute('src')).toBe('https://cdn.example/real.png')
    expect(doc.getElementById('i1')!.getAttribute('loading')).toBe('eager')
    expect(out.getElementById('i2')!.getAttribute('src')).toBe('https://cdn.example/orig.png')
    // 已有真实 src 的图片不被 data-src 覆盖
    expect(out.getElementById('i3')!.getAttribute('src')).toBe('https://cdn.example/keep.png')
  })

  it('超出 maxHtmlBytes → ok:false / too-large', async () => {
    const doc = makeDoc('<p>' + 'x'.repeat(200) + '</p>')
    const { win, posted } = fakeWin(doc)
    captureAgentMain(cfgOf({ quietMs: 5, maxAfterLoadMs: 20, sweep: false, maxHtmlBytes: 32 }), win).run()
    const msg = (await waitPost(posted)).msg
    expect(msg.ok).toBe(false)
    if (msg.ok) throw new Error('unreachable')
    expect(msg.reason).toBe('too-large')
    expect(msg.agentVersion).toBe(CAPTURE_AGENT_VERSION)
  })

  it('硬超时到点就发：有什么序列化什么，且仍然只发一次', async () => {
    const doc = makeDoc('<p>正文</p>')
    const { win, posted } = fakeWin(doc)
    captureAgentMain(cfgOf({ quietMs: 5000, maxAfterLoadMs: 5000, sweep: false, hardTimeoutMs: 5 }), win).run()
    const msg = (await waitPost(posted)).msg
    expect(msg.ok).toBe(true)
    if (!msg.ok) throw new Error('unreachable')
    expect(msg.html).toContain('<p>正文</p>')
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(posted).toHaveLength(1)
  })

  it('流程里任何抛错都变成 ok:false + reason', async () => {
    const { win, posted } = fakeWin(null)
    captureAgentMain(cfgOf({ quietMs: 5, maxAfterLoadMs: 20, sweep: false }), win).run()
    const msg = (await waitPost(posted)).msg
    expect(msg.ok).toBe(false)
    if (msg.ok) throw new Error('unreachable')
    expect(msg.reason.length).toBeGreaterThan(0)
    expect(msg.reason).not.toBe('too-large')
  })
})
