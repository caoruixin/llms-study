// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import PdfFlowPage, { type FlowPageSize } from './PdfFlowPage'
import type { ZhSlice } from './PdfZhOverlay'
import { partitionPageFlow, segmentsOnPage, translationBounds } from '../../lib/paper/pdfLayout'
import { isTranslatableBlock } from '../../lib/paper/translate/translateBatch'
import type { PaperBlock, PaperBlockKind, PdfLayoutSeg } from '../../lib/paper/types'

/**
 * 段落对照流的 DOM 契约（renderToStaticMarkup：effect 不跑——位图裁切、文字层、取消纪律由 E2E 在浏览器里验）：
 * - 页容器 `#paper-page-N[data-page=N]`，**没有 height**（由条带 + 译文撑开）；尺寸未知 → 固定高度占位、无条带；
 * - 有块的条带带 `data-block-index`，文字层容器负偏移对齐本条带；
 * - 译文紧跟该块**最后一条**条带（跨栏块只在右栏首条带之后），三态都带 `data-block-index`，
 *   已译的再带 `data-translated="zh"` + `data-hl-host="zh"`；不可译块不出译文元素。
 */

/** renderToStaticMarkup 下 MemoryRouter 的 useLayoutEffect 告警是预期内的，滤掉免得淹没真错误 */
const realError = console.error
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('useLayoutEffect does nothing on the server')) return
    realError(...args)
  })
})
afterAll(() => {
  vi.restoreAllMocks()
})

const SIZE: FlowPageSize = { pageX: 0, pageY: 0, pageWidth: 600, pageHeight: 800, width: 600, height: 800 }

const lines = (x0: number, x1: number, yTop: number, n: number): PdfLayoutSeg['lines'] =>
  Array.from({ length: n }, (_, i) => [x0, yTop - i * 14, x1, 12] as [number, number, number, number])

const block = (index: number, kind: PaperBlockKind, text: string, segs: PdfLayoutSeg[]): PaperBlock => ({
  id: `b${index}`,
  paperId: 'p',
  index,
  kind,
  text,
  anchor: { kind: 'pdf', blockIndex: index, page: 1 },
  layout: { segs },
})

const PROSE = 'An ordinary English paragraph that reads like running prose in a two column paper.'

const BLOCKS: PaperBlock[] = [
  // 0：通栏标题（已译）
  block(0, 'heading', 'A Title Spanning Both Columns', [{ page: 1, col: 'span', lines: lines(100, 500, 740, 1) }]),
  // 1：左栏正文（未译 → 骨架）
  block(1, 'paragraph', PROSE, [{ page: 1, col: 'left', lines: lines(60, 290, 700, 4) }]),
  // 2：左栏公式（不可译 → 只有条带，没有译文元素）
  block(2, 'formula', 'x = y + z', [{ page: 1, col: 'left', lines: lines(120, 230, 630, 1) }]),
  // 3：跨栏正文：左栏底 + 右栏顶（失败 → 失败 chip 只在右栏那条之后）
  block(3, 'paragraph', PROSE, [
    { page: 1, col: 'left', lines: lines(60, 290, 590, 3) },
    { page: 1, col: 'right', lines: lines(310, 540, 700, 2) },
  ]),
  // 4：右栏正文（已译）
  block(4, 'paragraph', PROSE, [{ page: 1, col: 'right', lines: lines(310, 540, 660, 5) }]),
]

const rowsFor = (blocks: readonly PaperBlock[]) =>
  partitionPageFlow({ pageWidth: SIZE.pageWidth, pageHeight: SIZE.pageHeight, page: 1 }, segmentsOnPage(blocks, 1, SIZE), {
    isTranslatable: (i) => {
      const b = blocks.find((x) => x.index === i)
      return !!b && isTranslatableBlock(b.kind) && b.text.trim() !== ''
    },
  })

const ZH: ZhSlice = {
  texts: new Map([
    [0, '横跨两栏的标题'],
    [4, '右栏这一段的中文译文。'],
  ]),
  failed: new Set([3]),
  highlights: new Map(),
  authIssue: null,
  onRetry: () => undefined,
}

function render(over: Record<string, unknown> = {}): Document {
  const props = {
    lib: {},
    doc: {},
    pageNumber: 1,
    scale: 1,
    layoutTick: 0,
    active: false,
    size: SIZE,
    fallbackWidth: 612,
    fallbackHeight: 792,
    rows: rowsFor(BLOCKS),
    zh: ZH,
    onRenderError: () => undefined,
    ...over,
  }
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PdfFlowPage as never, props)))
  const doc = document.implementation.createHTMLDocument('t')
  doc.body.innerHTML = html
  return doc
}

/** 页容器内按文档序列出 [类名, 块序号] —— 断言「译文紧跟最后条带」用 */
const sequence = (doc: Document) =>
  Array.from(doc.querySelectorAll<HTMLElement>('.paper-flow-strip, .paper-flow-zh, .paper-flow-skel, .paper-flow-fail')).map(
    (el) => `${el.className.split(' ')[0].replace('paper-flow-', '')}:${el.getAttribute('data-block-index') ?? '-'}`,
  )

describe('PdfFlowPage DOM 契约', () => {
  it('页容器带 id / data-page / 宽度与三个 CSS 变量，没有 height', () => {
    const page = render().querySelector<HTMLElement>('[data-page="1"]')!
    expect(page.id).toBe('paper-page-1')
    expect(page.classList.contains('paper-flow-page')).toBe(true)
    expect(page.style.width).toBe('600px')
    expect(page.style.height).toBe('')
    expect(page.getAttribute('style')).toContain('--total-scale-factor:1')
  })

  it('通栏标题 → full 条带 + 译文；双栏 → 左右两列各一叠；跨栏块的译文只在右栏那条之后', () => {
    const doc = render()
    const rows = doc.querySelectorAll('.paper-flow-row')
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const cols = rows[0].querySelectorAll(':scope > .paper-flow-col')
    expect(cols).toHaveLength(2)
    // 左列：块 1 条带 + 骨架、块 2 条带（公式无译文）、块 3 左段条带（不是最后一段 → 无译文）
    const left = Array.from(cols[0].querySelectorAll<HTMLElement>('[data-block-index]')).map(
      (el) => `${el.className.split(' ')[0]}:${el.getAttribute('data-block-index')}`,
    )
    expect(left).toEqual(['paper-flow-strip:1', 'paper-flow-skel:1', 'paper-flow-strip:2', 'paper-flow-strip:3'])
    // 右列：块 3 右段条带 + 失败 chip，块 4 条带 + 译文
    const right = Array.from(cols[1].querySelectorAll<HTMLElement>('[data-block-index]')).map(
      (el) => `${el.className.split(' ')[0]}:${el.getAttribute('data-block-index')}`,
    )
    expect(right).toEqual(['paper-flow-strip:3', 'paper-flow-fail:3', 'paper-flow-strip:4', 'paper-flow-zh:4'])
    // 通栏标题在列之前：条带 + 译文
    const seq = sequence(doc)
    expect(seq.slice(0, 2)).toEqual(['strip:0', 'zh:0'])
  })

  it('译文三态的属性契约', () => {
    const doc = render()
    const zh = doc.querySelector<HTMLElement>('.paper-flow-zh[data-block-index="4"]')!
    expect(zh.getAttribute('data-translated')).toBe('zh')
    expect(zh.getAttribute('data-hl-host')).toBe('zh')
    expect(zh.textContent).toBe('右栏这一段的中文译文。')
    const skel = doc.querySelector('.paper-flow-skel')!
    expect(skel.getAttribute('data-block-index')).toBe('1')
    expect(skel.hasAttribute('data-translated')).toBe(false)
    const fail = doc.querySelector('.paper-flow-fail')!
    expect(fail.getAttribute('data-block-index')).toBe('3')
    expect(fail.hasAttribute('data-hl-host')).toBe(false)
    expect(fail.textContent).toContain('这一段翻译失败')
    // 不可译的公式块：没有任何译文元素
    expect(doc.querySelectorAll('[data-block-index="2"]')).toHaveLength(1)
  })

  it('条带：canvas + 整页文字层容器（负偏移对齐本条带）；无块的页眉 / 列尾条带不带 data-block-index', () => {
    const doc = render()
    const strips = Array.from(doc.querySelectorAll<HTMLElement>('.paper-flow-strip'))
    expect(strips.length).toBeGreaterThan(5)
    for (const s of strips) {
      expect(s.querySelector('canvas')).not.toBeNull()
      const text = s.querySelector<HTMLElement>('.paper-textlayer.paper-flow-text')!
      expect(text).not.toBeNull()
      expect(s.getAttribute('data-strip')).toBeTruthy()
    }
    // 右栏块 4 的条带：x = split 处，文字层 left 为负
    const s4 = doc.querySelector<HTMLElement>('.paper-flow-strip[data-block-index="4"]')!
    expect(parseFloat(s4.querySelector<HTMLElement>('.paper-flow-text')!.style.left)).toBeLessThan(0)
    expect(parseFloat(s4.querySelector<HTMLElement>('.paper-flow-text')!.style.top)).toBeLessThan(0)
    // 页眉（标题上方大段空白）独立成无块条带
    expect(strips.some((s) => !s.hasAttribute('data-block-index'))).toBe(true)
  })

  it('textBounds：译文框左右边对齐该块原文的文字范围（右栏块 4：x 310–540 → 左距 310−split，右距 600−540）', () => {
    const rows = rowsFor(BLOCKS)
    const split = rows.find((r) => r.kind === 'columns')
    if (!split || split.kind !== 'columns') throw new Error('expected a columns row')
    const doc = render({ rows, textBounds: new Map([[4, [310, 540] as const]]) })
    const zh = doc.querySelector<HTMLElement>('.paper-flow-zh[data-block-index="4"]')!
    expect(zh.style.marginLeft).toBe(`${Math.max(4, 310 - Math.round(split.split))}px`)
    expect(zh.style.marginRight).toBe('60px')
    // 没给范围的块沿用 CSS 默认外边距
    expect(doc.querySelector<HTMLElement>('.paper-flow-skel')!.style.marginLeft).toBe('')
  })

  it('translationBounds：只有一行短尾的块（x 60–140）译文框与整栏同宽（右缘 = 左栏文字右缘 290）；通栏单行标题保留自身宽度', () => {
    // 块 5：左栏单行短尾（图注末行「feedback loop.」那种），紧贴块 3 左段之下
    const blocks = [...BLOCKS, block(5, 'paragraph', 'feedback loop.', [{ page: 1, col: 'left', lines: lines(60, 140, 530, 1) }])]
    const bounds = translationBounds(segmentsOnPage(blocks, 1, SIZE), (i) => blocks.find((b) => b.index === i)?.kind)
    expect(bounds.get(5)).toEqual([60, 290]) // 不是片自己的 [60, 140]
    expect(bounds.get(4)).toEqual([310, 540])
    expect(bounds.get(0)).toEqual([100, 500]) // 通栏单行标题：自身宽度，不伸到全页右缘
    expect(bounds.get(3)).toEqual([310, 540]) // 跨栏块只给最后一片（右栏）

    const rows = rowsFor(blocks)
    const cols = rows.find((r) => r.kind === 'columns')
    if (!cols || cols.kind !== 'columns') throw new Error('expected a columns row')
    const zh: ZhSlice = { ...ZH, texts: new Map([...ZH.texts, [5, '反馈回路。']]) }
    const doc = render({ rows, textBounds: bounds, zh })
    const tail = doc.querySelector<HTMLElement>('.paper-flow-zh[data-block-index="5"]')!
    expect(tail.style.marginLeft).toBe('60px')
    // 右外边距 = 左栏条带右缘（split）− 栏文字右缘 290；按短尾自身右缘 140 算会是 split − 140 的窄框
    expect(tail.style.marginRight).toBe(`${Math.max(4, Math.round(cols.split) - 290)}px`)
    const title = doc.querySelector<HTMLElement>('.paper-flow-zh[data-block-index="0"]')!
    expect(title.style.marginLeft).toBe('100px')
    expect(title.style.marginRight).toBe('100px')
  })

  it('尺寸未知（size / rows 为 null）：固定高度占位，没有条带也没有译文', () => {
    const doc = render({ size: null, rows: null })
    const page = doc.querySelector<HTMLElement>('[data-page="1"]')!
    expect(page.style.width).toBe('612px')
    expect(page.querySelector('.paper-flow-strip')).toBeNull()
    expect(page.querySelector('[data-block-index]')).toBeNull()
    expect(page.querySelector<HTMLElement>(':scope > div')?.style.height).toBe('792px')
    // 未渲染占位标签（effect 不跑 → rendered 恒 false）
    expect(page.textContent).toContain('第 1 页')
  })
})
