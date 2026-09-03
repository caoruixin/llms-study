/**
 * 端点检测（连续对话的「说完了」判定）：纯函数 + 时间注入，node 环境直测。
 *
 * 只吃一个标量 rms（由 recorder 的 AnalyserNode 每帧算出），不碰 AudioContext——
 * 阈值调参、边界回归全部能在单测里跑，不需要真麦克风。
 *
 * 判定口径：
 * - 累计人声 ≥ minSpeechMs 才算「说过话」（咳嗽、点击声、环境瞬时噪声不触发断句）；
 * - 说过话之后连续静默 ≥ silenceMs → stop='silence'；
 * - 从第一次出声起满 maxUtteranceMs → stop='max'（硬帽优先，防长录音撞服务端字节上限）；
 * - 决策一旦作出就锁存，后续 step 返回同一个 stop（调用方 rAF 里天然会多调几帧）。
 */

export interface EndpointOpts {
  /** 累计人声时长门槛：低于它不认为「说过话」 */
  minSpeechMs: number
  /** 说过话之后的静默时长门槛 */
  silenceMs: number
  /** 单次说话硬上限（从第一次出声算起） */
  maxUtteranceMs: number
  /** 人声 RMS 阈值（0..1）；安静房间底噪约 0.005，正常说话 0.05~0.2 */
  speechRms: number
}

export const DEFAULT_ENDPOINT_OPTS: EndpointOpts = {
  minSpeechMs: 400,
  silenceMs: 1200,
  maxUtteranceMs: 30000,
  speechRms: 0.02,
}

export type EndpointStop = 'silence' | 'max'

export interface EndpointStep {
  /** 当前帧是否判为人声 */
  speaking: boolean
  /** 累计人声是否已过 minSpeechMs */
  speechDetected: boolean
  /** null = 继续收音；'silence' = 说完了；'max' = 到达硬上限 */
  stop: EndpointStop | null
  /** 累计人声毫秒 */
  speechMs: number
  /** 当前这段静默已持续的毫秒（说过话之后才累计），UI 可据此画倒计时 */
  silenceMs: number
}

export interface SilenceDetector {
  step(rms: number, nowMs: number): EndpointStep
  /** 复用同一个检测器开始下一次说话 */
  reset(): void
}

/**
 * 时域字节样本（AnalyserNode.getByteTimeDomainData，128 为静音中位）→ 0..1 的 RMS。
 * 空数组返回 0（首帧 analyser 还没填数据时不该炸）。
 */
export function rmsOf(timeDomain: Uint8Array): number {
  const n = timeDomain.length
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const x = (timeDomain[i] - 128) / 128
    sum += x * x
  }
  return Math.sqrt(sum / n)
}

export function createSilenceDetector(opts: Partial<EndpointOpts> = {}): SilenceDetector {
  const cfg: EndpointOpts = { ...DEFAULT_ENDPOINT_OPTS, ...opts }

  let prevMs: number | null = null
  let speechMs = 0
  let quietMs = 0
  let firstSpeechAt: number | null = null
  let stopped: EndpointStop | null = null

  const snapshot = (speaking: boolean): EndpointStep => ({
    speaking,
    speechDetected: speechMs >= cfg.minSpeechMs,
    stop: stopped,
    speechMs,
    silenceMs: quietMs,
  })

  return {
    step(rms, nowMs) {
      const speaking = rms >= cfg.speechRms
      if (stopped !== null) return snapshot(speaking) // 已决策：锁存，不再累计

      // 首帧没有前一时刻，dt=0；时间倒流（切标签页后 rAF 时钟跳变）钳到 0
      const dt = prevMs === null ? 0 : Math.max(0, nowMs - prevMs)
      prevMs = nowMs

      if (speaking) {
        speechMs += dt
        quietMs = 0
        firstSpeechAt ??= nowMs
      } else if (firstSpeechAt !== null) {
        quietMs += dt
      }

      if (firstSpeechAt !== null && nowMs - firstSpeechAt >= cfg.maxUtteranceMs) stopped = 'max'
      else if (speechMs >= cfg.minSpeechMs && quietMs >= cfg.silenceMs) stopped = 'silence'

      return snapshot(speaking)
    },
    reset() {
      prevMs = null
      speechMs = 0
      quietMs = 0
      firstSpeechAt = null
      stopped = null
    },
  }
}
