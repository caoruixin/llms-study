import type { ChatMessage } from '../lib/llmClient'

/**
 * Paper Copilot 模型策略（PLAN-paper-copilot.md §5.2/§5.3/§5.4）。
 * 配置即代码：能力矩阵、任务路由、预算、价格全部是类型化常量，易变事实带 sourceUrl + asOf。
 *
 * 注意：本文件是 flag-off tree-shake 的例外——它被 paper 模块 import，flag-off 时因无人引用
 * 而被剪掉（纯常量无副作用）；主入口静态图（main/store/nav/App）禁止 import 此文件。
 */

export type PaperProviderId = 'deepseek' | 'kimi'

export interface ModelCapability {
  provider: PaperProviderId
  model: string
  proxyPrefix: '/api/deepseek' | '/api/moonshot' // 复用既有代理路由
  chatPath: string
  structured: 'json_object' | 'json_schema_strict'
  thinking: { kind: 'toggle'; defaultOn: false } | { kind: 'always'; efforts: readonly ['low', 'high', 'max'] }
  sampling: 'tunable' | 'fixed' // fixed → 禁发 temperature/top_p/presence/frequency
  maxOutputParam: 'max_tokens' | 'max_completion_tokens'
  /** true → 流式请求需带 stream_options:{include_usage:true} 才有 usage 尾帧 */
  streamUsage: boolean
  pricing: { inPerMTok: number; outPerMTok: number; sourceUrl: string; asOf: string }
}

export const DEEPSEEK_V4_PRO: ModelCapability = {
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  proxyPrefix: '/api/deepseek',
  chatPath: '/chat/completions',
  structured: 'json_object',
  thinking: { kind: 'toggle', defaultOn: false },
  sampling: 'tunable',
  maxOutputParam: 'max_tokens',
  streamUsage: true,
  pricing: {
    inPerMTok: 0.435,
    outPerMTok: 0.87,
    sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/',
    asOf: '2026-08-12',
  },
}

export const KIMI_K3: ModelCapability = {
  provider: 'kimi',
  model: 'kimi-k3',
  proxyPrefix: '/api/moonshot',
  chatPath: '/v1/chat/completions',
  structured: 'json_schema_strict',
  thinking: { kind: 'always', efforts: ['low', 'high', 'max'] },
  sampling: 'fixed',
  maxOutputParam: 'max_completion_tokens',
  // Kimi 的流式 usage 随 finish_reason 帧携带（choices[0].usage），无需也不发 stream_options
  streamUsage: false,
  pricing: {
    inPerMTok: 3,
    outPerMTok: 15,
    sourceUrl: 'https://platform.kimi.ai/docs/pricing/chat-k3',
    asOf: '2026-08-12',
  },
}

export type PaperThinking = 'off' | 'on-high' | 'effort-low' | 'effort-high'

export interface PaperCallSpec {
  cap: ModelCapability
  thinking: PaperThinking
  responseFormat?: { type: 'json_object' } | { type: 'json_schema'; name: string; schema: object }
  maxOutputTokens: number // 1500 普通 / 6000 深度（推理+正文共享预算）/ brief 单配
  /** 仅 sampling=tunable 的模型会真正发送；fixed（Kimi）一律省略 */
  temperature?: number
}

/** 任务路由条目：CallSpec + 上下文输入预算（§5.4，contextBuilder 的裁剪阶梯据此工作） */
export interface PaperTaskSpec extends PaperCallSpec {
  inputBudgetTokens: number
}

/**
 * 任务 → CallSpec 路由表（§5.1 分工 + §5.4 预算）。
 * - chat：普通提问 / 选段解释 / 追问——DeepSeek thinking off，12K 输入 / 1.5K 输出。
 * - deep：公式推导 / 跨章节综合 / 批判性审阅——DeepSeek thinking on + effort high，24K / 3K。
 * - briefDigest / briefSynthesis：论文地图分单元摘要与综合（json_object + 本地校验，brief 单配）。
 */
export const PAPER_TASKS = {
  chat: { cap: DEEPSEEK_V4_PRO, thinking: 'off', maxOutputTokens: 1500, temperature: 0.5, inputBudgetTokens: 12_000 },
  deep: {
    cap: DEEPSEEK_V4_PRO,
    thinking: 'on-high',
    // DeepSeek thinking 模式下 max_tokens 是推理+正文的共享预算：3000 时硬题（跨章节综合/算法拆解）
    // 推理可独占全额导致正文空流（评测实测 vllm-m5 6/6、attn-c-cross 5/6 失败，asOf 2026-08-13）。
    // 6000 最坏成本 24K in + 6K out ≈ $0.0157，仍低于 $0.02 确认阈值（§5.4）。
    maxOutputTokens: 6000,
    temperature: 0.4,
    inputBudgetTokens: 24_000,
  },
  briefDigest: {
    cap: DEEPSEEK_V4_PRO,
    thinking: 'off',
    responseFormat: { type: 'json_object' },
    maxOutputTokens: 900,
    temperature: 0.2,
    inputBudgetTokens: 24_000,
  },
  briefSynthesis: {
    cap: DEEPSEEK_V4_PRO,
    thinking: 'off',
    responseFormat: { type: 'json_object' },
    maxOutputTokens: 2000,
    temperature: 0.2,
    inputBudgetTokens: 32_000,
  },
  /**
   * 显式深度升级（§5.1）：用户点「换一种深度解释」时才走的 kimi-k3 effort high 独立回答。
   * 永远不自动触发——需 Moonshot 独立授权 + 成本二次确认（Kimi 阈值）。
   * sampling fixed → 不带 temperature（providerAdapters 会一并省略采样参数）。
   */
  deepAlt: {
    cap: KIMI_K3,
    thinking: 'effort-high',
    maxOutputTokens: 3000,
    inputBudgetTokens: 24_000,
  },
} as const satisfies Record<string, PaperTaskSpec>

export type PaperTaskId = keyof typeof PAPER_TASKS

/**
 * Kimi 兜底 spec（§5.5 结构化失败且已授权 Moonshot 时使用）：
 * strict JSON Schema、effort low、省略全部采样参数。
 */
export function buildKimiStructuredSpec(name: string, schema: object, maxOutputTokens: number): PaperCallSpec {
  return {
    cap: KIMI_K3,
    thinking: 'effort-low',
    responseFormat: { type: 'json_schema', name, schema },
    maxOutputTokens,
  }
}

/**
 * 成本确认阈值（§5.4，美元）：单轮预计超过即弹二次确认；论文地图按整个管线累计预估。
 */
export const COST_CONFIRM_THRESHOLDS: Record<'turn' | 'brief', Record<PaperProviderId, number>> = {
  turn: { deepseek: 0.02, kimi: 0.15 },
  brief: { deepseek: 0.1, kimi: 0.75 },
}

/** provider 展示名（授权/成本确认对话框用） */
export const PAPER_PROVIDER_LABELS: Record<PaperProviderId, string> = {
  deepseek: 'DeepSeek',
  kimi: 'Kimi (Moonshot)',
}

/**
 * feature 开关（默认关闭的可选链路）。
 * - profileConsolidation：§6.2 L3 定期画像巩固调用（每 10 轮/会话结束 1 次 JSON 调用）。
 *   Phase 4 只留开关不实弹：L1/L2 已足够驱动层级选择，跳过 L3 不影响任何行为。
 */
export const PAPER_FEATURES = {
  profileConsolidation: false,
  /** L3 触发间隔（轮），开关打开后生效 */
  profileConsolidationEveryTurns: 10,
} as const

/** 检索条数（§8.1）：常规 6，深度任务 / evidence 扩检索 12 */
export const RETRIEVE_TOP_K = { normal: 6, deep: 12 } as const

/** 客户端令牌桶参数（§5.5：与生产 nginx 同参——6 次/分钟、burst 3，对话与 brief 共享） */
export const PAPER_RATE_LIMIT = { capacity: 3, refillMs: 10_000 } as const

/** 熔断参数（§5.5：同一 provider 连续 3 次技术失败后本地熔断 5 分钟） */
export const PAPER_CIRCUIT = { failures: 3, cooldownMs: 5 * 60_000 } as const

export type { ChatMessage }
