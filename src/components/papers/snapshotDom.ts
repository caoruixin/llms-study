import type { LlmAuthCode } from '../../lib/llmClient'
import { READER_ALIGN_MARGIN } from '../../lib/paper/anchors'
import { validRanges } from '../../lib/paper/highlight/highlightModel'
import { isTranslatableBlock } from '../../lib/paper/translate/translateBatch'
import type { LangMode, NormalizedBlock, PaperHighlight } from '../../lib/paper/types'
import { hydrateCssTokens, rewriteDeclarationValues } from '../../lib/paper/url/cssRewrite'
import { HIDDEN_ATTR, STAMP_ATTR, hostText, isElement, isNestedHost, isText } from '../../lib/paper/url/stampBlocks'
import type { WebSnapshotHeader } from '../../lib/paper/url/webSnapshot'
import { FLASH_MS } from './ReaderContext'

/**
 * 「网页原貌」阅读器的纯 DOM 帮手（PLAN-web-snapshot-sync.md §2.3）。
 *
 * 全部函数只碰传入的 Document / Element，不引用 window、不持有 React 状态——
 * happy-dom 下可逐个单测（snapshotDom.test.ts）。WebSnapshotView 负责 iframe 生命周期、
 * 观察器与事件，把这里的函数按顺序套上去。
 *
 * 契约（与 stampBlocks / selectionOffsets 共用）：
 * - 打标元素 `[data-pc-block="N"]` 是块 N 的宿主；水合时镜像 `data-block-index="N"`（BlockReader
 *   同名属性，观察器/锚点/选区解析三处共用一套选择器），文本块再补 `data-hl-host="orig"`；
 * - 译文节点 `.pc-zh[data-hl-host="zh"]` 嵌在宿主**内部**（both/zh 模式），`hostText()` 排除它，
 *   所以宿主原文在三态下恒等于 block.text；
 * - orig/both 模式下原始子节点零改动；zh 模式把原始子节点包进 `.pc-orig[hidden]`，可逆。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 阅读 iframe 的 CSP（meta，`<head>` 最前）。沙箱已无脚本（`sandbox="allow-same-origin"` 不含
 * allow-scripts），这里是纵深防御：`script-src` 回落 `default-src 'none'`；资源只准 blob:/data:/https:
 * 与 `'self'`（KaTeX 样式与字体来自本站 assets——dev 是 http://localhost，没有 'self' 会被 https: 挡掉）；
 * 表单/子框架/媒体一律禁止。
 */
export const READER_CSP =
  "default-src 'none'; img-src 'self' blob: data: https:; style-src 'self' 'unsafe-inline' blob: https:; " +
  "font-src 'self' blob: data: https:; media-src 'none'; frame-src 'none'; form-action 'none'"

export const READER_STYLE_ID = 'pc-reader'

/**
 * 站点自带的内部纵向滚动容器（渲染期由 `stampScrollers()` 统一打标）。
 *
 * 快照是一份**整篇平铺**的静态文档，内部本就不该有滚动口：留着它们只会把滚轮吃掉——指针停在
 * 站点侧栏上滚不动正文，滚到底还会被站点的 `overscroll-behavior` 掐断链式传递。
 *
 * 两轴一起解除，而不是只解纵向：CSS overflow 规范规定 `overflow-x` 非 visible 时，`overflow-y`
 * 的 visible 会被**计算成 auto**——站点的 Radix ScrollArea 带内联 `overflow:scroll`，只写
 * `overflow-y:visible` 会被这条规则原样打回去（llm-pro.cn 上实测如此）。打标只认**真有纵向溢出**的
 * 元素，横向单轴滚动的长代码块压根不会被标上，所以两轴一起解不会伤到它们。
 */
export const SCROLLER_ATTR = 'data-pc-scroller'

/** 常见 cookie / consent 横幅：固化时它们往往还在 DOM 里，阅读时只会盖住正文 */
const CONSENT_SELECTORS = [
  '#onetrust-consent-sdk',
  '#CybotCookiebotDialog',
  '.cc-window',
  '[id*="cookie-banner" i]',
  '[class*="cookie-banner" i]',
  '[id*="cookieconsent" i]',
  '[class*="cookieconsent" i]',
].join(', ')

/**
 * 注入 iframe 文档的阅读器样式（`<style id="pc-reader">`，放在 `<head>` **末尾**：同优先级时后者胜，
 * 站点自己的 `html{overflow-y:scroll}`、`span{display:inline-block}` 之类才盖不过来）。
 * 颜色全部写字面量：站点文档里没有本站的 CSS 变量。
 */
export const READER_CSS = `
html { overflow: hidden !important; height: auto !important; min-height: 0 !important; }
body { height: auto !important; min-height: 0 !important; }
html, body { overscroll-behavior: auto !important; touch-action: auto !important; }
[data-pc-fixed] { position: static !important; }
[${SCROLLER_ATTR}] { overflow: visible !important; max-height: none !important; height: auto !important; }
[${HIDDEN_ATTR}] { display: none !important; }
${CONSENT_SELECTORS} { display: none !important; }
.pc-placeholder { display: inline-block; padding: .5em .8em; border: 1px dashed #9a9a9a; border-radius: 6px; color: #666; font-size: .85em; }
.pc-zh { display: block; flex: 0 0 100%; grid-column: 1 / -1; margin-top: .35em; padding-left: .6em; border-left: 2px solid rgba(158, 43, 58, .4); background: rgba(158, 43, 58, .05); font: inherit; color: inherit; direction: ltr; text-align: start; white-space: normal; }
.pc-orig[hidden] { display: none !important; }
.pc-skel { display: block; margin-top: .4em; }
.pc-skel::before, .pc-skel::after { content: ""; display: block; height: .6em; border-radius: 3px; background: rgba(127, 127, 127, .18); animation: pc-pulse 1.4s ease-in-out infinite; }
.pc-skel::before { width: 90%; }
.pc-skel::after { width: 66%; margin-top: .45em; }
@keyframes pc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
.pc-fail { display: flex; flex-wrap: wrap; align-items: center; gap: .5em; margin-top: .3em; font-size: .75em; line-height: 1.5; color: #d92d20; }
.pc-fail a[data-pc-nav] { color: #9e2b3a; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.pc-fail button[data-pc-retry] { font: inherit; color: #9e2b3a; background: transparent; border: 1px solid #e3ded1; border-radius: 4px; padding: .1em .5em; cursor: pointer; }
mark[data-highlight-id] { background: rgba(217, 119, 6, .3); color: inherit; border-radius: 3px; cursor: pointer; }
mark[data-highlight-id]:hover { background: rgba(217, 119, 6, .45); }
@keyframes paper-flash-kf { 0% { background-color: rgba(158, 43, 58, .26); } 100% { background-color: transparent; } }
.paper-flash { animation: paper-flash-kf ${FLASH_MS}ms ease-out; border-radius: 6px; }
@media (prefers-reduced-motion: reduce) { .paper-flash { animation-duration: 1ms; } .pc-skel::before, .pc-skel::after { animation: none; } }
`

/** 拿得到宿主的块：table（富结构 HTML）与 image（占位文本）不参与划词高亮，与 BlockReader 同一口径 */
const hasHost = (kind: NormalizedBlock['kind']): boolean => kind !== 'table' && kind !== 'image'

const SHOW_ELEMENT = 1
const SHOW_TEXT = 4
const FILTER_ACCEPT = 1
const FILTER_REJECT = 2
const FILTER_SKIP = 3


// ---------------------------------------------------------------------------
// 滚动：内部滚动容器与滚轮归属
// ---------------------------------------------------------------------------

/** 会响应滚轮的 overflow 取值（`hidden` 不响应用户滚动，不算陷阱） */
const SCROLLABLE_OVERFLOW = /^(auto|scroll|overlay)$/

/** 元素当前的纵向 overflow；跨 realm 取样式要用它自己那个 window */
const overflowYOf = (el: Element): string => {
  const view = el.ownerDocument?.defaultView
  if (!view) return ''
  try {
    return String(view.getComputedStyle(el).overflowY || '')
  } catch {
    return ''
  }
}

/** 元素在 `dy` 方向上还能不能滚：得是真滚动容器、有溢出、且没到那一端 */
const canScrollBy = (el: Element, dy: number): boolean => {
  if (!SCROLLABLE_OVERFLOW.test(overflowYOf(el))) return false
  const max = el.scrollHeight - el.clientHeight
  if (max <= 1) return false
  return dy > 0 ? el.scrollTop < max - 1 : el.scrollTop > 1
}

/**
 * 这一下滚轮该由 iframe 内部谁吃：从 `target` 往上找**当前方向上还能滚**的祖先（找到 `root` 为止，不含 root）。
 *
 * 返回元素 → 让浏览器自己滚它，转发桥不插手；返回 `null` → iframe 内没人能消费，
 * 该由 WebSnapshotView 把这一下转发给外层滚动容器。
 */
export const wheelScrollTarget = (target: Node | null, deltaY: number, root: Element | null): Element | null => {
  let node: Node | null = target
  while (node && node !== root) {
    if (isElement(node) && canScrollBy(node, deltaY)) return node
    node = node.parentNode
  }
  return null
}

/**
 * 给站点自带的纵向滚动容器补打 `data-pc-scroller`，返回打标个数。
 *
 * 只在渲染期做，不在抓取期做：捕获 iframe 的时间预算很紧（硬超时内还要做整篇序列化），
 * 而这里不限时；顺带也让存量快照不必重新导入就能修好。只认**真的有纵向溢出**的元素：
 * `overflow-x:auto` 的长代码块其 `overflow-y` 计算值也会变成 `auto`（CSS overflow 规范），
 * 但它纵向没有溢出，不该被当成滚动容器。
 */
export const stampScrollers = (doc: Document): number => {
  let n = 0
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (el === doc.documentElement || el === doc.body) continue
    if (el.hasAttribute(SCROLLER_ATTR)) continue
    if (!SCROLLABLE_OVERFLOW.test(overflowYOf(el))) continue
    if (el.scrollHeight - el.clientHeight <= 1) continue
    el.setAttribute(SCROLLER_ATTR, '1')
    n++
  }
  return n
}


// ---------------------------------------------------------------------------
// 水合：快照头 → srcdoc
// ---------------------------------------------------------------------------

export interface ReaderSrcdocOptions {
  /** KaTeX 样式表的绝对 URL；只在 `header.capture.katex` 为真时注入 */
  katexCssHref?: string
  /** 参考视口高度（px）：站点 CSS 里的 vh 系单位改写成这个高度的百分比（见 neutralizeViewportUnits） */
  viewportHeightPx?: number
}

const VH_UNIT_RE = /(\d*\.?\d+)(vh|dvh|svh|lvh|vmin|vmax)\b/g
const HAS_VH_RE = /\d(?:vh|dvh|svh|lvh|vmin|vmax)\b/

/**
 * 把 CSS 文本里的视口高度单位钉死成参考高度的百分比（`100vh` → `720px`；`vmin/vmax` → `min()/max()` 混 vw）。
 *
 * 为什么必须做：阅读 iframe 是**自适应高度**的（没有内滚），iframe 高度 = 文档高度；而 `vh` 又按
 * iframe 高度算——`min-height:100vh` 的首屏区块会随每次撑高再长高，ResizeObserver 回环永不收敛。
 * 钉成参考值（阅读列高度）后 vh 不再依赖 iframe，回环从根上消失；站点在「一屏」内的布局也接近抓取时。
 * 只改**声明值**（`rewriteDeclarationValues`）：选择器（Tailwind 的 `.min-h-\[100dvh\]`）、字符串、
 * url() 里的 base64 载荷都不能碰——改了选择器规则就失配，改了载荷图片/字体就坏。单位按小写认
 * （CSS 单位大小写不敏感，但实际样式表里全小写；不加 i 标志免得误伤别的词法形态）。
 */
export function neutralizeViewportUnits(css: string, viewportHeightPx: number): string {
  if (!HAS_VH_RE.test(css)) return css
  const px = (n: number): string => `${Math.round((n * viewportHeightPx) / 100 * 100) / 100}px`
  return rewriteDeclarationValues(css, (value) =>
    value.replace(VH_UNIT_RE, (_m, num: string, unit: string) => {
      const n = Number(num)
      if (unit === 'vmin') return `min(${num}vw, ${px(n)})`
      if (unit === 'vmax') return `max(${num}vw, ${px(n)})`
      return px(n)
    }),
  )
}

/**
 * 快照 html → 可直接赋给 `iframe.srcdoc` 的完整文档：
 * 1. `<!DOCTYPE html>`（快照里存的是 documentElement.outerHTML，无 doctype）；
 * 2. 每个 `<style>`（及含占位的 style 属性）里的 `url("pc-asset:<id>")` → blob:（无资源时**原样保留**）；
 * 3. `img[data-pc-asset]` / svg `image[data-pc-asset]` 的 src/href → blob:（无 blob 时保留原 https 兜底）；
 * 4. `<head>` 最前插 CSP meta，末尾插 `<style id="pc-reader">`，KaTeX 样式（可选）夹在中间；
 * 5. `[data-pc-block]` 镜像 `data-block-index`，文本块补 `data-hl-host="orig"`（id 不动）。
 */
export function buildReaderSrcdoc(
  header: WebSnapshotHeader,
  urlFor: (id: string) => string | null,
  opts: ReaderSrcdocOptions = {},
): string {
  const doc = new DOMParser().parseFromString(header.html, 'text/html')
  const vh = opts.viewportHeightPx
  const rewrite = (css: string): string => {
    let out = css.includes('pc-asset:') ? hydrateCssTokens(css, urlFor) : css
    if (vh !== undefined && vh > 0) out = neutralizeViewportUnits(out, vh)
    return out
  }

  for (const style of Array.from(doc.querySelectorAll('style'))) {
    const css = style.textContent ?? ''
    const next = rewrite(css)
    if (next !== css) style.textContent = next
  }
  for (const el of Array.from(doc.querySelectorAll('[style]'))) {
    const css = el.getAttribute('style') ?? ''
    const next = rewrite(css)
    if (next !== css) el.setAttribute('style', next)
  }
  for (const el of Array.from(doc.querySelectorAll('[data-pc-asset]'))) {
    const id = el.getAttribute('data-pc-asset')
    const url = id ? urlFor(id) : null
    if (!url) continue
    const tag = el.localName.toLowerCase()
    if (tag === 'img') el.setAttribute('src', url)
    else if (tag === 'image') el.setAttribute('href', url)
  }

  const kindOf = new Map<number, NormalizedBlock['kind']>()
  for (const b of header.blocks) kindOf.set(b.index, b.kind)
  for (const el of Array.from(doc.querySelectorAll(`[${STAMP_ATTR}]`))) {
    const raw = el.getAttribute(STAMP_ATTR) ?? ''
    const index = Number(raw)
    if (!Number.isInteger(index) || index < 0) continue
    el.setAttribute('data-block-index', raw)
    const kind = kindOf.get(index)
    if (kind !== undefined && hasHost(kind)) el.setAttribute('data-hl-host', 'orig')
  }

  const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement('head'), doc.documentElement.firstChild)
  const csp = doc.createElement('meta')
  csp.setAttribute('http-equiv', 'Content-Security-Policy')
  csp.setAttribute('content', READER_CSP)
  head.insertBefore(csp, head.firstChild)

  if (header.capture.katex && opts.katexCssHref) {
    const link = doc.createElement('link')
    link.setAttribute('rel', 'stylesheet')
    link.setAttribute('href', opts.katexCssHref)
    head.appendChild(link)
  }
  const style = doc.createElement('style')
  style.id = READER_STYLE_ID
  style.textContent = READER_CSS
  head.appendChild(style)

  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`
}

/** 块序号 → 宿主元素（稀疏数组：缺失/畸形的序号留空） */
export function blockElements(doc: Document): (Element | undefined)[] {
  const out: (Element | undefined)[] = []
  for (const el of Array.from(doc.querySelectorAll(`[${STAMP_ATTR}]`))) {
    const index = Number(el.getAttribute(STAMP_ATTR))
    if (Number.isInteger(index) && index >= 0) out[index] = el
  }
  return out
}

// ---------------------------------------------------------------------------
// 语言三态：译文就地挂载
// ---------------------------------------------------------------------------

export interface LangState {
  langMode: LangMode
  translations?: ReadonlyMap<number, string> | undefined
  failed?: ReadonlySet<number> | undefined
  authIssue?: LlmAuthCode | null | undefined
}

/** 宿主 → zh 模式下包住原始子节点的 `.pc-orig[hidden]`（只解包自己建的） */
const wrapperOf = new WeakMap<Element, HTMLElement>()
/** 宿主 → 译文节点及其内容键（同键不重建，已挂上去的 mark 得以保留） */
const zhOf = new WeakMap<Element, { el: HTMLElement; key: string }>()

const AUTH_MESSAGE: Record<LlmAuthCode, string> = {
  unauthenticated: '登录已过期，请重新登录后重试翻译',
  'no-user-key': '该账号尚未配置 DeepSeek Key，无法翻译',
  forbidden: '该账号尚未配置 DeepSeek Key，无法翻译',
}

/** 失败 chip：文案 / 设置页引导 / 重试 与 BlockReader.TranslationError 同一语义 */
function buildFailChip(doc: Document, blockIndex: number, authIssue: LlmAuthCode | null | undefined): HTMLElement {
  const chip = doc.createElement('span')
  chip.className = 'pc-fail'
  const msg = doc.createElement('span')
  msg.textContent = authIssue ? AUTH_MESSAGE[authIssue] : '这一段翻译失败'
  chip.appendChild(msg)
  if (authIssue && authIssue !== 'unauthenticated') {
    const nav = doc.createElement('a')
    nav.setAttribute('data-pc-nav', '/settings')
    nav.setAttribute('href', '#/settings')
    nav.textContent = '去设置页配置'
    chip.appendChild(nav)
  }
  const retry = doc.createElement('button')
  retry.setAttribute('type', 'button')
  retry.setAttribute('data-pc-retry', String(blockIndex))
  retry.textContent = '重试'
  chip.appendChild(retry)
  return chip
}

type ZhContent = { key: string; fill: (el: HTMLElement) => void; isText: boolean }

function zhContent(doc: Document, blockIndex: number, zh: string | undefined, failed: boolean, authIssue: LlmAuthCode | null | undefined): ZhContent {
  if (zh !== undefined) return { key: `text:${zh}`, isText: true, fill: (el) => (el.textContent = zh) }
  if (failed) {
    return {
      key: `fail:${authIssue ?? ''}`,
      isText: false,
      fill: (el) => el.appendChild(buildFailChip(doc, blockIndex, authIssue)),
    }
  }
  return {
    key: 'skel',
    isText: false,
    fill: (el) => {
      const skel = doc.createElement('span')
      skel.className = 'pc-skel'
      skel.setAttribute('aria-hidden', 'true')
      el.appendChild(skel)
    },
  }
}

/** 确保宿主内有一个 `.pc-zh` 且内容与当前状态一致；只有译文态才带 hl-host / translated 标记（chip 文本不该被划成 zh 高亮） */
function ensureZh(host: Element, content: ZhContent): void {
  const doc = host.ownerDocument
  const existing = zhOf.get(host)
  if (existing && existing.key === content.key && existing.el.parentNode === host) return
  let el = existing?.el
  if (!el || el.parentNode !== host) {
    el = doc.createElement('span')
    el.className = 'pc-zh'
    el.setAttribute('lang', 'zh-CN')
    host.appendChild(el)
  }
  el.replaceChildren()
  if (content.isText) {
    el.setAttribute('data-hl-host', 'zh')
    el.setAttribute('data-translated', 'zh')
  } else {
    el.removeAttribute('data-hl-host')
    el.removeAttribute('data-translated')
  }
  content.fill(el)
  zhOf.set(host, { el, key: content.key })
}

function removeZh(host: Element): void {
  const existing = zhOf.get(host)
  if (existing) {
    if (existing.el.parentNode === host) host.removeChild(existing.el)
    zhOf.delete(host)
  }
  // 防御：不是我们建的 .pc-zh（不该存在）也一并清掉，保证 orig 模式下宿主里没有译文节点
  for (const child of Array.from(host.children)) {
    if (child.classList.contains('pc-zh')) host.removeChild(child)
  }
}

/** zh 模式：原始子节点（除 .pc-zh）包进 `.pc-orig[hidden]`；已包过则只补漏（新出现的节点） */
function wrapOriginals(host: Element): void {
  const doc = host.ownerDocument
  let wrapper = wrapperOf.get(host)
  if (!wrapper || wrapper.parentNode !== host) {
    wrapper = doc.createElement('span')
    wrapper.className = 'pc-orig'
    wrapper.setAttribute('hidden', '')
    host.insertBefore(wrapper, host.firstChild)
    wrapperOf.set(host, wrapper)
  }
  const zh = zhOf.get(host)?.el
  for (const child of Array.from(host.childNodes)) {
    if (child === wrapper || child === zh) continue
    if (isElement(child) && child.classList.contains('pc-zh')) continue
    wrapper.appendChild(child)
  }
}

/** 解包 `.pc-orig`：子节点按原顺序放回原位 */
function unwrapOriginals(host: Element): void {
  const wrapper = wrapperOf.get(host)
  if (!wrapper) return
  if (wrapper.parentNode === host) {
    while (wrapper.firstChild) host.insertBefore(wrapper.firstChild, wrapper)
    host.removeChild(wrapper)
  }
  wrapperOf.delete(host)
}

/**
 * 按语言三态更新每个可译块的宿主：
 * - orig：删 `.pc-zh`、解包 `.pc-orig`——宿主 innerHTML 复原到打标时的样子；
 * - both：宿主内追加 `.pc-zh`（译文 / 骨架 / 失败 chip），原始节点不动；
 * - zh：同 both，再把原始节点包进 `.pc-orig[hidden]`；失败态例外——显示原文 + chip（同 BlockReader）。
 * 不可译块（table/image/code）与空文本块永不触碰。
 */
export function applyLangState(doc: Document, blocks: readonly NormalizedBlock[], state: LangState): void {
  const hosts = blockElements(doc)
  for (const b of blocks) {
    const host = hosts[b.index]
    if (!host || !isTranslatableBlock(b.kind) || b.text.trim() === '') continue
    if (state.langMode === 'orig') {
      removeZh(host)
      unwrapOriginals(host)
      continue
    }
    const zh = state.translations?.get(b.index)
    const failed = state.failed?.has(b.index) === true
    const content = zhContent(doc, b.index, zh, failed, state.authIssue)
    ensureZh(host, content)
    if (state.langMode === 'zh' && !(zh === undefined && failed)) wrapOriginals(host)
    else unwrapOriginals(host)
  }
}

// ---------------------------------------------------------------------------
// 高亮：mark 包裹
// ---------------------------------------------------------------------------

/** 解包文档里全部 `<mark data-highlight-id>` 并 normalize 其父节点（拆分过的文本节点合回去） */
function unwrapMarks(doc: Document): void {
  const parents = new Set<Node>()
  for (const mark of Array.from(doc.querySelectorAll('mark[data-highlight-id]'))) {
    const parent = mark.parentNode
    if (!parent) continue
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
    parents.add(parent)
  }
  for (const p of parents) p.normalize()
}

/** 宿主内文本节点（文档序，跳过嵌套宿主子树）及各自在 hostText 里的起点 */
function textNodesOf(host: Element): { node: Text; start: number }[] {
  const doc = host.ownerDocument
  const walker = doc.createTreeWalker(host, SHOW_ELEMENT | SHOW_TEXT, {
    acceptNode: (n: Node) => (isElement(n) ? (isNestedHost(n) ? FILTER_REJECT : FILTER_SKIP) : FILTER_ACCEPT),
  })
  const out: { node: Text; start: number }[] = []
  let at = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!isText(n)) continue
    out.push({ node: n, start: at })
    at += n.data.length
  }
  return out
}

/**
 * 给一个宿主套 mark：区间按 start **降序**处理——splitText 把节点拆成「头 + 中 + 尾」时头节点留在
 * 列表里、起点不变，后处理的低区间只会落在头节点上，长度一律读实时值。区间彼此不重叠（写入时已合并）。
 */
function wrapHost(host: Element, rows: readonly PaperHighlight[]): void {
  const doc = host.ownerDocument
  const nodes = textNodesOf(host)
  const sorted = [...rows].sort((a, b) => b.start - a.start)
  for (const row of sorted) {
    for (const entry of nodes) {
      const nodeStart = entry.start
      const nodeEnd = nodeStart + entry.node.data.length
      const s = Math.max(row.start, nodeStart)
      const e = Math.min(row.end, nodeEnd)
      if (e <= s) continue
      let mid = entry.node
      if (s > nodeStart) mid = mid.splitText(s - nodeStart)
      if (e < nodeEnd) mid.splitText(e - s)
      const mark = doc.createElement('mark')
      mark.setAttribute('data-highlight-id', row.id)
      const parent = mid.parentNode
      if (!parent) continue
      parent.insertBefore(mark, mid)
      mark.appendChild(mid)
    }
  }
}

/**
 * 全量重放高亮：先解包已有 mark（幂等），再对每块的 orig 宿主 / zh 宿主分别校验区间（validRanges）
 * 后跨文本节点包 `<mark data-highlight-id>`。orig 宿主 = 打标元素；zh 宿主 = 其内部的 `.pc-zh[data-hl-host=zh]`。
 */
export function applyHighlights(doc: Document, byBlock: ReadonlyMap<number, readonly PaperHighlight[]>): void {
  unwrapMarks(doc)
  if (!byBlock.size) return
  const hosts = blockElements(doc)
  for (const [blockIndex, rows] of byBlock) {
    if (!rows.length) continue
    const el = hosts[blockIndex]
    if (!el) continue
    if (el.getAttribute('data-hl-host') === 'orig') {
      const mine = validRanges(hostText(el), rows.filter((r) => r.lang === 'orig'))
      if (mine.length) wrapHost(el, mine)
    }
    const zh = zhOf.get(el)?.el
    if (zh && zh.parentNode === el && zh.getAttribute('data-hl-host') === 'zh') {
      const mine = validRanges(hostText(zh), rows.filter((r) => r.lang === 'zh'))
      if (mine.length) wrapHost(zh, mine)
    }
  }
}

// ---------------------------------------------------------------------------
// 几何与链接
// ---------------------------------------------------------------------------

export interface ParentRect {
  top: number
  left: number
  bottom: number
  right: number
  width: number
  height: number
}

/** iframe 文档里元素的矩形换算到父视口坐标（iframe 不内滚，只需加上 iframe 自身位置与边框） */
export function hostRectInParent(iframe: HTMLIFrameElement, el: Element): ParentRect {
  const frame = iframe.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  const dx = frame.left + iframe.clientLeft
  const dy = frame.top + iframe.clientTop
  return { top: r.top + dy, left: r.left + dx, bottom: r.bottom + dy, right: r.right + dx, width: r.width, height: r.height }
}

/** 「当前块」观察带占阅读窗格可视高度的比例：上 1/4（与 BlockReader 的 `-75%` 同一口径） */
export const CURRENT_BLOCK_BAND_RATIO = 0.25

/**
 * 「当前块」观察带的顶边内缩量。必须**大于**程序化对齐的顶部留白（READER_ALIGN_MARGIN）：
 * 对齐后目标块顶边在窗格顶边下 16px，上一块的底边不会低过这条线。BlockReader 的块间距恒 ≥ 12px，
 * 内缩 8（CURRENT_PAGE_EPSILON）就够；快照里的块间距由站点 CSS 决定，可以是 0（列表项、参考文献条目，
 * arXiv 那篇 259 个间距里 78 个 ≤ 8px）。内缩不过对齐留白，上一块就还在带里，`min` 取到它，当前块倒退一格；
 * 每次重开/切视图又按倒退后的位置再对齐，阅读位置就一格一格往回走。
 */
export const SNAPSHOT_BAND_INSET = READER_ALIGN_MARGIN + 2

/**
 * 「当前块」观察带 → 父窗口 IntersectionObserver 的 rootMargin。
 *
 * 快照的块在 iframe 文档里，观察器的 root 只能是隐式的**顶层视口**（规范要求显式 root 与 target 同文档），
 * rootMargin 因此是相对浏览器视口算的，不是相对阅读窗格（main）。BlockReader 那句 `-8px 0px -75% 0px`
 * 原样搬过来，量的就成了「浏览器视口的上 1/4」：main 的顶边在导航 + 标题 + 工具行之下，窗口一矮
 * （或工具行一换行）它就整个落在这条带子下面，再没有块能进带——当前块冻住，目录高亮与阅读进度不动，
 * 译文窗口（当前块 −4…+16）不再跟着滚动走，屏幕上的骨架永远等不到译文。
 *
 * 这里把「main 的上 1/4、顶边内缩 epsilon」换算成视口坐标下的内缩量（epsilon 传 SNAPSHOT_BAND_INSET）：
 * - paneTop / paneHeight：main 内容盒顶边的视口坐标与可视高度（`getBoundingClientRect().top + clientTop`、`clientHeight`）；
 * - viewportHeight：顶层视口高。
 * 取整到 px（rootMargin 只收 px / %）。main 不可见（display:none，高度 0）或带高不为正时返回 null：
 * 此时没有「当前块」可言，调用方不建观察器。
 */
export function currentBlockRootMargin(
  paneTop: number,
  paneHeight: number,
  viewportHeight: number,
  epsilon: number,
): string | null {
  if (![paneTop, paneHeight, viewportHeight].every(Number.isFinite) || paneHeight <= 0 || viewportHeight <= 0) return null
  const bandTop = Math.round(paneTop + epsilon)
  const bandBottom = Math.round(paneTop + paneHeight * CURRENT_BLOCK_BAND_RATIO)
  if (bandBottom <= bandTop) return null
  // 负值 = 向内收：顶边下移到 bandTop，底边上移到 bandBottom
  return `${-bandTop}px 0px ${bandBottom - Math.round(viewportHeight)}px 0px`
}

// ---------------------------------------------------------------------------
// 跨 iframe 滚动锚定：坐标与锚点规则
// ---------------------------------------------------------------------------

/** iframe 文档坐标里的一段纵向区间：`getBoundingClientRect()` 再加 iframe 窗口的 scrollY */
export interface DocSpan {
  top: number
  bottom: number
}

/**
 * 元素在 iframe 文档坐标里的上下边。iframe 文档不内滚，scrollY 正常恒为 0；照加不误，防的是焦点/页内查找把它的视口挪了。
 * 宽高都为 0 = 没有布局（display:none、zh 模式下随外层原文被包进 `.pc-orig[hidden]` 的块）：坐标没有意义，返回 null。
 */
export function docSpanOf(el: Element, scrollY: number): DocSpan | null {
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  return { top: r.top + scrollY, bottom: r.bottom + scrollY }
}

/** 阅读窗格（main 的滚动视口，含 clientTop 边框修正）在 iframe 文档坐标里的上下边 */
export function paneSpanInFrame(main: Element, iframe: HTMLIFrameElement, scrollY: number): DocSpan {
  const paneTop = main.getBoundingClientRect().top + main.clientTop
  const frame = iframe.getBoundingClientRect()
  const top = paneTop - (frame.top + iframe.clientTop) + scrollY
  return { top, bottom: top + main.clientHeight }
}

/**
 * 跨 iframe 滚动锚定选哪一块当锚点（WebSnapshotView 的 A/B 两路共用）。返回 `spans` 的下标，没有返回 -1（不补偿）。
 *
 * 为什么要自己锚：iframe 不内滚、整篇在 main 里滚，浏览器原生的 scroll anchoring 看不进 iframe——main 里能当锚点的
 * 只有 iframe 元素本身。iframe 文档里视口上方任何内容变高变矮（回看块的译文落地、切语言一次性挂上全部缓存译文、
 * 「中文」把原文包进 `.pc-orig[hidden]`），都会把正在读的内容整体推走。
 *
 * 规则（坐标一律是 iframe 文档坐标；`probe` = 窗格顶 + SNAPSHOT_BAND_INSET，与「当前块」观察带同口径）：
 * 1. 优先取**包含探测线**的块（`top ≤ probe < bottom`）；有多个（嵌套）时取 top 最大的最内层，top 相同取文档序靠后者；
 * 2. 否则取顶边落在 `(probe, viewBottom)` 里、top 最小的块；
 * 3. 都没有返回 -1。`spans` 按文档序给出，null（没有布局的块）跳过。
 *
 * 两个关键场景：
 * - 目录跳转：第 N 块顶边对齐在窗格顶 +16px（READER_ALIGN_MARGIN），探测线在 +18 → 锚 N；第 N−1 块底边 ≤ +16，选不中。
 *   若锚「第一个底边低于窗格顶的块」会选中 N−1——N−1 自己的译文挂在它底部，一挂上 N 就被推走；
 * - 顺读：正在读的块 K 跨着窗格顶 → 锚 K。K 的译文挂在它底部往下推后文，正在读的那几行不动（同原生锚定的手感）。
 */
export function pickScrollAnchor(spans: readonly (DocSpan | null | undefined)[], probe: number, viewBottom: number): number {
  let inside = -1
  let insideTop = -Infinity
  let below = -1
  let belowTop = Infinity
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]
    if (!s) continue
    if (s.top <= probe && probe < s.bottom) {
      // >=：top 相同取文档序靠后者（嵌套时它在里层）
      if (s.top >= insideTop) {
        inside = i
        insideTop = s.top
      }
    } else if (s.top > probe && s.top < viewBottom && s.top < belowTop) {
      below = i
      belowTop = s.top
    }
  }
  return inside >= 0 ? inside : below
}

/**
 * 在 iframe 文档里按 pickScrollAnchor 的规则选锚点块：`pane` 是阅读窗格在 iframe 文档坐标里的上下边（paneSpanInFrame），
 * 探测线 = 窗格顶 + SNAPSHOT_BAND_INSET。返回宿主元素、它的文档坐标顶边，以及它是不是按规则 1 选中的
 * （`contained`：此刻包含探测线）；窗格里没有可用的块返回 null。
 */
export function findScrollAnchor(
  doc: Document,
  pane: DocSpan,
  scrollY: number,
): { el: Element; top: number; contained: boolean } | null {
  const els = Array.from(doc.querySelectorAll(`[${STAMP_ATTR}]`))
  const spans = els.map((el) => docSpanOf(el, scrollY))
  const probe = pane.top + SNAPSHOT_BAND_INSET
  const i = pickScrollAnchor(spans, probe, pane.bottom)
  const el = els[i]
  const span = spans[i]
  return el && span ? { el, top: span.top, contained: span.top <= probe && probe < span.bottom } : null
}

// ---------------------------------------------------------------------------
// 锚点补偿的判定（WebSnapshotView 只管读 DOM / 写 scrollTop，怎么算全在这里，node 单测）
// ---------------------------------------------------------------------------

/** 锚点位移小于它不补偿（亚像素噪声） */
export const ANCHOR_EPSILON_PX = 0.5

/** 一条锚点记录里与滚动位置有关的两个数：读回来的 scrollTop，与未取整的理想 scrollTop */
export interface IdealScroll {
  scrollTop: number
  ideal: number
}

/**
 * 新记录的理想 scrollTop：上一条记录仍新鲜（scrollTop 自记录以来没动过，差 <1px）就沿用它的理想值，否则以读回值重新起算。
 *
 * 为什么要有「理想值」：WebKit 的 scrollTop 只存整数且**向下截断**。每次补偿写 `读回值 + d`，写进去又被截掉小数，
 * 再拿读回的整数当下一次的基准——每补偿一次丢约 0.5px，块单向下漂。对齐留白 16、探测线 18，只有 2px 余量，
 * 漂过去锚点就翻到上一块（实测第 320 块 16.7 → 17 → 17.9 → 18 → −137）。按未取整的理想值累计，误差恒 <1px。
 */
export function inheritIdealScrollTop(actual: number, prev: IdealScroll | null | undefined): number {
  return prev && Math.abs(actual - prev.scrollTop) < 1 ? prev.ideal : actual
}

/**
 * 写入之后理想值怎么记：读回与想写的差不到 1px 只是被取整，保留想写的值；否则是被钳位了（到顶 / 到底），以读回值为准。
 */
export function resolveIdealScrollTop(wanted: number, actual: number): number {
  return Math.abs(actual - wanted) < 1 ? wanted : actual
}

/**
 * 塌缩重对齐要追加的滚动量（加到 scrollTop 上，负值 = 往回滚）；不需要时返回 0。
 *
 * 锚点块原本包含探测线（规则 1），改动后它自己变矮——读到段落中部时切「中文」而译文还没缓存，原文收起只剩骨架——
 * 顶边虽然被补偿留在原处，底边却到了探测线之上：探测线落到后面的块上，当前块前移、阅读位置跟着跑。
 * 这时改为把它的顶边对齐到窗格顶 + alignMargin（与程序化对齐同一口径），探测线仍落在它身上。
 *
 * @param offsetTop 块顶边相对窗格顶的偏移（补偿会保持它不变）
 * @param height 块此刻的高度
 */
export function collapseRealign(
  offsetTop: number,
  height: number,
  probeInset: number = SNAPSHOT_BAND_INSET,
  alignMargin: number = READER_ALIGN_MARGIN,
): number {
  return offsetTop + height <= probeInset ? offsetTop - alignMargin : 0
}

/** 补偿判定需要的锚点记录字段 */
export interface AnchorState {
  /** 记录时锚点块在 iframe 文档坐标里的顶边 */
  docTop: number
  /** 记录时它的顶边相对窗格顶的偏移 */
  offsetTop: number
  /** 按规则 1 选中（记录时包含探测线） */
  contained: boolean
  /** 记录时未取整的理想 scrollTop */
  ideal: number
}

/**
 * 按记录补偿该把 scrollTop 写成多少：锚点块在文档里挪了多少，main 就跟着滚多少，再叠加塌缩重对齐。
 * 用**记录里的理想值**算绝对值——iframe 变矮时浏览器可能先钳位了 main.scrollTop，按现值去加会算错；负值截到 0，
 * 超上限交给浏览器钳位。总位移不到 ANCHOR_EPSILON_PX 返回 null（不写）。
 */
export function anchorRestoreTarget(a: AnchorState, now: DocSpan): { top: number; realigned: boolean } | null {
  const shift = now.top - a.docTop
  const realign = a.contained ? collapseRealign(a.offsetTop, now.bottom - now.top) : 0
  if (Math.abs(shift + realign) < ANCHOR_EPSILON_PX) return null
  return { top: Math.max(0, a.ideal + shift + realign), realigned: realign !== 0 }
}

/** 共享锚点记录此刻能不能拿来补偿：没有记录 / 已过期 / 平滑跳转进行中（不补，记录留着）/ 可用 */
export type SharedRecordVerdict = 'none' | 'stale' | 'smooth' | 'use'

/**
 * 共享锚点记录还能不能用来补偿「记录之后发生的外部重排」（B 的 RO 回调与 A 现量锚点之前共用同一口径）：
 * - 没有记录，或拿不到容器的 scrollTop → 'none'；
 * - scrollTop 与记录差 ≥1px → 'stale'：记录之后滚动过（用户滚动；程序化滚动刚写过、scroll 事件还没派发），
 *   按它去补会把那次滚动抵消掉，调用方应作废记录；
 * - 平滑跳转进行中 → 'smooth'：不写 scrollTop（会打断动画），记录留着；
 * - 其余 → 'use'。
 * 过期先于平滑跳转判定：跳转途中 scrollTop 一直在变，记录本来就该作废。
 */
export function sharedRecordVerdict(
  rec: { scrollTop: number } | null | undefined,
  scrollTop: number | null | undefined,
  smoothActive: boolean,
): SharedRecordVerdict {
  if (!rec || scrollTop === null || scrollTop === undefined) return 'none'
  if (Math.abs(scrollTop - rec.scrollTop) >= 1) return 'stale'
  return smoothActive ? 'smooth' : 'use'
}

/** 「改 DOM + 锚定」这一串动作里要碰 DOM 的各步（WebSnapshotView 给真实现，单测给模型） */
export interface AnchoredMutationSteps<A> {
  /** 按共享记录把「上次记录之后、还没补偿的外部重排」补掉（记录不可用就什么都不做） */
  compensatePending(): void
  /** 现量锚点；窗格里没有可锚的块返回 null */
  capture(): A | null
  /** 改 DOM */
  mutate(): void
  /** 同步 iframe 高度 */
  syncHeight(): void
  /** 按锚点位移补偿 */
  restore(anchor: A): void
  /** 收尾：刷新共享记录。`anchor` 是刚补偿过的那条，新记录要继承它未取整的理想值 */
  commit(anchor: A | null): void
}

/**
 * A 的时序（没有平滑跳转在进行时）。这个函数的全部内容就是顺序：
 *
 * 1. **先补偿待处理的外部重排，再现量锚点。** B 靠 iframe 的 ResizeObserver，回调要等下一次渲染才来；React 的 effect
 *    可能抢在它前面。现量会强制排版，量到的是已经被外部重排推偏的位置——把它当成既成事实去锚，还顺手刷新了共享记录，
 *    随后 B 到来时位移为 0，不补，块就停在偏了的地方。全应用 WebKit「中文」带缓存重开 2/94 次：续读对齐后字体换上，
 *    上方矮了 52px，块停在 −35.5px；每来一次还会累计（16.4 → 25.1 → 33.8 → …）。
 * 2. 现量在改 DOM 之前；改完先同步高度再补偿（高度没跟上就写 scrollTop 会被钳位）。
 */
export function runAnchoredMutation<A>(steps: AnchoredMutationSteps<A>): void {
  steps.compensatePending()
  const anchor = steps.capture()
  steps.mutate()
  steps.syncHeight()
  if (anchor) steps.restore(anchor)
  steps.commit(anchor)
}

// ---------------------------------------------------------------------------
// 平滑跳转、滚动来源与暂缓的判定
// ---------------------------------------------------------------------------

/**
 * 平滑跳转发起时目标是否已在原位（截到最大滚动位置后的目标与当前 scrollTop 差 <1px）：这时不会有任何 scroll 事件，
 * 调用方要自己起静止计时来结束跳转状态。其余情况**不能**在发起时起计时——工作台点目录是先发起滚动、再触发整页同步重渲染，
 * 主线程一卡过静止时长，计时器就先于第一个 scroll 事件到点，把还没动的跳转判成结束（随后的落地按锚点去补，
 * 把动画掐在半路，实测最终偏出一万多像素）。等第一个 scroll 事件来起计时，另有时长上限兜底。
 */
export function smoothStartsInPlace(target: number, current: number, maxScroll: number): boolean {
  return Math.abs(Math.min(target, Math.max(0, maxScroll)) - current) < 1
}

/** 平滑跳转的逼近进度：`dist` 是离目标的距离（逼近中记最小值），`approaching` 表示已经开始变近 */
export interface SmoothProgress {
  dist: number | null
  approaching: boolean
}

/** 发起 / 重新瞄准时的初始进度：目标变了，距离从头量 */
export const SMOOTH_PROGRESS_START: SmoothProgress = { dist: null, approaching: false }

/** 逼近中离目标又变远超过它，判定用户已接管 */
export const SMOOTH_DIVERGE_PX = 2

/**
 * 平滑跳转进行中的每个 scroll 事件喂一次「离目标的距离」，判断用户是不是已经接管了滚动。
 *
 * 为什么需要：WebKit 不给无脚本沙箱文档派发父窗口挂的监听，iframe 里的滚轮 / 触摸 / 按键全收不到，跳转状态会一直留到
 * 静止或时长上限，期间落地的改动被「重新瞄准」拽回目标。动画只会让距离变小；逼近中距离反而变大（超过 SMOOTH_DIVERGE_PX），
 * 只可能是用户在往别处滚。
 *
 * 为什么要等「开始变近」才判：对一个进行中的平滑滚动重新瞄准到身后的目标时，两个引擎都会先沿旧方向再走一帧
 * （实测 Chromium +192px、WebKit +627px）才掉头——自己重新瞄准后的头几个事件里距离本来就在变大，不能算接管。
 */
export function trackSmoothProgress(p: SmoothProgress, dist: number): { progress: SmoothProgress; takenOver: boolean } {
  if (p.dist === null) return { progress: { dist, approaching: false }, takenOver: false }
  if (!p.approaching) return { progress: { dist, approaching: dist < p.dist - 0.5 }, takenOver: false }
  if (dist > p.dist + SMOOTH_DIVERGE_PX) return { progress: p, takenOver: true }
  return { progress: { dist: Math.min(p.dist, dist), approaching: true }, takenOver: false }
}

/** main 的一次 scroll 事件是谁滚的 */
export type ScrollSource = 'smooth' | 'own' | 'native'

/**
 * 区分滚动来源：有进行中的平滑跳转 → 不算原生；否则 scrollTop 与组件自己最后写入的值（读回值）差 <1px → 自己写的
 * （补偿、瞬时对齐、滚轮转发桥、同步高度后的复位）；其余是用户的原生滚动（触摸惯性、键盘翻页、拖滚动条、WebKit 的原生滚轮）。
 */
export function classifyScroll(scrollTop: number, ownWrite: number | null, smoothActive: boolean): ScrollSource {
  if (smoothActive) return 'smooth'
  return ownWrite !== null && Math.abs(scrollTop - ownWrite) < 1 ? 'own' : 'native'
}

/**
 * 这次 DOM 改动要不要暂缓到滚动停稳再落。
 *
 * 用户的原生滚动由浏览器的滚动线程 / 滚动动画驱动，途中写 scrollTop 会被它按旧位置覆盖：WebKit 键盘 PageDown 途中落地译文，
 * 翻页被截断（只滚 126px，正常 408px），参考块被下推 603px，补偿整个丢了；原生滚轮则是闪两帧。所以原生滚动刚发生过
 * （距今不到 holdMs）就先不改 DOM，停稳后带着锚定一起落。平滑跳转进行中不暂缓（那条路径只重新瞄准、不写 scrollTop）；
 * 窗格不可见时没有位置可言，直接应用。holdMs 必须小于静止时长，否则停稳时的冲刷自己也会被暂缓。
 */
export function shouldHoldMutation(input: {
  smooth: boolean
  paneVisible: boolean
  sinceNativeMs: number
  holdMs: number
}): boolean {
  return !input.smooth && input.paneVisible && input.sinceNativeMs < input.holdMs
}

// ---------------------------------------------------------------------------
// iframe 高度：两段式、内容尺寸跟着视口走（耦合）、整次同步的编排
// ---------------------------------------------------------------------------

/** iframe 高度的一次测量（全在 iframe 文档里量） */
export interface FrameHeightProbe {
  /** 流内内容高 = max(html 的 rect 高, body.scrollHeight)：两者都是 auto 高，没有视口下限 */
  inFlow: number
  /** html.scrollHeight：含绝对定位溢出（只反映在它上面），但永远不小于 iframe 当前视口高——是下限，不是测量值 */
  scroll: number
  /** html.clientHeight：iframe 当前的视口高（= 当前 iframe 高度） */
  view: number
}

export interface FrameHeightStep {
  height: number
  /** true = 这是一次降高：调用方写入后要再量一次（降下来才看得出绝对定位版式有没有溢出） */
  recheck: boolean
}

/**
 * iframe 高度的单段判定（syncFrameHeight 编排两段）：
 * - `scroll > view + 1`：内容溢出当前高度，取 scroll（含绝对定位溢出）；
 * - 否则内容装得下，scroll 只是视口下限：inFlow 与 view 差不到 1px 就维持现高；明显更矮则降到 inFlow 并要求复查——
 *   调用方写入后（同一任务里，没有中间帧）再量一次，此时 scroll 溢出（绝对定位版式）就取第二次的 scroll。
 *
 * 原先取 `max(html.scrollHeight, …)`：根元素的 scrollHeight 不小于 iframe 视口高，iframe 只增不减，
 * 「对照 → 原文」后底部留下上万像素空白。
 *
 * 绝对定位溢出撑着高度时，稳态下 scroll 恰等于 view，单段分不清这是视口下限还是真实溢出，所以每次都会复查一遍；
 * 两段在同一任务里落回同一高度（没有中间帧，不会跨帧振荡）。中间那次降高可能让外层滚动容器被钳位，
 * 由 WebSnapshotView 的 syncHeight 在量完后把 scrollTop 放回去。
 */
export function frameHeightPass({ inFlow, scroll, view }: FrameHeightProbe): FrameHeightStep {
  // 与 inFlow 取大：scrollHeight 是四舍五入的整数，流内高度带小数时它可能比向上取整的 inFlow 少 1px，最后那点内容不能裁掉
  if (scroll > view + 1) return { height: Math.max(scroll, inFlow), recheck: false }
  if (inFlow >= view - 1) return { height: Math.max(view, inFlow), recheck: false }
  return { height: inFlow, recheck: true }
}

/**
 * 内容尺寸跟着 iframe 视口走的量：视口每长高 1px，内容也跟着长 1px，所以量出来总比视口多出固定的一截。
 * 两种形态：
 * - (i) 溢出跟着视口：`position:absolute; bottom:-200px`（包含块是初始包含块）永远挂在视口底边下方 → 只有 scrollExtra；
 * - (ii) 流内高度跟着视口：正文容器 `min-height:100vh` 后面还跟着页脚 → 文档高 = max(正文, 视口) + 页脚，两个量都有。
 *   vh 本该在水合时钉死（neutralizeViewportUnits），但导入时样式表抓取失败会回落成 `@import url(远程)`，远程文本改不到。
 */
export interface FrameCoupling {
  /** 流内高度比视口多出的部分（形态 ii；形态 i 为 0） */
  inFlowExtra: number
  /** scrollHeight 比视口多出的部分 */
  scrollExtra: number
}

/**
 * 刚把高度写成量到的值之后，同一任务里再量一次：扣掉已知的耦合量还溢出（>1px），只可能是内容尺寸跟着视口走——
 * 同步过程中没有别的东西在变。返回按这次测量记下的耦合量；不溢出则原样返回 `known`（没有耦合就是 null）。
 *
 * 不认这个的后果：每同步一次高度就往上棘轮一截，永远追不上。形态 (ii) 每个 RO 回合涨一截，直到高度上限，
 * 正文区一片空白（实测每 250ms 涨约 5000px）；形态 (i) 每落一包译文涨 200px，切回原文也缩不回。
 * 合法的绝对定位溢出（`top:6000px`）不随视口动，撑到它的底边就不再溢出，不会被判成耦合。
 * `known` 非空时用于复查：耦合量自己变了（页脚换行变高）也会表现成「长完还想长」，改记新量即可。
 */
export function probeViewportCoupling(after: FrameHeightProbe, known: FrameCoupling | null): FrameCoupling | null {
  const residual = Math.max(
    after.inFlow - after.view - (known?.inFlowExtra ?? 0),
    after.scroll - after.view - (known?.scrollExtra ?? 0),
  )
  if (residual <= 1) return known
  return { inFlowExtra: Math.max(0, after.inFlow - after.view), scrollExtra: Math.max(0, after.scroll - after.view) }
}

/**
 * 耦合模式下的一步，返回该有的高度（等于 `view` 即维持现高）：
 * - 扣掉耦合量之后还多出 >1px：内容真的变多了，只长这一截；
 * - 否则，流内不耦合（形态 i）且流内高度明显小于视口：降到流内高度——切回原文能缩回；
 * - 其余维持现高。形态 (ii) 下「流内高度」本身含着视口，分不出正文到底多高，所以只长不缩，页脚也会落在视口之外被裁掉：
 *   这是可以接受的降级（正文完整、不再失控）。彻底的修法是运行期把跟着视口走的元素钉住，不在这里做。
 */
export function coupledFrameHeight({ inFlow, scroll, view }: FrameHeightProbe, c: FrameCoupling): number {
  const grow = Math.max(inFlow - view - c.inFlowExtra, scroll - view - c.scrollExtra)
  if (grow > 1) return view + grow
  if (c.inFlowExtra <= 1 && inFlow < view - 1) return inFlow
  return view
}

/** 高度同步要用到的两个动作（WebSnapshotView 给真实现，单测给布局模型） */
export interface FrameHeightIO {
  /** 在 iframe 文档里量一次 */
  measure(): FrameHeightProbe
  /** 写入 iframe 高度，返回写完后实际生效的高度（调用方可能按上限截断，或因差不到 1px 没写） */
  write(height: number): number
}

/**
 * 同步一次 iframe 高度（全在同一个任务里，没有中间帧），返回此后这份文档的耦合量（null = 不耦合）。
 * - 不耦合：两段式（frameHeightPass）。凡是按 scroll 撑高之后——包括第二段——再量一次探测耦合；探到了就按耦合模式收尾一步
 *   （形态 i 首次同步时把刚才多撑的那截还回去）。写入被上限截断时不探测：截断后必然还溢出，那不是耦合。
 * - 已耦合：只走 coupledFrameHeight；长高之后复查耦合量有没有变。
 */
export function syncFrameHeight(io: FrameHeightIO, coupling: FrameCoupling | null): FrameCoupling | null {
  if (coupling) {
    const probe = io.measure()
    const height = coupledFrameHeight(probe, coupling)
    if (height === probe.view) return coupling
    const wrote = io.write(height)
    return height > probe.view && wrote === height ? probeViewportCoupling(io.measure(), coupling) : coupling
  }
  let probe = io.measure()
  let step = frameHeightPass(probe)
  let wrote = io.write(step.height)
  if (step.recheck) {
    probe = io.measure()
    step = frameHeightPass(probe)
    wrote = io.write(step.height)
  }
  if (step.height <= probe.view + 1 || wrote !== step.height) return null
  const after = io.measure()
  const found = probeViewportCoupling(after, null)
  if (found) io.write(coupledFrameHeight(after, found))
  return found
}

export type LinkAction = { kind: 'fragment'; id: string } | { kind: 'external'; href: string } | { kind: 'ignore' }

const sameDocument = (a: URL, b: URL): boolean => a.origin === b.origin && a.pathname === b.pathname && a.search === b.search

/**
 * 点击链接该做什么：页内锚（`#frag` 或指回本页的绝对 URL 带 hash）→ 父页滚动；http(s) → 新窗口；
 * 其余（空 href、`#`、mailto/tel/javascript、解析失败）→ 忽略。
 * 调用方在 iframe 文档捕获阶段拦截并 preventDefault：沙箱无 popups/forms，但 iframe 仍可**自导航**到外站。
 */
export function pickLinkAction(a: Element, finalUrl: string): LinkAction {
  const raw = (a.getAttribute('href') ?? '').trim()
  if (!raw) return { kind: 'ignore' }
  const fragment = (hash: string): LinkAction => {
    let id = hash.replace(/^#/, '')
    try {
      id = decodeURIComponent(id)
    } catch {
      /* 非法转义：按原样找 id */
    }
    return id ? { kind: 'fragment', id } : { kind: 'ignore' }
  }
  if (raw.startsWith('#')) return fragment(raw)
  let url: URL
  try {
    url = new URL(raw, finalUrl)
  } catch {
    return { kind: 'ignore' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'ignore' }
  let base: URL | null = null
  try {
    base = new URL(finalUrl)
  } catch {
    base = null
  }
  if (base && url.hash && sameDocument(url, base)) return fragment(url.hash)
  return { kind: 'external', href: url.href }
}
