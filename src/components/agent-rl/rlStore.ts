import { create } from 'zustand'
import {
  DEFAULT_CONFIG,
  addUsage,
  batchUsage,
  emptyUsage,
  evaluate,
  evaluateProduction,
  initialPolicy,
  prepareAdvantages,
  rolloutBatch,
  sanitizeConfig,
  scoreTrajectory,
  updatePolicy,
} from '../../lib/agentRl/engine'
import { DEFAULT_PRICES, type PriceConfig } from '../../lib/agentRl/economics'
import type {
  Checkpoint,
  EvaluationResult,
  ExperimentConfig,
  Policy,
  RoundResult,
  Trajectory,
  UpdateResult,
  UsageLedger,
  View,
} from '../../lib/agentRl/types'
import { PRESETS, RL_STAGES, RL_TABS } from '../../data/agentRl'

const STORAGE_KEY = 'llm-infra-agent-rl-v1'
interface Preferences {
  config: ExperimentConfig
  view: View
  stage: string
  completed: number[]
}
function readPreferences(): Preferences {
  const defaults: Preferences = { config: DEFAULT_CONFIG, view: 'map', stage: 'goal', completed: [] }
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (!p || p.version !== 1) return defaults
    return {
      config: sanitizeConfig(p.config ?? {}),
      view: RL_TABS.some((t) => t.id === p.view) ? p.view : 'map',
      stage: RL_STAGES.some((s) => s.id === p.stage) ? p.stage : 'goal',
      completed: Array.isArray(p.completed)
        ? [
            ...new Set<number>(
              p.completed.filter((n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 6),
            ),
          ]
        : [],
    }
  } catch {
    return defaults
  }
}
export interface Release {
  version: number
  harness: string
  tools: string
  reward: string
  evaluation: string
  kind: 'canary' | 'promote' | 'rollback'
  result: EvaluationResult
}
export interface RlState extends Preferences {
  preset: string
  playing: boolean
  phase: number
  round: number
  error: string | null
  learner: Checkpoint
  sampler: Checkpoint
  reference: Policy
  checkpoints: Checkpoint[]
  batch: Trajectory[]
  pending: UpdateResult | null
  history: RoundResult[]
  baseline: EvaluationResult
  validations: Record<number, EvaluationResult>
  tests: Record<number, EvaluationResult>
  trainingUsage: UsageLedger
  evaluationUsage: UsageLedger
  productionUsage: UsageLedger
  selectedTrajectory: number
  selectedStep: number
  selectedVersion: number
  productionVersion: number
  previousProduction: number | null
  productionFailure: number
  canary: { control: EvaluationResult; candidate: EvaluationResult } | null
  releases: Release[]
  prices: PriceConfig
  comparisons: { config: ExperimentConfig; round: RoundResult; calls: number }[]
  rememberRun: () => void
  setView: (view: View) => void
  setStage: (stage: string) => void
  markCompleted: (index: number) => void
  configure: (patch: Partial<ExperimentConfig>) => void
  applyPreset: (id: string) => void
  reset: () => void
  advance: () => void
  setPlaying: (value: boolean) => void
  syncSampler: () => void
  selectTrajectory: (index: number) => void
  selectStep: (index: number) => void
  selectVersion: (version: number) => void
  runTest: () => void
  setProductionFailure: (rate: number) => void
  runCanary: () => void
  promote: () => void
  rollback: () => void
  setPrices: (patch: Partial<PriceConfig>) => void
}
function experiment(config: ExperimentConfig) {
  const cp: Checkpoint = { version: 0, policy: initialPolicy(), config: { ...config } }
  const baseline = evaluate(cp, 'validation')
  return {
    config,
    playing: false,
    phase: 0,
    round: 0,
    error: null,
    learner: cp,
    sampler: cp,
    reference: initialPolicy(),
    checkpoints: [cp],
    batch: [] as Trajectory[],
    pending: null,
    history: [] as RoundResult[],
    baseline,
    validations: { 0: baseline },
    tests: {} as Record<number, EvaluationResult>,
    trainingUsage: emptyUsage(),
    evaluationUsage: baseline.usage,
    productionUsage: emptyUsage(),
    selectedTrajectory: 0,
    selectedStep: 0,
    selectedVersion: 0,
    productionVersion: 0,
    previousProduction: null,
    canary: null,
    releases: [] as Release[],
  }
}
const prefs = readPreferences()
export const useRlStore = create<RlState>()((set, get) => ({
  ...prefs,
  ...experiment(prefs.config),
  preset: JSON.stringify(prefs.config) === JSON.stringify(DEFAULT_CONFIG) ? 'healthy' : 'custom',
  productionFailure: 0,
  prices: { ...DEFAULT_PRICES },
  comparisons: [],
  rememberRun: () =>
    set((s) => ({
      comparisons: s.history.length
        ? [
            ...s.comparisons,
            { config: { ...s.config }, round: s.history.at(-1)!, calls: s.trainingUsage.modelCalls },
          ].slice(-3)
        : s.comparisons,
    })),
  setView: (view) => set({ view, playing: false }),
  setStage: (stage) => set({ stage }),
  markCompleted: (index) => set((s) => ({ completed: [...new Set([...s.completed, index])] })),
  configure: (patch) => set((s) => ({ ...experiment(sanitizeConfig({ ...s.config, ...patch })), preset: 'custom' })),
  applyPreset: (id) => {
    const preset = PRESETS.find((p) => p.id === id)
    if (preset)
      set({
        ...experiment(sanitizeConfig({ ...DEFAULT_CONFIG, ...preset.config })),
        preset: id,
        productionFailure: preset.productionFailure ?? 0,
        view: 'train',
        stage: 'rollout',
      })
  },
  reset: () => set((s) => experiment(s.config)),
  setPlaying: (playing) => set({ playing, error: null }),
  advance: () => {
    const s = get()
    if (s.round >= s.config.rounds) {
      set({ playing: false })
      return
    }
    try {
      if (s.phase === 0) {
        if (s.sampler.version !== s.learner.version) {
          set({ playing: false, error: '采样器仍是旧版本。请先同步权重，再开始下一轮 on-policy 训练。' })
          return
        }
        const batch = rolloutBatch(s.sampler, s.config, s.round)
        set({
          batch,
          phase: 1,
          stage: 'rollout',
          selectedTrajectory: 0,
          selectedStep: 0,
          pending: null,
          trainingUsage: addUsage(s.trainingUsage, batchUsage(batch, 'sample', s.config)),
          error: null,
        })
      } else if (s.phase === 1) {
        const batch = s.batch.map((t) => scoreTrajectory(t, s.config))
        set({
          batch,
          phase: 2,
          stage: 'reward',
          trainingUsage: addUsage(s.trainingUsage, batchUsage(batch, 'grade', s.config)),
        })
      } else if (s.phase === 2) {
        set({ batch: prepareAdvantages(s.batch, s.config, s.learner.policy.baseline), phase: 3, stage: 'advantage' })
      } else if (s.phase === 3) {
        const pending = updatePolicy(s.learner.policy, s.reference, s.batch, s.config)
        set({
          pending,
          phase: 4,
          stage: 'update',
          trainingUsage: addUsage(s.trainingUsage, batchUsage(s.batch, 'train', s.config)),
        })
      } else if (s.phase === 4 && s.pending) {
        const learner: Checkpoint = {
          version: s.learner.version + 1,
          policy: s.pending.policy,
          config: { ...s.config },
        }
        set({
          learner,
          checkpoints: [...s.checkpoints, learner],
          selectedVersion: learner.version,
          phase: 5,
          stage: 'checkpoint',
          canary: null,
        })
      } else if (s.phase === 5 && s.pending) {
        const validation = evaluate(s.learner, 'validation')
        const sampler = s.config.autoSync ? s.learner : s.sampler
        const history: RoundResult[] = [
          ...s.history,
          {
            round: s.round + 1,
            reward: s.batch.reduce((a, t) => a + t.reward, 0) / s.batch.length,
            success: s.batch.filter((t) => t.outcome.resolved).length / s.batch.length,
            validation: validation.resolved / validation.count,
            kl: s.pending.kl,
            clipped: s.pending.clipped,
            samplerVersion: sampler.version,
            version: s.learner.version,
          },
        ]
        set({
          sampler,
          phase: 0,
          stage: 'sync',
          round: s.round + 1,
          history,
          validations: { ...s.validations, [s.learner.version]: validation },
          evaluationUsage: addUsage(s.evaluationUsage, validation.usage),
          playing: s.playing && s.round + 1 < s.config.rounds && s.config.autoSync,
        })
      }
    } catch (error) {
      set({ playing: false, error: error instanceof Error ? error.message : '实验计算失败，请重置实验。' })
    }
  },
  syncSampler: () => set((s) => ({ sampler: s.learner, error: null, playing: false, stage: 'sync' })),
  selectTrajectory: (index) => set({ selectedTrajectory: index, selectedStep: 0 }),
  selectStep: (selectedStep) => set({ selectedStep }),
  selectVersion: (selectedVersion) => set({ selectedVersion, canary: null }),
  runTest: () => {
    const s = get()
    const cp = s.checkpoints.find((c) => c.version === s.selectedVersion)
    if (!cp) return
    const result = evaluate(cp, 'test')
    const base = s.tests[0] ?? (cp.version === 0 ? result : evaluate(s.checkpoints[0], 'test'))
    const usage = !s.tests[0] && cp.version !== 0 ? addUsage(result.usage, base.usage) : result.usage
    set({
      tests: { ...s.tests, 0: base, [cp.version]: result },
      evaluationUsage: addUsage(s.evaluationUsage, usage),
      stage: 'evaluate',
    })
  },
  setProductionFailure: (rate) => set({ productionFailure: Math.max(0, Math.min(1, rate)), canary: null }),
  runCanary: () => {
    const s = get()
    const current = s.checkpoints.find((c) => c.version === s.productionVersion)!
    const candidate = s.checkpoints.find((c) => c.version === s.selectedVersion)!
    const control = evaluateProduction(current, s.productionFailure)
    const result = evaluateProduction(candidate, s.productionFailure)
    set({
      canary: { control, candidate: result },
      productionUsage: addUsage(s.productionUsage, addUsage(control.usage, result.usage)),
      stage: 'deploy',
      releases: [...s.releases, release(candidate, result, 'canary')],
    })
  },
  promote: () => {
    const s = get()
    if (!s.canary || !s.tests[s.selectedVersion]) return
    const { control, candidate } = s.canary
    const test = s.tests[s.selectedVersion]
    const baseTest = s.tests[0]
    if (
      !baseTest ||
      test.resolved < baseTest.resolved ||
      test.violations > baseTest.violations ||
      candidate.version !== s.selectedVersion ||
      candidate.resolved < control.resolved ||
      candidate.violations > control.violations ||
      s.selectedVersion === s.productionVersion
    )
      return
    const cp = s.checkpoints.find((c) => c.version === s.selectedVersion)!
    set({
      previousProduction: s.productionVersion,
      productionVersion: s.selectedVersion,
      releases: [...s.releases, release(cp, candidate, 'promote')],
      canary: null,
      stage: 'deploy',
    })
  },
  rollback: () => {
    const s = get()
    if (s.previousProduction === null) return
    const cp = s.checkpoints.find((c) => c.version === s.previousProduction)!
    const result = evaluateProduction(cp, s.productionFailure)
    set({
      productionVersion: cp.version,
      previousProduction: s.productionVersion,
      productionUsage: addUsage(s.productionUsage, result.usage),
      releases: [...s.releases, release(cp, result, 'rollback')],
      canary: null,
      stage: 'feedback',
    })
  },
  setPrices: (patch) => set((s) => ({ prices: { ...s.prices, ...patch } })),
}))
function release(cp: Checkpoint, result: EvaluationResult, kind: Release['kind']): Release {
  return {
    version: cp.version,
    harness: '客服 Harness v1',
    tools: '模拟工具 v1',
    reward: `${cp.config.rewardMode} / v1`,
    evaluation: '独立业务验收 v1',
    kind,
    result,
  }
}
// Whitelist only preferences; trajectories, weights, cost ledgers and test results never enter storage.
useRlStore.subscribe((s, prev) => {
  if (s.config === prev.config && s.view === prev.view && s.stage === prev.stage && s.completed === prev.completed)
    return
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, config: s.config, view: s.view, stage: s.stage, completed: s.completed }),
    )
  } catch {
    /* private browsing / quota: session remains usable */
  }
})
