import type { PDFDocument, PDFImage } from 'pdf-lib'
import { sanitizeArticleHtml } from '../sanitize'
import type { PaperBlock } from '../types'
import type { CjkFont, FontkitModule } from './cjkFont'
import { finishDocument, runOps, type PdfLibModule } from './exportPdfInPlace'
import { ExportError, isAbortError, throwIfAborted, type ExportInput } from './exportTypes'
import { buildTextDocChunks, CONTENT_H, paginate, renderTextDoc, TEXT_FLAVOR_NAME } from './textDocPlan'
import { parseTableHtml, type TableModel } from './textDocTables'

/**
 * 文本排版版执行器（PLAN A.6）：表格解析（DOM）+ 图片加载（直取 / 代理，见 classifyImageSrc）→ 纯规划器 → pdf-lib 落笔。
 * 不需要原始文件字节（从不调用 input.getBytes）：原版导出拿不到字节时编排层就回退到这里。
 * 图：8 s 超时、并发 3、单图 ≤ 5 MB、总 ≤ 20 MB；png / jpeg 直接 embedPng / embedJpg，其它（svg / webp / gif）
 * 或嵌入失败 → `<img>` 解码 + canvas（长边 ≤ 1600）→ PNG；失败 → 规划器出虚线占位框。
 */

export const IMAGE_TIMEOUT_MS = 8000
export const IMAGE_CONCURRENCY = 3
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const IMAGE_TOTAL_MAX_BYTES = 20 * 1024 * 1024
export const IMAGE_MAX_EDGE = 1600

export interface LoadedImage {
  bytes: Uint8Array
  mime: string
  format: 'png' | 'jpg' | 'other'
}

/** 按魔数判格式（Content-Type 不可信：代理回传的类型常是 octet-stream） */
export function sniffImageFormat(bytes: Uint8Array): LoadedImage['format'] {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  return 'other'
}

export type ImageRoute = 'direct' | 'proxy' | 'skip'

/** 真实的网页 origin（http / https）；node、file:、about:blank 等 → null */
const realOrigin = (origin: string | null | undefined): URL | null => {
  if (!origin || origin === 'null') return null
  try {
    const u = new URL(origin)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

/**
 * 图片 src 怎么取字节（纯函数，pageOrigin = 当前应用页的 location.origin）：
 * - `data:` / `blob:` → direct：字节就在本地，origin 是 'null'，绝不能发给服务端代理；
 * - 绝对 http(s)：同源 → direct，跨域 → proxy（`<img>` 不需要 CORS，fetch 需要）；
 * - 协议相对 `//host/x`：有真实页面 origin 时借它的协议补全后同上，否则 skip；
 * - 相对路径（`x.png`、`/x.png`）→ skip：导入链路只存绝对地址（URL 导入是 https、DOCX 是 data:），
 *   相对路径的基址早已丢失，按应用 origin 解析只会取到应用自己的页面；
 * - 其它协议（file: / javascript: …）或解析失败 → skip。skip 由规划器出占位框。
 */
export function classifyImageSrc(src: string, pageOrigin: string | null | undefined): ImageRoute {
  return resolveImageSrc(src, pageOrigin).route
}

/** classifyImageSrc + 实际要请求的地址（协议相对已补全；代理只认绝对地址） */
function resolveImageSrc(src: string, pageOrigin: string | null | undefined): { route: ImageRoute; url: string } {
  const s = src.trim()
  const skip = { route: 'skip' as const, url: s }
  if (s === '') return skip
  if (/^(?:data|blob):/i.test(s)) return { route: 'direct', url: s }
  const page = realOrigin(pageOrigin)
  let url: URL
  try {
    if (/^[a-z][a-z\d+.-]*:/i.test(s)) url = new URL(s)
    else if (s.startsWith('//') && page) url = new URL(`${page.protocol}${s}`)
    else return skip
  } catch {
    return skip
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return skip
  return { route: page && url.origin === page.origin ? 'direct' : 'proxy', url: url.href }
}

const currentPageOrigin = (): string | null => (typeof location === 'undefined' ? null : location.origin)

/**
 * 取图字节（路由见 classifyImageSrc）：direct 直接 fetch，proxy 走 fetchUrl 代理（kind: 'asset'，
 * 与 BlockReader 的代理兜底同款），skip → null（占位框）；超时 8 s。
 */
export async function fetchImageBytes(src: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const { route, url } = resolveImageSrc(src, currentPageOrigin())
  if (route === 'skip') return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (route === 'direct') {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? '' }
    }
    const { fetchUrl } = await import('../url/fetchUrlApi')
    const { bytes, contentType } = await fetchUrl(url, { kind: 'asset', signal: controller.signal })
    return { bytes: new Uint8Array(bytes), mime: contentType }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function loadImageForExport(src: string, signal?: AbortSignal): Promise<LoadedImage | null> {
  const got = await fetchImageBytes(src, signal)
  if (!got) return null
  const { bytes, mime } = got
  if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_MAX_BYTES) return null
  return { bytes, mime, format: sniffImageFormat(bytes) }
}

/** 并发 3 加载全部 image 块；总字节到 20 MB 后不再加载；单图失败静默（占位框） */
export async function loadImagesForExport(
  blocks: readonly PaperBlock[],
  opts: { signal?: AbortSignal; load?: typeof loadImageForExport; concurrency?: number } = {},
): Promise<Map<number, LoadedImage>> {
  const load = opts.load ?? loadImageForExport
  const out = new Map<number, LoadedImage>()
  const queue = blocks.filter((b) => b.kind === 'image' && typeof b.src === 'string' && b.src !== '')
  let total = 0
  let cursor = 0
  const worker = async () => {
    for (;;) {
      if (opts.signal?.aborted) return
      const b = queue[cursor++]
      if (!b || total >= IMAGE_TOTAL_MAX_BYTES) return
      try {
        const img = await load(b.src!, opts.signal)
        if (img && total + img.bytes.byteLength <= IMAGE_TOTAL_MAX_BYTES) {
          total += img.bytes.byteLength
          out.set(b.index, img)
        }
      } catch (e) {
        if (isAbortError(e)) return
        console.warn(`[export] 图片加载失败（块 ${b.index}）`, e)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? IMAGE_CONCURRENCY) }, worker))
  return out
}

/** `<img>` 解码 + canvas 栅格化为 PNG（长边 ≤ maxEdge）；没有 DOM / 解码失败抛错 */
export async function rasterizeToPng(image: LoadedImage, maxEdge: number = IMAGE_MAX_EDGE): Promise<Uint8Array> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') throw new Error('没有 DOM，无法栅格化')
  const blob = new Blob([image.bytes as BlobPart], { type: image.mime || 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    const w = img.naturalWidth
    const h = img.naturalHeight
    if (!(w > 0 && h > 0)) throw new Error('图片没有尺寸')
    const scale = Math.min(1, maxEdge / Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('没有 2d 上下文')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    canvas.width = 0
    canvas.height = 0
    if (!png) throw new Error('toBlob 失败')
    return new Uint8Array(await png.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 嵌入一张图：png / jpg 直接嵌，失败或其它格式 → 栅格化后再嵌；都失败 → null（占位框） */
async function embedImage(doc: PDFDocument, image: LoadedImage): Promise<PDFImage | null> {
  if (image.format === 'png' || image.format === 'jpg') {
    try {
      return image.format === 'png' ? await doc.embedPng(image.bytes) : await doc.embedJpg(image.bytes)
    } catch (e) {
      console.warn('[export] 直接嵌入图片失败，改走栅格化', e)
    }
  }
  try {
    return await doc.embedPng(await rasterizeToPng(image))
  } catch (e) {
    console.warn('[export] 图片栅格化失败，用占位框', e)
    return null
  }
}

export interface TextDocDeps {
  pdfLib: PdfLibModule
  fontkit: FontkitModule
  font: CjkFont
  /** 表格解析宿主；缺省全局 document，传 null 表示没有 DOM（表格退回段落） */
  dom?: Document | null
  loadImage?: typeof loadImageForExport
  now?: Date
}

export interface TextDocResult {
  bytes: Uint8Array
  pageCount: number
  /** 可译但缺译（排了原文）的块数——buildTextDocChunks 的计数 */
  untranslated: number
}

export async function exportTextDoc(input: ExportInput, deps: TextDocDeps): Promise<TextDocResult> {
  const { pdfLib: lib, font } = deps
  const flavor = input.flavor
  if (flavor !== 'text-zh' && flavor !== 'text-both') throw new ExportError('unknown', `文本排版导出不支持版本 ${flavor}`)
  throwIfAborted(input.signal)
  input.onProgress?.({ phase: 'open' })

  // 表格：sanitizeArticleHtml（DOMPurify）→ DOM 解析；没有 DOM 就退回 block.text
  const dom = deps.dom === undefined ? (typeof document !== 'undefined' ? document : null) : deps.dom
  const tables = new Map<number, TableModel>()
  if (dom) {
    for (const b of input.blocks) {
      if (b.kind !== 'table' || !b.html) continue
      try {
        const model = parseTableHtml(sanitizeArticleHtml(b.html), dom)
        if (model) tables.set(b.index, model)
      } catch (e) {
        console.warn(`[export] 表格解析失败（块 ${b.index}）`, e)
      }
    }
  }

  // 图：浏览器里才加载（node 没有 Image / canvas，占位框）
  const loaded =
    typeof document === 'undefined' && !deps.loadImage
      ? new Map<number, LoadedImage>()
      : await loadImagesForExport(input.blocks, { signal: input.signal, load: deps.loadImage })
  throwIfAborted(input.signal)

  const outDoc = await lib.PDFDocument.create()
  outDoc.registerFontkit(deps.fontkit as unknown as Parameters<PDFDocument['registerFontkit']>[0])
  const pdfFont = await outDoc.embedFont(font.bytes, { subset: true })
  const images = new Map<number, PDFImage>()
  const sizes = new Map<number, { w: number; h: number }>()
  for (const [index, image] of loaded) {
    throwIfAborted(input.signal)
    const embedded = await embedImage(outDoc, image)
    if (!embedded) continue
    images.set(index, embedded)
    sizes.set(index, { w: embedded.width, h: embedded.height })
  }

  const { chunks, untranslated } = buildTextDocChunks({
    paper: input.paper,
    blocks: input.blocks,
    texts: input.texts,
    flavor,
    font,
    tables,
    images: sizes,
    now: deps.now,
  })
  const pages = paginate(chunks, CONTENT_H)
  const plans = renderTextDoc(pages, font)
  const ctx = { lib, font: pdfFont, sanitize: (t: string) => font.sanitize(t), images }
  for (let i = 0; i < plans.length; i += 1) {
    throwIfAborted(input.signal)
    const plan = plans[i]
    const page = outDoc.addPage([plan.width, plan.height])
    runOps(page, plan.ops, ctx)
    input.onProgress?.({ phase: 'pages', done: i + 1, total: plans.length })
  }
  const title = `${input.paper.title || input.paper.fileName}（${TEXT_FLAVOR_NAME[flavor]}）`
  const bytes = await finishDocument(outDoc, title, input)
  return { bytes, pageCount: plans.length, untranslated }
}
