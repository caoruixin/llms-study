import type { MechanismId } from '../../data/architectureTypes'
import { dot, matVec, normalize, outer, scaleColumns, stepGated, stepKda, subMat, type Mat } from '../kdaEngine'

// Deterministic miniature operators, NOT weights or benchmark outputs of a released LLM.
export const TOKENS = ['我', '想', '理解', '不同', 'Attention', '的', 'Cache', '机制'] as const
export const PROMPT_TOKENS = 5
export const HEADS = 4
export const DIM = 4
export const LAYERS = 4
export const WINDOW = 3
export const INPUTS: number[][] = [
  [1, 0, .5, 0], [0, 1, 0, .5], [.5, .5, 1, 0], [1, .5, 0, 1],
  [.5, 1, .5, 0], [1, 0, .5, 1], [0, .5, 1, .5], [.5, 1, 1, .5],
]
export const STAGES = ['Project', 'Select', 'Score', 'Aggregate', 'Cache'] as const
export const RECURRENT_STAGES = ['Project', 'Decay', 'Predict', 'Write', 'Read'] as const
export interface MemoryPart { id: string; label: string; elements: number; bytes: number; note: string }
export interface MemoryLedger { parts: MemoryPart[]; elements: number; bytes: number; assumptions: string }
export interface AttentionEntry {
  id: string
  label: string
  tokens: number[]
  key: number[]
  value: number[]
  latent?: number[]
  indexScore?: number
  selected: boolean
  score: number | null
  weight: number
  kind: 'token' | 'summary' | 'window'
}
export interface RecurrentTrace {
  before: Mat; decayed: Mat; prediction: number[]; residual: number[]; write: Mat; after: Mat; alpha: number[]; beta: number
}
export interface HeadTrace {
  head: number; kvHead: number; q: number[]; k: number[]; v: number[]
  entries: AttentionEntry[]; output: number[]; tokenWeights: number[]
  recurrent?: RecurrentTrace
}
export interface AttentionStep {
  t: number
  token: string
  input: number[]
  heads: HeadTrace[]
  storedTokens: number[]
  evictedTokens: number[]
  indexCandidates: number
  mainEntriesRead: number
  memory: MemoryLedger
  layerModes: ('Full' | 'Reindex' | 'Reuse')[]
}
export interface AttentionTrace {
  mechanism: MechanismId
  steps: AttentionStep[]
  fidelity: 'numeric' | 'teaching'
  simplification: string
}
export const isRecurrent = (id: MechanismId) => id === 'gdn' || id === 'kda'
export const isLatent = (id: MechanismId) => ['mla', 'dsa', 'csa2'].includes(id)
export const kvHeadCount = (id: MechanismId) => id === 'mha' ? 4 : id === 'mqa' || isLatent(id) ? 1 : 2
export const headToKV = (head: number, kvHeads: number) => Math.floor(head * kvHeads / HEADS)

export function softmax(scores: readonly number[]): number[] {
  if (!scores.length) return []
  const max = Math.max(...scores)
  const e = scores.map(s => Math.exp(s - max))
  const sum = e.reduce((a, b) => a + b, 0)
  return e.map(v => v / sum)
}
export function attend(q: readonly number[], keys: readonly number[][], values: readonly number[][]) {
  if (!keys.length || keys.length !== values.length || keys.some(k => k.length !== q.length) || values.some(v => v.length !== values[0].length)) throw new Error('Attention dimensions do not match')
  const scores = keys.map(k => dot(q, k) / Math.sqrt(q.length))
  const weights = softmax(scores)
  return { scores, weights, output: values[0].map((_, d) => values.reduce((s, v, i) => s + v[d] * weights[i], 0)) }
}
export function topK(scores: number[], k: number): number[] {
  return scores.map((score, i) => ({ score, i })).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, k).map(x => x.i)
}
function rotate(x: readonly number[], h: number): number[] { return x.map((_, i) => x[(i + h) % x.length]) }
function query(t: number, h: number) { return normalize(rotate(INPUTS[t], h)) as number[] }
function key(t: number, h: number) { return normalize(rotate(INPUTS[t], h)) as number[] }
function value(t: number, h: number) { return rotate(INPUTS[t], h).map((v, i) => v * (i % 2 ? .5 : 1)) }
const range = (n: number, start = 0) => Array.from({ length: Math.max(0, n) }, (_, i) => i + start)
const zeros = (): Mat => Array.from({ length: DIM }, () => Array<number>(DIM).fill(0))
const mean = (xs: number[][]): number[] => xs[0].map((_, d) => xs.reduce((sum, x) => sum + x[d], 0) / xs.length)
export const latentOf = (t: number): number[] => [(INPUTS[t][0] + INPUTS[t][2]) / 2, (INPUTS[t][1] + INPUTS[t][3]) / 2]
export const ropeKey = (t: number): number[] => [Math.cos(t / 2), Math.sin(t / 2)]
export const upMatrix = (h: number): number[][] => rotate([1, .5, -.5, 1], h).map((v, i) => i % 2 ? [0, v] : [v, 0])
export function absorbedScore(q: number[], latent: number[], up: number[][], qRope: number[], kRope: number[]): number {
  const absorbed = [0, 1].map(d => q.reduce((sum, x, i) => sum + x * up[i][d], 0))
  return (dot(absorbed, latent) + dot(qRope, kRope)) / Math.sqrt(q.length + qRope.length)
}
function entryFor(t: number, h: number, id: MechanismId): AttentionEntry {
  const kvHead = headToKV(h, kvHeadCount(id))
  const latent = isLatent(id) ? latentOf(t) : undefined
  return {
    id: `token-${t}`, label: TOKENS[t], tokens: [t], kind: 'token',
    key: latent ? [...matVec(upMatrix(h), latent), ...ropeKey(t)] : key(t, kvHead),
    value: latent ? matVec(upMatrix((h + 1) % HEADS), latent) as number[] : value(t, kvHead),
    latent, selected: true, score: null, weight: 0,
  }
}
// Fixed-size *toy* index projections. The official learned indexer is not reproduced.
function indexScore(q: number[], entries: AttentionEntry[]): number {
  const k = mean(entries.map(e => e.key.slice(0, 2)))
  return Math.max(0, q[0] * k[0] + q[1] * k[1])
}
function selectedEntries(t: number, h: number, id: MechanismId, q: number[]) {
  let entries = range(t + 1).map(i => entryFor(i, h, id))
  let indexCandidates = 0
  if (id === 'swa') entries = entries.slice(-WINDOW).map(e => ({ ...e, kind: 'window' as const }))
  if (id === 'csa' || id === 'hca') {
    const block = id === 'csa' ? 2 : 4
    const oldEnd = Math.max(0, t + 1 - WINDOW)
    const complete = Math.floor(oldEnd / block)
    const compressed: AttentionEntry[] = range(complete).map(i => {
      const group = entries.slice(i * block, (i + 1) * block)
      return { id: `summary-${i}`, label: `C${i + 1}`, tokens: group.flatMap(e => e.tokens), key: mean(group.map(e => e.key)), value: mean(group.map(e => e.value)), selected: true, score: null, weight: 0, kind: 'summary' }
    })
    if (id === 'csa') {
      const scores = compressed.map(e => indexScore(q, [e])); indexCandidates = compressed.length
      const selected = topK(scores, 1)
      compressed.forEach((e, i) => { e.indexScore = scores[i]; e.selected = selected.includes(i) })
    }
    entries = [...compressed, ...entries.slice(complete * block).map(e => ({ ...e, kind: 'window' as const }))]
  }
  if (id === 'dsa' || id === 'csa2') {
    const scores = entries.map(e => indexScore(q, [e])); indexCandidates = scores.length
    const selected = topK(scores, 2)
    entries = entries.map((e, i) => ({ ...e, indexScore: scores[i], selected: selected.includes(i) }))
  }
  if (id === 'qsa' || id === 'msa') {
    const block = id === 'qsa' ? 4 : 2
    const complete = Math.floor(entries.length / block)
    const scores = range(complete).map(i => indexScore(q, entries.slice(i * block, (i + 1) * block)))
    indexCandidates = complete
    const selected = topK(scores, 1)
    entries = entries.map((e, i) => ({ ...e, indexScore: scores[Math.floor(i / block)], selected: i >= complete * block || selected.includes(Math.floor(i / block)) }))
  }
  return { entries, indexCandidates }
}
export function memoryLedger(id: MechanismId, length: number, batch = 1, layers = LAYERS): MemoryLedger {
  if (!Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(batch) || batch < 1 || !Number.isSafeInteger(layers) || layers < 1) throw new Error('Memory dimensions must be positive integers')
  const parts: MemoryPart[] = []
  const part = (id: string, label: string, elements: number, bytesPerElement: number, note: string) => parts.push({ id, label, elements: elements * batch, bytes: elements * bytesPerElement * batch, note })
  if (isRecurrent(id)) {
    part('state', 'Recurrent State', HEADS * DIM * DIM * layers, 4, `${layers} layers × ${HEADS} heads × ${DIM}×${DIM}；FP32，每请求一份`)
  } else if (id === 'csa2') {
    part('kv', 'Shared Global KV', length * 4, 2, 'latent 2 + RoPE 2；跨层只存一份，教学 FP16')
    part('index', 'Shared Indexer K', length * 2, 2, '共享索引 key；不随 layers 重复')
    part('topk', 'Top-K IDs', Math.min(length, 2) * Math.min(layers, 2), 4, 'Full / Reindex 各生成一份；Reuse 引用同一份')
    part('window', 'SWA Working State', Math.min(length, WINDOW) * 2 * DIM * layers, 2, '各层当前窗口工作状态；不等同于持久化 prefix KV')
  } else if (isLatent(id)) {
    part('kv', 'Latent KV + RoPE', length * 4 * layers, 2, '每 token 每层 latent 2 + RoPE 2；不再乘两份 K/V')
    if (id === 'dsa') part('index', 'Indexer K', length * 2 * layers, 2, '稀疏主读取仍需保留历史 latent 与 index keys')
  } else if (id === 'csa' || id === 'hca') {
    const block = id === 'csa' ? 2 : 4
    const old = Math.max(0, length - WINDOW); const compressed = Math.floor(old / block)
    part('kv', 'Compressed KV', compressed * 2 * kvHeadCount(id) * DIM * layers, 2, `教学压缩率 ${block}:1；完成的历史块`)
    part('window', 'SWA + Incomplete Tail', (Math.min(length, WINDOW) + old % block) * 2 * kvHeadCount(id) * DIM * layers, 2, '保留窗口与尚未完成压缩的 tail，避免丢 token')
    if (id === 'csa') part('index', 'Summary Indexer', compressed * 2 * layers, 2, '每个已完成摘要保留一个 2D index key')
  } else {
    part(id === 'swa' ? 'window' : 'kv', id === 'swa' ? 'Window KV' : 'Token KV', (id === 'swa' ? Math.min(length, WINDOW) : length) * 2 * kvHeadCount(id) * DIM * layers, 2, `${layers} layers × ${kvHeadCount(id)} KV heads × ${DIM} dim × K/V；FP16`)
    if (id === 'qsa' || id === 'msa') {
      const block = id === 'qsa' ? 4 : 2
      part('index', 'Block Indexer + Tail', (Math.floor(length / block) + length % block) * 2 * layers, 2, `完成块的 index key + 未完成 tail；教学 block=${block}`)
    }
  }
  return { parts, elements: parts.reduce((s, p) => s + p.elements, 0), bytes: parts.reduce((s, p) => s + p.bytes, 0), assumptions: `Teaching configuration · ${layers} layers · ${HEADS} Q heads · d=4 · KV FP16 / State FP32；不含模型权重、卷积状态、临时激活、分配器或运行时开销。` }
}
export function buildAttentionTrace(id: MechanismId): AttentionTrace {
  let states = range(HEADS).map(() => zeros())
  const steps = TOKENS.map((token, t): AttentionStep => {
    let indexCandidates = 0
    const heads = range(HEADS).map((h): HeadTrace => {
      const q0 = query(t, h), k = key(t, h), v = value(t, h)
      if (isRecurrent(id)) {
        const alpha = id === 'gdn' ? [.8, .8, .8, .8] : [1, .6, .9, .4]
        const before = states[h], decayed = scaleColumns(before, alpha)
        const prediction = matVec(decayed, k) as number[]
        const residual = v.map((x, d) => x - prediction[d]); const beta = .7
        const after = id === 'gdn' ? stepGated(before, k, v, beta, alpha[0]) : stepKda(before, k, v, beta, alpha)
        states = states.map((s, i) => i === h ? after : s)
        return { head: h, kvHead: h, q: q0, k, v, output: matVec(after, q0) as number[], entries: [], tokenWeights: [], recurrent: { before, decayed, prediction, residual, write: outer(residual.map(x => x * beta), k), after, alpha, beta } }
      }
      const q = isLatent(id) ? [...q0, ...ropeKey(t)] : q0
      const selection = selectedEntries(t, h, id, q)
      if (h === 0) indexCandidates = selection.indexCandidates
      const selected = selection.entries.filter(e => e.selected)
      const result = attend(q, selected.map(e => e.key), selected.map(e => e.value))
      let i = 0
      selection.entries.forEach(e => { if (e.selected) { e.score = result.scores[i]; e.weight = result.weights[i++] } })
      const tokenWeights = Array<number>(TOKENS.length).fill(0)
      // Summary contributions are distributed for display only, NOT token-level attention weights.
      selection.entries.forEach(e => e.tokens.forEach(ti => { tokenWeights[ti] += e.weight / e.tokens.length }))
      return { head: h, kvHead: headToKV(h, kvHeadCount(id)), q, k: entryFor(t, h, id).key, v: entryFor(t, h, id).value, entries: selection.entries, output: result.output, tokenWeights }
    })
    const storedTokens = isRecurrent(id) ? [] : id === 'swa' ? range(Math.min(t + 1, WINDOW), Math.max(0, t + 1 - WINDOW)) : range(t + 1)
    return { t, token, input: INPUTS[t], heads, storedTokens, evictedTokens: id === 'swa' ? range(Math.max(0, t + 1 - WINDOW)) : [], indexCandidates, mainEntriesRead: heads[0].entries.filter(e => e.selected).length, memory: memoryLedger(id, t + 1), layerModes: id === 'csa2' ? ['Full', 'Reindex', 'Reuse', 'Reuse'] : [] }
  })
  const teaching = ['dsa', 'qsa', 'msa', 'csa', 'hca', 'csa2'].includes(id)
  return { mechanism: id, steps, fidelity: teaching ? 'teaching' : 'numeric', simplification: teaching
    ? 'Teaching implementation：固定 2D index projection、简化 Top-K / 块均值；保留机制的选择与缓存语义，不复现官方 learned indexer、压缩器或 kernel。CSA2 的层模式只展示共享关系，不模拟完整 CED 网络。'
    : isRecurrent(id) ? '可复算的 4×4 delta-rule 核心；归一化 k，本教学 q=k，固定教学 α / β。省略 learned gates、卷积和 Output Norm。' : isLatent(id) ? '可复算的低秩 Attention；latent=2、RoPE=2，展示投影吸收与显式重建等价。并非真实模型维度。' : '可复算的 scaled dot-product Attention；固定教学 Embedding / Projection，展示 causal mask 与 KV head mapping，不是模型真实权重。' }
}
export function recurrenceIdentityError(r: RecurrentTrace): number {
  return Math.max(...subMat(r.after, r.decayed.map((row, i) => row.map((x, j) => x + r.write[i][j]))).flat().map(Math.abs))
}
