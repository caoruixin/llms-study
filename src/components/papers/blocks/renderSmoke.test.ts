import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import StepperBlock from './StepperBlock'
import ComparisonBlock from './ComparisonBlock'
import GraphBlock from './GraphBlock'
import TimelineBlock from './TimelineBlock'
import QuizBlock from './QuizBlock'
import FlashcardBlock from './FlashcardBlock'
import TeachBackBlock from './TeachBackBlock'
import { validateIsland, type CopilotBlock } from '../../../lib/paper/blockSchemas'
import type { StoredCiteEntry } from '../../../lib/paper/types'

/**
 * 展示块的渲染冒烟（node 环境，renderToStaticMarkup，无需 DOM 与新依赖）。
 * 目的：模型给的任意合法块都不会在渲染期抛错，且 SVG/表格由本地组件生成
 * （岛里出现 <script>/<svg> 之类的内容只会作为文本被转义）。
 */

const entry: StoredCiteEntry = {
  alias: 'c1',
  chunkId: 'k1',
  anchor: { kind: 'pdf', blockIndex: 3, page: 7, section: '4.2 Method' },
  page: 7,
  section: '4.2 Method',
}
const citeIndex = new Map([['c1', entry]])
const common = { citeIndex, badges: null, onJump: () => undefined }

/** 走真实校验器拿到块，保证冒烟用的数据形状与线上一致 */
function parse(type: string, json: unknown): CopilotBlock {
  const r = validateIsland(type, JSON.stringify(json))
  if (!r.ok) throw new Error(`fixture invalid: ${r.failure}`)
  return r.block
}

describe('展示块渲染冒烟', () => {
  it('stepper', () => {
    const block = parse('stepper', { title: '流程', steps: [{ title: '一', detail: 'd', code: 'x = 1' }], cites: ['c1'] })
    const html = renderToStaticMarkup(createElement(StepperBlock, { block: block as never, ...common }))
    expect(html).toContain('流程')
    expect(html).toContain('x = 1')
    expect(html).toContain('p.7')
  })

  it('comparison：表格在横滚容器内', () => {
    const block = parse('comparison', { columns: ['A', 'B'], rows: [{ label: 'r', cells: ['1'] }] })
    const html = renderToStaticMarkup(createElement(ComparisonBlock, { block: block as never, ...common }))
    expect(html).toContain('overflow-x-auto')
    expect(html).toContain('<table')
  })

  it('flow / concept-map：固定 SVG，节点标签被转义', () => {
    const flow = parse('flow', {
      nodes: [{ id: 'a', label: '<script>x</script>' }, { id: 'b', label: 'B' }],
      edges: [{ from: 'a', to: 'b', label: '→' }],
    })
    const html = renderToStaticMarkup(createElement(GraphBlock, { block: flow as never, ...common }))
    expect(html).toContain('<svg')
    expect(html).toContain('viewBox')
    expect(html).not.toContain('<script>')
    const map = parse('concept-map', {
      nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
      edges: [{ from: 'a', to: 'b' }],
    })
    expect(renderToStaticMarkup(createElement(GraphBlock, { block: map as never, ...common }))).toContain('<svg')
  })

  it('图超限时降级为列表（不出 SVG）', () => {
    const big = parse('concept-map', {
      nodes: Array.from({ length: 16 }, (_, i) => ({ id: `n${i}`, label: `N${i}` })),
      edges: [],
    })
    const html = renderToStaticMarkup(createElement(GraphBlock, { block: big as never, ...common }))
    expect(html).not.toContain('<svg')
    expect(html).toContain('列表展示')
  })

  it('timeline', () => {
    const block = parse('timeline', { items: [{ at: '2017', title: 'T', detail: 'd' }] })
    expect(renderToStaticMarkup(createElement(TimelineBlock, { block: block as never, ...common }))).toContain('2017')
  })

  it('quiz：单选/多选/简答三种形态', () => {
    for (const fixture of [
      { kind: 'single', stem: 's', options: ['a', 'b'], answer: 1, why: 'w' },
      { kind: 'multi', stem: 's', options: ['a', 'b', 'c'], answer: [0, 2] },
      { kind: 'short', stem: 's', reference: 'ref' },
    ]) {
      const block = parse('quiz', fixture)
      const html = renderToStaticMarkup(
        createElement(QuizBlock, { block: block as never, seed: 1, ...common, onEvidence: () => undefined }),
      )
      expect(html).toContain('理解检查')
    }
  })

  it('flashcard 背面默认不展开', () => {
    const block = parse('flashcard', { front: 'RoPE', back: '旋转位置编码' })
    const html = renderToStaticMarkup(createElement(FlashcardBlock, { block: block as never, ...common }))
    expect(html).toContain('RoPE')
    expect(html).not.toContain('旋转位置编码')
  })

  it('teach-back 带输入框与提示', () => {
    const block = parse('teach-back', { prompt: '请解释 KV cache', hints: ['提示一'] })
    const html = renderToStaticMarkup(
      createElement(TeachBackBlock, { block: block as never, ...common, onTeachBack: () => undefined }),
    )
    expect(html).toContain('请解释 KV cache')
    expect(html).toContain('提示一')
    expect(html).toContain('<textarea')
  })
})
