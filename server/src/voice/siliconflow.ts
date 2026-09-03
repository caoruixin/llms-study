/**
 * SiliconFlow 语音适配器(契约已对 docs.siliconflow.com 核实,2026-09-03)。
 * - ASR:`POST {base}/v1/audio/transcriptions`,multipart `file` + `model`,响应 `{"text":"…"}`
 * - TTS:`POST {base}/v1/audio/speech`,JSON,响应=音频字节(支持 chunked)
 *
 * 所有失败一律翻译成 VoiceUpstreamError:路由层只认这一种异常,别的异常会冒泡成 500,
 * 那正是我们想要的——那说明是本进程的 bug,不是上游的锅。
 */
import {
  VoiceUpstreamError,
  type SynthesizeRequest,
  type SynthesizeResult,
  type TranscribeRequest,
  type TranscribeResult,
  type VoiceAdapter,
} from './adapter.js'
import type { VoiceVoiceOption } from '../../../shared/apiTypes.js'

/** CosyVoice2 预置音色;label 是给设置页下拉用的中文短标签(带试听钮) */
const VOICES: readonly VoiceVoiceOption[] = [
  { id: 'alex', label: '沉稳男声' },
  { id: 'anna', label: '沉稳女声' },
  { id: 'bella', label: '激情女声' },
  { id: 'benjamin', label: '低沉男声' },
  { id: 'charles', label: '磁性男声' },
  { id: 'claire', label: '温柔女声' },
  { id: 'david', label: '欢快男声' },
  { id: 'diana', label: '欢快女声' },
]

/**
 * mime → multipart 文件扩展名。
 * 为什么必须派生而不是写死 .webm:部分 ASR 上游按扩展名分发解码器,
 * Safari 录出来的 mp4 挂个 .webm 名字会被直接 400。
 */
const MIME_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
}

const FORMAT_CONTENT_TYPE: Record<'mp3' | 'wav', string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
}

/**
 * 剥离 TTS 指令标记与控制字符。
 * CosyVoice 把 `<|endofprompt|>` 一类尖括号标记当**指令**解释,回答正文里若混进这种串
 * (LLM 复述提示词、论文里出现的伪标记)会改变合成行为甚至截断朗读;控制字符同理会让上游 400。
 */
export function stripTtsMarkers(input: string): string {
  return input
    .replace(/<\|[^|>]*\|>/g, '')
    // 保留 \t\n\r(合法排版),其余 C0/DEL 一律清掉
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
}

/** 上游错误体只取头 200 字进日志:再多也帮不上排查,却可能把整段回声写进日志 */
async function upstreamMessage(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200)
  } catch {
    return ''
  }
}

/** 把 fetch/abort 抛出的异常统一成 VoiceUpstreamError(status=0:与 key 无关,不触发轮换) */
function asNetworkError(e: unknown, what: string): VoiceUpstreamError {
  const aborted = e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')
  return new VoiceUpstreamError(0, aborted ? `语音${what}请求超时` : `语音${what}上游连接失败`)
}

/** 带上限地读完响应体:上游可能 chunked,不能先信 content-length 也不能无界读 */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new VoiceUpstreamError(0, '语音合成结果超过大小上限')
  }
  const body = res.body
  if (!body) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new VoiceUpstreamError(0, '语音合成结果超过大小上限')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
}

export function createSiliconFlowAdapter(): VoiceAdapter {
  return {
    provider: 'siliconflow',
    providerLabel: '硅基流动',
    voices: VOICES,

    async transcribe(req: TranscribeRequest, key: string, baseUrl: string): Promise<TranscribeResult> {
      const ext = MIME_EXT[req.mime] ?? 'webm'
      const form = new FormData()
      // 复制成 Uint8Array 再包 File:Buffer 可能是共享内存池的切片,复制一次杜绝越界读
      form.append('file', new File([new Uint8Array(req.audio)], `utterance.${ext}`, { type: req.mime }))
      form.append('model', req.model)
      // 刻意不发 language:SenseVoice 自动判语种,契约里也没有这个字段;
      // req.lang 保留给后续换 provider 时使用

      let res: Response
      try {
        res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}` },
          // content-type 交给 FormData 自己写(必须带 boundary),手写会导致上游解析失败
          body: form,
          signal: AbortSignal.timeout(req.timeoutMs),
        })
      } catch (e) {
        throw asNetworkError(e, '转写')
      }

      if (!res.ok) {
        const detail = await upstreamMessage(res)
        console.error(`[voice] siliconflow 转写 ${res.status}: ${detail}`)
        throw new VoiceUpstreamError(res.status, `语音转写上游返回 ${res.status}`)
      }
      let parsed: unknown
      try {
        parsed = await res.json()
      } catch {
        throw new VoiceUpstreamError(res.status, '语音转写上游返回体不是 JSON')
      }
      const text = (parsed as { text?: unknown } | null)?.text
      if (typeof text !== 'string') {
        throw new VoiceUpstreamError(res.status, '语音转写上游返回体缺少 text 字段')
      }
      return { text }
    },

    async synthesize(req: SynthesizeRequest, key: string, baseUrl: string): Promise<SynthesizeResult> {
      const input = stripTtsMarkers(req.text)
      if (!input) {
        // 剥完标记什么都不剩:发上去只会拿一个 400,直接当上游失败处理更省一次往返
        throw new VoiceUpstreamError(0, '待合成文本为空')
      }
      const payload: Record<string, unknown> = {
        model: req.model,
        input,
        // 音色参数形如 `FunAudioLLM/CosyVoice2-0.5B:anna`——短 id 单独发是不认的
        voice: `${req.model}:${req.voice}`,
        response_format: req.format,
        // 明确关流式:本路由整块回字节,开 stream 只会让首字节更早但整体逻辑复杂化(P2 再做透传)
        stream: false,
      }
      if (req.speed !== undefined) payload.speed = req.speed

      let res: Response
      try {
        res = await fetch(`${baseUrl}/v1/audio/speech`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(req.timeoutMs),
        })
      } catch (e) {
        throw asNetworkError(e, '合成')
      }

      if (!res.ok) {
        const detail = await upstreamMessage(res)
        console.error(`[voice] siliconflow 合成 ${res.status}: ${detail}`)
        throw new VoiceUpstreamError(res.status, `语音合成上游返回 ${res.status}`)
      }
      const audio = await readCapped(res, req.maxBytes)
      if (audio.length === 0) throw new VoiceUpstreamError(res.status, '语音合成上游返回空音频')
      const upstreamType = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      return {
        audio,
        // 上游偶尔回 application/octet-stream,那种情况按我们请求的 format 声明更有用
        contentType:
          upstreamType && upstreamType.startsWith('audio/')
            ? upstreamType
            : FORMAT_CONTENT_TYPE[req.format],
      }
    },
  }
}
