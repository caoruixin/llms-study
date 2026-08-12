import type { ChatMessage } from '../llmClient'
import type { PaperCallSpec } from '../../data/paperPolicy'

/**
 * provider 参数适配（§5.2）：DeepSeek 与 Kimi 的请求体差异全部集中在这里，
 * 纯函数、契约测试重点。任何新参数差异先改这里再改测试，禁止在调用方散落 if。
 *
 * DeepSeek（deepseek-v4-pro）：
 * - 普通问答显式 `thinking: { type: 'disabled' }`；深度任务 `thinking: { type: 'enabled' }` + `reasoning_effort: 'high'`。
 * - 流式且 cap.streamUsage 时带 `stream_options: { include_usage: true }`（否则 usage 尾帧不发）。
 * - 输出上限用 `max_tokens`；sampling tunable，spec 带 temperature 才发送。
 * - 结构任务 `response_format: { type: 'json_object' }`（官方要求 prompt 中同时明确 JSON）。
 *
 * Kimi（kimi-k3）：
 * - 思考不可关：只发 `reasoning_effort`（low/high），不发 thinking 字段。
 * - sampling fixed：temperature/top_p/presence_penalty/frequency_penalty 一律省略（发了会 400）。
 * - 输出上限用 `max_completion_tokens`；不发 stream_options（usage 随 finish 帧自带）。
 * - 结构任务 `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`。
 */
export function buildChatBody(
  spec: PaperCallSpec,
  messages: readonly ChatMessage[],
  stream: boolean,
): Record<string, unknown> {
  const { cap } = spec
  const body: Record<string, unknown> = {
    model: cap.model,
    messages: messages.map(({ role, content }) => ({ role, content })),
    stream,
  }

  // 输出上限：参数名按能力矩阵
  body[cap.maxOutputParam] = spec.maxOutputTokens

  // thinking / reasoning_effort
  if (cap.thinking.kind === 'toggle') {
    if (spec.thinking === 'on-high') {
      body.thinking = { type: 'enabled' }
      body.reasoning_effort = 'high'
    } else {
      // 普通任务显式 disabled（不依赖上游默认值）
      body.thinking = { type: 'disabled' }
    }
  } else {
    // always-thinking（Kimi）：off/effort-low → low，on-high/effort-high → high
    body.reasoning_effort = spec.thinking === 'on-high' || spec.thinking === 'effort-high' ? 'high' : 'low'
  }

  // 采样参数：fixed 模型一个都不发
  if (cap.sampling === 'tunable' && spec.temperature !== undefined) {
    body.temperature = spec.temperature
  }

  // 结构化输出
  if (spec.responseFormat) {
    if (spec.responseFormat.type === 'json_schema' && cap.structured === 'json_schema_strict') {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: spec.responseFormat.name, schema: spec.responseFormat.schema, strict: true },
      }
    } else {
      // json_object 请求，或能力只有 json_object 时把 schema 请求降级为 json_object
      body.response_format = { type: 'json_object' }
    }
  }

  // 流式 usage 尾帧（DeepSeek 需要显式开启）
  if (stream && cap.streamUsage) {
    body.stream_options = { include_usage: true }
  }

  return body
}
