import { describe, expect, it } from 'vitest'
import type { OutboxItem } from '../repo/db'
import { SYNC_BATCH_MAX_CHANGES, chunkRows, planOutbox, recordKey } from './outbox'

let seq = 0
const item = (overrides: Partial<OutboxItem>): OutboxItem => ({
  qid: ++seq,
  op: 'record',
  paperId: 'p1',
  createdAt: 1000 + seq,
  ...overrides,
})

describe('recordKey', () => {
  it('progress 归一为 papers 行键：与 setSensitive 之类的 papers record 同键去重', () => {
    expect(recordKey(item({ op: 'progress', paperId: 'pX' }))).toBe('papers:pX')
    expect(recordKey(item({ op: 'record', tbl: 'papers', recordId: 'pX' }))).toBe('papers:pX')
    expect(recordKey(item({ op: 'record', tbl: 'messages', recordId: 'm1' }))).toBe('messages:m1')
  })
})

describe('planOutbox 合并规则', () => {
  it('progress 同 paperId 只留最新一条，旧的进 obsoleteQids', () => {
    const a = item({ op: 'progress', paperId: 'p1', payload: { v: 1 } })
    const b = item({ op: 'progress', paperId: 'p1', payload: { v: 2 } })
    const c = item({ op: 'progress', paperId: 'p2', payload: { v: 3 } })
    const plan = planOutbox([a, b, c])
    expect(plan.recordBatches).toHaveLength(1)
    expect(plan.recordBatches[0].map((i) => i.qid)).toEqual([b.qid, c.qid])
    expect(plan.obsoleteQids).toEqual([a.qid])
  })

  it('record 按 (tbl,id) 去重留最新；不同 id 互不影响', () => {
    const a = item({ tbl: 'messages', recordId: 'm1', payload: { v: 1 } })
    const b = item({ tbl: 'messages', recordId: 'm2', payload: { v: 2 } })
    const c = item({ tbl: 'messages', recordId: 'm1', payload: { v: 3 } })
    const plan = planOutbox([a, b, c])
    expect(plan.recordBatches[0].map((i) => i.qid)).toEqual([b.qid, c.qid])
    expect(plan.obsoleteQids).toEqual([a.qid])
  })

  it('delete-paper 赢一切：同论文更早的 progress/record/push-artifacts 全部作废', () => {
    const a = item({ op: 'progress', paperId: 'p1' })
    const b = item({ op: 'record', tbl: 'messages', recordId: 'm1', paperId: 'p1' })
    const c = item({ op: 'push-artifacts', paperId: 'p1' })
    const d = item({ op: 'delete-paper', paperId: 'p1' })
    const other = item({ op: 'record', tbl: 'messages', recordId: 'm9', paperId: 'p2' })
    const plan = planOutbox([a, b, c, d, other])
    expect(plan.deletes.map((i) => i.qid)).toEqual([d.qid])
    expect(plan.obsoleteQids.sort((x, y) => x - y)).toEqual([a.qid, b.qid, c.qid])
    expect(plan.recordBatches[0].map((i) => i.qid)).toEqual([other.qid])
    expect(plan.artifacts).toEqual([])
  })

  it('push-artifacts 每论文只留一条（序列幂等，推一次即可）', () => {
    const a = item({ op: 'push-artifacts', paperId: 'p1' })
    const b = item({ op: 'push-artifacts', paperId: 'p1' })
    const c = item({ op: 'push-artifacts', paperId: 'p2' })
    const plan = planOutbox([a, b, c])
    expect(plan.artifacts.map((i) => i.qid)).toEqual([b.qid, c.qid])
    expect(plan.obsoleteQids).toEqual([a.qid])
  })

  it('record 批量按 ≤50 条切批，保持入队顺序', () => {
    const items = Array.from({ length: SYNC_BATCH_MAX_CHANGES + 10 }, (_, i) =>
      item({ tbl: 'messages', recordId: `m${i}`, payload: { i } }),
    )
    const plan = planOutbox(items)
    expect(plan.recordBatches).toHaveLength(2)
    expect(plan.recordBatches[0]).toHaveLength(SYNC_BATCH_MAX_CHANGES)
    expect(plan.recordBatches[1]).toHaveLength(10)
    expect(plan.recordBatches[0][0].recordId).toBe('m0')
    expect(plan.recordBatches[1][9].recordId).toBe(`m${SYNC_BATCH_MAX_CHANGES + 9}`)
  })

  it('超大 payload 触发字节软上限切批', () => {
    const big = 'x'.repeat(4 * 1024 * 1024) // ×2 估算后单条即超 6MB 软上限
    const a = item({ tbl: 'briefs', recordId: 'b1', payload: { big } })
    const b = item({ tbl: 'briefs', recordId: 'b2', payload: { big } })
    const plan = planOutbox([a, b])
    expect(plan.recordBatches).toHaveLength(2)
  })

  it('空队列 → 空计划', () => {
    const plan = planOutbox([])
    expect(plan).toEqual({ deletes: [], recordBatches: [], artifacts: [], obsoleteQids: [] })
  })
})

describe('chunkRows', () => {
  it('按行数上限切批', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ i }))
    expect(chunkRows(rows, 3).map((c) => c.length)).toEqual([3, 3, 1])
  })

  it('按字节软上限切批（单行超限自成一批，不会死循环）', () => {
    const rows = [{ t: 'x'.repeat(100) }, { t: 'y'.repeat(100) }]
    expect(chunkRows(rows, 10, 150).map((c) => c.length)).toEqual([1, 1])
  })
})
