import { mixToMono, encodeWavPcm16, resampleLinear } from './wavEncode'
import { pickRecorderMime } from './recorderMime'
import { acquireStream, releaseStream } from './recorderSingleton'
import { rmsOf } from './endpointing'

/**
 * 录音薄壳：唯一触碰 MediaRecorder / AudioContext 的地方（纯逻辑都在 recorderMime /
 * endpointing / wavEncode 里，node 环境直测）。
 *
 * 每个分支都刻意保持平凡——本文件不写单测，复杂度必须留在纯函数侧：
 * - 容器选型 → pickRecorderMime
 * - 电平计算 → rmsOf
 * - 兜底转码 → mixToMono / resampleLinear / encodeWavPcm16
 *
 * 生命周期：start → (onLevel 回调若干) → stop|cancel → dispose。
 * 麦克风流走 recorderSingleton 引用计数，本对象只负责「借」和「还」。
 */

export interface RecordedAudio {
  blob: Blob
  durationMs: number
  mime: string
}

export interface Recorder {
  start(): Promise<void>
  /** null = 本次录音被取消，或压根没开始 */
  stop(): Promise<RecordedAudio | null>
  cancel(): void
  /** 订阅电平（0..1 RMS），返回退订函数。数值走 ref/CSS 变量，别进 store */
  onLevel(cb: (rms: number) => void): () => void
  dispose(): void
}

/** 分片间隔：即便 stop 与 ondataavailable 抢跑，也已经有整段数据落进 chunks */
const TIMESLICE_MS = 200
/** ASR 兜底转码的目标采样率（SenseVoice 一类模型的原生输入率） */
export const WAV_TARGET_SAMPLE_RATE = 16000

interface Session {
  rec: MediaRecorder
  mime: string
  chunks: Blob[]
  startedAt: number
  cancelled: boolean
  settle: ((r: RecordedAudio | null) => void) | null
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

type AudioContextCtor = new () => AudioContext

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  return (w.AudioContext ?? w.webkitAudioContext ?? null) as AudioContextCtor | null
}

export function createRecorder(): Recorder {
  let session: Session | null = null
  let held = false
  let starting = false
  let disposed = false

  const listeners = new Set<(rms: number) => void>()
  let ctx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let raf = 0

  const release = () => {
    if (!held) return
    held = false
    releaseStream()
  }

  const stopMetering = () => {
    if (raf !== 0) {
      cancelAnimationFrame(raf)
      raf = 0
    }
    source?.disconnect()
    source = null
    analyser = null
  }

  const startMetering = (stream: MediaStream) => {
    const Ctor = audioContextCtor()
    if (!Ctor) return
    try {
      ctx ??= new Ctor()
      void ctx.resume()
      analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source = ctx.createMediaStreamSource(stream)
      source.connect(analyser)
    } catch {
      stopMetering()
      return
    }
    const buf = new Uint8Array(analyser.fftSize)
    const tick = () => {
      if (!analyser) return
      analyser.getByteTimeDomainData(buf)
      const rms = rmsOf(buf)
      for (const cb of listeners) cb(rms)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  }

  const finish = (s: Session) => {
    stopMetering()
    release()
    const result: RecordedAudio | null = s.cancelled
      ? null
      : { blob: new Blob(s.chunks, { type: s.mime }), durationMs: Math.max(0, now() - s.startedAt), mime: s.mime }
    s.settle?.(result)
    s.settle = null
  }

  const cancelSession = () => {
    const s = session
    if (s === null) return
    session = null
    s.cancelled = true
    if (s.rec.state === 'inactive') finish(s)
    else s.rec.stop() // 结果在 onstop → finish 里作废
  }

  return {
    async start() {
      // starting 挡住 await 窗口内的重入（连点两下）：两次 acquire 只会 release 一次，麦克风会一直亮着
      if (session !== null || starting || disposed) return
      starting = true
      try {
        const stream = await acquireStream()
        held = true
        if (disposed) {
          release()
          return
        }
        const picked = pickRecorderMime((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t))
        if (!picked) {
          release()
          throw new Error('当前浏览器不支持录音，请更换浏览器后重试')
        }
        const rec = new MediaRecorder(stream, { mimeType: picked.mime })
        const s: Session = { rec, mime: picked.mime, chunks: [], startedAt: now(), cancelled: false, settle: null }
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) s.chunks.push(e.data)
        }
        rec.onstop = () => finish(s)
        rec.onerror = () => {
          if (session === s) session = null
          s.cancelled = true
          finish(s)
        }
        session = s
        rec.start(TIMESLICE_MS)
        startMetering(stream)
      } finally {
        starting = false
      }
    },

    stop() {
      const s = session
      if (s === null) return Promise.resolve(null)
      session = null
      return new Promise<RecordedAudio | null>((resolve) => {
        s.settle = resolve
        if (s.rec.state === 'inactive') finish(s)
        else s.rec.stop() // 结果在 onstop → finish 里交付
      })
    },

    cancel() {
      cancelSession()
    },

    onLevel(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },

    dispose() {
      disposed = true
      cancelSession()
      stopMetering()
      listeners.clear()
      void ctx?.close().catch(() => {})
      ctx = null
      release()
    },
  }
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext

function offlineContextCtor(): OfflineCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  return (w.OfflineAudioContext ?? w.webkitOfflineAudioContext ?? null) as OfflineCtor | null
}

/**
 * 容器兼容兜底（PLAN 风险表「SenseVoice 容器兼容」）：webm/mp4 被上游拒收时，
 * 解码 → 混单声道 → 重采样 16k → WAV 再上传。目前**未接线**（默认直传原容器），
 * 留在这里是为了拒收当天只改一行调用，不用现写编解码。
 */
export async function blobToWav16kMono(blob: Blob): Promise<Blob> {
  const Ctor = offlineContextCtor()
  if (!Ctor) throw new Error('当前浏览器不支持音频转码')
  const bytes = await blob.arrayBuffer()
  const ctx = new Ctor(1, 1, WAV_TARGET_SAMPLE_RATE)
  const decoded = await ctx.decodeAudioData(bytes)
  const channels: Float32Array[] = []
  for (let i = 0; i < decoded.numberOfChannels; i++) channels.push(decoded.getChannelData(i))
  const mono = resampleLinear(mixToMono(channels), decoded.sampleRate, WAV_TARGET_SAMPLE_RATE)
  return new Blob([encodeWavPcm16(mono, WAV_TARGET_SAMPLE_RATE)], { type: 'audio/wav' })
}
