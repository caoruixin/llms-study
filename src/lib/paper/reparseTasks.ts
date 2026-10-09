import type { ImportOutcome, IngestState, SerialQueue } from './ingest'
import type { IngestStage } from './types'

/**
 * 「重新解析」任务的模块级登记处（PLAN-pdf-inline-translation §4 / §6 的横幅）。
 *
 * 为什么不能只放在工作台组件里：重解析走全局导入队列，是 fire-and-forget 的异步任务，生命周期比挂载它的
 * 工作台长。此前状态与完成回调都绑在发起它的那次挂载上——解析中离开工作台再回来，新挂载的横幅回到「空闲」，
 * 再点一次就排了第二次解析（QA r1 / 审查 P1-2）；完成时也没人刷新新挂载的页面。
 * 这里按论文 id 登记：同一篇同时最多一个任务（重复发起直接返回 false），任何挂载随时订阅它的最新状态。
 */

export type ReparseTaskState =
  | { kind: 'idle' }
  | { kind: 'busy'; stage: IngestStage; waiting: boolean }
  /** 完成：一次性事件，交付给当时的订阅者后条目回到 idle */
  | { kind: 'done' }
  | { kind: 'error'; message: string }

type Listener = (s: ReparseTaskState) => void

interface Entry {
  state: ReparseTaskState
  listeners: Set<Listener>
}

/** 队列任务 id 前缀：与论文库导入 / 重试的 id 区分开 */
export const REPARSE_JOB_PREFIX = 'reparse:'

const IDLE: ReparseTaskState = { kind: 'idle' }
const entries = new Map<string, Entry>()

const entryOf = (paperId: string): Entry => {
  let e = entries.get(paperId)
  if (!e) {
    e = { state: IDLE, listeners: new Set() }
    entries.set(paperId, e)
  }
  return e
}

/** 空闲且没人订阅的条目不留在表里 */
const gc = (paperId: string, e: Entry): void => {
  if (e.state.kind === 'idle' && !e.listeners.size && entries.get(paperId) === e) entries.delete(paperId)
}

function emit(paperId: string, e: Entry, next: ReparseTaskState): void {
  e.state = next
  for (const fn of [...e.listeners]) fn(next)
  // 完成态只交付一次：订阅者（工作台）收到即刷新；没人订阅（用户已离开）就直接丢——下次打开会从库里读到新块
  if (next.kind === 'done') e.state = IDLE
  gc(paperId, e)
}

/** 当前状态（没有登记 = idle） */
export function reparseStateOf(paperId: string): ReparseTaskState {
  return entries.get(paperId)?.state ?? IDLE
}

/** 订阅某篇的任务状态（含之后新发起的任务）；返回退订函数 */
export function subscribeReparse(paperId: string, fn: Listener): () => void {
  const e = entryOf(paperId)
  e.listeners.add(fn)
  return () => {
    e.listeners.delete(fn)
    gc(paperId, e)
  }
}

/**
 * 发起重解析。`run` 收到 onState 回调，返回 reingestPaper 的结果；走 `queue`（全局导入队列）——
 * 列表页正在导入时只排队。返回 false = 这篇已有在途任务，本次没有重复排队。
 */
export function startReparse(
  paperId: string,
  queue: SerialQueue,
  run: (onState: (s: IngestState) => void) => Promise<ImportOutcome>,
): boolean {
  const e = entryOf(paperId)
  if (e.state.kind === 'busy') return false
  emit(paperId, e, { kind: 'busy', stage: 'queued', waiting: queue.size() > 0 })
  // 队列任务被取消时 enqueue 是 resolve 而不是 reject：只有真跑完才算完成，别报假的「已完成」
  let completed = false
  void queue
    .enqueue(`${REPARSE_JOB_PREFIX}${paperId}`, async () => {
      emit(paperId, e, { kind: 'busy', stage: 'queued', waiting: false })
      const outcome = await run((st) => {
        if (st.stage !== 'failed') emit(paperId, e, { kind: 'busy', stage: st.stage, waiting: false })
      })
      if (outcome.kind !== 'ready') {
        throw new Error(outcome.kind === 'failed' ? outcome.failure.message : '重新解析未完成')
      }
      completed = true
    })
    .then(() => emit(paperId, e, completed ? { kind: 'done' } : IDLE))
    .catch((err: unknown) => emit(paperId, e, { kind: 'error', message: err instanceof Error ? err.message : String(err) }))
  return true
}

/** 测试用：清空登记表 */
export function resetReparseTasksForTest(): void {
  entries.clear()
}
