import { describe, expect, it } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { PaperDb } from './db'
import { createLearnerRepository, profileToRow, rowToProfile, type LearnerRepository } from './learnerRepo'
import {
  PAPER_LEVEL_CONCEPT,
  applyEvidenceToStore,
  emptyProfile,
  setPinnedLevel,
  summarizeProfile,
  type ProfileEvidence,
} from '../learnerProfile'

/** 每个用例一套全新的 IDBFactory + 唯一库名：测例之间零串扰 */
function freshRepo(): { db: PaperDb; repo: LearnerRepository } {
  const db = new PaperDb(`t-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange })
  return { db, repo: createLearnerRepository(db) }
}

const T0 = 1_700_000_000_000
const ev = (over: Partial<ProfileEvidence> = {}): ProfileEvidence => ({
  conceptIds: ['kv-cache'],
  dir: 1,
  weight: 0.6,
  ts: T0,
  source: 'quiz',
  ...over,
})

describe('learnerRepo · 行 ↔ 画像映射', () => {
  it('round-trip 保留掌握度、层级、pin 与证据窗口', () => {
    const profile = {
      ...emptyProfile('kv-cache', T0),
      mastery: 0.72,
      confidence: 0.4,
      level: '研究' as const,
      pinnedLevel: '进阶' as const,
      levelChangedAt: T0 - 10,
      evidence: [ev(), ev({ dir: -1, ts: T0 + 1, source: 'feedback' })],
    }
    const back = rowToProfile(profileToRow('p1', profile))
    expect(back).toMatchObject({
      conceptId: 'kv-cache',
      mastery: 0.72,
      level: '研究',
      pinnedLevel: '进阶',
      levelChangedAt: T0 - 10,
    })
    expect(back.evidence.map((e) => e.dir)).toEqual([1, -1])
    expect(back.evidence.map((e) => e.source)).toEqual(['quiz', 'feedback'])
  })
  it('主键按 (paperId, conceptId) 拼接：重复保存是幂等覆盖', () => {
    const a = profileToRow('p1', emptyProfile('c', T0))
    const b = profileToRow('p1', { ...emptyProfile('c', T0 + 5), mastery: 0.9 })
    expect(a.id).toBe(b.id)
  })
  it('缺 level/levelChangedAt 的旧行按 mastery 推断', () => {
    const p = rowToProfile({ id: 'x', paperId: 'p', conceptId: 'c', mastery: 0.2, confidence: 0, updatedAt: T0 })
    expect(p.level).toBe('入门')
    expect(p.levelChangedAt).toBe(T0)
    expect(p.evidence).toEqual([])
  })
  it('非法层级字符串被忽略', () => {
    const p = rowToProfile({
      id: 'x',
      paperId: 'p',
      conceptId: 'c',
      mastery: 0.5,
      confidence: 0,
      updatedAt: T0,
      level: '大师',
      pinnedLevel: '大师',
    })
    expect(p.level).toBe('进阶')
    expect(p.pinnedLevel).toBeUndefined()
  })
})

describe('learnerRepo · 持久化', () => {
  it('空库 load 也给出整体行（层级永远可读）', async () => {
    const { repo } = freshRepo()
    const rows = await repo.load('p1')
    expect(rows).toHaveLength(1)
    expect(rows[0].conceptId).toBe(PAPER_LEVEL_CONCEPT)
    expect(summarizeProfile(rows, T0)).toMatchObject({ level: '进阶', source: 'auto' })
  })

  it('save → load 往返一致，且按论文隔离', async () => {
    const { repo } = freshRepo()
    const store = applyEvidenceToStore([], ev(), T0)
    await repo.save('p1', store)
    const back = await repo.load('p1')
    expect(back.map((p) => p.conceptId).sort()).toEqual(['*', 'kv-cache'])
    expect(back.find((p) => p.conceptId === 'kv-cache')!.mastery).toBeCloseTo(
      store.find((p) => p.conceptId === 'kv-cache')!.mastery,
      6,
    )
    expect(await repo.load('p2')).toHaveLength(1) // 另一篇论文不受影响
  })

  it('重复 save 覆盖而不是追加', async () => {
    const { repo } = freshRepo()
    let store = applyEvidenceToStore([], ev(), T0)
    await repo.save('p1', store)
    store = applyEvidenceToStore(store, ev({ ts: T0 + 1 }), T0 + 1)
    await repo.save('p1', store)
    expect(await repo.load('p1')).toHaveLength(2)
  })

  it('pin 持久化后 summarize 仍为 manual', async () => {
    const { repo } = freshRepo()
    await repo.save('p1', setPinnedLevel([], '入门', T0))
    expect(summarizeProfile(await repo.load('p1'), T0)).toMatchObject({ level: '入门', source: 'manual' })
  })

  it('logEvidence 按概念展开成多行（含整体行）', async () => {
    const { repo } = freshRepo()
    await repo.logEvidence('p1', ev({ conceptIds: ['kv-cache', 'rope'] }))
    const rows = await repo.listEvidence('p1')
    expect(rows.map((r) => r.conceptId).sort()).toEqual(['*', 'kv-cache', 'rope'])
    expect(rows.every((r) => r.dir === 1 && r.source === 'quiz' && r.ts === T0)).toBe(true)
  })

  it('无概念的证据只记整体行；dir=0 也能落库', async () => {
    const { repo } = freshRepo()
    await repo.logEvidence('p1', ev({ conceptIds: [], dir: 0, source: 'feedback' }))
    const rows = await repo.listEvidence('p1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ conceptId: '*', dir: 0, source: 'feedback' })
  })

  it('reset 同时清 conceptStates 与 evidence，且不影响其他论文', async () => {
    const { repo } = freshRepo()
    await repo.save('p1', applyEvidenceToStore([], ev(), T0))
    await repo.logEvidence('p1', ev())
    await repo.save('p2', applyEvidenceToStore([], ev({ conceptIds: ['attn'] }), T0))
    await repo.logEvidence('p2', ev({ conceptIds: ['attn'] }))

    await repo.reset('p1')
    expect(await repo.listEvidence('p1')).toEqual([])
    expect(await repo.load('p1')).toHaveLength(1) // 只剩兜底整体行
    expect(await repo.listEvidence('p2')).toHaveLength(2)
    expect((await repo.load('p2')).map((p) => p.conceptId).sort()).toEqual(['*', 'attn'])
  })
})
