/**
 * 鉴权中间件三件套:Origin 校验(CSRF)、requireSession、adminOnly。
 * CSRF 策略 = SameSite=Lax cookie + 非 GET 校验 Origin:浏览器跨站发起的写请求
 * 必带 Origin 头,不在 allowlist 即拒;无 Origin 的请求(curl/同源老浏览器)放行,
 * 因为没有浏览器 cookie 自动携带就没有 CSRF 面。
 */
import type { MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { SESSION_COOKIE, SESSION_TTL_MS } from '../../../shared/apiRoutes.js'
import type { Config } from '../config.js'
import type { UserRow } from '../db/db.js'
import { apiError } from '../lib/respond.js'
import type { AppDeps, AppEnv } from '../types.js'
import { deleteSession, touchSession } from './session.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function originCheck(config: Config): MiddlewareHandler {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin')
      if (origin && !config.allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
        return apiError(c, 403, 'origin-forbidden')
      }
    }
    await next()
  }
}

export function setSessionCookie(
  c: Parameters<typeof setCookie>[0],
  config: Config,
  sid: string,
): void {
  setCookie(c, SESSION_COOKIE, sid, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.cookieSecure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}

export function clearSessionCookie(c: Parameters<typeof deleteCookie>[0]): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

export function requireSession(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const sid = getCookie(c, SESSION_COOKIE)
    if (!sid) return apiError(c, 401, 'unauthenticated')
    const touched = touchSession(deps.db, sid)
    if (!touched) {
      clearSessionCookie(c)
      return apiError(c, 401, 'unauthenticated')
    }
    const user = deps.db.prepare('SELECT * FROM users WHERE id = ?').get(touched.session.user_id) as
      | UserRow
      | undefined
    if (!user) {
      // 用户行已消失(理论上仅手工删库),session 成孤儿,顺手清掉
      deleteSession(deps.db, sid)
      clearSessionCookie(c)
      return apiError(c, 401, 'unauthenticated')
    }
    if (user.disabled) return apiError(c, 403, 'account-disabled', '账号已被停用')
    // 滑动续期发生时重发 cookie,浏览器侧 Max-Age 与服务端 expires_at 保持同步
    if (touched.renewed) setSessionCookie(c, deps.config, sid)
    c.set('user', user)
    c.set('sessionId', sid)
    await next()
  }
}

/** 必须挂在 requireSession 之后 */
export function adminOnly(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get('user').role !== 'admin') return apiError(c, 403, 'forbidden')
    await next()
  }
}
