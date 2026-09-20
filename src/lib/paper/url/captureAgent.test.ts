// @vitest-environment happy-dom
// @vitest-environment-options { "settings": { "disableCSSFileLoading": true, "disableJavaScriptFileLoading": true, "disableJavaScriptEvaluation": true } }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildCaptureSrcdoc,
  captureAgentMain,
  CAPTURE_AGENT_VERSION,
  CAPTURE_CSP,
  DEFAULT_CAPTURE_CONFIG,
  FIXED_ATTR,
  SHEET_ATTR,
  type CaptureAgentConfig,
  type CaptureAgentMessage,
} from './captureAgent'
// captureAgent.ts 是零 import 文件（要原样编进 Node 服务端），不再转出这两个常量：直接从定义处取
import { HIDDEN_ATTR, PRE_ATTR, stampBlocks } from './stampBlocks'

/**
 * captureAgent 的三条契约在这里锁死：
 * ① `captureAgentMain` 自包含（要被 toString() 注进 srcdoc，闭包/import 一律不行）；
 * ② `buildCaptureSrcdoc` 的注入顺序（charset → CSP → base → 代理脚本，且在 `<head>` 最前）；
 * ③ `serialize()/annotate()/run()/collect()` 的行为，含 v2 的内容感知静默与 blockedScripts 信号。
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
  /** 发出时刻（假定时器下 Date 也是假的，时序断言靠它） */
  at: number
}

interface FakeWin {
  win: Window
  posted: Posted[]
  /** 代理挂的 window error 监听器，连同它登记的阶段 */
  errorListeners: Array<{ fn: (event: unknown) => void; capture: boolean }>
  /**
   * 模拟一次资源加载失败。这类 error **不冒泡**，window 上只有捕获阶段的监听器看得到——
   * 所以这里只派发给 `capture: true` 的监听器：代理要是忘了第三个参数，相关用例会直接红。
   */
  fireError: (target: unknown) => void
}

/** 假窗口：只提供代理真正用到的那几个成员，计算样式与 postMessage 完全可控 */
function fakeWin(
  doc: Document | null,
  styleFor: (el: Element) => FakeStyle = () => ({}),
  over: Record<string, unknown> = {},
): FakeWin {
  const posted: Posted[] = []
  const errorListeners: FakeWin['errorListeners'] = []
  const win = {
    document: doc,
    innerWidth: 1280,
    innerHeight: 800,
    location: { href: 'about:srcdoc' },
    parent: {
      postMessage: (msg: CaptureAgentMessage, origin: string) => {
        posted.push({ msg, origin, at: Date.now() })
      },
    },
    getComputedStyle: (el: Element) => ({ ...NORMAL_STYLE, ...styleFor(el) }),
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    // 被捕获文档是 createHTMLDocument（readyState 恒为 interactive），load 由假窗口代发
    addEventListener: (type: string, fn: (event?: unknown) => void, opts?: boolean | { capture?: boolean }) => {
      if (type === 'load') setTimeout(fn, 0)
      if (type === 'error') {
        errorListeners.push({ fn, capture: opts === true || (typeof opts === 'object' && opts?.capture === true) })
      }
    },
    scrollTo: () => {},
    MutationObserver: globalThis.MutationObserver,
    ...over,
  }
  const fireError = (target: unknown): void => {
    for (const listener of errorListeners) if (listener.capture) listener.fn({ type: 'error', target })
  }
  return { win: win as unknown as Window, posted, errorListeners, fireError }
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

  it('函数体里**每一处** agentVersion 字面量都等于导出常量（ok / 失败两条消息，漏改一处就红）', () => {
    const literals = Array.from(src.matchAll(/agentVersion:\s*([^,\s}]+)/g)).map((m) => m[1])
    expect(literals.length).toBeGreaterThanOrEqual(2)
    expect(literals).toEqual(literals.map(() => String(CAPTURE_AGENT_VERSION)))
    expect(CAPTURE_AGENT_VERSION).toBe(2)
  })

  it('本文件零 import：序列化后的源码里没有被改写的导入绑定', () => {
    // vitest/vite-node 会把 import 绑定改写成 __vi_import_N__.xxx；函数体里出现它就说明又引了模块作用域
    expect(src).not.toMatch(/__vi_import_\d+__/)
    expect(src).not.toContain('__vite_ssr_import')
  })

  it('不直接引用 `window`：宿主窗口只经 `win || globalThis` 取得（服务端编译没有 DOM lib）', () => {
    expect(src).toContain('globalThis')
    expect(src).not.toMatch(/\|\|\s*window\b/)
  })

  it('序列化后的源码脱离模块也能跑：`(src)(cfg).collect()` 正是服务端 page.evaluate 的调用形态', async () => {
    // 不传 win → 落到 globalThis，也就是 happy-dom 的顶层窗口（parent === window）。
    // 函数体里只要还有一个模块作用域的引用，这里就是 ReferenceError。
    expect(window.parent).toBe(window)
    const saved = document.body.innerHTML
    const spy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    try {
      document.body.innerHTML = `<main><p>${'独立运行的正文。'.repeat(40)}</p></main>`
      const cfg = cfgOf({ quietMs: 5, maxAfterLoadMs: 20, emptyWaitCapMs: 20, sweep: false })
      const expr = '(' + src + ')(' + JSON.stringify(cfg) + ').collect()'
      const msg = (await new Function('return ' + expr)()) as CaptureAgentMessage
      expect(msg.ok).toBe(true)
      if (!msg.ok) throw new Error('unreachable')
      expect(msg.agentVersion).toBe(CAPTURE_AGENT_VERSION)
      expect(msg.blockedScripts).toBe(0)
      expect(msg.html).toContain('独立运行的正文。')
      // 顶层页面里 parent 就是自己：collect() 绝不能再把整份 HTML postMessage 出去
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      document.body.innerHTML = saved
    }
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

/**
 * 真定时器用例的提速配置。这些夹具文档只有几个字（远不到 minTextChars），v2 起会被当成「空页面」
 * 一直等到 emptyWaitCapMs——所以它必须跟 maxAfterLoadMs 一起压小，否则每个用例白等 10s。
 */
const FAST = { quietMs: 5, maxAfterLoadMs: 20, emptyWaitCapMs: 20 } as const

describe('run()', () => {
  it('走完整流程后只发一条 ok 消息，带标注计数与视口宽度', async () => {
    const doc = makeDoc('<div id="ghost">影子</div><p>正文</p>')
    const { win, posted } = fakeWin(doc, (el) => (el.id === 'ghost' ? { display: 'none' } : {}))
    captureAgentMain(cfgOf({ ...FAST, sweep: false }), win).run()

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
    captureAgentMain(cfgOf({ ...FAST, sweep: true }), win).run()
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
    captureAgentMain(cfgOf({ ...FAST, sweep: false, maxHtmlBytes: 32 }), win).run()
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
    captureAgentMain(cfgOf({ ...FAST, sweep: false }), win).run()
    const msg = (await waitPost(posted)).msg
    expect(msg.ok).toBe(false)
    if (msg.ok) throw new Error('unreachable')
    expect(msg.reason.length).toBeGreaterThan(0)
    expect(msg.reason).not.toBe('too-large')
  })
})

/**
 * v2：内容感知的静默判定 + blockedScripts 信号 + collect()。
 *
 * 全部用假定时器并断言**精确时刻**：这一组用例守的是时序，真定时器下只能写「大概」。
 * 假窗口的 load 由 `setTimeout(fn, 0)` 代发，所以静默判定从 t=0 起算，
 * 用默认配置的真实数值（700 / 6000 / 10000 / 20000）直接对。
 *
 * `FRAMES`：quiesce 收工后还有 twoFrames()，假窗口的 rAF 是 0ms 定时器，而假定时器会把
 * **tick 期间**新建的 0ms 定时器排到 +1ms（@sinonjs/fake-timers 的 duringTick 规则），
 * 两帧就是 +2ms。它与 v1/v2 无关（v1 同样是 702），断言时单独加上，免得看起来像是代理多等了 2ms。
 */
describe('run() 的静默判定（v2：内容感知）', () => {
  /** 330 字，稳过 minTextChars=200 */
  const LONG = '这是一段足够长的正文。'.repeat(30)
  const T = { sweep: false } as const
  const FRAMES = 2
  let t0 = 0

  beforeEach(() => {
    vi.useFakeTimers()
    t0 = Date.now()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 把假时钟拨到「开跑后第 ms 毫秒」 */
  const advanceTo = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms - (Date.now() - t0))
  }

  const okOf = (posted: Posted[]): Extract<CaptureAgentMessage, { ok: true }> => {
    expect(posted).toHaveLength(1)
    const msg = posted[0].msg
    if (!msg.ok) throw new Error('capture failed: ' + msg.reason)
    return msg
  }

  /**
   * 断言 quiesce 恰在 `stopAt` 收工：此前一毫秒还没有消息，两帧之后消息发出，
   * 且发出时刻精确等于 stopAt + FRAMES（早收工或晚收工都会让这个等式不成立）。
   */
  const expectStopAt = async (posted: Posted[], stopAt: number): Promise<Extract<CaptureAgentMessage, { ok: true }>> => {
    await advanceTo(stopAt + FRAMES - 1)
    expect(posted).toHaveLength(0)
    await advanceTo(stopAt + FRAMES)
    const msg = okOf(posted)
    expect(posted[0].at - t0).toBe(stopAt + FRAMES)
    return msg
  }

  it('默认配置钉住：minTextChars=200 / emptyWaitCapMs=10000，且随 cfg 一起注进 srcdoc', () => {
    expect(DEFAULT_CAPTURE_CONFIG.minTextChars).toBe(200)
    expect(DEFAULT_CAPTURE_CONFIG.emptyWaitCapMs).toBe(10000)
    // 回归红线依赖这三个旧值不动
    expect(DEFAULT_CAPTURE_CONFIG.quietMs).toBe(700)
    expect(DEFAULT_CAPTURE_CONFIG.maxAfterLoadMs).toBe(6000)
    expect(DEFAULT_CAPTURE_CONFIG.hardTimeoutMs).toBe(20000)
    const out = buildCaptureSrcdoc('<html><head></head><body></body></html>', BASE, cfgOf())
    expect(out).toContain('"minTextChars":200')
    expect(out).toContain('"emptyWaitCapMs":10000')
  })

  describe('回归红线：已有正文的页面与 v1 时序完全一致', () => {
    it('一开始就有正文 → 第一个静默 tick（quietMs）收工，一毫秒不多', async () => {
      const { win, posted } = fakeWin(makeDoc(`<article><p>${LONG}</p></article>`))
      captureAgentMain(cfgOf(T), win).run()
      const msg = await expectStopAt(posted, 700)
      expect(msg.blockedScripts).toBe(0)
    })

    it('静默窗口内的 DOM 变更照旧重新计时：t=500 变更 → t=1200 收工', async () => {
      const doc = makeDoc(`<article><p id="p">${LONG}</p></article>`)
      const { win, posted } = fakeWin(doc)
      captureAgentMain(cfgOf(T), win).run()
      await advanceTo(500)
      doc.getElementById('p')!.setAttribute('data-late', '1')
      await expectStopAt(posted, 1200)
    })

    it('永不静默的有正文页面照旧在 maxAfterLoadMs 封顶，不会被顺延到 emptyWaitCapMs', async () => {
      const doc = makeDoc(`<article><p id="p">${LONG}</p></article>`)
      const { win, posted } = fakeWin(doc)
      let n = 0
      const ticker = setInterval(() => doc.getElementById('p')!.setAttribute('data-n', String(n++)), 300)
      try {
        captureAgentMain(cfgOf(T), win).run()
        await expectStopAt(posted, 6000)
      } finally {
        clearInterval(ticker)
      }
    })
  })

  describe('空页面（缺陷 G：JS 包还在下载的页面同样没有 DOM 变更）', () => {
    it('空 body 不在第一个静默 tick 收工，而是等满 emptyWaitCapMs', async () => {
      const { win, posted } = fakeWin(makeDoc('<div id="root"></div>'))
      captureAgentMain(cfgOf(T), win).run()
      await advanceTo(700 + FRAMES)
      expect(posted).toHaveLength(0)
      // 旧的 maxAfterLoadMs 封顶也拦不住它
      await advanceTo(6000 + FRAMES)
      expect(posted).toHaveLength(0)
      const msg = await expectStopAt(posted, 10000)
      expect(msg.blockedScripts).toBe(0)
      expect(msg.html).toContain('<div id="root"></div>')
    })

    it('一直在变、却始终没有正文的页面（转圈动画）：同样封顶在 emptyWaitCapMs', async () => {
      const doc = makeDoc('<div id="root"><i id="spin"></i></div>')
      const { win, posted } = fakeWin(doc)
      let n = 0
      const ticker = setInterval(() => doc.getElementById('spin')!.setAttribute('data-n', String(n++)), 300)
      try {
        captureAgentMain(cfgOf(T), win).run()
        await expectStopAt(posted, 10000)
      } finally {
        clearInterval(ticker)
      }
    })

    it('正文晚到（已经空转了好几个静默窗口）→ 出现后一个 quietMs 内收工，远早于上限', async () => {
      const doc = makeDoc('<div id="root"></div>')
      const { win, posted } = fakeWin(doc)
      captureAgentMain(cfgOf(T), win).run()
      // 700 / 1400 / 2100 三个静默 tick 都因为没有正文而放过
      await advanceTo(2500)
      expect(posted).toHaveLength(0)
      doc.getElementById('root')!.innerHTML = `<article><p>${LONG}</p></article>`
      // 这次变更让静默重新计时：2500 + 700
      const msg = await expectStopAt(posted, 3200)
      expect(msg.html).toContain('这是一段足够长的正文。')
    })

    it('宿主没有 MutationObserver 也不会错过晚到的正文：重上弦的静默定时器本身就是轮询', async () => {
      const doc = makeDoc('<div id="root"></div>')
      const { win, posted } = fakeWin(doc, () => ({}), { MutationObserver: undefined })
      captureAgentMain(cfgOf(T), win).run()
      await advanceTo(2500)
      doc.getElementById('root')!.innerHTML = `<article><p>${LONG}</p></article>`
      // 没有观察者来重新计时 → 下一个既定 tick（2800）直接看见正文
      await expectStopAt(posted, 2800)
    })

    it('script / style / noscript / template 里的字与纯空白都不算正文', async () => {
      const junk = 'x'.repeat(400)
      const doc = makeDoc(
        `<div id="root">   \n\t  </div><script>var a = "${junk}"</script><style>.a::after{content:"${junk}"}</style>` +
          `<noscript>${junk}</noscript><template><p>${junk}</p></template>`,
      )
      const { win, posted } = fakeWin(doc)
      captureAgentMain(cfgOf(T), win).run()
      await expectStopAt(posted, 10000)
    })

    it('门槛按累计算：分散在许多节点里的短文本加起来够数就算有正文', async () => {
      const items = Array.from({ length: 50 }, (_, i) => `<li><span> 条目${i} </span></li>`).join('')
      const { win, posted } = fakeWin(makeDoc(`<ul>${items}</ul>`))
      captureAgentMain(cfgOf({ ...T, minTextChars: 100 }), win).run()
      await expectStopAt(posted, 700)
    })

    it('差一个字也不算：199 字照样等满上限', async () => {
      const short = fakeWin(makeDoc(`<p>${'字'.repeat(199)}</p>`))
      captureAgentMain(cfgOf(T), short.win).run()
      await expectStopAt(short.posted, 10000)
    })

    it('恰好 200 字（跨节点累计、两端空白不计）→ 第一个静默 tick 收工', async () => {
      const enough = fakeWin(makeDoc(`<p>${'字'.repeat(120)}</p><p>  ${'字'.repeat(80)}  </p>`))
      captureAgentMain(cfgOf(T), enough.win).run()
      await expectStopAt(enough.posted, 700)
    })

    it('minTextChars=0 关掉内容感知 → 空页面也在第一个静默 tick 收工（v1 行为）', async () => {
      const { win, posted } = fakeWin(makeDoc('<div id="root"></div>'))
      captureAgentMain(cfgOf({ ...T, minTextChars: 0 }), win).run()
      await expectStopAt(posted, 700)
    })

    it('maxAfterLoadMs 比 emptyWaitCapMs 还大时：过了 emptyWaitCapMs 的第一个静默 tick 收工', async () => {
      const { win, posted } = fakeWin(makeDoc('<div id="root"></div>'))
      captureAgentMain(cfgOf({ ...T, maxAfterLoadMs: 15000, emptyWaitCapMs: 3000 }), win).run()
      // tick 在 700 的整数倍上：2800 还没到上限，3500 是第一个越过 3000 的
      await expectStopAt(posted, 3500)
    })
  })

  describe('blockedScripts：外链脚本加载失败的实测信号', () => {
    /**
     * 充当 error 事件 target 的外链脚本元素。**不接进文档**：happy-dom 对接入文档的 `<script src>`
     * 会真的尝试加载，然后在 stderr 里刷一屏「JavaScript file loading is disabled」。
     * 代理只看 `event.target` 的标签名与 src，元素在不在树上无所谓。
     */
    const scriptEl = (doc: Document, attrs: Record<string, string>): Element => {
      const el = doc.createElement('script')
      for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value)
      return el
    }

    it('error 监听器在**构造时**就以捕获阶段挂上（先于站点任何脚本，不等 run）', () => {
      const h = fakeWin(makeDoc('<div id="root"></div>'))
      captureAgentMain(cfgOf(T), h.win)
      expect(h.errorListeners).toHaveLength(1)
      expect(h.errorListeners[0].capture).toBe(true)
    })

    it('被拦的 `<script src>` → 空 body 也在第一个静默 tick 收工，并回报 blockedScripts: 1', async () => {
      // z.ai 博客的形态：纯客户端渲染的空壳 + 走 CORS 的 module 入口
      const doc = makeDoc('<div id="root"></div>')
      const h = fakeWin(doc)
      const agent = captureAgentMain(cfgOf(T), h.win)
      // 脚本失败发生在 run() 之前（解析 head 时）也得算进去
      h.fireError(scriptEl(doc, { type: 'module', crossorigin: '', src: '/blog/assets/index.js' }))
      agent.run()
      const msg = await expectStopAt(h.posted, 700)
      expect(msg.blockedScripts).toBe(1)
      expect(msg.html).toContain('<div id="root"></div>')
    })

    it('等待途中才失败的脚本：下一个静默 tick 就走，不再耗到上限', async () => {
      const doc = makeDoc('<div id="root"></div>')
      const h = fakeWin(doc)
      captureAgentMain(cfgOf(T), h.win).run()
      await advanceTo(1500)
      expect(h.posted).toHaveLength(0)
      h.fireError(scriptEl(doc, { src: 'https://cdn.example/app.js' }))
      h.fireError(scriptEl(doc, { src: 'https://cdn.example/vendor.js' }))
      const msg = await expectStopAt(h.posted, 2100)
      expect(msg.blockedScripts).toBe(2)
    })

    it('非脚本目标、内联脚本、window 自身的 error 都不计数 → 空页面照旧等满上限', async () => {
      const doc = makeDoc('<div id="root"></div><img id="pic" src="https://cdn.example/a.png">')
      const h = fakeWin(doc)
      captureAgentMain(cfgOf(T), h.win).run()
      h.fireError(doc.getElementById('pic'))
      h.fireError(doc.createElement('link'))
      // 没有 src（内联脚本）或 src 为空：不是「外链脚本加载失败」
      h.fireError(scriptEl(doc, { id: 'inline' }))
      h.fireError(scriptEl(doc, { src: '' }))
      h.fireError(h.win)
      h.fireError(null)
      h.fireError(undefined)
      const msg = await expectStopAt(h.posted, 10000)
      expect(msg.blockedScripts).toBe(0)
    })

    it('失败消息同样带 blockedScripts', async () => {
      const doc = makeDoc(`<p>${LONG}</p>`)
      const h = fakeWin(doc)
      const agent = captureAgentMain(cfgOf({ ...T, maxHtmlBytes: 32 }), h.win)
      h.fireError(scriptEl(doc, { src: 'https://cdn.example/app.js' }))
      agent.run()
      await advanceTo(700 + FRAMES)
      expect(h.posted).toHaveLength(1)
      expect(h.posted[0].msg).toEqual({
        type: 'pc-capture',
        ok: false,
        reason: 'too-large',
        blockedScripts: 1,
        agentVersion: CAPTURE_AGENT_VERSION,
      })
    })

    it('宿主的 addEventListener 抛错也不影响构造与捕获', async () => {
      const h = fakeWin(makeDoc(`<p>${LONG}</p>`), () => ({}), {
        addEventListener: (type: string, fn: () => void) => {
          if (type === 'error') throw new Error('nope')
          if (type === 'load') setTimeout(fn, 0)
        },
      })
      captureAgentMain(cfgOf(T), h.win).run()
      const msg = await expectStopAt(h.posted, 700)
      expect(msg.blockedScripts).toBe(0)
    })
  })

  describe('硬超时压过一切', () => {
    it('空页面的等待上限比硬超时还长 → 硬超时到点就发（不经两帧，直接 finish）', async () => {
      const { win, posted } = fakeWin(makeDoc('<div id="root"></div>'))
      captureAgentMain(cfgOf({ ...T, maxAfterLoadMs: 60000, emptyWaitCapMs: 60000 }), win).run()
      await advanceTo(19999)
      expect(posted).toHaveLength(0)
      await advanceTo(20000)
      okOf(posted)
      expect(posted[0].at - t0).toBe(20000)
      // 之后 quiesce 的定时器陆续到点，也不会再发第二条
      await advanceTo(180000)
      expect(posted).toHaveLength(1)
    })

    it('硬超时短于 emptyWaitCapMs 时同理（3s 硬超时 vs 10s 空页面上限）', async () => {
      const { win, posted } = fakeWin(makeDoc('<div id="root"></div>'))
      captureAgentMain(cfgOf({ ...T, hardTimeoutMs: 3000 }), win).run()
      await advanceTo(2999)
      expect(posted).toHaveLength(0)
      await advanceTo(3000)
      okOf(posted)
      expect(posted[0].at - t0).toBe(3000)
      await advanceTo(60000)
      expect(posted).toHaveLength(1)
    })
  })

  describe('collect()', () => {
    it('resolve 一次 ok 消息，且**从不** postMessage；之后硬超时到点也不会补发', async () => {
      const { win, posted } = fakeWin(makeDoc(`<article><p>${LONG}</p></article>`))
      const sink = vi.fn()
      const promise = captureAgentMain(cfgOf(T), win)
        .collect()
        .then((msg) => {
          sink(msg)
          return msg
        })
      await advanceTo(700 + FRAMES - 1)
      expect(sink).not.toHaveBeenCalled()
      await advanceTo(700 + FRAMES)
      const msg = await promise
      expect(msg.ok).toBe(true)
      if (!msg.ok) throw new Error('unreachable')
      expect(msg.type).toBe('pc-capture')
      expect(msg.agentVersion).toBe(CAPTURE_AGENT_VERSION)
      expect(msg.blockedScripts).toBe(0)
      expect(msg.title).toBe('快照标题')
      expect(msg.html).toContain('这是一段足够长的正文。')
      await advanceTo(180000)
      expect(sink).toHaveBeenCalledTimes(1)
      expect(posted).toHaveLength(0)
    })

    it('顶层页面（parent === window）里单独调用：消息只从 Promise 出来，window.postMessage 没被碰过', async () => {
      const selfPost = vi.fn()
      const h = fakeWin(makeDoc(`<article><p>${LONG}</p></article>`), () => ({}), { postMessage: selfPost })
      ;(h.win as unknown as { parent: unknown }).parent = h.win
      const promise = captureAgentMain(cfgOf(T), h.win).collect()
      await advanceTo(700 + FRAMES)
      expect((await promise).ok).toBe(true)
      expect(selfPost).not.toHaveBeenCalled()
    })

    it('失败也走 resolve（ok:false），不 reject、不 postMessage', async () => {
      const { win, posted } = fakeWin(null)
      const promise = captureAgentMain(cfgOf(T), win).collect()
      await advanceTo(10)
      const msg = await promise
      expect(msg.ok).toBe(false)
      if (msg.ok) throw new Error('unreachable')
      expect(msg.reason.length).toBeGreaterThan(0)
      expect(msg.blockedScripts).toBe(0)
      expect(posted).toHaveLength(0)
    })

    it('重复 collect() 拿到同一条消息，流程只跑一遍（晚到的那次直接拿现成结果）', async () => {
      const { win, posted } = fakeWin(makeDoc(`<article><p>${LONG}</p></article>`))
      const agent = captureAgentMain(cfgOf(T), win)
      const first = agent.collect()
      const second = agent.collect()
      await advanceTo(700 + FRAMES)
      const a = await first
      expect(await second).toBe(a)
      expect(await agent.collect()).toBe(a)
      expect(posted).toHaveLength(0)
    })

    it('不用 collect() 时 run() 照旧向 parent 发且只发一条', async () => {
      const { win, posted } = fakeWin(makeDoc(`<article><p>${LONG}</p></article>`))
      const agent = captureAgentMain(cfgOf(T), win)
      agent.run()
      // 重入无害：第二次 run() 不会再起一套流程
      agent.run()
      await expectStopAt(posted, 700)
      expect(posted[0].origin).toBe('https://app.example')
      await advanceTo(180000)
      expect(posted).toHaveLength(1)
    })
  })
})
