import { HIDDEN_ATTR, PRE_ATTR } from './stampBlocks'

/**
 * 网页原貌导入 Tier 2 的「捕获代理」（PLAN-web-snapshot-sync.md §2.2 第 2 条）。
 *
 * 本文件分两半，边界必须守住：
 * - `captureAgentMain`：**注入到不透明源 iframe 里执行的脚本**。它被 `toString()` 序列化后拼进
 *   `<script>`，所以必须完全自包含——不引用模块作用域的任何标识符（常量、helper、类型枚举都不行），
 *   只吃入参 `cfg` 与可选的 `win`。属性名因此在函数体内以字符串字面量内联，
 *   与下面导出的常量靠单测保持一致（captureAgent.test.ts）。
 * - 其余导出（`buildCaptureSrcdoc` / 常量 / 类型）：跑在父页，普通模块代码。
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

/** 代理协议版本：消息里回传，父页据此判断能否解读（当前只有 1） */
export const CAPTURE_AGENT_VERSION = 1

/** 捕获代理在活树上标出的 fixed/sticky 元素：阅读器把它们改回 static，否则整页浮层会压住正文 */
export const FIXED_ATTR = 'data-pc-fixed'
/** 克隆树里由 `<link rel=stylesheet>` 转换而来的样式表占位：buildSnapshot 据此逐个抓取并内联 */
export const SHEET_ATTR = 'data-pc-sheet'

// 冻结的 DOM 契约里这两个属性由 stampBlocks 消费（跳过隐藏子树 / pre 文本不规整空白），
// 定义在那边，这里只转出，保证「一个属性名一处定义」。
export { HIDDEN_ATTR, PRE_ATTR }

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
  hardTimeoutMs: 20000,
  maxHtmlBytes: 8 * 1024 * 1024,
  sweep: true,
}

/** 代理 → 父页的唯一一条消息（只发一次，成败都发） */
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
      agentVersion: number
    }
  | { type: 'pc-capture'; ok: false; reason: string; agentVersion: number }

/**
 * 注入 iframe 的捕获代理主体。**改这个函数前先读文件头**：
 * 它整体被 `toString()` 拼进 `<script>`，所以函数体内不得出现任何模块作用域的引用
 * （包括上面的 `FIXED_ATTR` 等常量——属性名一律内联字面量），也不得用会生成运行时 helper 的语法
 * （TS enum、装饰器、低目标下的 async/await 降级……本文件用朴素 Promise 链就是为了这个）。
 *
 * 返回的三个方法在单测里被单独调用：`annotate()`（活树打标）、`serialize()`（克隆树清洗 → HTML）、
 * `run()`（完整流程 + postMessage）。生产里只用 `run()`。
 */
export function captureAgentMain(
  cfg: CaptureAgentConfig,
  win?: Window,
): { run(): void; serialize(): string; annotate(): { hidden: number; fixed: number; pre: number } } {
  /* eslint-disable */
  const w: any = win || window
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
  let posted = false

  function tagOf(el: any): string {
    return el && el.localName ? String(el.localName).toLowerCase() : ''
  }

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
    try {
      w.parent.postMessage(msg, cfg.parentOrigin)
    } catch {
      // 父页已经走了：无处可报，静默收尾（父页那边会走外层超时）
    }
  }

  function fail(reason: string): void {
    post({ type: 'pc-capture', ok: false, reason: String(reason || 'agent-error'), agentVersion: 1 })
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
        agentVersion: 1,
      })
    } catch (e) {
      fail(errText(e))
    }
  }

  function whenLoaded(): Promise<void> {
    return new Promise(function (resolve) {
      if (doc.readyState === 'complete') {
        resolve()
        return
      }
      try {
        w.addEventListener('load', function () {
          resolve()
        }, { once: true })
      } catch {
        resolve()
      }
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

  /** MutationObserver 静默：连续 quietMs 无变更即认为渲染稳定，load 后总时长封顶 maxAfterLoadMs */
  function quiesce(): Promise<void> {
    return new Promise(function (resolve) {
      let observer: any = null
      let quietTimer: any = 0
      let capTimer: any = 0
      let done = false
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
          quietTimer = w.setTimeout(stop, cfg.quietMs)
        } catch {
          stop()
        }
      }
      try {
        capTimer = w.setTimeout(stop, cfg.maxAfterLoadMs)
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

  function run(): void {
    let hard: any = 0
    try {
      hard = w.setTimeout(function () {
        finish()
      }, cfg.hardTimeoutMs)
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
        .then(
          function () {
            clearHard()
            finish()
          },
          function (e: any) {
            clearHard()
            fail(errText(e))
          },
        )
    } catch (e) {
      clearHard()
      fail(errText(e))
    }
  }

  return { run: run, serialize: serialize, annotate: annotate }
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
