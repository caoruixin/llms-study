/**
 * 同步域公用底座:全局 seq 分配与存储配额记账。
 * 全部是"假定已在事务内"的同步函数——better-sqlite3 事务是同步的,
 * 调用方负责用 db.transaction() 包裹,这里不自行开事务(嵌套语义靠 savepoint 兜底)。
 */
import type { Db } from '../db/db.js'

/** 分配下一个全局 seq(事务内自增,UPDATE...RETURNING 原子完成读改写) */
export function nextSeq(db: Db): number {
  const row = db
    .prepare("UPDATE sync_meta SET v = v + 1 WHERE k = 'global_seq' RETURNING v")
    .get() as { v: number }
  return row.v
}

/** 当前 seq 水位(不分配),push/changes 响应里的 cursor 用 */
export function currentSeq(db: Db): number {
  const row = db.prepare("SELECT v FROM sync_meta WHERE k = 'global_seq'").get() as { v: number }
  return row.v
}

/**
 * 增量调整用户存储占用;delta 可负(删除/裁剪回收)。
 * MAX(..., 0) 防御历史记账误差把占用推成负数——负占用会让配额检查形同虚设。
 */
export function addStorageUsed(db: Db, userId: number, delta: number): void {
  if (delta === 0) return
  db.prepare('UPDATE users SET storage_used_bytes = MAX(storage_used_bytes + ?, 0) WHERE id = ?').run(
    delta,
    userId,
  )
}

/** 事务内实读配额:requireSession 拿到的 user 行可能已过期(并发请求间会漂移) */
export function readQuota(db: Db, userId: number): { used: number; quota: number } {
  const row = db
    .prepare('SELECT storage_used_bytes AS used, storage_quota_bytes AS quota FROM users WHERE id = ?')
    .get(userId) as { used: number; quota: number }
  return row
}

/**
 * 全量重算所有用户占用(admin 兜底工具):存活 sync 记录字节 + 文件字节。
 * 增量记账理论上精确,但任何 bug 都可能累积漂移,重算是唯一的真相恢复手段。
 */
export function recountAllUsers(db: Db): number {
  const info = db
    .prepare(
      `UPDATE users SET storage_used_bytes =
         COALESCE((SELECT SUM(s.bytes_size) FROM sync_records s
                   WHERE s.user_id = users.id AND s.deleted = 0), 0)
       + COALESCE((SELECT SUM(f.byte_size) FROM stored_files f
                   WHERE f.user_id = users.id), 0)`,
    )
    .run()
  return info.changes
}
