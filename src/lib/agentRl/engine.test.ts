import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  DEFAULT_CONFIG,
  clippedSurrogate,
  dataset,
  environmentStep,
  evaluate,
  evaluateProduction,
  gae,
  groupAdvantages,
  initialEnvironment,
  initialPolicy,
  klValueGradient,
  logPolicyGradient,
  prepareAdvantages,
  probabilities,
  rolloutBatch,
  sanitizeConfig,
  scoreTrajectory,
  softmax,
  updatePolicy,
} from './engine'
import type { Algorithm, Checkpoint, ExperimentConfig, Policy } from './types'

export function trainExperiment(algorithm: Algorithm, overrides: Partial<ExperimentConfig> = {}) {
  const c = { ...DEFAULT_CONFIG, algorithm, ...overrides }
  let p = initialPolicy()
  const reference = initialPolicy()
  const baseline = evaluate({ version: 0, policy: p, config: c }, 'validation')
  const rewards: number[] = []
  for (let round = 0; round < c.rounds; round++) {
    const cp = { version: round, policy: p, config: c }
    const batch = prepareAdvantages(
      rolloutBatch(cp, c, round).map((t) => scoreTrajectory(t, c)),
      c,
      p.baseline,
    )
    rewards.push(batch.reduce((s, t) => s + t.reward, 0) / batch.length)
    p = updatePolicy(p, reference, batch, c).policy
  }
  return { baseline, result: evaluate({ version: c.rounds, policy: p, config: c }, 'validation'), p, rewards }
}
describe('Agent RL environment and algorithms', () => {
  it('keeps task families disjoint', () => {
    const tickets = [...dataset('train'), ...dataset('validation'), ...dataset('test')]
    expect(new Set(tickets.map((t) => t.family)).size).toBe(tickets.length)
  })
  it('policy observations hide the truth before a tool query', () => {
    const [eligible, ineligible] = dataset('train')
    expect(initialEnvironment(eligible).observation).toEqual(initialEnvironment(ineligible).observation)
  })
  it('validates refunds and terminal states', () => {
    const ticket = dataset('train')[0]
    const start = initialEnvironment(ticket)
    expect(environmentStep(ticket, start, 'refund', 12).env.violations).toBe(1)
    let env = start
    for (const action of ['order', 'rules', 'refund', 'close'] as const)
      env = environmentStep(ticket, env, action, 12).env
    expect(env.resolved).toBe(true)
    expect(() => environmentStep(ticket, env, 'refund', 12)).toThrow()
    expect(start.steps).toBe(0)
    expect(environmentStep(ticket, start, 'close', 12).env.resolved).toBe(false)
  })
  it('handles missing information, transient failure, duplicates and time limits', () => {
    const missing = dataset('train')[2]
    let env = initialEnvironment(missing)
    env = environmentStep(missing, env, 'order', 12).env
    expect(env.observation.order).toBe('unknown')
    env = environmentStep(missing, env, 'ask', 12).env
    expect(environmentStep(missing, env, 'order', 12).env.observation.order).toBe('eligible')
    const flaky = dataset('train')[4]
    env = environmentStep(flaky, initialEnvironment(flaky), 'order', 12).env
    expect(env.observation.toolFailed).toBe(true)
    expect(environmentStep(flaky, env, 'order', 12).env.observation.order).toBe('eligible')
    expect(environmentStep(missing, initialEnvironment(missing), 'ask', 1).env.done).toBe(true)
  })
  it('normalizes stable probabilities and checks log-softmax gradients numerically', () => {
    expect(softmax([1000, 1000])).toEqual([0.5, 0.5])
    const logits = [0.3, -0.2, 1]
    const g = logPolicyGradient(softmax(logits), 1)
    const eps = 1e-5
    logits.forEach((_, i) => {
      const a = [...logits]
      a[i] += eps
      const b = [...logits]
      b[i] -= eps
      expect(g[i]).toBeCloseTo((Math.log(softmax(a)[1]) - Math.log(softmax(b)[1])) / (2 * eps), 7)
    })
  })
  it('checks exact categorical KL gradients numerically', () => {
    const logits = [0.3, -0.2, 1]
    const q = [0.1, 0.7, 0.2]
    const eps = 1e-5
    const g = klValueGradient(softmax(logits), q)
    logits.forEach((_, i) => {
      const a = [...logits]
      a[i] += eps
      const b = [...logits]
      b[i] -= eps
      expect(g.gradient[i]).toBeCloseTo(
        (klValueGradient(softmax(a), q).value - klValueGradient(softmax(b), q).value) / (2 * eps),
        7,
      )
    })
  })
  it('clips only the improving side of signed PPO advantages', () => {
    expect(clippedSurrogate(1.4, 2, 0.2)).toEqual({ value: 2.4, derivative: 0, clipped: true })
    expect(clippedSurrogate(0.6, -2, 0.2)).toEqual({ value: -1.6, derivative: 0, clipped: true })
    expect(clippedSurrogate(0.6, 2, 0.2).derivative).toBe(2)
    expect(clippedSurrogate(1.4, -2, 0.2).derivative).toBe(-2)
  })
  it('GAE has a hand-computable terminal return', () => {
    expect(gae([0, 2], [0.5, 1], 1, 1)).toEqual({ advantages: [1.5, 1], targets: [2, 2] })
    expect(groupAdvantages([1, 3])).toEqual([-1, 1])
    expect(groupAdvantages([1, 1])).toEqual([0, 0])
  })
  it('sampling and evaluation do not train; seeds reproduce the same trajectories', () => {
    const cp: Checkpoint = { version: 0, policy: initialPolicy(), config: DEFAULT_CONFIG }
    const before = JSON.stringify(cp)
    const batch = rolloutBatch(cp, DEFAULT_CONFIG, 0)
    expect(rolloutBatch(cp, DEFAULT_CONFIG, 0)).toEqual(batch)
    evaluate(cp, 'test')
    expect(JSON.stringify(cp)).toBe(before)
    expect(batch.every((t) => t.policyVersion === 0)).toBe(true)
  })
  it('uses the declared evaluation environment and accounts for every production failure', () => {
    const cp = { version: 0, policy: initialPolicy(), config: { ...DEFAULT_CONFIG, failureRate: 1 } }
    const validation = evaluate(cp, 'validation')
    expect(validation.failureRate).toBe(1)
    expect(validation.resolved).toBe(0)
    const production = evaluateProduction(cp, 1)
    expect(Object.values(production.failures).reduce((a, b) => a + b, 0)).toBe(production.count - production.resolved)
    expect(production.failures['工具异常：环境 / Harness']).toBeGreaterThan(0)
  })
  it('flat GRPO rewards produce no policy gradient with KL disabled', () => {
    const c: ExperimentConfig = { ...DEFAULT_CONFIG, algorithm: 'grpo', rewardMode: 'flat', kl: 0 }
    const p = initialPolicy()
    const batch = prepareAdvantages(
      rolloutBatch({ version: 0, policy: p, config: c }, c, 0).map((t) => scoreTrajectory(t, c)),
      c,
      0,
    )
    const next = updatePolicy(p, p, batch, c).policy
    for (const t of batch)
      for (const s of t.steps) {
        expect(s.advantage).toBe(0)
        expect(probabilities(next, s.state)).toEqual(probabilities(p, s.state))
      }
  })
  for (const algorithm of ['reinforce', 'ppo', 'grpo'] as const)
    it(`${algorithm} learns from real trajectories`, () => {
      const run = trainExperiment(algorithm)
      console.info(algorithm, { before: run.baseline.resolved, after: run.result.resolved, reward: run.rewards.at(-1) })
      expect(run.result.resolved).toBeGreaterThan(run.baseline.resolved)
      expect(Object.keys(run.p.values).length > 0).toBe(algorithm === 'ppo')
      for (const row of Object.values(run.p.logits)) expect(softmax(row).reduce((a, b) => a + b, 0)).toBeCloseTo(1)
    })
  it('reward hacking increases closure without genuine resolution', () => {
    const good = trainExperiment('reinforce')
    const bad = trainExperiment('reinforce', { rewardMode: 'closed' })
    expect(bad.result.closed).toBeGreaterThanOrEqual(good.result.closed)
    expect(bad.result.resolved).toBeLessThan(good.result.resolved)
  })
  it('only algorithm-specific models update', () => {
    const p: Policy = initialPolicy()
    expect(ACTIONS).toHaveLength(6)
    expect(p.values).toEqual({})
    expect(sanitizeConfig({ rounds: NaN, groupSize: -5, failureRate: 9 }).groupSize).toBe(2)
  })
})
