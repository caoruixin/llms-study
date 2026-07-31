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
    defaultModel: 'gpt-5.5',
    supportsJsonMode: true,
  },
]

const KEY_STORAGE = 'llm-user-key' // sessionStorage：key 不落 localStorage

interface SettingsState {
  provider: ProviderId
  model: string
  userKey: string
  setProvider: (p: ProviderId) => void
  setModel: (m: string) => void
  setUserKey: (k: string) => void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      userKey: typeof sessionStorage !== 'undefined' ? (sessionStorage.getItem(KEY_STORAGE) ?? '') : '',
      setProvider: (provider) =>
        set({ provider, model: PROVIDERS.find((p) => p.id === provider)?.defaultModel ?? '' }),
      setModel: (model) => set({ model }),
      setUserKey: (userKey) => {
        sessionStorage.setItem(KEY_STORAGE, userKey)
        set({ userKey })
      },
    }),
    {
      name: 'llm-infra-settings',
      partialize: (s) => ({ provider: s.provider, model: s.model }), // userKey 不持久化到 localStorage
    },
  ),
)

interface HistoryState {
  attempts: AttemptRecord[]
  addAttempt: (a: AttemptRecord) => void
  clear: () => void
}

export const useHistory = create<HistoryState>()(
  persist(
    (set) => ({
      attempts: [],
      addAttempt: (a) => set((s) => ({ attempts: [a, ...s.attempts] })),
      clear: () => set({ attempts: [] }),
    }),
    { name: 'llm-infra-history' },
  ),
)
