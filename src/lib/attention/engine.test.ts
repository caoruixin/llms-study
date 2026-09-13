import { describe, expect, it } from 'vitest'
import { MECHANISMS } from '../../data/architectureTerms'
import { matVec, stepGated } from '../kdaEngine'
import { HEADS, TOKENS, absorbedScore, attend, buildAttentionTrace, headToKV, isRecurrent, latentOf, memoryLedger, recurrenceIdentityError, ropeKey, softmax, topK, upMatrix } from './engine'

const closeVector = (actual: readonly number[], expected: readonly number[]) => { expect(actual.length).toBe(expected.length); actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 10)) }
describe('Attention arithmetic', () => {
  it('is stable for large softmax logits', () => { closeVector(softmax([1000, 1000]), [.5, .5]); closeVector(softmax([0, Math.log(3)]), [.25, .75]) })
  it('matches a hand-computable attention example', () => { const a = attend([1, 0], [[0, 1], [0, -1]], [[2, 4], [6, 8]]); closeVector(a.weights, [.5, .5]); closeVector(a.output, [4, 6]) })
  it('rejects incompatible tensor dimensions', () => { expect(() => attend([1], [[1, 2]], [[1]])).toThrow(); expect(() => attend([1], [[1], [2]], [[1], [2, 3]])).toThrow() })
  it('uses stable tie-breaking for sparse selection', () => { expect(topK([.2, .8, .8, .1], 2)).toEqual([1, 2]); expect(topK([1], 20)).toEqual([0]) })
  it('maps four Q heads to MHA, MQA and GQA KV groups', () => { expect([0, 1, 2, 3].map(h => headToKV(h, 4))).toEqual([0, 1, 2, 3]); expect([0, 1, 2, 3].map(h => headToKV(h, 1))).toEqual([0, 0, 0, 0]); expect([0, 1, 2, 3].map(h => headToKV(h, 2))).toEqual([0, 0, 1, 1]) })
  it('shares K/V exactly within GQA groups while preserving Q heads', () => { const h = buildAttentionTrace('gqa').steps[3].heads; expect(h[0].k).toEqual(h[1].k); expect(h[0].v).toEqual(h[1].v); expect(h[0].q).not.toEqual(h[1].q); expect(h[2].k).toEqual(h[3].k) })
  it('counts KV heads separately from Q heads', () => { expect(memoryLedger('mha', 8).bytes).toBe(2048); expect(memoryLedger('mqa', 8).bytes).toBe(512); expect(memoryLedger('gqa', 8).bytes).toBe(1024) })
})
describe.each(MECHANISMS)('%s trace invariants', id => {
  const trace = buildAttentionTrace(id)
  it('is deterministic, finite and causal for every step', () => {
    expect(trace).toEqual(buildAttentionTrace(id)); expect(trace.steps).toHaveLength(TOKENS.length)
    for (const s of trace.steps) for (const h of s.heads) {
      expect(h.output.every(Number.isFinite)).toBe(true)
      for (const e of h.entries) { expect(e.tokens.every(t => t <= s.t)).toBe(true); expect(e.selected || e.weight === 0).toBe(true) }
      if (!isRecurrent(id)) expect(h.entries.reduce((v, e) => v + e.weight, 0)).toBeCloseTo(1, 12)
    }
  })
  it('replays the identical output and ledger when stepping backward then forward', () => {
    const original = trace.steps[6]; const replay = buildAttentionTrace(id).steps[6]
    expect(replay).toEqual(original); expect(replay.memory.bytes).toBe(replay.memory.parts.reduce((s, p) => s + p.bytes, 0))
  })
  it('scales per-request memory linearly with concurrency', () => { expect(memoryLedger(id, 8192, 16).bytes).toBe(memoryLedger(id, 8192).bytes * 16) })
})
describe('MLA projection absorption', () => {
  const trace = buildAttentionTrace('mla')
  it('matches explicit K reconstruction for every query and causal entry', () => { for (const s of trace.steps) for (const h of s.heads) for (const e of h.entries) expect(absorbedScore(h.q.slice(0, 4), e.latent!, upMatrix(h.head), ropeKey(s.t), ropeKey(e.tokens[0]))).toBeCloseTo(e.score!, 12) })
  it('commutes the V up-projection with weighted latent accumulation', () => {
    for (const s of trace.steps) for (const h of s.heads) {
      const c = [0, 1].map(d => h.entries.reduce((sum, e) => sum + e.weight * latentOf(e.tokens[0])[d], 0))
      closeVector(h.output, matVec(upMatrix((h.head + 1) % HEADS), c))
    }
  })
  it('stores latent + position components once, separately from index keys', () => { expect(memoryLedger('mla', 8).elements).toBe(8 * 4 * 4); expect(memoryLedger('dsa', 8).parts.find(p => p.id === 'index')!.elements).toBe(8 * 2 * 4) })
})
describe('Window / sparse / compressed state', () => {
  it('appends without mutating prior KV entries', () => { const steps = buildAttentionTrace('mha').steps; expect(steps[4].heads[0].entries.slice(0, 4).map(e => e.key)).toEqual(steps[3].heads[0].entries.map(e => e.key)) })
  it('evicts exactly the positions beyond the window', () => { const s = buildAttentionTrace('swa').steps[7]; expect(s.storedTokens).toEqual([5, 6, 7]); expect(s.evictedTokens).toEqual([0, 1, 2, 3, 4]); expect(memoryLedger('swa', 8).bytes).toBe(memoryLedger('swa', 8192).bytes) })
  it('sparse DSA reads top-2 but retains the entire latent history and separate index', () => { const s = buildAttentionTrace('dsa').steps[7]; expect(s.mainEntriesRead).toBe(2); expect(s.indexCandidates).toBe(8); expect(s.storedTokens).toHaveLength(8); expect(s.memory.parts).toHaveLength(2) })
  it.each(['qsa', 'msa'] as const)('%s selects whole blocks and keeps incomplete tail', id => { const block = id === 'qsa' ? 4 : 2; for (const s of buildAttentionTrace(id).steps) { const es = s.heads[0].entries; for (let i = 0; i < Math.floor(es.length / block); i++) expect(new Set(es.slice(i * block, (i + 1) * block).map(e => e.selected)).size).toBe(1); es.slice(Math.floor(es.length / block) * block).forEach(e => expect(e.selected).toBe(true)) } })
  it.each(['csa', 'hca'] as const)('%s compresses without losing or duplicating the incomplete tail', id => { for (const s of buildAttentionTrace(id).steps) { const es = s.heads[0].entries; expect(es.flatMap(e => e.tokens)).toEqual(Array.from({ length: s.t + 1 }, (_, i) => i)); const kv = s.memory.parts.filter(p => p.id !== 'index').reduce((sum, p) => sum + p.elements, 0); expect(kv).toBe(es.length * 2 * 2 * 4 * 4) } })
  it('sequence compression still grows with length; it is not constant State', () => { expect(memoryLedger('hca', 8192).bytes).toBeGreaterThan(memoryLedger('hca', 8).bytes) })
})
describe('GDN / KDA state evolution', () => {
  it('matches a hand-calculated scalar delta update', () => { const out = stepGated([[1, 2], [3, 4]], [1, 0], [2, 3], .25, .5); expect(out).toEqual([[.875, 1], [1.875, 2]]) })
  it.each(['gdn', 'kda'] as const)('%s update equals decayed state plus its traced delta write', id => { const steps = buildAttentionTrace(id).steps; for (const s of steps) for (const h of s.heads) { expect(recurrenceIdentityError(h.recurrent!)).toBeLessThan(1e-12); closeVector(h.output, matVec(h.recurrent!.after, h.q)); if (s.t > 0) expect(h.recurrent!.before).toEqual(steps[s.t - 1].heads[h.head].recurrent!.after) } })
  it('distinguishes scalar and channel gates and keeps fixed storage', () => { const g = buildAttentionTrace('gdn'), k = buildAttentionTrace('kda'); expect(new Set(g.steps[4].heads[0].recurrent!.alpha).size).toBe(1); expect(new Set(k.steps[4].heads[0].recurrent!.alpha).size).toBe(4); expect(g.steps[7].heads[0].output).not.toEqual(k.steps[7].heads[0].output); expect(memoryLedger('kda', 8).bytes).toBe(memoryLedger('kda', 1048576).bytes) })
})
describe('Cross-layer sharing', () => {
  it('deduplicates global KV and index keys across decoder layers', () => { const one = memoryLedger('csa2', 8, 1, 1), four = memoryLedger('csa2', 8, 1, 4); for (const id of ['kv', 'index']) expect(four.parts.find(p => p.id === id)!.elements).toBe(one.parts.find(p => p.id === id)!.elements); expect(four.parts.find(p => p.id === 'topk')!.elements).toBe(4); expect(four.parts.find(p => p.id === 'window')!.elements).toBe(4 * one.parts.find(p => p.id === 'window')!.elements) })
  it('records static layer modes independently of temporal playback', () => { expect(buildAttentionTrace('csa2').steps.every(s => s.layerModes.join(',') === 'Full,Reindex,Reuse,Reuse')).toBe(true) })
  it('rejects invalid accounting inputs', () => { expect(() => memoryLedger('mla', 0)).toThrow(); expect(() => memoryLedger('mla', 4, 1.5)).toThrow() })
})
