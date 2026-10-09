// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import PdfZhOverlay, { type ZhPageData } from './PdfZhOverlay'
import type { PaperBlock, PaperBlockKind, PaperHighlight, PdfLayoutSeg } from '../../lib/paper/types'

/**
 * 中文覆盖的 DOM 契约（renderToStaticMarkup：effect / layout effect 不跑——字号拟合、取样、闪烁都不在这里验，
 * 真实排版由 E2E 在浏览器里量）。这里钉住的是 selectionOffsets / SelectionActions / anchorFromElement
 * 依赖的属性契约与三态：
 * - 已译正文 → `.paper-zh-block[data-block-index][data-translated="zh"]`，单片才带 `data-hl-host="zh"`；
 * - 未译 → 只描边骨架（无 data-translated，不可选中）；失败 → 紧凑失败签；非正文版面 / 图内标签 / 不可译 → 不出元素；
 * - 跨栏块的两片拼回整段译文、都不带宿主属性。
 */

/** renderToStaticMarkup 必然触发「useLayoutEffect does nothing on the server」：预期内，滤掉免得淹没真错误 */
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

const GEOM = { pageX: 0, pageY: 0, pageWidth: 600, pageHeight: 800 }

/** 行框 [x0, yTop, x1, h]（PDF 用户空间，y 向上）：从 yTop 起每行下移 14 */
const lines = (x0: number, x1: number, yTop: number, n: number, last = x1): PdfLayoutSeg['lines'] =>
  Array.from({ length: n }, (_, i) => [x0, yTop - i * 14, i === n - 1 ? last : x1, 12] as [number, number, number, number])

const block = (index: number, kind: PaperBlockKind, text: string, segs: PdfLayoutSeg[]): PaperBlock => ({
  id: `b${index}`,
  paperId: 'p',
  index,
  kind,
  text,
  anchor: { kind: 'pdf', blockIndex: index, page: 1 },
  layout: { segs },
})

const PROSE = 'This is an ordinary English paragraph with enough words to look like running prose text.'

const BLOCKS: PaperBlock[] = [
  // 0：通栏正文 3 行（已译 + 高亮）
  block(0, 'paragraph', PROSE, [{ page: 1, col: 'full', lines: lines(60, 540, 760, 3, 400) }]),
  // 1：左栏正文（未译 → 骨架）
  block(1, 'paragraph', PROSE, [{ page: 1, col: 'left', lines: lines(60, 290, 700, 4, 200) }]),
  // 2：左栏正文（失败 → 紧凑失败签）
  block(2, 'paragraph', PROSE, [{ page: 1, col: 'left', lines: lines(60, 290, 630, 3, 250) }]),
  // 3：公式块（不可译 + 非正文版面 → 不出元素）
  block(3, 'formula', 'E = mc^2 + 1', [{ page: 1, col: 'left', lines: lines(120, 230, 570, 1) }]),
  // 4：跨栏正文：左栏底 2 行 + 右栏顶 2 行（已译 → 两片按行数拆分，都不带宿主）
  block(4, 'paragraph', PROSE, [
    { page: 1, col: 'left', lines: lines(60, 290, 540, 2) },
    { page: 1, col: 'right', lines: lines(310, 540, 700, 2, 450) },
  ]),
  // 5：插图里的孤立短标签（右栏中部、离栏左缘 30%）→ 不出任何元素（未译时也不出骨架）
  block(5, 'paragraph', 'AI R&D', [{ page: 1, col: 'right', lines: lines(380, 420, 400, 1) }]),
]

const ZH4 = '第一句译文在左栏，比较长一些。第二句译文接在右栏。'

const hl = (id: string, blockIndex: number, start: number, end: number, text: string): PaperHighlight =>
  ({ id, paperId: 'p', blockId: `p:${blockIndex}`, blockIndex, lang: 'zh', start, end, text, createdAt: 0, updatedAt: 0 }) as PaperHighlight

function render(over: Partial<ZhPageData> = {}, wrapRouter = false): Document {
  const props = {
    page: 1,
    scale: 1,
    geom: GEOM,
    canvasRef: { current: null },
    blocks: BLOCKS,
    texts: new Map([
      [0, '这是第一段的中文译文。'],
      [4, ZH4],
    ]),
    failed: new Set([2]),
    highlights: new Map([[0, [hl('h1', 0, 2, 5, '第一段')]]]),
    authIssue: null,
    onRetry: () => undefined,
    flash: { pending: null, handlers: new Map() },
    ...over,
  }
  const el = createElement(PdfZhOverlay as never, props)
  const html = renderToStaticMarkup(wrapRouter ? createElement(MemoryRouter, null, el) : el)
  const doc = document.implementation.createHTMLDocument('t')
  doc.body.innerHTML = html
  return doc
}

describe('PdfZhOverlay DOM 契约', () => {
  it('层容器 .paper-zhlayer；已译单片块带三属性、译文与高亮 mark；版式只写框与底色，不写字号', () => {
    const doc = render()
    const layer = doc.querySelector('.paper-zhlayer')
    expect(layer).not.toBeNull()
    const b0 = doc.querySelector<HTMLElement>('.paper-zh-block[data-block-index="0"]')!
    expect(b0.getAttribute('data-translated')).toBe('zh')
    expect(b0.getAttribute('data-hl-host')).toBe('zh')
    expect(b0.textContent).toBe('这是第一段的中文译文。')
    expect(b0.querySelector('mark[data-highlight-id="h1"]')?.textContent).toBe('第一段')
    // 覆盖框 = 行框并集外扩（上 0.1、下 0.15 行高，左右 1px）：x 60 → 59，宽 480 → 482
    expect(b0.style.left).toBe('59px')
    expect(b0.style.width).toBe('482px')
    // 页面 CSS 空间：y = 800 − 760 = 40，上扩 round(1.2) = 1
    expect(b0.style.top).toBe('39px')
    // 字号 / 行高由 layout effect 批量拟合后命令式写入：React 的 style 里不能有（否则重渲染会冲掉拟合结果）
    expect(b0.style.fontSize).toBe('')
    expect(b0.style.lineHeight).toBe('')
    // canvas 不可用时底色回退白
    expect(b0.style.background).toMatch(/#fff|rgb\(255, 255, 255\)/)
  })

  it('未译 → 只描边的骨架（不带 data-translated，不可选中）；失败 → 紧凑失败签带重试', () => {
    const doc = render()
    const skel = doc.querySelectorAll('.paper-zh-skel')
    expect(skel).toHaveLength(1)
    expect(skel[0].hasAttribute('data-translated')).toBe(false)
    expect(skel[0].textContent).toBe('')
    expect(doc.querySelector('[data-block-index="1"]')).toBeNull()
    const fail = doc.querySelector('.paper-zh-fail')!
    expect(fail.textContent).toContain('这一段翻译失败')
    expect(fail.querySelector('button')?.textContent).toBe('重试')
    // 失败不覆盖原文：没有该块的译文块
    expect(doc.querySelector('.paper-zh-block[data-block-index="2"]')).toBeNull()
  })

  it('公式块（不可译 / 非正文版面）不出任何元素', () => {
    const doc = render({ texts: new Map([[3, '公式']]) })
    expect(doc.querySelector('[data-block-index="3"]')).toBeNull()
    expect(doc.querySelectorAll('.paper-zh-block, .paper-zh-skel, .paper-zh-fail')).toHaveLength(
      // 0 骨架、1 骨架、2 失败、4 两片骨架；3 不出
      5,
    )
  })

  it('图内标签（pdfLayout.isLabelLike）：已译也不盖译文框、未译不出骨架——示意图保持原样', () => {
    const translated = render({ texts: new Map([[5, '人工智能研发']]) })
    expect(translated.querySelector('[data-block-index="5"]')).toBeNull()
    // 默认渲染里块 5 未译：骨架只给 1 号块（0、4 已译，2 失败）
    expect(render().querySelectorAll('.paper-zh-skel')).toHaveLength(1)
  })

  it('跨栏块：两片按行数拆分、拼回整段译文；两片都不带 data-hl-host（单片 textContent ≠ 整段）', () => {
    const doc = render()
    const parts = Array.from(doc.querySelectorAll<HTMLElement>('.paper-zh-block[data-block-index="4"]'))
    expect(parts).toHaveLength(2)
    for (const p of parts) {
      expect(p.getAttribute('data-translated')).toBe('zh')
      expect(p.hasAttribute('data-hl-host')).toBe(false)
      expect(p.textContent).not.toBe('')
    }
    expect(parts.map((p) => p.textContent).join('')).toBe(ZH4)
  })

  it('auth 细分：未配 key 的失败签带设置页链接（Link 需要 Router）', () => {
    const doc = render({ authIssue: 'no-user-key' }, true)
    const fail = doc.querySelector('.paper-zh-fail')!
    expect(fail.textContent).toContain('尚未配置 DeepSeek Key')
    expect(fail.querySelector('a')?.getAttribute('href')).toBe('/settings')
  })

  it('本页没有块：空层，不出任何子元素', () => {
    const doc = render({ blocks: [] })
    expect(doc.querySelector('.paper-zhlayer')?.children).toHaveLength(0)
  })
})
