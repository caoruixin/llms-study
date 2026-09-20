import type { Partnership, UsageLedger } from './types'

export interface PriceConfig {
  billing: 'token' | 'gpu'
  partnership: Partnership
  judge: boolean
  input: number
  cached: number
  output: number
  train: number
  cacheRate: number
  promptTokens: number
  outputTokens: number
  observationTokens: number
  judgeInput: number
  judgeOutput: number
  toolCall: number
  ruleCall: number
  dataCost: number
  expertCost: number
  gpuCount: number
  gpuPrice: number
  rolloutHours: number
  trainHours: number
  servingHours: number
}
export const DEFAULT_PRICES: PriceConfig = {
  billing: 'token',
  partnership: 'api',
  judge: false,
  input: 1,
  cached: 0.2,
  output: 4,
  train: 3,
  cacheRate: 0.5,
  promptTokens: 220,
  outputTokens: 80,
  observationTokens: 60,
  judgeInput: 800,
  judgeOutput: 32,
  toolCall: 0.001,
  ruleCall: 0.0001,
  dataCost: 200,
  expertCost: 500,
  gpuCount: 4,
  gpuPrice: 3,
  rolloutHours: 2,
  trainHours: 1,
  servingHours: 10,
}
export function tokenQuantities(u: UsageLedger, p: PriceConfig) {
  const input = u.modelCalls * p.promptTokens + u.contextUnits * (p.outputTokens + p.observationTokens)
  return {
    input: input * (1 - p.cacheRate),
    cached: input * p.cacheRate,
    output: u.modelCalls * p.outputTokens,
    learned: u.trainActions * p.outputTokens,
    train:
      u.trainActions * (p.promptTokens + p.outputTokens) + u.trainContextUnits * (p.outputTokens + p.observationTokens),
    judgeInput: p.judge ? u.graderCalls * p.judgeInput : 0,
    judgeOutput: p.judge ? u.graderCalls * p.judgeOutput : 0,
  }
}
export interface CostRow {
  id: string
  label: string
  cost: number
  provider: boolean
  basis: string
}
export function estimateCosts(
  training: UsageLedger,
  evaluation: UsageLedger,
  production: UsageLedger,
  p: PriceConfig,
): { rows: CostRow[]; total: number; revenue: number; productionCost: number } {
  const rows: CostRow[] = []
  const inference = (u: UsageLedger) => {
    const q = tokenQuantities(u, p)
    return (q.input * p.input + q.cached * p.cached + q.output * p.output) / 1e6
  }
  const owns = (service: string) =>
    p.partnership === 'expert' ||
    service === 'rollout' ||
    (p.partnership !== 'rollout' && ['train', 'evaluation', 'serving'].includes(service)) ||
    (p.partnership === 'managed' && service === 'environment')
  const add = (id: string, label: string, cost: number, service: string, basis: string) =>
    rows.push({ id, label, cost, provider: owns(service), basis })
  add('data', '研发 · 数据与 Eval 建设', p.dataCost, 'data', '一次性教学预算；人工与标注')
  if (p.partnership === 'expert') add('expert', '研发 · 专家共建', p.expertCost, 'expert', '一次性教学项目费')
  if (p.billing === 'token') {
    add('rollout', '训练循环 · Rollout 推理', inference(training), 'rollout', '未缓存输入 + 缓存输入 + 输出 Token')
    add(
      'train',
      '训练循环 · 参数更新',
      (tokenQuantities(training, p).train * p.train) / 1e6,
      'train',
      '教学口径：每次更新处理的上下文及输出 × 更新次数',
    )
    add(
      'evaluation',
      '研发 · 基线 / 验证 / 测试推理',
      inference(evaluation),
      'evaluation',
      '已运行的评测调用；重复评测再次计量',
    )
    add('production', '生产 · Serving 推理', inference(production), 'serving', '模拟生产批次的 Token 估算')
  } else {
    add(
      'rollout',
      '训练循环 · Rollout 专用容量',
      p.gpuCount * p.rolloutHours * p.gpuPrice,
      'rollout',
      'GPU 数 × 用户填写的运行小时 × $/GPU-hour',
    )
    add(
      'train',
      '训练循环 · Trainer 专用容量',
      p.gpuCount * p.trainHours * p.gpuPrice,
      'train',
      'GPU 数 × 用户填写的训练小时 × $/GPU-hour',
    )
    add('evaluation', '研发 · 评测 API', inference(evaluation), 'evaluation', '本方案评测另购 API，不占上面的专用容量')
    add(
      'production',
      '生产 · 专用 Serving 容量',
      p.gpuCount * p.servingHours * p.gpuPrice,
      'serving',
      '用户填写的生产容量预算；包含空闲时间',
    )
  }
  for (const [prefix, u] of [
    ['training', training],
    ['evaluation', evaluation],
    ['production', production],
  ] as const) {
    const q = tokenQuantities(u, p)
    add(
      `${prefix}-tools`,
      `${prefix === 'production' ? '生产' : prefix === 'training' ? '训练循环' : '研发评测'} · 工具环境`,
      u.toolCalls * p.toolCall,
      'environment',
      '工具次数 × 每次环境费用',
    )
    add(
      `${prefix}-grader`,
      `${prefix === 'production' ? '生产' : prefix === 'training' ? '训练循环' : '研发评测'} · 评分`,
      p.judge ? (q.judgeInput * p.input + q.judgeOutput * p.output) / 1e6 : u.graderCalls * p.ruleCall,
      'environment',
      p.judge ? '假设使用 LLM Judge 的 Token 成本（实验仍由规则评分）' : '规则评分次数 × CPU 单次成本',
    )
  }
  return {
    rows,
    total: rows.reduce((s, r) => s + r.cost, 0),
    revenue: rows.reduce((s, r) => s + (r.provider ? r.cost : 0), 0),
    productionCost: rows.filter((r) => r.id.startsWith('production')).reduce((s, r) => s + r.cost, 0),
  }
}
export function perSuccess(cost: number, successes: number): number | null {
  return successes > 0 ? cost / successes : null
}
