/**
 * 用户 LLM key 保管:PUT/DELETE /me/llm-keys/:provider。
 * 明文只在请求处理的内存里存在一瞬:入库前 AES-256-GCM 加密(AAD 绑定 userId+provider),
 * 响应与 /auth/me 永远只回 last4。P2 网关调用上游时才解密。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { LLM_KEY_MAX, LLM_KEY_MIN } from '../../../shared/apiRoutes.js'
import {
  LLM_PROVIDERS,
  type LlmProvider,
  type OkResponse,
  type PutLlmKeyResponse,
} from '../../../shared/apiTypes.js'
import { requireSession } from '../auth/middleware.js'
import { encryptSecret, llmKeyAad } from '../lib/crypto.js'
import { apiError } from '../lib/respond.js'
import { readJson } from '../lib/validate.js'
import type { AppDeps, AppEnv } from '../types.js'

const putKeySchema = z.object({ key: z.string().max(LLM_KEY_MAX * 2) })

function asProvider(raw: string): LlmProvider | null {
  return (LLM_PROVIDERS as readonly string[]).includes(raw) ? (raw as LlmProvider) : null
}

export function llmKeysRoutes(deps: AppDeps): Hono<AppEnv> {
  const { db, config } = deps
  const r = new Hono<AppEnv>()
  r.use('*', requireSession(deps))

  r.put('/:provider', async (c) => {
    const provider = asProvider(c.req.param('provider'))
    if (!provider) return apiError(c, 400, 'invalid-input', '未知 provider')
    const body = await readJson(c, putKeySchema)
    if (!body.ok) return body.res
    const key = body.data.key.trim()
    if (key.length < LLM_KEY_MIN || key.length > LLM_KEY_MAX) {
      return apiError(c, 400, 'invalid-input', `key 长度须在 ${LLM_KEY_MIN}-${LLM_KEY_MAX} 之间`)
    }
    const user = c.get('user')
    const ciphertext = encryptSecret(config.llmKeyMaster, key, llmKeyAad(user.id, provider))
    const now = Date.now()
    db.prepare(
      `INSERT INTO user_llm_keys (user_id, provider, ciphertext, last4, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         ciphertext = excluded.ciphertext, last4 = excluded.last4, updated_at = excluded.updated_at`,
    ).run(user.id, provider, ciphertext, key.slice(-4), now, now)
    const resBody: PutLlmKeyResponse = { provider, last4: key.slice(-4) }
    return c.json(resBody)
  })

  // 幂等:删不存在的 key 也回 ok(前端"清除"按钮不需要区分)
  r.delete('/:provider', (c) => {
    const provider = asProvider(c.req.param('provider'))
    if (!provider) return apiError(c, 400, 'invalid-input', '未知 provider')
    db.prepare('DELETE FROM user_llm_keys WHERE user_id = ? AND provider = ?').run(
      c.get('user').id,
      provider,
    )
    const ok: OkResponse = { ok: true }
    return c.json(ok)
  })

  return r
}
