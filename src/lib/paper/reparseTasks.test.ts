import { afterEach, describe, expect, it } from 'vitest'
import { createSerialQueue, type ImportOutcome, type IngestState } from './ingest'
import { reparseStateOf, resetReparseTasksForTest, startReparse, subscribeReparse, type ReparseTaskState } from './reparseTasks'
import type { PaperRecord } from './types'

const flush = () => new Promise<void>((r) => setTimeout(r, 0))
const READY = { kind: 'ready', paper: {} as PaperRecord } as ImportOutcome
const st = (stage: IngestState['stage']): IngestState => ({ stage, attempts: 0 }) as IngestState

/** 手动放行的 run：返回 [run, release(outcome)] */
function gated() {
  let release!: (o: ImportOutcome) => void
  const calls: number[] = []
  const run = (onState: (s: IngestState) => void) => {
    calls.push(1)
    onState(st('parsing'))
    return new Promise<ImportOutcome>((r) => (release = r))
  }
  return { run, release: (o: ImportOutcome) => release(o), calls }
}

afterEach(() => resetReparseTasksForTest())

describe('reparseTasks', () => {
  it('同一篇在途时重复发起不再排队；离开（退订）再回来（重新订阅）看得到进行中的阶段', async () => {
    const q = createSerialQueue()
    const g = gated()
    expect(startReparse('p1', q, g.run)).toBe(true)
    await flush()
    expect(reparseStateOf('p1')).toEqual({ kind: 'busy', stage: 'parsing', waiting: false })
    // 第一次挂载退订（离开工作台）
    const seenA: ReparseTaskState[] = []
    const offA = subscribeReparse('p1', (s) => seenA.push(s))
    offA()
    // 回来：状态仍是进行中，再点一次不会排第二个任务
    expect(reparseStateOf('p1').kind).toBe('busy')
    expect(startReparse('p1', q, g.run)).toBe(false)
    expect(q.size()).toBe(1)
    const seenB: ReparseTaskState[] = []
    subscribeReparse('p1', (s) => seenB.push(s))
    g.release(READY)
    await flush()
    await flush()
    expect(g.calls).toHaveLength(1)
    expect(seenB.map((s) => s.kind)).toEqual(['done'])
    expect(seenA).toEqual([])
    // 完成是一次性事件：之后回到 idle，可以再发起
    expect(reparseStateOf('p1')).toEqual({ kind: 'idle' })
  })

  it('失败：订阅者收到 error（带消息），状态保留到下次发起；重试可再次排队', async () => {
    const q = createSerialQueue()
    const g = gated()
    const seen: ReparseTaskState[] = []
    subscribeReparse('p2', (s) => seen.push(s))
    startReparse('p2', q, g.run)
    await flush()
    g.release({ kind: 'failed', failure: { kind: 'corrupt', message: '坏了', at: 1 } } as ImportOutcome)
    await flush()
    await flush()
    expect(seen[seen.length - 1]).toEqual({ kind: 'error', message: '坏了' })
    expect(reparseStateOf('p2')).toEqual({ kind: 'error', message: '坏了' })
    const g2 = gated()
    expect(startReparse('p2', q, g2.run)).toBe(true)
    await flush()
    expect(reparseStateOf('p2').kind).toBe('busy')
  })

  it('队列里已有别的任务：先报 waiting，轮到自己时转为进行中', async () => {
    const q = createSerialQueue()
    let releaseOther!: () => void
    void q.enqueue('import-x', () => new Promise<void>((r) => (releaseOther = r)))
    const g = gated()
    startReparse('p3', q, g.run)
    expect(reparseStateOf('p3')).toEqual({ kind: 'busy', stage: 'queued', waiting: true })
    releaseOther()
    await flush()
    await flush()
    expect(reparseStateOf('p3')).toEqual({ kind: 'busy', stage: 'parsing', waiting: false })
  })

  it('任务在队列里被取消：回到 idle，不报完成', async () => {
    const q = createSerialQueue()
    let releaseOther!: () => void
    void q.enqueue('import-y', () => new Promise<void>((r) => (releaseOther = r)))
    const g = gated()
    const seen: ReparseTaskState[] = []
    subscribeReparse('p4', (s) => seen.push(s))
    startReparse('p4', q, g.run)
    q.cancel('reparse:p4')
    await flush()
    expect(seen.map((s) => s.kind)).toEqual(['busy', 'idle'])
    expect(g.calls).toHaveLength(0)
    releaseOther()
  })
})
