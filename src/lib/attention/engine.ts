import type { MechanismId } from '../../data/architectureTypes'
import { dot, matVec, normalize, outer, scaleColumns, stepGated, stepKda, subMat, type Mat } from '../kdaEngine'

// Column-vector convention: a projection has shape [output dimension, input dimension].
// These fixed miniature weights are public teaching fixtures, never checkpoint weights.
export const TRACE_VERSION = '2'
export const TOKENS = ['我', '想', '理解', '不同', 'Attention', '的', 'Cache', '机制'] as const
export const PROMPT_TOKENS = 5
export const HEADS = 4
export const DIM = 4
export const LAYERS = 4
export const WINDOW = 3
export const STAGES = ['Project', 'Prepare Memory', 'Route', 'Score', 'Aggregate', 'Output'] as const
export const RECURRENT_STAGES = ['Project', 'Prepare State', 'Decay', 'Predict', 'Write', 'Read / Output'] as const
export const PHASES = STAGES.length
export const LAST_FRAME = TOKENS.length * PHASES - 1
export const INPUTS: number[][] = [[1, 0, .5, 0], [0, 1, 0, .5], [.5, .5, 1, 0], [1, .5, 0, 1], [.5, 1, .5, 0], [1, 0, .5, 1], [0, .5, 1, .5], [.5, 1, 1, .5]]
export const range = (n: number, start = 0) => Array.from({ length: Math.max(0, n) }, (_, i) => i + start)
const zeros = (): Mat => range(DIM).map(() => range(DIM).map(() => 0))
const mean = (xs: number[][]) => xs[0].map((_, d) => xs.reduce((s, x) => s + x[d], 0) / xs.length)
export const fixtureMatrix = (rows: number, cols: number, seed: number): number[][] => range(rows).map(r => range(cols).map(c => (((r + 1) * (c + 2) + seed * (r + 2) + c * seed) % 11 - 5) / 8 + (r === c ? .6 : 0)))
export const PROJECTIONS = range(HEADS).map(h => ({ q: fixtureMatrix(4, 4, h + 1), k: fixtureMatrix(4, 4, h + 7), v: fixtureMatrix(4, 4, h + 13) }))
export const OUTPUT_MATRIX = fixtureMatrix(4, 16, 21)
export const GROUP_MATRICES = [fixtureMatrix(2, 8, 23), fixtureMatrix(2, 8, 25)]
export const GROUP_OUTPUT_MATRIX = fixtureMatrix(4, 4, 27)
export const DOWN_MATRIX = [[.5, 0, .5, 0], [0, .5, 0, .5]]
export const isRecurrent = (id: MechanismId) => id === 'gdn' || id === 'kda'
export const isLatent = (id: MechanismId) => id === 'mla' || id === 'dsa'
export const isCompressed = (id: MechanismId) => id === 'csa' || id === 'hca'
export const kvHeadCount = (id: MechanismId) => id === 'mha' ? 4 : id === 'mqa' || isLatent(id) || isCompressed(id) || id === 'csa2' ? 1 : 2
export const headToKV = (head: number, kvHeads: number) => Math.floor(head * kvHeads / HEADS)
export const project = (x: number[], matrix: number[][]): number[] => matVec(matrix, x) as number[]
export const rmsNorm = (v: number[]) => { const r = Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length + 1e-6); return v.map(x => x / r) }
export function partialRoPE(v: number[], position: number): number[] {
  const a = position / 2, n = v.length, out = [...v]
  out[n - 2] = v[n - 2] * Math.cos(a) - v[n - 1] * Math.sin(a)
  out[n - 1] = v[n - 2] * Math.sin(a) + v[n - 1] * Math.cos(a)
  return out
}
export const latentOf = (t: number) => project(INPUTS[t], DOWN_MATRIX)
export const ropeKey = (t: number) => partialRoPE(project(INPUTS[t], fixtureMatrix(2, 4, 30)), t)
export const ropeQuery = (t: number, h: number) => partialRoPE(project(INPUTS[t], fixtureMatrix(2, 4, 31 + h)), t)
export const upMatrix = (h: number) => fixtureMatrix(4, 2, 35 + h)
export const valueUpMatrix = (h: number) => fixtureMatrix(4, 2, 41 + h)
export const absorbQuery = (q: number[], up: number[][]) => [0, 1].map(d => q.reduce((s, x, i) => s + x * up[i][d], 0))
export function absorbedScore(q: number[], latent: number[], up: number[][], qRope: number[], kRope: number[]): number {
  return (dot(absorbQuery(q, up), latent) + dot(qRope, kRope)) / Math.sqrt(q.length + qRope.length)
}
export function softmax(scores: readonly number[]): number[] {
  if (!scores.length) return []
  const max = Math.max(...scores), e = scores.map(s => Math.exp(s - max)), sum = e.reduce((a, b) => a + b, 0)
  return e.map(v => v / sum)
}
export function attend(q: readonly number[], keys: readonly number[][], values: readonly number[][], sinkLogit?: number) {
  if (!keys.length || keys.length !== values.length || keys.some(k => k.length !== q.length) || values.some(v => v.length !== values[0].length)) throw new Error('Attention dimensions do not match')
  const scores = keys.map(k => dot(q, k) / Math.sqrt(q.length)), all = softmax(sinkLogit === undefined ? scores : [...scores, sinkLogit]), weights = all.slice(0, scores.length)
  return { scores, weights, sinkWeight: sinkLogit === undefined ? 0 : all.at(-1)!, output: values[0].map((_, d) => values.reduce((s, v, i) => s + v[d] * weights[i], 0)) }
}
export function topK(scores: number[], k: number): number[] { return scores.map((score, i) => ({ score, i })).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, k).map(x => x.i) }

export interface MemoryPart { id: string; label: string; elements: number; bytes: number; note: string }
export interface MemoryLedger { parts: MemoryPart[]; elements: number; bytes: number; assumptions: string }
export interface StorageObject {
  id: string; kind: 'kv' | 'window' | 'index' | 'compressor' | 'state' | 'topk' | 'candidate'
  label: string; group: number; tokens: number[]; values?: Mat; elements: number; bytesPerElement: number; refs: string[]
}
export interface CompressionTrace { sourceTokens: number[]; sourceBranches: ('a' | 'b')[]; weights: number[][]; sourceValues: number[][]; pooled: number[]; position: number }
export interface AttentionEntry {
  id: string; storageId: string; label: string; tokens: number[]; key: number[]; value: number[]; latent?: number[]; rope?: number[]
  compression?: CompressionTrace; selected: boolean; score: number | null; weight: number; kind: 'token' | 'summary' | 'window'
}
export interface IndexTrace {
  id: string; group: number | null; scope: 'all-heads' | 'kv-group'; queries: number[][]; keys: number[][]; scores: number[]
  queryWeights: number[]; candidates: number[][]; selectedCandidates: number[]; selectedTokens: number[]; forcedTokens: number[]
  keyStorageIds: string[]; rule: string
}
export interface RecurrentTrace { before: Mat; decayed: Mat; prediction: number[]; residual: number[]; write: Mat; after: Mat; alpha: number[]; beta: number }
export interface HeadTrace {
  head: number; kvHead: number; q: number[]; k: number[]; v: number[]; entries: AttentionEntry[]; output: number[]; rawOutput: number[]
  tokenWeights: number[]; sinkWeight: number; sinkLogit?: number; recurrent?: RecurrentTrace; absorbedQuery?: number[]; latentOutput?: number[]
  indexId?: string
}
export interface MergeTrace { concat: number[]; groups?: number[][]; projected: number[]; output: number[]; matrix: number[][] }
export interface LayerReference {
  layer: number; mode: 'Full' | 'Reindex' | 'Reuse'; kvId: string; indexKeyId: string; topkId: string; candidateId: string
  generates: string[]; reuses: string[]; queryId: string; windowId: string; indexQueryId?: string
}
export interface AttentionStep {
  t: number; token: string; input: number[]; heads: HeadTrace[]; merge?: MergeTrace; indexes: IndexTrace[]
  storage: StorageObject[]; storageBefore: StorageObject[]; memory: MemoryLedger; memoryBefore: MemoryLedger
  evictedTokens: number[]; layers: LayerReference[]; structural: boolean
  stageStorage: StorageObject[][]; stageMemory: MemoryLedger[]
}
export interface ProjectionFixture { label: string; matrix: number[][]; head?: number }
export interface AttentionTrace { version: '2'; mechanism: MechanismId; steps: AttentionStep[]; parameters: ProjectionFixture[]; fidelity: 'numeric' | 'teaching' | 'structure' }
function projectionFixtures(id: MechanismId): ProjectionFixture[] {
  if (id === 'csa2') return []
  const out: ProjectionFixture[] = PROJECTIONS.map((p, h) => ({ label: `WQ · h${h}`, matrix: p.q, head: h }))
  const add = (label: string, matrix: number[][], head?: number) => out.push({ label, matrix, head })
  if (isLatent(id)) {
    add('Wᴰ · Joint latent', DOWN_MATRIX); add('WKR · RoPE Key', fixtureMatrix(2, 4, 30))
    range(HEADS).forEach(h => { add(`WQR · h${h}`, fixtureMatrix(2, 4, 31 + h), h); add(`Uₖ · h${h}`, upMatrix(h), h); add(`Uᵥ · h${h}`, valueUpMatrix(h), h) })
  } else if (isCompressed(id)) {
    add('Window KV Projection', fixtureMatrix(4, 4, 68))
    for (const b of range(id === 'csa' ? 2 : 1)) { add(`Compression C${b ? 'b' : 'a'}`, fixtureMatrix(4, 4, 55 + b)); add(`Compression Z${b ? 'b' : 'a'}`, fixtureMatrix(4, 4, 57 + b)) }
    const ratio = id === 'csa' ? 2 : 4; add('Compression position bias B · each branch', range(ratio).map(i => range(4).map(c => (i - ratio / 2) * (c + 1) / 10)))
    if (id === 'csa') { for (const b of range(2)) { add(`Indexer compression C${b ? 'b' : 'a'}`, fixtureMatrix(2, 4, 60 + b)); add(`Indexer compression Z${b ? 'b' : 'a'}`, fixtureMatrix(2, 4, 65 + b)) }; add('Indexer position bias B', range(2).map(i => range(2).map(c => (i - 1) * (c + 1) / 10))) }
  } else range(isRecurrent(id) ? HEADS : kvHeadCount(id)).forEach(g => { add(`WK · g${g}`, PROJECTIONS[g].k); add(`WV · g${g}`, PROJECTIONS[g].v) })
  if (['dsa', 'qsa', 'msa'].includes(id)) add('Indexer WK · raw keys', fixtureMatrix(2, 4, 48))
  if (['dsa', 'qsa', 'csa', 'msa'].includes(id)) range(id === 'qsa' ? 4 : 2).forEach(a => add(`Indexer WQ · ${id === 'msa' ? 'group' : 'head'} ${a}`, fixtureMatrix(2, 4, (id === 'msa' ? 71 : 49) + a)))
  if (isCompressed(id)) { GROUP_MATRICES.forEach((m, i) => add(`Grouped Output Projection ${i}`, m)); add('Final Wᴼ', GROUP_OUTPUT_MATRIX) } else add('Wᴼ · all Heads', OUTPUT_MATRIX)
  return out
}
const PART_LABELS = { kv: 'Main KV', window: 'Window KV', index: 'Indexer K', compressor: 'Compression working state', state: 'Recurrent State', topk: 'Top-K IDs', candidate: 'Candidate pool' }
export function ledgerFromStorage(objects: StorageObject[], batch = 1): MemoryLedger {
  const unique = [...new Map(objects.map(o => [o.id, o])).values()]
  const parts = Object.entries(PART_LABELS).flatMap(([kind, label]) => {
    const items = unique.filter(o => o.kind === kind)
    return items.length ? [{ id: kind, label, elements: items.reduce((s, o) => s + o.elements, 0) * batch, bytes: items.reduce((s, o) => s + o.elements * o.bytesPerElement, 0) * batch, note: `${items.length} storage objects · references are not additional copies` }] : []
  })
  return { parts, elements: parts.reduce((s, p) => s + p.elements, 0), bytes: parts.reduce((s, p) => s + p.bytes, 0), assumptions: 'Teaching dimensions · KV / Indexer FP16, State FP32, IDs int32. Includes the stated compression buffers; excludes weights, convolution state, temporary activations and allocator overhead.' }
}
// Compact storage regions permit large-L estimates without allocating a million token objects.
// The trace's concrete objects are validated against these same region sizes in tests.
export function storageRegions(id: MechanismId, length: number, layers = LAYERS): StorageObject[] {
  const out: StorageObject[] = [], add = (key: string, kind: StorageObject['kind'], elements: number, refs: string[], b = 2) => { if (elements) out.push({ id: key, kind, label: PART_LABELS[kind], group: 0, tokens: [], elements, bytesPerElement: b, refs }) }
  if (id === 'csa2') {
    add('global-kv', 'kv', length * DIM, range(layers).map(l => `L${l}`)); add('global-index', 'index', length * 2, ['L0', ...(layers > 1 ? ['L1'] : [])])
    add('candidate', 'candidate', Math.min(length, 4), ['L1'], 4)
    range(Math.min(layers, 2)).forEach(l => add(`topk-${l}`, 'topk', Math.min(length, 2), range(l === 0 ? 1 : layers - 1, l).map(i => `L${i}`), 4))
    range(layers).forEach(l => add(`window-${l}`, 'window', Math.min(length, WINDOW) * DIM, [`L${l}`]))
    return out
  }
  for (const l of range(layers)) {
    const refs = [`L${l}`], prefix = `L${l}:`
    if (isRecurrent(id)) { add(prefix + 'state', 'state', HEADS * DIM * DIM, refs, 4); continue }
    if (isCompressed(id)) {
      const r = id === 'csa' ? 2 : 4, complete = Math.floor(length / r), pending = length % r
      add(prefix + 'summary', 'kv', complete * DIM, refs); add(prefix + 'window', 'window', Math.min(length, WINDOW) * DIM, refs)
      // Raw inputs retained for the next weighted compression; overlap reuses the preceding full block.
      add(prefix + 'compressor', 'compressor', (pending + (id === 'csa' && complete ? r : 0)) * DIM, refs)
      if (id === 'csa') add(prefix + 'index', 'index', complete * 2, refs)
    } else {
      add(prefix + 'main', id === 'swa' ? 'window' : 'kv', (id === 'swa' ? Math.min(length, WINDOW) : length) * (isLatent(id) ? 4 : 2 * kvHeadCount(id) * DIM), refs)
      if (id === 'dsa' || id === 'msa') add(prefix + 'index', 'index', length * 2, refs)
      if (id === 'qsa') add(prefix + 'index', 'index', (Math.floor(length / 4) + length % 4) * 2, refs)
    }
  }
  return out
}
export function memoryLedger(id: MechanismId, length: number, batch = 1, layers = LAYERS): MemoryLedger {
  if (![length, batch, layers].every(n => Number.isSafeInteger(n) && n >= 1)) throw new Error('Memory dimensions must be positive integers')
  return ledgerFromStorage(storageRegions(id, length, layers), batch)
}
export function mergeHeads(outputs: number[][], grouped = false): MergeTrace {
  const concat = outputs.flat(), groups = grouped ? [project(concat.slice(0, 8), GROUP_MATRICES[0]), project(concat.slice(8), GROUP_MATRICES[1])] : undefined
  const projected = groups?.flat() ?? concat, matrix = grouped ? GROUP_OUTPUT_MATRIX : OUTPUT_MATRIX
  return { concat, groups, projected, output: project(projected, matrix), matrix }
}
const indexRaw = (t: number) => project(INPUTS[t], fixtureMatrix(2, 4, 48))
const indexQs = (t: number, n = 2, start = 49) => range(n).map(h => partialRoPE(project(INPUTS[t], fixtureMatrix(2, 4, start + h)), t))
const store = (id: string, kind: StorageObject['kind'], group: number, tokens: number[], values: Mat, refs: string[] = []): StorageObject => ({ id, kind, label: id, group, tokens, values, elements: values.flat().length, bytesPerElement: kind === 'state' ? 4 : 2, refs })
function normalEntry(t: number, h: number, id: MechanismId): AttentionEntry {
  const g = headToKV(h, kvHeadCount(id)), latent = isLatent(id) ? latentOf(t) : undefined
  const key = latent ? [...project(latent, upMatrix(h)), ...ropeKey(t)] : project(INPUTS[t], PROJECTIONS[g].k)
  const value = latent ? project(latent, valueUpMatrix(h)) : project(INPUTS[t], PROJECTIONS[g].v)
  const storageId = latent ? `latent:t${t}` : `kv:g${g}:t${t}`
  return { id: `h${h}:${storageId}`, storageId, tokens: [t], label: `t${t + 1} · ${latent ? 'Latent + RoPE' : `KV g${g}`}`, kind: id === 'swa' ? 'window' : 'token', key, value, latent, rope: latent ? ropeKey(t) : undefined, selected: true, score: null, weight: 0 }
}
export function compressBlock(block: number, ratio: number, overlap: boolean, index = false): CompressionTrace {
  const current = range(ratio, block * ratio), previous = overlap && block ? range(ratio, (block - 1) * ratio) : []
  const sourceTokens = [...current, ...previous], sourceBranches = sourceTokens.map((_, i) => i < current.length ? 'a' as const : 'b' as const), dim = index ? 2 : DIM
  const sourceValues = sourceTokens.map((t, i) => project(INPUTS[t], fixtureMatrix(dim, 4, (index ? 60 : 55) + (sourceBranches[i] === 'b' ? 1 : 0))))
  const logits = sourceTokens.map((t, i) => project(INPUTS[t], fixtureMatrix(dim, 4, (index ? 65 : 57) + (sourceBranches[i] === 'b' ? 1 : 0))).map((x, c) => x + ((i % ratio) - ratio / 2) * (c + 1) / 10))
  const byChannel = range(dim).map(c => softmax(logits.map(row => row[c])))
  const weights = sourceTokens.map((_, i) => byChannel.map(row => row[i]))
  const pooled = range(dim).map(c => sourceValues.reduce((s, row, i) => s + row[c] * weights[i][c], 0))
  return { sourceTokens, sourceBranches, sourceValues, weights, pooled, position: (block + 1) * ratio - 1 }
}
function compressedEntry(block: number, h: number, id: MechanismId): AttentionEntry {
  const compression = compressBlock(block, id === 'csa' ? 2 : 4, id === 'csa'), v = partialRoPE(rmsNorm(compression.pooled), compression.position), storageId = `summary:b${block}`
  return { id: `h${h}:${storageId}`, storageId, label: `C${block} · Shared KV`, tokens: compression.sourceTokens, key: v, value: v, compression, kind: 'summary', selected: true, score: null, weight: 0 }
}
function windowEntry(t: number, h: number): AttentionEntry {
  const v = partialRoPE(rmsNorm(project(INPUTS[t], fixtureMatrix(4, 4, 68))), t), storageId = `window:t${t}`
  return { id: `h${h}:${storageId}`, storageId, label: `t${t + 1} · Window`, tokens: [t], key: v, value: v, kind: 'window', selected: true, score: null, weight: 0 }
}
function buildIndex(id: MechanismId, t: number, group: number | null = null): IndexTrace {
  let candidates = range(t + 1).map(i => [i]), keys = candidates.map(ts => partialRoPE(indexRaw(ts[0]), ts[0])), queries = indexQs(t)
  let scores: number[] = [], forcedTokens: number[] = [], keyStorageIds = candidates.map(ts => `index:t${ts[0]}`)
  let queryWeights = [1, .7], rule = 'Σ index-head weights × ReLU(qᴵ · kᴵ); one Top-K shared by all Main Heads'
  if (id === 'qsa') {
    candidates = range(Math.floor((t + 1) / 4)).map(b => range(4, b * 4)); keys = candidates.map(ts => partialRoPE(rmsNorm(mean(ts.map(indexRaw))), ts[0]))
    keyStorageIds = candidates.map((_, b) => `index:block${b}`); queries = indexQs(t, 4); queryWeights = [1, 1, 1, 1]
    forcedTokens = range((t + 1) % 4, Math.floor((t + 1) / 4) * 4)
    rule = 'AvgPool → RMSNorm → block-start RoPE → Σ ReLU across Indexer Heads → Top-1 micro-block + incomplete tail'
  } else if (id === 'msa') {
    candidates = range(Math.ceil((t + 1) / 2)).map(b => range(Math.min(2, t + 1 - b * 2), b * 2))
    queries = indexQs(t, 1, 71 + (group ?? 0)); queryWeights = [1]
    scores = candidates.map(ts => Math.max(...ts.map(j => dot(queries[0], partialRoPE(indexRaw(j), j)) / Math.sqrt(2))))
    forcedTokens = candidates.at(-1)!; rule = 'Per GQA Group: max token score in each block → Top-2 (including forced Local Block)'
  } else if (id === 'csa') {
    // Strictly preceding blocks: the query's own compression block is excluded even at its last token.
    candidates = range(Math.floor(t / 2)).map(b => [b]); keys = candidates.map(([b]) => { const c = compressBlock(b, 2, true, true); return partialRoPE(rmsNorm(c.pooled), c.position) })
    keyStorageIds = candidates.map(([b]) => `index:summary${b}`); rule = 'Overlapping compressed Indexer K → Σ weighted ReLU → one shared Top-1 summary set'
  }
  if (id !== 'msa') scores = keys.map(k => queries.reduce((s, q, h) => s + queryWeights[h] * Math.max(0, dot(q, k)), 0))
  const budget = id === 'dsa' ? 2 : 1
  let selectedCandidates = topK(scores, budget)
  if (id === 'msa') {
    const local = candidates.length - 1
    selectedCandidates = [...new Set([...topK(scores.map((s, i) => i === local ? -Infinity : s), Math.min(1, local)), local])]
  }
  const selectedTokens = [...new Set([...selectedCandidates.flatMap(i => candidates[i]), ...forcedTokens])].sort((a, b) => a - b)
  return { id: group === null ? 'index:shared' : `index:group${group}`, group, scope: group === null ? 'all-heads' : 'kv-group', queries, keys, scores, queryWeights, candidates, selectedCandidates, selectedTokens, forcedTokens, keyStorageIds, rule }
}
function structuralStep(t: number, storageBefore: StorageObject[]): AttentionStep {
  const layers: LayerReference[] = range(4).map(layer => {
    const mode = layer === 0 ? 'Full' : layer === 1 ? 'Reindex' : 'Reuse', topkId = layer === 0 ? 'topk-0' : 'topk-1'
    return { layer, mode, kvId: 'global-kv', indexKeyId: 'global-index', topkId, candidateId: 'candidate', queryId: `L${layer}:Q`, windowId: `window-${layer}`, indexQueryId: layer < 2 ? `L${layer}:indexQ` : undefined,
      generates: layer === 0 ? ['global-kv', 'global-index', 'candidate', topkId] : layer === 1 ? [topkId] : [], reuses: layer === 0 ? [] : layer === 1 ? ['global-kv', 'global-index', 'candidate'] : ['global-kv', topkId] }
  })
  const storage = storageRegions('csa2', t + 1, 4)
  return { t, token: TOKENS[t], input: INPUTS[t], heads: [], indexes: [], storage, storageBefore, memory: ledgerFromStorage(storage), memoryBefore: ledgerFromStorage(storageBefore), evictedTokens: [], layers, structural: true, stageStorage: [], stageMemory: [] }
}
export function buildAttentionTrace(id: MechanismId): AttentionTrace {
  let states = range(HEADS).map(() => zeros()), previousStorage: StorageObject[] = []
  if (isRecurrent(id)) previousStorage = states.map((state, h) => store(`state:h${h}`, 'state', h, [], state, [`h${h}`]))
  const steps = TOKENS.map((token, t): AttentionStep => {
    if (id === 'csa2') { const s = structuralStep(t, previousStorage); previousStorage = s.storage; return s }
    const indexes = id === 'msa' ? range(2).map(g => buildIndex(id, t, g)) : ['dsa', 'qsa', 'csa'].includes(id) ? [buildIndex(id, t)] : []
    const heads = range(HEADS).map((h): HeadTrace => {
      const g = headToKV(h, kvHeadCount(id)), q0 = project(INPUTS[t], PROJECTIONS[h].q)
      if (isRecurrent(id)) {
        const k = normalize(project(INPUTS[t], PROJECTIONS[h].k)) as number[], v = project(INPUTS[t], PROJECTIONS[h].v), q = normalize(q0) as number[]
        const alpha = id === 'gdn' ? [.8, .8, .8, .8] : [1, .6, .9, .4], beta = .7, before = states[h], decayed = scaleColumns(before, alpha), prediction = matVec(decayed, k) as number[], residual = v.map((x, d) => x - prediction[d])
        const after = id === 'gdn' ? stepGated(before, k, v, beta, alpha[0]) : stepKda(before, k, v, beta, alpha)
        states[h] = after; const output = matVec(after, q) as number[]
        return { head: h, kvHead: h, q, k, v, output, rawOutput: output, entries: [], tokenWeights: [], sinkWeight: 0, recurrent: { before, decayed, prediction, residual, write: outer(residual.map(x => x * beta), k), after, alpha, beta } }
      }
      const index = indexes.find(i => i.group === null || i.group === g)
      let entries = range(t + 1).map(j => normalEntry(j, h, id))
      if (id === 'swa') entries = entries.slice(-WINDOW)
      if (isCompressed(id)) {
        const ratio = id === 'csa' ? 2 : 4
        entries = [...range(Math.floor((t + 1) / ratio)).map(b => ({ ...compressedEntry(b, h, id), selected: b < Math.floor(t / ratio) && (id === 'hca' || index!.selectedTokens.includes(b)) })), ...range(Math.min(t + 1, WINDOW), Math.max(0, t + 1 - WINDOW)).map(j => windowEntry(j, h))]
      } else if (index) entries = entries.map(e => ({ ...e, selected: index.selectedTokens.includes(e.tokens[0]) }))
      const q = isLatent(id) ? [...q0, ...ropeQuery(t, h)] : isCompressed(id) ? partialRoPE(rmsNorm(q0), t) : q0
      const selected = entries.filter(e => e.selected), sinkLogit = isCompressed(id) ? -.5 + .2 * h : undefined
      const latentScores = isLatent(id) ? selected.map(e => absorbedScore(q0, e.latent!, upMatrix(h), ropeQuery(t, h), e.rope!)) : undefined
      const explicit = latentScores ? { scores: latentScores, weights: softmax(latentScores), sinkWeight: 0, output: [] } : attend(q, selected.map(e => e.key), selected.map(e => e.value), sinkLogit)
      let wi = 0; entries.forEach(e => { if (e.selected) { e.score = explicit.scores[wi]; e.weight = explicit.weights[wi++] } })
      const latentOutput = isLatent(id) ? [0, 1].map(d => entries.reduce((s, e) => s + e.weight * e.latent![d], 0)) : undefined
      // Absorbed path is the primary MLA result; the expanded path is an independent test oracle.
      const rawOutput = latentOutput ? project(latentOutput, valueUpMatrix(h)) : explicit.output
      const output = isCompressed(id) ? partialRoPE(rawOutput, -t) : rawOutput
      const current = isCompressed(id) ? windowEntry(t, h) : normalEntry(t, h, id)
      const tokenWeights = range(TOKENS.length).map(() => 0)
      entries.forEach(e => e.tokens.forEach((j, i) => { const share = e.compression ? e.compression.weights[i].reduce((s, w) => s + w, 0) / DIM : 1; tokenWeights[j] += e.weight * share }))
      return { head: h, kvHead: g, q, k: current.key, v: current.value, entries, output, rawOutput, tokenWeights, sinkWeight: explicit.sinkWeight, sinkLogit, absorbedQuery: isLatent(id) ? absorbQuery(q0, upMatrix(h)) : undefined, latentOutput, indexId: index?.id }
    })
    const objectMap = new Map<string, StorageObject>()
    for (const h of heads) {
      if (h.recurrent) { objectMap.set(`state:h${h.head}`, store(`state:h${h.head}`, 'state', h.head, [], h.recurrent.after, [`h${h.head}`])); continue }
      for (const e of h.entries) {
        const existing = objectMap.get(e.storageId)
        if (existing) { existing.refs.push(`h${h.head}`); continue }
        objectMap.set(e.storageId, store(e.storageId, e.kind === 'window' ? 'window' : 'kv', h.kvHead, e.tokens, e.latent ? [e.latent, e.rope!] : isCompressed(id) ? [e.key] : [e.key, e.value], [`h${h.head}`]))
      }
    }
    if (id === 'dsa' || id === 'msa') range(t + 1).forEach(j => objectMap.set(`index:t${j}`, store(`index:t${j}`, 'index', 0, [j], [partialRoPE(indexRaw(j), j)])))
    if (id === 'qsa') {
      const idx = indexes[0]; idx.keys.forEach((k, b) => objectMap.set(`index:block${b}`, store(`index:block${b}`, 'index', 0, idx.candidates[b], [k])))
      idx.forcedTokens.forEach(j => objectMap.set(`index:tail${j}`, store(`index:tail${j}`, 'index', 0, [j], [indexRaw(j)])))
    }
    if (isCompressed(id)) {
      const ratio = id === 'csa' ? 2 : 4, complete = Math.floor((t + 1) / ratio), begin = Math.max(0, (complete - (id === 'csa' && complete ? 1 : 0)) * ratio)
      range(t + 1 - begin, begin).forEach(j => objectMap.set(`compressor:t${j}`, store(`compressor:t${j}`, 'compressor', 0, [j], [INPUTS[j]])))
      if (id === 'csa') range(complete).forEach(b => { const c = compressBlock(b, 2, true, true); objectMap.set(`index:summary${b}`, store(`index:summary${b}`, 'index', 0, c.sourceTokens, [partialRoPE(rmsNorm(c.pooled), c.position)])) })
    }
    const storage = [...objectMap.values()], storageBefore = previousStorage; previousStorage = storage
    return { t, token, input: INPUTS[t], heads, merge: mergeHeads(heads.map(h => h.output), isCompressed(id)), indexes, storage, storageBefore, memory: ledgerFromStorage(storage), memoryBefore: ledgerFromStorage(storageBefore), evictedTokens: id === 'swa' || isCompressed(id) ? range(Math.max(0, t + 1 - WINDOW)) : [], layers: [], structural: false, stageStorage: [], stageMemory: [] }
  })
  // Each view consumes these snapshots, including mutations that preserve the byte count.
  for (const s of steps) {
    s.stageStorage = range(PHASES).map(stage => {
      if (stage === 0) return s.storageBefore
      if (isRecurrent(id)) return s.storage.map(o => ({ ...o, values: stage < 2 ? s.heads[o.group].recurrent!.before : stage < 4 ? s.heads[o.group].recurrent!.decayed : s.heads[o.group].recurrent!.after }))
      if (s.structural && stage < 2) return [...s.storage.filter(o => o.kind !== 'topk' && o.kind !== 'candidate'), ...s.storageBefore.filter(o => o.kind === 'topk' || o.kind === 'candidate')]
      return s.storage
    })
    s.stageMemory = s.stageStorage.map(objects => ledgerFromStorage(objects))
  }
  return { version: '2', mechanism: id, steps, parameters: projectionFixtures(id), fidelity: id === 'csa2' ? 'structure' : ['dsa', 'qsa', 'msa', 'csa', 'hca'].includes(id) ? 'teaching' : 'numeric' }
}
export function recurrenceIdentityError(r: RecurrentTrace): number { return Math.max(...subMat(r.after, r.decayed.map((row, i) => row.map((x, j) => x + r.write[i][j]))).flat().map(Math.abs)) }
export function frameFromUrl(value: string | null, version: string | null, id: MechanismId): number {
  const n = Number(value)
  if (value === null || !Number.isInteger(n) || n < 0) return 0
  if (version === TRACE_VERSION) return n <= LAST_FRAME ? n : 0
  if (n >= TOKENS.length * 5) return 0
  const oldStages = isRecurrent(id) ? [0, 2, 3, 4, 5] : [0, 2, 3, 4, 1]
  return Math.floor(n / 5) * PHASES + oldStages[n % 5]
}
