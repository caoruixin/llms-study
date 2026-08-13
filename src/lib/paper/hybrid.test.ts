import { describe, expect, it, vi } from 'vitest'
import { canRerank, hybridRetrieve, mergeRecall, type RerankFn, type ScoredId } from './hybrid'

const ids = (list: ScoredId[]) => list.map((r) => r.id)

const docs = [
  { id: 'a', text: 'alpha' },
  { id: 'b', text: 'beta' },
  { id: 'c', text: 'gamma' },
]

const bm25: ScoredId[] = [
  { id: 'a', score: 9 },
  { id: 'b', score: 4 },
  { id: 'c', score: 1 },
]

describe('mergeRecall', () => {
  it('只有 BM25 时保持原名次', () => {
    expect(ids(mergeRecall(bm25, undefined))).toEqual(['a', 'b', 'c'])
  })

  it('两路召回按 RRF 融合：两边都靠前的文档胜出', () => {
    const vector: ScoredId[] = [
      { id: 'b', score: 0.9 },
      { id: 'c', score: 0.8 },
      { id: 'a', score: 0.1 },
    ]
    // b 在两路分别排第 2 / 第 1，a 有一路垫底 → b 上位
    expect(ids(mergeRecall(bm25, vector))[0]).toBe('b')
  })

  it('权重可调：向量权重为 0 时退化成纯 BM25 顺序', () => {
    const vector: ScoredId[] = [{ id: 'c', score: 1 }]
    expect(ids(mergeRecall(bm25, vector, { vectorWeight: 0 }))).toEqual(['a', 'b', 'c'])
  })

  it('完全确定：同分先比最好名次，再比 id 字典序', () => {
    const l1: ScoredId[] = [{ id: 'z', score: 1 }]
    const l2: ScoredId[] = [{ id: 'y', score: 1 }]
    const once = mergeRecall(l1, l2)
    expect(ids(once)).toEqual(['y', 'z'])
    expect(mergeRecall(l1, l2)).toEqual(once)
  })

  it('topK 截断，空输入 → 空结果', () => {
    expect(mergeRecall(bm25, undefined, { topK: 2 })).toHaveLength(2)
    expect(mergeRecall([], undefined)).toEqual([])
  })
})

describe('canRerank', () => {
  it('默认关闭：Phase 2 不做任何远端调用', () => {
    expect(canRerank(undefined, true)).toEqual({ ok: false, reason: 'disabled' })
    expect(canRerank({}, true)).toEqual({ ok: false, reason: 'disabled' })
  })

  it('敏感论文即使已授权也只走本地', () => {
    expect(canRerank({ enabled: true, sensitive: true, consent: { provider: 'jina', granted: true } }, true)).toEqual({
      ok: false,
      reason: 'sensitive',
    })
  })

  it('未授权 / 授权被撤销 → 拒绝', () => {
    expect(canRerank({ enabled: true }, true)).toEqual({ ok: false, reason: 'no-consent' })
    expect(canRerank({ enabled: true, consent: { provider: 'jina', granted: false } }, true)).toEqual({
      ok: false,
      reason: 'no-consent',
    })
  })

  it('全部满足但没有注入实现 → 拒绝', () => {
    expect(canRerank({ enabled: true, consent: { provider: 'jina', granted: true } }, false)).toEqual({
      ok: false,
      reason: 'no-rerank-fn',
    })
  })

  it('三道闸门全过 → 允许', () => {
    expect(canRerank({ enabled: true, consent: { provider: 'jina', granted: true } }, true)).toEqual({ ok: true })
  })
})

describe('hybridRetrieve', () => {
  const granted = { enabled: true, consent: { provider: 'jina', granted: true } }

  it('默认（未开启）只返回合并结果，rerankFn 一次都不会被调用', async () => {
    const rerankFn = vi.fn<RerankFn>()
    const out = await hybridRetrieve({ query: 'q', bm25, docs }, { rerankFn, topN: 2 })
    expect(rerankFn).not.toHaveBeenCalled()
    expect(out).toMatchObject({ usedRerank: false, skipped: 'disabled' })
    expect(ids(out.results)).toEqual(['a', 'b'])
  })

  it('未授权时不外发任何 chunk', async () => {
    const rerankFn = vi.fn<RerankFn>()
    const out = await hybridRetrieve({ query: 'q', bm25, docs }, { rerankFn, gate: { enabled: true } })
    expect(rerankFn).not.toHaveBeenCalled()
    expect(out.skipped).toBe('no-consent')
  })

  it('敏感论文不外发', async () => {
    const rerankFn = vi.fn<RerankFn>()
    const out = await hybridRetrieve({ query: 'q', bm25, docs }, { rerankFn, gate: { ...granted, sensitive: true } })
    expect(rerankFn).not.toHaveBeenCalled()
    expect(out.skipped).toBe('sensitive')
  })

  it('授权后按注入的 rerankFn 重排，且只把 chunk 文本交出去', async () => {
    const rerankFn = vi.fn<RerankFn>(async ({ docs: sent }) => {
      expect(sent.map((d) => d.id)).toEqual(['a', 'b', 'c'])
      expect(Object.keys(sent[0])).toEqual(['id', 'text'])
      return [
        { id: 'c', score: 0.99 },
        { id: 'a', score: 0.4 },
      ]
    })
    const out = await hybridRetrieve({ query: 'q', bm25, docs }, { rerankFn, gate: granted, topN: 3 })
    expect(out.usedRerank).toBe(true)
    // 重排未提及的 b 按合并序补在后面，结果集不会凭空变短
    expect(ids(out.results)).toEqual(['c', 'a', 'b'])
  })

  it('重排返回未知 id 时忽略之，不污染结果', async () => {
    const rerankFn: RerankFn = async () => [
      { id: 'ghost', score: 9 },
      { id: 'b', score: 1 },
    ]
    const out = await hybridRetrieve({ query: 'q', bm25, docs }, { rerankFn, gate: granted, topN: 3 })
    expect(ids(out.results)).toEqual(['b', 'a', 'c'])
  })

  it('重排失败 → 无感降级回本地合并结果', async () => {
    const rerankFn: RerankFn = async () => {
      throw new Error('429 too many requests')
    }
    const out = await hybridRetrieve({ query: 'q', bm25, docs }, { rerankFn, gate: granted, topN: 2 })
    expect(out).toMatchObject({ usedRerank: false, skipped: 'rerank-failed' })
    expect(ids(out.results)).toEqual(['a', 'b'])
  })

  it('没有候选时直接返回空，不触发远端调用', async () => {
    const rerankFn = vi.fn<RerankFn>()
    const out = await hybridRetrieve({ query: 'q', bm25: [], docs: [] }, { rerankFn, gate: granted })
    expect(rerankFn).not.toHaveBeenCalled()
    expect(out).toMatchObject({ results: [], usedRerank: false, skipped: 'no-candidates' })
  })
})
