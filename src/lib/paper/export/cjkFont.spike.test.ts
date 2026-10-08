import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { decodePDFRawStream, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * 导出 PDF 的硬门禁（PLAN A.2 spike）：pdf-lib + fontkit 嵌入 Noto Serif SC 子集，
 * 画 500 个不同 GB2312 汉字 + 中文标点，save() 后用 pdf.js 回读文本必须与所画完全一致
 * ——证明 pdf-lib 子集化后写出的 ToUnicode / cmap 映射正确；宽度与 fontkit 自测一致；体积受控。
 * 文本回读只验证映射，验不出字形轮廓是否完好：曾因字体 glyf 条目未 4 字节对齐，fontkit 子集化
 * 写短格式 loca 时偏移错位，导致嵌入字体里大量字形缺失而文本回读照样全对（肉眼/Preview 才看得出）。
 * 所以另有「嵌入字体轮廓」一条：把 PDF 里的 FontFile2 抠出来，逐字形比对原字体轮廓。
 * TTF 不在（子集资产未生成）时整组跳过。
 */
const TTF = fileURLToPath(new URL('../../../assets/fonts/NotoSerifSC-sub.ttf', import.meta.url))

const PUNCT = '，。、；：？！“”‘’（）《》—…'
const PER_LINE = 50
const LINES = 10

/** GB2312 双字节区位(首字节 B0–F7、次字节 A1–FE)解码,按固定步长取 500 个,一二级汉字都覆盖 */
function pickHanzi(count: number): string[] {
  const dec = new TextDecoder('gb2312')
  const all: string[] = []
  for (let hi = 0xb0; hi <= 0xf7; hi++) {
    for (let lo = 0xa1; lo <= 0xfe; lo++) {
      const ch = dec.decode(new Uint8Array([hi, lo]))
      if (ch.length === 1 && ch.charCodeAt(0) >= 0x4e00 && ch.charCodeAt(0) <= 0x9fff) all.push(ch)
    }
  }
  expect(all.length).toBe(6763)
  const step = Math.floor(all.length / count)
  return Array.from({ length: count }, (_, i) => all[i * step])
}

/** 拉丁 / 希腊 / 符号:ASCII + Latin-1 字母区 + 希腊小写 + 几个常见数学符号,切成每行 60 字 */
function latinLines(): string[] {
  const chars: string[] = []
  for (let c = 0x21; c <= 0x7e; c++) chars.push(String.fromCharCode(c))
  for (let c = 0xc0; c <= 0xff; c++) chars.push(String.fromCharCode(c))
  for (let c = 0x3b1; c <= 0x3c9; c++) chars.push(String.fromCharCode(c))
  chars.push(...'∑∫→□')
  const out: string[] = []
  for (let i = 0; i < chars.length; i += 60) out.push(chars.slice(i, i + 60).join(''))
  return out
}

/** 从 pdf-lib 写出的 PDF 里抠出嵌入的字体程序(FontDescriptor 的 FontFile2) */
async function extractEmbeddedFont(pdf: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf)
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.has(PDFName.of('FontFile2'))) {
      const stream = doc.context.lookup(obj.get(PDFName.of('FontFile2')))
      if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode()
    }
  }
  throw new Error('PDF 里没找到 FontFile2')
}

/** fontkit 的导入形态:vite 打包走 ES 构建(只有 default),node 原生走 UMD(module.exports) */
async function loadFontkit() {
  const mod = await import('@pdf-lib/fontkit')
  return (mod as unknown as { default?: typeof mod }).default ?? mod
}

/** 用 pdf.js(legacy 构建 + node 假 worker)取每页文本项,拼接后返回 */
async function readTextBack(pdf: Uint8Array): Promise<string> {
  const require = createRequire(import.meta.url)
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
  const task = pdfjs.getDocument({ data: new Uint8Array(pdf) })
  try {
    const doc = await task.promise
    let out = ''
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      for (const it of content.items) if ('str' in it) out += it.str
      page.cleanup()
    }
    return out
  } finally {
    await task.destroy()
  }
}

describe.skipIf(!fs.existsSync(TTF))('中文字体子集 × pdf-lib 嵌入 spike（硬门禁）', () => {
  const lines: string[] = []
  let pdfBytes: Uint8Array
  let widthOfSample = 0

  beforeAll(async () => {
    const hanzi = pickHanzi(PER_LINE * LINES)
    for (let i = 0; i < LINES; i++) lines.push(hanzi.slice(i * PER_LINE, (i + 1) * PER_LINE).join(''))
    lines.push(PUNCT, '汉字测试abc ABC 123', ...latinLines())

    const fontBytes = new Uint8Array(fs.readFileSync(TTF))
    const fontkit = await loadFontkit()
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(fontkit)
    const font = await pdf.embedFont(fontBytes, { subset: true })
    const page = pdf.addPage([595.28, 841.89])
    lines.forEach((text, i) => page.drawText(text, { x: 20, y: 800 - i * 20, size: 11, font }))
    pdfBytes = await pdf.save()
    widthOfSample = font.widthOfTextAtSize('汉字测试abc', 12)
  }, 30_000)

  it('500 个互异汉字 + 中文标点经 pdf.js 回读与所画文本完全一致', async () => {
    expect(new Set(lines.slice(0, LINES).join('')).size).toBe(PER_LINE * LINES)
    expect(new Set(PUNCT).size).toBe(PUNCT.length)
    const back = await readTextBack(pdfBytes)
    const strip = (s: string) => s.replace(/\s+/g, '')
    expect(strip(back)).toBe(strip(lines.join('')))
  }, 30_000)

  it('widthOfTextAtSize 与 fontkit 自测量（Σ advance × size / upm）误差 < 0.05pt', async () => {
    const fontkit = await loadFontkit()
    const f = fontkit.create(new Uint8Array(fs.readFileSync(TTF)))
    const text = '汉字测试abc'
    let sum = 0
    for (const ch of text) sum += (f.glyphForCodePoint(ch.codePointAt(0)!).advanceWidth * 12) / f.unitsPerEm
    expect(Math.abs(widthOfSample - sum)).toBeLessThan(0.05)
  })

  it('嵌入字体里每个字形的轮廓都与原字体一致（防 loca 错位导致字形缺失）', async () => {
    const fontkit = await loadFontkit()
    const orig = fontkit.create(new Uint8Array(fs.readFileSync(TTF)))
    const embedded = fontkit.create(await extractEmbeddedFont(pdfBytes))
    const used = [...new Set(lines.join(''))]
    // 期望集合:每个被画字符在原字体里的轮廓;实际集合:嵌入子集(去掉 gid 0 的 .notdef)里的全部轮廓
    const expected = used.map((ch) => orig.glyphForCodePoint(ch.codePointAt(0)!).path.toSVG())
    const actual: string[] = []
    for (let gid = 1; gid < embedded.numGlyphs; gid++) actual.push(embedded.getGlyph(gid).path.toSVG())
    expect(embedded.numGlyphs).toBe(used.length + 1)
    expect(actual.sort()).toEqual(expected.sort())
    // 汉字不会是空轮廓(空格才是),兜底防两边同时为空的假阳性
    expect(expected.filter((d) => d === '').length).toBe(1)
  })

  it('子集化后输出 < 400 KB', () => {
    expect(pdfBytes.byteLength).toBeLessThan(400 * 1024)
  })
})
