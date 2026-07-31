import type { Grade, Question, ScoreResult } from '../data/types'
import type { ChatMessage } from './llmClient'

// 固定权重：A-D 等级由客户端确定性映射，不让模型直接给等级
export const WEIGHTS = { accuracy: 0.35, depth: 0.25, business: 0.2, structure: 0.2 } as const

export function weightedScore(s: ScoreResult): number {
  return (
    s.accuracy * WEIGHTS.accuracy +
    s.depth * WEIGHTS.depth +
    s.business * WEIGHTS.business +
    s.structure * WEIGHTS.structure
  )
}

export function toGrade(total: number): Grade {
  if (total >= 8) return 'A'
  if (total >= 6.5) return 'B'
  if (total >= 5) return 'C'
  return 'D'
}

const clamp = (n: number) => Math.min(10, Math.max(1, n))

// 容错解析：剥离 markdown 代码栅栏、截取首个 { 到末个 }，字段缺失/越界时抛错或钳位
export function parseScoreJson(raw: string): ScoreResult {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('评分返回不含 JSON 对象')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    throw new Error('评分返回 JSON 解析失败')
  }
  const obj = parsed as Record<string, unknown>
  const num = (key: string): number => {
    const v = obj[key]
    if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`评分缺少数值字段 ${key}`)
    return clamp(v)
  }
  const strArr = (key: string): string[] => {
    const v = obj[key]
    if (!Array.isArray(v)) return []
    return v.filter((x): x is string => typeof x === 'string')
  }
  return {
    accuracy: num('accuracy'),
    structure: num('structure'),
    business: num('business'),
    depth: num('depth'),
    comments: strArr('comments'),
    missed: strArr('missed'),
  }
}

export function buildGradingMessages(q: Question, answer: string): ChatMessage[] {
  const system = `你是「Token & 算力售前负责人（大模型/Agent 方向）」岗位的资深技术面试官。该岗位要求：讲清 Token 经济模型（计费/吞吐/上下文成本/缓存命中/batch 优化）、Agent 架构选型、模型×算力匹配方案、英伟达算力栈成本测算、POC/Benchmark/ROI 输出。你按评分要点严格评分，宁严勿松，但点评具体、可执行。只输出 JSON，不要任何其他文字。`

  const user = `## 面试题（${q.lang === 'en' ? '英文题，候选人可用中英文回答' : '中文题'}）
${q.prompt}
${q.followUp ? `\n追问：${q.followUp}` : ''}

## 评分要点
必须覆盖（缺一项明显扣分）：
${q.mustCover.map((s) => `- ${s}`).join('\n')}

加分项：
${q.niceToHave.map((s) => `- ${s}`).join('\n')}

红线（出现即重扣）：
${q.redFlags.map((s) => `- ${s}`).join('\n')}

参考要点：
${q.referenceNotes}

## 候选人回答
${answer}

## 输出格式
只输出一个 JSON 对象（不要 markdown 栅栏），字段：
{"accuracy": <技术准确性 1-10>, "structure": <结构化表达 1-10>, "business": <业务与成本视角 1-10>, "depth": <深度与实战感 1-10>, "comments": ["逐条中文点评，具体指出好在哪/差在哪，3-6 条"], "missed": ["候选人遗漏的必须覆盖要点，原文引用"]}`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
