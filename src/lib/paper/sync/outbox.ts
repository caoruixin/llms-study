import type { OutboxItem } from '../repo/db'

/**
 * outbox 合并规划（纯函数）：把队列压缩成最小推送计划。
 * 为什么在读取时合并而不是入队时合并：入队路径要快且无竞态（多处写者），
 * 读取合并只有引擎单写者（Web Lock 领导者），规则集中一处、可单测。
 */

/** 单次 push 攒批上限：远小于服务端 500 上限，失败重试的浪费窗口更小 */
export const SYNC_BATCH_MAX_CHANGES = 50
/** 单批字节软上限：留足余量给服务端 8MB 硬限（JSON 序列化误差 + 请求头） */
export const SYNC_BATCH_MAX_BYTES = 6 * 1024 * 1024
/** push-artifacts 里 blocks 的每批行数上限（≤500 硬限，300 兼顾单事务时长） */
export const ARTIFACT_BLOCKS_PER_BATCH = 300

export interface OutboxPlan {
  /** 论文删除：先执行——同论文的其它队列项全部作废（服务端墓碑会拒绝它们） */
  deletes: OutboxItem[]
  /** record/progress 项合并后的推送批次（每批 ≤SYNC_BATCH_MAX_CHANGES 条 / ≤软字节上限） */
  recordBatches: OutboxItem[][]
  /** 制品推送序列（papers 行 → 文件 → blocks 分批），每论文最多一项 */
  artifacts: OutboxItem[]
  /** 被合并掉的队列项 qid：无需推送，直接从队列删除 */
  obsoleteQids: number[]
}

/** record 项的去重键：progress 本质是 papers 行的整行覆盖，归一到同一键参与去重 */
export function recordKey(item: OutboxItem): string {
  if (item.op === 'progress') return `papers:${item.paperId}`
  return `${item.tbl ?? '?'}:${item.recordId ?? '?'}`
}

/**
 * 合并规则：
 * 1. delete-paper 赢一切：该论文更早入队的 progress/record/push-artifacts 全部作废；
 * 2. record/progress 按 recordKey 去重，只留 qid 最大（最新）的一条——整行覆盖语义下旧版本毫无价值；
 * 3. push-artifacts 每论文只留一条（序列本身幂等，推一次即可）；
 * 4. 幸存的 record 项按入队顺序切批。
 */
export function planOutbox(items: readonly OutboxItem[]): OutboxPlan {
  const obsoleteQids: number[] = []
  const deletedPapers = new Map<string, OutboxItem>()
  for (const it of items) {
    if (it.op === 'delete-paper') {
      const prev = deletedPapers.get(it.paperId)
      if (prev?.qid !== undefined) obsoleteQids.push(prev.qid)
      deletedPapers.set(it.paperId, it)
    }
  }

  const latestRecords = new Map<string, OutboxItem>()
  const artifactByPaper = new Map<string, OutboxItem>()
  for (const it of items) {
    if (it.op === 'delete-paper') continue
    if (deletedPapers.has(it.paperId)) {
      if (it.qid !== undefined) obsoleteQids.push(it.qid)
      continue
    }
    if (it.op === 'push-artifacts') {
      const prev = artifactByPaper.get(it.paperId)
      if (prev?.qid !== undefined) obsoleteQids.push(prev.qid)
      artifactByPaper.set(it.paperId, it)
      continue
    }
    const key = recordKey(it)
    const prev = latestRecords.get(key)
    if (prev?.qid !== undefined) obsoleteQids.push(prev.qid)
    latestRecords.set(key, it)
  }

  // 幸存 record 按 qid 排序切批：跨论文混批没问题（服务端逐条应用），保持时间序即可
  const survivors = [...latestRecords.values()].sort((a, b) => (a.qid ?? 0) - (b.qid ?? 0))
  const recordBatches: OutboxItem[][] = []
  let batch: OutboxItem[] = []
  let batchBytes = 0
  for (const it of survivors) {
    const bytes = payloadBytes(it)
    if (batch.length >= SYNC_BATCH_MAX_CHANGES || (batch.length > 0 && batchBytes + bytes > SYNC_BATCH_MAX_BYTES)) {
      recordBatches.push(batch)
      batch = []
      batchBytes = 0
    }
    batch.push(it)
    batchBytes += bytes
  }
  if (batch.length) recordBatches.push(batch)

  return {
    deletes: [...deletedPapers.values()],
    recordBatches,
    artifacts: [...artifactByPaper.values()].sort((a, b) => (a.qid ?? 0) - (b.qid ?? 0)),
    obsoleteQids,
  }
}

function payloadBytes(item: OutboxItem): number {
  if (item.payload === undefined) return 64
  try {
    // ×2 粗估 UTF-8 展开（中文 3 字节/字符）：软上限场景宁可高估切批，不可低估爆 8MB
    return JSON.stringify(item.payload).length * 2
  } catch {
    return 64
  }
}

/** 把 blocks 行数组按行数与字节软上限切批（push-artifacts 序列用），纯函数可单测 */
export function chunkRows<T>(rows: readonly T[], maxRows = ARTIFACT_BLOCKS_PER_BATCH, maxBytes = SYNC_BATCH_MAX_BYTES): T[][] {
  const out: T[][] = []
  let cur: T[] = []
  let bytes = 0
  for (const row of rows) {
    let size = 128
    try {
      size = JSON.stringify(row).length * 2
    } catch {
      /* 不可序列化的行让服务端 400，这里不拦 */
    }
    if (cur.length >= maxRows || (cur.length > 0 && bytes + size > maxBytes)) {
      out.push(cur)
      cur = []
      bytes = 0
    }
    cur.push(row)
    bytes += size
  }
  if (cur.length) out.push(cur)
  return out
}

// ---------------------------------------------------------------------------
// 入队通知：syncedRepos 写完 outbox 后发信号，引擎据此调度 flush。
// 放这里而不是 syncEngine：repos → syncedRepos → outbox 的依赖是单向的，
// 引擎订阅信号即可，不产生 syncEngine ↔ repos 环。
// ---------------------------------------------------------------------------

type OutboxListener = (dbName: string, item: OutboxItem) => void

const listeners = new Set<OutboxListener>()

export const outboxSignal = {
  on(fn: OutboxListener): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  emit(dbName: string, item: OutboxItem): void {
    for (const fn of listeners) fn(dbName, item)
  },
}
