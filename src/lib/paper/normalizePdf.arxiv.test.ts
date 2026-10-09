import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { normalizePdf, toTextItem, type PdfPageText, type PdfTextItem, type RawTextItem, type RawTextStyle } from './normalizePdf'
import type { NormalizedBlock } from './types'

/**
 * 真实 PDF 集成检查（arXiv 2609.36054v1「What if automating AI R&D triggers an intelligence explosion?」：
 * 双栏、10pt 分栏槽、通栏框、「标题 ⎮ page N of 14」页脚、上标脚注标、参考文献悬挂缩进）。
 * 样本是未跟踪文件（.e2e-qa-fixtures/），CI 里不存在时整组跳过。
 * pdf.js 走 legacy 构建 + node 假 worker；文本项转换与生产完全相同（normalizePdf.toTextItem）。
 */
const FIXTURE = fileURLToPath(new URL('../../../.e2e-qa-fixtures/pdf-inline/arxiv-2609.36054v1.pdf', import.meta.url))

async function loadPages(): Promise<PdfPageText[]> {
  const require = createRequire(import.meta.url)
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
  const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(FIXTURE)) })
  try {
    const doc = await task.promise
    const pages: PdfPageText[] = []
    for (let i = 1; i <= doc.numPages; i++) {
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
    return pages
  } finally {
    await task.destroy()
  }
}

describe.skipIf(!fs.existsSync(FIXTURE))('normalizePdf × arXiv 2609.36054v1（真实 PDF）', () => {
  let blocks: NormalizedBlock[] = []
  let pageCount = 0

  beforeAll(async () => {
    const pages = await loadPages()
    pageCount = pages.length
    expect(pages.some((p) => p.items.some((it) => it.ascent !== undefined))).toBe(true)
    blocks = normalizePdf(pages)
  }, 60_000)

  const around = (needle: string, radius = 3): NormalizedBlock[] => {
    const i = blocks.findIndex((b) => b.text.includes(needle))
    if (i < 0) return []
    return blocks.slice(Math.max(0, i - radius), i + radius)
  }

  it('打印「Diminishing returns」前后 6 块供人工核对', () => {
    const excerpt = around('Diminishing returns')
    expect(excerpt.length).toBeGreaterThan(0)
    for (const b of excerpt) {
      const segs = b.layout?.segs.map((s) => `p${s.page}/${s.col}×${s.lines.length}`).join(' ') ?? '(no layout)'
      console.log(`#${b.index} [${b.kind}] {${segs}} ${b.text}`)
    }
  })

  it('(a) 没有任何块含「page N of M」页脚', () => {
    expect(pageCount).toBe(14)
    const hits = blocks.filter((b) => /\bpage\s+\d+\s+of\s+\d+\b/i.test(b.text))
    expect(hits.map((b) => `#${b.index}: ${b.text.slice(0, 80)}`)).toEqual([])
    // 页脚左半「What if automating AI R&D triggers an intelligence explosion?」只保留首页标题，不在正文块里重复
    const footers = blocks.filter((b) => b.kind !== 'heading' && /^What if automating AI R&D triggers an intelligence explosion\?$/.test(b.text))
    expect(footers).toEqual([])
  })

  it('(b) 「Diminishing returns」段不混入右栏的「own attempts and learn」（左右栏逐行交错的症状）', () => {
    const block = blocks.find((b) => b.text.includes('Diminishing returns'))
    expect(block).toBeDefined()
    expect(block!.text).not.toContain('own attempts and learn')
    expect(block!.text).toContain('Evidence suggests that diminishing returns would not prevent an intelligence explosion')
    // 右栏首行接在左栏末段之后（「models generate their own attempts…」是跨栏续段）
    const data = blocks.find((b) => b.text.startsWith('Data.'))
    expect(data?.text).toContain('models generate their own attempts and learn from whether those attempts succeed')
  })

  it('(c) 每块都带 layout：segs ≥ 1，每行 4 个数、1 位小数、页码合法', () => {
    const oneDecimal = (n: number) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-6
    for (const b of blocks) {
      expect(b.layout?.segs.length ?? 0).toBeGreaterThanOrEqual(1)
      for (const seg of b.layout!.segs) {
        expect(seg.page).toBeGreaterThanOrEqual(1)
        expect(seg.page).toBeLessThanOrEqual(pageCount)
        expect(seg.lines.length).toBeGreaterThanOrEqual(1)
        for (const line of seg.lines) {
          expect(line).toHaveLength(4)
          expect(line.every(oneDecimal)).toBe(true)
          const [x0, , x1, h] = line
          expect(x1).toBeGreaterThanOrEqual(x0)
          expect(h).toBeGreaterThan(0)
        }
      }
    }
  })

  it('(d) 块数在 120–400 之间', () => {
    const headings = blocks.filter((b) => b.kind === 'heading')
    console.log(`arXiv 2609.36054v1: ${blocks.length} blocks, ${headings.length} headings`)
    console.log(`headings: ${headings.map((h) => `${h.text} (p${h.anchor.page})`).join(' | ')}`)
    expect(blocks.length).toBeGreaterThanOrEqual(120)
    expect(blocks.length).toBeLessThanOrEqual(400)
  })
})
