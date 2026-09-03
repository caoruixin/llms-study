/**
 * 语音助手路由:GET /config、POST /transcribe、POST /tts,挂在 /api/app/voice 下
 *(落在现有 nginx `/api/app/` location 内,零 nginx 改动)。
 *
 * 为什么服务端代理而不是浏览器直连厂商:key 不能下发到前端,且大陆可用性要由我们兜底。
 * 防滥用同 fetchUrl 三层——令牌桶(频次)→ 并发闸 → 字节/字符/超时上限;
 * ASR 与 TTS 各自一套桶闸:一条回答会触发 4~8 次合成,共用一套必然互相饿死。
 *
 * key 轮换语义与 LLM 网关一致:同一段字节/同一段文本换 key 重放,
 * 401/403 永久剔除、402/429 冷却 60s(src/lib/keyRotation.ts 纯逻辑)。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import {
  VOICE_ASR_MAX_BYTES,
  VOICE_ASR_MAX_CONCURRENT,
  VOICE_ASR_RATE_CAPACITY,
  VOICE_ASR_RATE_REFILL_MS,
  VOICE_ASR_TIMEOUT_MS,
  VOICE_AUDIO_MIME_ALLOWLIST,
  VOICE_HEADER_LANG,
  VOICE_MAX_UTTERANCE_MS,
  VOICE_TTS_BODY_MAX_BYTES,
  VOICE_TTS_MAX_AUDIO_BYTES,
  VOICE_TTS_MAX_CHARS,
  VOICE_TTS_MAX_CONCURRENT,
  VOICE_TTS_RATE_CAPACITY,
  VOICE_TTS_RATE_REFILL_MS,
  VOICE_TTS_TIMEOUT_MS,
} from '../../../shared/apiRoutes.js'
import type {
  VoiceConfigResponse,
  VoiceTranscribeResponse,
  VoiceTtsBody,
} from '../../../shared/apiTypes.js'
import { classifyKeyFailure, createKeyRotator } from '../../../src/lib/keyRotation.js'
import { requireSession } from '../auth/middleware.js'
import type { Db } from '../db/db.js'
import { apiError } from '../lib/respond.js'
import { createConcurrencyGate, createTokenBucket } from '../llm/rateLimit.js'
import type { AppDeps, AppEnv } from '../types.js'
import { VoiceUpstreamError, type VoiceAdapter, type VoiceLang } from '../voice/adapter.js'
import { createSiliconFlowAdapter } from '../voice/siliconflow.js'

const ALLOWED_AUDIO_MIMES = new Set<string>(VOICE_AUDIO_MIME_ALLOWLIST)
const LANGS = new Set<VoiceLang>(['zh', 'en', 'auto'])

/** text 只校验非空:400 字上限要回 413 而不是 400,所以放到 schema 之外单独判 */
const ttsSchema = z.object({
  text: z.string().min(1),
  voice: z.string().max(64).optional(),
  format: z.enum(['mp3', 'wav']).optional(),
  speed: z.number().min(0.25).max(4).optional(),
})

/** 审计日志:fire-and-forget,写失败绝不影响正在进行的语音请求 */
function logVoiceCall(
  db: Db,
  row: {
    userId: number
    kind: 'asr' | 'tts'
    provider: string
    model: string
    bytesIn: number | null
    charsIn: number | null
    status: number | null
    latencyMs: number
  },
): void {
  try {
    db.prepare(
      `INSERT INTO voice_call_log (user_id, kind, provider, model, bytes_in, chars_in, status, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.userId,
      row.kind,
      row.provider,
      row.model,
      row.bytesIn,
      row.charsIn,
      row.status,
      row.latencyMs,
      Date.now(),
    )
  } catch (e) {
    console.error('[voice] call log 写入失败:', e)
  }
}

/** 只取 media type:MediaRecorder 会带 `;codecs=opus`,参数不参与白名单判定 */
function mediaTypeOf(raw: string | undefined): string {
  return (raw ?? '').split(';')[0].trim().toLowerCase()
}

export function voiceRoutes(deps: AppDeps): Hono<AppEnv> {
  const { db, config } = deps
  const r = new Hono<AppEnv>()
  r.use('*', requireSession(deps))

  const tuning = deps.voiceTuning ?? {}
  const voiceCfg = config.voice
  const adapter: VoiceAdapter | null =
    tuning.adapter ?? (voiceCfg.provider === 'siliconflow' ? createSiliconFlowAdapter() : null)
  // 「可用」= 有适配器且有 key。config 已 fail-fast 保证生产不会出现"配了 provider 没 key",
  // 这里再判一次是给 provider=none 的默认部署和测试留一条不抛异常的退路
  const enabled = adapter !== null && voiceCfg.keys.length > 0

  // 进程级轮换记忆(invalid 剔除 / quota 冷却)跨请求生效;随路由实例创建,测试互不串味
  const rotator = createKeyRotator(voiceCfg.keys)
  const asrBucket = createTokenBucket(
    tuning.rateCapacity ?? VOICE_ASR_RATE_CAPACITY,
    tuning.rateRefillMs ?? VOICE_ASR_RATE_REFILL_MS,
  )
  const asrGate = createConcurrencyGate(VOICE_ASR_MAX_CONCURRENT)
  const ttsBucket = createTokenBucket(
    tuning.ttsRateCapacity ?? VOICE_TTS_RATE_CAPACITY,
    tuning.ttsRateRefillMs ?? VOICE_TTS_RATE_REFILL_MS,
  )
  const ttsGate = createConcurrencyGate(VOICE_TTS_MAX_CONCURRENT)

  /** 全部被剔除/冷却时仍按原序全试一遍:剔除只是优化,不该让请求必然失败(同 LLM 网关) */
  function candidateKeys(): string[] {
    const live = rotator.candidates()
    return live.length > 0 ? live : [...voiceCfg.keys]
  }

  r.get('/config', (c) => {
    if (!enabled || !adapter) {
      const body: VoiceConfigResponse = { enabled: false }
      return c.json(body)
    }
    const body: VoiceConfigResponse = {
      enabled: true,
      provider: adapter.provider,
      providerLabel: adapter.providerLabel,
      asrModel: voiceCfg.asrModel,
      voices: [...adapter.voices],
      defaultVoice: voiceCfg.defaultVoice,
      maxUtteranceMs: VOICE_MAX_UTTERANCE_MS,
      maxAudioBytes: tuning.maxBytes ?? VOICE_ASR_MAX_BYTES,
    }
    return c.json(body)
  })

  r.post('/transcribe', async (c) => {
    // 未配置语音时先短路:静态 503 不做任何工作,没有必要先扣令牌
    if (!enabled || !adapter) return apiError(c, 503, 'voice-unavailable', '本站未启用语音助手')
    const user = c.get('user')

    const taken = asrBucket.take(user.id)
    if (!taken.ok) {
      c.header('Retry-After', String(Math.ceil(taken.retryAfterMs / 1000)))
      return apiError(c, 429, 'rate-limited', '语音请求过于频繁')
    }
    if (!asrGate.tryAcquire(user.id)) {
      c.header('Retry-After', '5')
      return apiError(c, 429, 'rate-limited', '已有语音转写进行中')
    }

    try {
      const mime = mediaTypeOf(c.req.header('content-type'))
      if (!ALLOWED_AUDIO_MIMES.has(mime)) {
        return apiError(c, 415, 'unsupported-content', `不支持的音频格式:${mime || '(未声明)'}`)
      }

      // 字节双闸:先看 Content-Length 快速拒绝,再按实际读到的字节兜底(说谎的客户端)
      const maxBytes = tuning.maxBytes ?? VOICE_ASR_MAX_BYTES
      const declared = Number(c.req.header('content-length') ?? Number.NaN)
      if (Number.isFinite(declared) && declared > maxBytes) {
        return apiError(c, 413, 'invalid-input', '音频超过大小上限')
      }
      const audio = Buffer.from(await c.req.arrayBuffer())
      if (audio.length > maxBytes) {
        return apiError(c, 413, 'invalid-input', '音频超过大小上限')
      }
      if (audio.length === 0) return apiError(c, 400, 'invalid-input', '缺少音频数据')

      const langHeader = (c.req.header(VOICE_HEADER_LANG) ?? '').toLowerCase() as VoiceLang
      const lang: VoiceLang = LANGS.has(langHeader) ? langHeader : 'auto'

      const candidates = candidateKeys()
      let lastError: VoiceUpstreamError | null = null
      for (let i = 0; i < candidates.length; i++) {
        const key = candidates[i]
        const started = Date.now()
        try {
          const result = await adapter.transcribe(
            {
              audio,
              mime,
              lang,
              model: voiceCfg.asrModel,
              timeoutMs: tuning.timeoutMs ?? VOICE_ASR_TIMEOUT_MS,
            },
            key,
            voiceCfg.baseUrl,
          )
          const latencyMs = Date.now() - started
          logVoiceCall(db, {
            userId: user.id,
            kind: 'asr',
            provider: adapter.provider,
            model: voiceCfg.asrModel,
            bytesIn: audio.length,
            charsIn: null,
            status: 200,
            latencyMs,
          })
          // 空转写是正常结果(没说话/纯噪声),前端据此提示"没听清",不是错误
          const body: VoiceTranscribeResponse = {
            text: result.text,
            model: voiceCfg.asrModel,
            latencyMs,
          }
          return c.json(body)
        } catch (e) {
          // 非 VoiceUpstreamError = 本进程 bug,原样冒泡成 500,不该被伪装成上游故障
          if (!(e instanceof VoiceUpstreamError)) throw e
          logVoiceCall(db, {
            userId: user.id,
            kind: 'asr',
            provider: adapter.provider,
            model: voiceCfg.asrModel,
            bytesIn: audio.length,
            charsIn: null,
            status: e.status || null,
            latencyMs: Date.now() - started,
          })
          lastError = e
          const kind = classifyKeyFailure(e.status)
          if (!kind) break // 与 key 无关(超时/5xx):换 key 大概率同样失败,快速失败
          rotator.reportFailure(key, kind)
        }
      }
      return apiError(c, 502, 'voice-upstream-failed', lastError?.message ?? '语音转写失败')
    } finally {
      // 并发名额必须在所有出口归还——包括提前 return 的 413/415 与抛异常路径
      asrGate.release(user.id)
    }
  })

  r.post('/tts', async (c) => {
    if (!enabled || !adapter) return apiError(c, 503, 'voice-unavailable', '本站未启用语音助手')
    const user = c.get('user')

    const taken = ttsBucket.take(user.id)
    if (!taken.ok) {
      c.header('Retry-After', String(Math.ceil(taken.retryAfterMs / 1000)))
      return apiError(c, 429, 'rate-limited', '语音合成请求过于频繁')
    }
    if (!ttsGate.tryAcquire(user.id)) {
      c.header('Retry-After', '5')
      return apiError(c, 429, 'rate-limited', '并发语音合成过多')
    }

    try {
      const declared = Number(c.req.header('content-length') ?? Number.NaN)
      if (Number.isFinite(declared) && declared > VOICE_TTS_BODY_MAX_BYTES) {
        return apiError(c, 413, 'invalid-input', '请求体过大')
      }
      const raw = await c.req.text()
      if (Buffer.byteLength(raw, 'utf8') > VOICE_TTS_BODY_MAX_BYTES) {
        return apiError(c, 413, 'invalid-input', '请求体过大')
      }
      let parsedRaw: unknown
      try {
        parsedRaw = JSON.parse(raw)
      } catch {
        return apiError(c, 400, 'invalid-input', 'body 不是合法 JSON')
      }
      const parsed = ttsSchema.safeParse(parsedRaw)
      if (!parsed.success) {
        const first = parsed.error.issues[0]
        return apiError(
          c,
          400,
          'invalid-input',
          first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'body 不合法',
        )
      }
      const body: VoiceTtsBody = parsed.data
      if (body.text.length > VOICE_TTS_MAX_CHARS) {
        return apiError(c, 413, 'invalid-input', `文本超过 ${VOICE_TTS_MAX_CHARS} 字上限`)
      }
      const voice = body.voice || voiceCfg.defaultVoice
      if (!adapter.voices.some((v) => v.id === voice)) {
        return apiError(c, 400, 'invalid-input', `未知音色:${voice}`)
      }
      const format = body.format ?? 'mp3'

      // 日字符上限(账单兜底):与 admin 日调用限同一套日界语义——本地零点起算,
      // 计每次上游尝试的请求字符数(轮换中失败的那次也烧了配额,不该白送)
      if (voiceCfg.dailyCharLimit > 0) {
        const dayStart = new Date()
        dayStart.setHours(0, 0, 0, 0)
        const { n } = db
          .prepare(
            "SELECT COALESCE(SUM(chars_in), 0) AS n FROM voice_call_log WHERE user_id = ? AND kind = 'tts' AND created_at >= ?",
          )
          .get(user.id, dayStart.getTime()) as { n: number }
        if (n >= voiceCfg.dailyCharLimit) {
          c.header('Retry-After', '3600')
          return apiError(c, 429, 'rate-limited', '已达当日语音合成字符上限')
        }
      }

      const candidates = candidateKeys()
      let lastError: VoiceUpstreamError | null = null
      for (let i = 0; i < candidates.length; i++) {
        const key = candidates[i]
        const started = Date.now()
        try {
          const result = await adapter.synthesize(
            {
              text: body.text,
              voice,
              format,
              speed: body.speed,
              model: voiceCfg.ttsModel,
              timeoutMs: tuning.timeoutMs ?? VOICE_TTS_TIMEOUT_MS,
              maxBytes: VOICE_TTS_MAX_AUDIO_BYTES,
            },
            key,
            voiceCfg.baseUrl,
          )
          logVoiceCall(db, {
            userId: user.id,
            kind: 'tts',
            provider: adapter.provider,
            model: voiceCfg.ttsModel,
            bytesIn: null,
            // 记请求文本长度而非剥离标记后的长度:账单兜底取上界更安全
            charsIn: body.text.length,
            status: 200,
            latencyMs: Date.now() - started,
          })
          // 复制成 Uint8Array:小 Buffer 可能是共享内存池的切片(同 fetchUrl 的理由)
          return new Response(new Uint8Array(result.audio), {
            status: 200,
            headers: {
              'Content-Type': result.contentType,
              'Content-Length': String(result.audio.length),
              // 合成音频播毕即弃,不留在任何缓存层——这是隐私口径的一部分
              'Cache-Control': 'no-store',
            },
          })
        } catch (e) {
          if (!(e instanceof VoiceUpstreamError)) throw e
          logVoiceCall(db, {
            userId: user.id,
            kind: 'tts',
            provider: adapter.provider,
            model: voiceCfg.ttsModel,
            bytesIn: null,
            charsIn: body.text.length,
            status: e.status || null,
            latencyMs: Date.now() - started,
          })
          lastError = e
          const kind = classifyKeyFailure(e.status)
          if (!kind) break
          rotator.reportFailure(key, kind)
        }
      }
      return apiError(c, 502, 'voice-upstream-failed', lastError?.message ?? '语音合成失败')
    } finally {
      ttsGate.release(user.id)
    }
  })

  return r
}
