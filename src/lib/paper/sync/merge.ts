import type { PaperRecord, ReadingProgress } from '../types'

/**
 * 拉取合并规则（纯函数，引擎在应用远端 changes 时逐条调用）：
 * 1. 本地 outbox 里有同记录 pending → 本地胜（本地写还没推上去，远端这条必然更旧或将被覆盖）；
 * 2. 否则逐记录 LWW：payload.updatedAt 较新者胜；
 * 3. papers.progress 特例：无论谁胜，maxBlockIndex / ratio 双端取 max——阅读深度只增不减，
 *    换设备回看旧章节绝不能把另一台设备的进度打回去；
 * 4. 墓碑：papers 墓碑 → 本地级联删除；子表墓碑 → 行删除（由引擎执行，这里只做判定）。
 */

/** 远端记录该不该覆盖本地行：pending 本地胜 → LWW（时间戳缺失按 0，等值时远端胜以趋同服务端） */
export function shouldApplyRemote(opts: {
  hasPendingLocal: boolean
  localUpdatedAt: number | undefined
  remoteUpdatedAt: number | undefined
}): boolean {
  if (opts.hasPendingLocal) return false
  return (opts.remoteUpdatedAt ?? 0) >= (opts.localUpdatedAt ?? 0)
}

/** 从任意业务行里提取 LWW 时间戳：updatedAt 优先，append-only 行退回 createdAt/ts */
export function rowTimestamp(row: unknown): number | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const r = row as { updatedAt?: unknown; createdAt?: unknown; ts?: unknown }
  for (const v of [r.updatedAt, r.createdAt, r.ts]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

/** 进度合并：以 winner 为基（当前位置跟胜者走），阅读深度类字段双端取 max */
export function mergeProgress(
  winner: ReadingProgress | undefined,
  loser: ReadingProgress | undefined,
): ReadingProgress | undefined {
  if (!winner) return loser
  if (!loser) return winner
  const maxBlockIndex = Math.max(winner.maxBlockIndex ?? winner.blockIndex, loser.maxBlockIndex ?? loser.blockIndex)
  return {
    ...winner,
    maxBlockIndex,
    ratio: Math.max(winner.ratio, loser.ratio),
  }
}

/**
 * papers 行合并：整行 LWW 选底（远端等新时选远端，让各端趋同服务端），
 * progress 走 mergeProgress 特例，lastReadAt 取 max（「最近阅读」排序不回退）。
 */
export function mergePaperRecord(local: PaperRecord | undefined, remote: PaperRecord): PaperRecord {
  if (!local) return remote
  const remoteWins = (remote.updatedAt ?? 0) >= (local.updatedAt ?? 0)
  const winner = remoteWins ? remote : local
  const loser = remoteWins ? local : remote
  const progress = mergeProgress(winner.progress, loser.progress)
  const lastReadAt = Math.max(winner.lastReadAt ?? 0, loser.lastReadAt ?? 0)
  return {
    ...winner,
    ...(progress ? { progress } : {}),
    ...(lastReadAt > 0 ? { lastReadAt } : {}),
  }
}
