import type { LlmAuthCode } from '../../lib/llmClient'
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
[data-pc-fixed] { position: static !important; }
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
