import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PDFDocument, rgb } from 'pdf-lib'
import { describe, expect, it, vi } from 'vitest'
import { buildPieces, segmentsOnPage } from '../pdfLayout'
import type { PaperBlock, PaperRecord, PdfLayoutSeg } from '../types'
import { createCjkFont, loadFontkit, type CjkFont, type FontkitModule } from './cjkFont'
import { exportPdfInPlace, MAX_IN_PLACE_BYTES, oversizeError, type OpenedPdf, type OpenPdf, type PdfLibModule } from './exportPdfInPlace'
import { ExportError, type ExportInput } from './exportTypes'
import { planOverlayPage } from './inPlacePlan'

/**
 * 原版导出执行器的失败分类（编排层据此决定是否回退文本排版版）与未译计数：
 * - getBytes 失败 / 字节超限 → 'bytes'；pdf.js 打不开、pdf-lib 读不了、两边页数不一致 → 'parse'；取消 → 'aborted'；
 * - 未译按块去重：覆盖版跨页块每页都有片，只计一次。
 * pdf.js 用假文档注入（只需 numPages / getPage / getViewport），原文件用 pdf-lib 现做。
 */

const PROSE = 'This is an ordinary English paragraph with enough words to look like running prose text.'
const GEOM = { pageX: 0, pageY: 0, pageWidth: 600, pageHeight: 800 }

const block = (index: number, segs: PdfLayoutSeg[]): PaperBlock => ({
  id: `p:${index}`,
  paperId: 'p',
  index,
  kind: 'paragraph',
  text: PROSE,
  anchor: { kind: 'pdf', blockIndex: index, page: segs[0].page },
  layout: { segs },
})

/** 通栏 3 行（首行缩进），行框 [x0, yTop, x1, h]，用户空间 y 向上 */
const seg = (page: number, yTop: number): PdfLayoutSeg => ({
  page,
  col: 'full',
  lines: [
    [100, yTop, 540, 12],
    [80, yTop - 14, 540, 12],
    [80, yTop - 28, 400, 12],
  ],
})

// 0：第 1 页（已译）；1：第 1 页末 → 第 2 页首（缺译，跨页）；2：第 2 页（缺译）
const BLOCKS: PaperBlock[] = [block(0, [seg(1, 760)]), block(1, [seg(1, 200), seg(2, 760)]), block(2, [seg(2, 600)])]
const TEXTS = new Map([[0, '这是第一段的中文译文，有一些字。']])
const PAPER = { id: 'p', title: 'T', fileName: 't.pdf', byteSize: 1000 } as PaperRecord

async function makePdf(pages: number): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([GEOM.pageWidth, GEOM.pageHeight])
    page.drawRectangle({ x: 50, y: 50, width: 100, height: 100, color: rgb(0.9, 0.9, 0.9) })
  }
  const bytes = await doc.save()
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

const fakePage = {
  getViewport: () => ({ rawDims: GEOM, width: GEOM.pageWidth, height: GEOM.pageHeight, rotation: 0 }),
  cleanup: () => undefined,
}

/** 假 pdf.js：报 numPages 页，每页同一几何 */
function fakeOpen(numPages: number) {
  const close = vi.fn(async () => undefined)
  const open = vi.fn(async (): Promise<OpenedPdf> => ({
    doc: { numPages, getPage: async () => fakePage } as unknown as OpenedPdf['doc'],
    close,
  }))
  return { open, close }
}

const input = (patch: Partial<ExportInput> = {}): ExportInput => ({
  paper: PAPER,
  blocks: BLOCKS,
  texts: TEXTS,
  flavor: 'pdf-zh-overlay',
  getBytes: () => makePdf(2),
  ...patch,
})

/** 失败路径在嵌字体之前就抛：字体 / fontkit 用占位 */
const stubDeps = async (openPdf: OpenPdf) => ({
  pdfLib: (await import('pdf-lib')) as PdfLibModule,
  fontkit: {} as FontkitModule,
  font: {} as CjkFont,
  openPdf,
})

const rejection = async (p: Promise<unknown>): Promise<ExportError> => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(ExportError)
    return e as ExportError
  }
  throw new Error('应当失败')
}

describe('exportPdfInPlace 失败分类', () => {
  it.each(['pdf-zh-overlay', 'pdf-both-flow'] as const)('%s：pdf.js 与 pdf-lib 页数不一致 → parse（而不是越界 RangeError → unknown），并关闭 pdf.js 文档', async (flavor) => {
    const { open, close } = fakeOpen(3)
    const e = await rejection(exportPdfInPlace(input({ flavor }), await stubDeps(open)))
    expect(e.code).toBe('parse')
    expect(e.message).toBe('原始 PDF 无法重写（页数读取不一致：pdf.js 3 页，pdf-lib 2 页）')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('getBytes 失败 → bytes：页面已讲清「原始文件…」的原样用，否则补上主语；不去打开 PDF', async () => {
    const { open } = fakeOpen(2)
    const deps = await stubDeps(open)
    const a = await rejection(
      exportPdfInPlace(input({ getBytes: () => Promise.reject(new ExportError('bytes', '原始文件不在本机且无法从服务端拉取')) }), deps),
    )
    expect(a.code).toBe('bytes')
    expect(a.message).toBe('原始文件不在本机且无法从服务端拉取')
    const b = await rejection(exportPdfInPlace(input({ getBytes: () => Promise.reject(new Error('登录已过期，请重新登录后重试')) }), deps))
    expect(b.code).toBe('bytes')
    expect(b.message).toBe('原始文件不在本机（登录已过期，请重新登录后重试）')
    expect(b.cause).toBeInstanceOf(Error)
    expect(open).not.toHaveBeenCalled()
  })

  it('getBytes 被取消 → aborted（不伪装成 bytes 触发回退）', async () => {
    const { open } = fakeOpen(2)
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    const e = await rejection(exportPdfInPlace(input({ getBytes: () => Promise.reject(abort) }), await stubDeps(open)))
    expect(e.code).toBe('aborted')
  })

  it('实际字节超过 40 MB → bytes（paper.byteSize 缺失 / 过期时的兜底）', async () => {
    const { open } = fakeOpen(2)
    const e = await rejection(exportPdfInPlace(input({ getBytes: async () => new ArrayBuffer(MAX_IN_PLACE_BYTES + 1) }), await stubDeps(open)))
    expect(e.code).toBe('bytes')
    expect(e.message).toBe('文件超过 40 MB（40.0 MB）')
    expect(open).not.toHaveBeenCalled()
    expect(oversizeError(0)).toBeNull()
    expect(oversizeError(MAX_IN_PLACE_BYTES)).toBeNull()
    expect(oversizeError(52 * 1048576)?.message).toBe('文件超过 40 MB（52.0 MB）')
  })

  it('pdf.js 打不开 / pdf-lib 读不了 → parse', async () => {
    const boom = vi.fn(async (): Promise<OpenedPdf> => {
      throw new Error('Invalid PDF structure')
    })
    const a = await rejection(exportPdfInPlace(input(), await stubDeps(boom)))
    expect(a.code).toBe('parse')
    expect(a.message).toBe('原始 PDF 无法打开（Invalid PDF structure）')

    const { open, close } = fakeOpen(1)
    const garbage = new TextEncoder().encode('not a pdf at all').buffer as ArrayBuffer
    const b = await rejection(exportPdfInPlace(input({ getBytes: async () => garbage }), await stubDeps(open)))
    expect(b.code).toBe('parse')
    expect(b.message.startsWith('原始 PDF 无法重写（')).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

const FONT = fileURLToPath(new URL('../../../assets/fonts/NotoSerifSC-sub.ttf', import.meta.url))

describe.skipIf(!fs.existsSync(FONT))('exportPdfInPlace 未译计数（真实字体）', () => {
  it('前提：覆盖版逐页规划时块 1 两页都报缺译（逐页求和会得 3）', () => {
    const blockOf = (i: number) => BLOCKS[i]
    const perPage = [1, 2].map((p) => {
      const pieces = buildPieces(segmentsOnPage(BLOCKS, p, GEOM), blockOf, 1, { round: false })
      return planOverlayPage({ geom: GEOM, pieces, texts: TEXTS, font: { metrics: { unitsPerEm: 1000, ascent: 800, descent: -200 }, measureAt: (t, s) => t.length * s } }).untranslatedBlocks
    })
    expect(perPage).toEqual([[1], [1, 2]])
  })

  it.each(['pdf-zh-overlay', 'pdf-both-flow'] as const)('%s：跨页缺译块只计一次', async (flavor) => {
    const buf = fs.readFileSync(FONT)
    const font = await createCjkFont(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
    const { open } = fakeOpen(2)
    const r = await exportPdfInPlace(input({ flavor }), {
      pdfLib: await import('pdf-lib'),
      fontkit: await loadFontkit(),
      font,
      openPdf: open,
      createCanvas: () => null,
    })
    expect(r.pageCount).toBe(2)
    // 覆盖版：块 1 在两页各有一片（逐页求和会得 3）；对照流：译文位只在块的最后一段
    expect(r.untranslated).toBe(2)
  }, 60_000)
})
