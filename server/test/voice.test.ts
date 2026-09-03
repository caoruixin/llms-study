/**
 * 语音路由:鉴权、可用性开关、转写/合成回环、字节与字符上限、限流(桶+闸)、
 * key 轮换与全失败、日字符上限、超时后并发名额归还。
 *
 * 适配器走 deps.voiceTuning.adapter 注入的纯内存实现——**零网络**。
 * 与 llmGateway.test.ts 起 http stub 的做法不同,理由:语音上游的真实面是 multipart 拼装
 * 与厂商响应形状,起本地 stub 只能测到我们自己写的那半边;而路由要验的是轮换/限流/审计,
 * 用可编程的假适配器才能精确构造"k1 401、k2 成功"和"超时"这类分支。
 */
import { describe, expect, it } from 'vitest'
import { VOICE_TTS_MAX_CHARS } from '../../shared/apiRoutes.js'
import type { Config } from '../src/config.js'
import {
  VoiceUpstreamError,
  type SynthesizeRequest,
  type SynthesizeResult,
  type TranscribeRequest,
  type TranscribeResult,
  type VoiceAdapter,
} from '../src/voice/adapter.js'
import { createTestApp, createUser, login, postJson, withSid, type TestCtx } from './helpers.js'

const CONFIG_PATH = '/api/app/voice/config'
const ASR_PATH = '/api/app/voice/transcribe'
const TTS_PATH = '/api/app/voice/tts'

interface AsrCall {
  key: string
  mime: string
  lang: string
  bytes: number
  baseUrl: string
}
interface TtsCall {
  key: string
  text: string
  voice: string
  format: string
  model: string
}

interface FakeAdapter extends VoiceAdapter {
  asrCalls: AsrCall[]
  ttsCalls: TtsCall[]
}

/**
 * 可编程假适配器。onTranscribe/onSynthesize 抛 VoiceUpstreamError 即模拟上游失败;
 * 抛 status=0 的那种即模拟超时(与 key 无关,不触发轮换)。
 */
function makeAdapter(opts: {
  onTranscribe?: (req: TranscribeRequest, key: string) => Promise<TranscribeResult> | TranscribeResult
  onSynthesize?: (req: SynthesizeRequest, key: string) => Promise<SynthesizeResult> | SynthesizeResult
} = {}): FakeAdapter {
  const asrCalls: AsrCall[] = []
  const ttsCalls: TtsCall[] = []
  return {
    provider: 'fake',
    providerLabel: '假上游',
    voices: [
      { id: 'anna', label: '沉稳女声' },
      { id: 'david', label: '欢快男声' },
    ],
    asrCalls,
    ttsCalls,
    async transcribe(req, key, baseUrl) {
      asrCalls.push({ key, mime: req.mime, lang: req.lang, bytes: req.audio.length, baseUrl })
      if (opts.onTranscribe) return await opts.onTranscribe(req, key)
      return { text: '这是转写结果' }
    },
    async synthesize(req, key) {
      ttsCalls.push({ key, text: req.text, voice: req.voice, format: req.format, model: req.model })
      if (opts.onSynthesize) return await opts.onSynthesize(req, key)
      return { audio: Buffer.from('FAKE-MP3-BYTES'), contentType: 'audio/mpeg' }
    },
  }
}

function voiceConfig(overrides: Partial<Config['voice']> = {}): Config['voice'] {
  return {
    provider: 'siliconflow',
    keys: ['k1'],
    baseUrl: 'https://upstream.test',
    asrModel: 'asr-model-1',
    ttsModel: 'tts-model-1',
    defaultVoice: 'anna',
    dailyCharLimit: 0,
    ...overrides,
  }
}

interface VoiceCtx {
  ctx: TestCtx
  sid: string
  adapter: FakeAdapter
  asr(bytes: Buffer, headers?: Record<string, string>): Promise<Response>
  tts(body: unknown): Promise<Response>
}

async function setup(
  opts: {
    adapter?: FakeAdapter
    voice?: Partial<Config['voice']>
    tuning?: NonNullable<Parameters<typeof createTestApp>[1]>['voiceTuning']
  } = {},
): Promise<VoiceCtx> {
  const adapter = opts.adapter ?? makeAdapter()
  const ctx = createTestApp(
    { voice: voiceConfig(opts.voice) },
    { voiceTuning: { adapter, ...opts.tuning } },
  )
  await createUser(ctx.db, 'alice', 'password-1')
  const sid = await login(ctx.app, 'alice', 'password-1')
  return {
    ctx,
    sid,
    adapter,
    asr: async (bytes, headers = {}) =>
      await ctx.app.request(ASR_PATH, {
        method: 'POST',
        headers: { 'content-type': 'audio/webm;codecs=opus', ...withSid(sid), ...headers },
        body: new Uint8Array(bytes),
      }),
    tts: async (body) => await ctx.app.request(TTS_PATH, postJson(body, withSid(sid))),
  }
}

interface LogRow {
  kind: string
  provider: string
  model: string | null
  bytes_in: number | null
  chars_in: number | null
  status: number | null
  latency_ms: number | null
}
function logRows(ctx: TestCtx): LogRow[] {
  return ctx.db
    .prepare(
      'SELECT kind, provider, model, bytes_in, chars_in, status, latency_ms FROM voice_call_log ORDER BY id',
    )
    .all() as LogRow[]
}

/** 一段足以过"非空"闸的假音频 */
const audio = (n = 4096): Buffer => Buffer.alloc(n, 7)

describe('鉴权与可用性', () => {
  it('未登录 → 401,不触达适配器', async () => {
    const v = await setup()
    const cfg = await v.ctx.app.request(CONFIG_PATH)
    expect(cfg.status).toBe(401)
    const asr = await v.ctx.app.request(ASR_PATH, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: new Uint8Array(audio()),
    })
    expect(asr.status).toBe(401)
    expect(await asr.json()).toEqual({ error: 'unauthenticated' })
    const tts = await v.ctx.app.request(TTS_PATH, postJson({ text: '你好' }))
    expect(tts.status).toBe(401)
    expect(v.adapter.asrCalls).toHaveLength(0)
    expect(v.adapter.ttsCalls).toHaveLength(0)
  })

  it('GET /config:启用时回模型与音色表,provider=none 只回 {enabled:false}', async () => {
    const on = await setup()
    const res = await on.ctx.app.request(CONFIG_PATH, { headers: withSid(on.sid) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      enabled: true,
      provider: 'fake',
      providerLabel: '假上游',
      asrModel: 'asr-model-1',
      voices: [
        { id: 'anna', label: '沉稳女声' },
        { id: 'david', label: '欢快男声' },
      ],
      defaultVoice: 'anna',
      maxUtteranceMs: 30_000,
      maxAudioBytes: 2 * 1024 * 1024,
    })

    // 关闭态:不注入适配器 + provider=none
    const off = createTestApp({ voice: voiceConfig({ provider: 'none', keys: [] }) })
    await createUser(off.db, 'bob', 'password-1')
    const sid = await login(off.app, 'bob', 'password-1')
    const offRes = await off.app.request(CONFIG_PATH, { headers: withSid(sid) })
    expect(offRes.status).toBe(200)
    expect(await offRes.json()).toEqual({ enabled: false })
  })

  it('配了适配器但 key 列表为空 → /config 关闭且 transcribe/tts 均 503 voice-unavailable', async () => {
    const v = await setup({ voice: { keys: [] } })
    expect(await (await v.ctx.app.request(CONFIG_PATH, { headers: withSid(v.sid) })).json()).toEqual({
      enabled: false,
    })
    const asr = await v.asr(audio())
    expect(asr.status).toBe(503)
    expect(await asr.json()).toMatchObject({ error: 'voice-unavailable' })
    const tts = await v.tts({ text: '你好' })
    expect(tts.status).toBe(503)
    expect(await tts.json()).toMatchObject({ error: 'voice-unavailable' })
    expect(v.adapter.asrCalls).toHaveLength(0)
  })
})

describe('转写', () => {
  it('happy path:原始字节直传适配器,回 {text,model,latencyMs} 并落审计行', async () => {
    const v = await setup()
    const res = await v.asr(audio(1234), { [`x-voice-lang`]: 'zh' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { text: string; model: string; latencyMs: number }
    expect(body.text).toBe('这是转写结果')
    expect(body.model).toBe('asr-model-1')
    expect(body.latencyMs).toBeGreaterThanOrEqual(0)

    // mime 只取 media type(codecs 参数不进适配器),lang 头透传,baseUrl 来自 config
    expect(v.adapter.asrCalls).toEqual([
      { key: 'k1', mime: 'audio/webm', lang: 'zh', bytes: 1234, baseUrl: 'https://upstream.test' },
    ])
    expect(logRows(v.ctx)).toEqual([
      {
        kind: 'asr',
        provider: 'fake',
        model: 'asr-model-1',
        bytes_in: 1234,
        chars_in: null,
        status: 200,
        latency_ms: expect.any(Number),
      },
    ])
  })

  it('空转写 = 200 {text:""},不是错误', async () => {
    const v = await setup({ adapter: makeAdapter({ onTranscribe: () => ({ text: '' }) }) })
    const res = await v.asr(audio())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ text: '' })
    expect(logRows(v.ctx)[0].status).toBe(200)
  })

  it('413 双路径:Content-Length 预检与实读字节兜底都拒,均不触达适配器', async () => {
    const v = await setup({ tuning: { maxBytes: 1000 } })
    // 路径一:声明超限(fetch 会按 body 长度自动写 content-length)
    const declared = await v.asr(audio(2000))
    expect(declared.status).toBe(413)
    expect(await declared.json()).toMatchObject({ error: 'invalid-input' })

    // 路径二:content-length 说谎(声明 10,实际 2000),按实读字节拒
    const lying = await v.ctx.app.request(ASR_PATH, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm', 'content-length': '10', ...withSid(v.sid) },
      body: new Uint8Array(audio(2000)),
    })
    expect(lying.status).toBe(413)
    expect(v.adapter.asrCalls).toHaveLength(0)
  })

  it('非白名单 Content-Type → 415 unsupported-content;空 body → 400', async () => {
    const v = await setup()
    for (const ct of ['application/json', 'video/mp4', 'audio/flac']) {
      const res = await v.asr(audio(64), { 'content-type': ct })
      expect(res.status).toBe(415)
      expect(await res.json()).toMatchObject({ error: 'unsupported-content' })
    }
    const empty = await v.asr(Buffer.alloc(0))
    expect(empty.status).toBe(400)
    expect(v.adapter.asrCalls).toHaveLength(0)
  })

  it('限流:令牌桶耗尽 → 429 + Retry-After;并发闸 1 挡住第二个在飞请求', async () => {
    // 桶容量 2:第 3 次即 429
    const bucketCtx = await setup({ tuning: { rateCapacity: 2, rateRefillMs: 60_000 } })
    expect((await bucketCtx.asr(audio())).status).toBe(200)
    expect((await bucketCtx.asr(audio())).status).toBe(200)
    const limited = await bucketCtx.asr(audio())
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: 'rate-limited' })
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)

    // 并发闸:第一个请求挂住不返回时,第二个必须被 429 拒(桶给足容量,排除桶的干扰)
    let release = (): void => {}
    const blocked = new Promise<void>((r) => {
      release = r
    })
    const gateCtx = await setup({
      adapter: makeAdapter({
        onTranscribe: async () => {
          await blocked
          return { text: 'ok' }
        },
      }),
    })
    const first = gateCtx.asr(audio())
    // 让第一个请求真正进到适配器里挂住,再发第二个
    await new Promise((r) => setTimeout(r, 20))
    const second = await gateCtx.asr(audio())
    expect(second.status).toBe(429)
    expect(second.headers.get('retry-after')).toBe('5')
    release()
    expect((await first).status).toBe(200)
  })
})

describe('key 轮换与上游失败', () => {
  it('k1 401 → 剔除并换 k2 → 200,两条审计行;下一请求直接从 k2 起', async () => {
    const adapter = makeAdapter({
      onTranscribe: (_req, key) => {
        if (key === 'k1') throw new VoiceUpstreamError(401, '语音转写上游返回 401')
        return { text: 'via k2' }
      },
    })
    const v = await setup({ adapter, voice: { keys: ['k1', 'k2'] } })
    const res = await v.asr(audio())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ text: 'via k2' })
    expect(adapter.asrCalls.map((c) => c.key)).toEqual(['k1', 'k2'])
    expect(logRows(v.ctx).map((r) => r.status)).toEqual([401, 200])

    const again = await v.asr(audio())
    expect(again.status).toBe(200)
    // k1 已被进程内剔除
    expect(adapter.asrCalls.map((c) => c.key)).toEqual(['k1', 'k2', 'k2'])
  })

  it('全部 key 失败 → 502 voice-upstream-failed,审计记录每次尝试', async () => {
    const adapter = makeAdapter({
      onTranscribe: (_req, key) => {
        throw new VoiceUpstreamError(key === 'k1' ? 401 : 429, `${key} 挂了`)
      },
    })
    const v = await setup({ adapter, voice: { keys: ['k1', 'k2'] } })
    const res = await v.asr(audio())
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: 'voice-upstream-failed', message: 'k2 挂了' })
    expect(adapter.asrCalls).toHaveLength(2)
    expect(logRows(v.ctx).map((r) => r.status)).toEqual([401, 429])
  })

  it('超时(status=0,与 key 无关)→ 只试一次即 502,且并发名额已归还', async () => {
    let failNext = true
    const adapter = makeAdapter({
      onTranscribe: () => {
        if (failNext) {
          failNext = false
          throw new VoiceUpstreamError(0, '语音转写请求超时')
        }
        return { text: '恢复了' }
      },
    })
    const v = await setup({ adapter, voice: { keys: ['k1', 'k2'] } })
    const res = await v.asr(audio())
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({
      error: 'voice-upstream-failed',
      message: '语音转写请求超时',
    })
    // 快速失败:不换 key 重试
    expect(adapter.asrCalls.map((c) => c.key)).toEqual(['k1'])
    expect(logRows(v.ctx)).toEqual([
      expect.objectContaining({ kind: 'asr', status: null, bytes_in: 4096 }),
    ])

    // 闸门在 finally 归还:紧接着的请求不该被卡死
    const next = await v.asr(audio())
    expect(next.status).toBe(200)
  })
})

describe('合成', () => {
  it('happy path:回音频字节 + no-store,审计行记 chars_in;voice/format 缺省走服务端默认', async () => {
    const v = await setup()
    const res = await v.tts({ text: '先说结论,再展开。' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(bytes.toString('utf8')).toBe('FAKE-MP3-BYTES')
    expect(res.headers.get('content-length')).toBe(String(bytes.length))

    expect(v.adapter.ttsCalls).toEqual([
      { key: 'k1', text: '先说结论,再展开。', voice: 'anna', format: 'mp3', model: 'tts-model-1' },
    ])
    expect(logRows(v.ctx)).toEqual([
      {
        kind: 'tts',
        provider: 'fake',
        model: 'tts-model-1',
        bytes_in: null,
        chars_in: 9,
        status: 200,
        latency_ms: expect.any(Number),
      },
    ])
  })

  it('文本超 400 字 → 413;body 超 8KiB → 413;未知音色 → 400', async () => {
    const v = await setup()
    const tooLong = await v.tts({ text: '字'.repeat(VOICE_TTS_MAX_CHARS + 1) })
    expect(tooLong.status).toBe(413)
    expect(await tooLong.json()).toMatchObject({ error: 'invalid-input' })

    // 8KiB 闸在 400 字闸之前:超大 body 根本不进 JSON 解析
    const hugeBody = await v.tts({ text: '你好', pad: 'x'.repeat(9000) })
    expect(hugeBody.status).toBe(413)

    const badVoice = await v.tts({ text: '你好', voice: 'nobody' })
    expect(badVoice.status).toBe(400)
    expect(await badVoice.json()).toMatchObject({ error: 'invalid-input' })
    expect(v.adapter.ttsCalls).toHaveLength(0)
  })

  it('日字符上限:累计达标后 429 + Retry-After,且不再触达适配器', async () => {
    const v = await setup({ voice: { dailyCharLimit: 10 } })
    // 第一次 8 字 → 放行(8 < 10);此时累计 8
    expect((await v.tts({ text: '一二三四五六七八' })).status).toBe(200)
    // 第二次 3 字 → 仍放行(8 < 10),累计 11
    expect((await v.tts({ text: '九十甲' })).status).toBe(200)
    const limited = await v.tts({ text: '乙' })
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: 'rate-limited' })
    expect(limited.headers.get('retry-after')).toBe('3600')
    expect(v.adapter.ttsCalls).toHaveLength(2)

    // 昨天的调用不算进今天:日界是本地零点
    const yesterday = Date.now() - 26 * 60 * 60 * 1000
    v.ctx.db.prepare('UPDATE voice_call_log SET created_at = ?').run(yesterday)
    expect((await v.tts({ text: '丙' })).status).toBe(200)
  })

  it('合成上游失败:轮换后仍全失败 → 502,合成侧桶与闸同样在出口归还', async () => {
    let calls = 0
    const adapter = makeAdapter({
      onSynthesize: () => {
        calls += 1
        if (calls <= 2) throw new VoiceUpstreamError(429, '配额用尽')
        return { audio: Buffer.from('OK'), contentType: 'audio/wav' }
      },
    })
    const v = await setup({ adapter, voice: { keys: ['k1', 'k2'] } })
    const failed = await v.tts({ text: '你好', format: 'wav' })
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({ error: 'voice-upstream-failed' })
    expect(adapter.ttsCalls.map((c) => c.key)).toEqual(['k1', 'k2'])
    expect(logRows(v.ctx).map((r) => r.status)).toEqual([429, 429])

    // 两个 key 都在冷却里,但候选为空时按原序全试一遍 → 第三次调用成功
    const ok = await v.tts({ text: '你好', format: 'wav' })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('audio/wav')
  })
})
