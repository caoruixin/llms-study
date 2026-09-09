import { tableToText } from '../normalizeDocx'
import { sanitizeArticleHtml } from '../sanitize'
import type { NormalizedBlock, PaperBlockKind } from '../types'

/**
 * 网页原貌导入的「打标 + 块推导」（PLAN-web-snapshot-sync.md §2.2 第 6 条）。
 *
 * 输入一份 DOM（浏览器 DOMParser 或 happy-dom 产物），**就地**给每个可阅读单元打上
 * `data-pc-block="N"`，同时产出与之一一对应的 NormalizedBlock[]（N = block.index，文档序连续）。
 * 快照头里的 blocks 是唯一的块来源，阅读器只按 `[data-pc-block]` 找宿主，不再从 DOM 重推。
 *
 * 不变式（stampBlocks.test.ts 逐块断言）：对每个文本块（kind ≠ table/image），
 * `hostText(doc.querySelector('[data-pc-block="N"]')) === blocks[N].text`——
 * 高亮偏移、译文挂载、划词捕获都建立在这一等式上（selectionOffsets.ts 共用 hostText）。
 *
 * 只碰 DOM：无 Dexie、无网络；DOMPurify 仅用于 table 块的 html 字段（沿 normalizeHtml.ts 口径）。
 *
 * 幂等：函数开头先撕掉上一次的 `data-pc-block` 并解包 `[data-pc-run]`，再重新打标——
 * 对已打标文档再跑一次得到的 blocks 与 DOM 完全一致（空白规整本身是幂等的）。
 */

/** 打标元素的属性：值 = block.index */
export const STAMP_ATTR = 'data-pc-block'
/** 混合容器里被包起来的松散行内串（stampBlocks 唯一会新建的元素：`<span data-pc-run>`） */
export const RUN_ATTR = 'data-pc-run'
/** 捕获代理在活树上标出的不可见文本元素（display:none / visibility:hidden），整棵子树跳过 */
export const HIDDEN_ATTR = 'data-pc-hidden'
/** 捕获代理标出的 `white-space: pre*` 元素：文本原样，不做空白规整 */
export const PRE_ATTR = 'data-pc-pre'

export interface StampOptions {
  /** 泛型容器（div/section/span/a/…）成块所需的最少字符数（空白规整后），默认 20 */
  minGenericChars?: number
}

const DEFAULT_MIN_GENERIC_CHARS = 20

/** 整棵子树跳过（不打标、不下探、不出图）；body 自身不做此检查 */
const SKIP_SELECTOR = 'nav, head, script, style, template, noscript, [aria-hidden="true"], [hidden], [data-pc-hidden]'

/** 行内原子：不下探、不单独打标；文本仍计入 hostText，但不计入成块判定（见 visibleText） */
const MATH_ATOM_TAGS = new Set(['math', 'mjx-container'])
/** 其余行内原子（无可读文本或文本无意义） */
const MEDIA_ATOM_TAGS = new Set(['img', 'picture', 'svg', 'canvas', 'br', 'wbr', 'input'])

/** 短语内容：出现在候选容器里时视为行内；span/a 作为 run 的唯一节点时可被直接打标 */
const PHRASING_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q',
  'ruby', 'rp', 'rt', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var',
  'button', 'label', 'del', 'ins',
  // 旧式行内标签：老站点常见，语义等同 b/i/span
  'font', 'big', 'tt', 'strike', 'nobr', 'acronym',
])

/** 不透明元素：既不下探也不出图（表单控件/嵌入内容，sanitize 阶段整体剥除） */
const OPAQUE_TAGS = new Set([
  'textarea', 'select', 'option', 'optgroup', 'datalist', 'iframe', 'object', 'embed', 'video', 'audio',
  'meter', 'progress',
])

/** 空白规整跳过：这些祖先之下的文本节点原样保留（block.text 直接等于 hostText） */
const VERBATIM_TAGS = new Set(['pre', 'code', 'textarea'])

/** 判定为「有内容」的媒体后代（空的非短语元素当作行内原子，避免无谓拆 run） */
const MEDIA_SELECTOR = 'img, svg, canvas, picture, video, iframe, object, embed'

const LETTER_RE = /\p{L}/u

interface KindInfo {
  kind: PaperBlockKind
  level?: number
  /**
   * 语义标签（h1-h6 / p / li / figcaption / caption / pre / blockquote / dt / dd / summary）只要求 ≥1 个字母；
   * 泛型容器（div/section/article/aside/header/footer/main/span/a/td/th）还要求 ≥ minGenericChars
   */
  semantic: boolean
}

const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 }
const SEMANTIC_KIND: Record<string, PaperBlockKind> = {
  p: 'paragraph', blockquote: 'paragraph', dt: 'paragraph', dd: 'paragraph', summary: 'paragraph',
  li: 'list',
  figcaption: 'caption', caption: 'caption',
  pre: 'code',
}
const GENERIC_TAGS = new Set(['div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'span', 'a', 'td', 'th'])
/** run 只有一个元素节点且是这两种标签时直接打在它身上，不再套 `<span data-pc-run>` */
const DIRECT_STAMP_TAGS = new Set(['span', 'a'])

const ELEMENT_NODE = 1
const TEXT_NODE = 3

const localName = (el: Element): string => el.localName.toLowerCase()
export const isElement = (n: Node): n is Element => n.nodeType === ELEMENT_NODE
export const isText = (n: Node): n is Text => n.nodeType === TEXT_NODE
const collapseWs = (s: string): string => s.replace(/\s+/g, ' ').trim()

function kindOf(el: Element): KindInfo | null {
  const tag = localName(el)
  const level = HEADING_LEVEL[tag]
  if (level) return { kind: 'heading', level, semantic: true }
  const semantic = SEMANTIC_KIND[tag]
  if (semantic) return { kind: semantic, semantic: true }
  if (GENERIC_TAGS.has(tag)) return { kind: 'paragraph', semantic: false }
  return null
}

/** 阅读器挂载译文（`.pc-zh[data-hl-host="zh"]`）后，这些子树不属于宿主原文（snapshotDom 的选区/译文遍历共用同一口径） */
export const isNestedHost = (el: Element): boolean => el.hasAttribute('data-hl-host') || el.classList.contains('pc-zh')

const isMathAtom = (el: Element): boolean => MATH_ATOM_TAGS.has(localName(el)) || el.classList.contains('katex')

/**
 * 宿主原文 = 宿主内全部后代文本节点按文档序拼接，**排除**嵌套宿主（`[data-hl-host]`）与 `.pc-zh` 子树。
 * 与 selectionOffsets.ts 共用：偏移相对这个字符串，所以译文嵌在原文宿主内部（both 模式）也不破坏不变式。
 * svg/math/mjx-container/.katex 等行内原子的文本照常计入（简单、一致，两端同一实现）。
 */
export function hostText(host: Element): string {
  let out = ''
  const walk = (parent: Node): void => {
    for (let c = parent.firstChild; c; c = c.nextSibling) {
      if (isText(c)) out += c.data
      else if (isElement(c) && !isNestedHost(c)) walk(c)
    }
  }
  walk(host)
  return out
}

/** 成块判定用的「可见正文」：hostText 再去掉数学/svg 原子的文本，避免纯公式/纯图标容器被当成段落 */
function visibleTextOf(node: Node): string {
  if (isText(node)) return node.data
  if (!isElement(node) || isNestedHost(node) || isMathAtom(node) || localName(node) === 'svg') return ''
  let out = ''
  for (let c = node.firstChild; c; c = c.nextSibling) out += visibleTextOf(c)
  return out
}

/** 文本节点是否处在 pre/code/textarea/[data-pc-pre] 之下（一路查到文档根，宿主本身在 pre 内也算） */
function isVerbatim(node: Node): boolean {
  for (let p = node.parentNode; p && isElement(p); p = p.parentNode) {
    if (VERBATIM_TAGS.has(localName(p)) || p.hasAttribute(PRE_ATTR)) return true
  }
  return false
}

function collectTextNodes(parent: Node, out: Text[]): void {
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (isText(c)) out.push(c)
    else if (isElement(c) && !isNestedHost(c)) collectTextNodes(c, out)
  }
}

/**
 * 就地规整文本块的空白：每个文本节点内 `\s+`（含 NBSP）折成单个空格，跨节点边界不留双空格，
 * 去掉宿主整体的首尾空白（首尾若是纯空白节点则清空后继续向内）。
 * pre/code/textarea/[data-pc-pre] 之下的文本节点原样不动。执行后 `hostText(el)` 即为该块的 text。
 * 幂等：对已规整的元素再跑一次不产生任何改动。
 */
export function normalizeBlockWhitespace(el: Element): void {
  const nodes: Text[] = []
  collectTextNodes(el, nodes)
  const verbatim = nodes.map(isVerbatim)
  const next = nodes.map((n) => n.data)

  let prevSpace = true // 起始视同「前面已有空格」→ 首个非空白节点的前导空白被剥掉
  for (let i = 0; i < next.length; i++) {
    if (verbatim[i]) {
      if (next[i]) prevSpace = /\s$/.test(next[i])
      continue
    }
    let s = next[i].replace(/\s+/g, ' ')
    if (prevSpace && s.startsWith(' ')) s = s.slice(1)
    if (s) prevSpace = s.endsWith(' ')
    next[i] = s
  }
  for (let i = next.length - 1; i >= 0; i--) {
    if (verbatim[i]) break
    next[i] = next[i].replace(/\s+$/, '')
    if (next[i]) break
  }
  nodes.forEach((n, i) => {
    if (n.data !== next[i]) n.data = next[i]
  })
}

/** 撕掉上一次打标：属性清空 + 解包 run 包裹（子节点原位放回），使函数可重复调用 */
function unstamp(doc: Document): void {
  for (const run of Array.from(doc.querySelectorAll(`[${RUN_ATTR}]`))) {
    const parent = run.parentNode
    if (!parent) continue
    while (run.firstChild) parent.insertBefore(run.firstChild, run)
    parent.removeChild(run)
  }
  for (const el of Array.from(doc.querySelectorAll(`[${STAMP_ATTR}]`))) el.removeAttribute(STAMP_ATTR)
}

interface Ctx {
  blocks: NormalizedBlock[]
  section: string
  minGeneric: number
  /** isInline 的记忆表：短语元素是否含块级后代要递归判定，记一次即可 */
  inlineMemo: Map<Element, boolean>
}

function emit(ctx: Ctx, el: Element, kind: PaperBlockKind, text: string, extra?: { level?: number; html?: string; src?: string }): void {
  const index = ctx.blocks.length
  el.setAttribute(STAMP_ATTR, String(index))
  const block: NormalizedBlock = {
    index,
    kind,
    text,
    anchor: ctx.section ? { kind: 'html', blockIndex: index, section: ctx.section } : { kind: 'html', blockIndex: index },
  }
  if (extra?.level !== undefined) block.level = extra.level
  if (extra?.html) block.html = extra.html
  if (extra?.src) block.src = extra.src
  ctx.blocks.push(block)
}

const hasContent = (el: Element): boolean => /\S/.test(el.textContent ?? '') || el.querySelector(MEDIA_SELECTOR) !== null

/**
 * 子节点分类：行内（进 run / 留在候选容器内）还是块级（run 边界，单独下探）。
 * - 原子标签（img/svg/math/mjx-container/.katex/br/…）→ 行内；
 * - 短语标签 → 行内，除非其后代里藏着块级元素（`<a><div>卡片</div></a>` 这类要下探）；
 * - hr → 块级；
 * - 其余非短语元素：有文本或媒体 → 块级；空壳（锚点 div、清除浮动 div）→ 行内原子，不拆 run。
 */
function isInline(ctx: Ctx, el: Element): boolean {
  const memo = ctx.inlineMemo.get(el)
  if (memo !== undefined) return memo
  const tag = localName(el)
  let inline: boolean
  if (MEDIA_ATOM_TAGS.has(tag) || isMathAtom(el)) inline = true
  else if (PHRASING_TAGS.has(tag)) inline = !hasBlockChild(ctx, el)
  else if (tag === 'hr') inline = false
  else inline = !hasContent(el)
  ctx.inlineMemo.set(el, inline)
  return inline
}

function hasBlockChild(ctx: Ctx, el: Element): boolean {
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (isElement(c) && !isInline(ctx, c)) return true
  }
  return false
}

function eligible(ctx: Ctx, visible: string, info: KindInfo): boolean {
  if (!LETTER_RE.test(visible)) return false
  return info.semantic || visible.length >= ctx.minGeneric
}

/** 规整空白 → 取宿主原文 → 打标；heading 同时刷新 section（标题块自身的 section 就是它自己） */
function stampText(ctx: Ctx, host: Element, info: KindInfo): void {
  normalizeBlockWhitespace(host)
  const text = hostText(host)
  if (info.kind === 'heading') ctx.section = text
  emit(ctx, host, info.kind, text, info.level !== undefined ? { level: info.level } : undefined)
}

function svgLabel(svg: Element): string {
  for (let c = svg.firstChild; c; c = c.nextSibling) {
    if (isElement(c) && localName(c) === 'title') return collapseWs(c.textContent ?? '')
  }
  const nested = svg.querySelector('title')
  if (nested) return collapseWs(nested.textContent ?? '')
  const label = svg.getAttribute('aria-label')
  if (label) return collapseWs(label)
  const by = svg.getAttribute('aria-labelledby')
  if (by) {
    const doc = svg.ownerDocument
    const parts = by.split(/\s+/).map((id) => collapseWs(doc.getElementById(id)?.textContent ?? '')).filter(Boolean)
    if (parts.length) return parts.join(' ')
  }
  return ''
}

/** 属性里的长度：`120` / `120px` → 120；百分比或缺失 → NaN */
function attrLength(el: Element, name: string): number {
  const raw = el.getAttribute(name)?.trim() ?? ''
  if (!raw || raw.endsWith('%')) return NaN
  return parseFloat(raw)
}

/** 独立 svg 的尺寸判定：width/height 属性优先，缺失时取 viewBox 的宽高，两者均 ≥48 才算「图」 */
function svgBigEnough(svg: Element): boolean {
  const vb = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  const vbW = vb.length === 4 ? vb[2] : NaN
  const vbH = vb.length === 4 ? vb[3] : NaN
  const w = attrLength(svg, 'width')
  const h = attrLength(svg, 'height')
  const width = Number.isFinite(w) ? w : vbW
  const height = Number.isFinite(h) ? h : vbH
  return width >= 48 && height >= 48
}

function visitImg(ctx: Ctx, img: Element): void {
  const w = attrLength(img, 'width')
  const h = attrLength(img, 'height')
  // 1×1 追踪像素：不出块
  if (Number.isFinite(w) && Number.isFinite(h) && w <= 1 && h <= 1) return
  const alt = collapseWs(img.getAttribute('alt') ?? '')
  const src = (img.getAttribute('src') ?? '').trim()
  emit(ctx, img, 'image', alt ? `[图: ${alt}]` : '[图]', /^https:/i.test(src) ? { src } : undefined)
}

function visitSvg(ctx: Ctx, svg: Element): void {
  if (!svg.closest('figure') && !svgBigEnough(svg)) return
  const label = svgLabel(svg)
  emit(ctx, svg, 'image', label ? `[图: ${label}]` : '[图]')
}

/** 未成块的行内串里找媒体：img → image 块，svg → 独立 svg 判定；不进数学原子与不透明元素 */
function visitMedia(ctx: Ctx, node: Node): void {
  if (!isElement(node) || node.matches(SKIP_SELECTOR)) return
  const tag = localName(node)
  if (tag === 'img') return visitImg(ctx, node)
  if (tag === 'svg') return visitSvg(ctx, node)
  if (isMathAtom(node) || OPAQUE_TAGS.has(tag)) return
  for (let c = node.firstChild; c; c = c.nextSibling) visitMedia(ctx, c)
}

/** 布局表格（role=presentation / 内含标题或嵌套表格）按容器下探，否则整表一个 table 块 */
const isLayoutTable = (table: Element): boolean =>
  table.getAttribute('role') === 'presentation' || table.querySelector('h1, h2, h3, h4, h5, h6, table') !== null

function visitTable(ctx: Ctx, table: Element): void {
  const inner = table.innerHTML
  const text = tableToText(inner)
  // 与 normalizeHtml 的表格分支同一宽容度：无文本但有图的表格仍保留（html 承载结构）
  if (!text && !table.querySelector('img')) return
  emit(ctx, table, 'table', text, { html: sanitizeArticleHtml(`<table>${inner}</table>`) })
}

/** 块级子节点分发：跳过集 → 表格 → 不透明元素 → 普通容器 */
function visitBlock(ctx: Ctx, el: Element): void {
  if (el.matches(SKIP_SELECTOR)) return
  const tag = localName(el)
  if (tag === 'table') {
    if (isLayoutTable(el)) visitContainer(ctx, el)
    else visitTable(ctx, el)
    return
  }
  if (OPAQUE_TAGS.has(tag)) return
  visitContainer(ctx, el)
}

const isBlankText = (n: Node): boolean => isText(n) && !/\S/.test(n.data)

/**
 * 一段最大连续行内串：够格则包进 `<span data-pc-run>`（run 只有一个 span/a 元素时直接打在它身上）；
 * 不够格则原样不动，只从中捞图。首尾纯空白文本节点留在包裹之外（少改 DOM，规整后也不计入原文）。
 */
function processRun(ctx: Ctx, parent: Element, nodes: Node[], info: KindInfo): void {
  let s = 0
  let e = nodes.length
  while (s < e && isBlankText(nodes[s])) s++
  while (e > s && isBlankText(nodes[e - 1])) e--
  const core = nodes.slice(s, e)
  if (!core.length) return

  const visible = collapseWs(core.map(visibleTextOf).join(''))
  if (!eligible(ctx, visible, info)) {
    for (const n of core) visitMedia(ctx, n)
    return
  }

  const only = core.length === 1 ? core[0] : null
  let host: Element
  if (only && isElement(only) && DIRECT_STAMP_TAGS.has(localName(only))) {
    host = only
  } else {
    host = parent.ownerDocument.createElement('span')
    host.setAttribute(RUN_ATTR, '')
    parent.insertBefore(host, core[0])
    for (const n of core) host.appendChild(n)
  }
  stampText(ctx, host, info)
}

/**
 * 容器处理：
 * - 子节点全为行内且容器有 kind → 直接在容器上打标（DOM 零改动）；不够格则只捞图；
 * - 否则（混合容器，或 body/ul/details 这类无 kind 的容器）→ 行内串按 run 处理、块级子元素递归。
 *   run 的 kind/阈值随容器：语义容器（li/h2/p/…）的 run 继承其 kind 与 level、只需 1 个字母
 *   （`<li>水果<ul>…</ul></li>` 的「水果」、`<h2><div class=anchor></div>标题</h2>` 的标题都不能丢）；
 *   泛型/无 kind 容器的 run 落 paragraph，需 ≥ minGenericChars。
 */
function visitContainer(ctx: Ctx, el: Element): void {
  const info = kindOf(el)
  const children = Array.from(el.childNodes)
  const mixed = children.some((c) => isElement(c) && !isInline(ctx, c))

  if (!mixed && info) {
    if (eligible(ctx, collapseWs(visibleTextOf(el)), info)) stampText(ctx, el, info)
    else for (const c of children) visitMedia(ctx, c)
    return
  }

  const runInfo: KindInfo = info?.semantic ? info : { kind: 'paragraph', semantic: false }
  let run: Node[] = []
  const flush = (): void => {
    if (run.length) processRun(ctx, el, run, runInfo)
    run = []
  }
  for (const c of children) {
    if (isElement(c) && !isInline(ctx, c)) {
      flush()
      visitBlock(ctx, c)
    } else {
      run.push(c)
    }
  }
  flush()
}

/**
 * 单次 body 文档序遍历：就地打标并返回块列表（无 id/paperId，由仓储补齐）。
 * 空文本且无 html/src 的候选不出块也不打标；索引 = 数组下标 = `data-pc-block` 值。
 */
export function stampBlocks(doc: Document, opts: StampOptions = {}): NormalizedBlock[] {
  const body = doc.body
  if (!body) return []
  unstamp(doc)
  const ctx: Ctx = {
    blocks: [],
    section: '',
    minGeneric: opts.minGenericChars ?? DEFAULT_MIN_GENERIC_CHARS,
    inlineMemo: new Map(),
  }
  visitContainer(ctx, body)
  return ctx.blocks
}
