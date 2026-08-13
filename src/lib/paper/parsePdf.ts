import { IngestError, type ParseResult } from './ingest'
import { countChars, normalizePdf, type PdfPageText, type PdfTextItem } from './normalizePdf'
import { MAX_PDF_PAGES, MAX_TEXT_CHARS } from './validate'

/**
 * PDF 解析运行时层：只负责「动态 import pdfjs → 取文字项 → 调纯函数 normalizePdf」。
 * 本文件不进 vitest（会拉进 pdfjs 二进制），算法回归全部由 normalizePdf.test.ts 覆盖。
 */

/** 低于此阈值判定为无文字层（扫描件）：全书字符数，或页均字符数 */
const MIN_TOTAL_CHARS = 50
const MIN_CHARS_PER_PAGE = 10

interface RawTextItem {
  str?: unknown
  transform?: unknown
  width?: unknown
  height?: unknown
  hasEOL?: unknown
}

/** pdf.js 的 items 混有 TextMarkedContent，用结构判定过滤出真正的文本项 */
function toTextItem(raw: RawTextItem): PdfTextItem | null {
  if (typeof raw.str !== 'string' || !Array.isArray(raw.transform)) return null
  return {
    str: raw.str,
    transform: raw.transform as number[],
    width: typeof raw.width === 'number' ? raw.width : 0,
    height: typeof raw.height === 'number' ? raw.height : 0,
    hasEOL: raw.hasEOL === true,
  }
}

function classify(e: unknown): IngestError {
  if (e instanceof IngestError) return e
  const name = (e as { name?: unknown } | null)?.name
  if (name === 'PasswordException') {
    return new IngestError('encrypted', 'PDF 已加密，请提供解密后的文件')
  }
  if (name === 'InvalidPDFException') {
    return new IngestError('corrupt', 'PDF 结构无法解析，文件可能已损坏')
  }
  const message = e instanceof Error ? e.message : String(e)
  return new IngestError('corrupt', `PDF 解析失败：${message || '未知错误'}`)
}

export async function parsePdfBytes(bytes: ArrayBuffer): Promise<ParseResult> {
  const pdfjs = await import('pdfjs-dist')
  // worker 脚本由 Vite 作为独立资产发射（裸包路径经 vite:asset-import-meta-url 解析），
  // 解析在 Worker 线程进行，主线程不阻塞。
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

  // 关键坑：必须传字节副本 bytes.slice(0)。pdf.js 会把传入的 ArrayBuffer transfer 进 worker
  // 并 detach 原对象（byteLength 归零）——直接传会毁掉我们要写进 IndexedDB 的那一份原始字节。
  const task = pdfjs.getDocument({ data: bytes.slice(0) })

  try {
    const doc = await task.promise
    {
      if (doc.numPages > MAX_PDF_PAGES) {
        throw new IngestError('too-many-pages', `文档 ${doc.numPages} 页，超过 ${MAX_PDF_PAGES} 页上限`)
      }

      const pages: PdfPageText[] = []
      let rawChars = 0
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        try {
          const content = await page.getTextContent()
          const items: PdfTextItem[] = []
          for (const raw of content.items as RawTextItem[]) {
            const item = toTextItem(raw)
            if (item) {
              items.push(item)
              rawChars += item.str.length
            }
          }
          pages.push({ page: i, items })
        } finally {
          page.cleanup()
        }
        // 超限提前中止：不把 200 万字符以上的文档整篇读进内存再报错
        if (rawChars > MAX_TEXT_CHARS) {
          throw new IngestError('too-much-text', `抽取正文已超过 ${MAX_TEXT_CHARS} 字符上限`)
        }
      }

      if (rawChars < MIN_TOTAL_CHARS || rawChars / doc.numPages < MIN_CHARS_PER_PAGE) {
        throw new IngestError('no-text-layer', '这是扫描件（没有可抽取的文字层），首版不做 OCR')
      }

      const blocks = normalizePdf(pages)
      if (countChars(blocks) > MAX_TEXT_CHARS) {
        throw new IngestError('too-much-text', `抽取正文超过 ${MAX_TEXT_CHARS} 字符上限`)
      }

      let title: string | undefined
      try {
        const meta = await doc.getMetadata()
        const raw = (meta.info as { Title?: unknown } | undefined)?.Title
        if (typeof raw === 'string' && raw.trim()) title = raw.trim()
      } catch {
        /* 元数据缺失不是错误：标题回落到首个 heading 块或文件名 */
      }
      if (!title) title = blocks.find((b) => b.kind === 'heading')?.text

      return { blocks, pageCount: doc.numPages, title }
    }
  } catch (e) {
    throw classify(e)
  } finally {
    // 销毁 loadingTask 会一并释放 worker 侧的文档资源（PDFDocumentProxy 本身无 destroy）
    void task.destroy().catch(() => undefined)
  }
}
