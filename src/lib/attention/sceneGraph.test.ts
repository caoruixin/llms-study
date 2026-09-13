import { describe, expect, it } from 'vitest'
import { MECHANISMS } from '../../data/architectureTerms'
import { PHASES, TOKENS, buildAttentionTrace, isLatent, isRecurrent } from './engine'
import { buildSceneFrame } from './sceneGraph'

describe.each(MECHANISMS)('%s semantic rendering contract', id => {
  const trace = buildAttentionTrace(id)
  it('every visible path resolves to actual nodes for all tokens and phases', () => {
    for (let f = 0; f < TOKENS.length * PHASES; f++) {
      const g = buildSceneFrame(trace, f), nodes = new Map(g.nodes.map(n => [n.id, n]))
      expect(nodes.size).toBe(g.nodes.length); expect(new Set(g.edges.map(e => e.id)).size).toBe(g.edges.length)
      for (const e of g.edges) { expect(nodes.has(e.from), e.from).toBe(true); expect(nodes.has(e.to), e.to).toBe(true); expect(e.tokens?.every(t => t <= g.t) ?? true).toBe(true); expect(e.segment[0]).toBeLessThan(e.segment[1]) }
      g.nodes.filter(n => !n.available).forEach(n => expect(n.values).toBeUndefined())
    }
  })
  it('all Heads participate in projection, core computation and final output; none disappear', () => {
    if (id === 'csa2') return
    for (const stage of [0, 3, 4, 5]) {
      const g = buildSceneFrame(trace, 7 * PHASES + stage)
      expect([...new Set(g.edges.flatMap(e => e.head === undefined ? [] : [e.head]))].sort()).toEqual([0, 1, 2, 3])
      expect(g.nodes.filter(n => /^head-\d$/.test(n.id))).toHaveLength(4)
    }
    const output = buildSceneFrame(trace, 7 * PHASES + 5)
    const merges = output.edges.filter(e => e.to === 'concat'); expect(merges.map(e => e.from)).toEqual(['head-output:0', 'head-output:1', 'head-output:2', 'head-output:3'])
    expect(output.edges.some(e => e.from === 'concat' && e.to === 'projection')).toBe(true); expect(output.edges.some(e => e.from === 'projection' && e.to === 'output')).toBe(true)
  })
  it('never shows future values or premature Head/Attention Output', () => {
    if (id === 'csa2') return
    for (let stage = 0; stage < PHASES; stage++) {
      const g = buildSceneFrame(trace, 6 * PHASES + stage)
      expect(g.nodes.find(n => n.id === 'output')!.available).toBe(stage === 5)
      g.nodes.filter(n => n.id.startsWith('head-output:')).forEach(n => expect(n.available).toBe(stage >= (isRecurrent(id) ? 5 : 4)))
      if (stage < 5) expect(g.edges.some(e => e.to === 'output' || e.to === 'concat')).toBe(false)
    }
  })
  it('cache reads exactly match each Head selection, not the focused H0 entries', () => {
    if (id === 'csa2' || isRecurrent(id)) return
    const s = trace.steps[7]
    for (const stage of [3, 4]) {
      const g = buildSceneFrame(trace, 7 * PHASES + stage)
      for (const h of s.heads) {
        const expected = h.entries.filter(e => e.selected).map(e => e.storageId).sort()
        const reads = g.edges.filter(e => e.head === h.head && s.storage.some(o => o.id === e.from)).map(e => e.from).sort()
        expect(reads).toEqual(expected)
        g.edges.filter(e => e.head === h.head && s.storage.some(o => o.id === e.from)).forEach(e => { const entry = h.entries.find(x => x.storageId === e.from)!; expect(e.weight).toBe(entry.weight) })
      }
    }
  })
  it('replaying a frame reproduces the identical nodes, values and paths', () => { expect(buildSceneFrame(trace, 39)).toEqual(buildSceneFrame(buildAttentionTrace(id), 39)) })
})
describe('Mechanism-specific diagrams', () => {
  it('MLA renders one latent cache and separate per-Head accumulation', () => {
    const trace = buildAttentionTrace('mla'), g = buildSceneFrame(trace, 46)
    expect(g.nodes.filter(n => n.id.startsWith('latent:t'))).toHaveLength(8)
    expect(g.nodes.filter(n => n.id.startsWith('latent-agg:h'))).toHaveLength(4)
    for (let h = 0; h < 4; h++) expect(g.edges.some(e => e.from === `latent-agg:h${h}` && e.to === `head-output:${h}`)).toBe(true)
    expect(isLatent('csa2')).toBe(false)
  })
  it('DSA / QSA visually distinguish Indexer Heads from Main Heads', () => {
    for (const [id, count] of [['dsa', 2], ['qsa', 4]] as const) {
      const g = buildSceneFrame(buildAttentionTrace(id), 44)
      expect(g.nodes.filter(n => n.id.startsWith('index:shared:q'))).toHaveLength(count)
      expect(g.edges.filter(e => e.from === 'index:shared' && e.to.startsWith('head-'))).toHaveLength(4)
    }
  })
  it('GDN and KDA only read with Q after completing the update', () => {
    for (const id of ['gdn', 'kda'] as const) for (let stage = 0; stage < 6; stage++) {
      const g = buildSceneFrame(buildAttentionTrace(id), 6 * PHASES + stage)
      const queryReads = g.edges.filter(e => e.operation === 'S q'); expect(queryReads).toHaveLength(stage === 5 ? 4 : 0)
      for (const h of [0, 1, 2, 3]) { const expected = buildAttentionTrace(id).steps[6].heads[h].recurrent!; expect(g.nodes.find(n => n.id === `state:h${h}`)!.values).toEqual(stage < 2 ? expected.before : stage < 4 ? expected.decayed : expected.after) }
    }
  })
  it('SWA exposes eviction separately from surviving current reads', () => {
    const trace = buildAttentionTrace('swa'), update = buildSceneFrame(trace, 43), score = buildSceneFrame(trace, 45)
    expect(update.nodes.some(n => n.id === 'eviction')).toBe(true)
    expect(update.edges.filter(e => e.to === 'eviction')).toHaveLength(2)
    expect(score.edges.filter(e => e.operation === 'Key score').every(e => e.tokens?.every(t => t >= 5))).toBe(true)
  })
  it('CSA2 Reuse references the preceding index producer without re-indexing', () => {
    const trace = buildAttentionTrace('csa2'), route = buildSceneFrame(trace, 44)
    expect(route.nodes.filter(n => n.id.endsWith(':indexQ'))).toHaveLength(2)
    expect(route.edges.filter(e => e.operation === 'Reuse existing index object').map(e => e.from)).toEqual(['topk-1', 'topk-1'])
    expect(route.nodes.some(n => n.id === 'candidate')).toBe(true)
    expect(route.nodes.every(n => n.values === undefined)).toBe(true)
  })
})
