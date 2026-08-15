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

// /inference 三个面板（生命周期模拟 / 显存计算器 / Token 经济）共享的推理参数：
// 同一份 模型/GPU/量化/batch/缓存命中率，切 tab 结论不打架；会话内共享、不持久化。
// 面板专属参数（上下文长度、价目、时租、利用率等）仍留在各组件本地。
export type QuantId = 'fp16' | 'fp8' | 'int4'

interface InferenceParamsState {
  modelId: string
  gpuId: string
  quantId: QuantId
  batch: number
  cacheRate: number // 前缀缓存命中率 0~0.95
  setModelId: (modelId: string) => void
  setGpuId: (gpuId: string) => void
  setQuantId: (quantId: QuantId) => void
  setBatch: (batch: number) => void
  setCacheRate: (cacheRate: number) => void
}

export const useInferenceParams = create<InferenceParamsState>()((set) => ({
  modelId: 'deepseek-v3',
  gpuId: 'h100',
  quantId: 'fp8',
  batch: 16,
  cacheRate: 0.7,
  setModelId: (modelId) => set({ modelId }),
  setGpuId: (gpuId) => set({ gpuId }),
  setQuantId: (quantId) => set({ quantId }),
  setBatch: (batch) => set({ batch }),
  setCacheRate: (cacheRate) => set({ cacheRate }),
}))

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
