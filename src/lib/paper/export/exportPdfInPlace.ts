import type { PDFDocument, PDFEmbeddedPage, PDFFont, PDFImage, PDFPage } from 'pdf-lib'
import type * as Pdfjs from 'pdfjs-dist'
import { sampleBackgrounds } from '../../../components/papers/PdfZhOverlay'
import { ensurePdfCompat } from '../pdfCompat'
import {
  buildPieces,
  groupBlocksByPage,
  hasPdfLayout,
  partitionPageFlow,
  segmentsOnPage,
  translationBounds,
  type PageGeom,
  type PortionRect,
} from '../pdfLayout'
import { hasTranslatableText } from '../translate/translateBatch'
import type { PaperBlock } from '../types'
import type { CjkFont, FontkitModule } from './cjkFont'
import { abortError, ExportError, isAbortError, throwIfAborted, type DrawOp, type ExportInput, type PagePlan } from './exportTypes'
import { pageBodyLineH, planCopiedPage, planFlowPage, planOverlayPage } from './inPlacePlan'

/**
 * 原版 PDF 导出执行器（PLAN A.5）：pdf.js 取几何（与 viewer 同源的 rawDims）+ pdf-lib 落笔。
 * - 覆盖版：`PDFDocument.load(bytes)` 原文档上叠画；有覆盖片的页先离屏渲染（scale 1、DPR 1）取底色后立即归零 canvas；
 * - 对照流版：新文档，每个原页 **只 embedPage 一次**（显式 cropbox BBox），每条带 q / re W n / Do / Q 共享同一 XObject；
 *   旋转页 copyPages。
 * 规划全部在 inPlacePlan（纯函数）；这里只做 IO 与 pdf-lib 调用。pdf.js 的打开方式可注入（node 集成测试用 legacy 构建）。
 * 拿不到 / 过大的原始文件抛 ExportError('bytes')、pdf-lib 读不了或与 pdf.js 页数不一致抛 ExportError('parse')：
 * 两类都由编排层（exportPaper）自动回退到文本排版版，message 直接拼进回退提示（「…，已改为导出…」）。
 */

/** 原版两种版本的文件体积上限：pdf-lib 要把整个文件读进内存重写（E 风险项） */
export const MAX_IN_PLACE_BYTES = 40 * 1024 * 1024

/** 超过上限 → ExportError('bytes')（编排层据此直接改走文本排版版，不必先下载 / 解析原文件） */
export function oversizeError(byteSize: number): ExportError | null {
  if (!(byteSize > MAX_IN_PLACE_BYTES)) return null
  return new ExportError('bytes', `文件超过 40 MB（${(byteSize / 1048576).toFixed(1)} MB）`)
}

/** getBytes 失败的原因文案：页面给的文案已经讲清「原始文件…」就原样用，否则补上主语 */
function bytesFailureMessage(e: unknown): string {
  const detail = (e instanceof Error ? e.message : String(e ?? '')).trim()
  if (!detail) return '原始文件不在本机'
  return detail.includes('原始文件') ? detail : `原始文件不在本机（${detail}）`
}

export type PdfLibModule = typeof import('pdf-lib')
type PdfDocumentLike = Pick<Pdfjs.PDFDocumentProxy, 'numPages' | 'getPage'>

export interface OpenedPdf {
  doc: PdfDocumentLike
  close: () => Promise<void>
}
export type OpenPdf = (bytes: ArrayBuffer) => Promise<OpenedPdf>

export interface InPlaceDeps {
  pdfLib: PdfLibModule
  fontkit: FontkitModule
  font: CjkFont
  /** 缺省：浏览器路径（ensurePdfCompat + pdfjs-dist + 包装 worker） */
  openPdf?: OpenPdf
  /** 覆盖版取底色的离屏 canvas；缺省 document.createElement，没有 DOM → 不取样（白底） */
  createCanvas?: () => HTMLCanvasElement | null
}

/** 浏览器里打开 PDF（沿 PdfViewer：WebKit shim、包装 worker、传字节副本——pdf.js 会 transfer 并 detach 原 ArrayBuffer） */
export async function openPdfInBrowser(bytes: ArrayBuffer): Promise<OpenedPdf> {
  ensurePdfCompat()
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('../pdfWorkerEntry?worker&url')])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const task = pdfjs.getDocument({ data: bytes.slice(0) })
  const doc = await task.promise
  return { doc, close: () => task.destroy() }
}

const defaultCanvas = (): HTMLCanvasElement | null =>
  typeof document === 'undefined' ? null : document.createElement('canvas')

/** 一页在 scale = 1 下的几何（与 PdfViewer 的 PageSize 同口径） */
interface PageInfo {
  geom: PageGeom
  width: number
  height: number
  rotated: boolean
}

const pageInfoOf = (page: Pdfjs.PDFPageProxy): PageInfo => {
  const vp = page.getViewport({ scale: 1 })
  const raw = vp.rawDims as PageGeom
  return {
    geom: { pageX: raw.pageX, pageY: raw.pageY, pageWidth: raw.pageWidth, pageHeight: raw.pageHeight },
    width: vp.width,
    height: vp.height,
    rotated: vp.rotation % 360 !== 0,
  }
}

// ---------------------------------------------------------------------------
// runOps：PagePlan → pdf-lib 操作符（覆盖版 / 对照流版 / 文本排版版共用）
// ---------------------------------------------------------------------------

export interface OpsContext {
  lib: PdfLibModule
  font: PDFFont
  sanitize: (text: string) => string
  /** strip op 的整页 XObject（按原页码） */
  embedded?: ReadonlyMap<number, PDFEmbeddedPage>
  /** image op 的图（按 blockIndex）；缺失 → 跳过 */
  images?: ReadonlyMap<number, PDFImage>
}

/** 描边仿粗的线宽比例 */
const BOLD_STROKE_RATIO = 0.028

export function runOps(page: PDFPage, ops: readonly DrawOp[], ctx: OpsContext): void {
  const { lib } = ctx
  const color = (c: { r: number; g: number; b: number }) => lib.rgb(c.r, c.g, c.b)
  // 不设页字体的话 drawText 会顺手嵌一份 Helvetica 进资源表
  if (ops.some((o) => o.kind === 'text')) page.setFont(ctx.font)
  for (const op of ops) {
    switch (op.kind) {
      case 'rect': {
        if (!op.fill && !op.stroke) break
        // pdf-lib：给了 borderColor 没给 color 就不填充；两者都没给才默认黑填充（上面已短路）
        page.drawRectangle({
          x: op.x,
          y: op.y,
          width: op.w,
          height: op.h,
          ...(op.fill ? { color: color(op.fill) } : {}),
          ...(op.stroke
            ? { borderColor: color(op.stroke), borderWidth: op.strokeWidth ?? 0.5, ...(op.dash ? { borderDashArray: op.dash } : {}) }
            : { borderWidth: 0 }),
        })
        break
      }
      case 'line':
        page.drawLine({ start: { x: op.x1, y: op.y1 }, end: { x: op.x2, y: op.y2 }, thickness: op.width, color: color(op.color) })
        break
      case 'text': {
        const text = ctx.sanitize(op.text).replace(/\n/g, ' ')
        if (text === '') break
        const pre = [lib.pushGraphicsState(), lib.setCharacterSpacing(op.charSpacing ?? 0)]
        if (op.bold) {
          pre.push(
            lib.setTextRenderingMode(lib.TextRenderingMode.FillAndOutline),
            lib.setLineWidth(BOLD_STROKE_RATIO * op.size),
            lib.setStrokingColor(color(op.color)),
          )
        }
        // pdf-lib 的 drawText 自带 q/Q，但会继承外层的 Tc / Tr：包一层 q/Q 让它们只作用于这一行
        page.pushOperators(...pre)
        page.drawText(text, { x: op.x, y: op.y, size: op.size, font: ctx.font, color: color(op.color) })
        page.pushOperators(lib.popGraphicsState())
        break
      }
      case 'strip': {
        const embedded = ctx.embedded?.get(op.srcPage)
        if (!embedded) break
        page.pushOperators(lib.pushGraphicsState(), lib.rectangle(op.clip.x, op.clip.y, op.clip.w, op.clip.h), lib.clip(), lib.endPath())
        page.drawPage(embedded, { x: op.tx, y: op.ty })
        page.pushOperators(lib.popGraphicsState())
        break
      }
      case 'image': {
        const img = ctx.images?.get(op.blockIndex)
        if (img) page.drawImage(img, { x: op.x, y: op.y, width: op.w, height: op.h })
        break
      }
    }
  }
}

/** 文档元数据 + 保存（三种版本共用） */
export async function finishDocument(doc: PDFDocument, title: string, input: Pick<ExportInput, 'signal' | 'onProgress'>): Promise<Uint8Array> {
  throwIfAborted(input.signal)
  input.onProgress?.({ phase: 'save' })
  doc.setTitle(title)
  doc.setModificationDate(new Date())
  // objectsPerTick：pdf-lib 默认每 50 个对象 setTimeout 让位一次。导出标签页一旦退到后台，Chrome 把链式定时器
  // 节流到每秒 1 次（隐藏 5 分钟后每分钟 1 次），几千个对象的序列化会拖成几分钟（生产复验实测）。
  // 导出本就在模态对话框里，整段同步写出（2.5 MB 论文约 1–2 s）比"可能永远写不完"好。
  return doc.save({ useObjectStreams: true, objectsPerTick: Number.MAX_SAFE_INTEGER })
}

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

export interface InPlaceResult {
  bytes: Uint8Array
  pageCount: number
  /**
   * 译文没落进输出的可译块数（全篇去重）：覆盖版 = 有覆盖片但缺译的块；对照流 = showTranslation 条带缺译的块。
   * 公式 / 图内标签 / 旋转页上的块本就不出译文位，不计
   */
  untranslated: number
}

async function loadSource(lib: PdfLibModule, bytes: ArrayBuffer): Promise<PDFDocument> {
  try {
    // parseSpeed：默认 Slow = 每 100 个对象 setTimeout 让位一次，后台标签页被定时器节流后解析会拖成几分钟
    //（同 finishDocument 的 objectsPerTick）。Fastest = 一口气同步解析，2.5 MB 论文约 1 s
    return await lib.PDFDocument.load(bytes, { parseSpeed: lib.ParseSpeeds.Fastest })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new ExportError('parse', `原始 PDF 无法重写（${/encrypt/i.test(msg) ? '文件已加密' : msg}）`, { cause: e })
  }
}

export async function exportPdfInPlace(input: ExportInput, deps: InPlaceDeps): Promise<InPlaceResult> {
  const { pdfLib: lib, font } = deps
  const flavor = input.flavor
  if (flavor !== 'pdf-zh-overlay' && flavor !== 'pdf-both-flow') throw new ExportError('unknown', `原版导出不支持版本 ${flavor}`)
  if (!hasPdfLayout(input.blocks)) throw new ExportError('parse', '该论文的正文块没有版面几何，无法就地导出')
  throwIfAborted(input.signal)

  input.onProgress?.({ phase: 'open' })
  let bytes: ArrayBuffer
  try {
    bytes = await input.getBytes()
  } catch (e) {
    if (isAbortError(e)) throw abortError()
    throw new ExportError('bytes', bytesFailureMessage(e), { cause: e })
  }
  throwIfAborted(input.signal)
  // paper.byteSize 可能缺失 / 过期：按实际字节再拦一次
  const tooBig = oversizeError(bytes.byteLength)
  if (tooBig) throw tooBig

  const blocksByPage = groupBlocksByPage(input.blocks)
  const byIndex = new Map<number, PaperBlock>()
  for (const b of input.blocks) byIndex.set(b.index, b)
  const blockOf = (i: number) => byIndex.get(i)
  const translatable = (i: number): boolean => {
    const b = byIndex.get(i)
    return b !== undefined && hasTranslatableText(b)
  }

  let opened: OpenedPdf
  try {
    opened = await (deps.openPdf ?? openPdfInBrowser)(bytes)
  } catch (e) {
    if (isAbortError(e)) throw abortError()
    throw new ExportError('parse', `原始 PDF 无法打开（${e instanceof Error ? e.message : String(e)}）`, { cause: e })
  }
  try {
    throwIfAborted(input.signal)
    const srcDoc = await loadSource(lib, bytes)
    const total = opened.doc.numPages
    // 逐页按 pdf.js 页码去取 pdf-lib 的页（覆盖版 outDoc.getPage / 对照流 srcDoc.getPage）：两边页数对不上
    // 就会越界抛 RangeError（落成 'unknown'）。改抛 'parse' 让编排层回退到文本排版版
    const libPages = srcDoc.getPageCount()
    if (libPages !== total) {
      throw new ExportError('parse', `原始 PDF 无法重写（页数读取不一致：pdf.js ${total} 页，pdf-lib ${libPages} 页）`)
    }
    const outDoc = flavor === 'pdf-zh-overlay' ? srcDoc : await lib.PDFDocument.create()
    outDoc.registerFontkit(deps.fontkit as unknown as Parameters<PDFDocument['registerFontkit']>[0])
    const pdfFont = await outDoc.embedFont(font.bytes, { subset: true })
    const ctxBase = { lib, font: pdfFont, sanitize: (t: string) => font.sanitize(t) }
    /** 规划器报的缺译块号取并集（覆盖版的跨页块每页都有片，不能按页求和） */
    const missing = new Set<number>()
    const noteMissing = (indices: readonly number[]) => {
      for (const i of indices) missing.add(i)
    }

    for (let p = 1; p <= total; p += 1) {
      throwIfAborted(input.signal)
      const page = await opened.doc.getPage(p)
      try {
        const info = pageInfoOf(page)
        const list = blocksByPage.get(p)
        // 旋转页：行框在未旋转空间，换算不成立 → 不给块（与 viewer 一致）
        const portions: PortionRect[] = info.rotated || !list ? [] : segmentsOnPage(list, p, info.geom)

        if (flavor === 'pdf-zh-overlay') {
          const pieces = buildPieces(portions, blockOf, 1, { round: false })
          const hasText = pieces.some((pc) => input.texts.has(pc.block.index))
          let backgrounds: ReadonlyMap<string, string> | undefined
          if (hasText) backgrounds = await sampleOverlayBackgrounds(page, pieces, info, deps.createCanvas ?? defaultCanvas)
          const plan = planOverlayPage({ geom: info.geom, pieces, texts: input.texts, backgrounds, font })
          noteMissing(plan.untranslatedBlocks)
          if (plan.ops.length) runOps(outDoc.getPage(p - 1), plan.ops, ctxBase)
        } else {
          let plan: PagePlan
          if (info.rotated) {
            plan = planCopiedPage(p, info.width, info.height)
          } else {
            const rows = partitionPageFlow({ pageWidth: info.geom.pageWidth, pageHeight: info.geom.pageHeight, page: p }, portions, {
              isTranslatable: translatable,
            })
            const bounds = translationBounds(portions, (i) => byIndex.get(i)?.kind)
            const flow = planFlowPage({
              page: p,
              geom: info.geom,
              rows,
              textBounds: bounds,
              texts: input.texts,
              bodyLineH: pageBodyLineH(portions),
              font,
            })
            noteMissing(flow.untranslatedBlocks)
            plan = flow
          }
          if (plan.base.kind === 'copy') {
            const [copied] = await outDoc.copyPages(srcDoc, [p - 1])
            outDoc.addPage(copied)
          } else {
            const g = info.geom
            // 必须显式传 cropbox：pdf-lib 默认 BBox 假设 MediaBox 原点 0,0，drawPage 不补偿 BBox
            const embedded = await outDoc.embedPage(srcDoc.getPage(p - 1), {
              left: g.pageX,
              bottom: g.pageY,
              right: g.pageX + g.pageWidth,
              top: g.pageY + g.pageHeight,
            })
            const newPage = outDoc.addPage([plan.width, plan.height])
            runOps(newPage, plan.ops, { ...ctxBase, embedded: new Map([[p, embedded]]) })
          }
        }
      } finally {
        page.cleanup()
      }
      input.onProgress?.({ phase: 'pages', done: p, total })
    }

    const title = `${input.paper.title || input.paper.fileName}（${flavor === 'pdf-zh-overlay' ? '中文' : '中英对照'}）`
    const out = await finishDocument(outDoc, title, input)
    return { bytes: out, pageCount: outDoc.getPageCount(), untranslated: missing.size }
  } finally {
    await opened.close().catch(() => undefined)
  }
}

/** 覆盖版底色：离屏渲染（scale 1、DPR 1）→ sampleBackgrounds → 立即归零 canvas；没有 2d 上下文 / 渲染失败 → 白底 */
async function sampleOverlayBackgrounds(
  page: Pdfjs.PDFPageProxy,
  pieces: ReturnType<typeof buildPieces>,
  info: PageInfo,
  createCanvas: () => HTMLCanvasElement | null,
): Promise<ReadonlyMap<string, string> | undefined> {
  const canvas = createCanvas()
  if (!canvas) return undefined
  try {
    const viewport = page.getViewport({ scale: 1 })
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    // intent: 'print'：display 意图的渲染靠 requestAnimationFrame 续跑，标签页退到后台 rAF 一停就永远完不成
    // （生产复验实测卡在「准备文档…」）；print 意图走微任务，与标签页可见性无关，取底色也不需要屏幕意图
    await page.render({ canvas, viewport, intent: 'print' }).promise
    return sampleBackgrounds(canvas, pieces, info.geom.pageWidth)
  } catch (e) {
    console.warn('[export] 取底色失败，按白底', e)
    return undefined
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}
