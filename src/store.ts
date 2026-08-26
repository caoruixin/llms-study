import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AttemptRecord } from './data/types'

export type ProviderId = 'moonshot' | 'zhipu' | 'deepseek' | 'openai-compat'

export interface ProviderPreset {
  id: ProviderId
  label: string
  proxyPrefix: string
  chatPath: string // 代理前缀后的上游路径
  defaultModel: string
  supportsJsonMode: boolean
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'moonshot',
    label: 'Kimi (Moonshot)',
    proxyPrefix: '/api/moonshot',
    chatPath: '/v1/chat/completions',
    defaultModel: 'kimi-k3',
    supportsJsonMode: true,
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    proxyPrefix: '/api/zhipu',
    chatPath: '/api/paas/v4/chat/completions',
    defaultModel: 'glm-5.2',
    supportsJsonMode: false,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    proxyPrefix: '/api/deepseek',
    chatPath: '/chat/completions',
    defaultModel: 'deepseek-v4-flash',
    supportsJsonMode: true,
  },
  {
    id: 'openai-compat',
    label: 'OpenAI 兼容端点',
    proxyPrefix: '/api/openai-compat',
    chatPath: '/v1/chat/completions',
    defaultModel: 'gpt-5.6-terra', // 与 src/data/pricing.ts 现有条目对齐
    supportsJsonMode: true,
  },
]

// 旧版残留清理：自带 key 已迁移到账号体系（加密存服务端、按登录态注入），
// 浏览器端不再保存任何 LLM key；老会话的 sessionStorage 残留在启动时抹掉
if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('llm-user-key')

interface SettingsState {
  provider: ProviderId
  model: string
  setProvider: (p: ProviderId) => void
  setModel: (m: string) => void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      setProvider: (provider) =>
        set({ provider, model: PROVIDERS.find((p) => p.id === provider)?.defaultModel ?? '' }),
      setModel: (model) => set({ model }),
    }),
    {
      name: 'llm-infra-settings',
      partialize: (s) => ({ provider: s.provider, model: s.model }),
    },
  ),
)

// /inference 全部面板共享的场景参数：切 tab 后模型、负载、SLO、Sizing 与成本口径不打架。
// 只在当前浏览器会话内保存，不持久化；客户 benchmark 信息不落 localStorage/IndexedDB。
export type QuantId = 'fp16' | 'fp8' | 'int4'

export interface InferenceSlo {
  ttftMs: number | null
  tpotMs: number | null
  e2eMs: number | null
  attainment: number | null // 0~1；必须由客户场景显式输入，不设通用默认值
}

export type SystemTpsSource = 'estimated' | 'manual'

type InferenceTpsContext = Pick<
  InferenceParamsState,
  'modelId' | 'gpuId' | 'quantId' | 'batch' | 'inputTokens' | 'outputTokens' | 'gpusPerCapacityUnit'
>

/** Identifies exactly which scenario a capacity-unit TPS value belongs to. */
export function inferenceTpsFingerprint(context: InferenceTpsContext): string {
  return JSON.stringify([
    context.modelId,
    context.gpuId,
    context.quantId,
    context.batch,
    context.inputTokens,
    context.outputTokens,
    context.gpusPerCapacityUnit,
  ])
}

export interface InferenceParamsState {
  modelId: string
  gpuId: string
  quantId: QuantId
  batch: number
  cacheRate: number // 前缀缓存命中率 0~0.95
  // 诊断用的预期前缀命中率 0~1：cacheRate 是估算假设，不能自动当成诊断预期；
  // 保持 null 直到用户显式设置，cache-hit-gap 规则才会启用
  expectedPrefixHitRate: number | null
  inputTokens: number
  outputTokens: number
  peakRps: number
  concurrency: number
  slo: InferenceSlo
  headroom: number // 容量余量 0~1
  spareUnits: number // N+1 默认 1
  gpusPerCapacityUnit: number
  gpusPerServer: number | null // 不隐藏猜拓扑；用户未给则 server/rack 结果 N/A
  serversPerRack: number | null
  gpuCount: number
  systemTps: number // 每个容量单元的系统输出 TPS
  systemTpsFingerprint: string | null
  systemTpsSource: SystemTpsSource | null
  utilization: number // 成本模型的有效利用率，不等于 GPU utilization 遥测
  hourlyCost: number // 当前 gpuCount 对应的整集群 $/h
  setModelId: (modelId: string) => void
  setGpuId: (gpuId: string) => void
  setQuantId: (quantId: QuantId) => void
  setBatch: (batch: number) => void
  setCacheRate: (cacheRate: number) => void
  setExpectedPrefixHitRate: (expectedPrefixHitRate: number | null) => void
  setInputTokens: (inputTokens: number) => void
  setOutputTokens: (outputTokens: number) => void
  setPeakRps: (peakRps: number) => void
  setConcurrency: (concurrency: number) => void
  setSlo: (slo: Partial<InferenceSlo>) => void
  setHeadroom: (headroom: number) => void
  setSpareUnits: (spareUnits: number) => void
  setGpusPerCapacityUnit: (gpusPerCapacityUnit: number) => void
  setGpusPerServer: (gpusPerServer: number | null) => void
  setServersPerRack: (serversPerRack: number | null) => void
  setGpuCount: (gpuCount: number) => void
  setSystemTps: (systemTps: number, source?: SystemTpsSource) => void
  setUtilization: (utilization: number) => void
  setHourlyCost: (hourlyCost: number) => void
}

const INITIAL_TPS_CONTEXT = {
  modelId: 'deepseek-v3',
  gpuId: 'h100',
  quantId: 'fp8' as QuantId,
  batch: 16,
  inputTokens: 16_000,
  outputTokens: 512,
  gpusPerCapacityUnit: 8,
}

const invalidateTps = { systemTpsFingerprint: null, systemTpsSource: null } as const

export const useInferenceParams = create<InferenceParamsState>()((set) => ({
  modelId: 'deepseek-v3',
  gpuId: 'h100',
  quantId: 'fp8',
  batch: 16,
  cacheRate: 0.7,
  expectedPrefixHitRate: null,
  inputTokens: 16_000,
  outputTokens: 512,
  peakRps: 20,
  concurrency: 32,
  slo: { ttftMs: null, tpotMs: null, e2eMs: null, attainment: null },
  headroom: 0.2,
  spareUnits: 1,
  gpusPerCapacityUnit: 8,
  gpusPerServer: null,
  serversPerRack: null,
  gpuCount: 8,
  systemTps: 5000,
  systemTpsFingerprint: inferenceTpsFingerprint(INITIAL_TPS_CONTEXT),
  systemTpsSource: 'manual',
  utilization: 0.4,
  hourlyCost: 27.2,
  setModelId: (modelId) => set({ modelId, ...invalidateTps }),
  setGpuId: (gpuId) => set({ gpuId, ...invalidateTps }),
  setQuantId: (quantId) => set({ quantId, ...invalidateTps }),
  setBatch: (batch) => set({ batch: Math.max(1, Math.round(batch)), ...invalidateTps }),
  setCacheRate: (cacheRate) => set({ cacheRate: Math.min(0.95, Math.max(0, cacheRate)) }),
  setExpectedPrefixHitRate: (expectedPrefixHitRate) =>
    set({
      expectedPrefixHitRate:
        expectedPrefixHitRate === null ? null : Math.min(1, Math.max(0, expectedPrefixHitRate)),
    }),
  setInputTokens: (inputTokens) => set({ inputTokens: Math.max(1, Math.round(inputTokens)), ...invalidateTps }),
  setOutputTokens: (outputTokens) => set({ outputTokens: Math.max(1, Math.round(outputTokens)), ...invalidateTps }),
  setPeakRps: (peakRps) => set({ peakRps: Math.max(0, peakRps) }),
  setConcurrency: (concurrency) => set({ concurrency: Math.max(1, Math.round(concurrency)) }),
  setSlo: (next) =>
    set((state) => ({
      slo: {
        ...state.slo,
        ...next,
        ttftMs:
          next.ttftMs === undefined
            ? state.slo.ttftMs
            : next.ttftMs === null
              ? null
              : Math.max(0, next.ttftMs),
        tpotMs:
          next.tpotMs === undefined
            ? state.slo.tpotMs
            : next.tpotMs === null
              ? null
              : Math.max(0, next.tpotMs),
        e2eMs:
          next.e2eMs === undefined
            ? state.slo.e2eMs
            : next.e2eMs === null
              ? null
              : Math.max(0, next.e2eMs),
        attainment:
          next.attainment === undefined
            ? state.slo.attainment
            : next.attainment === null
              ? null
              : Math.min(1, Math.max(0, next.attainment)),
      },
    })),
  setHeadroom: (headroom) => set({ headroom: Math.min(1, Math.max(0, headroom)) }),
  setSpareUnits: (spareUnits) => set({ spareUnits: Math.max(0, Math.round(spareUnits)) }),
  setGpusPerCapacityUnit: (gpusPerCapacityUnit) =>
    set({ gpusPerCapacityUnit: Math.max(1, Math.round(gpusPerCapacityUnit)), ...invalidateTps }),
  setGpusPerServer: (gpusPerServer) =>
    set({ gpusPerServer: gpusPerServer === null ? null : Math.max(1, Math.round(gpusPerServer)) }),
  setServersPerRack: (serversPerRack) =>
    set({ serversPerRack: serversPerRack === null ? null : Math.max(1, Math.round(serversPerRack)) }),
  setGpuCount: (gpuCount) => set({ gpuCount: Math.max(1, Math.round(gpuCount)) }),
  setSystemTps: (systemTps, source = 'manual') =>
    set((state) => ({
      systemTps: Math.max(1, systemTps),
      systemTpsFingerprint: inferenceTpsFingerprint(state),
      systemTpsSource: source,
    })),
  setUtilization: (utilization) => set({ utilization: Math.min(0.99, Math.max(0.01, utilization)) }),
  setHourlyCost: (hourlyCost) => set({ hourlyCost: Math.max(0, hourlyCost) }),
}))

// 新名称表达「场景」含义；保留 useInferenceParams 供现有面板与架构图谱无缝兼容。
export const useInferenceScenario = useInferenceParams

interface HistoryState {
  attempts: AttemptRecord[]
  addAttempt: (a: AttemptRecord) => void
  removeAttempt: (id: string) => void
  clearQuestion: (questionId: string) => void
  clear: () => void
}

// 每题只保留最近 N 次作答：attempts 持久化在 localStorage（含完整回答文本），不设上限会无界膨胀
const HISTORY_CAP_PER_QUESTION = 20

// 记录 id：优先 crypto.randomUUID，降级为时间戳+随机后缀（与 paperRepo 的 newId 同一惯例）。
// 纯毫秒时间戳同毫秒会撞车——既是按 id 删除的正确性隐患，也是 React key 冲突隐患。
export const newAttemptId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export const useHistory = create<HistoryState>()(
  persist(
    (set) => ({
      attempts: [],
      addAttempt: (a) =>
        set((s) => {
          const next = [a, ...s.attempts] // 新的在前
          let kept = 0
          return {
            attempts: next.filter((x) => x.questionId !== a.questionId || ++kept <= HISTORY_CAP_PER_QUESTION),
          }
        }),
      removeAttempt: (id) => set((s) => ({ attempts: s.attempts.filter((x) => x.id !== id) })),
      clearQuestion: (questionId) =>
        set((s) => ({ attempts: s.attempts.filter((x) => x.questionId !== questionId) })),
      clear: () => set({ attempts: [] }),
    }),
    {
      name: 'llm-infra-history',
      version: 1, // v1：旧记录 id 为纯毫秒时间戳可能重复，迁移时对重复/缺失 id 重新生成
      migrate: (persisted: unknown) => {
        const s = persisted as { attempts?: AttemptRecord[] } | undefined
        const seen = new Set<string>()
        const attempts = (s?.attempts ?? []).map((a) => {
          if (!a.id || seen.has(a.id)) return { ...a, id: newAttemptId() }
          seen.add(a.id)
          return a
        })
        return { attempts } as HistoryState
      },
    },
  ),
)
