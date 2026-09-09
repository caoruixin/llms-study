import type { OutboxOp } from '../repo/db'

/**
 * 跨 tab 同步信号（§1.1）：`BroadcastChannel('paper-sync')`。
 * 独立成模块是为了避免 repos → syncedRepos → outbox 与 syncEngine 之间的依赖环：
 * outbox（入队方）与 syncEngine（领导者）都只依赖这里，互不引用。
 *
 * - `enqueued`：某 tab 写了 outbox。**不带 payload**——领导者 tab 收到后只是 kick，
 *   推送时刻自己读库组装；无 payload 也意味着领导者的 progressCache 不会被别的 tab 污染
 *   （keepalive 兜底由原写入 tab 自己负责）；
 * - `flushed`：领导者推完一轮 → 其它 tab 重派 `paper-sync-flushed` 窗口事件刷徽标；
 * - `pulled`：某 tab 拉到远端变更 → 其它 tab 重派 `paper-sync-pulled`（译文/高亮失效通知）。
 *
 * BroadcastChannel 不回环投递给发送方自身，无需防抖；没有 BroadcastChannel 的环境
 * （旧浏览器）静默降级——引擎的空闲轮询（idlePollMs）是兜底。
 */

export const SYNC_CHANNEL_NAME = 'paper-sync'

export type SyncCrossTabMessage =
  | { kind: 'enqueued'; dbName: string; op: OutboxOp; paperId: string }
  | { kind: 'flushed'; dbName: string }
  | { kind: 'pulled'; dbName: string; paperIds: string[]; tables: string[] }

type SyncMessageListener = (msg: SyncCrossTabMessage) => void

const OUTBOX_OPS: ReadonlySet<string> = new Set<OutboxOp>(['progress', 'record', 'push-artifacts', 'delete-paper'])

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** 逐字段校验：频道是同源任意页面可写的，畸形消息一律丢弃而不是让监听器抛错 */
export function parseSyncMessage(data: unknown): SyncCrossTabMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const m = data as Record<string, unknown>
  if (typeof m.kind !== 'string' || typeof m.dbName !== 'string') return null
  switch (m.kind) {
    case 'enqueued':
      if (typeof m.op !== 'string' || !OUTBOX_OPS.has(m.op) || typeof m.paperId !== 'string') return null
      return { kind: 'enqueued', dbName: m.dbName, op: m.op as OutboxOp, paperId: m.paperId }
    case 'flushed':
      return { kind: 'flushed', dbName: m.dbName }
    case 'pulled':
      if (!isStringArray(m.paperIds) || !isStringArray(m.tables)) return null
      return { kind: 'pulled', dbName: m.dbName, paperIds: m.paperIds, tables: m.tables }
    default:
      return null
  }
}

const listeners = new Set<SyncMessageListener>()

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(SYNC_CHANNEL_NAME) : null
// node（vitest）下 channel 会挂住事件循环，unref 让进程正常退出；浏览器无此方法
;(channel as { unref?: () => void } | null)?.unref?.()
channel?.addEventListener('message', (ev) => {
  const msg = parseSyncMessage((ev as MessageEvent).data)
  if (!msg) return
  for (const fn of listeners) {
    try {
      fn(msg)
    } catch (e) {
      // 一个监听器抛错不能拖累其它监听器：跨 tab 信号只是「尽快」，丢一次无损正确性
      console.warn('[sync] 跨 tab 消息处理失败', e)
    }
  }
})

export function postSyncMessage(msg: SyncCrossTabMessage): void {
  try {
    channel?.postMessage(msg)
  } catch {
    /* 频道已关闭/序列化失败：信号丢失由空闲轮询兜底 */
  }
}

export function onSyncMessage(fn: SyncMessageListener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
