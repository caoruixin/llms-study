import { afterEach, describe, expect, it } from 'vitest'
import {
  getVoiceConfig,
  mapVoiceHttpError,
  synthesizeSpeech,
  transcribeAudio,
  VoiceApiError,
  VOICE_LANG_HEADER,
} from './voiceApi'

const realFetch = globalThis.fetch

interface Call {
  url: string
  init: RequestInit
}

let calls: Call[] = []

afterEach(() => {
  globalThis.fetch = realFetch
  calls = []
})

interface StubInit {
  status?: number
  json?: unknown
  /** 非 JSON 响应体（TTS 音频） */
  bytes?: ArrayBuffer
  headers?: Record<string, string>
  /** 让 res.json() 抛（服务端返回了 HTML 错误页等） */
  brokenJson?: boolean
}

function stub(init: StubInit): void {
  const status = init.status ?? 200
  globalThis.fetch = (async (url: RequestInfo | URL, opts: RequestInit = {}) => {
    calls.push({ url: String(url), init: opts })
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(init.headers ?? {}),
      json: async () => {
        if (init.brokenJson) throw new SyntaxError('Unexpected token <')
        return init.json
      },
      arrayBuffer: async () => init.bytes ?? new ArrayBuffer(0),
    } as unknown as Response
  }) as typeof globalThis.fetch
}

function stubThrow(e: unknown): void {
  globalThis.fetch = (async () => {
    throw e
  }) as typeof globalThis.fetch
}

const audio = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm;codecs=opus' })

describe('mapVoiceHttpError · 状态码/错误码 → kind + 中文文案', () => {
  const table: [number, string | null, string, boolean][] = [
    [401, 'unauthenticated', 'auth', false],
    [403, null, 'auth', false],
    [413, null, 'too-large', false],
    [415, 'unsupported-content', 'unsupported', false],
    [429, 'rate-limited', 'rate-limit', true],
    [502, 'voice-upstream-failed', 'upstream', true],
    [503, 'voice-unavailable', 'unavailable', false],
    [504, null, 'timeout', true],
  ]

  for (const [status, code, kind, retryable] of table) {
    it(`${status}${code ? ` / ${code}` : ''} → ${kind}（retryable=${retryable}）`, () => {
      const err = mapVoiceHttpError(status, code)
      expect(err).toBeInstanceOf(VoiceApiError)
      expect(err.kind).toBe(kind)
      expect(err.retryable).toBe(retryable)
      expect(err.status).toBe(status)
      expect(err.message).toMatch(/[一-鿿]/) // 一律中文文案
    })
  }

  it('错误码比状态码更权威（网关把 503 包成了 500 等情形）', () => {
    expect(mapVoiceHttpError(500, 'voice-unavailable').kind).toBe('unavailable')
  })

  it('都认不出来时才退到服务端 message', () => {
    expect(mapVoiceHttpError(418, 'weird', '服务端说的话').message).toBe('服务端说的话')
    expect(mapVoiceHttpError(418, null, null).kind).toBe('unsupported')
    expect(mapVoiceHttpError(500, null, null).kind).toBe('upstream')
  })
})

describe('getVoiceConfig', () => {
  it('打到 /api/app/voice/config，同源带 cookie', async () => {
    stub({ json: { enabled: true, provider: 'siliconflow', providerLabel: '硅基流动', asrModel: 'SenseVoiceSmall' } })
    const cfg = await getVoiceConfig()
    expect(calls[0].url).toBe('/api/app/voice/config')
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].init.credentials).toBe('same-origin')
    expect(cfg).toMatchObject({ enabled: true, provider: 'siliconflow', providerLabel: '硅基流动' })
  })

  it('归一化：enabled 非 true 视为关闭，音色缺 label 时用 id 兜底，脏数据剔除', async () => {
    stub({
      json: {
        enabled: 'yes',
        voices: [{ id: 'anna', label: '安娜' }, { id: 'alex' }, { label: '没有 id' }],
        maxAudioBytes: 2097152,
        maxUtteranceMs: 'x',
      },
    })
    const cfg = await getVoiceConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.voices).toEqual([
      { id: 'anna', label: '安娜' },
      { id: 'alex', label: 'alex' },
    ])
    expect(cfg.maxAudioBytes).toBe(2097152)
    expect(cfg.maxUtteranceMs).toBeUndefined()
  })

  it('401 → auth 错误（调用方据此当作语音不可用）', async () => {
    stub({ status: 401, json: { error: 'unauthenticated' } })
    await expect(getVoiceConfig()).rejects.toMatchObject({ kind: 'auth', retryable: false })
  })

  it('响应不是 JSON → upstream 错误', async () => {
    stub({ brokenJson: true })
    await expect(getVoiceConfig()).rejects.toMatchObject({ kind: 'upstream' })
  })
})

describe('transcribeAudio', () => {
  it('原始字节直传：Content-Type = blob.type，语言走 X-Voice-Lang', async () => {
    stub({ json: { text: '这段的注意力是怎么算的' } })
    const res = await transcribeAudio(audio(), { lang: 'zh' })
    expect(res.text).toBe('这段的注意力是怎么算的')
    expect(calls[0].url).toBe('/api/app/voice/transcribe')
    expect(calls[0].init.method).toBe('POST')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('audio/webm;codecs=opus')
    expect(headers[VOICE_LANG_HEADER]).toBe('zh')
    expect(calls[0].init.body).toBeInstanceOf(Blob)
  })

  it('未指定语言时默认 auto；blob 无 type 时回落 audio/webm', async () => {
    stub({ json: { text: 'ok' } })
    await transcribeAudio(new Blob([new Uint8Array([1])]))
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers[VOICE_LANG_HEADER]).toBe('auto')
    expect(headers['Content-Type']).toBe('audio/webm')
  })

  it('空转写是 200 {text:""}，不当错误抛（由状态机判「没听清」）', async () => {
    stub({ json: { text: '' } })
    await expect(transcribeAudio(audio())).resolves.toEqual({ text: '' })
  })

  it('缺 text 字段时归一为空串', async () => {
    stub({ json: {} })
    await expect(transcribeAudio(audio())).resolves.toEqual({ text: '' })
  })

  it('413 → too-large 不可重试；429 → rate-limit 可重试', async () => {
    stub({ status: 413, json: { error: 'too-large' } })
    await expect(transcribeAudio(audio())).rejects.toMatchObject({ kind: 'too-large', retryable: false })
    stub({ status: 429, json: { error: 'rate-limited' } })
    await expect(transcribeAudio(audio())).rejects.toMatchObject({ kind: 'rate-limit', retryable: true })
  })

  it('fetch 抛（断网）→ network 且可重试，文案含原因', async () => {
    stubThrow(new TypeError('Failed to fetch'))
    let caught: unknown
    try {
      await transcribeAudio(audio())
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(VoiceApiError)
    const err = caught as VoiceApiError
    expect(err.kind).toBe('network')
    expect(err.retryable).toBe(true)
    expect(err.message).toContain('网络错误')
    expect(err.message).toContain('Failed to fetch')
  })

  it('自身超时（无外部信号的 AbortError）→ timeout', async () => {
    stubThrow(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    await expect(transcribeAudio(audio())).rejects.toMatchObject({ kind: 'timeout', retryable: true })
  })

  it('调用方主动取消 → 原样抛 AbortError，不包成 VoiceApiError', async () => {
    globalThis.fetch = ((_url: RequestInfo | URL, opts: RequestInit = {}) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        )
      })) as typeof globalThis.fetch
    const ctrl = new AbortController()
    const pending = transcribeAudio(audio(), { signal: ctrl.signal })
    ctrl.abort()
    let caught: unknown
    try {
      await pending
    } catch (e) {
      caught = e
    }
    expect(caught).not.toBeInstanceOf(VoiceApiError)
    expect((caught as Error).name).toBe('AbortError')
  })
})

describe('synthesizeSpeech', () => {
  it('JSON 进、音频字节出，按响应头定 Blob 类型', async () => {
    stub({ bytes: new Uint8Array([1, 2, 3]).buffer, headers: { 'content-type': 'audio/mpeg' } })
    const blob = await synthesizeSpeech('先说结论。', { voice: 'anna', speed: 1.1 })
    expect(calls[0].url).toBe('/api/app/voice/tts')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      text: '先说结论。',
      format: 'mp3',
      voice: 'anna',
      speed: 1.1,
    })
    expect(blob.type).toBe('audio/mpeg')
    expect(blob.size).toBe(3)
  })

  it('不传音色/语速时不发这两个字段（服务端用默认值）', async () => {
    stub({ bytes: new Uint8Array([1]).buffer })
    await synthesizeSpeech('一句话。')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ text: '一句话。', format: 'mp3' })
  })

  it('空音频 → upstream 错误（别把 0 字节喂给播放器）', async () => {
    stub({ bytes: new ArrayBuffer(0) })
    await expect(synthesizeSpeech('一句话。')).rejects.toMatchObject({ kind: 'upstream' })
  })

  it('502 → upstream 且可重试（触发 cloudTtsPlayer 粘性降级）', async () => {
    stub({ status: 502, json: { error: 'voice-upstream-failed' } })
    await expect(synthesizeSpeech('一句话。')).rejects.toMatchObject({ kind: 'upstream', retryable: true })
  })

  it('503 → unavailable 不可重试', async () => {
    stub({ status: 503, json: { error: 'voice-unavailable' } })
    await expect(synthesizeSpeech('一句话。')).rejects.toMatchObject({ kind: 'unavailable', retryable: false })
  })
})
