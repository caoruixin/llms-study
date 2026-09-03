/**
 * 语音端点客户端（同源 /api/app/voice/*）。
 *
 * 与 authApi 的 apiFetch 不同：转写请求体是原始音频字节、TTS 响应体是音频字节，
 * 两头都不是 JSON，所以不能复用固定 res.json() 的 apiFetch——这里按 fetchUrlApi 的形制
 * 手写一份同构的错误归一（HTTP 状态 + 服务端 {error,message} → 单一异常类型 + 中文文案）。
 *
 * 分层：mapVoiceHttpError 是纯函数（状态码/错误码 → kind/文案/是否可重试），三个端点函数
 * 是薄壳。单测 stub globalThis.fetch 即可全覆盖。
 */

/**
 * 路由前缀。刻意不 import shared/apiRoutes：语音常量正由服务端代理同步落进 shared，
 * 这里保持零跨包依赖，字符串与 PLAN 契约一字对应（'/api/app' + '/voice'）。
 */
const VOICE_API_PREFIX = '/api/app/voice'

/** 语言提示头：zh / en / auto（服务端据此选 ASR 语种，auto = 让上游自己判） */
export const VOICE_LANG_HEADER = 'X-Voice-Lang'

/** 客户端超时（比服务端超时多留握手与回传余量：ASR 20s、TTS 15s） */
export const VOICE_CONFIG_TIMEOUT_MS = 10_000
export const VOICE_ASR_TIMEOUT_MS = 25_000
export const VOICE_TTS_TIMEOUT_MS = 20_000

export interface VoiceVoiceOption {
  id: string
  label: string
}

export interface VoiceConfigResp {
  enabled: boolean
  provider?: string
  providerLabel?: string
  asrModel?: string
  voices?: VoiceVoiceOption[]
  /** 服务端默认音色 id：前端偏好 voiceTtsVoice='' 时用它在下拉里定位选中项 */
  defaultVoice?: string
  maxUtteranceMs?: number
  maxAudioBytes?: number
}

export type VoiceErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'too-large'
  | 'unsupported'
  | 'unavailable'
  | 'upstream'
  | 'network'
  | 'timeout'

/** kind → 用户可读中文文案：只在这里维护一份，UI 只管 catch 取 message */
const KIND_MESSAGES: Record<VoiceErrorKind, string> = {
  auth: '登录状态已失效，请重新登录后重试',
  'rate-limit': '语音请求太频繁了，缓一下再说',
  'too-large': '这段录音太长了，请分成几句再问',
  unsupported: '当前浏览器的录音格式不受支持',
  unavailable: '语音功能暂未开启',
  upstream: '语音服务暂时不可用，请稍后重试',
  network: '网络错误，请检查网络连接后重试',
  timeout: '语音服务响应超时，请重试',
}

/** 只有这几类重试同一份请求才有意义（其余要么改配置、要么换输入） */
const RETRYABLE: ReadonlySet<VoiceErrorKind> = new Set<VoiceErrorKind>(['rate-limit', 'upstream', 'network', 'timeout'])

export class VoiceApiError extends Error {
  readonly kind: VoiceErrorKind
  readonly retryable: boolean
  /** 仅 HTTP 错误携带；network / timeout 没有状态码 */
  readonly status?: number

  constructor(kind: VoiceErrorKind, message?: string, status?: number) {
    super(message ?? KIND_MESSAGES[kind])
    this.name = 'VoiceApiError'
    this.kind = kind
    this.retryable = RETRYABLE.has(kind)
    if (status !== undefined) this.status = status
  }
}

/** 服务端 respond.ts 的错误码 → kind（比状态码更精确，优先采用） */
const KIND_BY_CODE: Readonly<Record<string, VoiceErrorKind>> = {
  unauthenticated: 'auth',
  forbidden: 'auth',
  'account-disabled': 'auth',
  'rate-limited': 'rate-limit',
  'too-large': 'too-large',
  'fetch-too-large': 'too-large',
  'unsupported-content': 'unsupported',
  'voice-unavailable': 'unavailable',
  'voice-upstream-failed': 'upstream',
}

const KIND_BY_STATUS: Readonly<Record<number, VoiceErrorKind>> = {
  401: 'auth',
  403: 'auth',
  408: 'timeout',
  413: 'too-large',
  415: 'unsupported',
  429: 'rate-limit',
  502: 'upstream',
  503: 'unavailable',
  504: 'timeout',
}

/**
 * HTTP 状态 + 服务端错误码 → VoiceApiError（纯函数）。
 * 两者都认不出来时才退到服务端 message：能归类的一律用我们自己的文案，
 * 避免把「上游 5xx」这类内部口径直接怼给用户。
 */
export function mapVoiceHttpError(status: number, code?: string | null, message?: string | null): VoiceApiError {
  const byCode = code ? KIND_BY_CODE[code] : undefined
  const byStatus = KIND_BY_STATUS[status]
  const guessed = byCode === undefined && byStatus === undefined
  const kind: VoiceErrorKind = byCode ?? byStatus ?? (status >= 500 ? 'upstream' : 'unsupported')
  const text = guessed && message ? message : KIND_MESSAGES[kind]
  return new VoiceApiError(kind, text, status)
}

interface VoiceFetchInit {
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: BodyInit
}

/**
 * 带超时与外部取消的同源 fetch。
 * 调用方主动 abort（切论文/打断）时原样抛出 AbortError——那不是故障，UI 不该弹错误；
 * 只有我们自己的超时才归一成 VoiceApiError('timeout')。
 */
async function voiceFetch(
  path: string,
  init: VoiceFetchInit,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<Response> {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (external?.aborted) ctrl.abort() // 已经取消了就别发出去
  else external?.addEventListener('abort', onAbort)
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(VOICE_API_PREFIX + path, {
      method: init.method,
      // 同源默认即携带 cookie，显式写出以表意图（session cookie 是唯一鉴权凭据）
      credentials: 'same-origin',
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: ctrl.signal,
    })
  } catch (e) {
    if (external?.aborted) throw e
    if ((e as Error | undefined)?.name === 'AbortError') throw new VoiceApiError('timeout')
    throw new VoiceApiError('network', `${KIND_MESSAGES.network}：${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onAbort)
  }
}

async function failureOf(res: Response): Promise<VoiceApiError> {
  let payload: { error?: string; message?: string } | null = null
  try {
    payload = (await res.json()) as { error?: string; message?: string }
  } catch {
    payload = null
  }
  return mapVoiceHttpError(res.status, payload?.error ?? null, payload?.message ?? null)
}

async function readJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T
  } catch {
    throw new VoiceApiError('upstream', '语音服务返回了无法解析的内容')
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * GET /voice/config。失败一律抛 VoiceApiError——调用方（麦克风球）把任何失败都当
 * 「语音不可用」处理并隐藏入口，不需要区分是没登录还是没配 key。
 */
export async function getVoiceConfig(opts: { signal?: AbortSignal } = {}): Promise<VoiceConfigResp> {
  const res = await voiceFetch('/config', { method: 'GET' }, VOICE_CONFIG_TIMEOUT_MS, opts.signal)
  if (!res.ok) throw await failureOf(res)
  const raw = await readJson<Record<string, unknown>>(res)
  const voices = Array.isArray(raw.voices)
    ? raw.voices
        .map((v) => {
          const item = v as { id?: unknown; label?: unknown }
          const id = str(item?.id)
          return id ? { id, label: str(item?.label) ?? id } : null
        })
        .filter((v): v is VoiceVoiceOption => v !== null)
    : undefined
  return {
    enabled: raw.enabled === true,
    provider: str(raw.provider),
    providerLabel: str(raw.providerLabel),
    asrModel: str(raw.asrModel),
    ...(voices && voices.length > 0 ? { voices } : {}),
    maxUtteranceMs: num(raw.maxUtteranceMs),
    maxAudioBytes: num(raw.maxAudioBytes),
  }
}

/**
 * POST /voice/transcribe：原始音频字节直传（非 multipart，服务端按 Content-Type 自组）。
 * 空转写不是错误——服务端返回 200 {text:""}，这里如实交出空串，由状态机判「没听清」。
 */
export async function transcribeAudio(
  blob: Blob,
  opts: { lang?: 'zh' | 'en' | 'auto'; signal?: AbortSignal } = {},
): Promise<{ text: string }> {
  const res = await voiceFetch(
    '/transcribe',
    {
      method: 'POST',
      headers: {
        'Content-Type': blob.type || 'audio/webm',
        [VOICE_LANG_HEADER]: opts.lang ?? 'auto',
      },
      body: blob,
    },
    VOICE_ASR_TIMEOUT_MS,
    opts.signal,
  )
  if (!res.ok) throw await failureOf(res)
  const data = await readJson<{ text?: unknown }>(res)
  return { text: typeof data.text === 'string' ? data.text : '' }
}

/** POST /voice/tts：JSON 进、音频字节出（Cache-Control: no-store，播毕即弃） */
export async function synthesizeSpeech(
  text: string,
  opts: { voice?: string; speed?: number; signal?: AbortSignal } = {},
): Promise<Blob> {
  const res = await voiceFetch(
    '/tts',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        format: 'mp3',
        ...(opts.voice ? { voice: opts.voice } : {}),
        ...(opts.speed !== undefined ? { speed: opts.speed } : {}),
      }),
    },
    VOICE_TTS_TIMEOUT_MS,
    opts.signal,
  )
  if (!res.ok) throw await failureOf(res)
  const bytes = await res.arrayBuffer()
  if (bytes.byteLength === 0) throw new VoiceApiError('upstream', '语音合成返回了空音频')
  return new Blob([bytes], { type: res.headers.get('content-type') ?? 'audio/mpeg' })
}
