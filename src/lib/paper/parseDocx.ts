import { IngestError, countBlockChars, type ParseResult } from './ingest'
import { normalizeDocxHtml } from './normalizeDocx'
import { sanitizeDocxHtml } from './sanitize'
import { MAX_TEXT_CHARS } from './validate'

/**
 * DOCX 解析运行时层：动态 import mammoth → 白名单清洗 → 调纯函数 normalizeDocxHtml。
 * 本文件不进 vitest；算法回归由 normalizeDocx.test.ts / sanitize.test.ts 覆盖。
 *
 * Worker 化说明：pdfjs 自带 worker 已满足「主线程不阻塞」；mammoth 在主线程执行——
 * DOCX 体量通常远小于 PDF，且解析发生在串行队列内，Phase 1 可接受。若实测卡顿，
 * Phase 2 用 `new Worker(new URL('./docxWorker.ts', import.meta.url), { type: 'module' })`
 * 迁移即可：本函数的 `bytes → ParseResult` 接口不变，调用方无需改动。
 */

type MammothModule = typeof import('mammoth')

export async function parseDocxBytes(bytes: ArrayBuffer): Promise<ParseResult> {
  // mammoth 是 CJS（export =）：Vite 的 interop 可能把它挂在 default 上，两种形状都兼容
  const mod = (await import('mammoth')) as unknown as MammothModule & { default?: MammothModule }
  const mammoth: MammothModule = mod.default ?? mod

  let html: string
  try {
    const result = await mammoth.convertToHtml({ arrayBuffer: bytes })
    html = result.value
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new IngestError('corrupt', `DOCX 解压失败，文件可能已损坏：${message || '未知错误'}`)
  }

  const blocks = normalizeDocxHtml(sanitizeDocxHtml(html))
  if (!blocks.length) {
    throw new IngestError('no-text-layer', '没有从该 DOCX 中抽取到任何文字内容')
  }
  if (countBlockChars(blocks) > MAX_TEXT_CHARS) {
    throw new IngestError('too-much-text', `抽取正文超过 ${MAX_TEXT_CHARS} 字符上限`)
  }

  const title = blocks.find((b) => b.kind === 'heading')?.text
  return { blocks, title }
}
