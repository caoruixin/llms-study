// Paper Copilot 评测 harness —— Node 侧文档加载（PLAN-paper-copilot.md §11.3）。
//
// 复用 src/lib/paper 的纯规范化函数（normalizePdf / normalizeDocxHtml / chunkPaper），
// 只有"从字节到 pdf.js textContent / mammoth HTML"这一层是本文件自己写的运行时胶水
// （src/lib/paper/parsePdf.ts、parseDocx.ts 是浏览器向 Worker/动态 import 的运行时层，
// parsePdf.ts 硬编码了浏览器 Worker 路径，不能直接在 Node 里跑，因此不复用它们）。
//
// 已知偏差（如实记录，供报告引用）：
// - PDF：用 pdfjs-dist/legacy/build/pdf.mjs 而非 src/lib/paper/parsePdf.ts 的浏览器 Worker 路径；
//   pdf.js 会自动探测 Node 环境并用同线程 LoopbackPort（无需 disableWorker 选项，v6 已移除该参数）。
// - DOCX：跳过 sanitizeDocxHtml（DOMPurify 依赖 DOM，Node 无 window/document）。mammoth 输出的
//   HTML 直接交给 normalizeDocxHtml —— 该函数内部用正则去除全部标签/脚本再解码实体，等同于
//   "先转纯文本"的纵深防御层仍然生效，只是没有 DOMPurify 的白名单过滤这一道；评测只需要文本块，
//   不渲染 HTML，因此风险可接受。生产导入路径（parseDocx.ts）不受影响，仍然强制 sanitize。

import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { normalizePdf, type PdfPageText, type PdfTextItem } from '../../src/lib/paper/normalizePdf'
import { normalizeDocxHtml } from '../../src/lib/paper/normalizeDocx'
import { chunkPaper } from '../../src/lib/paper/chunking'
import type { NormalizedBlock, PaperChunk } from '../../src/lib/paper/types'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../..')
const PDFJS_DIST = path.join(REPO_ROOT, 'node_modules/pdfjs-dist')

export type PaperFormat = 'pdf' | 'docx'

export interface LoadedPaper {
  paperId: string
  title: string
  format: PaperFormat
  sourcePath: string
  blocks: NormalizedBlock[]
  chunks: PaperChunk[]
  pageCount?: number
  charCount: number
  /** 与 src 生产路径的已知行为偏差（评测报告需如实列出，§任务约束） */
  deviations: string[]
}

function charCountOf(blocks: readonly NormalizedBlock[]): number {
  return blocks.reduce((n, b) => n + b.text.length, 0)
}

interface RawPdfTextItem {
  str?: unknown
  transform?: unknown
  width?: unknown
  height?: unknown
  hasEOL?: unknown
}

async function loadPdf(paperId: string, sourcePath: string): Promise<LoadedPaper> {
  const deviations = [
    '解析走 pdfjs-dist/legacy/build/pdf.mjs 直接调用（非 src/lib/paper/parsePdf.ts 的浏览器 Worker 运行时层），文字抽取算法（normalizePdf）与生产一致',
  ]
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const bytes = await readFile(sourcePath)
  const data = new Uint8Array(bytes)
  // 无这两个 URL，罕见字形（连字、数学符号）会触发 pdf.js 内部警告；不影响 getTextContent 抽取的字符串本身。
  const standardFontDataUrl = pathToFileURL(path.join(PDFJS_DIST, 'standard_fonts') + path.sep).toString()
  const cMapUrl = pathToFileURL(path.join(PDFJS_DIST, 'cmaps') + path.sep).toString()

  const task = pdfjsLib.getDocument({ data, standardFontDataUrl, cMapUrl, cMapPacked: true })
  try {
    const doc = await task.promise
    const pages: PdfPageText[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      try {
        const content = await page.getTextContent()
        const items: PdfTextItem[] = []
        for (const raw of content.items as RawPdfTextItem[]) {
          if (typeof raw.str !== 'string' || !Array.isArray(raw.transform)) continue
          items.push({
            str: raw.str,
            transform: raw.transform as number[],
            width: typeof raw.width === 'number' ? raw.width : 0,
            height: typeof raw.height === 'number' ? raw.height : 0,
            hasEOL: raw.hasEOL === true,
          })
        }
        pages.push({ page: i, items })
      } finally {
        page.cleanup()
      }
    }

    const blocks = normalizePdf(pages)
    let title: string | undefined
    try {
      const meta = await doc.getMetadata()
      const raw = (meta.info as { Title?: unknown } | undefined)?.Title
      if (typeof raw === 'string' && raw.trim()) title = raw.trim()
    } catch {
      // 元数据缺失不是错误
    }
    title ??= blocks.find((b) => b.kind === 'heading')?.text

    const chunks = chunkPaper(paperId, blocks)
    return {
      paperId,
      title: title ?? path.basename(sourcePath),
      format: 'pdf',
      sourcePath,
      blocks,
      chunks,
      pageCount: doc.numPages,
      charCount: charCountOf(blocks),
      deviations,
    }
  } finally {
    void task.destroy().catch(() => undefined)
  }
}

type MammothConvert = (input: { path: string }) => Promise<{ value: string }>

async function loadDocx(paperId: string, sourcePath: string): Promise<LoadedPaper> {
  const deviations = [
    '跳过 sanitizeDocxHtml（DOMPurify 需要 DOM，Node 无 window/document）：mammoth HTML 直接交给 normalizeDocxHtml。' +
      '该函数内部用正则剥离全部标签与 script/style 内容后才解码实体，等价于一层纵深防御，但没有 DOMPurify 的属性白名单过滤；' +
      '仅影响本评测脚本，生产导入路径（src/lib/paper/parseDocx.ts）不受影响，仍强制 sanitize。',
  ]
  const mod = (await import('mammoth')) as unknown as { convertToHtml?: MammothConvert; default?: { convertToHtml: MammothConvert } }
  const mammoth = mod.default ?? (mod as { convertToHtml: MammothConvert })
  const result = await mammoth.convertToHtml({ path: sourcePath })
  const blocks = normalizeDocxHtml(result.value)
  const title = blocks.find((b) => b.kind === 'heading')?.text
  const chunks = chunkPaper(paperId, blocks)
  return {
    paperId,
    title: title ?? path.basename(sourcePath),
    format: 'docx',
    sourcePath,
    blocks,
    chunks,
    charCount: charCountOf(blocks),
    deviations,
  }
}

export async function loadPaper(paperId: string, sourcePath: string, format: PaperFormat): Promise<LoadedPaper> {
  return format === 'pdf' ? loadPdf(paperId, sourcePath) : loadDocx(paperId, sourcePath)
}

/**
 * 金丝雀注入（挑战题 §11.3：3 正文 prompt injection）：
 * 在指定 chunk 末尾追加一段"伪装成指令"的段落，模拟论文正文被污染。
 * 追加而非替换：BM25 仍能靠原文关键词命中该 chunk，注入段落随之被带入上下文。
 * 返回新的 chunks 数组（不修改入参），并回传被注入的 chunkId 供 checks.ts 核对"是否真的被检索到"。
 */
export function injectCanary(
  chunks: readonly PaperChunk[],
  matchText: string,
  canaryLine: string,
): { chunks: PaperChunk[]; injectedChunkId: string | null } {
  let injectedChunkId: string | null = null
  const out = chunks.map((c) => {
    if (injectedChunkId === null && c.text.includes(matchText)) {
      injectedChunkId = c.id
      return { ...c, text: `${c.text}\n\n${canaryLine}` }
    }
    return c
  })
  return { chunks: out, injectedChunkId }
}
