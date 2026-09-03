import { describe, expect, it } from 'vitest'
import { classifyPressGesture, micErrorMessage, pickRecorderMime, PRESS_TAP_MS } from './recorderMime'

const supports = (...allowed: string[]) => (t: string) => allowed.includes(t)

describe('pickRecorderMime · 容器梯子', () => {
  it('Chrome/Firefox：优先 webm/opus', () => {
    expect(pickRecorderMime(supports('audio/webm;codecs=opus', 'audio/webm'))).toEqual({
      mime: 'audio/webm;codecs=opus',
      ext: 'webm',
    })
  })

  it('只支持裸 webm 时退到 audio/webm', () => {
    expect(pickRecorderMime(supports('audio/webm'))).toEqual({ mime: 'audio/webm', ext: 'webm' })
  })

  it('Safari：退到 audio/mp4，扩展名 m4a（服务端按它派生上传文件名）', () => {
    expect(pickRecorderMime(supports('audio/mp4'))).toEqual({ mime: 'audio/mp4', ext: 'm4a' })
  })

  it('一个都不支持 → null（调用方隐藏麦克风球）', () => {
    expect(pickRecorderMime(() => false)).toBeNull()
  })

  it('isTypeSupported 抛异常时视为不支持，继续往下试', () => {
    const flaky = (t: string) => {
      if (t.includes('opus')) throw new TypeError('boom')
      return t === 'audio/mp4'
    }
    expect(pickRecorderMime(flaky)).toEqual({ mime: 'audio/mp4', ext: 'm4a' })
  })
})

describe('micErrorMessage · 分文案', () => {
  const err = (name: string) => Object.assign(new Error(name), { name })

  it('权限被拒绝 → 指路地址栏', () => {
    expect(micErrorMessage(err('NotAllowedError'))).toBe('麦克风权限被拒绝，请在浏览器地址栏允许后重试')
    expect(micErrorMessage(err('SecurityError'))).toContain('权限被拒绝')
  })

  it('没有设备 / 被占用 / 参数不满足各有文案', () => {
    expect(micErrorMessage(err('NotFoundError'))).toBe('没有找到可用的麦克风')
    expect(micErrorMessage(err('NotReadableError'))).toBe('麦克风被其他应用占用')
    expect(micErrorMessage(err('OverconstrainedError'))).toContain('录音参数')
  })

  it('未知错误 / 非 Error 值都有兜底', () => {
    expect(micErrorMessage(err('WeirdError'))).toContain('无法访问麦克风')
    expect(micErrorMessage('字符串异常')).toContain('无法访问麦克风')
    expect(micErrorMessage(null)).toContain('无法访问麦克风')
    expect(micErrorMessage(undefined)).toContain('无法访问麦克风')
  })

  it('非标准错误名但 message 表明拒权 → 仍给权限被拒文案（自动化浏览器场景）', () => {
    expect(micErrorMessage(Object.assign(new Error('Permission denied'), { name: 'Error' }))).toContain('权限被拒绝')
    expect(micErrorMessage(Object.assign(new Error('Permission dismissed'), { name: '' }))).toContain('权限被拒绝')
    expect(micErrorMessage('NotAllowed by user agent')).toContain('权限被拒绝')
  })
})

describe('classifyPressGesture · 300ms 边界', () => {
  it('短按是轻点，长按是按住', () => {
    expect(classifyPressGesture(1000, 1000 + PRESS_TAP_MS - 1)).toBe('tap')
    expect(classifyPressGesture(1000, 1000 + PRESS_TAP_MS)).toBe('hold')
    expect(classifyPressGesture(1000, 1000 + 1500)).toBe('hold')
  })

  it('同一时刻按下松开算轻点', () => {
    expect(classifyPressGesture(1000, 1000)).toBe('tap')
  })

  it('时间戳异常（倒流 / NaN）判轻点，宁可多开一会儿麦', () => {
    expect(classifyPressGesture(2000, 1000)).toBe('tap')
    expect(classifyPressGesture(Number.NaN, 1000)).toBe('tap')
  })
})
