import { describe, expect, it } from 'vitest'
import { countChars, normalizePdf, pickPdfTitle, styleAscent, toTextItem, type PdfPageText, type PdfTextItem } from './normalizePdf'

/** 造一个文本项：x/y 是 PDF 坐标（y 向上增大），width 按字符数粗估；extra 可覆盖任意字段（ascent / 旋转 transform） */
const item = (
  str: string,
  x: number,
  y: number,
  height = 10,
  width = str.length * 5,
  extra?: Partial<PdfTextItem>,
): PdfTextItem => ({
  str,
  transform: [height, 0, 0, height, x, y],
  width,
  height,
  ...extra,
})

/**
 * 双栏页的文本项：n 行，左栏 left..left+width、右栏 right..right+width（缺省版心 60..550，分栏槽 290..320）。
 * 行文本带页标签（a / b / c …）：跨页同文的顶行会被当成重复页眉删掉，fixture 不能撞上这条规则。
 */
const twoColumnItems = (
  page: number,
  n: number,
  opts: { top?: number; left?: number; right?: number; width?: number; height?: number; gap?: number } = {},
): PdfTextItem[] => {
  const { top = 700, left = 60, right = 320, width = 230, height = 10, gap = 14 } = opts
  const tag = String.fromCharCode(96 + page)
  const items: PdfTextItem[] = []
  for (let i = 0; i < n; i++) {
    const y = top - i * gap
    items.push(item(`left ${tag} line ${i} of the column`, left, y, height, width))
    items.push(item(`right ${tag} line ${i} of the column`, right, y, height, width))
  }
  return items
}
const twoColumnPage = (page: number, n: number, opts?: Parameters<typeof twoColumnItems>[2]): PdfPageText => ({
  page,
  items: twoColumnItems(page, n, opts),
})

/** 通栏行：单个文本项横跨版心（缺省 70..540） */
const wideItem = (str: string, y: number, h = 10, x0 = 70, x1 = 540): PdfTextItem => item(str, x0, y, h, x1 - x0)

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

// ---------------------------------------------------------------------------
// PARSER_VERSION 3：分栏忽略通栏行 / 页眉页脚 / 字号与缩进断段 / 版面几何
// ---------------------------------------------------------------------------

const joined = (pages: PdfPageText[]) => normalizePdf(pages).map((b) => b.text).join('\n')

describe('normalizePdf · 分栏检测忽略通栏行', () => {
  it('通栏框页：20 行二栏 + 6 条宽行 + 页眉「… page 4 of 14」→ 左右不互穿、框行自成块、页眉消失', () => {
    const items: PdfTextItem[] = [
      wideItem('What if automating AI R&D triggers an intelligence explosion? page 4 of 14', 790, 9, 60, 550),
      ...twoColumnItems(1, 20, { top: 740 }),
    ]
    // 右栏末行收句，通栏框从新段开始；框内 6 行同 x0 同字号、行距正常 → 一个块
    items[items.length - 1] = item('right a line 19 of the column.', 320, 740 - 19 * 14, 10, 230)
    const box = [
      'Box 1: Key terms used throughout this paper',
      'An intelligence explosion is a period in which AI systems',
      'rapidly and recursively improve their own capabilities',
      'through automated research and development, with the',
      'effective research workforce expanding far faster than',
      'any human organization could sustain on its own.',
    ]
    box.forEach((t, i) => items.push(wideItem(t, 450 - i * 14, 10)))

    const blocks = normalizePdf([{ page: 1, items }])
    const text = blocks.map((b) => b.text).join('\n')
    const at = (s: string) => text.indexOf(s)
    // 缺陷 1：修复前通栏行把整页判成单栏，同一 y 的左右栏被拼成一行
    expect(text.slice(at('left a line 0'), at('left a line 1'))).not.toContain('right')
    expect(at('left a line 19')).toBeLessThan(at('right a line 0'))
    expect(at('right a line 19')).toBeLessThan(at('Box 1'))
    // 框行自成块：不含任何栏内文本，layout 是单个 span seg
    const boxBlock = blocks.find((b) => b.text.startsWith('Box 1'))!
    expect(boxBlock.text).toContain('any human organization could sustain on its own.')
    expect(boxBlock.text).not.toMatch(/left a|right a/)
    expect(boxBlock.layout?.segs.map((s) => [s.page, s.col, s.lines.length])).toEqual([[1, 'span', 6]])
    // 缺陷 2：页眉按「page N of M」形状直接删
    expect(text).not.toContain('page 4 of 14')
    expect(text).not.toContain('What if automating')
  })

  it('文档级回退：第 3 页只剩 3 行二栏 + 1 条图注，沿用其它页的分栏槽', () => {
    const page3: PdfPageText = {
      page: 3,
      items: [...twoColumnItems(3, 3), wideItem('Figure 3: a caption that spans the whole page width.', 600)],
    }
    const text = joined([twoColumnPage(1, 20), twoColumnPage(2, 20), page3])
    const at = (s: string) => text.indexOf(s)
    expect(text.slice(at('left c line 0'), at('left c line 1'))).not.toContain('right c')
    expect(at('left c line 2')).toBeLessThan(at('right c line 0'))
    expect(at('right c line 2')).toBeLessThan(at('Figure 3'))
  })

  it('单页只有 3 行二栏且没有其它页可参考 → 仍按单栏（不凭空发明分栏槽）', () => {
    const text = joined([{ page: 1, items: twoColumnItems(1, 3) }])
    // 同一 y 的左右栏项被拼成一行：这是单栏处理的既定行为，不是本例要修的
    expect(text).toContain('left a line 0 of the column right a line 0 of the column')
  })

  it('旋转项（arXiv 竖排水印）不出现在任何块里，也不干扰分栏', () => {
    const items = [
      ...twoColumnItems(1, 8),
      item('arXiv:2609.36054v1 [cs.CY] 28 Sep 2026', 20, 500, 10, 200, { transform: [0, 10, -10, 0, 20, 500] }),
    ]
    const text = joined([{ page: 1, items }])
    expect(text).not.toContain('arXiv:2609')
    const at = (s: string) => text.indexOf(s)
    expect(at('left a line 7')).toBeLessThan(at('right a line 0'))
  })
})

describe('normalizePdf · 页眉页脚', () => {
  const WORDS = ['alpha', 'beta', 'gamma', 'delta']
  /** 一页：页眉 + 5 行正文（末行收句）+ 页脚；正文用不同词避免跨页同文 */
  const runningPage = (page: number, header: string, footer: string, headerHeight = 9): PdfPageText => {
    const w = WORDS[page - 1]
    return {
      page,
      items: [
        item(header, 72, 760, headerHeight, 200),
        ...[0, 1, 2, 3].map((i) => item(`${w} body line ${i} continues the paragraph`, 72, 740 - i * 14)),
        item(`${w} body line four ends the paragraph.`, 72, 740 - 4 * 14),
        item(footer, 72, 600, 9, 120),
      ],
    }
  }

  it('4 页重复页眉 / 页脚全部删除，正文完整', () => {
    const pages = [1, 2, 3, 4].map((p) => runningPage(p, 'Journal of Artificial Intelligence Research', 'Preprint under review'))
    const blocks = normalizePdf(pages)
    const text = blocks.map((b) => b.text).join('\n')
    expect(text).not.toContain('Journal of Artificial')
    expect(text).not.toContain('Preprint under review')
    expect(blocks).toHaveLength(4)
    blocks.forEach((b, i) => {
      expect(b.text.startsWith(`${WORDS[i]} body line 0`)).toBe(true)
      expect(b.text.endsWith('ends the paragraph.')).toBe(true)
      expect(b.anchor.page).toBe(i + 1)
    })
  })

  it('首页大字标题与后续页页眉同文：标题（字号大）保留并成为 heading，页眉删除', () => {
    const title = 'Intelligence Explosion Dynamics'
    const pages = [
      runningPage(1, title, 'Preprint under review', 18),
      ...[2, 3, 4].map((p) => runningPage(p, title, 'Preprint under review')),
    ]
    const blocks = normalizePdf(pages)
    expect(blocks[0]).toMatchObject({ kind: 'heading', text: title, anchor: { page: 1 } })
    expect(blocks[0].layout).toEqual({ segs: [{ page: 1, col: 'full', lines: [[72, 774.4, 272, 18]] }] })
    expect(blocks.filter((b) => b.text.includes(title))).toHaveLength(1)
  })

  it('2 页顶行各异 → 全部保留（不重复就不是页眉）', () => {
    const text = joined([
      linesPage(1, ['Alpha opening line of the first page.', 'Alpha second line of the first page.']),
      linesPage(2, ['Beta opening line of the second page.', 'Beta second line of the second page.']),
    ])
    for (const s of ['Alpha opening', 'Alpha second', 'Beta opening', 'Beta second']) expect(text).toContain(s)
  })

  it('单页「page 3 of 12」按形状删除（无需跨页重复）', () => {
    const blocks = normalizePdf([linesPage(1, ['Body text of a single page document.', 'More body text here.', 'page 3 of 12'])])
    // 首行是本页最宽行（不算「短行收句」），两行并为一段；页脚行整条消失
    expect(blocks.map((b) => b.text)).toEqual(['Body text of a single page document. More body text here.'])
  })

  it('「page N of M」是独立文本项时只剥掉它：同一行的首页脚注保留', () => {
    const page: PdfPageText = {
      page: 1,
      items: [
        item('Body paragraph line one of the page', 72, 700),
        item('body paragraph line two ends here.', 72, 686),
        item('*The views are the authors’ own and not of their employers.', 72, 560, 9, 300),
        item('page 1 of 14', 500, 560, 9, 50),
      ],
    }
    const texts = normalizePdf([page]).map((b) => b.text)
    expect(texts).toContain('*The views are the authors’ own and not of their employers.')
    expect(texts.join('\n')).not.toContain('page 1 of 14')
  })

  it('大字标题不会因为出现在页顶带里被当页眉删掉（高度守卫）', () => {
    const blocks = normalizePdf([linesPage(1, ['A Big Title Line', 'body text under the title.'], { height: 10 })].map((p) => ({
      ...p,
      items: p.items.map((it, i) => (i === 0 ? item(it.str, 72, 700, 18, 120) : it)),
    })))
    expect(blocks[0]).toMatchObject({ kind: 'heading', text: 'A Big Title Line' })
  })
})

describe('normalizePdf · 字号与缩进断段', () => {
  it('栏底 8pt 脚注独立成块，且右栏首行不并入脚注（跨栏字号规则）', () => {
    const items: PdfTextItem[] = []
    for (let i = 0; i < 6; i++) {
      const y = 700 - i * 14
      if (i < 5) items.push(item(`left line ${i} continues without a period`, 60, y, 10, 230))
      else items.push(item('¹ See the appendix for the derivation.', 60, y, 8, 180))
      items.push(item(`right line ${i} continues without a period`, 320, y, 10, 230))
    }
    const texts = normalizePdf([{ page: 1, items }]).map((b) => b.text)
    expect(texts).toContain('¹ See the appendix for the derivation.')
    const left = texts.find((t) => t.startsWith('left line 0'))!
    expect(left).not.toContain('appendix')
    const right = texts.find((t) => t.startsWith('right line 0'))!
    expect(right).not.toContain('appendix')
  })

  it('9pt 图注与 10pt 正文分开（8% 阈值）', () => {
    const page: PdfPageText = {
      page: 1,
      items: [
        item('Body text line one of the paragraph', 72, 700),
        item('body text line two of the paragraph', 72, 686),
        item('body text line three without a period', 72, 672),
        item('Figure 2: The mechanism has two parts that', 72, 658, 9),
        item('reinforce each other in a feedback loop.', 72, 644, 9),
      ],
    }
    const texts = normalizePdf([page]).map((b) => b.text)
    expect(texts).toHaveLength(2)
    expect(texts[1]).toBe('Figure 2: The mechanism has two parts that reinforce each other in a feedback loop.')
  })

  it('左边界跳变断段：A(72,72,72) / B(82,72) → 两块（首行缩进不作数，由第 2 行确立边界）', () => {
    const page: PdfPageText = {
      page: 1,
      items: [
        item('alpha first line of the paragraph', 72, 700),
        item('alpha second line of the paragraph', 72, 686),
        item('alpha third line without a period', 72, 672),
        item('beta first line is indented', 82, 658),
        item('beta second line is flush left', 72, 644),
      ],
    }
    const texts = normalizePdf([page]).map((b) => b.text)
    expect(texts).toEqual([
      'alpha first line of the paragraph alpha second line of the paragraph alpha third line without a period',
      'beta first line is indented beta second line is flush left',
    ])
  })

  it('悬挂缩进列表（参考文献）：每条自成一块', () => {
    const page: PdfPageText = {
      page: 1,
      items: [
        item('[1] First reference entry by Some Authors', 72, 700),
        item('with the rest of the title on this line', 82, 686),
        item('[2] Second reference entry by Other Authors', 72, 672),
        item('continued on the hanging indent line', 82, 658),
      ],
    }
    const texts = normalizePdf([page]).map((b) => b.text)
    expect(texts).toEqual([
      '[1] First reference entry by Some Authors with the rest of the title on this line',
      '[2] Second reference entry by Other Authors continued on the hanging indent line',
    ])
  })

  it('主导字号：带 7pt 上标与一个 14pt 符号的行仍按 10pt 计，不触发字号断段', () => {
    const page: PdfPageText = {
      page: 1,
      items: [
        item('The method was proposed by Smith et al.', 72, 700),
        item('12', 270, 703, 7, 8),
        item('Σ', 285, 700, 14, 10),
        item('and later extended to several other domains', 72, 686),
      ],
    }
    const blocks = normalizePdf([page])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('The method was proposed by Smith et al. 12 Σ and later extended to several other domains')
  })

  it('同字号同缩进的普通段落不受新规则影响（回归）', () => {
    const blocks = normalizePdf([linesPage(1, ['First line of the paragraph', 'second line of the paragraph', 'third line ends here.'])])
    expect(blocks).toHaveLength(1)
  })
})

describe('normalizePdf · layout（块级行框）', () => {
  it('单栏 3 行：一个 full seg，每行 [x0, yTop = y + 0.8h, x1, h]，1 位小数', () => {
    const blocks = normalizePdf([linesPage(1, ['First line of text', 'second line of text', 'third line of text.'])])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].layout).toEqual({
      segs: [{ page: 1, col: 'full', lines: [[72, 708, 162, 10], [72, 694, 167, 10], [72, 680, 167, 10]] }],
    })
  })

  it('ascent=0.9 的项：yTop = y + 9，高度仍为字号', () => {
    const blocks = normalizePdf([{ page: 1, items: [item('ascent aware line', 72, 700, 10, 85, { ascent: 0.9 })] }])
    expect(blocks[0].layout).toEqual({ segs: [{ page: 1, col: 'full', lines: [[72, 709, 157, 10]] }] })
  })

  it('坐标取 1 位小数且不出现 -0', () => {
    const blocks = normalizePdf([{ page: 1, items: [item('precise line', 72.345, 100.04, 10.91, 60.26)] }])
    const [x0, yTop, x1, h] = blocks[0].layout!.segs[0].lines[0]
    expect([x0, yTop, x1, h]).toEqual([72.3, 108.8, 132.6, 10.9])
    expect(Object.is(h, -0)).toBe(false)
  })

  it('跨栏续段：两个 seg（left → right），各 1 行', () => {
    const items: PdfTextItem[] = []
    for (let i = 0; i < 6; i++) {
      const y = 700 - i * 14
      items.push(item(i === 5 ? 'the method consists of two stages which' : `left filler line ${i} of column one`, 60, y, 10, 230))
      items.push(item(i === 0 ? 'are trained jointly.' : `right filler line ${i} of column two`, 320, y, 10, 230))
    }
    // fixture 里每行都是满栏宽（width 230），于是左栏 6 行 + 右栏 6 行是同一段：两个 seg，各 6 行
    const block = normalizePdf([{ page: 1, items }]).find((b) => b.text.includes('two stages which are trained'))!
    expect(block.layout?.segs.map((s) => [s.page, s.col, s.lines.length])).toEqual([
      [1, 'left', 6],
      [1, 'right', 6],
    ])
    // 左栏末行（y = 630）与右栏首行（y = 700）的盒子：yTop = y + 8
    expect(block.layout?.segs[0].lines[5]).toEqual([60, 638, 290, 10])
    expect(block.layout?.segs[1].lines[0]).toEqual([320, 708, 550, 10])
  })

  it('跨页续段：两个 seg（第 1 页 → 第 2 页）', () => {
    const blocks = normalizePdf([
      linesPage(1, ['The method consists of two stages which']),
      linesPage(2, ['are trained jointly.']),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].layout?.segs.map((s) => [s.page, s.col, s.lines.length])).toEqual([
      [1, 'full', 1],
      [2, 'full', 1],
    ])
  })

  it('heading 块同样带 layout', () => {
    const blocks = normalizePdf([linesPage(1, ['1 Introduction', 'Some body text here.'])])
    expect(blocks[0].kind).toBe('heading')
    expect(blocks[0].layout).toEqual({ segs: [{ page: 1, col: 'full', lines: [[72, 708, 142, 10]] }] })
  })
})

describe('normalizePdf · 通栏段落的左对齐短尾', () => {
  /**
   * 双栏页：上方 12 行二栏（右栏末行收句）→ 通栏图注 3 行（y 560 / 546 / 532）→ 图注之后的内容由各例自给。
   * 图注短尾（只占左半版）在 rowsToLines 里是 'left'；修复前块的 segs = [span × 3, left × 1]，对照视图译文被塞进左栏且只有短尾那么宽。
   */
  const pageWithCaption = (caption: PdfTextItem[], below: PdfTextItem[]): PdfPageText => {
    const items = twoColumnItems(1, 12, { top: 740 })
    items[items.length - 1] = item('right a line 11 of the column.', 320, 740 - 11 * 14, 10, 230)
    return { page: 1, items: [...items, ...caption, ...below] }
  }
  const segsOf = (b: { layout?: { segs: { page: number; col: string; lines: unknown[] }[] } } | undefined) =>
    b?.layout?.segs.map((s) => [s.page, s.col, s.lines.length])
  /** 图注之下的二栏正文：左栏 x 60、右栏 x 320，各 n 行 */
  const lowerColumns = (top: number, n: number): PdfTextItem[] =>
    Array.from({ length: n }, (_, i) => [
      item(`lower left line ${i} of the body text`, 60, top - i * 14, 10, 230),
      item(`lower right line ${i} of the body text`, 320, top - i * 14, 10, 230),
    ]).flat()

  it('3 条通栏行 + 同 x0 起头的短尾 → 一个块、一个 span seg、4 行；其后的左栏正文照旧自成一块', () => {
    const caption = [
      wideItem('Figure 2. The mechanism for a software-driven intelligence explosion has two', 560),
      wideItem('parts: AI systems expand the effective R&D workforce as they get better, and', 546),
      wideItem('this workforce produces still better AI systems that expand it in a recursive', 532),
      item('feedback loop.', 70, 518, 10, 70),
    ]
    const blocks = normalizePdf([pageWithCaption(caption, lowerColumns(480, 4))])
    const cap = blocks.find((b) => b.text.startsWith('Figure 2.'))!
    expect(cap.text.endsWith('in a recursive feedback loop.')).toBe(true)
    expect(segsOf(cap)).toEqual([[1, 'span', 4]])
    expect(cap.layout!.segs[0].lines[3]).toEqual([70, 526, 140, 10])
    const body = blocks.find((b) => b.text.startsWith('lower left line 0'))!
    expect(body.layout!.segs[0].col).toBe('left')
  })

  it('已收句的通栏图注之后、同 x0 的左栏新段 → 照旧跨栏断段，自成一块（left seg 起头）', () => {
    const caption = [
      wideItem('Figure 3. A caption that spans the full width of the page and keeps going', 560, 10, 60, 550),
      wideItem('for a couple of lines before it finally ends with a complete sentence here.', 546, 10, 60, 550),
    ]
    const blocks = normalizePdf([pageWithCaption(caption, lowerColumns(518, 4))])
    expect(segsOf(blocks.find((b) => b.text.startsWith('Figure 3.')))).toEqual([[1, 'span', 2]])
    const body = blocks.find((b) => b.text.startsWith('lower left line 0'))!
    expect(body.layout!.segs[0]).toMatchObject({ page: 1, col: 'left' })
  })

  it('左边界对不齐（x0 差 > 半个字号）的左栏行不改写：照旧另起 left seg', () => {
    const caption = [
      wideItem('Figure 4. A caption that spans the full width of the page and keeps going', 560),
      wideItem('without any terminal punctuation on its last wide line so it does not end', 546),
    ]
    // 图注 x0 = 70，下方左栏 x0 = 60：差 10 > max(3, 10 × 0.5)
    const blocks = normalizePdf([pageWithCaption(caption, lowerColumns(532, 4))])
    const cap = blocks.find((b) => b.text.startsWith('Figure 4.'))!
    expect(segsOf(cap)?.[0]).toEqual([1, 'span', 2])
    expect(segsOf(cap)?.[1]?.[1]).toBe('left')
  })

  it('短尾只改写自己：短尾（未收句）之后隔大行距的左栏行不接力并成通栏', () => {
    const caption = [
      wideItem('Figure 5. A caption that spans the full width of the page and keeps going', 560, 10, 60, 550),
      wideItem('on the next line as well and then wraps into a short tail that has no', 546, 10, 60, 550),
      item('terminal mark', 60, 532, 10, 65),
    ]
    const blocks = normalizePdf([pageWithCaption(caption, lowerColumns(500, 4))])
    expect(segsOf(blocks.find((b) => b.text.startsWith('Figure 5.')))).toEqual([[1, 'span', 3]])
    const body = blocks.find((b) => b.text.startsWith('lower left line 0'))!
    expect(body.layout!.segs[0].col).toBe('left')
  })
})

describe('toTextItem / styleAscent（pdf.js 文本项转换）', () => {
  it('过滤 TextMarkedContent，ascent 取 styles[fontName].ascent 并钳到 [0.5, 1.2]', () => {
    const styles = { f1: { ascent: 0.752, descent: -0.221 }, f2: { ascent: 0, descent: -0.3 }, f3: { ascent: 5 }, f4: {} }
    const raw = (fontName: string) => ({ str: 'x', transform: [10, 0, 0, 10, 1, 2], width: 5, height: 10, fontName })
    expect(toTextItem({ type: 'beginMarkedContent' } as never, styles)).toBeNull()
    expect(toTextItem(raw('f1'), styles)?.ascent).toBe(0.752)
    expect(toTextItem(raw('f2'), styles)?.ascent).toBeCloseTo(0.7) // ascent 为 0 → 1 + descent
    expect(toTextItem(raw('f3'), styles)?.ascent).toBe(1.2)
    expect(toTextItem(raw('f4'), styles)?.ascent).toBeUndefined()
    expect(toTextItem(raw('missing'), styles)?.ascent).toBeUndefined()
    expect(toTextItem(raw('f1'))).toMatchObject({ str: 'x', width: 5, height: 10, hasEOL: false })
    expect(toTextItem(raw('f1'))?.ascent).toBeUndefined()
    expect(styleAscent({ ascent: 0.3 })).toBe(0.5)
    expect(styleAscent({ ascent: Number.NaN })).toBeUndefined()
  })
})

describe('normalizePdf · 编号标题字号守卫', () => {
  const body = (top: number) =>
    [0, 1, 2, 3, 4].map((i) => item(`body line ${i} of the paragraph text`, 72, top - i * 14))

  it('10pt 正文下的 9pt「1. Machine-learning venues …」（尾注）是段落，不是标题', () => {
    const page: PdfPageText = {
      page: 1,
      items: [...body(700), item('1. Machine-learning venues typically have a main conference', 72, 620, 9)],
    }
    const blocks = normalizePdf([page])
    expect(blocks.filter((b) => b.kind === 'heading')).toEqual([])
    expect(blocks.at(-1)).toMatchObject({ kind: 'paragraph', text: '1. Machine-learning venues typically have a main conference' })
    expect(blocks.every((b) => b.anchor.section === undefined)).toBe(true)
  })

  it('10pt 正文下的 10pt「3.2 Method」仍是标题；关键词标题不看字号', () => {
    const page: PdfPageText = {
      page: 1,
      items: [...body(700), item('3.2 Method', 72, 620, 10), item('References', 72, 600, 9)],
    }
    const headings = normalizePdf([page]).filter((b) => b.kind === 'heading')
    expect(headings.map((h) => [h.text, h.level])).toEqual([
      ['3.2 Method', 2],
      ['References', 1],
    ])
  })
})

describe('normalizePdf · 编号标题形状守卫', () => {
  const body = (top: number) =>
    [0, 1, 2, 3, 4].map((i) => item(`body line ${i} of the paragraph text`, 72, top - i * 14))

  it('「2 · 106–2 · 108. As in the main text, this assumes that」（10pt 正文下 10pt）是段落：正文以 · 起头且含句界', () => {
    const junk = '2 · 106–2 · 108. As in the main text, this assumes that'
    const blocks = normalizePdf([{ page: 1, items: [...body(700), item(junk, 72, 620, 10)] }])
    expect(blocks.filter((b) => b.kind === 'heading')).toEqual([])
    expect(blocks.at(-1)).toMatchObject({ kind: 'paragraph', text: junk })
    // 两条守卫各自也要独立命中
    expect(normalizePdf([linesPage(1, ['3 × 4 grid layout', 'Body text under it'])]).filter((b) => b.kind === 'heading')).toEqual([])
    expect(normalizePdf([linesPage(1, ['2 Results were mixed. Next we discuss them', 'Body text under it'])]).filter((b) => b.kind === 'heading')).toEqual([])
  })

  it('真实编号标题不受形状守卫影响：3.2 Method / 4.1.2 Detail / 1 Introduction', () => {
    const blocks = normalizePdf([linesPage(1, ['1 Introduction', 'Some body text here.', '3.2 Method', 'More body text here.', '4.1.2 Detail'])])
    expect(blocks.filter((b) => b.kind === 'heading').map((h) => [h.text, h.level])).toEqual([
      ['1 Introduction', 1],
      ['3.2 Method', 2],
      ['4.1.2 Detail', 3],
    ])
  })
})

describe('normalizePdf · 多行大字标题合并', () => {
  /** 10pt 正文 5 行（定出正文字号），从 top 起 */
  const body = (top: number) =>
    [0, 1, 2, 3, 4].map((i) => item(`body line ${i} of the paragraph text`, 72, top - i * 14))
  const headings = (blocks: ReturnType<typeof normalizePdf>) => blocks.filter((b) => b.kind === 'heading')

  it('18pt 标题排成两行（末行以 ? 收尾）→ 一个 heading，layout 带两行行框，后续块的 section 是整条标题', () => {
    const page: PdfPageText = {
      page: 1,
      items: [
        item('What if automating AI R&D triggers an', 72, 760, 18, 300),
        item('intelligence explosion?', 120, 738, 18, 200),
        ...body(700),
      ],
    }
    const blocks = normalizePdf([page])
    const title = 'What if automating AI R&D triggers an intelligence explosion?'
    expect(headings(blocks)).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 2, text: title })
    expect(blocks[0].layout).toEqual({
      segs: [{ page: 1, col: 'full', lines: [[72, 774.4, 372, 18], [120, 752.4, 320, 18]] }],
    })
    expect(blocks[1]).toMatchObject({ kind: 'paragraph', anchor: { section: title } })
  })

  it('两行都单独够格的大字标题（无行尾标点）同样合并；三行标题在整条已收句后停止', () => {
    const two = normalizePdf([
      { page: 1, items: [item('Automating AI R&D could trigger an', 72, 760, 14), item('intelligence explosion', 72, 743, 14), ...body(700)] },
    ])
    expect(headings(two).map((h) => h.text)).toEqual(['Automating AI R&D could trigger an intelligence explosion'])
    const three = normalizePdf([
      {
        page: 1,
        items: [
          item('Can automated research', 72, 760, 18),
          item('explode?', 72, 738, 18),
          item('A Second Big Heading', 72, 716, 18),
          ...body(680),
        ],
      },
    ])
    expect(headings(three).map((h) => h.text)).toEqual(['Can automated research explode?', 'A Second Big Heading'])
  })

  it('连续两条编号标题各自独立（编号 / 关键词标题不合并）', () => {
    const blocks = normalizePdf([
      { page: 1, items: [item('3 Method', 72, 760, 12), item('3.1 Overview of the system', 72, 745, 12), ...body(700)] },
    ])
    expect(headings(blocks).map((h) => h.text)).toEqual(['3 Method', '3.1 Overview of the system'])
    const kw = normalizePdf([
      { page: 1, items: [item('Abstract', 72, 760, 14), item('A Big Line Right Below', 72, 743, 14), ...body(700)] },
    ])
    expect(headings(kw).map((h) => h.text)).toEqual(['Abstract', 'A Big Line Right Below'])
  })

  it('大字标题后接正文行 → heading + paragraph（正文行不是大字号，不并入标题）', () => {
    const blocks = normalizePdf([{ page: 1, items: [item('A Big Title Line', 72, 720, 18, 120), ...body(700)] }])
    expect(blocks[0]).toMatchObject({ kind: 'heading', text: 'A Big Title Line' })
    expect(blocks[1]).toMatchObject({ kind: 'paragraph' })
    expect(blocks[1].text.startsWith('body line 0')).toBe(true)
  })

  it('间距过大（> 1.6 行高）或字号差 > 5% → 两条独立标题', () => {
    const far = normalizePdf([
      { page: 1, items: [item('First Big Heading', 72, 760, 18), item('Second Big Heading', 72, 728, 18), ...body(700)] },
    ])
    expect(headings(far).map((h) => h.text)).toEqual(['First Big Heading', 'Second Big Heading'])
    const sizes = normalizePdf([
      { page: 1, items: [item('Chapter Level Heading', 72, 760, 18), item('Section Level Heading', 72, 740, 16), ...body(700)] },
    ])
    expect(headings(sizes).map((h) => h.text)).toEqual(['Chapter Level Heading', 'Section Level Heading'])
  })
})

describe('pickPdfTitle（元数据标题 vs 首个 heading）', () => {
  const H = 'What if automating AI R&D triggers an intelligence explosion?'

  it('元数据标题干净 → 用元数据（去首尾空白）', () => {
    expect(pickPdfTitle('  Attention Is All You Need ', 'Abstract')).toBe('Attention Is All You Need')
  })

  it('元数据含连续空白 / 控制字符 → 用首个 heading', () => {
    expect(pickPdfTitle('What if automating AI R   D triggers an intelligence explosion?', H)).toBe(H)
    expect(pickPdfTitle('Broken\u0001Title', 'Real Title')).toBe('Real Title')
    expect(pickPdfTitle('Line one\nline two', 'Real Title')).toBe('Real Title')
  })

  it('元数据坏了且没有 heading → 折叠空白后的元数据标题', () => {
    expect(pickPdfTitle('What if automating AI R   D triggers', undefined)).toBe('What if automating AI R D triggers')
    expect(pickPdfTitle('Tab\tseparated\u0000title', '  ')).toBe('Tab separated title')
  })

  it('没有元数据 → 首个 heading；都没有 → undefined', () => {
    expect(pickPdfTitle(undefined, H)).toBe(H)
    expect(pickPdfTitle('   ', H)).toBe(H)
    expect(pickPdfTitle(undefined, undefined)).toBeUndefined()
    expect(pickPdfTitle('', '')).toBeUndefined()
  })
})
