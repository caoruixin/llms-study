import { describe, expect, it } from 'vitest'
import { createSilenceDetector, DEFAULT_ENDPOINT_OPTS, rmsOf } from './endpointing'

describe('rmsOf', () => {
  it('全 128（静音）→ 0', () => {
    expect(rmsOf(new Uint8Array(16).fill(128))).toBe(0)
  })

  it('满量程方波 → 接近 1 且不越界', () => {
    const full = rmsOf(Uint8Array.from([0, 255, 0, 255]))
    expect(full).toBeGreaterThan(0.99)
    expect(full).toBeLessThanOrEqual(1)
  })

  it('半幅方波 → 0.5', () => {
    expect(rmsOf(Uint8Array.from([64, 192, 64, 192]))).toBeCloseTo(0.5, 5)
  })

  it('空数组 → 0（analyser 首帧还没数据）', () => {
    expect(rmsOf(new Uint8Array(0))).toBe(0)
  })
})

describe('createSilenceDetector · 默认参数', () => {
  const LOUD = 0.2
  const QUIET = 0.001

  /** 以 100ms 一帧推进，返回最后一帧的判定 */
  const feed = (
    det: ReturnType<typeof createSilenceDetector>,
    frames: readonly { rms: number; ms: number }[],
    startMs = 1000,
  ) => {
    let t = startMs
    let last = det.step(frames[0].rms, t)
    for (const f of frames) {
      t += f.ms
      last = det.step(f.rms, t)
    }
    return { last, t }
  }

  it('默认参数与 PLAN 一致', () => {
    expect(DEFAULT_ENDPOINT_OPTS).toEqual({
      minSpeechMs: 400,
      silenceMs: 1200,
      maxUtteranceMs: 30000,
      speechRms: 0.02,
    })
  })

  it('一直静默不触发停止（没说话就不该断句）', () => {
    const det = createSilenceDetector()
    const { last } = feed(det, Array.from({ length: 60 }, () => ({ rms: QUIET, ms: 100 })))
    expect(last).toMatchObject({ speaking: false, speechDetected: false, stop: null })
  })

  it('说话 + 静默 1.2s → stop=silence', () => {
    const det = createSilenceDetector()
    const frames = [
      ...Array.from({ length: 6 }, () => ({ rms: LOUD, ms: 100 })), // 600ms 人声
      ...Array.from({ length: 11 }, () => ({ rms: QUIET, ms: 100 })), // 1100ms 静默：还不到
    ]
    const { last, t } = feed(det, frames)
    expect(last.stop).toBeNull()
    expect(last.speechDetected).toBe(true)
    expect(det.step(QUIET, t + 100).stop).toBe('silence') // 满 1200ms
  })

  it('人声不足 minSpeechMs（咳嗽/点击）后的长静默不触发停止', () => {
    const det = createSilenceDetector()
    const frames = [
      ...Array.from({ length: 3 }, () => ({ rms: LOUD, ms: 100 })), // 300ms < 400ms
      ...Array.from({ length: 30 }, () => ({ rms: QUIET, ms: 100 })),
    ]
    const { last } = feed(det, frames)
    expect(last.speechDetected).toBe(false)
    expect(last.stop).toBeNull()
  })

  it('静默中途又说话 → 静默计时归零', () => {
    const det = createSilenceDetector()
    let t = 0
    for (let i = 0; i < 6; i++) {
      t += 100
      det.step(LOUD, t)
    }
    for (let i = 0; i < 10; i++) {
      t += 100
      det.step(QUIET, t)
    }
    t += 100
    expect(det.step(LOUD, t).silenceMs).toBe(0)
    for (let i = 0; i < 10; i++) {
      t += 100
      det.step(QUIET, t)
    }
    expect(det.step(QUIET, t + 100).stop).toBeNull() // 只累计了 1100ms
    expect(det.step(QUIET, t + 200).stop).toBe('silence')
  })

  it('从第一次出声起满 maxUtteranceMs → stop=max（硬帽优先）', () => {
    const det = createSilenceDetector({ maxUtteranceMs: 1000, silenceMs: 5000, minSpeechMs: 100 })
    det.step(LOUD, 0)
    det.step(LOUD, 500)
    expect(det.step(LOUD, 900).stop).toBeNull()
    expect(det.step(LOUD, 1000).stop).toBe('max')
  })

  it('决策锁存：之后的帧返回同一个 stop，不再累计', () => {
    const det = createSilenceDetector({ minSpeechMs: 100, silenceMs: 200 })
    det.step(0.3, 0)
    det.step(0.3, 200)
    expect(det.step(0.001, 400).stop).toBe('silence')
    const after = det.step(0.3, 4000)
    expect(after.stop).toBe('silence')
    expect(after.speaking).toBe(true) // 电平仍如实上报（UI 画波形）
  })

  it('reset 后可复用同一个检测器', () => {
    const det = createSilenceDetector({ minSpeechMs: 100, silenceMs: 200 })
    det.step(0.3, 0)
    det.step(0.3, 200)
    expect(det.step(0.001, 500).stop).toBe('silence')
    det.reset()
    expect(det.step(0.001, 600)).toMatchObject({ stop: null, speechMs: 0, silenceMs: 0 })
  })

  it('时钟倒流（标签页挂起后 rAF 跳变）不产生负时长', () => {
    const det = createSilenceDetector()
    det.step(0.3, 5000)
    const back = det.step(0.3, 100)
    expect(back.speechMs).toBe(0)
    expect(back.stop).toBeNull()
  })

  it('阈值可注入：speechRms 抬高后同一电平不算人声', () => {
    const det = createSilenceDetector({ speechRms: 0.5 })
    expect(det.step(0.2, 0).speaking).toBe(false)
    expect(det.step(0.6, 100).speaking).toBe(true)
  })
})
