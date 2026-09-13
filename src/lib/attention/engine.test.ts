import { describe, expect, it } from 'vitest'
import { MECHANISMS } from '../../data/architectureTerms'
import { ATTENTION_THEORY } from '../../data/attentionTheory'
import { HEADS, INPUTS, PROJECTIONS, OUTPUT_MATRIX, GROUP_MATRICES, GROUP_OUTPUT_MATRIX, PHASES, absorbedScore, attend, buildAttentionTrace, compressBlock, frameFromUrl, headToKV, isLatent, ledgerFromStorage, memoryLedger, mergeHeads, partialRoPE, recurrenceIdentityError, ropeKey, ropeQuery, softmax, topK, upMatrix, valueUpMatrix } from './engine'
// Independent direct matrix oracle: deliberately does not call the engine's projection/attention helpers.
const mv = (w: readonly (readonly number[])[], x: readonly number[]) => w.map(row => row.reduce((s, v, j) => s + v * x[j], 0))
const dot = (x: number[], y: number[]) => x.reduce((s, a, j) => s + a * y[j], 0)
const close = (a: readonly number[], b: readonly number[]) => { expect(a.length).toBe(b.length); a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 10)) }
const oracle = (q: number[], keys: number[][], values: number[][], sink?: number) => {
  const scores = keys.map(k => dot(q, k) / Math.sqrt(q.length)), all = sink === undefined ? scores : [...scores, sink], max = Math.max(...all)
  const exp = all.map(s => Math.exp(s - max)), sum = exp.reduce((a, b) => a + b, 0), weights = exp.slice(0, keys.length).map(e => e / sum)
  return { scores, weights, out: values[0].map((_, d) => values.reduce((s, v, j) => s + weights[j] * v[d], 0)) }
}
describe('Hand-calculable arithmetic and independent Head projections', () => {
  it('uses stable Softmax and handles a known weighted sum', () => { close(softmax([1000, 1000]), [.5, .5]); close(softmax([0, Math.log(3)]), [.25, .75]); close(attend([1, 0], [[0, 1], [0, -1]], [[2, 4], [6, 8]]).output, [4, 6]) })
  it('rejects incompatible dimensions', () => { expect(() => attend([1], [[1, 2]], [[1]])).toThrow(); expect(() => attend([1], [[1], [2]], [[1], [2, 3]])).toThrow() })
  it('uses stable Top-K ties and respects undersized candidate sets', () => { expect(topK([.2, .8, .8, .1], 2)).toEqual([1, 2]); expect(topK([1], 20)).toEqual([0]); expect(topK([], 2)).toEqual([]) })
  it('maps each Head to the correct MHA / MQA / GQA group', () => { expect([0, 1, 2, 3].map(h => headToKV(h, 4))).toEqual([0, 1, 2, 3]); expect([0, 1, 2, 3].map(h => headToKV(h, 1))).toEqual([0, 0, 0, 0]); expect([0, 1, 2, 3].map(h => headToKV(h, 2))).toEqual([0, 0, 1, 1]) })
  it('uses actual independent linear projections, with distinct MHA distributions', () => {
    const s = buildAttentionTrace('mha').steps[7]
    for (const h of s.heads) { close(h.q, mv(PROJECTIONS[h.head].q, INPUTS[7])); close(h.k, mv(PROJECTIONS[h.head].k, INPUTS[7])); expect(h.q).not.toEqual(h.k) }
    expect(new Set(s.heads.map(h => JSON.stringify(h.tokenWeights))).size).toBe(4)
  })
  it.each(['mqa', 'gqa'] as const)('%s shares stored K/V but not Query or weights', id => {
    const h = buildAttentionTrace(id).steps[7].heads
    expect(h[0].k).toEqual(h[1].k); expect(h[0].v).toEqual(h[1].v); expect(h[0].q).not.toEqual(h[1].q); expect(h[0].tokenWeights).not.toEqual(h[1].tokenWeights)
    expect(h[0].entries.map(e => e.storageId)).toEqual(h[1].entries.map(e => e.storageId))
  })
  it('every Head contributes to the complete Wᴼ output', () => {
    const heads = buildAttentionTrace('mha').steps[7].heads.map(h => h.output), base = mergeHeads(heads)
    close(base.output, mv(OUTPUT_MATRIX, heads.flat()))
    for (let h = 0; h < HEADS; h++) { const altered = heads.map(v => [...v]); altered[h][0] += 1; const next = mergeHeads(altered); close(next.output.map((v, i) => v - base.output[i]), OUTPUT_MATRIX.map(row => row[h * 4])); expect(next.output).not.toEqual(base.output) }
  })
  it('matches the independently calculated t2 example published in the audit', () => {
    const s = buildAttentionTrace('mha').steps[1]
    close(s.heads[0].entries.map(e => e.score!), [.493359375, .605859375])
    close(s.heads[0].entries.map(e => e.weight), [.47190462559161295, .528095374408387])
    close(s.merge!.output, [-1.5095013483417528, -.3007893214970146, .26261658642144786, .22558928286386826])
  })
  it('computes Grouped Output Projection through both real matrix stages', () => {
    const h = buildAttentionTrace('csa').steps[7].heads.map(h => h.output), result = mergeHeads(h, true)
    const groups = [mv(GROUP_MATRICES[0], h.slice(0, 2).flat()), mv(GROUP_MATRICES[1], h.slice(2).flat())]
    close(result.output, mv(GROUP_OUTPUT_MATRIX, groups.flat())); expect(result.groups).toEqual(groups)
  })
})
describe.each(MECHANISMS)('%s complete trace', id => {
  const trace = buildAttentionTrace(id)
  it('has reproducible data, explicit fidelity and source boundaries', () => { expect(trace).toEqual(buildAttentionTrace(id)); expect(trace.version).toBe('2'); expect(trace.steps).toHaveLength(8); expect(ATTENTION_THEORY[id].locator).toBeTruthy(); expect(ATTENTION_THEORY[id].omitted).toBeTruthy() })
  it('agrees with the independent direct attention oracle for EVERY Head and token', () => {
    for (const s of trace.steps) {
      if (s.structural) { expect(s.heads).toEqual([]); expect(s.merge).toBeUndefined(); continue }
      expect(s.heads).toHaveLength(4)
      for (const h of s.heads) {
        expect(h.output.every(Number.isFinite)).toBe(true)
        if (h.recurrent) { close(h.output, mv(h.recurrent.after, h.q)); continue }
        const selected = h.entries.filter(e => e.selected), expected = oracle(h.q, selected.map(e => e.key), selected.map(e => e.value), h.sinkLogit)
        close(selected.map(e => e.score!), expected.scores); close(selected.map(e => e.weight), expected.weights); close(h.rawOutput, expected.out)
        expect(h.entries.reduce((sum, e) => sum + e.weight, 0) + h.sinkWeight).toBeCloseTo(1, 12)
        for (const e of h.entries) { expect(e.tokens.every(j => j <= s.t)).toBe(true); if (!e.selected) { expect(e.weight).toBe(0); expect(e.score).toBeNull() } }
      }
      close(s.merge!.output, mv(s.merge!.matrix, s.merge!.projected))
    }
  })
  it('concrete cache objects match independent region counts and scale by requests', () => {
    for (const s of trace.steps) {
      expect(new Set(s.storage.map(o => o.id)).size).toBe(s.storage.length)
      expect(s.memory).toEqual(ledgerFromStorage(s.storage))
      const predicted = memoryLedger(id, s.t + 1, 1, s.structural ? 4 : 1)
      expect(s.memory.elements).toBe(predicted.elements); expect(s.memory.bytes).toBe(predicted.bytes)
      s.storage.filter(o => o.values).forEach(o => expect(o.elements).toBe(o.values!.flat().length))
      expect(ledgerFromStorage([...s.storage, ...s.storage]).bytes).toBe(s.memory.bytes)
    }
    expect(memoryLedger(id, 8192, 16).bytes).toBe(memoryLedger(id, 8192).bytes * 16)
  })
  it('keeps immutable snapshots when appending and replaying', () => { const s = trace.steps[5]; expect(s).toEqual(buildAttentionTrace(id).steps[5]); expect(trace.steps[6].storageBefore).toEqual(s.storage) })
  it('exposes only the storage mutations reached by each phase', () => {
    for (const s of trace.steps) {
      expect(s.stageStorage).toHaveLength(6); expect(s.stageStorage[0]).toEqual(s.storageBefore)
      s.stageStorage.forEach((objects, phase) => expect(s.stageMemory[phase]).toEqual(ledgerFromStorage(objects)))
      if (s.structural) {
        const isIndex = (o: { kind: string }) => o.kind === 'topk' || o.kind === 'candidate'
        expect(s.stageStorage[1].filter(isIndex)).toEqual(s.storageBefore.filter(isIndex))
        expect(s.stageStorage[2]).toEqual(s.storage)
      }
      for (const h of s.heads.filter(h => h.recurrent)) for (let phase = 1; phase < 6; phase++) {
        expect(s.stageStorage[phase].find(o => o.id === `state:h${h.head}`)!.values).toEqual(phase < 2 ? h.recurrent!.before : phase < 4 ? h.recurrent!.decayed : h.recurrent!.after)
      }
    }
  })
})
describe('MLA absorbed path and cache semantics', () => {
  it.each(['mla', 'dsa'] as const)('%s has exactly one shared latent and position cache', id => {
    const trace = buildAttentionTrace(id)
    for (const s of trace.steps) {
      const cache = s.storage.filter(o => o.kind === 'kv'); expect(cache.length).toBe(s.t + 1); cache.forEach(o => { expect(o.elements).toBe(4); expect(o.refs).toHaveLength(4) })
      for (const h of s.heads) {
        for (const e of h.entries.filter(e => e.selected)) expect(absorbedScore(h.q.slice(0, 4), e.latent!, upMatrix(h.head), ropeQuery(s.t, h.head), ropeKey(e.tokens[0]))).toBeCloseTo(e.score!, 12)
        close(h.output, mv(valueUpMatrix(h.head), h.latentOutput!))
      }
    }
  })
})
describe('Distinct sparse routing contracts', () => {
  it('DSA selects once for all Main Heads, independently of their Queries', () => {
    for (const s of buildAttentionTrace('dsa').steps) { expect(s.indexes).toHaveLength(1); const selected = s.heads[0].entries.filter(e => e.selected).map(e => e.storageId); for (const h of s.heads) expect(h.entries.filter(e => e.selected).map(e => e.storageId)).toEqual(selected); expect(selected).toHaveLength(Math.min(2, s.t + 1)); expect(s.storage.filter(o => o.kind === 'index')).toHaveLength(s.t + 1) }
  })
  it('DSA index score combines independent Indexer Heads using the traced weights', () => {
    for (const s of buildAttentionTrace('dsa').steps) { const ix = s.indexes[0]; close(ix.scores, ix.keys.map(k => ix.queries.reduce((a, q, h) => a + ix.queryWeights[h] * Math.max(0, dot(q, k)), 0))) }
  })
  it('QSA only indexes complete causal blocks and always keeps the incomplete tail', () => {
    for (const s of buildAttentionTrace('qsa').steps) {
      const ix = s.indexes[0]; expect(ix.queries).toHaveLength(4); ix.candidates.forEach(ts => { expect(ts).toHaveLength(4); expect(Math.max(...ts)).toBeLessThanOrEqual(s.t) })
      close(ix.scores, ix.keys.map(k => ix.queries.reduce((a, q) => a + Math.max(0, dot(q, k)), 0)))
      expect(ix.forcedTokens).toEqual(Array.from({ length: (s.t + 1) % 4 }, (_, i) => Math.floor((s.t + 1) / 4) * 4 + i))
      const sets = s.heads.map(h => h.entries.filter(e => e.selected).map(e => e.tokens[0])); sets.forEach(set => expect(set).toEqual(ix.selectedTokens))
      expect(s.storage.filter(o => o.kind === 'kv')).toHaveLength(2 * (s.t + 1))
    }
  })
  it('MSA uses group-specific max scoring and keeps Local Block even at exact block boundaries', () => {
    const trace = buildAttentionTrace('msa')
    for (const s of trace.steps) {
      expect(s.indexes).toHaveLength(2)
      for (const ix of s.indexes) {
        const reference = ix.candidates.map(ts => Math.max(...ts.map(j => dot(ix.queries[0], ix.keys[j]) / Math.sqrt(2))))
        close(ix.scores, reference); expect(ix.forcedTokens).toContain(s.t)
        const hs = s.heads.filter(h => h.kvHead === ix.group); expect(hs).toHaveLength(2)
        hs.forEach(h => expect(h.entries.filter(e => e.selected).map(e => e.tokens[0])).toEqual(ix.selectedTokens))
        expect(ix.selectedCandidates).toContain(ix.candidates.length - 1)
      }
    }
    expect(trace.steps.some(s => JSON.stringify(s.indexes[0].selectedTokens) !== JSON.stringify(s.indexes[1].selectedTokens))).toBe(true)
  })
})
describe('SWA and compressed Shared KV', () => {
  it('SWA stores and reads only its window and evicts old positions', () => { const s = buildAttentionTrace('swa').steps[7]; expect(s.evictedTokens).toEqual([0, 1, 2, 3, 4]); s.heads.forEach(h => expect(h.entries.map(e => e.tokens[0])).toEqual([5, 6, 7])); expect(memoryLedger('swa', 8).bytes).toBe(memoryLedger('swa', 8192).bytes) })
  it('weights the compression channels, with two-branch overlap only in CSA', () => {
    const c = compressBlock(1, 2, true), h = compressBlock(1, 4, false)
    expect(c.sourceTokens).toEqual([2, 3, 0, 1]); expect(c.sourceBranches).toEqual(['a', 'a', 'b', 'b']); expect(h.sourceTokens).toEqual([4, 5, 6, 7])
    for (const x of [c, h]) for (let d = 0; d < 4; d++) { expect(x.weights.reduce((s, row) => s + row[d], 0)).toBeCloseTo(1, 12); expect(x.pooled[d]).toBeCloseTo(x.sourceValues.reduce((s, row, i) => s + row[d] * x.weights[i][d], 0), 12) }
    expect(c.weights[0]).not.toEqual(c.weights[1])
  })
  it.each(['csa', 'hca'] as const)('%s shares the SAME entry as K/V and preserves strict summary causality', id => {
    const ratio = id === 'csa' ? 2 : 4
    for (const s of buildAttentionTrace(id).steps) for (const h of s.heads) {
      expect(h.kvHead).toBe(0); expect(h.sinkWeight).toBeGreaterThan(0)
      for (const e of h.entries) { expect(e.key).toEqual(e.value); if (e.kind === 'summary' && e.selected) expect(Math.floor(e.compression!.position / ratio)).toBeLessThan(Math.floor(s.t / ratio)) }
      close(h.output, partialRoPE(h.rawOutput, -s.t)); expect(h.entries.reduce((a, e) => a + e.weight, 0)).toBeLessThan(1)
    }
    expect(memoryLedger(id, 8192).bytes).toBeGreaterThan(memoryLedger(id, 8).bytes)
  })
  it('summary sources can overlap each other and the local window (not a partition)', () => {
    const h = buildAttentionTrace('csa').steps[6].heads[0], all = h.entries.flatMap(e => e.tokens)
    expect(new Set(all).size).toBeLessThan(all.length)
  })
  it('inverse partial RoPE is exactly invertible and leaves content channels unchanged', () => { const x = [1, -2, 3, .4], y = partialRoPE(x, 7); expect(y.slice(0, 2)).toEqual(x.slice(0, 2)); close(partialRoPE(y, -7), x) })
})
describe('Recurrent state and readout', () => {
  it.each(['gdn', 'kda'] as const)('%s performs the independently recomputed update in every Head', id => {
    for (const s of buildAttentionTrace(id).steps) for (const h of s.heads) {
      const r = h.recurrent!; expect(h.q).not.toEqual(h.k); expect(recurrenceIdentityError(r)).toBeLessThan(1e-12)
      const decay = r.before.map(row => row.map((v, d) => v * r.alpha[d])), prediction = mv(decay, h.k)
      const expected = decay.map((row, i) => row.map((v, j) => v + r.beta * (h.v[i] - prediction[i]) * h.k[j]))
      expected.forEach((row, i) => close(r.after[i], row)); close(h.output, mv(expected, h.q))
      expect(new Set(r.alpha).size).toBe(id === 'gdn' ? 1 : 4)
    }
    expect(memoryLedger(id, 8).bytes).toBe(memoryLedger(id, 1048576).bytes)
  })
})
describe('CED structure, sharing and version migration', () => {
  it('has no fabricated MLA tensors and uses static layer object references', () => {
    const trace = buildAttentionTrace('csa2'); expect(trace.fidelity).toBe('structure'); expect(isLatent('csa2')).toBe(false)
    for (const s of trace.steps) {
      expect(s.heads).toEqual([]); expect(s.merge).toBeUndefined(); expect(s.layers.map(l => l.mode)).toEqual(['Full', 'Reindex', 'Reuse', 'Reuse'])
      expect(s.layers[1].kvId).toBe(s.layers[0].kvId); expect(s.layers[2].topkId).toBe(s.layers[1].topkId); expect(s.layers[2].indexQueryId).toBeUndefined()
      expect(new Set(s.layers.map(l => l.queryId)).size).toBe(4); expect(new Set(s.layers.map(l => l.windowId)).size).toBe(4)
      expect(s.storage.find(o => o.id === 'candidate')!.elements).toBeGreaterThanOrEqual(s.storage.find(o => o.id === 'topk-1')!.elements)
    }
  })
  it('shares global KV across layers while keeping local windows distinct', () => { const a = memoryLedger('csa2', 8, 1, 1), b = memoryLedger('csa2', 8, 1, 4); expect(a.parts.find(p => p.id === 'kv')!.bytes).toBe(b.parts.find(p => p.id === 'kv')!.bytes); expect(b.parts.find(p => p.id === 'window')!.bytes).toBe(4 * a.parts.find(p => p.id === 'window')!.bytes) })
  it('migrates legacy positions by token and semantic phase', () => { expect(frameFromUrl('37', null, 'mha')).toBe(7 * PHASES + 3); expect(frameFromUrl('39', null, 'mha')).toBe(7 * PHASES + 1); expect(frameFromUrl('38', null, 'kda')).toBe(7 * PHASES + 4); expect(frameFromUrl('47', '2', 'mha')).toBe(47); expect(frameFromUrl('48', '2', 'mha')).toBe(0); expect(frameFromUrl('-1', '2', 'mha')).toBe(0); expect(frameFromUrl(null, null, 'mha')).toBe(0) })
  it('rejects invalid memory dimensions', () => { expect(() => memoryLedger('mla', 0)).toThrow(); expect(() => memoryLedger('mla', 4, 1.5)).toThrow() })
})
