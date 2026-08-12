import { describe, expect, it } from 'vitest'
import { countChars, normalizePdf, type PdfPageText, type PdfTextItem } from './normalizePdf'

/** 造一个文本项：x/y 是 PDF 坐标（y 向上增大），width 按字符数粗估 */
const item = (str: string, x: number, y: number, height = 10, width = str.length * 5): PdfTextItem => ({
  str,
  transform: [height, 0, 0, height, x, y],
  width,
  height,
})

/** 一行一个文本项的便捷构造：行距 14pt，自上而下 */
const linesPage = (page: number, lines: string[], opts?: { top?: number; gap?: number; height?: number }): PdfPageText => {
  const top = opts?.top ?? 700
  const gap = opts?.gap ?? 14
  return {
    page,
    items: lines.map((t, i) => item(t, 72, top - i * gap, opts?.height ?? 10)),
  }
}

describe('normalizePdf', () => {
  it('空输入与空页 → 空数组', () => {
    expect(normalizePdf([])).toEqual([])
    expect(normalizePdf([{ page: 1, items: [] }])).toEqual([])
    expect(normalizePdf([{ page: 1, items: [item('   ', 72, 700)] }])).toEqual([])
  })

  it('同一行内文本项乱序时按 x 升序修复（公式/多列的常见症状）', () => {
    const blocks = normalizePdf([
      {
        page: 1,
        items: [item('world', 120, 700, 10, 30), item('hello', 72, 700, 10, 30)],
      },
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('hello world')
  })

  it('中文相邻文本项拼接时不插入空格', () => {
    const blocks = normalizePdf([
      { page: 1, items: [item('注意力', 72, 700, 10, 30), item('机制', 120, 700, 10, 20)] },
    ])
    expect(blocks[0].text).toBe('注意力机制')
  })

  it('编号标题被识别为 heading 并带层级', () => {
    const blocks = normalizePdf([linesPage(1, ['1 Introduction', 'Some body text here.', '3.2.1 Detail'])])
    const headings = blocks.filter((b) => b.kind === 'heading')
    expect(headings.map((h) => [h.text, h.level])).toEqual([
      ['1 Introduction', 1],
      ['3.2.1 Detail', 3],
    ])
  })

  it('关键词标题（Abstract / 参考文献）被识别，并写进后续块的 anchor.section', () => {
    const blocks = normalizePdf([linesPage(1, ['Abstract', 'We propose a new method here'])])
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1, text: 'Abstract' })
    expect(blocks[1]).toMatchObject({ kind: 'paragraph' })
    expect(blocks[1].anchor.section).toBe('Abstract')

    const zh = normalizePdf([linesPage(1, ['参考文献', '张三等，2024'])])
    expect(zh[0]).toMatchObject({ kind: 'heading', text: '参考文献' })
  })

  it('纯页码行被丢弃', () => {
    const blocks = normalizePdf([linesPage(1, ['Body line one continues', '42'])])
    expect(blocks.map((b) => b.text)).toEqual(['Body line one continues'])
  })

  it('跨页续段：上页末行未收句则与下页首行并为同一段，anchor 保留起始页', () => {
    const blocks = normalizePdf([
      linesPage(1, ['The method consists of two stages which']),
      linesPage(2, ['are trained jointly.']),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('The method consists of two stages which are trained jointly.')
    expect(blocks[0].anchor.page).toBe(1)
  })

  it('上页已收句则不跨页合并，下页首行另起一段并记录第 2 页', () => {
    const blocks = normalizePdf([
      linesPage(1, ['The method consists of two stages.']),
      linesPage(2, ['We now describe the training loop.']),
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks[1].anchor.page).toBe(2)
  })

  it('同页大行距断段（空行）', () => {
    const page: PdfPageText = {
      page: 1,
      items: [
        item('First paragraph line one', 72, 700),
        item('still the same paragraph', 72, 686),
        item('A new paragraph after a blank line', 72, 620), // 行距 66 ≫ 14
      ],
    }
    const blocks = normalizePdf([page])
    expect(blocks).toHaveLength(2)
    expect(blocks[1].text).toBe('A new paragraph after a blank line')
  })

  it('块序号连续，且 anchor.blockIndex 与 index 一致', () => {
    const blocks = normalizePdf([linesPage(1, ['1 Introduction', 'Body A here.', '', '2 Method', 'Body B here.'])])
    blocks.forEach((b, i) => {
      expect(b.index).toBe(i)
      expect(b.anchor.blockIndex).toBe(i)
      expect(b.anchor.kind).toBe('pdf')
    })
  })
})

describe('countChars', () => {
  it('累加所有块的文本长度', () => {
    const blocks = normalizePdf([linesPage(1, ['abc'])])
    expect(countChars(blocks)).toBe(3)
    expect(countChars([])).toBe(0)
  })
})
