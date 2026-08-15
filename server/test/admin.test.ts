/**
 * admin 路由:权限边界(401/403)、邀请码生成、用户管理、停用踢下线、配额重算。
 */
import { describe, expect, it } from 'vitest'
import type { AdminUser, InviteCode, MeResponse } from '../../shared/apiTypes.js'
import { createTestApp, createUser, login, postJson, withSid, type TestCtx } from './helpers.js'

async function setupAdmin(ctx: TestCtx): Promise<string> {
  await createUser(ctx.db, 'root', 'root-pass-123', 'admin')
  return login(ctx.app, 'root', 'root-pass-123')
}

describe('权限边界', () => {
  it('未登录 → 401;普通用户 → 403 forbidden', async () => {
    const ctx = createTestApp()
    await createUser(ctx.db, 'pete', 'pete-pass-1234')
    const userSid = await login(ctx.app, 'pete', 'pete-pass-1234')

    expect((await ctx.app.request('/api/app/admin/users')).status).toBe(401)

    const asUser = await ctx.app.request('/api/app/admin/users', { headers: withSid(userSid) })
    expect(asUser.status).toBe(403)
    expect(((await asUser.json()) as { error: string }).error).toBe('forbidden')

    const post = await ctx.app.request('/api/app/admin/invites', {
      method: 'POST',
      headers: withSid(userSid),
    })
    expect(post.status).toBe(403)
  })
})

describe('邀请码', () => {
  it('生成 16 字符 URL 安全码,支持 expiresInDays/note,列表可见', async () => {
    const ctx = createTestApp()
    const sid = await setupAdmin(ctx)
    const res = await ctx.app.request(
      '/api/app/admin/invites',
      postJson({ expiresInDays: 7, note: '给同事' }, withSid(sid)),
    )
    expect(res.status).toBe(200)
    const invite = (await res.json()) as InviteCode
    expect(invite.code).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(invite.note).toBe('给同事')
    expect(invite.expiresAt).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000)
    expect(invite.usedBy).toBeNull()

    // 空 body 也能生成(全部字段可选,默认永不过期)
    const bare = await ctx.app.request('/api/app/admin/invites', {
      method: 'POST',
      headers: withSid(sid),
    })
    expect(bare.status).toBe(200)
    expect(((await bare.json()) as InviteCode).expiresAt).toBeNull()

    const list = await ctx.app.request('/api/app/admin/invites', { headers: withSid(sid) })
    expect(((await list.json()) as InviteCode[]).length).toBe(2)
  })

  it('admin 生成的码可完成注册,列表反映 usedBy', async () => {
    const ctx = createTestApp()
    const sid = await setupAdmin(ctx)
    const invite = (await (
      await ctx.app.request('/api/app/admin/invites', { method: 'POST', headers: withSid(sid) })
    ).json()) as InviteCode

    const reg = await ctx.app.request(
      '/api/app/auth/register',
      postJson({ username: 'quinn', password: 'quinn-pass-12', inviteCode: invite.code }),
    )
    expect(reg.status).toBe(200)
    const me = (await reg.json()) as MeResponse

    const list = (await (
      await ctx.app.request('/api/app/admin/invites', { headers: withSid(sid) })
    ).json()) as InviteCode[]
    expect(list.find((i) => i.code === invite.code)?.usedBy).toBe(me.id)
  })
})

describe('用户管理', () => {
  it('停用用户:session 立即吊销,重登被拒;恢复后可再登录', async () => {
    const ctx = createTestApp()
    const adminSid = await setupAdmin(ctx)
    const userId = await createUser(ctx.db, 'ruby', 'ruby-pass-1234')
    const userSid = await login(ctx.app, 'ruby', 'ruby-pass-1234')

    const res = await ctx.app.request(`/api/app/admin/users/${userId}`, {
      ...postJson({ disabled: true }, withSid(adminSid)),
      method: 'PATCH',
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as AdminUser).disabled).toBe(true)

    // 已被踢下线(session 删除 → 401)
    expect((await ctx.app.request('/api/app/auth/me', { headers: withSid(userSid) })).status).toBe(
      401,
    )
    // 重新登录被拒:账号停用
    const relogin = await ctx.app.request(
      '/api/app/auth/login',
      postJson({ username: 'ruby', password: 'ruby-pass-1234' }),
    )
    expect(relogin.status).toBe(403)
    expect(((await relogin.json()) as { error: string }).error).toBe('account-disabled')

    await ctx.app.request(`/api/app/admin/users/${userId}`, {
      ...postJson({ disabled: false }, withSid(adminSid)),
      method: 'PATCH',
    })
    await login(ctx.app, 'ruby', 'ruby-pass-1234') // 不抛即成功
  })

  it('admin 不能停用自己;可调配额;用户列表齐全', async () => {
    const ctx = createTestApp()
    const adminSid = await setupAdmin(ctx)
    const admin = (await (
      await ctx.app.request('/api/app/auth/me', { headers: withSid(adminSid) })
    ).json()) as MeResponse

    const selfDisable = await ctx.app.request(`/api/app/admin/users/${admin.id}`, {
      ...postJson({ disabled: true }, withSid(adminSid)),
      method: 'PATCH',
    })
    expect(selfDisable.status).toBe(400)

    const userId = await createUser(ctx.db, 'sam', 'sam-pass-12345')
    const quota = await ctx.app.request(`/api/app/admin/users/${userId}`, {
      ...postJson({ storageQuotaBytes: 1024 }, withSid(adminSid)),
      method: 'PATCH',
    })
    expect(((await quota.json()) as AdminUser).storageQuotaBytes).toBe(1024)

    const users = (await (
      await ctx.app.request('/api/app/admin/users', { headers: withSid(adminSid) })
    ).json()) as AdminUser[]
    expect(users.map((u) => u.username).sort()).toEqual(['root', 'sam'])
  })

  it('recount-quota:无同步数据时重算归 0', async () => {
    const ctx = createTestApp()
    const adminSid = await setupAdmin(ctx)
    ctx.db.prepare('UPDATE users SET storage_used_bytes = 999').run()
    const res = await ctx.app.request('/api/app/admin/recount-quota', {
      method: 'POST',
      headers: withSid(adminSid),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, users: 1 })
    const { s } = ctx.db.prepare('SELECT SUM(storage_used_bytes) AS s FROM users').get() as {
      s: number
    }
    expect(s).toBe(0)
  })
})
