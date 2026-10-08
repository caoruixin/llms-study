import { hasTranslatableText } from '../translate/translateBatch'
import type { PaperBlock, PaperRecord } from '../types'
import { loadCjkFont, loadFontkit, type CjkFont } from './cjkFont'
import { FLAVOR_LABEL, isInPlaceFlavor, textFlavorOf } from './exportFlavor'
import { exportPdfInPlace, oversizeError } from './exportPdfInPlace'
import { exportTextDoc } from './exportTextDoc'
import { abortError, ExportError, isAbortError, throwIfAborted, type ExportFlavor, type ExportInput, type ExportResult } from './exportTypes'

export { ExportError } from './exportTypes'
export { exportFlavorFor, FLAVOR_LABEL, isInPlaceFlavor, textFlavorOf } from './exportFlavor'
export { MAX_IN_PLACE_BYTES } from './exportPdfInPlace'
export type { ExportErrorCode, ExportFlavor, ExportInput, ExportPhase, ExportProgress, ExportResult } from './exportTypes'

/**
 * 导出 PDF 的编排层（PLAN A.7）：文件名、未译计数、`exportPaperPdf`（lib → font → 分派，原版拿不到字节 / 解析失败
 * 自动改走文本排版版）、`downloadBytes`。版本判定与标签在轻模块 exportFlavor（工作台静态引用，这里 re-export）；
 * 本模块只由 ExportDialog 动态 import，导出内核不进工作台 chunk。
 */

/** 文件名主干：NFC → 折叠空白（制表 / 换行也算）→ 去非法字符 → 去尾部 `.` / 空格 → 80 码点 */
export function sanitizeFileStem(raw: string): string {
  const s = raw
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '')
    .trim()
    .replace(/[. ]+$/g, '')
  return Array.from(s).slice(0, 80).join('')
}

const stripExtension = (name: string): string => name.replace(/\.[A-Za-z0-9]{1,5}$/, '')

/** `${stem}.中文.pdf` / `${stem}.中英对照.pdf`；stem 取 title → fileName 去扩展名 → 'paper' */
export function exportFileName(paper: Pick<PaperRecord, 'title' | 'fileName'>, flavor: ExportFlavor): string {
  const stem = sanitizeFileStem(paper.title) || sanitizeFileStem(stripExtension(paper.fileName)) || 'paper'
  const lang = flavor === 'pdf-zh-overlay' || flavor === 'text-zh' ? '中文' : '中英对照'
  return `${stem}.${lang}.pdf`
}

/**
 * 可译（体裁 + 非空）但没有译文的块数——导出前的预估口径，刻意不分版本（对话框补译确认用）。
 * 导出后的实际数以 ExportResult.untranslated 为准：由各版本执行器按自己真正排进去的块计
 * （覆盖版不含图内标签 / 非正文版面 / 旋转页上的块），所以可能比这里少。
 */
export function countUntranslated(blocks: readonly PaperBlock[], texts: ReadonlyMap<number, string>): number {
  let n = 0
  for (const b of blocks) if (hasTranslatableText(b) && !texts.has(b.index)) n += 1
  return n
}

/** 原版导出的这两类失败都不妨碍文本排版版（它不要原始字节、不用 pdf-lib 读原文件）→ 自动回退 */
const canFallBackToText = (e: unknown): e is ExportError => e instanceof ExportError && (e.code === 'parse' || e.code === 'bytes')

/** 回退提示：一句完整的话（对话框原样显示）= 原因 + 「已改为导出 X」 */
const fallbackNotice = (e: ExportError, to: ExportFlavor): string => `${e.message}，已改为导出${FLAVOR_LABEL[to]}`

/**
 * 生成 PDF 字节（不下载）：lib → font → 按版本分派。原版两种版本遇 `ExportError('bytes')`（原始文件不在本机 / 拉不到 /
 * 超过 40 MB）或 `ExportError('parse')`（pdf-lib 读不了 / 加密 / 页数不一致）自动改走对应语言的文本排版版，
 * `fellBackToText` 带上完整提示；文本排版版从不调用 getBytes，所以 'bytes' 不会再以错误收场。
 * 阶段之间检查 signal；其余错误统一包成 ExportError。
 */
export async function exportPaperPdf(input: ExportInput): Promise<ExportResult> {
  const { signal, onProgress } = input
  try {
    throwIfAborted(signal)
    const inPlace = isInPlaceFlavor(input.flavor)
    // 体积超限：不必下载 / 解析原文件，直接定为回退
    let fallback: ExportError | null = inPlace ? oversizeError(input.paper.byteSize) : null
    onProgress?.({ phase: 'lib' })
    const [pdfLib, fontkit] = await Promise.all([import('pdf-lib'), loadFontkit()])
    throwIfAborted(signal)

    onProgress?.({ phase: 'font' })
    let font: CjkFont
    try {
      font = await loadCjkFont({
        signal,
        onProgress: (bytes, total) => onProgress?.({ phase: 'font', bytes, ...(total !== null ? { total } : {}) }),
      })
    } catch (e) {
      if (isAbortError(e)) throw abortError()
      throw new ExportError('font', `中文字体下载失败：${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
    throwIfAborted(signal)

    let out: { bytes: Uint8Array; pageCount: number; untranslated: number } | null = null
    if (inPlace && !fallback) {
      try {
        out = await exportPdfInPlace(input, { pdfLib, fontkit, font })
      } catch (e) {
        if (!canFallBackToText(e)) throw e
        fallback = e
      }
    }
    const flavor: ExportFlavor = out ? input.flavor : textFlavorOf(input.flavor)
    if (!out) {
      throwIfAborted(signal)
      out = await exportTextDoc({ ...input, flavor: textFlavorOf(input.flavor) }, { pdfLib, fontkit, font })
    }
    return {
      bytes: out.bytes,
      fileName: exportFileName(input.paper, flavor),
      pageCount: out.pageCount,
      // 执行器按实际排进去的块计（版本相关）；countUntranslated 只是导出前的预估
      untranslated: out.untranslated,
      flavor,
      ...(fallback ? { fellBackToText: fallbackNotice(fallback, flavor) } : {}),
    }
  } catch (e) {
    if (e instanceof ExportError) throw e
    if (isAbortError(e)) throw abortError()
    throw new ExportError('unknown', e instanceof Error ? e.message : String(e), { cause: e })
  }
}

/** blob URL + `a[download]` 直接下载（不走打印对话框）；60 s 后 revoke */
export function downloadBytes(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
