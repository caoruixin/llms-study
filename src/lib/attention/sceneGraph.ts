import { PHASES, STAGES, RECURRENT_STAGES, isCompressed, isLatent, isRecurrent, type AttentionTrace, type StorageObject } from './engine'
import type { Mat } from '../kdaEngine'

export type Point = [number, number, number]
export interface TraceNode {
  id: string; label: string; detail: string; position: Point; kind: 'input' | 'query' | 'memory' | 'operator' | 'output' | 'state'
  head?: number; group?: number; values?: Mat; available: boolean; active: boolean; storage?: StorageObject; tokens?: number[]
}
export interface TraceEdge {
  id: string; from: string; to: string; operation: string; head?: number; weight?: number; tokens?: number[]
  path: 'score' | 'aggregate' | 'flow'
  // Edges only exist for the current operation. Segments within Output are clocked in dependency order.
  segment: [number, number]
}
export interface SceneFrame { nodes: TraceNode[]; edges: TraceEdge[]; title: string; stage: number; t: number; structural: boolean; note: string }
const lane = (h: number) => (h - 1.5) * 4.2
const subscript = (n: number) => String(n).replace(/\d/g, d => '₀₁₂₃₄₅₆₇₈₉'[Number(d)])
/** Pure semantic scene adapter. No attention, indexing, softmax or cache accounting is done here. */
export function buildSceneFrame(trace: AttentionTrace, frame: number): SceneFrame {
  const t = Math.floor(frame / PHASES), stage = frame % PHASES, s = trace.steps[t], id = trace.mechanism
  const nodes: TraceNode[] = [], edges: TraceEdge[] = []
  const add = (node: TraceNode) => { nodes.push(node); return node.id }
  const link = (from: string, to: string, operation: string, head?: number, tokens?: number[], weight?: number, segment: [number, number] = [0, 1], path: TraceEdge['path'] = 'flow') => edges.push({ id: `${from}>${to}:${operation}`, from, to, operation, head, tokens, weight, segment, path })
  const node = (id: string, label: string, position: Point, kind: TraceNode['kind'], detail: string, values?: Mat, available = true, active = false, head?: number) => add({ id, label, position, kind, detail, values: available ? values : undefined, available, active, head })
  if (s.structural) {
    node('encoder', 'Final Encoder states', [-8, 0, -3], 'input', 'CED · causal Encoder output; numerical Encoder computation is outside this view')
    const memory = s.stageStorage[stage]
    for (const [i, key] of ['global-kv', 'global-index', 'candidate'].entries()) {
      const o = memory.find(o => o.id === key)
      add({ id: key, label: ['Shared Global KV', 'Shared Indexer K', 'Candidate Pool'][i], detail: i === 2 ? 'Structural budget: up to 4 candidate positions; larger than final Top-2' : 'One object, shared references. Teaching ratio=1; no MLA latent reconstruction.', kind: 'memory', position: [-3 + i * 5, 0, -3], available: !!o, active: stage === (i === 2 ? 2 : 1), storage: o })
    }
    if (stage === 1) { link('encoder', 'global-kv', 'Project Global KV'); link('global-kv', 'global-index', 'Project Indexer K') }
    if (stage === 2) link('global-index', 'candidate', 'Full range → block candidates')
    for (const l of s.layers) {
      const z = l.layer * 3.1 + 1.5, colorHead = l.layer
      node(l.queryId, `L${l.layer + 1} · ${l.mode}`, [-7, 0, z], 'query', 'Every layer generates its own Main Q; every Main Head participates', undefined, true, stage === 0, colorHead)
      add({ id: l.windowId, label: `L${l.layer + 1} SWA KV`, detail: 'Layer-local K/V is generated even in Reuse Mode', kind: 'memory', position: [-2.8, 0, z], available: stage >= 1 || t > 0, active: stage === 1, storage: memory.find(o => o.id === l.windowId), head: colorHead })
      if (l.indexQueryId) node(l.indexQueryId, `Indexer Q · L${l.layer + 1}`, [1.4, 0, z], 'operator', l.mode === 'Full' ? 'Scores all causal Main KV positions' : 'Scores only the shared candidate pool', undefined, stage >= 2, stage === 2, colorHead)
      const selectionId = l.mode === 'Reuse' ? `L${l.layer}:reuse` : l.topkId
      node(selectionId, l.mode === 'Reuse' ? 'Reuse Top-K reference' : `Top-K · L${l.layer + 1}`, [5.6, 0, z], 'operator', `References ${l.topkId}; indices are not Main KV`, undefined, stage >= 2, stage === 2, colorHead)
      node(`L${l.layer}:output`, 'Attn\nOutput', [9.8, 0, z], 'output', 'Main Q + selected Main KV + local SWA. Structure only: no invented output vector.', undefined, stage >= 5, stage === 5, colorHead)
      if (stage === 1) link(l.queryId, l.windowId, 'Generate local SWA KV', colorHead)
      if (stage === 2) {
        if (l.indexQueryId) { link(l.mode === 'Full' ? 'global-index' : 'candidate', l.indexQueryId, 'Read index candidates', colorHead); link(l.indexQueryId, selectionId, 'New Top-K', colorHead) }
        else link(l.topkId, selectionId, 'Reuse existing index object', colorHead)
      }
      if (stage === 3 || stage === 4) { link('global-kv', selectionId, stage === 3 ? 'Selected K score' : 'Selected V read', colorHead); link(l.windowId, selectionId, 'Local window participates', colorHead); link(l.queryId, selectionId, 'Layer Main Q', colorHead) }
      if (stage === 5) link(selectionId, `L${l.layer}:output`, 'All Main Heads → output projection', colorHead)
    }
    return { nodes, edges, stage, t, title: STAGES[stage], structural: true, note: 'CED / CSA2 · Full → Reindex → Reuse → Reuse are static layer modes, not temporal decoding stages. Shared object IDs determine the ledger.' }
  }
  const recurrent = isRecurrent(id), latent = isLatent(id), compressed = isCompressed(id)
  node('input', `x[t${t + 1}] · ${s.token}`, [0, 0, -10], 'input', 'Input to ONE attention layer · 4 teaching dimensions', [s.input], true, stage === 0)
  const memory = s.stageStorage[stage]
  if (!recurrent) {
    const main = memory.filter(o => o.kind === 'kv' || o.kind === 'window')
    const groups = [...new Set(main.map(o => o.group))], summary = compressed ? main.filter(o => o.kind === 'kv') : []
    const projectionGroups = [...new Set(s.heads.map(h => h.kvHead))]
    projectionGroups.forEach((g, i) => {
      const h = s.heads.find(h => h.kvHead === g)!, current = s.storage.find(o => o.tokens.length === 1 && o.tokens[0] === t && o.group === g && (o.kind === 'kv' || o.kind === 'window'))
      node(`kv-project:g${g}`, latent ? 'c + kᴿ Projection' : compressed ? 'WKV\nK = V' : `WK / WV · g${g}`, [(i - (projectionGroups.length - 1) / 2) * 4.2, 0, -7.5], 'operator', latent ? 'Generate c and position key once; logical K/V follow from low-rank projections' : compressed ? 'Current Shared KV → RMSNorm → Partial RoPE' : 'Current token generates its own Key / Value before cache insertion', latent ? current?.values : [h.k, h.v], true, stage === 0)
      if (stage === 0) link('input', `kv-project:g${g}`, 'Current token KV projection')
    })
    const freshSummaries = compressed ? main.filter(o => o.kind === 'kv' && !s.storageBefore.some(old => old.id === o.id)) : []
    if (freshSummaries.length && stage === 1) {
      const sources = [...new Set(freshSummaries.flatMap(o => o.tokens))]
      node('compression-sources', 'Compression sources', [-8.8, 0, -6], 'memory', `Current token + buffered inputs: ${sources.map(j => `t${j + 1}`).join(', ')}. Working inputs are consumed, not duplicated permanent KV.`, undefined, true, true)
      link('input', 'compression-sources', 'Current projection + retained raw inputs', undefined, sources)
    }
    for (const o of main) {
      const groupRow = compressed ? (o.kind === 'window' ? 1 : 0) : groups.indexOf(o.group)
      const rowItems = compressed ? (o.kind === 'window' ? main.filter(x => x.kind === 'window') : summary) : main.filter(x => x.group === o.group)
      const index = rowItems.indexOf(o), x = (index - (rowItems.length - 1) / 2) * 1.7
      const label = o.id.startsWith('summary') ? `C${index}\nKV` : latent ? `c[${o.tokens[0] + 1}]\nkᴿ` : compressed ? `KV[${o.tokens[0] + 1}]` : `KV${subscript(o.tokens[0] + 1)},${subscript(o.group)}`
      add({ id: o.id, label, detail: `${o.elements} stored elements · ${o.refs.join(', ')}${compressed ? ' · same entry as Key AND Value' : ''}`, position: [x, 0, -4.7 + groupRow * 1.85], kind: 'memory', group: o.group, values: o.values, available: true, active: stage === 1 && !s.storageBefore.some(old => old.id === o.id), storage: o, tokens: o.tokens })
      if (stage === 1 && !s.storageBefore.some(old => old.id === o.id)) link(compressed && o.kind === 'kv' ? 'compression-sources' : `kv-project:g${o.group}`, o.id, compressed && o.kind === 'kv' ? 'Weighted compression + Norm + RoPE' : 'Append current KV', undefined, o.tokens)
    }
    // Separate persistent index/working state from main KV; the inspector lists every concrete object.
    const auxiliary = memory.filter(o => o.kind === 'index' || o.kind === 'compressor')
    if (auxiliary.length) {
      node('auxiliary', compressed ? 'Indexer / Compressor state' : 'Indexer K cache', [9.7, 0, -3], 'memory', auxiliary.map(o => `${o.id}: ${o.elements} elements`).join(';'), undefined, true, stage === 1)
      if (stage === 1) link('input', 'auxiliary', 'Update separate index / compression state')
    }
    const evicted = s.storageBefore.filter(o => o.kind === 'window' && !s.storage.some(now => now.id === o.id))
    if (stage === 1 && evicted.length) {
      node('eviction', 'Window Eviction', [-9.5, 0, 2], 'operator', evicted.map(o => `${o.id} removed from local cache`).join(';') + (compressed ? '; summary contributions may remain' : ''), undefined, true, true)
      evicted.forEach((o, i) => { const removedId = `evicted:${o.id}`; node(removedId, `Evict t${o.tokens[0] + 1} · g${o.group}`, [-9.5, 0, -2 + i * 1.6], 'memory', 'Old local copy: excluded from current cache ledger and Attention reads', o.values, true, true); link(removedId, 'eviction', 'Remove old Window KV', undefined, o.tokens) })
    }
    for (const [i, ix] of s.indexes.entries()) {
      node(ix.id, ix.group === null ? 'Top-K\nAll Heads' : `Top-K · g${ix.group}`, [s.indexes.length === 1 ? 0 : i * 8 - 4, 0, 2.1], 'operator', ix.rule, stage >= 2 ? [ix.scores] : undefined, stage >= 2, stage === 2)
      ix.queries.forEach((q, a) => {
        const qId = `${ix.id}:q${a}`, x = s.indexes.length === 1 ? (a - (ix.queries.length - 1) / 2) * 4.2 : i * 8 - 4
        node(qId, `Qᴵ[${ix.group === null ? `a${a}` : `g${ix.group}`}]`, [x, 0, -.2], 'query', 'Independent Indexer Query, distinct from Main Attention Heads', [q], stage >= 2, stage === 2)
        if (stage === 2) { link('input', qId, 'Independent Indexer Q projection'); link(qId, ix.id, id === 'msa' ? 'Token scores → block maximum' : `ReLU × ${ix.queryWeights[a]} → sum over Indexer Heads`) }
      })
      if (stage === 2 && auxiliary.length) link('auxiliary', ix.id, 'Indexer keys → scores → Top-K')
    }
  }
  for (const h of s.heads) {
    const x = lane(h.head), qid = `head-${h.head}`, scoreId = `score:h${h.head}`, outId = `head-output:${h.head}`
    node(qid, `Q[t${t + 1},h${h.head}]`, [x, 0, 4], 'query', recurrent ? `Independent Query; State h${h.head}` : latent ? 'Content Query + RoPE Query; reads shared latent memory' : `Reads KV Group ${h.kvHead}; weights remain head-specific`, [h.q], true, stage === 0, h.head)
    if (stage === 0) link('input', qid, 'WQ Projection', h.head)
    if (recurrent) {
      const r = h.recurrent!, stateId = `state:h${h.head}`, matrix = stage < 2 ? r.before : stage < 4 ? r.decayed : r.after
      node(`new-kv:h${h.head}`, `K / V · h${h.head}`, [x, 0, -7.5], 'operator', 'Current K and V from independent projections; K is normalized', [h.k, h.v], true, stage === 0, h.head)
      if (stage === 0) link('input', `new-kv:h${h.head}`, 'Current K / V projections', h.head)
      add({ id: stateId, label: `State S[h${h.head}]`, detail: 'Rows = Value channels; columns = Key channels · fixed 4×4', position: [x, 0, -2.5], kind: 'state', values: matrix, available: true, active: stage === 2 || stage === 4, head: h.head, storage: memory.find(o => o.id === stateId) })
      node(`gate:h${h.head}`, 'α · Decay', [x, 0, -5], 'operator', id === 'gdn' ? 'One scalar per Head' : 'One gate per Key channel', [r.alpha], true, stage === 2, h.head)
      node(scoreId, 'Prediction → Residual', [x, 0, .8], 'operator', 'prediction = S̄ k; residual = v − prediction', stage >= 3 ? [r.prediction, r.residual] : undefined, stage >= 3, stage === 3, h.head)
      node(`write:h${h.head}`, 'β · Residual ⊗ K', [x, 0, 6.3], 'operator', 'Delta Write: S = S̄ + β residual kᵀ', r.write, stage >= 4, stage === 4, h.head)
      if (stage === 1) link('input', stateId, 'Prepare previous State reference', h.head)
      if (stage === 2) link(`gate:h${h.head}`, stateId, 'Decay Key channels', h.head)
      if (stage === 3) { link(stateId, scoreId, 'Read S̄ with current K', h.head); link(`new-kv:h${h.head}`, scoreId, 'Current K / V → prediction error', h.head) }
      if (stage === 4) { link(scoreId, `write:h${h.head}`, 'β residual kᵀ', h.head); link(`write:h${h.head}`, stateId, 'Add Delta Write', h.head) }
      if (stage === 5) { link(stateId, outId, 'Updated State Query Readout', h.head, undefined, undefined, [0, .32]); link(qid, outId, 'S q', h.head, undefined, undefined, [0, .32]) }
    } else {
      node(scoreId, 'Mask · Softmax', [x, 0, 6.3], 'operator', compressed ? `Scaled score; Entry weights + Sink weight = 1; sink=${h.sinkWeight.toFixed(4)}` : 'QK score / √d → Causal Mask → Softmax; each Head has its own distribution', stage >= 3 ? [h.entries.map(e => e.weight)] : undefined, stage >= 3, stage === 3, h.head)
      if (latent) node(`latent-agg:h${h.head}`, 'Σ w·c\n→ Uᵥ', [x, 0, 8.9], 'operator', 'Weighted latent accumulation, then Value up-projection; not a persistent expanded V cache', h.latentOutput ? [h.latentOutput] : undefined, stage >= 4, stage === 4, h.head)
      if (stage === 2 && h.indexId) link(h.indexId, qid, 'Shared selection; independent Main Head', h.head)
      if (stage === 3) {
        link(qid, scoreId, latent ? '(Uₖᵀ q)·c + qᴿ·kᴿ' : 'Q dot K / √d', h.head)
        h.entries.filter(e => e.selected).forEach(e => link(e.storageId, scoreId, latent ? 'Latent content + RoPE score' : 'Key score', h.head, e.tokens, e.weight, [0, 1], 'score'))
      }
      if (stage === 4) {
        const target = latent ? `latent-agg:h${h.head}` : outId
        link(scoreId, target, 'Attention Weights', h.head, undefined, undefined, [0, latent ? .6 : 1])
        h.entries.filter(e => e.selected).forEach(e => link(e.storageId, target, latent ? 'Weighted latent read' : 'Weighted Value read', h.head, e.tokens, e.weight, [0, latent ? .6 : 1], 'aggregate'))
        if (latent) link(target, outId, 'Uᵥ projection', h.head, undefined, undefined, [.6, 1])
      }
    }
    node(outId, compressed ? `O[h${h.head}]\nR⁻¹` : `O[h${h.head}]\nHead Output`, [x, 0, latent ? 12.1 : 9.8], 'output', compressed ? 'Head Output = Weighted Shared KV → inverse output RoPE R⁻¹' : recurrent ? 'Only available after Query Readout' : 'This Head only; not the final Attention Output', [h.output], stage >= (recurrent ? 5 : 4), stage === (recurrent ? 5 : 4), h.head)
  }
  const endZ = latent ? 15.5 : 13
  node('concat', s.merge!.groups ? 'Group Proj.\n→ Concat' : 'Concat · O[0…3]', [-4.5, 0, endZ], 'operator', s.merge!.groups ? '2 groups: concatenate 2 Head outputs per group, project 8→2, then concatenate' : 'All 4 Head outputs concatenate to 16 dimensions', [s.merge!.concat], stage === 5, stage === 5)
  node('projection', 'Wᴼ\nProjection', [0, 0, endZ], 'operator', s.merge!.groups ? 'Grouped intermediate 4 → final 4' : '16 → 4 teaching dimensions', s.merge!.matrix, stage === 5, stage === 5)
  node('output', 'Attention Output', [5, 0, endZ], 'output', 'Complete attention module output; FFN / Residual / LM Head are outside this demonstration', [s.merge!.output], stage === 5, stage === 5)
  if (stage === 5) {
    s.heads.forEach(h => link(`head-output:${h.head}`, 'concat', 'Every Head participates', h.head, undefined, undefined, recurrent ? [.32, .58] : [0, .35]))
    link('concat', 'projection', s.merge!.groups ? 'Grouped intermediate' : 'Concatenated Heads', undefined, undefined, undefined, [.58, .78]); link('projection', 'output', 'Wᴼ projection', undefined, undefined, undefined, [.78, 1])
  }
  return { nodes, edges, stage, t, structural: false, title: (recurrent ? RECURRENT_STAGES : STAGES)[stage], note: 'One computed layer · Q[t,h]: token t, Query Head h. KVⱼ,𝗀: token j, KV Head g. Qᴵ: Indexer Query; R⁻¹: inverse output RoPE. Every Head participates; focus changes emphasis only.' }
}
