import { describe, expect, it } from 'vitest'
import { createTestApp } from './helpers.js'

describe('GET /api/app/health', () => {
  it('无鉴权返回 ok + version', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/app/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; version: string }
    expect(body.ok).toBe(true)
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('未知路由回统一 404 形状', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/app/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not-found' })
  })
})
