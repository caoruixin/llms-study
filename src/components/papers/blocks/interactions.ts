import type { ProfileEvidence } from '../../../lib/paper/learnerProfile'

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
}
