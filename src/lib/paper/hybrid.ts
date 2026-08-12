/**
 * 混合召回合并（§4.4）：BM25 与（未来的）向量召回做确定性融合，
 * 再把 Jina rerank 作为**可插拔的二阶段增强**。
 *
 * Phase 2 只落地纯函数与注入点：`rerankFn` 默认不存在、`gate.enabled` 默认 false，
 * 真实的 Jina 调用要等 §11.3 的 20 条检索集评测达标（Recall@6 提升 ≥5pt）才会打开。
 * 任何一步失败都无感降级回本地 BM25——检索不可用绝不能阻断阅读与全文搜索。
 */

export interface ScoredId {
  id: string
  score: number
}

export interface MergeOptions {
  bm25Weight?: number
  vectorWeight?: number
  /** RRF 常数：越大越弱化头部名次差异，60 是文献常规取值 */
  rrfK?: number
  topK?: number
}

/**
 * Reciprocal Rank Fusion：只吃名次不吃分数，天然规避「BM25 分数与余弦相似度不同量纲」的问题。
 * 同分时依次按「两路中的最好名次」「id 字典序」打破平局——保证任何环境下输出完全一致。
 */
export function mergeRecall(
  bm25: readonly ScoredId[],
  vector: readonly ScoredId[] | undefined,
  opts: MergeOptions = {},
): ScoredId[] {
  const k = opts.rrfK ?? 60
  const wB = opts.bm25Weight ?? 1
  const wV = opts.vectorWeight ?? 1

  const acc = new Map<string, { score: number; bestRank: number }>()
  const add = (list: readonly ScoredId[] | undefined, weight: number) => {
    if (!list) return
    list.forEach((item, rank) => {
      const prev = acc.get(item.id)
      const gain = weight / (k + rank + 1)
      if (prev) {
        prev.score += gain
        prev.bestRank = Math.min(prev.bestRank, rank)
      } else {
        acc.set(item.id, { score: gain, bestRank: rank })
      }
    })
  }
  add(bm25, wB)
  add(vector, wV)

  const merged = [...acc.entries()].map(([id, v]) => ({ id, score: v.score, bestRank: v.bestRank }))
  merged.sort((a, b) => b.score - a.score || a.bestRank - b.bestRank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const topK = opts.topK ?? merged.length
  return merged.slice(0, Math.max(0, topK)).map(({ id, score }) => ({ id, score }))
}

export interface RerankDoc {
  id: string
  text: string
}

/**
 * 二阶段重排注入点。实现方（Phase 3 的 Jina 适配器）只拿到 query 与待排 chunk 文本，
 * **不得**接收文件名、本地路径、用户标识或学习画像（§4.4 隐私边界）。
 */
export type RerankFn = (input: {
  query: string
  docs: RerankDoc[]
  topN: number
  signal?: AbortSignal
}) => Promise<ScoredId[]>

export interface RerankGate {
  /** 功能开关：Phase 2 恒为 false（真实调用未接入） */
  enabled?: boolean
  /** provider 独立授权（§8）：未授权时一个 chunk 都不外发 */
  consent?: { provider: string; granted: boolean } | null
  /** 敏感/未公开论文：只允许本地 BM25 */
  sensitive?: boolean
}

export type RerankSkipReason =
  | 'disabled'
  | 'no-consent'
  | 'sensitive'
  | 'no-rerank-fn'
  | 'no-candidates'
  | 'rerank-failed'

export interface HybridResult {
  results: ScoredId[]
  usedRerank: boolean
  /** 未重排时的原因；'rerank-failed' 表示调用过但失败并已降级 */
  skipped?: RerankSkipReason
}

export interface HybridOptions {
  gate?: RerankGate
  rerankFn?: RerankFn
  /** 重排后保留条数（§8.1：常规 6，深度任务 12） */
  topN?: number
  merge?: MergeOptions
  signal?: AbortSignal
}

/** 授权检查桩：三道闸门任一不过就只走本地路径 */
export function canRerank(gate: RerankGate | undefined, hasRerankFn: boolean): { ok: true } | { ok: false; reason: RerankSkipReason } {
  if (!gate?.enabled) return { ok: false, reason: 'disabled' }
  if (gate.sensitive) return { ok: false, reason: 'sensitive' }
  if (!gate.consent?.granted) return { ok: false, reason: 'no-consent' }
  if (!hasRerankFn) return { ok: false, reason: 'no-rerank-fn' }
  return { ok: true }
}

/**
 * 合并召回 → （可选）重排。重排结果里没出现的候选按合并序补在后面：
 * 即使远端只返回了部分文档，结果集也不会凭空变短。
 */
export async function hybridRetrieve(
  input: { query: string; bm25: readonly ScoredId[]; vector?: readonly ScoredId[]; docs: readonly RerankDoc[] },
  opts: HybridOptions = {},
): Promise<HybridResult> {
  const topN = opts.topN ?? 6
  const merged = mergeRecall(input.bm25, input.vector, { topK: 20, ...opts.merge })
  const localResult = (skipped: RerankSkipReason): HybridResult => ({
    results: merged.slice(0, topN),
    usedRerank: false,
    skipped,
  })

  if (!merged.length) return localResult('no-candidates')

  const gateCheck = canRerank(opts.gate, typeof opts.rerankFn === 'function')
  if (!gateCheck.ok) return localResult(gateCheck.reason)

  const textById = new Map(input.docs.map((d) => [d.id, d.text]))
  const docs = merged.map((m) => ({ id: m.id, text: textById.get(m.id) ?? '' })).filter((d) => d.text)
  if (!docs.length) return localResult('no-candidates')

  let ranked: ScoredId[]
  try {
    ranked = await opts.rerankFn!({ query: input.query, docs, topN, signal: opts.signal })
  } catch {
    // 无感降级：远端重排失败不影响本地召回结果
    return localResult('rerank-failed')
  }

  const order = new Map(merged.map((m, i) => [m.id, i]))
  const kept = ranked
    .filter((r) => order.has(r.id) && typeof r.score === 'number' && Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  const seen = new Set(kept.map((r) => r.id))
  const rest = merged.filter((m) => !seen.has(m.id))
  return { results: [...kept, ...rest].slice(0, topN), usedRerank: true }
}
