import { create } from 'zustand'
import type { PaperRecord, SourceAnchor } from '../../lib/paper/types'

/**
 * 论文陪读专属的轻量 UI 状态。
 * 有意**不并入 src/store.ts**：store.ts 从 main.tsx 静态可达，一旦在那里 import paper 类型/模块，
 * 整条 paper 依赖链就会被拉进首页主 chunk，违反 §11.4 的包体约束。
 * 不做持久化——阅读位置等真正需要留存的状态已经在 Dexie 里。
 */

export type PaperSortBy = 'lastRead' | 'created' | 'title'
export type PaperFilter = 'all' | 'processing' | 'ready' | 'failed'

/** 重复导入待决状态：命中 SHA-256 去重时挂起，等用户选择打开已有 / 替换导入 */
export interface PendingDuplicate {
  existing: PaperRecord
  fileName: string
}

/** 选区快捷操作（§3.3）。Phase 2 只入队，Phase 3 由 Copilot 消费 */
export type PaperAskAction = 'explain' | 'simpler' | 'derive' | 'example' | 'queue'

export const PAPER_ASK_ACTIONS: readonly { id: PaperAskAction; label: string }[] = [
  { id: 'explain', label: '解释这段' },
  { id: 'simpler', label: '更简单' },
  { id: 'derive', label: '推导公式' },
  { id: 'example', label: '举例' },
  { id: 'queue', label: '加入提问' },
]

/** 选区文本上限沿 SelectionAsk 先例：4000 字符 */
export const MAX_ASK_TEXT = 4000

export interface PendingAsk {
  id: string
  paperId: string
  action: PaperAskAction
  label: string
  text: string
  anchor: SourceAnchor
  at: number
}

interface PaperUiState {
  sortBy: PaperSortBy
  filter: PaperFilter
  copilotOpen: boolean
  outlineOpen: boolean
  pendingDuplicate: PendingDuplicate | null
  confirmDeleteId: string | null
  /** 待提问队列：Phase 3 接入 Copilot 后由会话消费，这里只负责暂存 */
  pendingAsks: PendingAsk[]
  setSortBy: (sortBy: PaperSortBy) => void
  setFilter: (filter: PaperFilter) => void
  setCopilotOpen: (copilotOpen: boolean) => void
  setOutlineOpen: (outlineOpen: boolean) => void
  setPendingDuplicate: (pendingDuplicate: PendingDuplicate | null) => void
  setConfirmDeleteId: (confirmDeleteId: string | null) => void
  addPendingAsk: (ask: Omit<PendingAsk, 'id' | 'at'>) => void
  removePendingAsk: (id: string) => void
  clearPendingAsks: () => void
}

const askId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export const usePaperUi = create<PaperUiState>()((set) => ({
  sortBy: 'lastRead',
  filter: 'all',
  copilotOpen: false,
  outlineOpen: true,
  pendingDuplicate: null,
  confirmDeleteId: null,
  pendingAsks: [],
  setSortBy: (sortBy) => set({ sortBy }),
  setFilter: (filter) => set({ filter }),
  setCopilotOpen: (copilotOpen) => set({ copilotOpen }),
  setOutlineOpen: (outlineOpen) => set({ outlineOpen }),
  setPendingDuplicate: (pendingDuplicate) => set({ pendingDuplicate }),
  setConfirmDeleteId: (confirmDeleteId) => set({ confirmDeleteId }),
  addPendingAsk: (ask) =>
    set((s) => ({ pendingAsks: [...s.pendingAsks, { ...ask, id: askId(), at: Date.now() }] })),
  removePendingAsk: (id) => set((s) => ({ pendingAsks: s.pendingAsks.filter((a) => a.id !== id) })),
  clearPendingAsks: () => set({ pendingAsks: [] }),
}))
