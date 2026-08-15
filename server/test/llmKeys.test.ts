/**
 * 用户 LLM key 保管:加密入库、只回 last4、DB 无明文、AAD 防跨用户移植。
 */
import { describe, expect, it } from 'vitest'
import type { MeResponse } from '../../shared/apiTypes.js'
import { decryptSecret, llmKeyAad } from '../src/lib/crypto.js'
import { createTestApp, createUser, login, postJson, withSid } from './helpers.js'

const KEY = 'sk-test-secret-1234567890abcd'

async function putKey(
  app: ReturnType<typeof createTestApp>['app'],
  sid: string,
  provider: string,
  key = KEY,
) {
  return app.request(`/api/app/me/llm-keys/${provider}`, {
    ...postJson({ key }, withSid(sid)),
    method: 'PUT',
  })
}

describe('PUT/DELETE /me/llm-keys/:provider', () => {
  it('未登录 → 401', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/app/me/llm-keys/deepseek', {
      ...postJson({ key: KEY }),
      method: 'PUT',
    })
    expect(res.status).toBe(401)
  })

  it('保存后只回 last4;me 里可见;DB 中无明文', async () => {
    const { app, db, config } = createTestApp()
    const userId = await createUser(db, 'kate', 'kate-pass-1234')
    const sid = await login(app, 'kate', 'kate-pass-1234')

    const res = await putKey(app, sid, 'deepseek')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ provider: 'deepseek', last4: 'abcd' })

    const me = (await (
      await app.request('/api/app/auth/me', { headers: withSid(sid) })
    ).json()) as MeResponse
    expect(me.llmKeys.deepseek).toEqual({ last4: 'abcd' })
    expect(me.llmKeys.moonshot).toBeNull()

    const row = db
      .prepare('SELECT ciphertext FROM user_llm_keys WHERE user_id = ? AND provider = ?')
      .get(userId, 'deepseek') as { ciphertext: Buffer }
    // 密文 BLOB 不含明文 key 字节
    expect(row.ciphertext.includes(Buffer.from(KEY, 'utf8'))).toBe(false)
    // 正确 AAD 能解回原文(P2 网关的读取路径)
    expect(decryptSecret(config.llmKeyMaster, row.ciphertext, llmKeyAad(userId, 'deepseek'))).toBe(
      KEY,
    )
  })

  it('AAD 绑定用户:换 userId 解不开(防密文移植)', async () => {
    const { app, db, config } = createTestApp()
    const userId = await createUser(db, 'liam', 'liam-pass-1234')
    const sid = await login(app, 'liam', 'liam-pass-1234')
    await putKey(app, sid, 'zhipu')
    const row = db
      .prepare('SELECT ciphertext FROM user_llm_keys WHERE user_id = ? AND provider = ?')
      .get(userId, 'zhipu') as { ciphertext: Buffer }
    expect(() =>
      decryptSecret(config.llmKeyMaster, row.ciphertext, llmKeyAad(userId + 1, 'zhipu')),
    ).toThrow()
    expect(() =>
      decryptSecret(config.llmKeyMaster, row.ciphertext, llmKeyAad(userId, 'deepseek')),
    ).toThrow()
  })

  it('重复 PUT 覆盖(仍单行),DELETE 后 me 回 null', async () => {
    const { app, db } = createTestApp()
    const userId = await createUser(db, 'mia', 'mia-pass-12345')
    const sid = await login(app, 'mia', 'mia-pass-12345')
    await putKey(app, sid, 'jina', 'jina_first_key_0000')
    await putKey(app, sid, 'jina', 'jina_second_key_9999')
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM user_llm_keys WHERE user_id = ?')
      .get(userId) as { n: number }
    expect(n).toBe(1)
    const me = (await (
      await app.request('/api/app/auth/me', { headers: withSid(sid) })
    ).json()) as MeResponse
    expect(me.llmKeys.jina).toEqual({ last4: '9999' })

    const del = await app.request('/api/app/me/llm-keys/jina', {
      method: 'DELETE',
      headers: withSid(sid),
    })
    expect(del.status).toBe(200)
    const me2 = (await (
      await app.request('/api/app/auth/me', { headers: withSid(sid) })
    ).json()) as MeResponse
    expect(me2.llmKeys.jina).toBeNull()
  })

  it('provider 不在 allowlist / key 过短 → 400', async () => {
    const { app, db } = createTestApp()
    await createUser(db, 'noah', 'noah-pass-1234')
    const sid = await login(app, 'noah', 'noah-pass-1234')
    expect((await putKey(app, sid, 'openai')).status).toBe(400) // 只认 openai-compat
    expect((await putKey(app, sid, 'deepseek', 'short')).status).toBe(400)
  })
})
