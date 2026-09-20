import { IngestError } from '../ingest'
import type { NormalizedBlock, PaperSource } from '../types'
import { isAbortError, throwIfAborted } from './abort'
import { CAPTURE_AGENT_VERSION } from './captureAgent'
import { SHEET_ATTR, captureDocument, captureStatic, type CapturedDocument } from './captureStatic'
import { absolutizeCssUrls, collectCssRefs, escapeCssForMarkup, inlineImports, substituteCssAssets, toHttpUrl } from './cssRewrite'
import { sanitizeFidelityDocumentHtml } from './fidelitySanitize'
import { fetchAssets, shouldProxyFont, type AssetCaps, type AssetPlanItem, type FetchedAsset } from './snapshotAssets'
import { HIDDEN_ATTR, STAMP_ATTR, hostText, stampBlocks } from './stampBlocks'
import { MAX_SNAPSHOT_HTML_BYTES, encodeWebSnapshot, type SnapshotSkipped, type WebSnapshotHeader } from './webSnapshot'

/**
 * 网页原貌快照的编排（PLAN-web-snapshot-sync.md §2.2 第 4 条）：
 *
 *   Tier 2 渲染捕获（可选，失败回退）→ 与静态产物公平对照、谁好用谁（chooseCapture）→ 仍不到正文下限
 *   且注入了 Tier 3（服务器渲染）才去试它 → DOMParser + preprocessFidelity → 外部样式表抓取并内联
 *   （@import ≤2 层）→ 资源计划（图片按文档序 → 同站字体）→ fetchAssets → CSS 占位替换 + `\3c ` 转义、
 *   img 标 data-pc-asset → stampBlocks → sanitizeFidelityDocumentHtml → 重解析复核每个文本块的
 *   hostText 不变式 → encodeWebSnapshot。
 *
 * 浏览器 only（DOMParser / DOMPurify）；网络全部经注入的 fetchAsset，happy-dom + 假抓取可测。
 * 渲染捕获（captureRendered / captureRemote）也是注入的：本模块不知道 iframe 或渲染服务的存在，
 * Tier 2 缺席或抛错一律走静态路径，并把原因带回（renderFallback）供日志/报告。
 */

export type SnapshotPhase = 'rendering' | 'remote' | 'sanitizing' | 'assets' | 'packing'

/** Tier 2 / Tier 3 捕获结果的最小形状（captureRendered.ts 的返回值满足它即可，本模块不依赖那个文件） */
export interface RenderedCaptureLike {
  html: string
  title: string
  finalUrl: string
  viewportWidth: number
  /** 捕获代理脚本版本；缺省按当前版本（注入方没报版本，只能当它跑的就是眼下这份代理） */
  agentVersion?: number
  /**
   * 捕获期间加载失败的外链脚本数（代理 v2 起），缺省按 0。什么原因的失败都计入（广告拦截、CSP、404…），
   * 单看它 > 0 说明不了「被跨源策略拦了」——只有和「渲染、静态两边都没正文」一起出现才算数。
   */
  blockedScripts?: number
}

export interface BuildSnapshotDeps {
  fetchAsset: (url: string, signal?: AbortSignal) => Promise<{ bytes: ArrayBuffer; contentType: string }>
  hash: (bytes: ArrayBuffer) => Promise<string>
  /** Tier 2；缺省 = 只走静态。任何 rejection → 回退静态并记录原因 */
  captureRendered?: (
    input: { html: string; finalUrl: string },
    opts?: { signal?: AbortSignal; config?: { minTextChars?: number } },
  ) => Promise<RenderedCaptureLike>
  /**
   * Tier 3：服务器无头浏览器渲染（PLAN-url-import-csr-render.md §4 B5）；缺省 = 没有这一层，行为与从前完全一致。
   * 只在 Tier 2 / 静态的胜出者仍不到正文下限时才会被调用——能在本地免费解决的页面一次都不该打到服务器。
   * 它在真实源下自己加载页面，所以入参是 URL 而不是已抓回的 HTML；产物与 Tier 2 同形，照样按
   * mode='rendered' 处理（webSnapshot.ts 只认 rendered/static，旧客户端还要能解码同步过去的快照）。
   */
  captureRemote?: (input: { url: string; finalUrl: string }, opts?: { signal?: AbortSignal }) => Promise<RenderedCaptureLike>
  /** 是否尝试 KaTeX auto-render（静态路径；渲染路径下页面已有公式时自动跳过） */
  katex?: boolean
  caps?: Partial<AssetCaps>
  onPhase?: (phase: SnapshotPhase, detail?: { done: number; total: number }) => void
  signal?: AbortSignal
  /** 429 退避的等待实现（测试注入） */
  sleep?: (ms: number) => Promise<void>
}

export interface BuildSnapshotInput {
  /** 用户粘贴的原始 URL */
  url: string
  /** 已解码的页面 HTML */
  html: string
  /** 抓取落地 URL */
  finalUrl: string
}

export interface BuildSnapshotResult {
  bytes: ArrayBuffer
  header: WebSnapshotHeader
  /** 随 papers 行同步的捕获摘要（PaperSource.capture） */
  capture: NonNullable<PaperSource['capture']>
  /** Tier 2 被尝试但失败、最终走静态路径时的原因 */
  renderFallback?: string
}

/** 全文（所有块 text 之和）低于此值判「未得到正文」 */
const MIN_TOTAL_CHARS = 200
/**
 * 渲染产物「可疑」的字数线：低于它无条件拿一份静态产物来对照。
 * 高于它的，要廉价口径（rawTextLength）也显示静态多出一倍才对照——正常导入不多付一次静态捕获。
 */
const RENDER_SUSPECT_CHARS = MIN_TOTAL_CHARS * 5
/** 静态产物要比渲染产物多这么多倍，才认定渲染退化、改用静态（廉价口径的触发线也用它） */
const RENDER_DEGRADED_RATIO = 2
/** `@import` 拉平深度：页面样式表 → 一层 → 两层；再深的保留为绝对 `@import` */
const MAX_IMPORT_DEPTH = 2
/** 静态路径没有视口概念 */
const STATIC_VIEWPORT_WIDTH = 0
const STATIC_AGENT_VERSION = 0

const ABORT_MESSAGE = '原貌抓取已取消'

const unique = (urls: string[]): string[] => Array.from(new Set(urls))

// ---------------------------------------------------------------------------
// 样式表：抓取（经 fetchAssets，享同一套重试/类型/配额）→ 绝对化 → @import 拉平
// ---------------------------------------------------------------------------

interface Ctx {
  deps: BuildSnapshotDeps
  /** 样式表文本缓存：null = 抓不到（已记入 skipped），同一 URL 不重复抓 */
  cssCache: Map<string, string | null>
  skipped: SnapshotSkipped[]
}

function decodeCss(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

async function loadCssTexts(urls: string[], ctx: Ctx): Promise<Map<string, string | null>> {
  const fresh = urls.filter((u) => !ctx.cssCache.has(u))
  if (fresh.length) {
    const { fetched, skipped } = await fetchAssets(
      fresh.map((url): AssetPlanItem => ({ url, kind: 'css' })),
      { fetchAsset: ctx.deps.fetchAsset, hash: ctx.deps.hash, caps: ctx.deps.caps, signal: ctx.deps.signal, sleep: ctx.deps.sleep },
    )
    for (const f of fetched) ctx.cssCache.set(f.url, decodeCss(f.bytes))
    for (const s of skipped) {
      ctx.skipped.push(s)
      ctx.cssCache.set(s.url, null)
    }
    for (const u of fresh) if (!ctx.cssCache.has(u)) ctx.cssCache.set(u, null)
  }
  return new Map(urls.map((u) => [u, ctx.cssCache.get(u) ?? null]))
}

/**
 * 一张样式表的文本：按**它自己的地址**绝对化，再把 `@import` 拉平（子表递归同样处理，深度受限）。
 * 抓不到的 `@import` 保留绝对形式——阅读器里仍可远程加载（Google Fonts 就是这种，其 gstatic 带 ACAO:*）。
 */
async function resolveSheet(css: string, sheetUrl: string, depth: number, ctx: Ctx): Promise<string> {
  const text = absolutizeCssUrls(css, sheetUrl)
  if (depth >= MAX_IMPORT_DEPTH) return text
  const imports = collectCssRefs(text, sheetUrl).filter((r) => r.kind === 'import')
  if (!imports.length) return text
  const urls = unique(imports.map((r) => r.abs))
  const texts = await loadCssTexts(urls, ctx)
  const resolved = new Map<string, string>()
  for (const u of urls) {
    const t = texts.get(u)
    if (t !== null && t !== undefined) resolved.set(u, await resolveSheet(t, u, depth + 1, ctx))
  }
  return inlineImports(text, (target) => {
    const abs = toHttpUrl(target, sheetUrl)
    return abs ? (resolved.get(abs) ?? null) : null
  })
}

/** `link[data-pc-sheet]` → `<style data-pc-sheet="<href>" media?>`；抓不到的变成 `<style>` 内的绝对 `@import` */
async function inlineStylesheets(doc: Document, ctx: Ctx): Promise<void> {
  const links = Array.from(doc.querySelectorAll(`link[${SHEET_ATTR}]`))
  if (!links.length) return
  const hrefs = links.map((l) => l.getAttribute('href') ?? '').filter((h) => /^https?:/i.test(h))
  const texts = await loadCssTexts(unique(hrefs), ctx)
  for (const link of links) {
    const href = link.getAttribute('href') ?? ''
    if (!/^https?:/i.test(href)) {
      link.remove()
      continue
    }
    const style = doc.createElement('style')
    style.setAttribute(SHEET_ATTR, href)
    const media = link.getAttribute('media')
    if (media) style.setAttribute('media', media)
    const css = texts.get(href)
    style.textContent = css === null || css === undefined ? `@import url("${href}");` : await resolveSheet(css, href, 0, ctx)
    link.replaceWith(style)
  }
}

/** 内联 `<style>`（含 svg 内的）按页面基准绝对化 + 拉平 @import；`style` 属性只绝对化（阅读器不水合属性） */
async function resolveInlineStyles(doc: Document, baseUrl: string, ctx: Ctx): Promise<void> {
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    if (style.hasAttribute(SHEET_ATTR)) continue
    const css = style.textContent ?? ''
    if (!css.trim()) continue
    style.textContent = await resolveSheet(css, baseUrl, 0, ctx)
  }
  for (const el of Array.from(doc.querySelectorAll('[style]'))) {
    const v = el.getAttribute('style') ?? ''
    if (!/url\s*\(/i.test(v)) continue
    const abs = absolutizeCssUrls(v, baseUrl)
    if (abs !== v) el.setAttribute('style', abs)
  }
}

// ---------------------------------------------------------------------------
// 资源计划 / 占位替换
// ---------------------------------------------------------------------------

/** 元素上承载图片 URL 的属性名：img → src；svg image → href / xlink:href；任何带 poster 的 → poster */
function imageAttrOf(el: Element): string | null {
  const tag = el.localName.toLowerCase()
  if (tag === 'img') return 'src'
  if (tag === 'image') return el.hasAttribute('href') ? 'href' : el.hasAttribute('xlink:href') ? 'xlink:href' : null
  if (el.hasAttribute('poster')) return 'poster'
  return null
}

const IMAGE_SELECTOR = 'img[src], [poster], image, style'

/** 图片按文档序（img/poster/svg image 与 CSS 非字体 url() 交错在遇到的位置）→ 同站字体 */
function planAssets(doc: Document, baseUrl: string, finalUrl: string): AssetPlanItem[] {
  const images: AssetPlanItem[] = []
  const fonts: string[] = []
  for (const el of Array.from(doc.querySelectorAll(IMAGE_SELECTOR))) {
    if (el.localName.toLowerCase() === 'style') {
      for (const r of collectCssRefs(el.textContent ?? '', baseUrl)) {
        if (r.kind !== 'url') continue
        if (r.isFont) fonts.push(r.abs)
        else images.push({ url: r.abs, kind: 'image' })
      }
      continue
    }
    const attr = imageAttrOf(el)
    if (!attr) continue
    const abs = toHttpUrl(el.getAttribute(attr) ?? '', baseUrl)
    if (abs) images.push({ url: abs, kind: 'image' })
  }
  const fontItems = unique(fonts)
    .filter((u) => shouldProxyFont(u, finalUrl))
    .map((url): AssetPlanItem => ({ url, kind: 'font' }))
  return [...images, ...fontItems]
}

/** 已固化的资源：CSS 里换占位 + `\3c ` 转义；img/poster/svg image 加 data-pc-asset（src 保留原 URL 作兜底） */
function applyAssets(doc: Document, baseUrl: string, fetched: FetchedAsset[]): void {
  const idByUrl = new Map(fetched.map((a) => [a.url, a.id]))
  const tokenFor = (target: string): string | null => {
    const abs = toHttpUrl(target, baseUrl)
    return abs ? (idByUrl.get(abs) ?? null) : null
  }
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    style.textContent = escapeCssForMarkup(substituteCssAssets(style.textContent ?? '', tokenFor))
  }
  for (const el of Array.from(doc.querySelectorAll('img[src], [poster], image'))) {
    const attr = imageAttrOf(el)
    if (!attr) continue
    const abs = toHttpUrl(el.getAttribute(attr) ?? '', baseUrl)
    const id = abs ? idByUrl.get(abs) : undefined
    if (id) el.setAttribute('data-pc-asset', id)
  }
}

// ---------------------------------------------------------------------------
// sanitize 后复核
// ---------------------------------------------------------------------------

const isTextBlock = (b: NormalizedBlock): boolean => b.kind !== 'table' && b.kind !== 'image'

/**
 * DOMPurify 可能 unwrap 未知包裹元素、改变空白、甚至删掉某个打标元素。以 sanitize 后的 DOM 为准：
 * 文本块重算 text；打标元素消失的块丢弃；随后重编连续索引、重建 anchor.blockIndex 与 section
 * （section = 最近前置标题，标题自身的 section 是它自己——与 stampBlocks 同一规则）。
 * 有块被丢弃时 DOM 上的 `data-pc-block` 也要跟着重编，并以重编后的 DOM 重新序列化。
 */
function reconcileBlocks(sanitizedHtml: string, blocks: NormalizedBlock[]): { html: string; blocks: NormalizedBlock[] } {
  const doc = new DOMParser().parseFromString(sanitizedHtml, 'text/html')
  const kept: { block: NormalizedBlock; el: Element }[] = []
  let dropped = false
  for (const block of blocks) {
    const el = doc.querySelector(`[${STAMP_ATTR}="${block.index}"]`)
    if (!el) {
      dropped = true
      continue
    }
    if (isTextBlock(block)) {
      const text = hostText(el)
      if (text !== block.text) block.text = text
    }
    kept.push({ block, el })
  }

  let section = ''
  const out: NormalizedBlock[] = kept.map(({ block, el }, i) => {
    if (dropped) el.setAttribute(STAMP_ATTR, String(i))
    if (block.kind === 'heading') section = block.text
    const anchor = { ...block.anchor, blockIndex: i }
    if (section) anchor.section = section
    else delete anchor.section
    return { ...block, index: i, anchor }
  })
  return { html: dropped ? doc.documentElement.outerHTML : sanitizedHtml, blocks: out }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 一份捕获产物能出多少正文字符：用 `stampBlocks` 这个唯一口径，免得选路判据和最终的下限检查各算各的。
 *
 * 量的是**克隆**：`stampBlocks` 会就地规整空白、包 `<span data-pc-run>`、打 `data-pc-block`，
 * 而被量的文档稍后要原样进快照——量一下不该改变产物（缺陷 F）。
 *
 * `ignoreHidden`：先撕掉克隆上的 `data-pc-hidden` 再量。渲染产物带着捕获代理按计算样式标出的隐藏标记，
 * `stampBlocks` 整棵跳过；静态产物没有计算样式，隐藏的菜单/弹层照单全收。拿「跳过隐藏的渲染」去比
 * 「不跳隐藏的静态」，静态永远虚高（缺陷 C）——要和静态比大小，渲染这边也得按不跳隐藏来量。
 */
export function measure(doc: Document, opts: { ignoreHidden?: boolean } = {}): number {
  const clone = doc.cloneNode(true) as Document
  if (opts.ignoreHidden) {
    for (const el of Array.from(clone.querySelectorAll(`[${HIDDEN_ATTR}]`))) el.removeAttribute(HIDDEN_ATTR)
  }
  let total = 0
  for (const b of stampBlocks(clone)) total += b.text.length
  return total
}

/** 廉价口径不计文本的子树（与捕获代理 hasContent 的 NO_TEXT_TAGS 同一套） */
const RAW_NO_TEXT_SELECTOR = 'script, style, noscript, template'

/**
 * 廉价口径：HTML 串里 body 的文本总长（空白折叠，免得 SSR 的缩进把静态一侧撑大）。
 * 只用来决定「值不值得做一次完整对照」，不参与选路本身。抓回来的 HTML 与渲染产物用同一个函数量，
 * 隐藏文本两边都计——静态 HTML 里藏着的大菜单在渲染产物里同样在，不会因此触发对照。
 * 一次 DOMParser + textContent，相对 10–30s 的导入可以忽略；贵的是 `captureStatic` + `stampBlocks`。
 */
function rawTextLength(html: string): number {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const el of Array.from(doc.querySelectorAll(RAW_NO_TEXT_SELECTOR))) el.remove()
  return (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim().length
}

/**
 * 渲染 vs 静态，用哪个（纯函数，字数均为 `measure` 口径）：
 * - `rendered`：渲染产物的可见正文（跳过 `data-pc-hidden`）——最终能不能过下限看的就是它；
 * - `renderedRaw`：同一份渲染产物、不跳隐藏——只用来和 `static` 比倍数（同口径，见 measure 的注释）；
 * - `static`：静态产物。
 *
 * 静态自己都不到下限 → 换了也白换，留渲染；渲染不到下限而静态够 → 静态（旧判据在这里有个死区：
 * 渲染 150 / 静态 250 不满足「静态 ≥ 2× 渲染」，于是留着渲染一路失败，而静态本来能成——缺陷 D）；
 * 两边都够 → 静态要多出 RENDER_DEGRADED_RATIO 倍才认定渲染退化。
 */
export function chooseCapture(chars: { rendered: number; renderedRaw: number; static: number }): 'rendered' | 'static' {
  const { rendered, renderedRaw, static: staticChars } = chars
  if (staticChars < MIN_TOTAL_CHARS) return 'rendered'
  if (rendered < MIN_TOTAL_CHARS) return 'static'
  return staticChars >= renderedRaw * RENDER_DEGRADED_RATIO ? 'static' : 'rendered'
}

/** capture() 的产出：胜出的文档 + 快照头要的元数据 + 选路时量到的事实（只给最终的下限检查挑文案 / hint 用） */
interface CaptureOutcome {
  captured: CapturedDocument
  viewportWidth: number
  agentVersion: number
  /** Tier 2 试过、最终却用了静态产物的原因（抛错 / 退化） */
  renderFallback?: string
  /** Tier 2 产物的可见正文字数；Tier 2 缺席或抛错 = undefined */
  renderedChars?: number
  /** 静态产物的字数；没量过（渲染健康，用不着对照）= undefined */
  staticChars?: number
  /** Tier 2 期间加载失败的外链脚本数；含义见 RenderedCaptureLike.blockedScripts */
  blockedScripts: number
  /** Tier 3 被采用时它的字数（采用的前提就是过了下限） */
  remoteChars?: number
  /** Tier 3 试过但没被采用的原因 */
  remoteFailure?: string
}

/**
 * CaptureError 的结构化 reason（timeout / too-large / agent-error / unavailable）以前被
 * e.message 抹平，生产上只能靠中文散文猜是哪种失败——带上它，下次复发一眼能定位。
 */
function describeError(e: unknown): string {
  const kind = typeof (e as { reason?: unknown } | null)?.reason === 'string' ? `${(e as { reason: string }).reason}: ` : ''
  return `${kind}${e instanceof Error ? e.message : String(e)}`
}

/** 本地两层：Tier 2 渲染捕获（与静态公平对照）→ Tier 1 静态捕获 */
async function captureLocal(input: BuildSnapshotInput, deps: BuildSnapshotDeps): Promise<CaptureOutcome> {
  const staticCapture = (katex: boolean | undefined): Promise<CapturedDocument> =>
    captureStatic({ html: input.html, finalUrl: input.finalUrl, katex })
  const asStatic = (captured: CapturedDocument): Pick<CaptureOutcome, 'captured' | 'viewportWidth' | 'agentVersion'> => ({
    captured,
    viewportWidth: STATIC_VIEWPORT_WIDTH,
    agentVersion: STATIC_AGENT_VERSION,
  })

  if (deps.captureRendered) {
    try {
      /**
       * 捕获代理 v2 会为一张白纸陪等 `emptyWaitCapMs`（10s），赌的是「正文稍后由脚本渲染出来」。
       * 这个赌只在抓回来的 HTML 本身是空壳（CSR）时才成立。HTML 自己就有正文（SSR）而渲染出白纸，
       * 只可能是沙箱把站点 JS 弄坏了——等多久都不会有字，而静态产物必定兜得住，白等的 10s 全是用户的。
       * 实测 minimax.io：渲染 0 字 → 静态 10,432 字，结果一样，导入却从 18s 拖到 29s。
       * 所以 HTML 有正文时把内容感知关掉（minTextChars: 0 = v1 行为）；渲染健康的页面首个静默 tick
       * 就满足 hasContent，开不开都一样，这里只改变「渲染是白纸」那一支的等待时长。
       */
      const staticRaw = rawTextLength(input.html)
      const rendered = await deps.captureRendered(
        { html: input.html, finalUrl: input.finalUrl },
        staticRaw >= MIN_TOTAL_CHARS ? { signal: deps.signal, config: { minTextChars: 0 } } : { signal: deps.signal },
      )
      throwIfAborted(deps.signal, ABORT_MESSAGE)
      const captured = await captureDocument({
        html: rendered.html,
        finalUrl: rendered.finalUrl || input.finalUrl,
        title: rendered.title,
        katex: deps.katex,
        mode: 'rendered',
      })
      const renderedChars = measure(captured.doc)
      const kept: CaptureOutcome = {
        captured,
        viewportWidth: rendered.viewportWidth,
        agentVersion: rendered.agentVersion ?? CAPTURE_AGENT_VERSION,
        renderedChars,
        blockedScripts: rendered.blockedScripts ?? 0,
      }
      /**
       * 渲染产物健全性检查：**跑站点 JS 有可能比不跑更糟**。
       *
       * 实测 openai.com 的文章页：SSR 的 HTML 里正文完好（静态口径 106 块 / 15,920 字），
       * 但在 `sandbox="allow-scripts"` 的不透明源里，站点 JS 一上来就 `SecurityError`、
       * `load` 事件永不触发，最终捕获到的是一份近乎空白的文档。Tier 2 **没有抛错**，
       * 于是旧代码原样采信，一路到「未得到正文」才炸——而同一份 HTML 走静态必定成功。
       *
       * 所以这里不无条件相信 Tier 2。什么时候对照：字数可疑（< RENDER_SUSPECT_CHARS）必对照；
       * 字数不少的也可能只是导航 + 页脚（沙箱里正文没渲染出来，1,200 字对静态 50,000 字——缺陷 E），
       * 所以再用廉价口径看一眼，静态多出一倍才对照。健康页面到此为止，不付静态捕获的钱。
       */
      if (renderedChars >= RENDER_SUSPECT_CHARS && staticRaw < rawTextLength(rendered.html) * RENDER_DEGRADED_RATIO) {
        return kept
      }
      throwIfAborted(deps.signal, ABORT_MESSAGE)
      // 对照用的静态产物先不跑 KaTeX：多数时候它只是陪跑，真用上了再按调用方的 katex 选项重做，免得白付一次
      const probe = await staticCapture(false)
      const staticChars = measure(probe.doc)
      // 撕掉隐藏标记会改变容器的行内/块级划分，极端情况下反而量得更少；取大者，保证倍数这条判据不会比旧的（拿可见字数去比）更爱换静态
      const renderedRaw = Math.max(renderedChars, measure(captured.doc, { ignoreHidden: true }))
      if (chooseCapture({ rendered: renderedChars, renderedRaw, static: staticChars }) === 'rendered') return { ...kept, staticChars }

      const reason = `渲染捕获退化（渲染 ${renderedChars} 字 < 静态 ${staticChars} 字），改用静态捕获`
      console.warn('[web-snapshot]', reason)
      return {
        ...asStatic(deps.katex ? await staticCapture(deps.katex) : probe),
        renderFallback: reason,
        renderedChars,
        staticChars,
        blockedScripts: kept.blockedScripts,
      }
    } catch (e) {
      if (isAbortError(e)) throw e
      const reason = describeError(e)
      console.warn('[web-snapshot] 渲染捕获失败，回退静态捕获：', reason)
      const captured = await staticCapture(deps.katex)
      // 代理的失败消息里也带 blockedScripts，但 CaptureError 不往外带；抛错一律按 0，文案走「未取得文字」那条
      return { ...asStatic(captured), renderFallback: reason, staticChars: measure(captured.doc), blockedScripts: 0 }
    }
  }
  const captured = await staticCapture(deps.katex)
  return { ...asStatic(captured), staticChars: measure(captured.doc), blockedScripts: 0 }
}

/** 胜出产物在选路时量到的字数：rendered 看渲染、static 看静态（captureLocal 的每条出路都量过胜出者） */
const winnerChars = (o: CaptureOutcome): number => (o.captured.mode === 'rendered' ? o.renderedChars : o.staticChars) ?? 0

/** 「渲染 N 字 / 静态 M 字」：量过哪个写哪个，失败文案与日志共用的排障面包屑 */
function describeChars(o: CaptureOutcome): string {
  const parts: string[] = []
  if (o.renderedChars !== undefined) parts.push(`渲染 ${o.renderedChars} 字`)
  if (o.staticChars !== undefined) parts.push(`静态 ${o.staticChars} 字`)
  return parts.join(' / ')
}

/**
 * 本地两层 → 仍不到正文下限且注入了 Tier 3 → 服务器渲染。
 *
 * Tier 3 的产物与 Tier 2 同样走 `captureDocument({ mode: 'rendered' })`，**只有过了下限才采用**；
 * 抛错（非取消）或仍不到下限都退回本地的结果，把原因带给最终的失败文案——它是锦上添花，
 * 不该让一次本来就要失败的导入换一种更难懂的方式失败。没注入 captureRemote 时这里就是 captureLocal。
 */
async function capture(input: BuildSnapshotInput, deps: BuildSnapshotDeps): Promise<CaptureOutcome> {
  const local = await captureLocal(input, deps)
  if (!deps.captureRemote || winnerChars(local) >= MIN_TOTAL_CHARS) return local

  throwIfAborted(deps.signal, ABORT_MESSAGE)
  deps.onPhase?.('remote')
  console.warn('[web-snapshot]', `本地捕获未取得正文（${describeChars(local)}），改用服务器渲染`)
  try {
    const remote = await deps.captureRemote({ url: input.url, finalUrl: input.finalUrl }, { signal: deps.signal })
    throwIfAborted(deps.signal, ABORT_MESSAGE)
    const captured = await captureDocument({
      html: remote.html,
      finalUrl: remote.finalUrl || input.finalUrl,
      title: remote.title,
      katex: deps.katex,
      mode: 'rendered',
    })
    const remoteChars = measure(captured.doc)
    if (remoteChars < MIN_TOTAL_CHARS) {
      const reason = `只得到 ${remoteChars} 字正文`
      console.warn('[web-snapshot] 服务器渲染未被采用：', reason)
      return { ...local, remoteFailure: reason }
    }
    // renderFallback 说的是「最终走了静态」，Tier 3 胜出就不成立了；本地两层量到的字数留着，出事时仍是线索
    return {
      ...local,
      captured,
      viewportWidth: remote.viewportWidth,
      agentVersion: remote.agentVersion ?? CAPTURE_AGENT_VERSION,
      renderFallback: undefined,
      remoteChars,
    }
  } catch (e) {
    if (isAbortError(e)) throw e
    const reason = describeError(e)
    console.warn('[web-snapshot] 服务器渲染失败：', reason)
    return { ...local, remoteFailure: reason }
  }
}

/**
 * 最终正文不到下限时的失败：说清哪条路、拿到多少字（下次复发照着这行就能定位），
 * 并如实告诉 UI「改用阅读模式重试」有没有意义。
 *
 * 阅读模式吃的是同一份抓回来的 HTML、同样不跑脚本、同样有 200 字下限——静态口径都不到下限，
 * 而渲染也试过了、同样没有，它就必然再失败一次：给 `reader-wont-help`，弹窗据此收起重试按钮（缺陷 B）。
 * 静态够下限（正文是在 sanitize 之后才丢的，或根本没量过静态）时绝不给这个 hint——阅读模式可能真能成。
 * 没试过任何渲染（Tier 2、Tier 3 都没注入）也不给：没有证据说正文是脚本生成的，别一口咬定。
 */
function emptyCaptureError(totalChars: number, o: CaptureOutcome): IngestError {
  const { captured, renderFallback, renderedChars, staticChars, blockedScripts, remoteChars, remoteFailure } = o
  const remoteNote = remoteFailure ?? (remoteChars !== undefined ? `捕获到 ${remoteChars} 字，净化后只剩 ${totalChars} 字` : undefined)
  const remote = remoteNote ? `；服务器渲染：${remoteNote}` : ''

  const renderTried = renderedChars !== undefined || renderFallback !== undefined || remoteNote !== undefined
  const noStaticText = staticChars !== undefined && staticChars < MIN_TOTAL_CHARS
  const noRenderedText = renderedChars === undefined || renderedChars < MIN_TOTAL_CHARS
  if (renderTried && noStaticText && noRenderedText) {
    const threw = renderedChars === undefined && renderFallback ? `，渲染捕获失败：${renderFallback}` : ''
    const facts = `${describeChars(o)}${threw}`
    // blockedScripts 什么原因的加载失败都计，单独看不说明问题；页面两头都是空的时候，它才是「入口脚本被拦」的实证。
    // 没有这个实证时「由脚本生成」只是推断（也可能是登录墙、纯图片页），文案里先摆事实、推断放括号
    const message =
      blockedScripts > 0
        ? `该页面正文完全由脚本生成，且其脚本被浏览器跨源策略拦截；阅读模式同样无法抓取（${facts}，${blockedScripts} 个脚本加载失败）`
        : `抓回的 HTML 里没有正文（应由脚本生成），渲染捕获也未取得文字；阅读模式同样无法抓取（${facts}）`
    return new IngestError('empty', `${message}${remote}`, { hint: 'reader-wont-help' })
  }

  // 别再一口咬定「依赖脚本渲染」：静态与渲染两条路都可能走到这里（比如正文是 sanitize 之后才丢的）。
  // Tier 3 只在本地两层都不到下限时才会被试，那种情况必然落在上面的分支，所以这里不用带 remote
  const how = renderFallback ? `静态捕获（${renderFallback}）` : `${captured.mode === 'rendered' ? '渲染' : '静态'}捕获`
  return new IngestError('empty', `${how}只得到 ${totalChars} 字正文，未能生成网页原貌；可改用「阅读模式」重试`)
}

export async function buildWebSnapshot(input: BuildSnapshotInput, deps: BuildSnapshotDeps): Promise<BuildSnapshotResult> {
  const { onPhase, signal } = deps
  throwIfAborted(signal, ABORT_MESSAGE)

  onPhase?.('rendering')
  const outcome = await capture(input, deps)
  const { captured, viewportWidth, agentVersion, renderFallback } = outcome
  const { doc, baseUrl, finalUrl, title } = captured
  throwIfAborted(signal, ABORT_MESSAGE)

  const ctx: Ctx = { deps, cssCache: new Map(), skipped: [] }
  onPhase?.('assets')
  await inlineStylesheets(doc, ctx)
  await resolveInlineStyles(doc, baseUrl, ctx)
  throwIfAborted(signal, ABORT_MESSAGE)

  const plan = planAssets(doc, baseUrl, finalUrl)
  const { fetched, skipped } = await fetchAssets(plan, {
    fetchAsset: deps.fetchAsset,
    hash: deps.hash,
    caps: deps.caps,
    signal,
    sleep: deps.sleep,
    onProgress: (done, total) => onPhase?.('assets', { done, total }),
  })
  ctx.skipped.push(...skipped)
  throwIfAborted(signal, ABORT_MESSAGE)

  onPhase?.('sanitizing')
  applyAssets(doc, baseUrl, fetched)
  const stamped = stampBlocks(doc)
  const sanitized = sanitizeFidelityDocumentHtml(doc.documentElement.outerHTML)
  const { html, blocks } = reconcileBlocks(sanitized, stamped)

  let totalChars = 0
  for (const b of blocks) totalChars += b.text.length
  if (totalChars < MIN_TOTAL_CHARS) throw emptyCaptureError(totalChars, outcome)
  if (new TextEncoder().encode(html).byteLength > MAX_SNAPSHOT_HTML_BYTES) {
    throw new IngestError('too-large', '网页原貌超过 8MB，请改用阅读模式')
  }
  throwIfAborted(signal, ABORT_MESSAGE)

  onPhase?.('packing')
  const { bytes, header } = encodeWebSnapshot({
    header: {
      url: input.url,
      finalUrl,
      title,
      capture: { mode: captured.mode, katex: captured.katex, viewportWidth, agentVersion },
      html,
      blocks,
      stats: { assetBytes: 0, skipped: ctx.skipped },
    },
    assets: fetched.map((a) => ({ id: a.id, url: a.url, mime: a.mime, bytes: a.bytes })),
  })

  const result: BuildSnapshotResult = {
    bytes,
    header,
    capture: {
      mode: header.capture.mode,
      assetCount: header.assets.length,
      assetBytes: header.stats.assetBytes,
      skipped: ctx.skipped.length,
      katex: header.capture.katex,
    },
  }
  if (renderFallback) result.renderFallback = renderFallback
  return result
}
