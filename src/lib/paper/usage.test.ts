import { describe, expect, it } from 'vitest'
import { computeCost, estimateCallCost, estimateMessagesTokens, estimateTokens, formatTokens, formatUsd, normalizeUsage } from './usage'
import { DEEPSEEK_V4_PRO, KIMI_K3 } from '../../data/paperPolicy'

describe('usage 归一化与成本', () => {
  it('estimateTokens：chars/3 向上取整', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('abcd')).toBe(2)
  })

  it('estimateMessagesTokens：逐条 + 结构开销', () => {
    const t = estimateMessagesTokens([
      { role: 'user', content: 'abc' },
      { role: 'assistant', content: 'abcdef' },
    ])
    expect(t).toBe(1 + 4 + 2 + 4)
  })

  it('computeCost：按 §5.4 官方价（DS in 0.435 / out 0.87 per MTok）', () => {
    expect(computeCost(DEEPSEEK_V4_PRO, 12_000, 1500)).toBeCloseTo(0.00652, 4)
    expect(computeCost(KIMI_K3, 12_000, 1500)).toBeCloseTo(0.0585, 4)
  })

  it('normalizeUsage：有真值用真值（estimated false）', () => {
    const u = normalizeUsage(DEEPSEEK_V4_PRO, { inputTokens: 100, outputTokens: 10 }, { messages: [], outputText: '' })
    expect(u).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 10, estimated: false })
  })

  it('normalizeUsage：缺 usage 时 chars/3 估算并标记', () => {
    const u = normalizeUsage(DEEPSEEK_V4_PRO, null, {
      messages: [{ role: 'user', content: 'abcdef' }],
      outputText: 'xyz',
    })
    expect(u.estimated).toBe(true)
    expect(u.inputTokens).toBe(2 + 4)
    expect(u.outputTokens).toBe(1)
  })

  it('estimateCallCost：输出按 maxOutputTokens 上限', () => {
    const est = estimateCallCost(KIMI_K3, [{ role: 'user', content: 'x'.repeat(3000) }], 3000)
    expect(est.inputTokens).toBe(1004)
    expect(est.outputTokens).toBe(3000)
    expect(est.cost).toBeCloseTo((1004 / 1e6) * 3 + (3000 / 1e6) * 15, 8)
  })

  it('格式化：小额 4 位、常规 2 位；token 万位缩写', () => {
    expect(formatUsd(0.0065)).toBe('$0.0065')
    expect(formatUsd(0.15)).toBe('$0.15')
    expect(formatTokens(9800)).toBe('9800')
    expect(formatTokens(12_400)).toBe('12.4K')
  })
})
