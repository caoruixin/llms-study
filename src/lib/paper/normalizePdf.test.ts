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

  it('表格数字行 / 公式碎片 / 轴标签不再被误判为编号标题（QA 实测垃圾样例）', () => {
    // attention.pdf Table 3 的数字行、公式碎片与图表轴标签：全都能匹配「数字起头」的编号标题形状
    const junk = ['1 512 512 5.29 24.9', '1 h', '1 2', '1 n 1 n i i', '1 2 4 8 16', '2 0.1 0.3']
    for (const text of junk) {
      const blocks = normalizePdf([linesPage(1, [text, 'Body text that follows the junk line'])])
      expect(blocks.filter((b) => b.kind === 'heading').map((b) => b.text)).toEqual([])
    }
  })

  it('真实编号标题仍被识别（中英文短章节名不被守卫误伤）', () => {
    const cases: [string, number][] = [
      ['3.2 Attention', 2],
      ['5 Training', 1],
      ['2 方法', 1],
      ['4.1 BLEU on WMT 2014 EN-DE', 2],
    ]
    for (const [text, level] of cases) {
      const blocks = normalizePdf([linesPage(1, [text, 'Body text under the section heading'])])
      expect(blocks[0]).toMatchObject({ kind: 'heading', level, text })
    }
  })

  it('垃圾行不再污染后续块的 anchor.section（已读章节 / § 标签的上游修复）', () => {
    const blocks = normalizePdf([
      linesPage(1, ['3.2 Attention', '1 512 512 5.29 24.9', 'The attention layer is described here.']),
    ])
    // 数字行退回普通段落，section 仍停留在真正的标题上
    expect(blocks.filter((b) => b.kind === 'heading')).toHaveLength(1)
    expect(blocks.every((b) => b.anchor.section === '3.2 Attention')).toBe(true)
  })

  it('大字号短行标题同样要求实词密度：纯数字行不因字号大而成为标题', () => {
    const page: PdfPageText = {
      page: 1,
      items: [
        item('body line one of the paragraph', 72, 700, 10),
        item('12 3 45', 72, 660, 14), // 字号更大但没有实词
        item('body line two of the paragraph', 72, 640, 10),
      ],
    }
    expect(normalizePdf([page]).filter((b) => b.kind === 'heading')).toEqual([])
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

  it('双栏页：左右栏不再被拼成一行，而是按「先左栏后右栏」还原阅读序', () => {
    // 版心 60..550：左栏 60..290，分栏槽 290..320，右栏 320..550
    const rows = 8
    const items: PdfTextItem[] = []
    for (let i = 0; i < rows; i++) {
      const y = 700 - i * 14
      items.push(item(`left line ${i} of the first column here`, 60, y, 10, 230))
      items.push(item(`right line ${i} of the second column here`, 320, y, 10, 230))
    }
    const text = normalizePdf([{ page: 1, items }])
      .map((b) => b.text)
      .join('\n')
    const at = (s: string) => text.indexOf(s)

    // 关键回归：同一 y 上的左右栏不得被拼进同一行——
    // 修复前 "left line 0 …" 与 "right line 0 …" 会紧挨着出现
    expect(text.slice(at('left line 0'), at('left line 1'))).not.toContain('right line')
    expect(at('left line 0')).toBeLessThan(at('left line 7'))
    expect(at('left line 7')).toBeLessThan(at('right line 0'))
    expect(at('right line 0')).toBeLessThan(at('right line 7'))
  })

  it('双栏页的通栏标题不被拆开，且排在两栏正文之前', () => {
    const rows = 8
    const items: PdfTextItem[] = [
      // 通栏标题：单个文本项横跨分栏槽
      item('A Full Width Title Across Both Columns', 60, 730, 14, 490),
    ]
    for (let i = 0; i < rows; i++) {
      const y = 700 - i * 14
      items.push(item(`left body ${i} continues in this column`, 60, y, 10, 230))
      items.push(item(`right body ${i} continues in this column`, 320, y, 10, 230))
    }
    const blocks = normalizePdf([{ page: 1, items }])
    const texts = blocks.map((b) => b.text)
    expect(texts[0]).toContain('A Full Width Title Across Both Columns')
    expect(texts[0]).not.toContain('left body')
    expect(texts.join('\n').indexOf('left body 0')).toBeLessThan(texts.join('\n').indexOf('right body 0'))
  })

  it('通栏元素把页面分成带：带内先左后右，带与带之间保持先后', () => {
    const items: PdfTextItem[] = []
    for (let i = 0; i < 5; i++) {
      const y = 700 - i * 14
      items.push(item(`upper left ${i} text of the column`, 60, y, 10, 230))
      items.push(item(`upper right ${i} text of the column`, 320, y, 10, 230))
    }
    items.push(item('Figure 1: a full width caption spanning the page.', 60, 600, 10, 490))
    for (let i = 0; i < 5; i++) {
      const y = 560 - i * 14
      items.push(item(`lower left ${i} text of the column`, 60, y, 10, 230))
      items.push(item(`lower right ${i} text of the column`, 320, y, 10, 230))
    }
    const text = normalizePdf([{ page: 1, items }])
      .map((b) => b.text)
      .join('\n')
    const at = (s: string) => text.indexOf(s)
    expect(at('upper left 0')).toBeLessThan(at('upper right 0'))
    expect(at('upper right 4')).toBeLessThan(at('Figure 1'))
    expect(at('Figure 1')).toBeLessThan(at('lower left 0'))
    expect(at('lower left 4')).toBeLessThan(at('lower right 0'))
  })

  it('单栏页不受双栏逻辑影响：居中短行不会被误判成两栏', () => {
    const items: PdfTextItem[] = []
    for (let i = 0; i < 8; i++) {
      // 每行由两个文本项组成，词间空隙落在版心中部（但远小于分栏槽宽度）
      const y = 700 - i * 14
      items.push(item(`single column line ${i}`, 60, y, 10, 240))
      items.push(item(`continues to the right edge`, 306, y, 10, 240))
    }
    const blocks = normalizePdf([{ page: 1, items }])
    expect(blocks[0].text).toContain('single column line 0 continues to the right edge')
  })

  it('双栏跨栏续段：左栏末行未收句则与右栏首行并为同一段', () => {
    const items: PdfTextItem[] = []
    for (let i = 0; i < 6; i++) {
      const y = 700 - i * 14
      items.push(item(i === 5 ? 'the method consists of two stages which' : `left filler line ${i} of column one`, 60, y, 10, 230))
      items.push(item(i === 0 ? 'are trained jointly.' : `right filler line ${i} of column two`, 320, y, 10, 230))
    }
    const text = normalizePdf([{ page: 1, items }])
      .map((b) => b.text)
      .join('\n')
    expect(text).toContain('the method consists of two stages which are trained jointly.')
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
