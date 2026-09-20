import { describe, expect, it } from 'vitest'
import { emptyUsage } from './engine'
import { DEFAULT_PRICES, estimateCosts, perSuccess, tokenQuantities } from './economics'

describe('Agent RL resource metering', () => {
  const usage = {
    ...emptyUsage(),
    modelCalls: 2,
    contextUnits: 1,
    toolCalls: 2,
    graderCalls: 1,
    trainActions: 2,
    trainContextUnits: 1,
  }
  it('separates context processing from learned output tokens with a hand-computable example', () => {
    const q = tokenQuantities(usage, DEFAULT_PRICES)
    expect(q.input).toBe(290)
    expect(q.cached).toBe(290)
    expect(q.output).toBe(160)
    expect(q.train).toBe(740)
    expect(q.learned).toBe(160)
    expect(q.judgeInput).toBe(0)
  })
  it('does not double-bill inference or training as GPU time and tokens', () => {
    const cost = estimateCosts(usage, emptyUsage(), emptyUsage(), { ...DEFAULT_PRICES, billing: 'gpu' })
    expect(cost.rows.find((r) => r.id === 'train')?.cost).toBe(12)
    expect(cost.rows.find((r) => r.id === 'rollout')?.cost).toBe(24)
    expect(cost.rows.filter((r) => r.id === 'rollout')).toHaveLength(1)
    expect(cost.total).toBeCloseTo(cost.rows.reduce((s, r) => s + r.cost, 0))
  })
  it('allocates provider revenue by explicit scope, not total customer spend', () => {
    const cost = estimateCosts(usage, usage, usage, { ...DEFAULT_PRICES, partnership: 'rollout' })
    expect(cost.revenue).toBe(cost.rows.find((r) => r.id === 'rollout')!.cost)
    expect(cost.revenue).toBeLessThan(cost.total)
    const expert = estimateCosts(usage, usage, usage, { ...DEFAULT_PRICES, partnership: 'expert' })
    expect(expert.revenue).toBe(expert.total)
  })
  it('adds judge tokens only under the declared hypothetical judge mode', () => {
    expect(tokenQuantities(usage, { ...DEFAULT_PRICES, judge: true }).judgeInput).toBe(800)
    const q = estimateCosts(usage, emptyUsage(), emptyUsage(), { ...DEFAULT_PRICES, judge: true })
    expect(q.rows.find((r) => r.id === 'training-grader')!.cost).toBeCloseTo((800 + 32 * 4) / 1e6)
  })
  it('includes failure consumption and leaves cost per success undefined with zero successes', () => {
    expect(perSuccess(5, 0)).toBeNull()
    expect(perSuccess(5, 2)).toBe(2.5)
    const costs = estimateCosts(emptyUsage(), emptyUsage(), usage, DEFAULT_PRICES)
    expect(costs.productionCost).toBeGreaterThan(0)
    expect(costs.productionCost).toBeCloseTo(
      costs.rows.filter((r) => r.id.startsWith('production')).reduce((a, r) => a + r.cost, 0),
    )
  })
})
