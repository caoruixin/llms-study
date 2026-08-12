import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_HALF_LIFE_MS,
  EVIDENCE_KEEP,
  LEVEL_BOUNDS,
  MAX_DELTA,
  PAPER_LEVEL_CONCEPT,
  applyEvidence,
  applyEvidenceToStore,
  computeConfidence,
  countIndependentEvidence,
  emptyProfile,
  evidenceFromFeedback,
  evidenceFromFlashcard,
  evidenceFromLearnerIsland,
  evidenceFromQuestion,
  evidenceFromQuiz,
  evidenceFromShortcut,
  evidenceFromVerdict,
  levelOfMastery,
  nextProfileHint,
  normalizeConceptId,
  setPinnedLevel,
  summarizeProfile,
  type ConceptProfile,
  type ProfileEvidence,
} from './learnerProfile'

const T0 = 1_700_000_000_000

const ev = (over: Partial<ProfileEvidence> = {}): ProfileEvidence => ({
  conceptIds: ['kv-cache'],
  dir: 1,
  weight: 1,
  ts: T0,
  source: 'quiz',
  ...over,
})

/** 造一个贴着桶边界的画像，便于测跨层规则 */
const nearBoundary = (mastery: number, over: Partial<ConceptProfile> = {}): ConceptProfile => ({
  ...emptyProfile('kv-cache', T0 - 1000),
  mastery,
  level: levelOfMastery(mastery),
  levelChangedAt: T0 - 1000,
  ...over,
})

describe('levelOfMastery / normalizeConceptId', () => {
  it('三桶边界（<0.34 入门，<0.67 进阶，其余研究）', () => {
    expect(levelOfMastery(0)).toBe('入门')
    expect(levelOfMastery(LEVEL_BOUNDS.entry - 0.001)).toBe('入门')
    expect(levelOfMastery(LEVEL_BOUNDS.entry)).toBe('进阶')
    expect(levelOfMastery(LEVEL_BOUNDS.advanced - 0.001)).toBe('进阶')
    expect(levelOfMastery(LEVEL_BOUNDS.advanced)).toBe('研究')
    expect(levelOfMastery(1)).toBe('研究')
  })
  it('概念 id 归一：小写、去空白、限长、空串 null', () => {
    expect(normalizeConceptId('  KV-Cache ')).toBe('kv-cache')
    expect(normalizeConceptId('   ')).toBeNull()
    expect(normalizeConceptId('x'.repeat(60))).toHaveLength(40)
  })
})

describe('applyEvidence · mastery 小步更新', () => {
  it('单事件 |Δ| ≤ 0.08，且按 weight 缩放', () => {
    const base = emptyProfile('kv-cache', T0)
    const strong = applyEvidence(base, ev({ weight: 1 }), T0)
    expect(strong.mastery).toBeCloseTo(0.5 + MAX_DELTA, 6)
    const weak = applyEvidence(base, ev({ weight: 0.25 }), T0)
    expect(weak.mastery).toBeCloseTo(0.5 + MAX_DELTA * 0.25, 6)
    const down = applyEvidence(base, ev({ dir: -1 }), T0)
    expect(down.mastery).toBeCloseTo(0.5 - MAX_DELTA, 6)
  })
  it('weight 越界被钳到 [0,1]，Δ 仍不超上限', () => {
    const p = applyEvidence(emptyProfile('c', T0), ev({ weight: 99 }), T0)
    expect(p.mastery - 0.5).toBeLessThanOrEqual(MAX_DELTA + 1e-9)
  })
  it('dir=0（刚好）不改 mastery，但计入证据', () => {
    const p = applyEvidence(emptyProfile('c', T0), ev({ dir: 0, weight: 0.5 }), T0)
    expect(p.mastery).toBe(0.5)
    expect(p.evidence).toHaveLength(1)
  })
  it('mastery 钳在 [0,1]', () => {
    let p = { ...emptyProfile('c', T0), mastery: 0.99 }
    for (let i = 0; i < 5; i++) p = applyEvidence(p, ev({ ts: T0 + i }), T0 + i)
    expect(p.mastery).toBe(1)
    let q = { ...emptyProfile('c', T0), mastery: 0.01 }
    for (let i = 0; i < 5; i++) q = applyEvidence(q, ev({ dir: -1, ts: T0 + i }), T0 + i)
    expect(q.mastery).toBe(0)
  })
  it('证据窗口最多保留 EVIDENCE_KEEP 条（最旧先出）', () => {
    let p = emptyProfile('c', T0)
    for (let i = 0; i < EVIDENCE_KEEP + 5; i++) p = applyEvidence(p, ev({ dir: 0, ts: T0 + i }), T0 + i)
    expect(p.evidence).toHaveLength(EVIDENCE_KEEP)
    expect(p.evidence[0].ts).toBe(T0 + 5)
  })
})

describe('applyEvidence · 跨层级需 ≥2 条独立同向证据（§6.2）', () => {
  it('单条强证据把 mastery 推进新桶，层级不动', () => {
    const p = applyEvidence(nearBoundary(0.66), ev({ ts: T0 }), T0)
    expect(p.mastery).toBeGreaterThanOrEqual(LEVEL_BOUNDS.advanced)
    expect(levelOfMastery(p.mastery)).toBe('研究')
    expect(p.level).toBe('进阶') // 只有一条证据 → 冻结
  })
  it('第二条独立同向证据到达后才跨层', () => {
    const first = applyEvidence(nearBoundary(0.66), ev({ ts: T0 }), T0)
    const second = applyEvidence(first, ev({ ts: T0 + 1000, source: 'feedback' }), T0 + 1000)
    expect(second.level).toBe('研究')
    expect(second.levelChangedAt).toBe(T0 + 1000)
  })
  it('同来源同时刻重复上报只算一条（独立性判定）', () => {
    const first = applyEvidence(nearBoundary(0.66), ev({ ts: T0 }), T0)
    const dup = applyEvidence(first, ev({ ts: T0 }), T0)
    expect(dup.level).toBe('进阶')
  })
  it('方向相反的两条不构成跨层证据', () => {
    const up = applyEvidence(nearBoundary(0.66), ev({ ts: T0 }), T0)
    const down = applyEvidence(up, ev({ dir: -1, ts: T0 + 1, source: 'feedback' }), T0 + 1)
    expect(down.level).toBe('进阶')
  })
  it('向下跨层同样需要 2 条', () => {
    const one = applyEvidence(nearBoundary(0.35), ev({ dir: -1, ts: T0 }), T0)
    expect(one.level).toBe('进阶')
    const two = applyEvidence(one, ev({ dir: -1, ts: T0 + 5, source: 'flashcard' }), T0 + 5)
    expect(two.level).toBe('入门')
  })
  it('层级变更后重新计数：变更前的旧证据不再复用', () => {
    const a = applyEvidence(nearBoundary(0.66), ev({ ts: T0 }), T0)
    const b = applyEvidence(a, ev({ ts: T0 + 1, source: 'feedback' }), T0 + 1)
    expect(b.level).toBe('研究')
    // 立刻给一条反向证据：mastery 掉回进阶桶，但只有 1 条独立证据 → 不回退
    const c = applyEvidence({ ...b, mastery: 0.68 }, ev({ dir: -1, ts: T0 + 2 }), T0 + 2)
    expect(levelOfMastery(c.mastery)).toBe('进阶')
    expect(c.level).toBe('研究')
  })
  it('countIndependentEvidence 只数 sinceTs 之后的同向记录', () => {
    const records: ProfileEvidence[] = [
      ev({ ts: T0 - 10, source: 'quiz' }),
      ev({ ts: T0 + 1, source: 'quiz' }),
      ev({ ts: T0 + 2, source: 'feedback' }),
      ev({ ts: T0 + 3, dir: -1, source: 'quiz' }),
    ]
    expect(countIndependentEvidence(records, 1, T0)).toBe(2)
    expect(countIndependentEvidence(records, -1, T0)).toBe(1)
  })
})

describe('pinnedLevel 冻结自动调层', () => {
  it('pin 后即便证据充分也不自动改层，但证据照记、mastery 照走', () => {
    const pinned: ConceptProfile = { ...nearBoundary(0.66), pinnedLevel: '入门' }
    const a = applyEvidence(pinned, ev({ ts: T0 }), T0)
    const b = applyEvidence(a, ev({ ts: T0 + 1, source: 'feedback' }), T0 + 1)
    expect(b.level).toBe('进阶') // 自动层级停在 pin 之前的值
    expect(b.mastery).toBeGreaterThan(0.66)
    expect(b.evidence).toHaveLength(2)
  })
  it('setPinnedLevel 写在整体行，取消后恢复自动', () => {
    const store = setPinnedLevel([], '研究', T0)
    expect(summarizeProfile(store, T0)).toMatchObject({ level: '研究', source: 'manual' })
    const cleared = setPinnedLevel(store, null, T0 + 1)
    expect(summarizeProfile(cleared, T0 + 1)).toMatchObject({ source: 'auto' })
  })
})

describe('computeConfidence · 一致性 × 数量饱和 × 时间衰减', () => {
  it('同向证据越多置信度越高', () => {
    const one = computeConfidence([ev({ ts: T0 })], T0)
    const three = computeConfidence([ev({ ts: T0 }), ev({ ts: T0 + 1 }), ev({ ts: T0 + 2 })], T0)
    expect(three).toBeGreaterThan(one)
  })
  it('方向冲突拉低一致性', () => {
    const consistent = computeConfidence([ev({ ts: T0 }), ev({ ts: T0 + 1 })], T0)
    const conflicting = computeConfidence([ev({ ts: T0 }), ev({ dir: -1, ts: T0 + 1 })], T0)
    expect(conflicting).toBeLessThan(consistent)
  })
  it('时间衰减：同一批证据放久了置信度下降', () => {
    const fresh = computeConfidence([ev({ ts: T0 }), ev({ ts: T0 + 1 })], T0 + 2)
    const stale = computeConfidence([ev({ ts: T0 }), ev({ ts: T0 + 1 })], T0 + 3 * EVIDENCE_HALF_LIFE_MS)
    expect(stale).toBeLessThan(fresh)
    expect(stale).toBeGreaterThanOrEqual(0)
  })
  it('空证据 → 0', () => {
    expect(computeConfidence([], T0)).toBe(0)
  })
})

describe('applyEvidenceToStore / summarizeProfile', () => {
  it('同时更新命中概念与整体行 \'*\'', () => {
    const store = applyEvidenceToStore([], ev({ conceptIds: ['KV-Cache'] }), T0)
    expect(store.map((p) => p.conceptId).sort()).toEqual(['*', 'kv-cache'])
    expect(store.every((p) => p.mastery > 0.5)).toBe(true)
  })
  it('无概念的证据只影响整体行', () => {
    const store = applyEvidenceToStore([], ev({ conceptIds: [] }), T0)
    expect(store).toHaveLength(1)
    expect(store[0].conceptId).toBe(PAPER_LEVEL_CONCEPT)
  })
  it('薄弱概念按 mastery 升序取前 3', () => {
    let store: ConceptProfile[] = []
    const ids = ['a', 'b', 'c', 'd']
    ids.forEach((id, i) => {
      for (let k = 0; k <= i; k++) {
        store = applyEvidenceToStore(store, ev({ conceptIds: [id], dir: -1, ts: T0 + i * 10 + k }), T0 + i * 10 + k)
      }
    })
    const summary = summarizeProfile(store, T0 + 100)
    expect(summary.weakConcepts).toEqual(['d', 'c', 'b'])
    expect(summary.conceptCount).toBe(4)
  })
})

describe('nextProfileHint（字节稳定）', () => {
  it('层级桶不变时原样复用上一版文案（同一对象引用）', () => {
    const s1 = summarizeProfile(applyEvidenceToStore([], ev({ dir: 0 }), T0), T0)
    const h1 = nextProfileHint(null, s1)
    const h2 = nextProfileHint(h1, s1)
    expect(h2).toBe(h1)
  })
  it('层级或来源变化时才重算', () => {
    const auto = summarizeProfile([], T0)
    const h1 = nextProfileHint(null, auto)
    const manual = summarizeProfile(setPinnedLevel([], '研究', T0), T0)
    const h2 = nextProfileHint(h1, manual)
    expect(h2).not.toBe(h1)
    expect(h2.text).toContain('研究')
    expect(h2.text).toContain('用户手动指定')
  })
  it('文案含层级与讲解口径', () => {
    expect(nextProfileHint(null, summarizeProfile([], T0)).text).toContain('讲解层次：进阶')
  })
})

describe('证据构造器（L1/L2 映射表）', () => {
  it('quiz：对 +1 / 部分 0 / 错 -1', () => {
    expect(evidenceFromQuiz('correct', ['c'], T0).dir).toBe(1)
    expect(evidenceFromQuiz('partial', ['c'], T0).dir).toBe(0)
    expect(evidenceFromQuiz('wrong', ['c'], T0).dir).toBe(-1)
  })
  it('flashcard：认识 +1 / 模糊 0 / 不认识 -1，模糊权重更低', () => {
    expect(evidenceFromFlashcard('known', [], T0).dir).toBe(1)
    expect(evidenceFromFlashcard('unknown', [], T0).dir).toBe(-1)
    const fuzzy = evidenceFromFlashcard('fuzzy', [], T0)
    expect(fuzzy.dir).toBe(0)
    expect(fuzzy.weight).toBeLessThan(evidenceFromFlashcard('known', [], T0).weight)
  })
  it('显式反馈：太浅 +1 / 刚好 0 / 太深 -1', () => {
    expect(evidenceFromFeedback('shallow', [], T0).dir).toBe(1)
    expect(evidenceFromFeedback('right', [], T0).dir).toBe(0)
    expect(evidenceFromFeedback('deep', [], T0).dir).toBe(-1)
  })
  it('快捷键：更简单 -1 / 推导 +1 / 其他无信号', () => {
    expect(evidenceFromShortcut('simpler', [], T0)?.dir).toBe(-1)
    expect(evidenceFromShortcut('derive', [], T0)?.dir).toBe(1)
    expect(evidenceFromShortcut('explain', [], T0)).toBeNull()
    expect(evidenceFromShortcut('example', [], T0)).toBeNull()
  })
  it('verdict：ok +1 / partial 0 / miss -1；缺 verdict 时按 missed 条数推断', () => {
    expect(evidenceFromVerdict({ kind: 'verdict', verdict: 'ok', missed: [], evidence: [] }, [], T0).dir).toBe(1)
    expect(evidenceFromVerdict({ kind: 'verdict', missed: [], evidence: ['x'] }, [], T0).dir).toBe(1)
    expect(evidenceFromVerdict({ kind: 'verdict', missed: ['a'], evidence: [] }, [], T0).dir).toBe(0)
    expect(evidenceFromVerdict({ kind: 'verdict', missed: ['a', 'b'], evidence: [] }, [], T0).dir).toBe(-1)
  })
  it('verdict 岛自带 concept 时并入概念表', () => {
    const e = evidenceFromVerdict({ kind: 'verdict', concept: 'RoPE', missed: [], evidence: [] }, ['attn'], T0)
    expect(e.conceptIds).toEqual(['rope', 'attn'])
  })
  it('learner 岛 → 每信号一条弱证据；空概念剔除', () => {
    const list = evidenceFromLearnerIsland(
      { kind: 'learner', signals: [{ concept: 'kv-cache', dir: 1 }, { concept: '  ', dir: -1 }] },
      T0,
    )
    expect(list).toHaveLength(1)
    expect(list[0].source).toBe('learner-island')
    expect(list[0].weight).toBeLessThanOrEqual(0.25)
  })
  it('抽象度启发式：公式/符号 +1，通俗诉求 -1，两者都命中或都不命中 → null', () => {
    expect(evidenceFromQuestion('请推导这个公式的上界', [], T0)?.dir).toBe(1)
    expect(evidenceFromQuestion('能不能用大白话讲讲', [], T0)?.dir).toBe(-1)
    expect(evidenceFromQuestion('这篇论文讲了什么', [], T0)).toBeNull()
    expect(evidenceFromQuestion('用通俗方式讲讲这个公式', [], T0)).toBeNull()
  })
})
