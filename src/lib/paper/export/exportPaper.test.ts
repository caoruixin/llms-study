import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaperBlock, PaperBlockKind, PaperRecord } from '../types'
import type { InPlaceResult } from './exportPdfInPlace'
import {
  countUntranslated,
  exportFileName,
  exportFlavorFor,
  exportPaperPdf,
  FLAVOR_LABEL,
  isInPlaceFlavor,
  MAX_IN_PLACE_BYTES,
  sanitizeFileStem,
  textFlavorOf,
} from './exportPaper'
import type { TextDocResult } from './exportTextDoc'
import { abortError, cssColorToRgb, ExportError, type ExportInput } from './exportTypes'

/** 编排层测试：两个执行器与字体下载 mock 掉（exportTextDoc 依赖的 runOps / finishDocument 仍是真的） */
const mocks = vi.hoisted(() => ({
  inPlace: vi.fn<(input: ExportInput, deps: unknown) => Promise<InPlaceResult>>(),
  text: vi.fn<(input: ExportInput, deps: unknown) => Promise<TextDocResult>>(),
  loadCjkFont: vi.fn(async () => ({})),
}))
vi.mock('./exportPdfInPlace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exportPdfInPlace')>()),
  exportPdfInPlace: mocks.inPlace,
}))
vi.mock('./exportTextDoc', () => ({ exportTextDoc: mocks.text }))
vi.mock('./cjkFont', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cjkFont')>()),
  loadCjkFont: mocks.loadCjkFont,
}))

describe('exportFlavorFor（A.0 口径）', () => {
  it('原文 → null；原版 PDF 视图且带几何 → 覆盖 / 对照流；其余 → 文本排版版', () => {
    expect(exportFlavorFor({ mode: 'original', pdfInPlace: true, langMode: 'orig' })).toBeNull()
    expect(exportFlavorFor({ mode: 'original', pdfInPlace: true, langMode: 'zh' })).toBe('pdf-zh-overlay')
    expect(exportFlavorFor({ mode: 'original', pdfInPlace: true, langMode: 'both' })).toBe('pdf-both-flow')
    // 带 layout 的 PDF 在文本视图下 → 文本排版版
    expect(exportFlavorFor({ mode: 'text', pdfInPlace: true, langMode: 'zh' })).toBe('text-zh')
    expect(exportFlavorFor({ mode: 'text', pdfInPlace: true, langMode: 'both' })).toBe('text-both')
    // 原版视图但没有几何（旧版解析 / 网页原貌）→ 文本排版版
    expect(exportFlavorFor({ mode: 'original', pdfInPlace: false, langMode: 'zh' })).toBe('text-zh')
    expect(exportFlavorFor({ mode: 'text', pdfInPlace: false, langMode: 'both' })).toBe('text-both')
  })

  it('FLAVOR_LABEL 覆盖四种版本；isInPlaceFlavor / textFlavorOf', () => {
    expect(Object.keys(FLAVOR_LABEL).sort()).toEqual(['pdf-both-flow', 'pdf-zh-overlay', 'text-both', 'text-zh'])
    expect(FLAVOR_LABEL['pdf-zh-overlay']).toBe('中文覆盖版')
    expect(isInPlaceFlavor('pdf-both-flow')).toBe(true)
    expect(isInPlaceFlavor('text-zh')).toBe(false)
    expect(textFlavorOf('pdf-zh-overlay')).toBe('text-zh')
    expect(textFlavorOf('pdf-both-flow')).toBe('text-both')
    expect(textFlavorOf('text-both')).toBe('text-both')
  })
})

describe('sanitizeFileStem / exportFileName', () => {
  it('去非法字符、折叠空白、去尾部 . 与空格、80 码点', () => {
    expect(sanitizeFileStem('  A/B:C*D?E"F<G>H|I\\J  K... ')).toBe('ABCDEFGHIJ K')
    expect(sanitizeFileStem('a\tb\n\nc')).toBe('a b c')
    expect(sanitizeFileStem('x'.repeat(100))).toHaveLength(80)
    expect(Array.from(sanitizeFileStem('汉'.repeat(100)))).toHaveLength(80)
    expect(sanitizeFileStem('...')).toBe('')
    // NFC：组合字符合并
    expect(sanitizeFileStem('é')).toBe('é')
  })

  it('stem 取 title → fileName 去扩展名 → paper；后缀按语言', () => {
    expect(exportFileName({ title: 'Attention Is All You Need', fileName: 'x.pdf' }, 'pdf-zh-overlay')).toBe('Attention Is All You Need.中文.pdf')
    expect(exportFileName({ title: 'A', fileName: 'x.pdf' }, 'pdf-both-flow')).toBe('A.中英对照.pdf')
    expect(exportFileName({ title: 'A', fileName: 'x.pdf' }, 'text-zh')).toBe('A.中文.pdf')
    expect(exportFileName({ title: 'A', fileName: 'x.pdf' }, 'text-both')).toBe('A.中英对照.pdf')
    expect(exportFileName({ title: '', fileName: 'report.final.docx' }, 'text-zh')).toBe('report.final.中文.pdf')
    expect(exportFileName({ title: '???', fileName: '' }, 'text-zh')).toBe('paper.中文.pdf')
  })
})

describe('countUntranslated', () => {
  const block = (index: number, kind: PaperBlockKind, text: string): PaperBlock => ({
    id: `b${index}`,
    paperId: 'p',
    index,
    kind,
    text,
    anchor: { kind: 'pdf', blockIndex: index },
  })

  it('只数可译体裁且非空、无译文的块', () => {
    const blocks = [block(0, 'heading', 'H'), block(1, 'paragraph', 'P'), block(2, 'formula', 'x'), block(3, 'caption', '  '), block(4, 'list', 'L')]
    expect(countUntranslated(blocks, new Map())).toBe(3)
    expect(countUntranslated(blocks, new Map([[0, '标题'], [4, '项']]))).toBe(1)
  })
})

describe('exportPaperPdf 回退（编排层）', () => {
  const PDF_BYTES = new Uint8Array([1, 2, 3])
  const blk = (index: number, kind: PaperBlockKind = 'paragraph'): PaperBlock => ({
    id: `b${index}`,
    paperId: 'p',
    index,
    kind,
    text: `Block ${index}.`,
    anchor: { kind: 'pdf', blockIndex: index, page: 1 },
  })
  const BLOCKS = [blk(0, 'heading'), blk(1), blk(2), blk(3, 'formula')]
  const paper = (byteSize = 1000) => ({ id: 'p', title: 'Attention', fileName: 'a.pdf', byteSize }) as PaperRecord
  const run = (patch: Partial<ExportInput> = {}) => {
    const getBytes = vi.fn(async () => new ArrayBuffer(8))
    const p = exportPaperPdf({ paper: paper(), blocks: BLOCKS, texts: new Map([[0, '引言']]), flavor: 'pdf-zh-overlay', getBytes, ...patch })
    return { p, getBytes }
  }

  beforeEach(() => {
    mocks.inPlace.mockReset()
    mocks.text.mockReset()
    mocks.text.mockResolvedValue({ bytes: PDF_BYTES, pageCount: 2, untranslated: 2 })
  })

  it('原版成功：untranslated 用执行器的实际计数（不是不分版本的预估）', async () => {
    mocks.inPlace.mockResolvedValue({ bytes: PDF_BYTES, pageCount: 9, untranslated: 1 })
    const r = await run().p
    expect(countUntranslated(BLOCKS, new Map([[0, '引言']]))).toBe(2)
    expect(r).toMatchObject({ flavor: 'pdf-zh-overlay', pageCount: 9, untranslated: 1, fileName: 'Attention.中文.pdf' })
    expect(r.fellBackToText).toBeUndefined()
    expect(mocks.text).not.toHaveBeenCalled()
  })

  it.each([
    ['pdf-zh-overlay', 'text-zh', '原始文件不在本机，已改为导出文本排版版（中文）', 'Attention.中文.pdf'],
    ['pdf-both-flow', 'text-both', '原始文件不在本机，已改为导出文本排版版（中英对照）', 'Attention.中英对照.pdf'],
  ] as const)('%s 拿不到原始字节（bytes）→ 自动改走 %s 并带提示', async (flavor, textFlavor, notice, fileName) => {
    mocks.inPlace.mockRejectedValue(new ExportError('bytes', '原始文件不在本机'))
    const r = await run({ flavor }).p
    expect(r.flavor).toBe(textFlavor)
    expect(r.fellBackToText).toBe(notice)
    expect(r.fileName).toBe(fileName)
    expect(r.untranslated).toBe(2)
    expect(mocks.text).toHaveBeenCalledTimes(1)
    expect(mocks.text.mock.calls[0][0].flavor).toBe(textFlavor)
  })

  it('解析失败（parse）同样回退，提示 = 原因 + 已改为导出…', async () => {
    mocks.inPlace.mockRejectedValue(new ExportError('parse', '原始 PDF 无法重写（页数读取不一致：pdf.js 3 页，pdf-lib 2 页）'))
    const r = await run().p
    expect(r.flavor).toBe('text-zh')
    expect(r.fellBackToText).toBe('原始 PDF 无法重写（页数读取不一致：pdf.js 3 页，pdf-lib 2 页），已改为导出文本排版版（中文）')
  })

  it('paper.byteSize 超过 40 MB：不调原版执行器、不取原始字节，直接文本排版版', async () => {
    const { p, getBytes } = run({ paper: paper(MAX_IN_PLACE_BYTES + 12 * 1048576) })
    const r = await p
    expect(mocks.inPlace).not.toHaveBeenCalled()
    expect(getBytes).not.toHaveBeenCalled()
    expect(r.flavor).toBe('text-zh')
    expect(r.fellBackToText).toBe('文件超过 40 MB（52.0 MB），已改为导出文本排版版（中文）')
  })

  it('文本排版版本身：不调原版执行器、不取原始字节、没有回退提示', async () => {
    const { p, getBytes } = run({ flavor: 'text-both' })
    const r = await p
    expect(mocks.inPlace).not.toHaveBeenCalled()
    expect(getBytes).not.toHaveBeenCalled()
    expect(r).toMatchObject({ flavor: 'text-both', untranslated: 2 })
    expect(r.fellBackToText).toBeUndefined()
  })

  it('其它错误不回退：unknown 原样上抛；取消仍是 aborted', async () => {
    mocks.inPlace.mockRejectedValueOnce(new Error('boom'))
    await expect(run().p).rejects.toMatchObject({ code: 'unknown', message: 'boom' })
    mocks.inPlace.mockRejectedValueOnce(abortError())
    await expect(run().p).rejects.toMatchObject({ code: 'aborted' })
    expect(mocks.text).not.toHaveBeenCalled()
  })

  it('回退途中已取消 → aborted，不再生成文本排版版', async () => {
    const ctrl = new AbortController()
    mocks.inPlace.mockImplementation(async () => {
      ctrl.abort()
      throw new ExportError('bytes', '原始文件不在本机')
    })
    await expect(run({ signal: ctrl.signal }).p).rejects.toMatchObject({ code: 'aborted' })
    expect(mocks.text).not.toHaveBeenCalled()
  })
})

describe('exportTypes 小工具', () => {
  it('cssColorToRgb：#rgb / #rrggbb / rgb() / rgba()；其它 → null', () => {
    expect(cssColorToRgb('#fff')).toEqual({ r: 1, g: 1, b: 1 })
    expect(cssColorToRgb('#1a1814')).toEqual({ r: 26 / 255, g: 24 / 255, b: 20 / 255 })
    expect(cssColorToRgb('rgb(255, 250, 240)')).toEqual({ r: 1, g: 250 / 255, b: 240 / 255 })
    expect(cssColorToRgb('rgba(0,0,0,0.5)')).toEqual({ r: 0, g: 0, b: 0 })
    expect(cssColorToRgb('white')).toBeNull()
  })

  it('ExportError 带 code', () => {
    const e = new ExportError('parse', 'x')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('parse')
    expect(e.name).toBe('ExportError')
  })
})
