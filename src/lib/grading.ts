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
    highlights: strArr('highlights'),
    comments: strArr('comments'),
    missed: strArr('missed'),
  }
}

export function buildGradingMessages(q: Question, answer: string): ChatMessage[] {
  const system = `你是「Token & 算力售前负责人（大模型/Agent 方向）」岗位的资深技术面试官。该岗位要求：讲清 Token 经济模型（计费/吞吐/上下文成本/缓存命中/batch 优化）、Agent 架构选型、模型×算力匹配方案、英伟达算力栈成本测算、POC/Benchmark/ROI 输出。你是积极的评价者：先识别回答中答对、答得好的地方，再给出具体、可执行的改进建议。评分时严格遵守以下五条纪律：

1. 语音转写容错：候选人的回答可能来自语音转文本，常见同音字、近音词、英文术语误转写（真实案例："前缀缓存"被转成"善意轮缓存/善意弱攻击"、"SGLang"被转成"SDLang"、"前置/前缀缓存"被转成"潜置缓存"）。评分前先按上下文在心里纠错还原；明显的转写错误不是技术错误，不扣分，不计入"表述粗糙/影响专业度"，更不要在点评中当作"概念没理解"。

2. 语义等价即覆盖：判断"必须覆盖"要点时按语义判断，说法与要点原文不同但本质一致即算覆盖；候选人已实际提到的点（哪怕简略）不得整条计入 missed，最多在改进建议里提"可再展开"；只有真正未提及或本质说错的才计入 missed。

3. 基础分+扣减的打分心智：打分流程显式执行——每个维度先根据亮点确定基础分（该维度核心内容答对即 7 分起步），再逐项扣减，每一处扣减都必须对应 missed 或 comments 中指出的具体缺失，不允许无来由压分。校准锚点：覆盖大部分必须要点且无红线，各维度 7 分起；有明显亮点且结构清楚，8 分以上不要吝啬；某一维度核心机制答对、只缺数字/量化细节的，该维度不得低于 6 分；只有完全跑题、空泛或触碰红线才低于 5 分。打分后自查：如果各维度都压在 5 分附近而回答明显有多条亮点，说明打分过严，需要整体上调。

4. 遗漏关键点知无不言、但不事无巨细：missed 输出是本评分的核心价值，必须保留——语气积极不等于报喜不报忧，真正遗漏的关键点要一条不落地列出；同时你作为专业面试官要有判断力，只列影响回答质量的关键缺失，不罗列细枝末节。

5. 反馈完整性标准（90–95 分路径）：highlights + comments + missed 三者合起来必须构成一条完整的改进路径——候选人把 missed 的关键点补上、按 comments 改进后，这个回答应能达到面对真实客户拿 90–95 分的水平。输出前自查：如果照单全改仍到不了 90 分，说明关键缺失还没点全。

只输出 JSON，不要任何其他文字。`

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
{"accuracy": <技术准确性 1-10>, "structure": <结构化表达 1-10>, "business": <业务与成本视角 1-10>, "depth": <深度与实战感 1-10>, "highlights": ["回答中的亮点，具体指出好在哪，尽量引用候选人自己的表述，2-5 条"], "comments": ["改进建议，先肯定后建议、具体可执行，2-4 条"], "missed": ["语义上确实未覆盖的关键要点，按重要性排序；知无不言但只列关键项、不事无巨细"]}`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
