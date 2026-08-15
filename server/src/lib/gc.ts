/**
 * 同步域后台清理(P3):启动时 + 每 24h 跑一次。
 * 1) 墓碑物理清除:90 天后删除——窗口内长期离线的设备靠 /sync/snapshot 对账兜底,
 *    超窗的墓碑只是磁盘垃圾;
 * 2) usage/evidence 行数上限裁剪:这两张表 append-only 无上限增长,
 *    超限的最老行"走墓碑"(而非直接物理删)——其它设备下次增量拉取时同步删掉本地行,
 *    否则各端行数会永久漂移。
 */
import type { SyncTable } from '../../../shared/apiTypes.js'
import type { Db } from '../db/db.js'
import { addStorageUsed, nextSeq } from './quota.js'

export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000
export const GC_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 每用户每表存活行数上限;usage 每次调用一行、evidence 每轮若干行,上限按月级用量放宽 */
export const ROW_CAPS: Partial<Record<SyncTable, number>> = {
  usage: 5000,
  evidence: 10000,
}

export interface GcResult {
  tombstonesPurged: number
  rowsTrimmed: number
}

export function runGc(db: Db, now = Date.now(), caps: Partial<Record<SyncTable, number>> = ROW_CAPS): GcResult {
  const tombstonesPurged = db.transaction(
    () =>
      db
        .prepare('DELETE FROM sync_records WHERE deleted = 1 AND updated_at < ?')
        .run(now - TOMBSTONE_TTL_MS).changes,
  )()

  let rowsTrimmed = 0
  for (const [tbl, cap] of Object.entries(caps) as [SyncTable, number][]) {
    const overUsers = db
      .prepare(
        'SELECT user_id, COUNT(*) AS n FROM sync_records WHERE tbl = ? AND deleted = 0 GROUP BY user_id HAVING n > ?',
      )
      .all(tbl, cap) as { user_id: number; n: number }[]
    for (const u of overUsers) {
      // 每用户一个事务:单个用户量大时不长期霸占写锁
      db.transaction(() => {
        const victims = db
          .prepare(
            'SELECT id, bytes_size FROM sync_records WHERE user_id = ? AND tbl = ? AND deleted = 0 ORDER BY seq ASC LIMIT ?',
          )
          .all(u.user_id, tbl, u.n - cap) as { id: string; bytes_size: number }[]
        let freed = 0
        for (const v of victims) {
          const seq = nextSeq(db)
          db.prepare(
            'UPDATE sync_records SET deleted = 1, payload = NULL, bytes_size = 0, seq = ?, updated_at = ? WHERE user_id = ? AND tbl = ? AND id = ?',
          ).run(seq, now, u.user_id, tbl, v.id)
          freed += v.bytes_size
        }
        addStorageUsed(db, u.user_id, -freed)
        rowsTrimmed += victims.length
      })()
    }
  }
  return { tombstonesPurged, rowsTrimmed }
}

/** 启动即跑一次 + 定时循环;unref 让定时器不阻止进程退出 */
export function startGc(db: Db): NodeJS.Timeout {
  const safeRun = () => {
    try {
      const r = runGc(db)
      if (r.tombstonesPurged > 0 || r.rowsTrimmed > 0) {
        console.log(`[gc] purged=${r.tombstonesPurged} trimmed=${r.rowsTrimmed}`)
      }
    } catch (e) {
      // GC 失败不致命,下一轮再试;绝不让清理任务把服务打挂
      console.error('[gc] 执行失败:', e)
    }
  }
  safeRun()
  const timer = setInterval(safeRun, GC_INTERVAL_MS)
  timer.unref()
  return timer
}
