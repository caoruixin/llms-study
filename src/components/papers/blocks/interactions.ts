import type { ProfileEvidence } from '../../../lib/paper/learnerProfile'
import type { CopilotBlockState } from '../../../lib/paper/types'

/**
 * 交互块 → 面板的回调契约（§6.2 L1 证据源）。
 * 块本身只产出证据与请求，画像更新与 LLM 调用都由 CopilotPanel 决定。
 */
export interface BlockInteractions {
  /** 本地判分/自评结果 → 画像证据（0 次调用） */
  onEvidence?: (ev: ProfileEvidence) => void
  /** teach-back 提交 → 面板发起 1 次调用（§6.1e'） */
  onTeachBack?: (payload: { prompt: string; answer: string; concept?: string }) => void
  /** 有轮次进行中：交互块禁用发起类操作 */
  busy?: boolean
  /** 已持久化的作答状态（key = 岛序号），刷新后据此恢复 */
  blockStates?: Readonly<Record<string, CopilotBlockState>>
  /** 作答/自评结果回写消息元数据（面板负责合并 + 落库） */
  onBlockState?: (key: string, patch: CopilotBlockState) => void
}

/** 单个交互块拿到的作答状态口子（由 CopilotMessage 按岛序号派发） */
export interface BlockStateSlot {
  state?: CopilotBlockState
  onState?: (patch: CopilotBlockState) => void
}
