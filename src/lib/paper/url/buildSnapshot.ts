import { IngestError } from '../ingest'
import type { NormalizedBlock, PaperSource } from '../types'
import { isAbortError, throwIfAborted } from './abort'
import { SHEET_ATTR, captureDocument, captureStatic, type CapturedDocument } from './captureStatic'
import { absolutizeCssUrls, collectCssRefs, escapeCssForMarkup, inlineImports, substituteCssAssets, toHttpUrl } from './cssRewrite'
import { sanitizeFidelityDocumentHtml } from './fidelitySanitize'
import { fetchAssets, shouldProxyFont, type AssetCaps, type AssetPlanItem, type FetchedAsset } from './snapshotAssets'
import { STAMP_ATTR, hostText, stampBlocks } from './stampBlocks'
import { MAX_SNAPSHOT_HTML_BYTES, encodeWebSnapshot, type SnapshotSkipped, type WebSnapshotHeader } from './webSnapshot'

/**
 * 网页原貌快照的编排（PLAN-web-snapshot-sync.md §2.2 第 4 条）：
 *
 *   Tier 2 渲染捕获（可选，失败回退）→ DOMParser + preprocessFidelity → 外部样式表抓取并内联
 *   （@import ≤2 层）→ 资源计划（图片按文档序 → 同站字体）→ fetchAssets → CSS 占位替换 + `\3c ` 转义、
 *   img 标 data-pc-asset → stampBlocks → sanitizeFidelityDocumentHtml → 重解析复核每个文本块的
 *   hostText 不变式 → encodeWebSnapshot。
 *
 * 浏览器 only（DOMParser / DOMPurify）；网络全部经注入的 fetchAsset，happy-dom + 假抓取可测。
 * 渲染捕获（captureRendered）也是注入的：本模块不知道 iframe 的存在，Tier 2 缺席或抛错一律
 * 走静态路径，并把原因带回（renderFallback）供日志/报告。
 */

export type SnapshotPhase = 'rendering' | 'sanitizing' | 'assets' | 'packing'

/** Tier 2 捕获结果的最小形状（captureRendered.ts 的返回值满足它即可，本模块不依赖那个文件） */
export interface RenderedCaptureLike {
  html: string
  title: string
  finalUrl: string
  viewportWidth: number
  /** 捕获代理脚本版本；缺省按 1 */
  agentVersion?: number
}

export interface BuildSnapshotDeps {
  fetchAsset: (url: string, signal?: AbortSignal) => Promise<{ bytes: ArrayBuffer; contentType: string }>
  hash: (bytes: ArrayBuffer) => Promise<string>
  /** Tier 2；缺省 = 只走静态。任何 rejection → 回退静态并记录原因 */
  captureRendered?: (input: { html: string; finalUrl: string }, opts?: { signal?: AbortSignal }) => Promise<RenderedCaptureLike>
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

async function capture(input: BuildSnapshotInput, deps: BuildSnapshotDeps): Promise<{
  captured: CapturedDocument
  viewportWidth: number
  agentVersion: number
  renderFallback?: string
}> {
  if (deps.captureRendered) {
    try {
      const rendered = await deps.captureRendered({ html: input.html, finalUrl: input.finalUrl }, { signal: deps.signal })
      throwIfAborted(deps.signal, ABORT_MESSAGE)
      const captured = await captureDocument({
        html: rendered.html,
        finalUrl: rendered.finalUrl || input.finalUrl,
        title: rendered.title,
        katex: deps.katex,
        mode: 'rendered',
      })
      return { captured, viewportWidth: rendered.viewportWidth, agentVersion: rendered.agentVersion ?? 1 }
    } catch (e) {
      if (isAbortError(e)) throw e
      const reason = e instanceof Error ? e.message : String(e)
      console.warn('[web-snapshot] 渲染捕获失败，回退静态捕获：', reason)
      const captured = await captureStatic({ html: input.html, finalUrl: input.finalUrl, katex: deps.katex })
      return { captured, viewportWidth: STATIC_VIEWPORT_WIDTH, agentVersion: STATIC_AGENT_VERSION, renderFallback: reason }
    }
  }
  const captured = await captureStatic({ html: input.html, finalUrl: input.finalUrl, katex: deps.katex })
  return { captured, viewportWidth: STATIC_VIEWPORT_WIDTH, agentVersion: STATIC_AGENT_VERSION }
}

export async function buildWebSnapshot(input: BuildSnapshotInput, deps: BuildSnapshotDeps): Promise<BuildSnapshotResult> {
  const { onPhase, signal } = deps
  throwIfAborted(signal, ABORT_MESSAGE)

  onPhase?.('rendering')
  const { captured, viewportWidth, agentVersion, renderFallback } = await capture(input, deps)
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
  if (totalChars < MIN_TOTAL_CHARS) {
    throw new IngestError('empty', '页面依赖脚本渲染，原貌抓取未得到正文；可改用「阅读模式」重试')
  }
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
