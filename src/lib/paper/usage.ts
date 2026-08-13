import type { ChatMessage } from '../llmClient'
import type { ModelCapability, PaperProviderId } from '../../data/paperPolicy'
import type { StreamUsage } from '../sse'

/**
 * usage / 成本归一化（§5.2/§5.4）。
 * 本地无 tokenizer，token 一律 chars/3 中英混合粗估；估算值全链路带 estimated 标记。
 */

export const estimateTokens = (text: string): number => Math.ceil(text.length / 3)

export const estimateMessagesTokens = (messages: readonly ChatMessage[]): number =>
  messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0) // +4：role 等结构开销粗估

/** 单位：美元。价格来自 paperPolicy 常量（发布前需按 sourceUrl 复核） */
export function computeCost(cap: ModelCapability, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1e6) * cap.pricing.inPerMTok + (outputTokens / 1e6) * cap.pricing.outPerMTok
}

export interface GatewayUsage {
  provider: PaperProviderId
  model: string
  inputTokens: number
  outputTokens: number
  estimated: boolean
  cost: number
}

/**
 * 归一化一次调用的 usage：provider 返回了就用真值；缺失时用 chars/3 估算并标记 estimated。
 */
export function normalizeUsage(
  cap: ModelCapability,
  usage: StreamUsage | null,
  fallback: { messages: readonly ChatMessage[]; outputText: string },
): GatewayUsage {
  const inputTokens = usage ? usage.inputTokens : estimateMessagesTokens(fallback.messages)
  const outputTokens = usage ? usage.outputTokens : estimateTokens(fallback.outputText)
  return {
    provider: cap.provider,
    model: cap.model,
    inputTokens,
    outputTokens,
    estimated: usage === null,
    cost: computeCost(cap, inputTokens, outputTokens),
  }
}

/** 调用前的成本预估（成本确认阈值判定用）：输入按实际组装的消息，输出按 maxOutputTokens 上限 */
export function estimateCallCost(
  cap: ModelCapability,
  messages: readonly ChatMessage[],
  maxOutputTokens: number,
): { inputTokens: number; outputTokens: number; cost: number } {
  const inputTokens = estimateMessagesTokens(messages)
  return { inputTokens, outputTokens: maxOutputTokens, cost: computeCost(cap, inputTokens, maxOutputTokens) }
}

export const formatUsd = (n: number): string => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)

export const formatTokens = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(1)}K` : String(n))
