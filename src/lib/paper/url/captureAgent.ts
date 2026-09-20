/**
 * 网页原貌导入 Tier 2 的「捕获代理」（PLAN-web-snapshot-sync.md §2.2 第 2 条）。
 *
 * 本文件分两半，边界必须守住：
 * - `captureAgentMain`：**注入到不透明源 iframe 里执行的脚本**。它被 `toString()` 序列化后拼进
 *   `<script>`，所以必须完全自包含——不引用模块作用域的任何标识符（常量、helper、类型枚举都不行），
 *   只吃入参 `cfg` 与可选的 `win`。属性名因此在函数体内以字符串字面量内联，
 *   与导出常量靠单测保持一致（captureAgent.test.ts）。
 * - 其余导出（`buildCaptureSrcdoc` / 常量 / 类型）：跑在父页，普通模块代码。
 *
 * **本文件零 import、不碰 DOM lib 类型**（PLAN-url-import-csr-render.md §3 A1 / §4）：它还会被原样
 * 编进 Node 服务端（`server/tsconfig.json`：`lib: ["ES2023"]`、`types: ["node"]`、NodeNext），
 * 由无头浏览器 `page.evaluate('(' + captureAgentMain.toString() + ')(cfg).collect()')` 在**真实页面**里跑。
 * 所以这里不能出现 `Window` / `Document` / `window` 这类只在 DOM lib 里有声明的名字，
 * 也不能有相对 import（NodeNext 要求带扩展名，客户端打包器又不认）。宿主对象一律 `any`。
 *
 * 代理只做「把渲染完的活树变成一份静态 HTML 字符串」这一件事：不抓资源、不 sanitize、不打标，
 * 那些都在父页的 buildSnapshot 里做（沙箱内拿不到我们的 fetch 凭据，也不该有）。
 *
 * 站点自带的 `<meta http-equiv="Content-Security-Policy">` 会在包 srcdoc 时被摘掉（同 `<base>`）：
 * 多份 CSP 取**交集**，站点若写死 `script-src 'self'`，我们注入的内联代理脚本会被它一起挡掉 →
 * 代理永不 postMessage → 只能等父页外层超时再回退 Tier 1。摘掉它只影响这个不透明源沙箱内的
 * 一次性捕获（我们自己的 CAPTURE_CSP 仍然生效），快照存档里本就不含任何脚本执行面。
 * 站点若通过**响应头**下发 CSP，srcdoc 继承不到，同样不受影响。
 */

/**
 * 代理协议版本：消息里回传，父页据此判断能否解读。
 * - 1：初版
 * - 2：内容感知的静默判定（空页面不再在第一个静默窗口收工）、`blockedScripts` 信号、`collect()`
 *
 * 函数体里引用不到这个常量，那边是内联字面量，靠单测保持一致——改这里要同时改 `agentVersion: 2` 两处。
 */
export const CAPTURE_AGENT_VERSION = 2

/** 捕获代理在活树上标出的 fixed/sticky 元素：阅读器把它们改回 static，否则整页浮层会压住正文 */
export const FIXED_ATTR = 'data-pc-fixed'
/** 克隆树里由 `<link rel=stylesheet>` 转换而来的样式表占位：buildSnapshot 据此逐个抓取并内联 */
export const SHEET_ATTR = 'data-pc-sheet'

// 冻结的 DOM 契约里还有 `data-pc-hidden` / `data-pc-pre` 两个属性，由 stampBlocks 消费
// （跳过隐藏子树 / pre 文本不规整空白），常量 `HIDDEN_ATTR` / `PRE_ATTR` 定义在那边。
// 以前这里转出过它们；为了零 import（见文件头）不再转出，要用请直接从 './stampBlocks' 取。
// 函数体内联的字面量与那两个常量的一致性仍由 captureAgent.test.ts 锁住。

/**
 * 注入到 srcdoc 的 CSP：只管住捕获期的这个不透明源 iframe。
 *
 * 不能用 `default-src https:`——那会把站点自己的**内联** MathJax 配置脚本和我们的代理脚本一起挡掉
 * （内联脚本不属于任何 https 源）。所以 script-src 显式带 `'unsafe-inline' 'unsafe-eval'`
 * （MathJax v3 的 CHTML 输出要 eval）。sandbox 属性只给 `allow-scripts`：不透明源意味着
 * 站点脚本拿不到我们的 cookie/localStorage，CSP 再挡住表单提交、子框架与 object。
 */
export const CAPTURE_CSP =
  "script-src https: 'unsafe-inline' 'unsafe-eval'; style-src https: 'unsafe-inline'; img-src https: data: blob:; font-src https: data:; connect-src https:; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'"

export interface CaptureAgentConfig {
  /** postMessage 的 targetOrigin：父页编译期注入（拿不到具体 origin 时才回退 `'*'`） */
  parentOrigin: string
  /** MutationObserver 连续静默多久算「渲染完了」 */
  quietMs: number
  /** load 之后最多再等多久（静默判定的封顶，防无限动画/轮询页面永远不静默） */
  maxAfterLoadMs: number
  /**
   * 「页面已经有正文了」的门槛：body 下文本节点 trim 后累计到这么多字符就算有（script/style/noscript/
   * template 子树不计）。没到门槛的静默不算数——JS 包还在下载的客户端渲染页面同样「没有 DOM 变更」，
   * 光看静默会在 ~2s 时把一张白纸当成渲染完毕。与 buildSnapshot 的正文下限（200 字）同量级，
   * 再低就会被导航条/页脚那点文字骗过去。`0` = 关掉内容感知，退回 v1 行为。
   */
  minTextChars: number
  /**
   * 空页面（没到 `minTextChars`、也没有脚本被拦）最多陪它等多久，从静默判定开始起算。
   * 空页面的封顶由 `maxAfterLoadMs` 延长到这里（比它小则不起作用）；已有正文的页面完全不受影响，
   * 时序与 v1 一致。整体仍受 `hardTimeoutMs` 约束。
   */
  emptyWaitCapMs: number
  /**
   * 文档解析完毕后，最多再给 `load` 事件多久。
   * 沙箱里 `load` 常常永不触发（子资源被 CSP/跨源挡住），到点就往下走。
   */
  afterParsedMs: number
  /** 代理自己的硬超时：到点有什么序列化什么 */
  hardTimeoutMs: number
  /** 序列化结果的字节上限，超了回 `{ok:false, reason:'too-large'}` */
  maxHtmlBytes: number
  /** 是否做滚动扫描（触发懒加载图片/IntersectionObserver 动画） */
  sweep: boolean
}

export const DEFAULT_CAPTURE_CONFIG: Omit<CaptureAgentConfig, 'parentOrigin'> = {
  quietMs: 700,
  maxAfterLoadMs: 6000,
  minTextChars: 200,
  emptyWaitCapMs: 10000,
  afterParsedMs: 1500,
  hardTimeoutMs: 20000,
  maxHtmlBytes: 8 * 1024 * 1024,
  sweep: true,
}

/**
 * 代理 → 父页的唯一一条消息（只发一次，成败都发）。
 *
 * `blockedScripts`（v2 起）：捕获期间加载失败的**外链** `<script src>` 个数——实测信号，不是猜的。
 * 不透明源沙箱里 `<script type="module" crossorigin>` 一律走 CORS，资源不带 `access-control-*` 头
 * 就整个被拦，纯客户端渲染的页面于是永远是空壳。调用方据此把「正文为空」说成人话
 * （脚本被跨源策略拦了，阅读模式同样没用），而不是笼统的「渲染超时」。
 */
export type CaptureAgentMessage =
  | {
      type: 'pc-capture'
      ok: true
      html: string
      title: string
      finalUrl: string
      viewportWidth: number
      hidden: number
      fixed: number
      blockedScripts: number
      agentVersion: number
    }
  | { type: 'pc-capture'; ok: false; reason: string; blockedScripts: number; agentVersion: number }

/** `captureAgentMain` 的返回值。宿主对象（窗口/文档）一律不出现在类型里，见文件头 */
export interface CaptureAgent {
  /** 完整流程，结果 `postMessage` 给 `parent`（srcdoc iframe 里用） */
  run(): void
  /**
   * 完整流程，结果从返回的 Promise 里拿，**不** `postMessage`（服务端无头浏览器用：
   * 顶层页面里 `parent === window`，发消息只会发给自己）。成败都 resolve，从不 reject。
   */
  collect(): Promise<CaptureAgentMessage>
  serialize(): string
  annotate(): { hidden: number; fixed: number; pre: number }
}

/**
 * 注入 iframe 的捕获代理主体。**改这个函数前先读文件头**：
 * 它整体被 `toString()` 拼进 `<script>`，所以函数体内不得出现任何模块作用域的引用
 * （包括上面的 `FIXED_ATTR` 等常量——属性名一律内联字面量），也不得用会生成运行时 helper 的语法
 * （TS enum、装饰器、低目标下的 async/await 降级……本文件用朴素 Promise 链就是为了这个）。
 *
 * 返回的方法在单测里被单独调用：`annotate()`（活树打标）、`serialize()`（克隆树清洗 → HTML）、
 * `run()`（完整流程 + postMessage）、`collect()`（完整流程 + Promise）。
 * 生产里 iframe 用 `run()`，服务端渲染用 `collect()`。
 *
 * `win` 只给单测注入假窗口用，类型故意是 `unknown`：本文件不引用 DOM lib（见文件头）。
 */
export function captureAgentMain(cfg: CaptureAgentConfig, win?: unknown): CaptureAgent {
  /* eslint-disable */
  const w: any = win || globalThis
  const doc: any = w.document
  // 不标 data-pc-hidden 的元素：根元素（body 一标整页就没了）与替换/空元素、装载面
  // （img 的 display:none 常是懒加载占位，标了会连带 stampBlocks 丢图）。其余任何元素——
  // 包括 ul/ol/table/form/aside/dialog/details/figure/header/footer 这类容器——只要自身
  // display:none / visibility:hidden 就整棵标掉：display 不继承，只看文本标签会漏掉
  // 藏在隐藏容器里的菜单项/弹窗文字，它们随后会被打成块、进译文与语音上下文。
  const NO_HIDE_TAGS = [
    'html', 'body', 'head', 'hr', 'br', 'wbr', 'img', 'picture', 'source', 'track',
    'video', 'audio', 'canvas', 'input', 'textarea', 'select', 'option', 'iframe',
    'object', 'embed', 'script', 'style', 'link', 'meta', 'title', 'base', 'template', 'noscript',
  ]
  // 这三个标签的 white-space: pre* 是 UA 默认值，stampBlocks 已按标签名兜住，不必再标
  const IMPLICIT_PRE = ['pre', 'code', 'textarea']
  // 克隆树上整体删掉的标签（脚本执行面 + 不会被快照消费的嵌入内容 + base）
  const DROP_SELECTOR = 'script, noscript, iframe, object, embed, template, base'
  // 需要查 javascript: 的 URL 属性
  const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'xlink:href']
  // 判「有没有正文」时整棵跳过的子树：里面的文本节点不是读者看得到的字
  // （沙箱里脚本是开着的，`<noscript>` 的内容按纯文本解析成一个文本节点，不跳就会被它骗过去）
  const NO_TEXT_TAGS = ['script', 'style', 'noscript', 'template']
  let posted = false
  // 已产出的那条消息（collect() 晚到时直接给它）
  let result: any = null
  // collect() 装的接收口：有它就把消息交给它，不再 postMessage
  let sink: any = null
  let running = false
  // 加载失败的外链脚本计数，见下面的监听器与 CaptureAgentMessage 的注释
  let blockedScripts = 0

  function tagOf(el: any): string {
    return el && el.localName ? String(el.localName).toLowerCase() : ''
  }

  // **构造时就挂**，不等 run()：代理是 `<head>` 里的第一个脚本，先于站点任何脚本执行，
  // 此刻挂上才不会漏掉头几个 `<script src>` 的失败。资源加载错误不冒泡，
  // 但捕获阶段在 window 上看得到（第三个参数必须是 true）。
  // 只数「带 src 的 script 元素」：img/link 的失败与本信号无关；内联脚本的运行时异常
  // 走的是 window 自身的 error（target 不是元素），同样不计。
  try {
    w.addEventListener(
      'error',
      function (event: any): void {
        try {
          const target = event ? event.target : null
          if (tagOf(target) !== 'script') return
          const src = typeof target.getAttribute === 'function' ? target.getAttribute('src') : target.src
          if (src) blockedScripts++
        } catch {}
      },
      true,
    )
  } catch {}

  function errText(e: any): string {
    if (e && e.message) return String(e.message)
    const s = String(e)
    return s || 'agent-error'
  }

  /** 去掉全部空白与控制字符后再判前缀：挡住 `java\tscript:` / `JAVASCRIPT :` 这类变形 */
  function isJsUrl(value: string): boolean {
    return String(value).replace(/[\u0000-\u0020]+/g, '').toLowerCase().indexOf('javascript:') === 0
  }

  function absolutize(url: string, base: string): string {
    try {
      return new URL(String(url), base).href
    } catch {
      return String(url)
    }
  }

  function basename(url: string): string {
    const clean = String(url || '').split('#')[0].split('?')[0]
    const parts = clean.split('/')
    return parts[parts.length - 1] || ''
  }

  function placeholder(kind: string, label: string): any {
    const box = doc.createElement('div')
    box.setAttribute('class', 'pc-placeholder')
    box.setAttribute('data-pc-placeholder', kind)
    box.textContent = label
    return box
  }

  function replaceNode(oldNode: any, newNode: any): void {
    const parent = oldNode.parentNode
    if (parent) parent.replaceChild(newNode, oldNode)
  }

  /**
   * 活树打标：计算样式只在这里读一次（克隆树没有布局，读不到 computed style）。
   * - `data-pc-hidden`：display:none / visibility:hidden 的元素（容器也算，见 NO_HIDE_TAGS）；
   *   祖先已标过就跳过——querySelectorAll 是文档序，祖先先于后代，所以整棵子树只标根
   * - `data-pc-fixed`：position fixed/sticky（阅读器里改回 static）
   * - `data-pc-pre`：white-space: pre*（pre/code/textarea 是 UA 默认，不重复标）
   */
  function annotate(): { hidden: number; fixed: number; pre: number } {
    let hidden = 0
    let fixed = 0
    let pre = 0
    let all: any = null
    try {
      all = doc.querySelectorAll('*')
    } catch {
      return { hidden: hidden, fixed: fixed, pre: pre }
    }
    for (let i = 0; i < all.length; i++) {
      const el = all[i]
      let style: any = null
      try {
        style = w.getComputedStyle(el)
      } catch {
        style = null
      }
      if (!style) continue
      const name = tagOf(el)
      const position = String(style.position || '')
      if (position === 'fixed' || position === 'sticky') {
        el.setAttribute('data-pc-fixed', '1')
        fixed++
      }
      const ws = String(style.whiteSpace || '')
      if (ws.slice(0, 3) === 'pre' && IMPLICIT_PRE.indexOf(name) < 0) {
        el.setAttribute('data-pc-pre', '1')
        pre++
      }
      if (NO_HIDE_TAGS.indexOf(name) >= 0) continue
      if (String(style.display) !== 'none' && String(style.visibility) !== 'hidden') continue
      const parent = el.parentElement
      if (parent && parent.closest && parent.closest('[data-pc-hidden]')) continue
      el.setAttribute('data-pc-hidden', '1')
      hidden++
    }
    return { hidden: hidden, fixed: fixed, pre: pre }
  }

  /** 剥 on* 事件属性与 javascript: URL（克隆树上做，活树不动） */
  function scrubAttrs(el: any): void {
    const attrs = el.attributes
    if (!attrs) return
    const names: string[] = []
    for (let i = 0; i < attrs.length; i++) names.push(attrs[i].name)
    for (let i = 0; i < names.length; i++) {
      const name = names[i]
      const lower = name.toLowerCase()
      if (lower.slice(0, 2) === 'on') {
        el.removeAttribute(name)
        continue
      }
      if (URL_ATTRS.indexOf(lower) < 0) continue
      const value = el.getAttribute(name)
      if (value && isJsUrl(value)) el.removeAttribute(name)
    }
  }

  /**
   * 克隆 documentElement 并清洗成可存档的静态 HTML。
   *
   * 顺序有讲究：先按**文档序下标**把活树的 `img.currentSrc` / `canvas.toDataURL()` 搬到克隆树上
   * （克隆是深拷贝，两边 `querySelectorAll` 顺序一致），再做会改变节点集合的替换与删除。
   */
  function serialize(): string {
    const base = String(doc.baseURI || (w.location && w.location.href) || '')
    const clone: any = doc.documentElement.cloneNode(true)

    // 1) 图片：srcset/sizes 的选取结果只有活树知道（currentSrc），克隆树里固化成单一 src
    const liveImgs = doc.querySelectorAll('img')
    const cloneImgs = clone.querySelectorAll('img')
    for (let i = 0; i < cloneImgs.length; i++) {
      const img = cloneImgs[i]
      const live = liveImgs[i]
      // currentSrc 是浏览器按 srcset/sizes 实际选中的那张，只有活树知道；
      // 没有它就自己按 baseURI 绝对化 src 属性（等价于规范里的 img.src，但不依赖宿主实现）
      const picked = live ? String(live.currentSrc || '') : ''
      const attr = String(img.getAttribute('src') || '')
      if (picked) img.setAttribute('src', picked)
      else if (attr) img.setAttribute('src', absolutize(attr, base))
      else if (live && live.src) img.setAttribute('src', String(live.src))
      img.removeAttribute('srcset')
      img.removeAttribute('sizes')
      img.removeAttribute('loading')
    }

    // 2) canvas：只有活树能出像素；跨源污染时 toDataURL 抛 SecurityError → 占位
    const liveCanvas = doc.querySelectorAll('canvas')
    const cloneCanvas = clone.querySelectorAll('canvas')
    for (let i = 0; i < cloneCanvas.length; i++) {
      const node = cloneCanvas[i]
      const live = liveCanvas[i]
      let data = ''
      try {
        if (live && typeof live.toDataURL === 'function') data = String(live.toDataURL() || '')
      } catch {
        data = ''
      }
      if (data.slice(0, 5) === 'data:') {
        const img = doc.createElement('img')
        img.setAttribute('src', data)
        const width = node.getAttribute('width')
        const height = node.getAttribute('height')
        if (width) img.setAttribute('width', width)
        if (height) img.setAttribute('height', height)
        replaceNode(node, img)
      } else {
        replaceNode(node, placeholder('canvas', '[画布]'))
      }
    }

    // 3) video/audio：快照不保留媒体（CSP media-src 'none'），poster 能救则救，否则占位
    const videos = clone.querySelectorAll('video')
    for (let i = 0; i < videos.length; i++) {
      const video = videos[i]
      const poster = String(video.getAttribute('poster') || '').trim()
      if (poster) {
        const img = doc.createElement('img')
        img.setAttribute('src', absolutize(poster, base))
        const alt = String(video.getAttribute('title') || '').trim()
        if (alt) img.setAttribute('alt', alt)
        replaceNode(video, img)
        continue
      }
      const source = video.querySelector('source')
      const src = String((source && source.getAttribute('src')) || video.getAttribute('src') || '')
      const name = basename(src)
      replaceNode(video, placeholder('video', name ? '[视频：' + name + ']' : '[视频]'))
    }
    const audios = clone.querySelectorAll('audio')
    for (let i = 0; i < audios.length; i++) {
      const audio = audios[i]
      const source = audio.querySelector('source')
      const src = String((source && source.getAttribute('src')) || audio.getAttribute('src') || '')
      const name = basename(src)
      replaceNode(audio, placeholder('audio', name ? '[音频：' + name + ']' : '[音频]'))
    }

    // 4) 脚本执行面与嵌入内容整体删掉（`<style>` 保留：MathJax 注入的 #MJX-CHTML-styles 就在里面）
    const drop = clone.querySelectorAll(DROP_SELECTOR)
    for (let i = 0; i < drop.length; i++) {
      const node = drop[i]
      if (node.parentNode) node.parentNode.removeChild(node)
    }

    // 5) 样式表：只留 rel~=stylesheet，转成绝对 URL 的占位 link（父页按 [data-pc-sheet] 抓取并内联）；
    //    preload/prefetch/icon/manifest 一律删——它们只会让阅读器 iframe 再发一轮无用请求
    const links = clone.querySelectorAll('link')
    for (let i = 0; i < links.length; i++) {
      const link = links[i]
      const rel = String(link.getAttribute('rel') || '').toLowerCase().split(/\s+/)
      const href = String(link.getAttribute('href') || '').trim()
      if (rel.indexOf('stylesheet') < 0 || !href) {
        if (link.parentNode) link.parentNode.removeChild(link)
        continue
      }
      const sheet = doc.createElement('link')
      sheet.setAttribute('data-pc-sheet', '1')
      sheet.setAttribute('href', absolutize(href, base))
      const media = String(link.getAttribute('media') || '').trim()
      if (media) sheet.setAttribute('media', media)
      replaceNode(link, sheet)
    }

    // 6) 属性级清洗（放最后：前面新建的节点也一并过一遍）
    scrubAttrs(clone)
    const all = clone.querySelectorAll('*')
    for (let i = 0; i < all.length; i++) scrubAttrs(all[i])

    return String(clone.outerHTML || '')
  }

  function post(msg: any): void {
    if (posted) return
    posted = true
    result = msg
    // collect() 模式：交给接收口就完事，**不**再 postMessage——顶层页面里 parent 就是自己，
    // 发出去等于把整份 HTML 广播给站点脚本的 message 监听器
    if (sink) {
      const deliver = sink
      sink = null
      try {
        deliver(msg)
      } catch {}
      return
    }
    try {
      w.parent.postMessage(msg, cfg.parentOrigin)
    } catch {
      // 父页已经走了：无处可报，静默收尾（父页那边会走外层超时）
    }
  }

  function fail(reason: string): void {
    post({
      type: 'pc-capture',
      ok: false,
      reason: String(reason || 'agent-error'),
      blockedScripts: blockedScripts,
      agentVersion: 2,
    })
  }

  /** 打标 → 序列化 → 体积检查 → 发消息。硬超时与正常收尾都走这里，`posted` 保证只发一次 */
  function finish(): void {
    if (posted) return
    try {
      const counts = annotate()
      const html = serialize()
      let size = html.length
      try {
        size = new TextEncoder().encode(html).length
      } catch {
        size = html.length
      }
      if (size > cfg.maxHtmlBytes) {
        fail('too-large')
        return
      }
      post({
        type: 'pc-capture',
        ok: true,
        html: html,
        title: String(doc.title || ''),
        finalUrl: String(doc.baseURI || (w.location && w.location.href) || ''),
        viewportWidth: Number(w.innerWidth) || 0,
        hidden: counts.hidden,
        fixed: counts.fixed,
        blockedScripts: blockedScripts,
        agentVersion: 2,
      })
    } catch (e) {
      fail(errText(e))
    }
  }

  /**
   * 等页面「可以开始抓」——**解析完毕即可，不死等 `load`**。
   *
   * 捕获 iframe 是 `sandbox="allow-scripts"` 的不透明源：站点脚本一上来就可能因跨源访问抛错，
   * 子资源也常常永远落不了地（实测 openai.com 文章页在沙箱里 `readyState` 恒为 `interactive`，
   * `load` 从不触发）。旧代码把整条链吊在 `load` 上，于是只能等硬超时兜底，
   * `annotate()+serialize()` 被挤到最后 2s，父级先超时、iframe 被销毁，消息永远送不到。
   *
   * 与 reader 侧 0325c63「解析就绪即绑定不等 load」同一个道理：readyState 过了 loading 就推进，
   * 再给 `load` 一个**有上限**的额外窗口（真能 load 的页面照旧等它，等不到也不拖死）。
   */
  function whenLoaded(): Promise<void> {
    return new Promise(function (resolve) {
      if (doc.readyState === 'complete') {
        resolve()
        return
      }
      let done = false
      function finishWait(): void {
        if (done) return
        done = true
        resolve()
      }
      try {
        w.addEventListener('load', finishWait, { once: true })
      } catch {
        finishWait()
        return
      }
      // 解析完毕后最多再给 load 这么久；到点就走，不把整次捕获赌在 load 上
      function pollParsed(): void {
        if (done) return
        if (doc.readyState !== 'loading') {
          try {
            w.setTimeout(finishWait, cfg.afterParsedMs)
          } catch {
            finishWait()
          }
          return
        }
        try {
          w.setTimeout(pollParsed, 50)
        } catch {
          finishWait()
        }
      }
      pollParsed()
    })
  }

  /** MathJax v3：等排版承诺（封顶 8s）。v2 没有这个承诺，只能靠后面的静默判定兜住 */
  function waitMathJax(): Promise<void> {
    let promise: any = null
    try {
      const mj = w.MathJax
      promise = mj && mj.startup ? mj.startup.promise : null
    } catch {
      promise = null
    }
    if (!promise || typeof promise.then !== 'function') return Promise.resolve()
    return new Promise(function (resolve) {
      let timer: any = 0
      const done = function (): void {
        try {
          w.clearTimeout(timer)
        } catch {}
        resolve()
      }
      try {
        timer = w.setTimeout(done, 8000)
      } catch {}
      promise.then(done, done)
    })
  }

  /** 懒加载提升：loading=lazy → eager，data-src 系属性在 src 空/占位时提升为真实 src */
  function promoteLazy(): void {
    let imgs: any = null
    try {
      imgs = doc.querySelectorAll('img')
    } catch {
      return
    }
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i]
      if (String(img.getAttribute('loading') || '').toLowerCase() === 'lazy') img.setAttribute('loading', 'eager')
      const cur = String(img.getAttribute('src') || '').trim()
      const isPlaceholder =
        !cur || cur.slice(0, 5) === 'data:' || /(^|[\/._-])(placeholder|blank|spacer|loading|lazy)([._-]|$)/i.test(cur)
      if (!isPlaceholder) continue
      const real =
        img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src')
      if (real && String(real).trim()) img.setAttribute('src', String(real).trim())
    }
  }

  /** 滚动扫描：一屏一屏走到底再回顶，逼出 IntersectionObserver 懒加载；每屏后再提升一次懒加载属性 */
  function sweep(): Promise<void> {
    promoteLazy()
    if (!cfg.sweep) return Promise.resolve()
    return new Promise(function (resolve) {
      const height = Number(w.innerHeight) || 800
      let steps = 1
      try {
        const total = Number(doc.documentElement && doc.documentElement.scrollHeight) || 0
        steps = Math.ceil(total / height)
      } catch {
        steps = 1
      }
      if (!(steps > 0)) steps = 1
      if (steps > 40) steps = 40
      let k = 0
      function step(): void {
        if (k >= steps) {
          try {
            w.scrollTo(0, 0)
          } catch {}
          promoteLazy()
          resolve()
          return
        }
        try {
          w.scrollTo(0, k * height)
        } catch {}
        k++
        promoteLazy()
        try {
          w.setTimeout(step, 120)
        } catch {
          resolve()
        }
      }
      step()
    })
  }

  /**
   * 页面是否「已经有正文了」：累计 body 下文本节点 trim 后的长度，够 `cfg.minTextChars` 立刻返回
   * （大页面走不了几个节点就出结论，所以每个静默 tick 调一次也不心疼）。
   *
   * 手写的指针遍历（firstChild / nextSibling / parentNode），不用 TreeWalker：跳过整棵子树要靠
   * `NodeFilter.FILTER_REJECT`，那是又一个要从宿主窗口上取的全局；也不用递归，免得深树爆栈。
   * nodeType 用数字字面量（1 元素 / 3 文本），同样是为了不碰 `Node` 这个全局。
   * 任何异常都当「没有」——宁可多等一会儿（有上限），不能把白纸当成渲染完毕。
   */
  function hasContent(): boolean {
    const need = Number(cfg.minTextChars) || 0
    // 门槛关掉（或老配置里压根没这个字段）→ 不做内容感知，行为退回 v1
    if (!(need > 0)) return true
    try {
      const body = doc.body
      if (!body) return false
      let total = 0
      let node: any = body.firstChild
      while (node) {
        let next: any = null
        if (node.nodeType === 3) {
          total += String(node.nodeValue || '').trim().length
          if (total >= need) return true
        } else if (node.nodeType === 1 && NO_TEXT_TAGS.indexOf(tagOf(node)) < 0) {
          next = node.firstChild
        }
        if (!next) {
          // 没有（或不进）子节点：找下一个兄弟，没有就一路上溯，回到 body 即走完
          let cur: any = node
          while (cur && cur !== body && !cur.nextSibling) cur = cur.parentNode
          next = cur && cur !== body ? cur.nextSibling : null
        }
        node = next
      }
    } catch {}
    return false
  }

  /**
   * MutationObserver 静默：连续 quietMs 无变更即认为渲染稳定，load 后总时长封顶 maxAfterLoadMs。
   *
   * v2 起静默**只在页面有正文时才算数**。v1 是「静默一次就收工」，可 JS 包还在下载的客户端渲染页面
   * 同样一个 DOM 变更都没有，于是慢一点的 SPA 在 ~2.2s 被抓成白纸，而且没有任何东西在等正文出现。
   * 现在一个静默 tick（以及封顶定时器）要收工，得满足三者之一：
   * - `hasContent()`：正文已经在了——**已有正文的页面因此与 v1 时序完全一致**（同一个 tick 收工，
   *   多出来的只是一次同步的树遍历），这是回归红线，有单测钉着；
   * - `blockedScripts > 0`：有外链脚本加载失败，再等也不会有正文（被 CORS 拦掉的 SPA 入口就是这样），
   *   第一个静默 tick 就走，让调用方尽快拿到这个信号、如实报错，而不是陪空壳耗满上限；
   * - 从静默判定开始已过 `emptyWaitCapMs`：空页面的等待上限。
   * 都不满足就重新上弦接着等——重上弦的静默定时器顺带充当轮询，哪怕宿主没有 MutationObserver，
   * 晚到的正文也会在下一个 tick 被看见。
   */
  function quiesce(): Promise<void> {
    return new Promise(function (resolve) {
      let observer: any = null
      let quietTimer: any = 0
      let capTimer: any = 0
      let done = false
      const began = Date.now()
      const emptyCap = Number(cfg.emptyWaitCapMs) || 0
      function waited(): number {
        return Date.now() - began
      }
      /** 现在收工是否说得过去（见上）。便宜的判据放前面，树遍历只在需要时才做 */
      function settled(): boolean {
        if (blockedScripts > 0) return true
        if (hasContent()) return true
        return waited() >= emptyCap
      }
      function stop(): void {
        if (done) return
        done = true
        try {
          if (observer) observer.disconnect()
        } catch {}
        try {
          w.clearTimeout(quietTimer)
          w.clearTimeout(capTimer)
        } catch {}
        resolve()
      }
      function bump(): void {
        try {
          w.clearTimeout(quietTimer)
          quietTimer = w.setTimeout(onQuiet, cfg.quietMs)
        } catch {
          stop()
        }
      }
      function onQuiet(): void {
        if (done) return
        if (settled()) stop()
        else bump()
      }
      /** 封顶到点：空页面且没有脚本被拦 → 把封顶顺延到 emptyWaitCapMs（到点无条件收工），其余照旧 */
      function onCap(): void {
        if (done) return
        if (settled()) {
          stop()
          return
        }
        try {
          capTimer = w.setTimeout(stop, emptyCap - waited())
        } catch {
          stop()
        }
      }
      try {
        capTimer = w.setTimeout(onCap, cfg.maxAfterLoadMs)
      } catch {}
      try {
        const Observer = w.MutationObserver
        if (typeof Observer === 'function') {
          observer = new Observer(bump)
          observer.observe(doc.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          })
        }
      } catch {
        observer = null
      }
      bump()
    })
  }

  /** 两帧：让最后一次 DOM 变更真正完成布局与绘制（第一帧调度、第二帧已应用） */
  function twoFrames(): Promise<void> {
    return new Promise(function (resolve) {
      if (typeof w.requestAnimationFrame !== 'function') {
        try {
          w.setTimeout(resolve, 16)
        } catch {
          resolve()
        }
        return
      }
      w.requestAnimationFrame(function () {
        w.requestAnimationFrame(function () {
          resolve()
        })
      })
    })
  }

  /**
   * 硬超时**只保护到 `finish()` 开始为止**，不能在开跑前就解除。
   *
   * 旧写法是 `clearHard(); finish()`——在最贵的一步（annotate + cloneNode(true) + 九次树遍历 +
   * outerHTML + encode，2MB 文档动辄数秒）之前先把自己的保险拆了，只剩父级的绝对超时兜底；
   * 而硬超时又刚好设在父级预算减 2s 处，序列化根本做不完，父级先超时销毁 iframe，消息永远送不到。
   *
   * 现在：定时器只在 `finish()` **真正开始**时清除（`posted` 保证只发一条，重入无害）。
   *
   * `running`：整条流程只跑一遍。`run()` 之后再 `collect()`（或反过来）不会再扫一遍页面、
   * 再挂一套定时器——消息本来也只有一条。
   */
  function run(): void {
    if (running) return
    running = true
    let hard: any = 0
    let started = false
    function startFinish(): void {
      if (started) return
      started = true
      try {
        w.clearTimeout(hard)
      } catch {}
      finish()
    }
    try {
      hard = w.setTimeout(startFinish, cfg.hardTimeoutMs)
    } catch {
      hard = 0
    }
    function clearHard(): void {
      try {
        w.clearTimeout(hard)
      } catch {}
    }
    try {
      whenLoaded()
        .then(waitMathJax)
        .then(sweep)
        .then(quiesce)
        .then(twoFrames)
        .then(startFinish, function (e: any) {
          clearHard()
          fail(errText(e))
        })
    } catch (e) {
      clearHard()
      fail(errText(e))
    }
  }

  /**
   * `run()` 的 Promise 版：同一条流程、同一条消息，只是不 `postMessage`，改从返回值里拿。
   * 给服务端无头浏览器用（`page.evaluate('(…)(cfg).collect()')`）：那里代理跑在**顶层真实页面**，
   * `parent === window`，没有父页可报。成败都 resolve（失败是 `ok:false` 的消息），从不 reject，
   * 且只 resolve 一次——`post()` 的 `posted` 闸同样管着这条路。
   * 重复调用也各自拿到同一条消息：已经产出就直接给，还在跑就把接收口串起来。
   */
  function collect(): Promise<any> {
    return new Promise(function (resolve) {
      if (posted) {
        resolve(result)
        return
      }
      const prev = sink
      sink = prev
        ? function (msg: any): void {
            prev(msg)
            resolve(msg)
          }
        : resolve
      run()
    })
  }

  return { run: run, collect: collect, serialize: serialize, annotate: annotate }
}

const BASE_TAG_RE = /<base\b[^>]*>/gi
/**
 * 站点自带的 CSP meta（属性顺序任意、值可带引号或裸写、大小写不限）。
 * 与 BASE_TAG_RE 同样用 `[^>]*` 匹配标签体：CSP 指令里出现 `>` 不合法，够用。
 */
const CSP_META_RE =
  /<meta\b[^>]*?http-equiv\s*=\s*(?:"\s*content-security-policy[^"]*"|'\s*content-security-policy[^']*'|content-security-policy[^\s>]*)[^>]*>/gi
const HEAD_OPEN_RE = /<head(\s[^>]*)?>/i
const HTML_OPEN_RE = /<html(\s[^>]*)?>/i
const DOCTYPE_RE = /^\s*<!doctype[^>]*>/i

/** 属性上下文转义：finalUrl 来自远端，必须当不可信字符串处理 */
function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 把站点原始 HTML 包成捕获用的 srcdoc：在 `<head>` **最前**依次插入
 * `<meta charset>` → CSP meta → `<base href=finalUrl>` → 代理脚本。
 *
 * 顺序不可换：charset 必须在任何文本之前（否则字节被按 UA 默认编码猜）；CSP meta 必须先于第一个
 * 脚本才生效；`<base>` 必须先于代理脚本，代理靠 `document.baseURI` 解析相对 URL 与回报 finalUrl。
 * 站点自带的 `<base>` 先整体删掉——它会把相对 URL 解析到错误的目录；站点自带的 CSP meta 同样删掉——
 * 多份 CSP 取交集会连我们的代理脚本一起挡掉（见文件头）。
 */
export function buildCaptureSrcdoc(siteHtml: string, finalUrl: string, cfg: CaptureAgentConfig): string {
  const source = String(siteHtml || '')
    .replace(BASE_TAG_RE, '')
    .replace(CSP_META_RE, '')
  // cfg 里的 `<` 转成 <：JSON 里出现 `</script` 会提前闭合脚本标签（parentOrigin 来自 location，
  // 理论上不含尖括号，但注入点的转义不该依赖「理论上」）。整体再兜一次 `</script` 的转义。
  const config = JSON.stringify(cfg).replace(/</g, '\\u003c')
  const agent = ('(' + captureAgentMain.toString() + ')(' + config + ').run()').replace(/<\/(script)/gi, '<\\/$1')
  const inject =
    '<meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' + escapeAttr(CAPTURE_CSP) + '">' +
    '<base href="' + escapeAttr(finalUrl) + '">' +
    '<script>' + agent + '</script>'

  const head = HEAD_OPEN_RE.exec(source)
  if (head) {
    const at = head.index + head[0].length
    return source.slice(0, at) + inject + source.slice(at)
  }
  // 没有 <head>：自己造一个。有 <html> 就插在它后面，否则插在 doctype 之后（doctype 必须留在最前）
  const html = HTML_OPEN_RE.exec(source)
  if (html) {
    const at = html.index + html[0].length
    return source.slice(0, at) + '<head>' + inject + '</head>' + source.slice(at)
  }
  const doctype = DOCTYPE_RE.exec(source)
  const at = doctype ? doctype[0].length : 0
  return source.slice(0, at) + '<head>' + inject + '</head>' + source.slice(at)
}
