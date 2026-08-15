/**
 * 注册消码事务 / 登录全链 / 爆破限流 / 统一失败文案 / 改密吊销其它会话。
 */
import { describe, expect, it } from 'vitest'
import type { MeResponse } from '../../shared/apiTypes.js'
import {
  createTestApp,
  createUser,
  insertInvite,
  login,
  postJson,
  sidOf,
  withSid,
} from './helpers.js'

describe('注册(邀请码消耗)', () => {
  it('有效邀请码:注册成功 + 自动登录 + 码被标记已用', async () => {
    const { app, db } = createTestApp()
    const adminId = await createUser(db, 'root', 'root-pass-123', 'admin')
    insertInvite(db, 'CODE-A', adminId)

    const res = await app.request(
      '/api/app/auth/register',
      postJson({ username: 'alice', password: 'alice-pass-1', inviteCode: 'CODE-A' }),
    )
    expect(res.status).toBe(200)
    const me = (await res.json()) as MeResponse
    expect(me.username).toBe('alice')
    expect(me.role).toBe('user')

    // 自动登录:注册响应的 cookie 直接可用
    const sid = sidOf(res)
    const meRes = await app.request('/api/app/auth/me', { headers: withSid(sid) })
    expect(meRes.status).toBe(200)

    const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get('CODE-A') as {
      used_by: number
      used_at: number
    }
    expect(invite.used_by).toBe(me.id)
    expect(invite.used_at).toBeGreaterThan(0)
  })

  it('已用过的码再次注册 → 400 invalid-invite,且不创建用户', async () => {
    const { app, db } = createTestApp()
    const adminId = await createUser(db, 'root', 'root-pass-123', 'admin')
    insertInvite(db, 'CODE-B', adminId)
    await app.request(
      '/api/app/auth/register',
      postJson({ username: 'alice', password: 'alice-pass-1', inviteCode: 'CODE-B' }),
    )

    const res = await app.request(
      '/api/app/auth/register',
      postJson({ username: 'bob', password: 'bob-pass-1234', inviteCode: 'CODE-B' }),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid-invite')
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'bob'").get()).toEqual({
      n: 0,
    })
  })

  it('过期码 → 400 invalid-invite', async () => {
    const { app, db } = createTestApp()
    const adminId = await createUser(db, 'root', 'root-pass-123', 'admin')
    insertInvite(db, 'CODE-EXP', adminId, { expiresAt: Date.now() - 1000 })
    const res = await app.request(
      '/api/app/auth/register',
      postJson({ username: 'late', password: 'late-pass-123', inviteCode: 'CODE-EXP' }),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid-invite')
  })

  it('用户名 NOCASE 判重 → 409,且第二个码未被消耗', async () => {
    const { app, db } = createTestApp()
    const adminId = await createUser(db, 'root', 'root-pass-123', 'admin')
    insertInvite(db, 'CODE-1', adminId)
    insertInvite(db, 'CODE-2', adminId)
    await app.request(
      '/api/app/auth/register',
      postJson({ username: 'Carol', password: 'carol-pass-12', inviteCode: 'CODE-1' }),
    )
    const res = await app.request(
      '/api/app/auth/register',
      postJson({ username: 'carol', password: 'carol-pass-12', inviteCode: 'CODE-2' }),
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('username-taken')
    const invite = db.prepare('SELECT used_by FROM invite_codes WHERE code = ?').get('CODE-2') as {
      used_by: number | null
    }
    expect(invite.used_by).toBeNull() // 事务回滚:码未被烧掉
  })
})

describe('登录/登出/me 全链', () => {
  it('login → me → logout → me 401', async () => {
    const { app, db } = createTestApp()
    await createUser(db, 'dave', 'dave-pass-123')
    const sid = await login(app, 'dave', 'dave-pass-123')

    const meRes = await app.request('/api/app/auth/me', { headers: withSid(sid) })
    expect(meRes.status).toBe(200)
    expect(((await meRes.json()) as MeResponse).username).toBe('dave')

    const outRes = await app.request('/api/app/auth/logout', {
      method: 'POST',
      headers: withSid(sid),
    })
    expect(outRes.status).toBe(200)

    const meAgain = await app.request('/api/app/auth/me', { headers: withSid(sid) })
    expect(meAgain.status).toBe(401)
    expect(((await meAgain.json()) as { error: string }).error).toBe('unauthenticated')
  })

  it('登录轮换 session id:携带旧 sid 登录后旧会话失效', async () => {
    const { app, db } = createTestApp()
    await createUser(db, 'eve', 'eve-pass-1234')
    const sid1 = await login(app, 'eve', 'eve-pass-1234')
    const res = await app.request(
      '/api/app/auth/login',
      postJson({ username: 'eve', password: 'eve-pass-1234' }, withSid(sid1)),
    )
    const sid2 = sidOf(res)
    expect(sid2).not.toBe(sid1)
    expect((await app.request('/api/app/auth/me', { headers: withSid(sid1) })).status).toBe(401)
    expect((await app.request('/api/app/auth/me', { headers: withSid(sid2) })).status).toBe(200)
  })

  it('错误密码与未知用户名返回完全相同的 401 响应体(不泄露用户名存在性)', async () => {
    const { app, db } = createTestApp()
    await createUser(db, 'frank', 'frank-pass-12')
    const wrongPw = await app.request(
      '/api/app/auth/login',
      postJson({ username: 'frank', password: 'not-the-pass' }),
    )
    const unknownUser = await app.request(
      '/api/app/auth/login',
      postJson({ username: 'ghost', password: 'not-the-pass' }),
    )
    expect(wrongPw.status).toBe(401)
    expect(unknownUser.status).toBe(401)
    expect(await wrongPw.json()).toEqual(await unknownUser.json()) // 统一文案
  })
})

describe('登录限流(10 次/15 分钟)', () => {
  it('同用户名换 IP 连错 10 次后 → 429 + Retry-After', async () => {
    const { app, db } = createTestApp()
    await createUser(db, 'grace', 'grace-pass-12')
    for (let i = 0; i < 10; i++) {
      const res = await app.request(
        '/api/app/auth/login',
        postJson(
          { username: 'grace', password: 'wrong' },
          { 'x-forwarded-for': `10.0.0.${i + 1}` }, // 每次不同 IP:命中的是用户名维度
        ),
      )
      expect(res.status).toBe(401)
    }
    const blocked = await app.request(
      '/api/app/auth/login',
      postJson({ username: 'grace', password: 'grace-pass-12' }, { 'x-forwarded-for': '10.0.0.99' }),
    )
    expect(blocked.status).toBe(429)
    expect(((await blocked.json()) as { error: string }).error).toBe('rate-limited')
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('同 IP 换用户名连错 10 次后 → 429(IP 维度)', async () => {
    const { app } = createTestApp()
    const ip = { 'x-forwarded-for': '10.9.9.9' }
    for (let i = 0; i < 10; i++) {
      await app.request(
        '/api/app/auth/login',
        postJson({ username: `u${i}`, password: 'wrong' }, ip),
      )
    }
    const blocked = await app.request(
      '/api/app/auth/login',
      postJson({ username: 'u-fresh', password: 'wrong' }, ip),
    )
    expect(blocked.status).toBe(429)
  })
})

describe('改密', () => {
  it('改密后其它 session 全部吊销,当前 session 保留,新密码生效', async () => {
    const { app, db } = createTestApp()
    await createUser(db, 'henry', 'old-pass-1234')
    const sidA = await login(app, 'henry', 'old-pass-1234')
    const sidB = await login(app, 'henry', 'old-pass-1234')

    const res = await app.request(
      '/api/app/auth/change-password',
      postJson({ oldPassword: 'old-pass-1234', newPassword: 'new-pass-5678' }, withSid(sidA)),
    )
    expect(res.status).toBe(200)

    expect((await app.request('/api/app/auth/me', { headers: withSid(sidB) })).status).toBe(401)
    expect((await app.request('/api/app/auth/me', { headers: withSid(sidA) })).status).toBe(200)

    const oldLogin = await app.request(
      '/api/app/auth/login',
      postJson({ username: 'henry', password: 'old-pass-1234' }),
    )
    expect(oldLogin.status).toBe(401)
    await login(app, 'henry', 'new-pass-5678') // 不抛即成功
  })

  it('旧密码错误 → 400,session 不受影响', async () => {
    const { app, db } = createTestApp()
    await createUser(db, 'ivy', 'ivy-pass-1234')
    const sid = await login(app, 'ivy', 'ivy-pass-1234')
    const res = await app.request(
      '/api/app/auth/change-password',
      postJson({ oldPassword: 'wrong-old', newPassword: 'new-pass-5678' }, withSid(sid)),
    )
    expect(res.status).toBe(400)
    expect((await app.request('/api/app/auth/me', { headers: withSid(sid) })).status).toBe(200)
  })
})
