/**
 * CSRF 防线:非 GET + 恶意 Origin → 403;GET 不校验;无 Origin(curl)放行。
 */
import { describe, expect, it } from 'vitest'
import { createTestApp, postJson } from './helpers.js'

describe('Origin 校验', () => {
  it('非 GET 携带不在 allowlist 的 Origin → 403 origin-forbidden', async () => {
    const { app } = createTestApp()
    const res = await app.request(
      '/api/app/auth/login',
      postJson({ username: 'a', password: 'b' }, { origin: 'https://evil.example' }),
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'origin-forbidden' })
  })

  it('GET 不校验 Origin', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/app/health', {
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(200)
  })

  it('allowlist 内的 Origin 放行(走到业务逻辑)', async () => {
    const { app } = createTestApp()
    const res = await app.request(
      '/api/app/auth/login',
      postJson({ username: 'nobody', password: 'wrong-pass' }, { origin: 'http://localhost:5173' }),
    )
    expect(res.status).toBe(401) // 未被 Origin 拦,进入登录逻辑
  })

  it('无 Origin 头(curl/服务端调用)放行', async () => {
    const { app } = createTestApp()
    const res = await app.request(
      '/api/app/auth/login',
      postJson({ username: 'nobody', password: 'wrong-pass' }),
    )
    expect(res.status).toBe(401)
  })
})
