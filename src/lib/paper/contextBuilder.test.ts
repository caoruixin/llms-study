import { describe, expect, it } from 'vitest'
import { assembleContext, PAPER_TUTOR_SYSTEM_PROMPT, renderChunkHeader, SELECTION_MAX_CHARS, type AssembleInput } from './contextBuilder'
import type { RetrievedChunk } from './retrieval'
import type { PaperChunk } from './types'

const mkChunk = (alias: string, text: string, order = 0): RetrievedChunk => ({
  alias,
  score: 1,
  matched: [],
  chunk: {
    id: `id-${alias}`,
    paperId: 'p1',
    order,
    text,
    anchor: { kind: 'pdf', blockIndex: order, page: 7, section: '4.2 Method' },
    blockStart: order,
    blockEnd: order,
  } satisfies PaperChunk,
})

const baseInput = (over: Partial<AssembleInput> = {}): AssembleInput => ({
  brief: '论文地图摘要',
  profileHint: '讲解层次：进阶',
  rollingSummary: '此前讨论了注意力机制',
  history: [
    { role: 'user', content: '老问题' },
    { role: 'assistant', content: '老回答' },
  ],
  selection: '选中的原文',
  chunks: [mkChunk('c1', '第一块'), mkChunk('c2', '第二块')],
  question: '为什么长上下文贵？',
  directives: ['输出 plan 岛'],
  inputBudgetTokens: 12_000,
  ...over,
})

describe('assembleContext · 五层排布', () => {
  it('顺序稳定：静态 system → brief+画像 → rolling → 历史 → 本轮 user', () => {
    const { messages } = assembleContext(baseInput())
    expect(messages.map((m) => m.role)).toEqual(['system', 'system', 'system', 'user', 'assistant', 'user'])
    expect(messages[0].content).toBe(PAPER_TUTOR_SYSTEM_PROMPT) // 字节稳定（前缀缓存）
    expect(messages[1].content).toContain('论文地图摘要')
    expect(messages[1].content).toContain('讲解层次：进阶')
    expect(messages[2].content).toContain('此前讨论了注意力机制')
    expect(messages[3]).toEqual({ role: 'user', content: '老问题' })
  })

  it('缺省层整层省略（不留空 system）', () => {
    const { messages } = assembleContext(baseInput({ brief: null, profileHint: null, rollingSummary: null, history: [] }))
    expect(messages.map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('本轮 user：选区 + 白名单段（[c3] §sec · p.N 格式）+ 问题 + 逐轮指令，全部集中于最后一条', () => {
    const { messages } = assembleContext(baseInput())
    const last = messages[messages.length - 1].content
    expect(last).toContain('选中的原文')
    expect(last).toContain('[c1] §4.2 Method · p.7')
    expect(last).toContain('第一块')
    expect(last).toContain('为什么长上下文贵？')
    expect(last).toContain('- 输出 plan 岛')
  })

  it('选区超限按 SelectionAsk 先例截 4000', () => {
    const { messages, report } = assembleContext(baseInput({ selection: 'x'.repeat(9000), inputBudgetTokens: 12_000 }))
    const last = messages[messages.length - 1].content
    expect(last).toContain('x'.repeat(SELECTION_MAX_CHARS))
    expect(last).not.toContain('x'.repeat(SELECTION_MAX_CHARS + 1))
    expect(report.selectionTruncated).toBe(false) // 4000 是常规上限，不算阶梯裁剪
  })

  it('renderChunkHeader：无 section/page 时收缩', () => {
    const c = mkChunk('c9', 't')
    c.chunk.anchor = { kind: 'docx', blockIndex: 1 }
    expect(renderChunkHeader(c)).toBe('[c9]')
  })
})

describe('assembleContext · 裁剪阶梯', () => {
  const bigChunk = (alias: string, order: number) => mkChunk(alias, `${alias}-`.repeat(1500), order) // ~3000 chars ≈ 1000 tok

  it('阶梯 1：先减 chunk 数（从尾部丢）', () => {
    const chunks = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((a, i) => bigChunk(a, i))
    const { report, messages } = assembleContext(baseInput({ chunks, inputBudgetTokens: 3000 }))
    expect(report.chunksDropped).toBeGreaterThan(0)
    expect(report.chunksIncluded).toBeGreaterThanOrEqual(2)
    const last = messages[messages.length - 1].content
    expect(last).toContain('[c1]') // 最高名次保留
    expect(last).not.toContain('[c6]')
  })

  it('阶梯 2：chunk 首尾截断（保底 2 条时）', () => {
    const chunks = [bigChunk('c1', 0), bigChunk('c2', 1)]
    const { report, messages } = assembleContext(baseInput({ chunks, inputBudgetTokens: 1500 }))
    expect(report.chunksIncluded).toBe(2)
    expect(report.chunksTruncated).toBe(true)
    expect(messages[messages.length - 1].content).toContain('（中段省略）')
  })

  it('阶梯 3：丢最老轮（成对），保底最近一轮', () => {
    const history = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `轮${Math.floor(i / 2)}-${'y'.repeat(1200)}`,
    }))
    const { report, messages } = assembleContext(
      baseInput({ history, chunks: [mkChunk('c1', '小块')], inputBudgetTokens: 2600 }),
    )
    expect(report.turnsDropped).toBeGreaterThan(0)
    const roles = messages.map((m) => m.role)
    expect(roles.filter((r) => r === 'assistant').length).toBeGreaterThanOrEqual(1) // 保底一轮
    expect(messages.some((m) => m.content.startsWith('轮5'))).toBe(true) // 最新轮保留
    expect(messages.some((m) => m.content.startsWith('轮0'))).toBe(false) // 最老轮被丢
  })

  it('阶梯 4：截选区', () => {
    const { report } = assembleContext(
      baseInput({
        selection: 's'.repeat(4000),
        chunks: [mkChunk('c1', '小')],
        history: [],
        inputBudgetTokens: 900,
      }),
    )
    expect(report.selectionTruncated).toBe(true)
    expect(report.overBudget).toBe(false)
  })

  it('阶梯 5：裁到底仍超 → overBudget 报错档', () => {
    const { report } = assembleContext(
      baseInput({ question: 'q'.repeat(30_000), chunks: [], history: [], selection: null, inputBudgetTokens: 800 }),
    )
    expect(report.overBudget).toBe(true)
  })

  it('预算内不动任何东西 + 报告数字', () => {
    const { report } = assembleContext(baseInput())
    expect(report).toMatchObject({
      chunksIncluded: 2,
      chunksDropped: 0,
      chunksTruncated: false,
      turnsDropped: 0,
      selectionTruncated: false,
      overBudget: false,
    })
    expect(report.estimatedInputTokens).toBeGreaterThan(0)
    expect(report.budgetTokens).toBe(12_000)
  })
})
