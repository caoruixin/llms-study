import type { TtsPlayer } from '../tts'
import { stripTtsMarkers } from './ttsChunking'
import { synthesizeSpeech } from './voiceApi'
import { encodeWavPcm16 } from './wavEncode'

/**
 * 云端 TTS 播放器：实现现有 `TtsPlayer` 接口（tts.ts），所以 CopilotPanel 的朗读队列
 * （ttsReducer + 驱动 effect）一个字都不用改，只把 getPlayer() 换掉。
 *
 * 三个要点：
 * 1. **单个共享 HTMLAudioElement**：autoplay 策略只认「在用户手势里被 play 过的元素」，
 *    每句新建 Audio 会在第二句就被拦下。unlockAudio() 在按下麦克风的手势内播一段静音把它解锁。
 * 2. **粘性降级**：第一次云端失败（VoiceApiError / autoplay 被拒 / 解码失败）就整轮切浏览器朗读，
 *    并且**当前这句也交给 fallback 念**——降级不能把用户已经在等的那句话吃掉。
 *    一次性提示由 onDegrade 交给 UI，不重复弹。
 * 3. **一格预取**：prime(下一句) 在当前句播放时把音频拿回来，speak 命中缓存即刻起播。
 *    只留一格：驱动 effect 保证「上一句 onEnd 之后才 speak 下一句」，多格是浪费额度。
 */

export interface CloudTtsPlayer extends TtsPlayer {
  /** 可选的预取入口：调用方在当前句起播后调用，speak 到这句时直接命中 */
  prime(sentence: string): void
  dispose(): void
}

export interface CloudTtsOpts {
  /** 降级目标，通常是 tts.createTtsPlayer() 的浏览器朗读 */
  fallback: TtsPlayer
  voice?: string
  speed?: number
  /** 本轮首次降级时调用一次（UI 弹一次性提示） */
  onDegrade?: (message: string) => void
}

const DEGRADE_MESSAGE = '云端朗读不可用，已切换为浏览器朗读'
const AUTOPLAY_MESSAGE = '浏览器阻止了自动播放，已切换为浏览器朗读'

let sharedEl: HTMLAudioElement | null = null
let silentUri: string | null = null

function audioEl(): HTMLAudioElement | null {
  if (typeof document === 'undefined') return null
  sharedEl ??= document.createElement('audio')
  return sharedEl
}

/** 20ms 静音 WAV 的 data URI（用自家编码器现算，省得塞一串 base64 常量进来） */
function silentDataUri(): string {
  if (silentUri === null) {
    const bytes = new Uint8Array(encodeWavPcm16(new Float32Array(160), 8000))
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    silentUri = `data:audio/wav;base64,${btoa(bin)}`
  }
  return silentUri
}

/**
 * 在用户手势内解锁音频元素（按下麦克风球/热键时调用）。
 * 失败一律吞掉：解锁不是必需路径，真正播不出来时 speak 会走降级。
 */
export function unlockAudio(): void {
  const el = audioEl()
  // 正在播放时不解锁：打断走 cancel()，换 src 会把当前这句掐断且不再触发 onended（队列卡死）
  if (el === null || !el.paused) return
  try {
    el.src = silentDataUri()
    void el.play().then(
      () => el.pause(),
      () => {},
    )
  } catch {
    /* 手势之外调用 / 元素不可用：静默失败 */
  }
}

export function createCloudTtsPlayer(opts: CloudTtsOpts): CloudTtsPlayer {
  const el = audioEl()
  // 没有 document（SSR / node 单测）时直接以降级态起步，行为等价于纯浏览器朗读
  let degraded = el === null
  /** 代数：cancel/speak 递增，迟到的 fetch 回调据此丢弃（同 turnEngine 的 sessionRef 模式） */
  let gen = 0
  let objectUrl: string | null = null
  let inflight: AbortController | null = null
  let cache: { key: string; audio: Promise<Blob>; ctrl: AbortController } | null = null

  const revoke = () => {
    if (objectUrl !== null) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
  }

  const abortAll = () => {
    inflight?.abort()
    inflight = null
    cache?.ctrl.abort()
    cache = null
  }

  const degrade = (message: string) => {
    if (degraded) return
    degraded = true
    abortAll()
    opts.onDegrade?.(message)
  }

  const fetchAudio = (text: string, ctrl: AbortController) =>
    synthesizeSpeech(text, { voice: opts.voice, speed: opts.speed, signal: ctrl.signal })

  const cancelAll = () => {
    gen += 1
    abortAll()
    const a = audioEl()
    if (a !== null) {
      a.onended = null
      a.onerror = null
      a.pause()
      a.removeAttribute('src')
      a.load() // 断开解码器，别让已丢弃的音频继续占带宽
    }
    revoke()
  }

  const play = (blob: Blob, myGen: number, sentence: string, onEnd: () => void) => {
    const a = audioEl()
    if (a === null || myGen !== gen) return
    let ended = false
    const done = () => {
      if (ended) return
      ended = true
      a.onended = null
      a.onerror = null
      revoke()
      onEnd()
    }
    const fail = (message: string) => {
      if (myGen !== gen) return
      degrade(message)
      opts.fallback.speak(sentence, done) // 失败句转 fallback，一句都不丢
    }

    revoke()
    objectUrl = URL.createObjectURL(blob)
    a.onended = () => {
      if (myGen === gen) done()
    }
    a.onerror = () => fail(DEGRADE_MESSAGE)
    a.src = objectUrl
    void a.play().catch((e: unknown) => {
      const autoplayBlocked = (e as Error | undefined)?.name === 'NotAllowedError'
      fail(autoplayBlocked ? AUTOPLAY_MESSAGE : DEGRADE_MESSAGE)
    })
  }

  return {
    speak(sentence, onEnd) {
      const myGen = ++gen
      if (degraded) {
        opts.fallback.speak(sentence, onEnd)
        return
      }
      const text = stripTtsMarkers(sentence)
      if (text === '') {
        onEnd() // 整句只剩标记：跳过但不能卡住队列
        return
      }
      const hit = cache?.key === sentence ? cache : null
      cache = null
      const ctrl = hit?.ctrl ?? new AbortController()
      inflight = ctrl
      const audio = hit?.audio ?? fetchAudio(text, ctrl)
      audio.then(
        (blob) => {
          if (inflight === ctrl) inflight = null
          play(blob, myGen, sentence, onEnd)
        },
        (e: unknown) => {
          if (inflight === ctrl) inflight = null
          if (myGen !== gen) return // 已取消：驱动 effect 不再等这句
          if ((e as Error | undefined)?.name === 'AbortError') return
          degrade(DEGRADE_MESSAGE)
          opts.fallback.speak(sentence, onEnd)
        },
      )
    },

    prime(sentence) {
      if (degraded) return
      const text = stripTtsMarkers(sentence)
      if (text === '' || cache?.key === sentence) return
      cache?.ctrl.abort()
      const ctrl = new AbortController()
      const audio = fetchAudio(text, ctrl)
      // 预取失败不立刻算故障：丢掉这一格，speak 到这句时重发一次，真失败了再走降级
      audio.catch(() => {
        if (cache?.audio === audio) cache = null
      })
      cache = { key: sentence, audio, ctrl }
    },

    pause() {
      if (degraded) {
        opts.fallback.pause()
        return
      }
      audioEl()?.pause()
    },

    resume() {
      if (degraded) {
        opts.fallback.resume()
        return
      }
      void audioEl()?.play().catch(() => {})
    },

    cancel() {
      cancelAll()
      if (degraded) opts.fallback.cancel()
    },

    dispose() {
      cancelAll()
      opts.fallback.cancel()
      degraded = true // 释放后任何迟到调用都走 fallback，不再碰共享元素
    },
  }
}
