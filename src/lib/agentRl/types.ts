export type Algorithm = 'reinforce' | 'ppo' | 'grpo'
export type RewardMode = 'verified' | 'closed' | 'flat'
export type Split = 'train' | 'validation' | 'test'
export type TicketKind = 'eligible' | 'ineligible' | 'missing' | 'duplicate' | 'flaky'
export type Action = 'order' | 'rules' | 'ask' | 'refund' | 'escalate' | 'close'
export interface Ticket {
  id: string
  family: string
  split: Split
  kind: TicketKind
  customer: string
  amount: number
}
export interface Observation {
  info: boolean
  order: 'unknown' | 'eligible' | 'ineligible' | 'duplicate'
  rules: boolean
  refunded: boolean
  toolFailed: boolean
}
export interface Environment {
  observation: Observation
  done: boolean
  resolved: boolean
  closed: boolean
  escalated: boolean
  violations: number
  steps: number
  orderAttempts: number
}
export interface ExperimentConfig {
  algorithm: Algorithm
  rewardMode: RewardMode
  seed: number
  rounds: number
  batchSize: number
  groupSize: number
  maxSteps: number
  learningRate: number
  gamma: number
  lambda: number
  clip: number
  epochs: number
  kl: number
  successWeight: number
  violationPenalty: number
  stepPenalty: number
  failureRate: number
  autoSync: boolean
}
export interface Policy {
  logits: Record<string, number[]>
  values: Record<string, number>
  baseline: number
}
export interface Checkpoint {
  version: number
  policy: Policy
  config: ExperimentConfig
}
export interface TraceStep {
  state: string
  observation: Observation
  action: Action
  probabilities: number[]
  logprob: number
  value: number
  result: string
  next: Observation
  reward: number
  advantage: number
  target: number
}
export interface RewardPart {
  label: string
  value: number
}
export interface Trajectory {
  id: string
  ticket: Ticket
  policyVersion: number
  steps: TraceStep[]
  outcome: Environment
  reward: number
  parts: RewardPart[]
}
/** Event counts are exact for the toy environment. Token quantities are derived estimates. */
export interface UsageLedger {
  modelCalls: number
  contextUnits: number
  toolCalls: number
  graderCalls: number
  trainActions: number
  trainContextUnits: number
}
export interface EvaluationResult {
  split: Split | 'production'
  version: number
  count: number
  resolved: number
  closed: number
  violations: number
  escalated: number
  steps: number
  usage: UsageLedger
  failureRate: number
  failures: Record<string, number>
}
export interface RoundResult {
  round: number
  reward: number
  success: number
  validation: number
  kl: number
  clipped: number
  samplerVersion: number
  version: number
}
export interface UpdateResult {
  policy: Policy
  kl: number
  clipped: number
}
export type View = 'map' | 'train' | 'lab' | 'evaluate' | 'provider'
export type Partnership = 'rollout' | 'api' | 'managed' | 'expert'
