import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { normalizePdf, toTextItem, type PdfPageText, type PdfTextItem, type RawTextItem, type RawTextStyle } from '../normalizePdf'
import { hasPdfLayout } from '../pdfLayout'
import { hasTranslatableText } from '../translate/translateBatch'
import type { PaperBlock, PaperRecord } from '../types'
import { createCjkFont, loadFontkit, type CjkFont, type FontkitModule } from './cjkFont'
import { exportPdfInPlace, type OpenedPdf, type PdfLibModule } from './exportPdfInPlace'
import { exportTextDoc } from './exportTextDoc'
import type { ExportInput } from './exportTypes'
import { PAGE_H, PAGE_W } from './textDocPlan'

/**
 * 真实 PDF 端到端生成（arXiv 2609.36054v1 fixture + Noto Serif SC 子集字体）：三种版本各生成一次，
 * 用 pdf.js legacy 回读，断言页数 / 页尺寸 / 中文文本存在。fixture 与字体任一缺失则整组跳过。
 * 解析走 normalizePdf（与 normalizePdf.arxiv.test.ts 同一路径）取带 layout 的块；译文是假的（几段中文）。
 * 设 EXPORT_SMOKE_OUT=目录 可把三个 PDF 写出来人工看。
 */
const FIXTURE = fileURLToPath(new URL('../../../../.e2e-qa-fixtures/pdf-inline/arxiv-2609.36054v1.pdf', import.meta.url))
const FONT = fileURLToPath(new URL('../../../assets/fonts/NotoSerifSC-sub.ttf', import.meta.url))
const CJK = /[一-鿿]{2,}/

const require = createRequire(import.meta.url)
type LegacyPdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

async function legacy(): Promise<LegacyPdfjs> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
  return pdfjs
}

const openLegacy = async (bytes: ArrayBuffer): Promise<OpenedPdf> => {
  const pdfjs = await legacy()
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) })
  const doc = await task.promise
  return { doc: doc as unknown as OpenedPdf['doc'], close: () => task.destroy() }
}

interface PageFacts {
  width: number
  height: number
  text: string
}

async function inspect(bytes: Uint8Array): Promise<PageFacts[]> {
  const pdfjs = await legacy()
  const task = pdfjs.getDocument({ data: bytes.slice() })
  try {
    const doc = await task.promise
    const out: PageFacts[] = []
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i)
      const vp = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const text = content.items.map((it) => ('str' in it ? it.str : '')).join('')
      out.push({ width: vp.width, height: vp.height, text })
      page.cleanup()
    }
    return out
  } finally {
    await task.destroy()
  }
}

async function parseBlocks(bytes: ArrayBuffer): Promise<PaperBlock[]> {
  const pdfjs = await legacy()
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) })
  try {
    const doc = await task.promise
    const pages: PdfPageText[] = []
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const styles = content.styles as Record<string, RawTextStyle>
      const items: PdfTextItem[] = []
      for (const raw of content.items as RawTextItem[]) {
        const item = toTextItem(raw, styles)
        if (item) items.push(item)
      }
      pages.push({ page: i, items })
      page.cleanup()
    }
    return normalizePdf(pages).map((b) => ({ ...b, id: `p:${b.index}`, paperId: 'p' }))
  } finally {
    await task.destroy()
  }
}

const dump = (name: string, bytes: Uint8Array) => {
  const dir = process.env.EXPORT_SMOKE_OUT
  if (!dir) return
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), bytes)
}

describe.skipIf(!fs.existsSync(FIXTURE) || !fs.existsSync(FONT))('导出 PDF 端到端（真实 fixture + 子集字体）', () => {
  let bytes: ArrayBuffer
  let blocks: PaperBlock[] = []
  let texts: Map<number, string>
  let source: PageFacts[] = []
  let font: CjkFont
  let fontkit: FontkitModule
  let pdfLib: PdfLibModule
  const paper = { id: 'p', title: 'What if automating AI R&D triggers an intelligence explosion?', fileName: 'arxiv-2609.36054v1.pdf', byteSize: 0, pageCount: 0 } as PaperRecord

  beforeAll(async () => {
    const buf = fs.readFileSync(FIXTURE)
    bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    paper.byteSize = bytes.byteLength
    blocks = await parseBlocks(bytes)
    expect(hasPdfLayout(blocks)).toBe(true)
    source = await inspect(new Uint8Array(bytes))
    paper.pageCount = source.length
    // 假译文：前两页的可译块全部给一段中文（含标点与数字，覆盖对齐与拆分路径）
    texts = new Map()
    let n = 0
    for (const b of blocks) {
      const page = b.layout?.segs[0]?.page ?? 99
      if (page > 2 || !hasTranslatableText(b)) continue
      n += 1
      texts.set(b.index, b.kind === 'heading' ? `第 ${n} 节标题` : `这是第 ${n} 段的中文译文：自动化 AI 研发是否会触发智能爆炸，取决于回报递减与算力增长的相对速度。`.repeat(1 + (n % 2)))
    }
    expect(texts.size).toBeGreaterThan(3)
    const fontBytes = fs.readFileSync(FONT)
    font = await createCjkFont(new Uint8Array(fontBytes.buffer, fontBytes.byteOffset, fontBytes.byteLength))
    fontkit = await loadFontkit()
    pdfLib = await import('pdf-lib')
  }, 120_000)

  const input = (flavor: ExportInput['flavor']): ExportInput => ({
    paper,
    blocks,
    texts,
    flavor,
    getBytes: async () => bytes,
    onProgress: () => undefined,
  })
  /** 不分版本的预估缺译数（可译、非空、无译文）：各版本的实际计数不会超过它 */
  const pendingCount = () => blocks.filter((b) => hasTranslatableText(b) && !texts.has(b.index)).length

  it('字体：度量合理、常用汉字与标点有字形、缺字换 □', () => {
    expect(font.metrics.unitsPerEm).toBeGreaterThan(0)
    expect(font.metrics.ascent).toBeGreaterThan(0)
    expect(font.metrics.descent).toBeLessThan(0)
    for (const ch of '中文译文，。：；！？（）「」0123456789abcXYZ□') expect(font.hasGlyph(ch.codePointAt(0)!)).toBe(true)
    expect(font.sanitize('a\tb c😀')).toBe('a  b c□')
    expect(font.measureAt('中', 10)).toBeCloseTo(10, 0)
  })

  it('中文覆盖版：页数与各页尺寸同原文件，第 1 页文字层含中文', async () => {
    const progress: number[] = []
    const r = await exportPdfInPlace({ ...input('pdf-zh-overlay'), onProgress: (p) => p.phase === 'pages' && progress.push(p.done!) }, { pdfLib, fontkit, font, openPdf: openLegacy })
    dump('overlay.pdf', r.bytes)
    expect(r.pageCount).toBe(source.length)
    expect(progress).toEqual(source.map((_, i) => i + 1))
    const out = await inspect(r.bytes)
    expect(out).toHaveLength(source.length)
    out.forEach((p, i) => {
      expect(p.width).toBeCloseTo(source[i].width, 3)
      expect(p.height).toBeCloseTo(source[i].height, 3)
    })
    expect(out[0].text).toMatch(CJK)
    // 原文仍在框下（可搜索）
    expect(out[0].text).toContain('intelligence')
    // 体积：原文件 + 字体子集，不该翻倍
    expect(r.bytes.byteLength).toBeLessThan(bytes.byteLength * 2 + 600_000)
    // 第 3 页起没给译文 → 有缺译；只数有覆盖片的块，不超过预估
    expect(r.untranslated).toBeGreaterThan(0)
    expect(r.untranslated).toBeLessThanOrEqual(pendingCount())
  }, 120_000)

  it('中英对照流版：页数相等、有页比原页高、含中文、同宽', async () => {
    const r = await exportPdfInPlace(input('pdf-both-flow'), { pdfLib, fontkit, font, openPdf: openLegacy })
    dump('flow.pdf', r.bytes)
    expect(r.pageCount).toBe(source.length)
    const out = await inspect(r.bytes)
    expect(out).toHaveLength(source.length)
    out.forEach((p, i) => expect(p.width).toBeCloseTo(source[i].width, 3))
    expect(out.some((p, i) => p.height > source[i].height + 10)).toBe(true)
    // 未译页高度不变
    expect(out[out.length - 1].height).toBeCloseTo(source[source.length - 1].height, 3)
    expect(out[0].text).toMatch(CJK)
    expect(out[0].text).toContain('intelligence')
    expect(r.untranslated).toBeGreaterThan(0)
    expect(r.untranslated).toBeLessThanOrEqual(pendingCount())
  }, 120_000)

  it('文本排版版（对照）：A4 页、第 1 页同时含英文与中文；不取原始字节，缺译数 = 预估', async () => {
    const getBytes = vi.fn(async () => bytes)
    const r = await exportTextDoc({ ...input('text-both'), getBytes }, { pdfLib, fontkit, font, dom: null })
    expect(getBytes).not.toHaveBeenCalled()
    expect(r.untranslated).toBe(pendingCount())
    dump('text-both.pdf', r.bytes)
    const out = await inspect(r.bytes)
    expect(out.length).toBe(r.pageCount)
    expect(out.length).toBeGreaterThan(1)
    for (const p of out) {
      expect(p.width).toBeCloseTo(PAGE_W, 3)
      expect(p.height).toBeCloseTo(PAGE_H, 3)
    }
    expect(out[0].text).toMatch(CJK)
    expect(out[0].text).toMatch(/[A-Za-z]{4,}/)
    expect(out[0].text).toContain('1 / ' + out.length)
  }, 120_000)
})
