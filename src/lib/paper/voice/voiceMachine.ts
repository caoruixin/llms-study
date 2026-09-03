/**
 * 语音助手状态机（PLAN-voice-copilot.md「状态机边界」）。
 *
 * 纯 reducer，零浏览器 API：录音、转写、发轮、朗读的所有副作用都发生在 useVoiceCopilot 里，
 * 这里只回答「现在允许做什么、状态行显示什么」。node 环境直测全迁移表。
 *
 * 三条不变量（迁移表的设计依据）：
 * 1. **半双工**：speaking 态不能直接开麦，唯一入口是 BARGE_IN（打断播放但不停生成）。
 * 2. **非法事件原样返回**（沿 turnEngine.turnReducer 的守卫写法）：迟到的异步回调
 *    （已取消的录音才 resolve 的 getUserMedia、上一轮的 TTS_DRAINED）不得把状态机拽回去。
 * 3. **空转写不是错误**：服务端 200 {text:""} 表示「没听清」，回到 idle 只留一条软提示，
 *    连续模式据此重新收音；连续 MAX_EMPTY_STREAK 次没听清才自动退出连续对话。
 */

export type VoiceStatus =
  | 'unavailable'
  | 'idle'
  | 'requesting'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'error'

/** hold = 按住说话（松手即发）；toggle = 轻点锁定免按（再点一下结束） */
export type VoiceMode = 'hold' | 'toggle'

export interface VoiceError {
  message: string
  /** true = 同一份录音重传有意义（网络/上游抖动），UI 给「重试」按钮 */
  retryable: boolean
}

export interface VoiceState {
  status: VoiceStatus
  mode: VoiceMode
  continuous: boolean
  error: VoiceError | null
  /** 本次说话开始时刻（MIC_READY 的时间戳）；非 listening 态一律 null */
  utteranceStartedAt: number | null
  /** 连续「没听清」次数：ASR_OK 清零，达到 MAX_EMPTY_STREAK 自动退出连续对话 */
  emptyStreak: number
}

export const initialVoiceState: VoiceState = {
  status: 'idle',
  mode: 'hold',
  continuous: false,
  error: null,
  utteranceStartedAt: null,
  emptyStreak: 0,
}

/** 连续「没听清」上限（PLAN P1「连续 2 次没听清退出」） */
export const MAX_EMPTY_STREAK = 2

export type VoiceEvent =
  /** 按下麦克风球 / 按下热键：进入按住说话 */
  | { type: 'PRESS_START' }
  /** 松开：hold 态才有意义（toggle 下松手不停） */
  | { type: 'PRESS_END' }
  /** 轻点（classifyPressGesture → 'tap'）：idle 起录并锁定免按；已在收音则结束本次说话 */
  | { type: 'TOGGLE' }
  | { type: 'MIC_READY'; at: number }
  | { type: 'MIC_DENIED'; message: string; retryable?: boolean }
  | { type: 'SILENCE_DETECTED' }
  | { type: 'MAX_UTTERANCE' }
  | { type: 'CANCEL' }
  | { type: 'AUDIO_TOO_SHORT' }
  | { type: 'ASR_OK'; text: string }
  | { type: 'ASR_EMPTY' }
  | { type: 'ASR_FAIL'; message: string; retryable?: boolean }
  /** 面板正忙，本轮不排队（turnEngine busy 返回 null，必须显式报出来） */
  | { type: 'TURN_REJECTED'; message: string }
  | { type: 'TURN_SPEAKING' }
  | { type: 'TURN_DONE' }
  | { type: 'TURN_ERROR'; message: string; retryable?: boolean }
  | { type: 'TTS_DRAINED' }
  /** 播报中按球/按热键：取消播放但不停生成，随后重新开麦 */
  | { type: 'BARGE_IN'; mode?: VoiceMode }
  /** stage='transcribe'（默认）= 重传上次录音；'record' = 重新录 */
  | { type: 'RETRY'; stage?: 'transcribe' | 'record' }
  | { type: 'DISMISS' }
  | { type: 'SET_CONTINUOUS'; value: boolean }
  | { type: 'SET_UNAVAILABLE'; value: boolean; message?: string }
  | { type: 'RESET' }

const toIdle = (s: VoiceState): VoiceState => ({ ...s, status: 'idle', error: null, utteranceStartedAt: null })

const toError = (s: VoiceState, message: string, retryable: boolean): VoiceState => ({
  ...s,
  status: 'error',
  error: { message, retryable },
  utteranceStartedAt: null,
})

export function voiceReducer(state: VoiceState, ev: VoiceEvent): VoiceState {
  // 'unavailable' 是吸收态：浏览器无 MediaRecorder / 后端未开启语音时，任何手势与任何
  // 迟到回调都不该把状态机唤醒，唯一出口是 SET_UNAVAILABLE{value:false}。
  if (state.status === 'unavailable' && !(ev.type === 'SET_UNAVAILABLE' && !ev.value)) return state

  switch (ev.type) {
    case 'PRESS_START':
      // speaking 态按球是「打断」，由调用方翻译成 BARGE_IN；这里不接
      if (state.status !== 'idle' && state.status !== 'error') return state
      return { ...state, status: 'requesting', mode: 'hold', error: null, utteranceStartedAt: null }

    case 'PRESS_END':
      if (state.mode !== 'hold') return state
      if (state.status === 'requesting') return toIdle(state) // 麦克风还没就绪就松手 = 放弃
      if (state.status === 'listening') return { ...state, status: 'transcribing', utteranceStartedAt: null }
      return state

    case 'TOGGLE':
      if (state.status === 'idle' || state.status === 'error') {
        return { ...state, status: 'requesting', mode: 'toggle', error: null, utteranceStartedAt: null }
      }
      // 轻点后松手：mic 尚在申请中/已在收音，都只是把 hold 升级成免按，不结束本次说话
      if (state.mode === 'hold' && (state.status === 'requesting' || state.status === 'listening')) {
        return { ...state, mode: 'toggle' }
      }
      if (state.mode === 'toggle' && state.status === 'listening') {
        return { ...state, status: 'transcribing', utteranceStartedAt: null }
      }
      return state

    case 'MIC_READY':
      if (state.status !== 'requesting') return state
      return { ...state, status: 'listening', utteranceStartedAt: ev.at }

    case 'MIC_DENIED':
      if (state.status !== 'requesting') return state
      return toError(state, ev.message, ev.retryable ?? false)

    case 'SILENCE_DETECTED':
    case 'MAX_UTTERANCE':
      if (state.status !== 'listening') return state
      return { ...state, status: 'transcribing', utteranceStartedAt: null }

    case 'CANCEL':
      if (state.status === 'idle' && state.error === null) return state
      return toIdle(state)

    case 'AUDIO_TOO_SHORT':
      if (state.status !== 'transcribing') return state
      // 重传同一份录音没有意义，retryable=false：用户按住再说一次即可
      return toError(state, '没有录到声音，请按住麦克风多说一会儿', false)

    case 'ASR_OK':
      if (state.status !== 'transcribing') return state
      return { ...state, status: 'thinking', error: null, emptyStreak: 0, utteranceStartedAt: null }

    case 'ASR_EMPTY': {
      if (state.status !== 'transcribing') return state
      const emptyStreak = state.emptyStreak + 1
      const exhausted = emptyStreak >= MAX_EMPTY_STREAK
      return {
        ...state,
        status: 'idle',
        utteranceStartedAt: null,
        emptyStreak,
        continuous: exhausted ? false : state.continuous,
        error: {
          message: exhausted && state.continuous ? '连续没听清，已退出连续对话' : '没听清，请再说一遍',
          retryable: false,
        },
      }
    }

    case 'ASR_FAIL':
      if (state.status !== 'transcribing') return state
      return toError(state, ev.message, ev.retryable ?? true)

    case 'TURN_REJECTED':
      if (state.status !== 'thinking') return state
      return toError(state, ev.message, false)

    case 'TURN_SPEAKING':
      if (state.status !== 'thinking') return state
      return { ...state, status: 'speaking' }

    case 'TURN_DONE':
      // speaking 时生成结束不算收工——朗读队列还在排空，等 TTS_DRAINED
      if (state.status !== 'thinking') return state
      return toIdle(state)

    case 'TURN_ERROR':
      if (state.status !== 'thinking' && state.status !== 'speaking') return state
      return toError(state, ev.message, ev.retryable ?? false)

    case 'TTS_DRAINED':
      if (state.status !== 'speaking') return state
      return toIdle(state)

    case 'BARGE_IN':
      if (state.status !== 'speaking') return state
      return { ...state, status: 'requesting', mode: ev.mode ?? state.mode, error: null, utteranceStartedAt: null }

    case 'RETRY':
      if (state.status !== 'error' || state.error?.retryable !== true) return state
      return {
        ...state,
        status: ev.stage === 'record' ? 'requesting' : 'transcribing',
        error: null,
        utteranceStartedAt: null,
      }

    case 'DISMISS':
      if (state.error === null) return state
      return state.status === 'error' ? toIdle(state) : { ...state, error: null }

    case 'SET_CONTINUOUS':
      if (state.continuous === ev.value) return state
      return { ...state, continuous: ev.value }

    case 'SET_UNAVAILABLE':
      if (ev.value) {
        return {
          ...initialVoiceState,
          status: 'unavailable',
          continuous: state.continuous,
          error: ev.message ? { message: ev.message, retryable: false } : null,
        }
      }
      return state.status === 'unavailable' ? { ...initialVoiceState, continuous: state.continuous } : state

    case 'RESET':
      // 切论文 / 卸载 / 标签页 hidden 的全量归位：continuous 是持久化偏好，保留
      return { ...initialVoiceState, continuous: state.continuous }
  }
}

/** 悬浮球下方的状态行文案（唯一一份，UI 不再自己拼） */
export function voiceStatusText(state: VoiceState, opts: { hotkey?: boolean } = {}): string {
  switch (state.status) {
    case 'unavailable':
      return state.error?.message ?? '当前浏览器不支持语音输入'
    case 'idle':
      // 「没听清」这类软提示挂在 idle 上，读完就被下一次按下清掉
      return state.error?.message ?? (opts.hotkey ? '按住说话（或按住 V 键）' : '按住说话')
    case 'requesting':
      return '正在打开麦克风…'
    case 'listening':
      return state.mode === 'toggle' ? '正在听…（再点一下结束）' : '正在听…（松开发送）'
    case 'transcribing':
      return '识别中…'
    case 'thinking':
      return '思考中…'
    case 'speaking':
      return '朗读中（按麦克风可打断）'
    case 'error':
      return state.error?.message ?? '语音出错了，请重试'
  }
}
