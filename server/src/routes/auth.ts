/**
 * 注册/登录/登出/me/改密。
 * 安全要点:注册在单事务内"检查邀请码未用未过期 + 建用户 + 标记已用",并发用同一码
 * 只有一个能成;登录失败统一文案不区分"用户名不存在/密码错误",且未知用户也跑 dummy
 * argon2 保持恒时;IP+用户名双维度限流防爆破;登录轮换 session id 防 fixation;
 * 改密吊销本人其它会话。
 */
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { z } from 'zod'
import {
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  PASSWORD_MAX,
  PASSWORD_MIN,
  SESSION_COOKIE,
  USERNAME_MAX,
  USERNAME_MIN,
  USERNAME_RE,
} from '../../../shared/apiRoutes.js'
import {
  LLM_PROVIDERS,
  type LlmKeyInfo,
  type LlmProvider,
  type MeResponse,
  type OkResponse,
} from '../../../shared/apiTypes.js'
import { clearSessionCookie, requireSession, setSessionCookie } from '../auth/middleware.js'
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../auth/password.js'
import { createSession, deleteOtherSessions, deleteSession } from '../auth/session.js'
import type { Db, InviteCodeRow, UserRow } from '../db/db.js'
import { apiError } from '../lib/respond.js'
import { readJson } from '../lib/validate.js'
import type { AppDeps, AppEnv } from '../types.js'

// ---- 登录失败限流(进程内存即可:单进程部署,重启清零可接受) ----

export interface FailureLimiter {
  /** 返回还需等待的毫秒数;0 = 未被限流 */
  blockedForMs(key: string, now?: number): number
  record(key: string, now?: number): void
  clear(key: string): void
}

export function createFailureLimiter(maxFailures: number, windowMs: number): FailureLimiter {
  const failures = new Map<string, number[]>()
  return {
    blockedForMs(key, now = Date.now()) {
      const kept = (failures.get(key) ?? []).filter((t) => t > now - windowMs)
      if (kept.length === 0) failures.delete(key)
      else failures.set(key, kept)
      return kept.length >= maxFailures ? kept[0] + windowMs - now : 0
    },
    record(key, now = Date.now()) {
      const arr = failures.get(key) ?? []
      arr.push(now)
      failures.set(key, arr)
    },
    clear(key) {
      failures.delete(key)
    },
  }
}

/** 直连时取 socket 地址;经 nginx 时取 XFF 首段(后端只监听 127.0.0.1,XFF 必为 nginx 所写,可信) */
function clientIp(c: { req: { header(name: string): string | undefined } }, env: unknown): string {
  const xff = c.req.header('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const incoming = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming
  return incoming?.socket?.remoteAddress ?? 'unknown'
}

// ---- DTO 组装 ----

export function buildMe(db: Db, user: UserRow): MeResponse {
  const rows = db
    .prepare('SELECT provider, last4 FROM user_llm_keys WHERE user_id = ?')
    .all(user.id) as { provider: string; last4: string }[]
  const llmKeys = Object.fromEntries(LLM_PROVIDERS.map((p) => [p, null])) as Record<
    LlmProvider,
    LlmKeyInfo | null
  >
  for (const row of rows) {
    if ((LLM_PROVIDERS as readonly string[]).includes(row.provider)) {
      llmKeys[row.provider as LlmProvider] = { last4: row.last4 }
    }
  }
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    storageQuotaBytes: user.storage_quota_bytes,
    storageUsedBytes: user.storage_used_bytes,
    llmKeys,
  }
}

// ---- schemas ----

const registerSchema = z.object({
  username: z.string().min(USERNAME_MIN).max(USERNAME_MAX).regex(USERNAME_RE),
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
  inviteCode: z.string().min(1).max(64),
})

const loginSchema = z.object({
  username: z.string().min(1).max(USERNAME_MAX),
  password: z.string().min(1).max(PASSWORD_MAX),
})

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1).max(PASSWORD_MAX),
  newPassword: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
})

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
}

export function authRoutes(deps: AppDeps): Hono<AppEnv> {
  const { db, config } = deps
  const limiter = createFailureLimiter(LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS)
  const r = new Hono<AppEnv>()

  r.post('/register', async (c) => {
    const body = await readJson(c, registerSchema)
    if (!body.ok) return body.res
    const { username, password, inviteCode } = body.data
    // argon2 在事务外先算好:better-sqlite3 事务是同步的,不能内嵌 await
    const passwordHash = await hashPassword(password)
    const now = Date.now()

    const result = db.transaction(
      (): { ok: true; userId: number } | { ok: false; code: 'invalid-invite' | 'username-taken' } => {
        const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(inviteCode) as
          | InviteCodeRow
          | undefined
        if (
          !invite ||
          invite.used_by !== null ||
          (invite.expires_at !== null && invite.expires_at <= now)
        ) {
          return { ok: false, code: 'invalid-invite' }
        }
        let userId: number
        try {
          const info = db
            .prepare(
              'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
            )
            .run(username, passwordHash, 'user', now)
          userId = Number(info.lastInsertRowid)
        } catch (e) {
          if (isUniqueViolation(e)) return { ok: false, code: 'username-taken' }
          throw e
        }
        db.prepare('UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code = ?').run(
          userId,
          now,
          inviteCode,
        )
        return { ok: true, userId }
      },
    )()

    if (!result.ok) {
      return result.code === 'invalid-invite'
        ? apiError(c, 400, 'invalid-invite', '邀请码无效或已被使用')
        : apiError(c, 409, 'username-taken', '用户名已被占用')
    }
    // 注册即登录,省一次往返
    const sid = createSession(db, result.userId, now)
    setSessionCookie(c, config, sid)
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.userId) as UserRow
    return c.json(buildMe(db, user))
  })

  r.post('/login', async (c) => {
    const body = await readJson(c, loginSchema)
    if (!body.ok) return body.res
    const { username, password } = body.data

    const keys = [`ip:${clientIp(c, c.env)}`, `user:${username.toLowerCase()}`]
    const blockedMs = Math.max(...keys.map((k) => limiter.blockedForMs(k)))
    if (blockedMs > 0) {
      c.header('Retry-After', String(Math.ceil(blockedMs / 1000)))
      return apiError(c, 429, 'rate-limited', '尝试次数过多,请稍后再试')
    }

    const recordFailure = () => {
      for (const k of keys) limiter.record(k)
      // 统一文案:不泄露用户名是否存在
      return apiError(c, 401, 'invalid-credentials', '用户名或密码错误')
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      | UserRow
      | undefined
    if (!user) {
      await verifyAgainstDummy(password)
      return recordFailure()
    }
    if (!(await verifyPassword(user.password_hash, password))) return recordFailure()
    if (user.disabled) return apiError(c, 403, 'account-disabled', '账号已被停用')

    limiter.clear(`user:${username.toLowerCase()}`)
    // 登录轮换 session id:携带旧 cookie 登录时旧会话作废(防 session fixation)
    const oldSid = getCookie(c, SESSION_COOKIE)
    if (oldSid) deleteSession(db, oldSid)
    const sid = createSession(db, user.id)
    setSessionCookie(c, config, sid)
    return c.json(buildMe(db, user))
  })

  r.post('/logout', requireSession(deps), (c) => {
    deleteSession(db, c.get('sessionId'))
    clearSessionCookie(c)
    const body: OkResponse = { ok: true }
    return c.json(body)
  })

  r.get('/me', requireSession(deps), (c) => c.json(buildMe(db, c.get('user'))))

  r.post('/change-password', requireSession(deps), async (c) => {
    const body = await readJson(c, changePasswordSchema)
    if (!body.ok) return body.res
    const user = c.get('user')
    if (!(await verifyPassword(user.password_hash, body.data.oldPassword))) {
      return apiError(c, 400, 'invalid-credentials', '旧密码错误')
    }
    const newHash = await hashPassword(body.data.newPassword)
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id)
    // 只留当前会话:旧 cookie 全部失效
    deleteOtherSessions(db, user.id, c.get('sessionId'))
    const ok: OkResponse = { ok: true }
    return c.json(ok)
  })

  return r
}
