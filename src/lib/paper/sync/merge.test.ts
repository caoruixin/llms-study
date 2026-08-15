import { describe, expect, it } from 'vitest'
import type { PaperRecord, ReadingProgress } from '../types'
import { mergePaperRecord, mergeProgress, rowTimestamp, shouldApplyRemote } from './merge'

const progress = (overrides: Partial<ReadingProgress>): ReadingProgress => ({
  blockIndex: 0,
  ratio: 0,
  updatedAt: 1000,
  ...overrides,
})

const paper = (overrides: Partial<PaperRecord>): PaperRecord => ({
  id: 'p1',
  title: '论文',
  fileName: 'a.pdf',
  format: 'pdf',
  mime: 'application/pdf',
  byteSize: 10,
  sha256: 'sha',
  status: 'ready',
  parserVersion: 1,
  sensitive: false,
  createdAt: 100,
  updatedAt: 1000,
  progress: progress({}),
  ...overrides,
})

describe('shouldApplyRemote', () => {
  it('本地有 pending 写入 → 本地胜（无论时间戳）', () => {
    expect(shouldApplyRemote({ hasPendingLocal: true, localUpdatedAt: 1, remoteUpdatedAt: 999 })).toBe(false)
  })

  it('LWW：远端较新或等新 → 应用；远端较旧 → 保本地', () => {
    expect(shouldApplyRemote({ hasPendingLocal: false, localUpdatedAt: 100, remoteUpdatedAt: 200 })).toBe(true)
    expect(shouldApplyRemote({ hasPendingLocal: false, localUpdatedAt: 200, remoteUpdatedAt: 200 })).toBe(true)
    expect(shouldApplyRemote({ hasPendingLocal: false, localUpdatedAt: 300, remoteUpdatedAt: 200 })).toBe(false)
  })

  it('时间戳缺失按 0：双端都缺时应用远端（append-only 行幂等覆盖）', () => {
    expect(shouldApplyRemote({ hasPendingLocal: false, localUpdatedAt: undefined, remoteUpdatedAt: undefined })).toBe(true)
    expect(shouldApplyRemote({ hasPendingLocal: false, localUpdatedAt: 5, remoteUpdatedAt: undefined })).toBe(false)
  })
})

describe('rowTimestamp', () => {
  it('updatedAt > createdAt > ts 依序取用；非对象/无时间戳 → undefined', () => {
    expect(rowTimestamp({ updatedAt: 3, createdAt: 2, ts: 1 })).toBe(3)
    expect(rowTimestamp({ createdAt: 2, ts: 1 })).toBe(2)
    expect(rowTimestamp({ ts: 1 })).toBe(1)
    expect(rowTimestamp({ other: 9 })).toBeUndefined()
    expect(rowTimestamp(null)).toBeUndefined()
    expect(rowTimestamp('x')).toBeUndefined()
  })
})

describe('mergeProgress', () => {
  it('maxBlockIndex 双端取 max（缺省回退到 blockIndex），ratio 取 max，其余跟胜者', () => {
    const winner = progress({ blockIndex: 10, maxBlockIndex: 12, ratio: 0.3, page: 2, updatedAt: 2000 })
    const loser = progress({ blockIndex: 50, maxBlockIndex: 60, ratio: 0.9, page: 9, updatedAt: 1000 })
    const merged = mergeProgress(winner, loser)!
    expect(merged.blockIndex).toBe(10) // 当前位置跟胜者
    expect(merged.page).toBe(2)
    expect(merged.maxBlockIndex).toBe(60) // 阅读深度不回退
    expect(merged.ratio).toBe(0.9)
  })

  it('一侧缺失 → 返回另一侧', () => {
    const only = progress({ blockIndex: 3 })
    expect(mergeProgress(only, undefined)).toBe(only)
    expect(mergeProgress(undefined, only)).toBe(only)
    expect(mergeProgress(undefined, undefined)).toBeUndefined()
  })
})

describe('mergePaperRecord', () => {
  it('整行 LWW：远端等新或更新 → 远端为底（趋同服务端）', () => {
    const local = paper({ title: '本地', updatedAt: 1000 })
    const remote = paper({ title: '远端', updatedAt: 1000 })
    expect(mergePaperRecord(local, remote).title).toBe('远端')
    expect(mergePaperRecord(paper({ title: '本地', updatedAt: 2000 }), remote).title).toBe('本地')
  })

  it('无本地行 → 直接采用远端', () => {
    const remote = paper({ title: '远端' })
    expect(mergePaperRecord(undefined, remote)).toBe(remote)
  })

  it('progress 特例：本地读得更深时即使远端整行胜，maxBlockIndex/ratio 也不回退', () => {
    const local = paper({
      updatedAt: 1000,
      lastReadAt: 5000,
      progress: progress({ blockIndex: 80, maxBlockIndex: 90, ratio: 0.9, updatedAt: 1000 }),
    })
    const remote = paper({
      updatedAt: 2000,
      lastReadAt: 2000,
      progress: progress({ blockIndex: 10, maxBlockIndex: 15, ratio: 0.15, updatedAt: 2000 }),
    })
    const merged = mergePaperRecord(local, remote)
    expect(merged.updatedAt).toBe(2000) // 远端整行胜
    expect(merged.progress.blockIndex).toBe(10) // 当前位置跟胜者
    expect(merged.progress.maxBlockIndex).toBe(90) // 深度不回退
    expect(merged.progress.ratio).toBe(0.9)
    expect(merged.lastReadAt).toBe(5000) // 最近阅读时间取 max
  })
})
