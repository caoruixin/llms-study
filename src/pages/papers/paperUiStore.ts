import { create } from 'zustand'
import type { PaperRecord } from '../../lib/paper/types'

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

interface PaperUiState {
  sortBy: PaperSortBy
  filter: PaperFilter
  copilotOpen: boolean
  pendingDuplicate: PendingDuplicate | null
  confirmDeleteId: string | null
  setSortBy: (sortBy: PaperSortBy) => void
  setFilter: (filter: PaperFilter) => void
  setCopilotOpen: (copilotOpen: boolean) => void
  setPendingDuplicate: (pendingDuplicate: PendingDuplicate | null) => void
  setConfirmDeleteId: (confirmDeleteId: string | null) => void
}

export const usePaperUi = create<PaperUiState>()((set) => ({
  sortBy: 'lastRead',
  filter: 'all',
  copilotOpen: false,
  pendingDuplicate: null,
  confirmDeleteId: null,
  setSortBy: (sortBy) => set({ sortBy }),
  setFilter: (filter) => set({ filter }),
  setCopilotOpen: (copilotOpen) => set({ copilotOpen }),
  setPendingDuplicate: (pendingDuplicate) => set({ pendingDuplicate }),
  setConfirmDeleteId: (confirmDeleteId) => set({ confirmDeleteId }),
}))
