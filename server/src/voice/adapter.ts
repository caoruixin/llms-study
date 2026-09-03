/**
 * 语音适配器契约:把"转写/合成"抽象成两个纯签名的方法,**本文件零网络、零依赖**。
 *
 * 为什么 key/baseUrl 是入参而不是构造参数:key 轮换发生在路由层(同一段字节换 key 重放,
 * 语义与 LLM 网关一致),适配器实例必须是无状态的,否则轮换就得重建适配器。
 * 测试也因此能注入一个纯内存适配器,把 13 个用例全部跑成零网络。
 */
import type { VoiceVoiceOption } from '../../../shared/apiTypes.js'

/** 语种提示:上游不一定使用(SenseVoice 自动判语种),但契约里保留给后续 provider */
export type VoiceLang = 'zh' | 'en' | 'auto'

export interface TranscribeRequest {
  /** 浏览器上传的原始音频字节,原样转发,不转码 */
  audio: Buffer
  /** 已过白名单校验的 media type(不含 codecs 等参数) */
  mime: string
  lang: VoiceLang
  model: string
  timeoutMs: number
}

export interface TranscribeResult {
  /** 空串是合法结果:静音/纯噪声的转写就是空 */
  text: string
}

export interface SynthesizeRequest {
  text: string
  /** 音色短 id(alex/anna/…),拼进上游参数的规则由各适配器自己决定 */
  voice: string
  format: 'mp3' | 'wav'
  speed?: number
  model: string
  timeoutMs: number
  /** 响应字节上限,超出即判上游异常——防无界响应打爆单进程内存 */
  maxBytes: number
}

export interface SynthesizeResult {
  audio: Buffer
  /** 对外声明的 Content-Type,由上游响应头或 format 推定 */
  contentType: string
}

export interface VoiceAdapter {
  /** 厂商标识,写进 voice_call_log.provider */
  readonly provider: string
  /** 面向用户的厂商名(设置页展示) */
  readonly providerLabel: string
  readonly voices: readonly VoiceVoiceOption[]
  transcribe(req: TranscribeRequest, key: string, baseUrl: string): Promise<TranscribeResult>
  synthesize(req: SynthesizeRequest, key: string, baseUrl: string): Promise<SynthesizeResult>
}

/**
 * 上游失败的统一载体。status 是上游 HTTP 状态,路由层直接喂给 classifyKeyFailure
 * 决定"换 key 重放"还是"快速失败";网络层失败/超时用 0——它与 key 无关,不该触发轮换。
 */
export class VoiceUpstreamError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'VoiceUpstreamError'
    this.status = status
  }
}
