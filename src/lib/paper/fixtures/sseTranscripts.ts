/**
 * 录制形 SSE 转录 fixtures（§11.1：门禁内零真实 API 调用）。
 * 帧结构按 2026-08 官方流式响应形状手工录制/整理：
 * - DeepSeek：role-only 首帧、reasoning_content 帧、content 帧、空 choices + usage 尾帧（需 stream_options）、[DONE]；
 * - Kimi：content 帧、finish_reason 帧内嵌 usage、[DONE]。
 */

const F = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

export const dsRole = F({ id: 'ds-1', choices: [{ index: 0, delta: { role: 'assistant' } }] })
/** 2026-08-12 实弹冒烟录得的真实 DS 尾帧形：finish 帧 choices 非空 + 顶层 usage（非 OpenAI 空 choices 形） */
export const dsFinishWithTopUsage = (prompt: number, completion: number): string =>
  F({
    id: 'ds-1',
    choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  })
export const dsReasoning = (text: string): string =>
  F({ id: 'ds-1', choices: [{ index: 0, delta: { reasoning_content: text } }] })
export const dsContent = (text: string): string => F({ id: 'ds-1', choices: [{ index: 0, delta: { content: text } }] })
export const dsUsageTail = (prompt: number, completion: number): string =>
  F({
    id: 'ds-1',
    choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  })
export const DONE = 'data: [DONE]\n\n'

export const kimiContent = (text: string): string =>
  F({ id: 'kimi-1', choices: [{ index: 0, delta: { content: text } }] })
export const kimiFinishWithUsage = (prompt: number, completion: number): string =>
  F({
    id: 'kimi-1',
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop',
        usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
      },
    ],
  })

export const errorFrame = (message: string): string => F({ error: { message, type: 'server_error' } })

/** DeepSeek 完整成功转录：role → reasoning×2 → content×3 → usage 尾帧 → [DONE] */
export const dsHappyTranscript: string[] = [
  dsRole,
  dsReasoning('分析问题'),
  dsReasoning('组织结构'),
  dsContent('这段在讲'),
  dsContent(' KV cache'),
  dsContent(' 的显存占用 [[cite:c1]]。'),
  dsUsageTail(1200, 45),
  DONE,
]

/** Kimi 完整成功转录：content×2 → finish 帧（内嵌 usage）→ [DONE] */
export const kimiHappyTranscript: string[] = [kimiContent('结论：'), kimiContent('线性增长。'), kimiFinishWithUsage(800, 30), DONE]

/** 整包 JSON（厂商忽略 stream）响应体 */
export const wholeJsonResponse = {
  id: 'ds-2',
  choices: [{ index: 0, message: { role: 'assistant', content: '整包回答' } }],
  usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 },
}

/** 结构化任务：合法 / 坏 JSON 响应体（completePaperJson 修复阶梯用） */
export const jsonGood = {
  choices: [{ message: { content: '{"summary":"本节讲了注意力机制","keyPoints":["Q/K/V 三矩阵"]}' } }],
  usage: { prompt_tokens: 500, completion_tokens: 60, total_tokens: 560 },
}
export const jsonBroken = {
  choices: [{ message: { content: '好的，以下是摘要：{"summary":' } }],
  usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 },
}
