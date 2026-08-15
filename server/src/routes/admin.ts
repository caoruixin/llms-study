/**
 * admin 管理面:邀请码、用户列表、停用/配额调整、配额重算。
 * 全部路由 requireSession + adminOnly;普通用户一律 403 forbidden。
 */
import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import type {
  AdminUser,
  InviteCode,
  RecountQuotaResponse,
} from '../../../shared/apiTypes.js'
import { adminOnly, requireSession } from '../auth/middleware.js'
import { deleteUserSessions } from '../auth/session.js'
import type { InviteCodeRow, UserRow } from '../db/db.js'
import { recountAllUsers } from '../lib/quota.js'
import { apiError } from '../lib/respond.js'
import { readJson } from '../lib/validate.js'
import type { AppDeps, AppEnv } from '../types.js'

// randomBytes(12) 的 base64url 恰为 16 字符,URL 安全字母表且无取模偏差
function generateInviteCode(): string {
  return randomBytes(12).toString('base64url')
}

// POST /admin/invites 允许空 body(全部字段可选)
const createInviteSchema = z
  .object({
    expiresInDays: z.number().int().min(1).max(365).optional(),
    note: z.string().max(200).optional(),
  })
  .optional()

const updateUserSchema = z.object({
  disabled: z.boolean().optional(),
  storageQuotaBytes: z.number().int().min(0).optional(),
})

function toInviteDto(row: InviteCodeRow): InviteCode {
  return {
    code: row.code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    note: row.note,
    usedBy: row.used_by,
    usedAt: row.used_at,
  }
}

function toAdminUserDto(row: UserRow): AdminUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    disabled: row.disabled !== 0,
    storageQuotaBytes: row.storage_quota_bytes,
    storageUsedBytes: row.storage_used_bytes,
    createdAt: row.created_at,
  }
}

export function adminRoutes(deps: AppDeps): Hono<AppEnv> {
  const { db } = deps
  const r = new Hono<AppEnv>()
  r.use('*', requireSession(deps), adminOnly())

  r.post('/invites', async (c) => {
    const body = await readJson(c, createInviteSchema)
    if (!body.ok) return body.res
    const { expiresInDays, note } = body.data ?? {}
    const now = Date.now()
    const code = generateInviteCode()
    db.prepare(
      'INSERT INTO invite_codes (code, created_by, created_at, expires_at, note) VALUES (?, ?, ?, ?, ?)',
    ).run(
      code,
      c.get('user').id,
      now,
      expiresInDays ? now + expiresInDays * 24 * 60 * 60 * 1000 : null,
      note ?? null,
    )
    const row = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as InviteCodeRow
    return c.json(toInviteDto(row))
  })

  r.get('/invites', (c) => {
    const rows = db
      .prepare('SELECT * FROM invite_codes ORDER BY created_at DESC')
      .all() as InviteCodeRow[]
    return c.json(rows.map(toInviteDto))
  })

  r.get('/users', (c) => {
    const rows = db.prepare('SELECT * FROM users ORDER BY id').all() as UserRow[]
    return c.json(rows.map(toAdminUserDto))
  })

  r.patch('/users/:id', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return apiError(c, 400, 'invalid-input', '用户 id 不合法')
    const body = await readJson(c, updateUserSchema)
    if (!body.ok) return body.res
    const { disabled, storageQuotaBytes } = body.data
    if (disabled === undefined && storageQuotaBytes === undefined) {
      return apiError(c, 400, 'invalid-input', '至少提供一个字段')
    }
    // 防自锁:admin 不能停用自己(否则没人能再进管理面)
    if (disabled === true && id === c.get('user').id) {
      return apiError(c, 400, 'invalid-input', '不能停用当前登录的账号')
    }
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
    if (!target) return apiError(c, 404, 'not-found')

    if (disabled !== undefined) {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id)
      // 停用即踢下线:不给残留 session 一个 30 天的窗口
      if (disabled) deleteUserSessions(db, id)
    }
    if (storageQuotaBytes !== undefined) {
      db.prepare('UPDATE users SET storage_quota_bytes = ? WHERE id = ?').run(storageQuotaBytes, id)
    }
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow
    return c.json(toAdminUserDto(updated))
  })

  // 真实聚合重算(存活 sync 记录 + 文件字节):增量记账漂移时的真相恢复手段
  r.post('/recount-quota', (c) => {
    const users = recountAllUsers(db)
    const body: RecountQuotaResponse = { ok: true, users }
    return c.json(body)
  })

  return r
}
