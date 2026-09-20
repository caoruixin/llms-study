import type {
  Action,
  Checkpoint,
  Environment,
  EvaluationResult,
  ExperimentConfig,
  Observation,
  Policy,
  Split,
  Ticket,
  TicketKind,
  Trajectory,
  UpdateResult,
  UsageLedger,
} from './types'

export const ACTIONS: Action[] = ['order', 'rules', 'ask', 'refund', 'escalate', 'close']
export const ACTION_LABELS: Record<Action, string> = {
  order: '查订单',
  rules: '查规则',
  ask: '补充信息',
  refund: '申请退款',
  escalate: '转人工',
  close: '结束工单',
}
export const KIND_LABELS: Record<TicketKind, string> = {
  eligible: '可退款',
  ineligible: '超售后期',
  missing: '资料不足',
  duplicate: '已经退款',
  flaky: '工具暂时失败',
}
export const DEFAULT_CONFIG: ExperimentConfig = {
  algorithm: 'reinforce',
  rewardMode: 'verified',
  seed: 42,
  rounds: 40,
  batchSize: 8,
  groupSize: 4,
  maxSteps: 12,
  learningRate: 0.3,
  gamma: 0.99,
  lambda: 0.95,
  clip: 0.2,
  epochs: 4,
  kl: 0.02,
  successWeight: 5,
  violationPenalty: 2,
  stepPenalty: 0.08,
  failureRate: 0,
  autoSync: true,
}
export function sanitizeConfig(input: Partial<ExperimentConfig>): ExperimentConfig {
  const c = { ...DEFAULT_CONFIG }
  const ranges: Partial<Record<keyof ExperimentConfig, [number, number, boolean?]>> = {
    seed: [1, 2147483647, true],
    rounds: [1, 100, true],
    batchSize: [1, 16, true],
    groupSize: [2, 16, true],
    maxSteps: [2, 16, true],
    learningRate: [0.01, 2],
    gamma: [0, 1],
    lambda: [0, 1],
    clip: [0.01, 0.5],
    epochs: [1, 8, true],
    kl: [0, 1],
    successWeight: [0, 10],
    violationPenalty: [0, 10],
    stepPenalty: [0, 1],
    failureRate: [0, 1],
  }
  for (const [key, range] of Object.entries(ranges)) {
    const value = input[key as keyof ExperimentConfig]
    if (typeof value === 'number' && Number.isFinite(value)) {
      const n = Math.max(range[0], Math.min(range[1], value))
      Object.assign(c, { [key]: range[2] ? Math.round(n) : n })
    }
  }
  if (['reinforce', 'ppo', 'grpo'].includes(input.algorithm ?? '')) c.algorithm = input.algorithm!
  if (['verified', 'closed', 'flat'].includes(input.rewardMode ?? '')) c.rewardMode = input.rewardMode!
  if (typeof input.autoSync === 'boolean') c.autoSync = input.autoSync
  return c
}
export function random(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s += 0x6d2b79f5
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function hash(text: string): number {
  let h = 2166136261
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}
export function dataset(split: Split): Ticket[] {
  const kinds: TicketKind[] = ['eligible', 'ineligible', 'missing', 'duplicate', 'flaky']
  return Array.from({ length: split === 'train' ? 80 : 40 }, (_, i) => ({
    id: `${split}-${i + 1}`,
    family: `${split}-family-${i + 1}`,
    split,
    kind: kinds[i % 5],
    customer: `客户 ${i + 1}`,
    amount: 20 + i * 7,
  }))
}
export function initialEnvironment(ticket: Ticket): Environment {
  return {
    observation: {
      info: ticket.kind !== 'missing',
      order: 'unknown',
      rules: false,
      refunded: false,
      toolFailed: false,
    },
    done: false,
    resolved: false,
    closed: false,
    escalated: false,
    violations: 0,
    steps: 0,
    orderAttempts: 0,
  }
}
export function stateKey(o: Observation): string {
  return `${+o.info}/${o.order}/${+o.rules}/${+o.refunded}/${+o.toolFailed}`
}
export function describeObservation(o: Observation): string {
  return `${o.info ? '资料齐全' : '缺少订单号'} · 订单${{ unknown: '未查', eligible: '在售后期', ineligible: '超售后期', duplicate: '已退款' }[o.order]} · ${o.rules ? '规则已查' : '规则未查'}${o.refunded ? ' · 退款成功' : ''}${o.toolFailed ? ' · 上次工具失败' : ''}`
}
/** Truth is read only by the environment, never by the policy. Tool failure RNG is independent of action sampling. */
export function environmentStep(
  ticket: Ticket,
  before: Environment,
  action: Action,
  maxSteps: number,
  failureRate = 0,
  environmentSeed = 0,
): { env: Environment; result: string } {
  if (before.done) throw new Error('工单已终止，必须重置环境后才能执行动作')
  const env = { ...before, observation: { ...before.observation }, steps: before.steps + 1 }
  const o = env.observation
  let result = ''
  if (action === 'ask') {
    o.info = true
    result = '用户补充订单号；信息写入上下文。'
  }
  if (action === 'rules') {
    o.rules = true
    result = '规则：售后期内且未退款可退；已退不可重复；超期说明原因。'
  }
  if (action === 'order') {
    env.orderAttempts++
    const fails =
      (ticket.kind === 'flaky' && env.orderAttempts === 1) ||
      random(hash(`${environmentSeed}/${ticket.id}/${env.orderAttempts}`))() < failureRate
    if (!o.info) result = '查询失败：缺少订单号。需要先向用户补充信息。'
    else if (fails) {
      o.toolFailed = true
      result = '订单 API 超时，可重试或转人工；尚未获得订单结果。'
    } else {
      o.toolFailed = false
      o.order = ticket.kind === 'ineligible' ? 'ineligible' : ticket.kind === 'duplicate' ? 'duplicate' : 'eligible'
      result = `查询成功：${describeObservation(o)}。`
    }
  }
  if (action === 'refund') {
    if (!o.info || !o.rules || o.order !== 'eligible' || o.refunded) {
      env.violations++
      result = 'Harness 拒绝退款：缺少核验、条件不符或重复请求；记录违规尝试。'
    } else {
      o.refunded = true
      result = `模拟退款 ¥${ticket.amount} 成功，工具返回交易回执。`
    }
  }
  if (action === 'escalate') {
    env.escalated = true
    env.done = true
    result = '已转人工。交接完成，但不计为 Agent 自助解决。'
  }
  if (action === 'close') {
    env.done = true
    env.closed = true
    env.resolved =
      o.info &&
      o.rules &&
      o.order !== 'unknown' &&
      (o.refunded || o.order === 'ineligible' || o.order === 'duplicate') &&
      env.violations === 0
    result = env.resolved
      ? '工单正确解决：退款有回执，或已依据规则解释不能再次退款。'
      : '工单已标记关闭，但独立验收发现问题没有被正确解决。'
  }
  if (!env.done && env.steps >= maxSteps) {
    env.done = true
    result += ' 已达到任务步数上限，按未解决终止。'
  }
  return { env, result }
}
// A weak tool-capable base policy, analogous to starting RL from an instruction-tuned model.
// It uses only observable fields, and still samples all actions (including bad ones).
function initialLogits(state: string): number[] {
  const [info, order, rules, refunded] = state.split('/')
  const ready = rules === '1' && order !== 'unknown'
  return [
    order === 'unknown' ? 0.7 : -0.8,
    rules === '0' ? 0.7 : -0.8,
    info === '0' ? 1.2 : -0.8,
    ready && order === 'eligible' && refunded === '0' ? 0.9 : -0.8,
    -1.5,
    ready && (order !== 'eligible' || refunded === '1') ? 1.3 : -0.3,
  ]
}
export function initialPolicy(): Policy {
  return { logits: {}, values: {}, baseline: 0 }
}
export function clonePolicy(p: Policy): Policy {
  return {
    logits: Object.fromEntries(Object.entries(p.logits).map(([k, v]) => [k, [...v]])),
    values: { ...p.values },
    baseline: p.baseline,
  }
}
export function softmax(logits: number[]): number[] {
  const m = Math.max(...logits)
  const e = logits.map((v) => Math.exp(v - m))
  const s = e.reduce((a, b) => a + b, 0)
  return e.map((v) => v / s)
}
export function probabilities(p: Policy, state: string): number[] {
  return softmax(p.logits[state] ?? initialLogits(state))
}
export function logPolicyGradient(probs: number[], action: number): number[] {
  return probs.map((p, i) => (i === action ? 1 : 0) - p)
}
export function klValueGradient(p: number[], q: number[]): { value: number; gradient: number[] } {
  const logs = p.map((x, i) => Math.log(Math.max(x, 1e-15) / Math.max(q[i], 1e-15)))
  const value = p.reduce((s, x, i) => s + x * logs[i], 0)
  return { value, gradient: p.map((x, i) => x * (logs[i] - value)) }
}
export function clippedSurrogate(
  ratio: number,
  advantage: number,
  clip: number,
): { value: number; derivative: number; clipped: boolean } {
  const bound = Math.max(1 - clip, Math.min(1 + clip, ratio))
  const clipped = (advantage > 0 && ratio > 1 + clip) || (advantage < 0 && ratio < 1 - clip)
  return { value: Math.min(ratio * advantage, bound * advantage), derivative: clipped ? 0 : advantage, clipped }
}
export function rollout(
  ticket: Ticket,
  cp: Checkpoint,
  config: ExperimentConfig,
  seed: number,
  id: string,
): Trajectory {
  const rng = random(seed)
  let env = initialEnvironment(ticket)
  const steps: Trajectory['steps'] = []
  while (!env.done) {
    const observation = { ...env.observation }
    const state = stateKey(observation)
    const probs = probabilities(cp.policy, state)
    let draw = rng()
    let a = 0
    while (a < ACTIONS.length - 1 && draw >= probs[a]) {
      draw -= probs[a]
      a++
    }
    const transition = environmentStep(ticket, env, ACTIONS[a], config.maxSteps, config.failureRate, config.seed)
    steps.push({
      state,
      observation,
      action: ACTIONS[a],
      probabilities: probs,
      logprob: Math.log(probs[a]),
      value: cp.policy.values[state] ?? 0,
      result: transition.result,
      next: { ...transition.env.observation },
      reward: 0,
      advantage: 0,
      target: 0,
    })
    env = transition.env
  }
  return { id, ticket, policyVersion: cp.version, steps, outcome: env, reward: 0, parts: [] }
}
export function rolloutBatch(cp: Checkpoint, config: ExperimentConfig, round: number): Trajectory[] {
  const tickets = dataset('train')
  const rng = random(config.seed + round * 997)
  return Array.from({ length: config.batchSize }, (_, taskIndex) => {
    const ticket = tickets[Math.floor(rng() * tickets.length)]
    return Array.from({ length: config.groupSize }, (_, i) =>
      rollout(ticket, cp, config, Math.floor(rng() * 2147483646) + 1, `${round}:${taskIndex}:${i}`),
    )
  }).flat()
}
export function scoreTrajectory(t: Trajectory, c: ExperimentConfig): Trajectory {
  const parts =
    c.rewardMode === 'flat'
      ? [{ label: '所有轨迹固定得分', value: 1 }]
      : c.rewardMode === 'closed'
        ? [
            { label: '只看系统标记关闭（错误目标）', value: t.outcome.closed ? c.successWeight : 0 },
            { label: '步骤开销', value: -c.stepPenalty * t.steps.length },
          ]
        : [
            { label: '独立验证的任务成功', value: t.outcome.resolved ? c.successWeight : 0 },
            { label: '违规尝试', value: -c.violationPenalty * t.outcome.violations },
            { label: '步骤开销', value: -c.stepPenalty * t.steps.length },
          ]
  const reward = parts.reduce((s, x) => s + x.value, 0)
  // Outcome supervision: terminal reward includes costs. Earlier actions receive credit through returns/advantages.
  return {
    ...t,
    reward,
    parts,
    steps: t.steps.map((s, i) => ({ ...s, reward: i === t.steps.length - 1 ? reward : 0 })),
  }
}
export function groupAdvantages(rewards: number[]): number[] {
  const mean = rewards.reduce((a, b) => a + b, 0) / rewards.length
  const std = Math.sqrt(rewards.reduce((a, b) => a + (b - mean) ** 2, 0) / rewards.length)
  return rewards.map((r) => (std < 1e-8 ? 0 : (r - mean) / std))
}
export function gae(
  rewards: number[],
  values: number[],
  gamma: number,
  lambda: number,
): { advantages: number[]; targets: number[] } {
  const advantages = new Array<number>(rewards.length)
  let a = 0
  for (let i = rewards.length - 1; i >= 0; i--) {
    const delta = rewards[i] + gamma * (values[i + 1] ?? 0) - values[i]
    a = delta + gamma * lambda * a
    advantages[i] = a
  }
  return { advantages, targets: advantages.map((v, i) => v + values[i]) }
}
export function prepareAdvantages(batch: Trajectory[], c: ExperimentConfig, baseline: number): Trajectory[] {
  const grouped = new Map<string, Trajectory[]>()
  for (const t of batch) {
    const key = t.id.split(':').slice(0, 2).join(':')
    grouped.set(key, [...(grouped.get(key) ?? []), t])
  }
  const relative = new Map<string, number>()
  for (const group of grouped.values())
    groupAdvantages(group.map((t) => t.reward)).forEach((a, i) => relative.set(group[i].id, a))
  return batch.map((t) => {
    const estimates = gae(
      t.steps.map((s) => s.reward),
      t.steps.map((s) => s.value),
      c.gamma,
      c.lambda,
    )
    return {
      ...t,
      steps: t.steps.map((s, i) => ({
        ...s,
        advantage:
          c.algorithm === 'grpo'
            ? relative.get(t.id)!
            : c.algorithm === 'ppo'
              ? estimates.advantages[i]
              : t.reward * c.gamma ** (t.steps.length - 1 - i) - baseline,
        target: estimates.targets[i],
      })),
    }
  })
}
/** Analytic gradient ascent on tabular logits; full batch updates keep the objective inspectable. */
export function updatePolicy(
  before: Policy,
  reference: Policy,
  batch: Trajectory[],
  c: ExperimentConfig,
): UpdateResult {
  if (!batch.length) throw new Error('没有轨迹，不能更新策略')
  const policy = clonePolicy(before)
  const epochs = c.algorithm === 'reinforce' ? 1 : c.epochs
  let clippedCount = 0
  let count = 0
  let klSum = 0
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradients: Record<string, number[]> = {}
    const valueGradients: Record<string, number> = {}
    for (const t of batch)
      for (const step of t.steps) {
        const p = probabilities(policy, step.state)
        const a = ACTIONS.indexOf(step.action)
        const ratio = Math.exp(Math.log(p[a]) - step.logprob)
        const clip = clippedSurrogate(ratio, step.advantage, c.clip)
        const scale = c.algorithm === 'reinforce' ? step.advantage : ratio * clip.derivative
        // REINFORCE/PPO sum over episode actions; GRPO follows the paper's per-completion length normalization.
        const weight = 1 / (batch.length * (c.algorithm === 'grpo' ? t.steps.length : 1))
        const kl = klValueGradient(p, probabilities(reference, step.state))
        const g = logPolicyGradient(p, a)
        const dest = (gradients[step.state] ??= new Array(ACTIONS.length).fill(0))
        for (let j = 0; j < g.length; j++)
          dest[j] += weight * (scale * g[j] - (c.algorithm === 'grpo' ? c.kl * kl.gradient[j] : 0))
        if (c.algorithm === 'ppo')
          valueGradients[step.state] =
            (valueGradients[step.state] ?? 0) + weight * (step.target - (policy.values[step.state] ?? 0))
        clippedCount += +(c.algorithm !== 'reinforce' && clip.clipped)
        count++
        klSum += kl.value
      }
    for (const [state, gradient] of Object.entries(gradients)) {
      const old = policy.logits[state] ?? initialLogits(state)
      policy.logits[state] = old.map((v, i) => Math.max(-20, Math.min(20, v + c.learningRate * gradient[i])))
    }
    for (const [state, gradient] of Object.entries(valueGradients))
      policy.values[state] = (policy.values[state] ?? 0) + c.learningRate * gradient
  }
  if (c.algorithm === 'reinforce')
    policy.baseline = 0.8 * before.baseline + (0.2 * batch.reduce((s, t) => s + t.reward, 0)) / batch.length
  return { policy, kl: klSum / count, clipped: clippedCount / count }
}
export function emptyUsage(): UsageLedger {
  return { modelCalls: 0, contextUnits: 0, toolCalls: 0, graderCalls: 0, trainActions: 0, trainContextUnits: 0 }
}
export function addUsage(a: UsageLedger, b: UsageLedger): UsageLedger {
  return Object.fromEntries(
    Object.keys(a).map((k) => [k, a[k as keyof UsageLedger] + b[k as keyof UsageLedger]]),
  ) as unknown as UsageLedger
}
export function batchUsage(batch: Trajectory[], phase: 'sample' | 'grade' | 'train', c: ExperimentConfig): UsageLedger {
  const u = emptyUsage()
  const epochs = c.algorithm === 'reinforce' ? 1 : c.epochs
  for (const t of batch) {
    if (phase === 'grade') u.graderCalls++
    t.steps.forEach((s, i) => {
      if (phase === 'sample') {
        u.modelCalls++
        u.contextUnits += i
        if (s.action !== 'close') u.toolCalls++
      }
      if (phase === 'train') {
        u.trainActions += epochs
        u.trainContextUnits += i * epochs
      }
    })
  }
  return u
}
function failureCounts(traces: Trajectory[]): Record<string, number> {
  const failures: Record<string, number> = {}
  for (const t of traces)
    if (!t.outcome.resolved) {
      const reason = t.outcome.violations
        ? '违规尝试：策略 / Harness'
        : t.outcome.observation.toolFailed
          ? '工具异常：环境 / Harness'
          : t.outcome.escalated
            ? '转人工：能力 / 工具'
            : t.outcome.closed
              ? '虚假结单：Reward / 策略'
              : '超时：Context / 工具 / 策略'
      failures[reason] = (failures[reason] ?? 0) + 1
    }
  return failures
}
export function evaluate(cp: Checkpoint, split: Split, failureRate = cp.config.failureRate): EvaluationResult {
  const config = { ...cp.config, failureRate }
  const tasks = dataset(split)
  // Fixed, disjoint evaluation RNG; independent of training round and chosen algorithm.
  const traces = tasks.map((t) => rollout(t, cp, config, hash(`${config.seed}/eval/${t.id}`), `eval:${t.id}`))
  return {
    split,
    version: cp.version,
    count: traces.length,
    resolved: traces.filter((t) => t.outcome.resolved).length,
    closed: traces.filter((t) => t.outcome.closed).length,
    violations: traces.filter((t) => t.outcome.violations > 0).length,
    escalated: traces.filter((t) => t.outcome.escalated).length,
    steps: traces.reduce((s, t) => s + t.steps.length, 0),
    usage: addUsage(batchUsage(traces, 'sample', config), batchUsage(traces, 'grade', config)),
    failureRate,
    failures: failureCounts(traces),
  }
}
export function evaluateProduction(cp: Checkpoint, failureRate: number): EvaluationResult {
  // A new family of tickets: production never doubles as the final test set.
  const tasks = dataset('test').map((t) => ({ ...t, id: `production-${t.id}`, family: `production-${t.family}` }))
  const traces = tasks.map((t) =>
    rollout(t, cp, { ...cp.config, failureRate }, hash(`${cp.config.seed}/production/${t.id}`), t.id),
  )
  return {
    split: 'production',
    version: cp.version,
    count: tasks.length,
    resolved: traces.filter((t) => t.outcome.resolved).length,
    closed: traces.filter((t) => t.outcome.closed).length,
    violations: traces.filter((t) => t.outcome.violations > 0).length,
    escalated: traces.filter((t) => t.outcome.escalated).length,
    steps: traces.reduce((s, t) => s + t.steps.length, 0),
    usage: addUsage(batchUsage(traces, 'sample', cp.config), batchUsage(traces, 'grade', cp.config)),
    failureRate,
    failures: failureCounts(traces),
  }
}
