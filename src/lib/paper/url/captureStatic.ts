/**
 * 网页原貌导入的 Tier 1 静态捕获 + Tier 1/Tier 2 共用的原貌预处理（PLAN-web-snapshot-sync.md §2.2 第 3 条）。
 *
 * 浏览器 only（DOMParser）；happy-dom 下可测（captureStatic.test.ts）。不发任何网络请求：
 * 样式表/图片/字体的抓取归 buildSnapshot.ts，这里只把 DOM 整理成「可离线固化」的形态——
 * 所有资源引用绝对化、懒加载图提升、不能固化的媒体换成占位、脚本与外链装载面删掉。
 *
 * `preprocessFidelity` 对 Tier 2（iframe 渲染捕获）的产物同样适用且幂等：捕获代理已经做过的
 * 事（删脚本、link → data-pc-sheet、video → 占位）再跑一遍不会有副作用。
 */

import { toHttpUrl } from './cssRewrite'

export interface CapturedDocument {
  doc: Document
  finalUrl: string
  /**
   * 文档内 `<base href>` 相对 finalUrl 解析后的基准 URL。preprocess 会把 `<base>` 删掉，
   * 但内联 `<style>` 里的相对 `url()` 仍要按它解析（buildSnapshot 用），所以单独带出来。
   */
  baseUrl: string
  title: string
  /** rendered = iframe 渲染捕获（Tier 2）；static = DOMParser 静态捕获（Tier 1 回退） */
  mode: 'static' | 'rendered'
  /** 本次是否由 KaTeX auto-render 渲染出了至少一个公式（阅读器据此决定要不要注入 katex.min.css） */
  katex: boolean
}

export interface CaptureInput {
  html: string
  finalUrl: string
  /** 是否尝试 KaTeX auto-render（可选步骤，默认关：katex 是重依赖，且多数页面没有公式） */
  katex?: boolean
}

export interface MathDelimiters {
  inline: [string, string][]
  display: [string, string][]
}

/** MathJax 的默认分隔符（v2/v3 同）：页面装了 MathJax 却没写 inlineMath/displayMath 时按这套 */
const MATHJAX_DEFAULT_INLINE: [string, string][] = [['\\(', '\\)']]
const MATHJAX_DEFAULT_DISPLAY: [string, string][] = [['$$', '$$'], ['\\[', '\\]']]

/** 占位元素：阅读器 CSS 里有 `.pc-placeholder` 样式（snapshotDom.ts） */
const PLACEHOLDER_CLASS = 'pc-placeholder'
const PLACEHOLDER_ATTR = 'data-pc-placeholder'

/** 捕获代理与本模块共用的样式表标记：`link[data-pc-sheet]` = 待 buildSnapshot 抓取并内联的外部样式表 */
export const SHEET_ATTR = 'data-pc-sheet'

const LAZY_SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src']
const LAZY_SRCSET_ATTRS = ['data-srcset', 'srcset']

const collapseWs = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------------------
// URL 帮手
// ---------------------------------------------------------------------------

/**
 * 解析基准：文档内 `<base href>`（相对 finalUrl 解析）→ 否则 finalUrl。
 * 与 extractArticle.ts:83-94 同一口径：arxiv HTML 的图是相对路径（x1.png），必须尊重 `<base>`；
 * DOMParser 产出的 doc.baseURI 不反映它，须手动查。
 */
export function resolveDocumentBase(doc: Document, finalUrl: string): string {
  const baseHref = doc.querySelector('base[href]')?.getAttribute('href')
  if (baseHref) {
    try {
      return new URL(baseHref, finalUrl).toString()
    } catch {
      /* 非法 <base href>：忽略，退回 finalUrl */
    }
  }
  return finalUrl
}

/** 任意协议的绝对化（a[href] 用：mailto:/tel: 也要保留）；解析失败返回 null */
function toAbsolute(value: string, base: string): string | null {
  try {
    return new URL(value.trim(), base).href
  } catch {
    return null
  }
}


/** 自包含或不可绝对化的取值：data:/blob:/about: 原样保留 */
const isSelfContained = (value: string): boolean => /^\s*(?:data:|blob:|about:)/i.test(value)

/** `srcset="a.png 400w, b.png 800w"` → `a.png`（首个候选，不看描述符） */
function firstSrcsetCandidate(srcset: string | null): string | null {
  if (!srcset) return null
  const m = /^\s*([^\s,]+)/.exec(srcset)
  return m ? m[1] : null
}

function hostnameAndPath(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname !== '/' ? `${u.hostname}${u.pathname}` : u.hostname
  } catch {
    return url
  }
}

function basenameOf(url: string, base: string): string {
  try {
    const path = new URL(url, base).pathname
    const last = path.split('/').filter(Boolean).pop() ?? ''
    return decodeURIComponent(last)
  } catch {
    return url.split('/').filter(Boolean).pop() ?? url
  }
}

// ---------------------------------------------------------------------------
// 预处理各步骤
// ---------------------------------------------------------------------------

/** `<picture>` 只留 `<img>`：`<source>` 的 srcset/type 协商在离线快照里没有意义，固化 img 实际显示的那张 */
function unwrapPictures(doc: Document): void {
  for (const picture of Array.from(doc.querySelectorAll('picture'))) {
    const img = picture.querySelector('img')
    if (!img) {
      picture.remove()
      continue
    }
    // img 自身没有可用 src 时，退而取首个 <source> 的首个候选（否则 picture 一拆图就没了）
    const src = img.getAttribute('src')
    if (!src || isSelfContained(src)) {
      for (const source of Array.from(picture.querySelectorAll('source'))) {
        const cand = firstSrcsetCandidate(source.getAttribute('srcset')) ?? firstSrcsetCandidate(source.getAttribute('data-srcset'))
        if (cand) {
          img.setAttribute('src', cand)
          break
        }
      }
    }
    picture.replaceWith(img)
  }
}

/**
 * 懒加载提升：`src` 为空 / 占位 data: 图时，用 `data-src` / `data-original` / `data-lazy-src`，
 * 再退到 `data-srcset` / `srcset` 的首个候选。随后一律删 `srcset/sizes`：src 是唯一事实。
 */
function promoteLazyImages(doc: Document): void {
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src')
    if (!src || isSelfContained(src)) {
      let promoted: string | null = null
      for (const attr of LAZY_SRC_ATTRS) {
        const v = img.getAttribute(attr)?.trim()
        if (v) {
          promoted = v
          break
        }
      }
      if (!promoted) {
        for (const attr of LAZY_SRCSET_ATTRS) {
          promoted = firstSrcsetCandidate(img.getAttribute(attr))
          if (promoted) break
        }
      }
      if (promoted) img.setAttribute('src', promoted)
    }
    img.removeAttribute('srcset')
    img.removeAttribute('sizes')
  }
}

/** 一个 URL 属性绝对化；不可解析的属性直接删（留着相对路径在阅读器 srcdoc 里只会 404） */
function absolutizeAttr(el: Element, name: string, base: string, opts: { keepFragment?: boolean } = {}): void {
  const value = el.getAttribute(name)
  if (value === null) return
  const trimmed = value.trim()
  if (!trimmed) return
  // 页内锚点原样保留：绝对化成 https://site/page#x 会丢掉「页内跳转」语义（阅读器按 #frag 就地滚动）
  if (trimmed.startsWith('#') && opts.keepFragment !== false) return
  if (isSelfContained(trimmed)) return
  const abs = toAbsolute(trimmed, base)
  if (abs === null) el.removeAttribute(name)
  else if (abs !== value) el.setAttribute(name, abs)
}

function absolutizeUrls(doc: Document, base: string): void {
  for (const a of Array.from(doc.querySelectorAll('a[href], area[href]'))) absolutizeAttr(a, 'href', base)
  for (const el of Array.from(doc.querySelectorAll('img[src], source[src]'))) absolutizeAttr(el, 'src', base)
  for (const el of Array.from(doc.querySelectorAll('[poster]'))) absolutizeAttr(el, 'poster', base)
  for (const el of Array.from(doc.querySelectorAll('image, use'))) {
    absolutizeAttr(el, 'href', base)
    absolutizeAttr(el, 'xlink:href', base)
  }
}

function placeholder(doc: Document, kind: string, label: string): HTMLElement {
  const div = doc.createElement('div')
  div.className = PLACEHOLDER_CLASS
  div.setAttribute(PLACEHOLDER_ATTR, kind)
  div.textContent = label
  return div
}

/** 属性里的尺寸 ≤1（追踪像素 / 隐形 iframe）：直接删，不出占位噪声 */
function isTracker(el: Element): boolean {
  const w = parseFloat(el.getAttribute('width') ?? '')
  const h = parseFloat(el.getAttribute('height') ?? '')
  return (Number.isFinite(w) && w <= 1) || (Number.isFinite(h) && h <= 1) || el.hasAttribute('hidden')
}

/**
 * 不能固化的媒体：video → poster 图（有 poster）或「[视频：文件名]」占位；
 * audio → 「[音频]」；iframe/object/embed → 「[嵌入内容]」；canvas（静态路径拿不到像素）→ 「[嵌入内容]」。
 * 占位是 `div.pc-placeholder[data-pc-placeholder=<kind>]`，阅读器有对应样式。
 */
function replaceMedia(doc: Document, base: string): void {
  for (const video of Array.from(doc.querySelectorAll('video'))) {
    const poster = video.getAttribute('poster')
    if (poster && /^https?:/i.test(poster)) {
      const img = doc.createElement('img')
      img.setAttribute('src', poster)
      img.setAttribute('alt', '视频封面')
      for (const attr of ['width', 'height', 'class', 'style']) {
        const v = video.getAttribute(attr)
        if (v) img.setAttribute(attr, v)
      }
      video.replaceWith(img)
      continue
    }
    const src = video.getAttribute('src') || video.querySelector('source[src]')?.getAttribute('src') || ''
    video.replaceWith(placeholder(doc, 'video', src ? `[视频：${basenameOf(src, base)}]` : '[视频]'))
  }
  for (const audio of Array.from(doc.querySelectorAll('audio'))) audio.replaceWith(placeholder(doc, 'audio', '[音频]'))
  for (const el of Array.from(doc.querySelectorAll('iframe, object, embed'))) {
    if (isTracker(el)) el.remove()
    else el.replaceWith(placeholder(doc, 'embed', '[嵌入内容]'))
  }
  for (const canvas of Array.from(doc.querySelectorAll('canvas'))) {
    if (isTracker(canvas)) canvas.remove()
    else canvas.replaceWith(placeholder(doc, 'canvas', '[嵌入内容]'))
  }
}

/**
 * MathML 的 `annotation` / `annotation-xml` 连元素带内容一起删：DOMPurify 默认禁这两个标签，
 * 但 KEEP_CONTENT 会把 `annotation` 里的 TeX 源码提升成可见文本（fidelitySanitize.ts 头注）。
 * KaTeX auto-render 之后还要再跑一次（它的输出里也带 annotation）。
 */
function removeAnnotations(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll('annotation, annotation-xml'))) el.remove()
}

/** 脚本执行面 + 外链装载面 + 对快照无意义的头部元素 */
function removeNoise(doc: Document): void {
  removeAnnotations(doc)
  for (const el of Array.from(doc.querySelectorAll('script, noscript, template, meta, base'))) el.remove()
}

/**
 * 外部样式表：`link[rel~=stylesheet][href]`（或捕获代理已标记的 `link[data-pc-sheet]`）→ href 绝对化 +
 * `data-pc-sheet="1"`，其余 `<link>`（icon/preload/canonical/alternate stylesheet/disabled）一律删。
 * 之后由 buildSnapshot 抓取并换成 `<style data-pc-sheet="<href>">`。
 */
function markStylesheets(doc: Document, base: string): void {
  for (const link of Array.from(doc.querySelectorAll('link'))) {
    const tokens = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const isSheet = tokens.includes('stylesheet') || link.hasAttribute(SHEET_ATTR)
    if (!isSheet || tokens.includes('alternate') || link.hasAttribute('disabled')) {
      link.remove()
      continue
    }
    const abs = toHttpUrl(link.getAttribute('href'), base)
    if (!abs) {
      link.remove()
      continue
    }
    link.setAttribute('href', abs)
    link.setAttribute(SHEET_ATTR, '1')
  }
}

/**
 * Tier 1 与 Tier 2 共用的原貌预处理（就地修改）。
 * @param finalUrl 抓取落地 URL；文档内 `<base href>` 相对它解析出真正的基准
 */
export function preprocessFidelity(doc: Document, finalUrl: string): void {
  const base = resolveDocumentBase(doc, finalUrl)
  unwrapPictures(doc)
  promoteLazyImages(doc)
  absolutizeUrls(doc, base)
  replaceMedia(doc, base)
  removeNoise(doc)
  markStylesheets(doc, base)
}

// ---------------------------------------------------------------------------
// 数学分隔符探测 + KaTeX auto-render
// ---------------------------------------------------------------------------

/** JS 字符串字面量的反转义：源码里的 `'\\('` 是 `\(`，`'\\\\'` 是 `\` */
const unescapeJs = (s: string): string =>
  s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))

/** 从 `[` 起匹配到对应的 `]`（跳过字符串字面量），返回闭括号下标；不闭合返回 -1 */
function matchBracket(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1
      i = j
      continue
    }
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

const STRING_LITERAL_RE = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g

/** 抠出 `key: [['a','b'],['c','d']]` 形态的分隔符对；key 缺失或不是数组字面量返回 null */
function extractPairs(text: string, key: string): [string, string][] | null {
  const re = new RegExp(`\\b${key}\\s*:\\s*`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length
    if (text[start] !== '[') continue
    const end = matchBracket(text, start)
    if (end < 0) continue
    const literals: string[] = []
    const inner = text.slice(start + 1, end)
    STRING_LITERAL_RE.lastIndex = 0
    let s: RegExpExecArray | null
    while ((s = STRING_LITERAL_RE.exec(inner))) literals.push(unescapeJs(s[1] ?? s[2] ?? ''))
    if (literals.length < 2) return []
    const pairs: [string, string][] = []
    for (let i = 0; i + 1 < literals.length; i += 2) pairs.push([literals[i], literals[i + 1]])
    return pairs
  }
  return null
}

/** MathJax v2（tex2jax）/ v3（tex）配置：`inlineMath` / `displayMath` 二选一出现即视为有配置 */
function parseMathJaxConfig(text: string): MathDelimiters | null {
  if (!/MathJax/.test(text)) return null
  const inline = extractPairs(text, 'inlineMath')
  const display = extractPairs(text, 'displayMath')
  if (inline === null && display === null) return null
  return {
    inline: inline && inline.length ? inline : MATHJAX_DEFAULT_INLINE,
    display: display && display.length ? display : MATHJAX_DEFAULT_DISPLAY,
  }
}

/** KaTeX auto-render 配置：`{left: "$$", right: "$$", display: true}` 对象序列 */
const KATEX_DELIM_RE =
  /left\s*:\s*(['"])((?:\\.|(?!\1).)*?)\1\s*,\s*right\s*:\s*(['"])((?:\\.|(?!\3).)*?)\3(?:\s*,\s*display\s*:\s*(true|false))?/g

function parseKatexConfig(text: string): MathDelimiters | null {
  const inline: [string, string][] = []
  const display: [string, string][] = []
  KATEX_DELIM_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = KATEX_DELIM_RE.exec(text))) {
    const pair: [string, string] = [unescapeJs(m[2]), unescapeJs(m[4])]
    if (m[5] === 'true') display.push(pair)
    else inline.push(pair)
  }
  if (!inline.length && !display.length) return null
  return { inline, display }
}

/**
 * 页面用了哪套数学分隔符：
 *   内联 MathJax 配置（v2 tex2jax / v3 tex 的 inlineMath/displayMath）→ 按配置；
 *   KaTeX auto-render 的 delimiters 配置 → 按配置；
 *   否则正文里出现 `\(` / `\[` / `$$` → MathJax 默认分隔符；
 *   都没有 → null（无公式，跳过 KaTeX）。
 * 必须在 preprocess **之前**调用：预处理会删掉 `<script>`。
 */
export function detectMathDelimiters(doc: Document): MathDelimiters | null {
  for (const script of Array.from(doc.querySelectorAll('script'))) {
    const text = script.textContent ?? ''
    if (!text) continue
    const found = parseMathJaxConfig(text) ?? parseKatexConfig(text)
    if (found) return found
  }
  const body = doc.body?.textContent ?? ''
  if (body.includes('\\(') || body.includes('\\[') || body.includes('$$')) {
    return { inline: MATHJAX_DEFAULT_INLINE, display: MATHJAX_DEFAULT_DISPLAY }
  }
  return null
}

/** auto-render 不下探的标签：默认集 + 数学原子（MathJax/KaTeX 已渲染的、原生 MathML、SVG） */
const KATEX_IGNORED_TAGS = ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option', 'mjx-container', 'math', 'svg', 'annotation']

/** 页面已有渲染好的公式（MathJax CHTML / KaTeX 输出）：Tier 2 里 MathJax 跑过了，不再叠一层 KaTeX */
export const hasRenderedMath = (doc: Document): boolean => doc.querySelector('mjx-container, .katex') !== null

/**
 * KaTeX auto-render（动态 import，不进主 chunk；`throwOnError:false` 解析失败原样保留文本）。
 * 返回是否至少渲染出一个 `.katex`。渲染后：删 `annotation`（TeX 源码，见 removeAnnotations）与
 * `.katex-mathml`（无障碍用的 MathML 副本，视觉隐藏；留着会让块文本把每个公式重复计一遍）。
 */
export async function autoRenderKatex(doc: Document, delimiters: MathDelimiters): Promise<boolean> {
  const body = doc.body
  if (!body) return false
  const { default: renderMathInElement } = await import('katex/contrib/auto-render')
  const before = doc.querySelectorAll('.katex').length
  try {
    renderMathInElement(body as HTMLElement, {
      delimiters: [
        ...delimiters.display.map(([left, right]) => ({ left, right, display: true })),
        ...delimiters.inline.map(([left, right]) => ({ left, right, display: false })),
      ],
      throwOnError: false,
      ignoredTags: KATEX_IGNORED_TAGS as unknown as ReadonlyArray<keyof HTMLElementTagNameMap>,
      ignoredClasses: ['katex'],
      errorCallback: () => {},
    })
  } catch {
    /* 非解析错误（极少见）：保留已渲染的部分，其余原样 */
  }
  removeAnnotations(doc)
  for (const el of Array.from(doc.querySelectorAll('.katex-mathml'))) el.remove()
  return doc.querySelectorAll('.katex').length > before
}

// ---------------------------------------------------------------------------
// 捕获入口
// ---------------------------------------------------------------------------

function deriveTitle(doc: Document, finalUrl: string): string {
  const headTitle = collapseWs(doc.querySelector('head > title')?.textContent ?? doc.title)
  if (headTitle) return headTitle
  const h1 = collapseWs(doc.querySelector('h1')?.textContent)
  return h1 || hostnameAndPath(finalUrl)
}

export interface CaptureDocumentInput extends CaptureInput {
  mode: 'static' | 'rendered'
  /** Tier 2 由捕获代理带回的 document.title，优先于从 DOM 推导 */
  title?: string
}

/**
 * HTML 串 → 预处理后的文档（两条 tier 共用）：DOMParser → 探测分隔符（要趁 `<script>` 还在）→
 * preprocessFidelity → 标题 → 可选 KaTeX。rendered 模式下页面已有渲染好的公式时跳过 KaTeX。
 */
export async function captureDocument(input: CaptureDocumentInput): Promise<CapturedDocument> {
  const doc = new DOMParser().parseFromString(input.html, 'text/html')
  const delimiters = input.katex ? detectMathDelimiters(doc) : null
  const baseUrl = resolveDocumentBase(doc, input.finalUrl)
  preprocessFidelity(doc, input.finalUrl)
  const title = collapseWs(input.title) || deriveTitle(doc, input.finalUrl)
  let katex = false
  if (delimiters && !(input.mode === 'rendered' && hasRenderedMath(doc))) {
    katex = await autoRenderKatex(doc, delimiters)
  }
  return { doc, finalUrl: input.finalUrl, baseUrl, title, mode: input.mode, katex }
}

/** Tier 1：不跑站点脚本的静态捕获（Tier 2 失败或未启用时的回退） */
export function captureStatic(input: CaptureInput): Promise<CapturedDocument> {
  return captureDocument({ ...input, mode: 'static' })
}
