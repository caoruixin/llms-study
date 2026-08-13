import { describe, expect, it } from 'vitest'
import { foldMemo, KEEP_PAIRS_AFTER_FOLD, MAX_LIVE_TURN_PAIRS, memoDirective, shouldRequestMemo, trimHistoryPairs } from './summarizer'

describe('shouldRequestMemo', () => {
  it('≥6 轮才要求 memo 岛', () => {
    expect(shouldRequestMemo(5)).toBe(false)
    expect(shouldRequestMemo(6)).toBe(true)
    expect(shouldRequestMemo(9)).toBe(true)
  })
  it('指令文案要求 copilot:memo 尾岛且 ≤150 token', () => {
    expect(memoDirective()).toContain('copilot:memo')
    expect(memoDirective()).toContain('150 token')
  })
})

describe('foldMemo', () => {
  it('未要求：轮数 +1，摘要不变，保留上限 6 轮', () => {
    const r = foldMemo({ rollingSummary: '旧摘要', turnsSinceMemo: 3, requested: false, memo: null })
    expect(r).toEqual({ rollingSummary: '旧摘要', turnsSinceMemo: 4, keepPairs: MAX_LIVE_TURN_PAIRS, degraded: false })
  })

  it('收到合法 memo：替换 rolling summary、计数归零、裁旧轮', () => {
    const r = foldMemo({
      rollingSummary: '旧摘要',
      turnsSinceMemo: 6,
      requested: true,
      memo: { kind: 'memo', summary: '新摘要' },
    })
    expect(r).toEqual({ rollingSummary: '新摘要', turnsSinceMemo: 0, keepPairs: KEEP_PAIRS_AFTER_FOLD, degraded: false })
  })

  it('漏发/坏岛：本地降级——丢旧轮 + 占位说明，下轮再试（计数不归零）', () => {
    const r = foldMemo({ rollingSummary: '旧摘要', turnsSinceMemo: 6, requested: true, memo: null })
    expect(r.degraded).toBe(true)
    expect(r.turnsSinceMemo).toBe(7)
    expect(r.keepPairs).toBe(KEEP_PAIRS_AFTER_FOLD)
    expect(r.rollingSummary).toContain('旧摘要')
    expect(r.rollingSummary).toContain('未能自动摘要')
  })

  it('降级占位不重复追加', () => {
    const once = foldMemo({ rollingSummary: '旧', turnsSinceMemo: 6, requested: true, memo: null })
    const twice = foldMemo({ rollingSummary: once.rollingSummary, turnsSinceMemo: 7, requested: true, memo: null })
    const count = (twice.rollingSummary?.match(/未能自动摘要/g) ?? []).length
    expect(count).toBe(1)
  })

  it('无旧摘要时降级只有占位行', () => {
    const r = foldMemo({ rollingSummary: null, turnsSinceMemo: 6, requested: true, memo: null })
    expect(r.rollingSummary).toContain('未能自动摘要')
  })
})

describe('trimHistoryPairs', () => {
  it('超限时保最近 N 对', () => {
    const history = ['u1', 'a1', 'u2', 'a2', 'u3', 'a3']
    expect(trimHistoryPairs(history, 2)).toEqual(['u2', 'a2', 'u3', 'a3'])
    expect(trimHistoryPairs(history, 5)).toEqual(history)
  })
})
