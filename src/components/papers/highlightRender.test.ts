import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import BlockReader from './BlockReader'
import type { PaperBlock, PaperBlockKind, PaperHighlight } from '../../lib/paper/types'

/**
 * 高亮渲染冒烟（node 环境，renderToStaticMarkup——effect 不跑，IntersectionObserver 不会被触碰）。
 * 目的：mark 落在正确的字符区间与正确的语言宿主里、快照失配被过滤、
 * table 分支不带宿主、list 的 '·' 前缀不进偏移口径。
 */

const block = (index: number, kind: PaperBlockKind, text: string, html?: string): PaperBlock => ({
  id: `p1:${index}`,
  paperId: 'p1',
  index,
  kind,
  text,
  ...(kind === 'heading' ? { level: 2 } : {}),
  ...(html !== undefined ? { html } : {}),
  anchor: { kind: 'pdf', blockIndex: index, page: 1 },
})

const hl = (id: string, blockIndex: number, lang: 'orig' | 'zh', start: number, end: number, text: string): PaperHighlight => ({
  id,
  paperId: 'p1',
  blockIndex,
  blockId: `p1:${blockIndex}`,
  lang,
  start,
  end,
  text,
  createdAt: 1,
})

const noop = () => undefined
const containerRef = { current: null }

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(BlockReader as never, { containerRef, onVisibleBlock: noop, ...props }))
}

describe('高亮渲染冒烟', () => {
  it('paragraph：mark 在正确区间，带 data-highlight-id 与宿主标记', () => {
    const html = render({
      blocks: [block(0, 'paragraph', 'The quick brown fox')],
      highlights: new Map([[0, [hl('h1', 0, 'orig', 4, 9, 'quick')]]]),
    })
    expect(html).toContain('data-hl-host="orig"')
    expect(html).toContain('data-highlight-id="h1"')
    expect(html).toContain('<mark')
    // 切分正确：mark 只包住 quick，前后文完整保留
    expect(html).toMatch(/The <\/span><mark[^>]*>quick<\/mark><span[^>]*> brown fox/)
  })

  it("list：宿主在内层 span，'·' 前缀不进 mark 也不进宿主", () => {
    const html = render({
      blocks: [block(0, 'list', 'first item')],
      highlights: new Map([[0, [hl('h1', 0, 'orig', 0, 5, 'first')]]]),
    })
    // '·' 在宿主 span 之外
    expect(html).toMatch(/·<\/span><span data-hl-host="orig">/)
    expect(html).toMatch(/<mark[^>]*data-highlight-id="h1"[^>]*>first<\/mark>/)
    expect(html).not.toMatch(/<mark[^>]*>[^<]*·/)
  })

  it('heading / code / formula 宿主齐全；table 分支不带宿主', () => {
    // table 用无 html 的 pre 兜底分支：DOMPurify 在 node 环境不可用，
    // 而「table 分支不带宿主」对两个子分支同样成立
    const html = render({
      blocks: [
        block(0, 'heading', 'Introduction'),
        block(1, 'code', 'x = 1'),
        block(2, 'formula', 'E = mc^2'),
        block(3, 'table', 'a | b'),
      ],
    })
    // heading/code/formula 各有一个 orig 宿主，table 没有 → 共 3 个
    expect(html.match(/data-hl-host="orig"/g)).toHaveLength(3)
    const tablePart = html.slice(html.indexOf('paper-block-3'))
    expect(tablePart).not.toContain('data-hl-host')
  })

  it('快照失配的行不渲染 mark（重解析容错），一致的行照常渲染', () => {
    const html = render({
      blocks: [block(0, 'paragraph', 'hello world')],
      highlights: new Map([
        [0, [hl('stale', 0, 'orig', 0, 5, '早已对不上'), hl('good', 0, 'orig', 6, 11, 'world')]],
      ]),
    })
    expect(html).not.toContain('data-highlight-id="stale"')
    expect(html).toMatch(/<mark[^>]*data-highlight-id="good"[^>]*>world<\/mark>/)
  })

  it('对照模式：zh 高亮只进译文宿主，orig 高亮只进原文宿主', () => {
    const html = render({
      blocks: [block(0, 'paragraph', 'hello world')],
      langMode: 'both',
      translations: new Map([[0, '你好世界']]),
      highlights: new Map([
        [0, [hl('ho', 0, 'orig', 0, 5, 'hello'), hl('hz', 0, 'zh', 0, 2, '你好')]],
      ]),
    })
    // 原文宿主段落里只有 orig 的 mark
    const origPart = html.slice(html.indexOf('data-hl-host="orig"'), html.indexOf('data-hl-host="zh"'))
    expect(origPart).toContain('data-highlight-id="ho"')
    expect(origPart).not.toContain('data-highlight-id="hz"')
    // 译文宿主里只有 zh 的 mark
    const zhPart = html.slice(html.indexOf('data-hl-host="zh"'))
    expect(zhPart).toMatch(/<mark[^>]*data-highlight-id="hz"[^>]*>你好<\/mark>/)
    expect(zhPart).not.toContain('data-highlight-id="ho"')
  })

  it('中文模式：zh 高亮渲染在译文上；无译文（骨架态）不渲染 mark 也不报错', () => {
    const withZh = render({
      blocks: [block(0, 'paragraph', 'hello world')],
      langMode: 'zh',
      translations: new Map([[0, '你好世界']]),
      highlights: new Map([[0, [hl('hz', 0, 'zh', 2, 4, '世界')]]]),
    })
    expect(withZh).toMatch(/<mark[^>]*data-highlight-id="hz"[^>]*>世界<\/mark>/)

    const skeleton = render({
      blocks: [block(0, 'paragraph', 'hello world')],
      langMode: 'zh',
      highlights: new Map([[0, [hl('hz', 0, 'zh', 2, 4, '世界')]]]),
    })
    expect(skeleton).not.toContain('<mark')
  })

  it('不传 highlights：输出与旧行为等价（无 mark，宿主标记仍在）', () => {
    const html = render({ blocks: [block(0, 'paragraph', 'plain text')] })
    expect(html).not.toContain('<mark')
    expect(html).toContain('data-hl-host="orig"')
    expect(html).toContain('plain text')
  })
})
