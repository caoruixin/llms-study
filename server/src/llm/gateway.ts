/**
 * LLM 网关(P2,安全目标达成点):/api/{provider}/* 的鉴权透传代理。
 *
 * 为什么全量缓冲请求体(≤2MB):多 key 故障转移要求"同一请求换 key 重发"。
 * 上游响应 status 在向客户端转发首字节之前就已知,所以 SSE 与非流式
 * 都能做请求内重试——失败的上游响应直接丢弃,换 key 重发缓冲的 body。
 *
 * key 注入策略:
 * - admin → 服务端 key 列表(SERVER_*_KEYS),按序故障转移(keyRotation 纯逻辑);
 *   列表为空时回落到 admin 本人配置的 key(admin 也可能想烧自己的额度);
 * - 普通用户 → 解密 user_llm_keys;无 key → 403 + X-LLM-Deny(前端引导去配 key);
 *   单 key 不轮换,失败原样透出(上游错误信息对用户排查自己的 key 有价值)。
 * 入站 Authorization/X-User-Key 一律不转发(上游头是白名单构造的)。
 */
import { Hono, type Context } from 'hono'
import {
  LLM_MAX_CONCURRENT_STREAMS,
  LLM_PROXY_MAX_BODY_BYTES,
  LLM_RATE_CAPACITY,
  LLM_RATE_REFILL_MS,
} from '../../../shared/apiRoutes.js'
import {
  LLM_PROVIDERS,
  type LlmDenyBody,
  type LlmProvider,
} from '../../../shared/apiTypes.js'
import {
  classifyKeyFailure,
  createKeyRotator,
  type KeyRotator,
} from '../../../src/lib/keyRotation.js'
import { requireSession } from '../auth/middleware.js'
import type { Db, UserLlmKeyRow, UserRow } from '../db/db.js'
import { decryptSecret, llmKeyAad } from '../lib/crypto.js'
import { apiError } from '../lib/respond.js'
import type { AppDeps, AppEnv } from '../types.js'
import { PROVIDER_ALLOWED_PATHS } from './providers.js'
import { createConcurrencyGate, createTokenBucket, tapStream } from './rateLimit.js'

interface ResolvedKeys {
  source: 'server' | 'user'
  keys: string[]
}

/** 审计日志:fire-and-forget,写失败绝不影响正在进行的代理请求 */
function logCall(
  db: Db,
  row: {
    userId: number
    provider: LlmProvider
    model: string | null
    keySource: 'server' | 'user'
    status: number | null
    latencyMs: number
  },
): void {
  try {
    db.prepare(
      `INSERT INTO llm_call_log (user_id, provider, model, key_source, status, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.userId, row.provider, row.model, row.keySource, row.status, row.latencyMs, Date.now())
  } catch (e) {
    console.error('[llm] call log 写入失败:', e)
  }
}

export function llmGatewayRoutes(deps: AppDeps): Hono<AppEnv> {
  const { db, config } = deps
  const r = new Hono<AppEnv>()

  // 进程级状态:服务端 key 的轮换记忆(invalid 剔除/quota 冷却)跨请求生效
  const rotators = new Map<LlmProvider, KeyRotator>()
  const rotatorFor = (provider: LlmProvider): KeyRotator => {
    let rot = rotators.get(provider)
    if (!rot) {
      rot = createKeyRotator(config.serverLlmKeys[provider])
      rotators.set(provider, rot)
    }
    return rot
  }

  const tuning = deps.llmTuning ?? {}
  const bucket = createTokenBucket(
    tuning.rateCapacity ?? LLM_RATE_CAPACITY,
    tuning.rateRefillMs ?? LLM_RATE_REFILL_MS,
  )
  const streamGate = createConcurrencyGate(tuning.maxStreams ?? LLM_MAX_CONCURRENT_STREAMS)

  function resolveKeys(user: UserRow, provider: LlmProvider): ResolvedKeys | null {
    if (user.role === 'admin' && config.serverLlmKeys[provider].length > 0) {
      return { source: 'server', keys: config.serverLlmKeys[provider] }
    }
    const row = db
      .prepare('SELECT * FROM user_llm_keys WHERE user_id = ? AND provider = ?')
      .get(user.id, provider) as UserLlmKeyRow | undefined
    if (!row) return null
    try {
      const key = decryptSecret(config.llmKeyMaster, row.ciphertext, llmKeyAad(user.id, provider))
      return { source: 'user', keys: [key] }
    } catch {
      // 解密失败 = 密文损坏/主密钥换过,视同没有 key(用户重存一次即恢复)
      return null
    }
  }

  function makeHandler(provider: LlmProvider, path: string) {
    return async (c: Context<AppEnv>): Promise<Response> => {
      const user = c.get('user')

      // 1) 每用户令牌桶(与前端同参,前端拿到 429+Retry-After 会自行退避)
      const taken = bucket.take(user.id)
      if (!taken.ok) {
        c.header('Retry-After', String(Math.ceil(taken.retryAfterMs / 1000)))
        return apiError(c, 429, 'rate-limited', '请求过于频繁')
      }

      // 2) 请求体:先看 Content-Length 快速拒绝,再按实际读到的字节兜底
      const declared = Number(c.req.header('content-length') ?? Number.NaN)
      if (Number.isFinite(declared) && declared > LLM_PROXY_MAX_BODY_BYTES) {
        return apiError(c, 413, 'invalid-input', 'body 超过 2MB 上限')
      }
      const bodyBuf = Buffer.from(await c.req.arrayBuffer())
      if (bodyBuf.length > LLM_PROXY_MAX_BODY_BYTES) {
        return apiError(c, 413, 'invalid-input', 'body 超过 2MB 上限')
      }

      // model/stream 从 body 提取(审计与并发闸门用);非 JSON body 容错为 null/false
      let model: string | null = null
      let isStream = false
      try {
        const parsed = JSON.parse(bodyBuf.toString('utf8')) as Record<string, unknown>
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.model === 'string') model = parsed.model
          isStream = parsed.stream === true
        }
      } catch {
        /* jina 等均为 JSON,这里只是防御 */
      }

      // 3) key 解析
      const resolved = resolveKeys(user, provider)
      if (!resolved) {
        const deny: LlmDenyBody = { error: 'no-user-key', provider }
        c.header('X-LLM-Deny', 'no-user-key')
        return c.json(deny, 403)
      }

      // 4) admin 走服务端 key 的日调用上限(账单兜底;计每次上游尝试)
      if (resolved.source === 'server' && config.adminDailyCallLimit > 0) {
        const dayStart = new Date()
        dayStart.setHours(0, 0, 0, 0)
        const { n } = db
          .prepare(
            "SELECT COUNT(*) AS n FROM llm_call_log WHERE user_id = ? AND key_source = 'server' AND created_at >= ?",
          )
          .get(user.id, dayStart.getTime()) as { n: number }
        if (n >= config.adminDailyCallLimit) {
          c.header('Retry-After', '3600')
          return apiError(c, 429, 'rate-limited', '已达服务端 key 当日调用上限')
        }
      }

      // 5) 并发 SSE 闸门:release 挂在响应流结束/取消/出错上,不是 handler 返回时
      let releaseStream: (() => void) | null = null
      if (isStream) {
        if (!streamGate.tryAcquire(user.id)) {
          c.header('Retry-After', '5')
          return apiError(c, 429, 'rate-limited', '并发流式请求过多')
        }
        let released = false
        releaseStream = () => {
          if (!released) {
            released = true
            streamGate.release(user.id)
          }
        }
      }

      try {
        // 6) 按序故障转移:server key 走 rotator;user 单 key 恰好是长度 1 的退化情形
        const rotator = resolved.source === 'server' ? rotatorFor(provider) : null
        let candidates = rotator ? rotator.candidates() : resolved.keys
        // 全部被剔除/冷却时仍按原序全试一遍:剔除与冷却只是优化,不该让请求必然失败
        // (上游侧可能已恢复;真不行也能拿到真实的上游错误而非编造的 5xx)
        if (candidates.length === 0) candidates = [...resolved.keys]

        const upstreamUrl = config.llmUpstreams[provider] + path
        let upstream: Response | undefined

        for (let i = 0; i < candidates.length; i++) {
          const key = candidates[i]
          const headers: Record<string, string> = {
            'content-type': c.req.header('content-type') ?? 'application/json',
            authorization: `Bearer ${key}`,
          }
          const accept = c.req.header('accept')
          if (accept) headers.accept = accept

          const started = Date.now()
          let res: Response
          try {
            res = await fetch(upstreamUrl, { method: 'POST', headers, body: bodyBuf })
          } catch (e) {
            // 网络层失败与 key 无关(同一上游主机),换 key 重试大概率同样失败——快速失败
            logCall(db, {
              userId: user.id,
              provider,
              model,
              keySource: resolved.source,
              status: null,
              latencyMs: Date.now() - started,
            })
            console.error(`[llm] ${provider} 上游连接失败:`, e)
            return apiError(c, 502, 'internal', '上游连接失败')
          }
          logCall(db, {
            userId: user.id,
            provider,
            model,
            keySource: resolved.source,
            status: res.status,
            latencyMs: Date.now() - started,
          })

          const kind = classifyKeyFailure(res.status)
          if (rotator && kind) {
            rotator.reportFailure(key, kind)
            if (i < candidates.length - 1) {
              // 失败响应体不再需要,取消掉释放连接,换下一 key 重发同一请求
              void res.body?.cancel().catch(() => undefined)
              continue
            }
          }
          upstream = res
          break
        }
        if (!upstream) {
          // 理论不可达(candidates 非空必有 break/return),防御性兜底
          releaseStream?.()
          return apiError(c, 502, 'internal')
        }

        // 7) 透传:status/content-type 原样;不复制 content-length/content-encoding
        //(undici 已自动解压,长度头会与实际字节不符)
        const headers = new Headers()
        const ct = upstream.headers.get('content-type')
        if (ct) headers.set('content-type', ct)
        headers.set('cache-control', 'no-store')
        // nginx 侧禁 buffering 的双保险之一(另一半是 location 级 proxy_buffering off)
        headers.set('x-accel-buffering', 'no')

        let body: ReadableStream<Uint8Array> | null = upstream.body
        if (body && releaseStream) body = tapStream(body, releaseStream)
        else releaseStream?.()
        return new Response(body, { status: upstream.status, headers })
      } catch (e) {
        releaseStream?.()
        throw e
      }
    }
  }

  for (const provider of LLM_PROVIDERS) {
    for (const path of PROVIDER_ALLOWED_PATHS[provider]) {
      // 只注册 allowlist 内的 POST 路由:其余 path/method 落到根 notFound → 404
      r.post(`/${provider}${path}`, requireSession(deps), makeHandler(provider, path))
    }
  }
  return r
}
