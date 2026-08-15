/**
 * 服务端 session:256-bit 随机 id 存 DB,cookie 只带 id。
 * 30 天滑动过期——但只在剩余寿命过半时才写库续期,避免每个请求都写 sessions 表。
 */
import { randomBytes } from 'node:crypto'
import { SESSION_TTL_MS } from '../../../shared/apiRoutes.js'
import type { Db, SessionRow } from '../db/db.js'

export function createSession(db: Db, userId: number, now = Date.now()): string {
  const id = randomBytes(32).toString('hex')
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    id,
    userId,
    now,
    now + SESSION_TTL_MS,
  )
  return id
}

export interface TouchResult {
  session: SessionRow
  /** 续期发生时中间件需要重发 Set-Cookie,同步浏览器侧 Max-Age */
  renewed: boolean
}

/** 取 session 并滑动续期;过期/不存在返回 null(过期行顺手删除) */
export function touchSession(db: Db, sid: string, now = Date.now()): TouchResult | null {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid) as
    | SessionRow
    | undefined
  if (!session) return null
  if (session.expires_at <= now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid)
    return null
  }
  if (session.expires_at - now < SESSION_TTL_MS / 2) {
    const expiresAt = now + SESSION_TTL_MS
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(expiresAt, sid)
    return { session: { ...session, expires_at: expiresAt }, renewed: true }
  }
  return { session, renewed: false }
}

export function deleteSession(db: Db, sid: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sid)
}

/** 改密后吊销本人其它会话(防拿到旧 cookie 的攻击者继续在线) */
export function deleteOtherSessions(db: Db, userId: number, keepSid: string): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, keepSid)
}

/** admin 停用账号时全量吊销 */
export function deleteUserSessions(db: Db, userId: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
}
