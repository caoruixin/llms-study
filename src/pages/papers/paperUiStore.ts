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

// ---------------------------------------------------------------------------
// 语音陪读（voice copilot）
// ---------------------------------------------------------------------------

/**
 * 语音提问载荷：悬浮球（PaperWorkbenchPage）写入、CopilotPanel 消费后立即清空。
 * 有意用 consume-and-clear 而不是 briefRequestTick 的 tick+seenTick——面板未挂载时
 * tick 先加、面板后挂，useRef(tick) 初始化即等于新值，effect 永不触发（手机 sheet 必踩）。
 */
export interface VoiceAsk {
  id: string
  paperId: string
  /** 语音转写文本（displayText 与 question 的共同来源） */
  text: string
  /** 发送瞬间快照的划词选区 */
  selection: string | null
  /** 发送瞬间快照的屏幕可见正文（voice/viewportContext 产物） */
  viewportContext: string | null
  /** 本轮回答是否自动朗读 */
  speak: boolean
  at: number
}

/** 面板回写给悬浮球的轮次阶段（粗粒度：一轮只有个位数次写入，不放高频数据） */
export type VoiceTurnPhase = 'idle' | 'thinking' | 'speaking' | 'done' | 'error'

/** 进 localStorage 的语音偏好白名单——与 sanitizeVoicePrefs 共用一份，防两处漂移 */
export interface VoicePrefs {
  /** 语音提问的回答自动朗读 */
  voiceSpeakAloud: boolean
  /** 打字提问也自动朗读（默认关；手动「边生成边朗读」按钮不受影响） */
  voiceSpeakTypedTurns: boolean
  /** 连续对话：回答读完自动重新收音 */
  voiceContinuous: boolean
  /** 桌面端「按住 V 说话」热键 */
  voiceHotkey: boolean
  /** 云端 TTS 音色 id（'' = 服务端默认） */
  voiceTtsVoice: string
  /** 朗读引擎：云端更自然 / 浏览器免费离线 */
  voiceTtsEngine: 'cloud' | 'browser'
  /** 隐藏悬浮麦克风球 */
  voiceBallHidden: boolean
}

const DEFAULT_VOICE_PREFS: VoicePrefs = {
  voiceSpeakAloud: true,
  voiceSpeakTypedTurns: false,
  voiceContinuous: false,
  voiceHotkey: true,
  voiceTtsVoice: '',
  voiceTtsEngine: 'cloud',
  voiceBallHidden: false,
}

/** localStorage 视为不可信输入（同 sanitizeLayoutPrefs）：坏值只污染自己那一格 */
export function sanitizeVoicePrefs(raw: unknown): VoicePrefs {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_VOICE_PREFS }
  const o = raw as Record<string, unknown>
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
  return {
    voiceSpeakAloud: bool(o.voiceSpeakAloud, DEFAULT_VOICE_PREFS.voiceSpeakAloud),
    voiceSpeakTypedTurns: bool(o.voiceSpeakTypedTurns, DEFAULT_VOICE_PREFS.voiceSpeakTypedTurns),
    voiceContinuous: bool(o.voiceContinuous, DEFAULT_VOICE_PREFS.voiceContinuous),
    voiceHotkey: bool(o.voiceHotkey, DEFAULT_VOICE_PREFS.voiceHotkey),
    voiceTtsVoice:
      typeof o.voiceTtsVoice === 'string' && o.voiceTtsVoice.length <= 120
        ? o.voiceTtsVoice
        : DEFAULT_VOICE_PREFS.voiceTtsVoice,
    voiceTtsEngine:
      o.voiceTtsEngine === 'cloud' || o.voiceTtsEngine === 'browser'
        ? o.voiceTtsEngine
        : DEFAULT_VOICE_PREFS.voiceTtsEngine,
    voiceBallHidden: bool(o.voiceBallHidden, DEFAULT_VOICE_PREFS.voiceBallHidden),
  }
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

interface PaperUiState extends LayoutPrefs, VoicePrefs {
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
  /** 语音提问载荷（consume-and-clear，见 VoiceAsk 注释）；以下语音运行时状态一律不落盘 */
  voiceAsk: VoiceAsk | null
  voiceTurnPhase: VoiceTurnPhase
  voiceTurnError: string | null
  /** CopilotPanel 是否有轮次在飞（悬浮球据此拒绝新提问 / 暂停连续模式重臂） */
  voicePanelBusy: boolean
  /** 悬浮球打断朗读的信号（ball → panel；面板 stopSpeaking，不停止生成） */
  voiceStopSpeakTick: number
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
  setVoicePrefs: (patch: Partial<VoicePrefs>) => void
  /** 悬浮球提交语音提问：面板收起时顺带展开（requestBrief 先例），并复位上一轮的阶段/错误 */
  requestVoiceAsk: (ask: Omit<VoiceAsk, 'id' | 'at'>) => void
  consumeVoiceAsk: () => void
  setVoiceTurnPhase: (voiceTurnPhase: VoiceTurnPhase, voiceTurnError?: string | null) => void
  setVoicePanelBusy: (voicePanelBusy: boolean) => void
  requestStopSpeak: () => void
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
      ...DEFAULT_VOICE_PREFS,
      pendingDuplicate: null,
      confirmDeleteId: null,
      pendingAsks: [],
      briefUi: null,
      briefData: null,
      briefRequestTick: 0,
      voiceAsk: null,
      voiceTurnPhase: 'idle',
      voiceTurnError: null,
      voicePanelBusy: false,
      voiceStopSpeakTick: 0,
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
      setVoicePrefs: (patch) => set(patch),
      requestVoiceAsk: (ask) =>
        set({
          voiceAsk: { ...ask, id: askId(), at: Date.now() },
          copilotOpen: true,
          voiceTurnPhase: 'idle',
          voiceTurnError: null,
        }),
      consumeVoiceAsk: () => set({ voiceAsk: null }),
      setVoiceTurnPhase: (voiceTurnPhase, voiceTurnError = null) => set({ voiceTurnPhase, voiceTurnError }),
      setVoicePanelBusy: (voicePanelBusy) => set({ voicePanelBusy }),
      requestStopSpeak: () => set((s) => ({ voiceStopSpeakTick: s.voiceStopSpeakTick + 1 })),
    }),
    {
      name: 'paper-ui-layout',
      version: 1,
      // 仿 src/store.ts 先例：白名单式 partialize，运行时状态（pendingAsks/briefData/voiceAsk/…）绝不落盘
      partialize: (s): LayoutPrefs & VoicePrefs => ({
        copilotOpen: s.copilotOpen,
        outlineOpen: s.outlineOpen,
        copilotWidth: s.copilotWidth,
        readerCollapsed: s.readerCollapsed,
        voiceSpeakAloud: s.voiceSpeakAloud,
        voiceSpeakTypedTurns: s.voiceSpeakTypedTurns,
        voiceContinuous: s.voiceContinuous,
        voiceHotkey: s.voiceHotkey,
        voiceTtsVoice: s.voiceTtsVoice,
        voiceTtsEngine: s.voiceTtsEngine,
        voiceBallHidden: s.voiceBallHidden,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...sanitizeLayoutPrefs(persisted),
        ...sanitizeVoicePrefs(persisted),
      }),
    },
  ),
)
