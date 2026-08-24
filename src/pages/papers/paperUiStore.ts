import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PaperRecord, SourceAnchor } from '../../lib/paper/types'
import type { BriefData } from '../../lib/paper/briefPipeline'

/**
 * 论文陪读专属的轻量 UI 状态。
 * 有意**不并入 src/store.ts**：store.ts 从 main.tsx 静态可达，一旦在那里 import paper 类型/模块，
 * 整条 paper 依赖链就会被拉进首页主 chunk，违反 §11.4 的包体约束。
 *
 * 持久化范围只有四个**布局偏好**（见 LayoutPrefs）：阅读位置、待提问队列、论文地图等
 * 运行时状态要么已在 Dexie 里，要么本就该随会话丢弃，一律不进 localStorage。
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
  /** 选区来自应用内生成的中文译文：队列卡片加「译文」徽章，消费时提示模型以原文语义为准 */
  translated?: boolean
}

/** 论文地图生成进度（CopilotPanel 写入，OutlinePane 展示；跨栏共享走 store） */
export interface BriefUiState {
  paperId: string
  status: 'running' | 'done' | 'error'
  done: number
  total: number
  error?: string
}

export interface BriefDataState {
  paperId: string
  data: BriefData
}

// ---------------------------------------------------------------------------
// 工作台布局偏好（宽度档位 / 专注陪读 / 持久化）
// ---------------------------------------------------------------------------

/** Copilot 宽度档位：标准 352 → 加宽 480 → 超宽 640（渲染层的类名映射在 PaperWorkbenchPage） */
export type CopilotWidth = 'standard' | 'wide' | 'max'

/** 档位循环顺序；超宽只在桌面（≥1280）可选——平板下正文会被压到 360px 以下 */
const WIDTH_ORDER = ['standard', 'wide', 'max'] as const satisfies readonly CopilotWidth[]
const TABLET_WIDTHS = ['standard', 'wide'] as const satisfies readonly CopilotWidth[]

export function allowedCopilotWidths(isDesktop: boolean): readonly CopilotWidth[] {
  return isDesktop ? WIDTH_ORDER : TABLET_WIDTHS
}

/** 偏好档位不在当前视口的可选集里（平板残留 'max'）时钳到最宽可选档；**不回写 store**，回到桌面仍是超宽 */
export function effectiveCopilotWidth(pref: CopilotWidth, allowed: readonly CopilotWidth[]): CopilotWidth {
  return allowed.includes(pref) ? pref : allowed[allowed.length - 1]
}

/** 单按钮循环切档，走到末档回绕到首档 */
export function nextCopilotWidth(current: CopilotWidth, allowed: readonly CopilotWidth[]): CopilotWidth {
  const index = allowed.indexOf(effectiveCopilotWidth(current, allowed))
  return allowed[(index + 1) % allowed.length]
}

/** 进 localStorage 的白名单——partialize 与 sanitize 共用同一份，防止两处漂移 */
export interface LayoutPrefs {
  copilotOpen: boolean
  outlineOpen: boolean
  copilotWidth: CopilotWidth
  readerCollapsed: boolean
}

const DEFAULT_LAYOUT: LayoutPrefs = {
  copilotOpen: false,
  outlineOpen: true,
  copilotWidth: 'standard',
  readerCollapsed: false,
}

const isCopilotWidth = (v: unknown): v is CopilotWidth => WIDTH_ORDER.includes(v as CopilotWidth)

/**
 * localStorage 一律当不可信输入：类型不对的字段退回默认值，非法组合就地修复
 * （readerCollapsed 且 Copilot 收起 = 正文和 Copilot 都没了，只剩空白工作台）。
 */
export function sanitizeLayoutPrefs(raw: unknown): LayoutPrefs {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_LAYOUT }
  const o = raw as Record<string, unknown>
  const copilotOpen = typeof o.copilotOpen === 'boolean' ? o.copilotOpen : DEFAULT_LAYOUT.copilotOpen
  return {
    copilotOpen,
    outlineOpen: typeof o.outlineOpen === 'boolean' ? o.outlineOpen : DEFAULT_LAYOUT.outlineOpen,
    copilotWidth: isCopilotWidth(o.copilotWidth) ? o.copilotWidth : DEFAULT_LAYOUT.copilotWidth,
    readerCollapsed: copilotOpen && typeof o.readerCollapsed === 'boolean' ? o.readerCollapsed : false,
  }
}

interface PaperUiState extends LayoutPrefs {
  sortBy: PaperSortBy
  filter: PaperFilter
  pendingDuplicate: PendingDuplicate | null
  confirmDeleteId: string | null
  /** 待提问队列：由 Copilot 会话消费 */
  pendingAsks: PendingAsk[]
  briefUi: BriefUiState | null
  briefData: BriefDataState | null
  /** OutlinePane 的「生成论文地图」入口 → CopilotPanel 监听 tick 发起管线（面板收起时先展开） */
  briefRequestTick: number
  setSortBy: (sortBy: PaperSortBy) => void
  setFilter: (filter: PaperFilter) => void
  setCopilotOpen: (copilotOpen: boolean) => void
  setOutlineOpen: (outlineOpen: boolean) => void
  setCopilotWidth: (copilotWidth: CopilotWidth) => void
  setReaderCollapsed: (readerCollapsed: boolean) => void
  setPendingDuplicate: (pendingDuplicate: PendingDuplicate | null) => void
  setConfirmDeleteId: (confirmDeleteId: string | null) => void
  addPendingAsk: (ask: Omit<PendingAsk, 'id' | 'at'>) => void
  removePendingAsk: (id: string) => void
  clearPendingAsks: () => void
  setBriefUi: (briefUi: BriefUiState | null) => void
  setBriefData: (briefData: BriefDataState | null) => void
  requestBrief: () => void
}

const askId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export const usePaperUi = create<PaperUiState>()(
  persist(
    (set) => ({
      sortBy: 'lastRead',
      filter: 'all',
      ...DEFAULT_LAYOUT,
      pendingDuplicate: null,
      confirmDeleteId: null,
      pendingAsks: [],
      briefUi: null,
      briefData: null,
      briefRequestTick: 0,
      setSortBy: (sortBy) => set({ sortBy }),
      setFilter: (filter) => set({ filter }),
      // 不变量：收起 Copilot 必须同时退出专注陪读，否则正文与 Copilot 会一起消失
      setCopilotOpen: (copilotOpen) => set(copilotOpen ? { copilotOpen } : { copilotOpen, readerCollapsed: false }),
      setOutlineOpen: (outlineOpen) => set({ outlineOpen }),
      setCopilotWidth: (copilotWidth) => set({ copilotWidth }),
      // 不变量的另一半：专注陪读必然带着 Copilot 一起在
      setReaderCollapsed: (readerCollapsed) =>
        set(readerCollapsed ? { readerCollapsed, copilotOpen: true } : { readerCollapsed }),
      setPendingDuplicate: (pendingDuplicate) => set({ pendingDuplicate }),
      setConfirmDeleteId: (confirmDeleteId) => set({ confirmDeleteId }),
      addPendingAsk: (ask) =>
        set((s) => ({ pendingAsks: [...s.pendingAsks, { ...ask, id: askId(), at: Date.now() }] })),
      removePendingAsk: (id) => set((s) => ({ pendingAsks: s.pendingAsks.filter((a) => a.id !== id) })),
      clearPendingAsks: () => set({ pendingAsks: [] }),
      setBriefUi: (briefUi) => set({ briefUi }),
      setBriefData: (briefData) => set({ briefData }),
      requestBrief: () => set((s) => ({ briefRequestTick: s.briefRequestTick + 1, copilotOpen: true })),
    }),
    {
      name: 'paper-ui-layout',
      version: 1,
      // 仿 src/store.ts 先例：白名单式 partialize，运行时状态（pendingAsks/briefData/…）绝不落盘
      partialize: (s): LayoutPrefs => ({
        copilotOpen: s.copilotOpen,
        outlineOpen: s.outlineOpen,
        copilotWidth: s.copilotWidth,
        readerCollapsed: s.readerCollapsed,
      }),
      merge: (persisted, current) => ({ ...current, ...sanitizeLayoutPrefs(persisted) }),
    },
  ),
)
