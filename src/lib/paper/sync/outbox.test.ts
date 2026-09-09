import { afterEach, describe, expect, it } from 'vitest'
import type { OutboxItem } from '../repo/db'
import { SYNC_CHANNEL_NAME } from './crossTab'
import { SYNC_BATCH_MAX_CHANGES, chunkRows, outboxSignal, planOutbox, recordKey } from './outbox'

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

describe('outboxSignal 跨 tab（§1.1）', () => {
  const channels: BroadcastChannel[] = []
  const offs: (() => void)[] = []
  afterEach(() => {
    for (const c of channels.splice(0)) c.close()
    for (const off of offs.splice(0)) off()
  })
  const otherTab = (): BroadcastChannel => {
    const ch = new BroadcastChannel(SYNC_CHANNEL_NAME)
    ;(ch as { unref?: () => void }).unref?.()
    channels.push(ch)
    return ch
  }
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const waitFor = async (pred: () => boolean, timeoutMs = 1000): Promise<void> => {
    const start = Date.now()
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
      await sleep(5)
    }
  }

  it('远端 enqueued 消息 → 本地监听器收到合成项：op/paperId 照搬、createdAt 为当下、无 payload', async () => {
    const got: { dbName: string; item: OutboxItem }[] = []
    offs.push(outboxSignal.on((dbName, it) => got.push({ dbName, item: it })))
    const before = Date.now()
    otherTab().postMessage({ kind: 'enqueued', dbName: 'paper-copilot-u7', op: 'progress', paperId: 'pX' })
    await waitFor(() => got.length >= 1)

    expect(got[0].dbName).toBe('paper-copilot-u7')
    expect(got[0].item).toMatchObject({ op: 'progress', paperId: 'pX' })
    expect(got[0].item.payload).toBeUndefined()
    expect(got[0].item.qid).toBeUndefined()
    expect(got[0].item.createdAt).toBeGreaterThanOrEqual(before)
  })

  it('畸形/非 enqueued 消息不触发监听器', async () => {
    const got: OutboxItem[] = []
    offs.push(outboxSignal.on((_db, it) => got.push(it)))
    const tab = otherTab()
    tab.postMessage(null)
    tab.postMessage({ kind: 'enqueued', dbName: 'd' }) // 缺 op/paperId
    tab.postMessage({ kind: 'enqueued', dbName: 'd', op: 'bogus', paperId: 'p' })
    tab.postMessage({ kind: 'flushed', dbName: 'd' })
    tab.postMessage({ kind: 'pulled', dbName: 'd', paperIds: ['p'], tables: ['blocks'] })
    await sleep(30)
    expect(got).toEqual([])
  })

  it('本地 emit → 本地监听器带完整项；同时广播到其它 tab 的消息不带 payload', async () => {
    const local: OutboxItem[] = []
    offs.push(outboxSignal.on((_db, it) => local.push(it)))
    const remote: unknown[] = []
    otherTab().addEventListener('message', (ev) => remote.push((ev as MessageEvent).data))

    const full = item({ op: 'progress', paperId: 'pY', payload: { secret: 1 } })
    outboxSignal.emit('db-a', full)
    expect(local).toEqual([full])
    await waitFor(() => remote.length >= 1)
    expect(remote[0]).toEqual({ kind: 'enqueued', dbName: 'db-a', op: 'progress', paperId: 'pY' })
  })
})
