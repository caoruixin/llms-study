import { describe, expect, it } from 'vitest'
import {
  initialVoiceState,
  voiceReducer,
  voiceStatusText,
  type VoiceEvent,
  type VoiceState,
  type VoiceStatus,
} from './voiceMachine'

const at = (over: Partial<VoiceState> = {}): VoiceState => ({ ...initialVoiceState, ...over })

/** 走一遍事件序列，返回终态 */
const run = (state: VoiceState, ...events: VoiceEvent[]): VoiceState => events.reduce(voiceReducer, state)

const ALL_STATUSES: VoiceStatus[] = [
  'unavailable',
  'idle',
  'requesting',
  'listening',
  'transcribing',
  'thinking',
  'speaking',
  'error',
]

describe('voiceReducer · 按住说话主链路', () => {
  it('PRESS_START → requesting（mode=hold，清掉上次的错误）', () => {
    const s = voiceReducer(at({ status: 'error', error: { message: '旧错误', retryable: true } }), {
      type: 'PRESS_START',
    })
    expect(s).toMatchObject({ status: 'requesting', mode: 'hold', error: null })
  })

  it('MIC_READY → listening 并记下起始时刻', () => {
    const s = run(initialVoiceState, { type: 'PRESS_START' }, { type: 'MIC_READY', at: 1234 })
    expect(s).toMatchObject({ status: 'listening', utteranceStartedAt: 1234 })
  })

  it('PRESS_END（hold）→ transcribing，起始时刻清空', () => {
    const s = run(initialVoiceState, { type: 'PRESS_START' }, { type: 'MIC_READY', at: 1 }, { type: 'PRESS_END' })
    expect(s).toMatchObject({ status: 'transcribing', utteranceStartedAt: null })
  })

  it('麦克风还没就绪就松手 → 回 idle（放弃本次）', () => {
    const s = run(initialVoiceState, { type: 'PRESS_START' }, { type: 'PRESS_END' })
    expect(s.status).toBe('idle')
  })

  it('ASR_OK → thinking，TURN_SPEAKING → speaking，TTS_DRAINED → idle', () => {
    let s = run(initialVoiceState, { type: 'PRESS_START' }, { type: 'MIC_READY', at: 1 }, { type: 'PRESS_END' })
    s = voiceReducer(s, { type: 'ASR_OK', text: '这段在讲什么' })
    expect(s.status).toBe('thinking')
    s = voiceReducer(s, { type: 'TURN_SPEAKING' })
    expect(s.status).toBe('speaking')
    s = voiceReducer(s, { type: 'TTS_DRAINED' })
    expect(s.status).toBe('idle')
  })

  it('thinking 时 TURN_DONE 直接收工；speaking 时 TURN_DONE 要等朗读排空', () => {
    expect(voiceReducer(at({ status: 'thinking' }), { type: 'TURN_DONE' }).status).toBe('idle')
    const speaking = at({ status: 'speaking' })
    expect(voiceReducer(speaking, { type: 'TURN_DONE' })).toBe(speaking)
  })
})

describe('voiceReducer · 轻点免按（toggle）', () => {
  it('idle 轻点 → requesting + mode=toggle', () => {
    expect(voiceReducer(initialVoiceState, { type: 'TOGGLE' })).toMatchObject({
      status: 'requesting',
      mode: 'toggle',
    })
  })

  it('按住途中判成轻点：requesting/listening 只升级 mode，不结束本次说话', () => {
    const requesting = run(initialVoiceState, { type: 'PRESS_START' }, { type: 'TOGGLE' })
    expect(requesting).toMatchObject({ status: 'requesting', mode: 'toggle' })

    const listening = run(initialVoiceState, { type: 'PRESS_START' }, { type: 'MIC_READY', at: 1 }, { type: 'TOGGLE' })
    expect(listening).toMatchObject({ status: 'listening', mode: 'toggle' })
  })

  it('toggle 态下再点一次 → transcribing', () => {
    const s = run(
      initialVoiceState,
      { type: 'TOGGLE' },
      { type: 'MIC_READY', at: 1 },
      { type: 'TOGGLE' },
    )
    expect(s.status).toBe('transcribing')
  })

  it('toggle 态松手不停（PRESS_END 无效）', () => {
    const s = run(initialVoiceState, { type: 'TOGGLE' }, { type: 'MIC_READY', at: 1 })
    expect(voiceReducer(s, { type: 'PRESS_END' })).toBe(s)
  })
})

describe('voiceReducer · 端点检测与取消', () => {
  const listening = () => run(initialVoiceState, { type: 'PRESS_START' }, { type: 'MIC_READY', at: 5 })

  it('SILENCE_DETECTED / MAX_UTTERANCE 都从 listening 进 transcribing', () => {
    expect(voiceReducer(listening(), { type: 'SILENCE_DETECTED' }).status).toBe('transcribing')
    expect(voiceReducer(listening(), { type: 'MAX_UTTERANCE' }).status).toBe('transcribing')
  })

  it('CANCEL 从任意活动态回 idle 并清错误', () => {
    for (const status of ['requesting', 'listening', 'transcribing', 'thinking', 'speaking', 'error'] as const) {
      const s = voiceReducer(at({ status, error: { message: 'x', retryable: true } }), { type: 'CANCEL' })
      expect(s).toMatchObject({ status: 'idle', error: null, utteranceStartedAt: null })
    }
  })

  it('干净的 idle 上 CANCEL 是空操作（同一个对象）', () => {
    expect(voiceReducer(initialVoiceState, { type: 'CANCEL' })).toBe(initialVoiceState)
  })
})

describe('voiceReducer · 失败分流', () => {
  it('MIC_DENIED → error，默认不可重试', () => {
    const s = run(initialVoiceState, { type: 'PRESS_START' }, { type: 'MIC_DENIED', message: '麦克风权限被拒绝' })
    expect(s).toMatchObject({ status: 'error', error: { message: '麦克风权限被拒绝', retryable: false } })
  })

  it('MIC_DENIED 可显式标记为可重试（被占用等）', () => {
    const s = run(
      initialVoiceState,
      { type: 'PRESS_START' },
      { type: 'MIC_DENIED', message: '麦克风被其他应用占用', retryable: true },
    )
    expect(s.error?.retryable).toBe(true)
  })

  it('AUDIO_TOO_SHORT → error 且不可重试（重传同一段没意义）', () => {
    const s = voiceReducer(at({ status: 'transcribing' }), { type: 'AUDIO_TOO_SHORT' })
    expect(s.status).toBe('error')
    expect(s.error?.retryable).toBe(false)
    expect(s.error?.message).toContain('没有录到声音')
  })

  it('ASR_FAIL 默认可重试（留着 blob 一键重传）', () => {
    const s = voiceReducer(at({ status: 'transcribing' }), { type: 'ASR_FAIL', message: '语音服务暂时不可用' })
    expect(s).toMatchObject({ status: 'error', error: { message: '语音服务暂时不可用', retryable: true } })
  })

  it('TURN_REJECTED（面板忙）→ error，显式不静默', () => {
    const s = voiceReducer(at({ status: 'thinking' }), { type: 'TURN_REJECTED', message: '回答进行中，说完这轮再问' })
    expect(s).toMatchObject({ status: 'error', error: { retryable: false } })
    expect(s.error?.message).toContain('回答进行中')
  })

  it('TURN_ERROR 在 thinking 与 speaking 都生效', () => {
    for (const status of ['thinking', 'speaking'] as const) {
      expect(voiceReducer(at({ status }), { type: 'TURN_ERROR', message: '生成失败' }).status).toBe('error')
    }
  })

  it('RETRY 默认重传录音（→ transcribing），stage=record 则重新录音', () => {
    const failed = at({ status: 'error', error: { message: '超时', retryable: true } })
    expect(voiceReducer(failed, { type: 'RETRY' })).toMatchObject({ status: 'transcribing', error: null })
    expect(voiceReducer(failed, { type: 'RETRY', stage: 'record' }).status).toBe('requesting')
  })

  it('不可重试的错误上 RETRY 是空操作', () => {
    const hard = at({ status: 'error', error: { message: '权限被拒绝', retryable: false } })
    expect(voiceReducer(hard, { type: 'RETRY' })).toBe(hard)
  })

  it('DISMISS 清错误回 idle；无错误时空操作', () => {
    const s = voiceReducer(at({ status: 'error', error: { message: 'x', retryable: false } }), { type: 'DISMISS' })
    expect(s).toMatchObject({ status: 'idle', error: null })
    expect(voiceReducer(initialVoiceState, { type: 'DISMISS' })).toBe(initialVoiceState)
  })

  it('DISMISS 也能清掉 idle 上挂着的软提示', () => {
    const soft = at({ error: { message: '没听清，请再说一遍', retryable: false } })
    expect(voiceReducer(soft, { type: 'DISMISS' })).toMatchObject({ status: 'idle', error: null })
  })
})

describe('voiceReducer · 空转写与连续对话', () => {
  it('ASR_EMPTY 不是错误：回 idle + 软提示，emptyStreak 递增', () => {
    const s = voiceReducer(at({ status: 'transcribing' }), { type: 'ASR_EMPTY' })
    expect(s).toMatchObject({ status: 'idle', emptyStreak: 1 })
    expect(s.error?.message).toContain('没听清')
  })

  it('连续 2 次没听清 → 自动关掉连续对话并换文案', () => {
    let s = at({ status: 'transcribing', continuous: true })
    s = voiceReducer(s, { type: 'ASR_EMPTY' })
    expect(s.continuous).toBe(true)
    s = voiceReducer({ ...s, status: 'transcribing' }, { type: 'ASR_EMPTY' })
    expect(s).toMatchObject({ emptyStreak: 2, continuous: false })
    expect(s.error?.message).toContain('已退出连续对话')
  })

  it('ASR_OK 把 emptyStreak 清零', () => {
    const s = voiceReducer(at({ status: 'transcribing', emptyStreak: 1 }), { type: 'ASR_OK', text: '好' })
    expect(s.emptyStreak).toBe(0)
  })

  it('SET_CONTINUOUS 只在值变化时产生新状态', () => {
    expect(voiceReducer(initialVoiceState, { type: 'SET_CONTINUOUS', value: false })).toBe(initialVoiceState)
    expect(voiceReducer(initialVoiceState, { type: 'SET_CONTINUOUS', value: true }).continuous).toBe(true)
  })
})

describe('voiceReducer · 打断与不可用', () => {
  it('BARGE_IN 只在 speaking 生效 → requesting（不停生成）', () => {
    const s = voiceReducer(at({ status: 'speaking' }), { type: 'BARGE_IN' })
    expect(s).toMatchObject({ status: 'requesting', error: null })
    const thinking = at({ status: 'thinking' })
    expect(voiceReducer(thinking, { type: 'BARGE_IN' })).toBe(thinking)
  })

  it('BARGE_IN 可带上新的手势模式（热键打断后按住继续说）', () => {
    expect(voiceReducer(at({ status: 'speaking' }), { type: 'BARGE_IN', mode: 'toggle' }).mode).toBe('toggle')
  })

  it('SET_UNAVAILABLE(true) 从任意状态进 unavailable 并保留 continuous 偏好', () => {
    const s = voiceReducer(at({ status: 'listening', continuous: true }), {
      type: 'SET_UNAVAILABLE',
      value: true,
      message: '当前浏览器不支持录音',
    })
    expect(s).toMatchObject({ status: 'unavailable', continuous: true })
    expect(s.error?.message).toContain('不支持')
  })

  it('unavailable 是吸收态：除 SET_UNAVAILABLE(false) 外一律原样返回', () => {
    const dead = at({ status: 'unavailable' })
    const events: VoiceEvent[] = [
      { type: 'PRESS_START' },
      { type: 'TOGGLE' },
      { type: 'MIC_READY', at: 1 },
      { type: 'CANCEL' },
      { type: 'RESET' },
      { type: 'SET_CONTINUOUS', value: true },
      { type: 'SET_UNAVAILABLE', value: true },
      { type: 'TTS_DRAINED' },
    ]
    for (const ev of events) expect(voiceReducer(dead, ev)).toBe(dead)
    expect(voiceReducer(dead, { type: 'SET_UNAVAILABLE', value: false }).status).toBe('idle')
  })

  it('SET_UNAVAILABLE(false) 在非 unavailable 态是空操作', () => {
    expect(voiceReducer(initialVoiceState, { type: 'SET_UNAVAILABLE', value: false })).toBe(initialVoiceState)
  })

  it('RESET 全量归位但保留 continuous 偏好', () => {
    const s = voiceReducer(at({ status: 'speaking', continuous: true, emptyStreak: 1, mode: 'toggle' }), {
      type: 'RESET',
    })
    expect(s).toEqual({ ...initialVoiceState, continuous: true })
  })
})

describe('voiceReducer · 非法迁移一律原样返回', () => {
  /** 每个事件只在这些状态里合法，其余状态必须返回同一个对象 */
  const legal: Record<VoiceEvent['type'], VoiceStatus[]> = {
    PRESS_START: ['idle', 'error'],
    PRESS_END: ['requesting', 'listening'],
    TOGGLE: ['idle', 'error', 'requesting', 'listening'],
    MIC_READY: ['requesting'],
    MIC_DENIED: ['requesting'],
    SILENCE_DETECTED: ['listening'],
    MAX_UTTERANCE: ['listening'],
    CANCEL: ['requesting', 'listening', 'transcribing', 'thinking', 'speaking', 'error'],
    AUDIO_TOO_SHORT: ['transcribing'],
    ASR_OK: ['transcribing'],
    ASR_EMPTY: ['transcribing'],
    ASR_FAIL: ['transcribing'],
    TURN_REJECTED: ['thinking'],
    TURN_SPEAKING: ['thinking'],
    TURN_DONE: ['thinking'],
    TURN_ERROR: ['thinking', 'speaking'],
    TTS_DRAINED: ['speaking'],
    BARGE_IN: ['speaking'],
    RETRY: ['error'],
    DISMISS: ['error'],
    SET_CONTINUOUS: ['idle', 'requesting', 'listening', 'transcribing', 'thinking', 'speaking', 'error'],
    SET_UNAVAILABLE: ALL_STATUSES,
    RESET: ALL_STATUSES.filter((s) => s !== 'unavailable'),
  }

  const sample: VoiceEvent[] = [
    { type: 'PRESS_START' },
    { type: 'PRESS_END' },
    { type: 'TOGGLE' },
    { type: 'MIC_READY', at: 9 },
    { type: 'MIC_DENIED', message: '拒绝' },
    { type: 'SILENCE_DETECTED' },
    { type: 'MAX_UTTERANCE' },
    { type: 'CANCEL' },
    { type: 'AUDIO_TOO_SHORT' },
    { type: 'ASR_OK', text: 'x' },
    { type: 'ASR_EMPTY' },
    { type: 'ASR_FAIL', message: 'x' },
    { type: 'TURN_REJECTED', message: 'x' },
    { type: 'TURN_SPEAKING' },
    { type: 'TURN_DONE' },
    { type: 'TURN_ERROR', message: 'x' },
    { type: 'TTS_DRAINED' },
    { type: 'BARGE_IN' },
    { type: 'RETRY' },
    { type: 'DISMISS' },
    { type: 'SET_CONTINUOUS', value: true },
    { type: 'SET_UNAVAILABLE', value: true },
    { type: 'RESET' },
  ]

  it('覆盖了全部事件类型', () => {
    expect(new Set(sample.map((e) => e.type)).size).toBe(Object.keys(legal).length)
  })

  for (const ev of sample) {
    it(`${ev.type} 在非法状态下不改变状态`, () => {
      for (const status of ALL_STATUSES) {
        if (legal[ev.type].includes(status)) continue
        // mode=hold + 可重试错误：让「合法」判定只取决于 status
        const state = at({ status, mode: 'hold', error: status === 'error' ? { message: 'e', retryable: true } : null })
        expect(voiceReducer(state, ev)).toBe(state)
      }
    })
  }
})

describe('voiceStatusText', () => {
  it('每个状态都有中文状态行', () => {
    expect(voiceStatusText(initialVoiceState)).toBe('按住说话')
    expect(voiceStatusText(initialVoiceState, { hotkey: true })).toContain('V')
    expect(voiceStatusText(at({ status: 'requesting' }))).toContain('麦克风')
    expect(voiceStatusText(at({ status: 'listening' }))).toContain('正在听…')
    expect(voiceStatusText(at({ status: 'listening', mode: 'toggle' }))).toContain('再点一下')
    expect(voiceStatusText(at({ status: 'transcribing' }))).toBe('识别中…')
    expect(voiceStatusText(at({ status: 'thinking' }))).toBe('思考中…')
    expect(voiceStatusText(at({ status: 'speaking' }))).toBe('朗读中（按麦克风可打断）')
    expect(voiceStatusText(at({ status: 'unavailable' }))).toContain('不支持')
  })

  it('错误态与 idle 软提示都显示 error.message', () => {
    expect(voiceStatusText(at({ status: 'error', error: { message: '麦克风被拒绝', retryable: false } }))).toBe(
      '麦克风被拒绝',
    )
    expect(voiceStatusText(at({ error: { message: '没听清，请再说一遍', retryable: false } }))).toBe(
      '没听清，请再说一遍',
    )
  })

  it('错误态但没有 error 对象时有兜底文案', () => {
    expect(voiceStatusText(at({ status: 'error' }))).toBe('语音出错了，请重试')
  })
})
