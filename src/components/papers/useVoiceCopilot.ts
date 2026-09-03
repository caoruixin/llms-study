import { useCallback, useEffect, useRef, useState } from 'react'
import { createSilenceDetector, type EndpointStep, type SilenceDetector } from '../../lib/paper/voice/endpointing'
import { classifyPressGesture, micErrorMessage } from '../../lib/paper/voice/recorderMime'
import { createRecorder, type RecordedAudio, type Recorder } from '../../lib/paper/voice/recorder'
import { transcribeAudio, VoiceApiError } from '../../lib/paper/voice/voiceApi'
import { unlockAudio } from '../../lib/paper/voice/cloudTtsPlayer'
import {
  initialVoiceState,
  voiceReducer,
  voiceStatusText,
  type VoiceEvent,
  type VoiceState,
} from '../../lib/paper/voice/voiceMachine'
import { usePaperUi } from '../../pages/papers/paperUiStore'

/**
 * 语音陪读的编排 hook（PLAN-voice-copilot.md「核心流」）：把纯状态机（voiceMachine）与
 * 副作用世界（录音 / ASR / store 往返 / 热键 / 连续对话循环）缝在一起。
 *
 * 职责边界：
 * - 本 hook 只管「采音 → 转写 → 交出文本」；上下文快照与 store 写入由调用方的
 *   onTranscript 完成（工作台持有 blocks/position/选区，不把它们搬进来）。
 * - 面板侧的轮次进展经 store 的 voiceTurnPhase 回流，这里翻译成状态机事件——
 *   两个组件（悬浮球 / CopilotPanel）之间不存在直接引用。
 * - speaking 态按下 = 打断：requestStopSpeak() 让面板停播，本机转 requesting，
 *   等 BARGE_GUARD_MS 再真正开麦（半双工，杜绝把自己的尾音录进去）。
 *
 * 所有异步回调落地前都对照 stateRef 校验现势（reducer 的「非法事件原样返回」在
 * 这里的镜像）：迟到的 getUserMedia / stop() / fetch 不得驱动过期会话。
 */

/** 打断后的静音守卫：给 <audio>.pause 一点真正停下来的时间 */
const BARGE_GUARD_MS = 200
/** 连续对话重臂延迟：TTS 排空后稍候再开麦 */
const REARM_GUARD_MS = 300
/** 自动会话（连续对话重臂）里持续无人声的自动退出时限 */
const AUTO_NO_SPEECH_EXIT_MS = 8000
/** 小于此字节/时长的录音不值得打一次 ASR（口误碰了一下） */
const MIN_AUDIO_BYTES = 2048
const MIN_UTTERANCE_MS = 300

export interface VoiceCopilotOpts {
  paperId: string
  /** 服务端语音已开启 && 非敏感论文（浏览器能力在 hook 内自检） */
  enabled: boolean
  /** ASR 成功后的提交回调：由工作台快照上下文并 requestVoiceAsk */
  onTranscript: (text: string) => void
  /** 单次说话硬上限（来自 /voice/config），缺省用 endpointing 默认值 */
  maxUtteranceMs?: number
  /** 「按住 V 说话」热键（桌面端 && 用户偏好开启时为 true） */
  hotkeyEnabled?: boolean
  /** 语音独立授权（consents 表 key 'voice'）：未授权时按下不采音，转而回调 onNeedConsent */
  consentGranted?: boolean
  onNeedConsent?: () => void
}

export interface VoiceCopilotApi {
  state: VoiceState
  statusText: string
  /** pointerdown / 热键按下 */
  press: () => void
  /** pointerup / 热键松开 */
  release: () => void
  cancel: () => void
  retry: () => void
  dismiss: () => void
  /** 电平显示元素：录音时在其上写 --voice-level CSS 变量（不进 React 状态） */
  bindLevelEl: (el: HTMLElement | null) => void
}

const isRecorderSupported = (): boolean =>
  typeof MediaRecorder !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  typeof navigator.mediaDevices?.getUserMedia === 'function'

export function useVoiceCopilot(opts: VoiceCopilotOpts): VoiceCopilotApi {
  const { paperId, enabled, maxUtteranceMs, hotkeyEnabled = false } = opts

  const [state, setState] = useState<VoiceState>(initialVoiceState)
  const stateRef = useRef(state)
  const dispatch = useCallback((ev: VoiceEvent): VoiceState => {
    const next = voiceReducer(stateRef.current, ev)
    if (next !== stateRef.current) {
      stateRef.current = next
      setState(next)
    }
    return next
  }, [])

  // 渲染期同步 ref（事件回调不重挂，SelectionActions 先例）
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const onTranscriptRef = useRef(opts.onTranscript)
  onTranscriptRef.current = opts.onTranscript
  const hotkeyRef = useRef(hotkeyEnabled)
  hotkeyRef.current = hotkeyEnabled
  const maxUtteranceRef = useRef(maxUtteranceMs)
  maxUtteranceRef.current = maxUtteranceMs
  const consentRef = useRef(opts.consentGranted ?? true)
  consentRef.current = opts.consentGranted ?? true
  const onNeedConsentRef = useRef(opts.onNeedConsent)
  onNeedConsentRef.current = opts.onNeedConsent

  const recorderRef = useRef<Recorder | null>(null)
  const levelElRef = useRef<HTMLElement | null>(null)
  const detectorRef = useRef<SilenceDetector | null>(null)
  const pressAtRef = useRef<number | null>(null)
  const lastAudioRef = useRef<RecordedAudio | null>(null)
  /** 本次收音是否为连续对话自动重臂（决定 8s 无人声自动退出是否生效） */
  const autoSessionRef = useRef(false)
  const hotkeyHeldRef = useRef(false)

  const requestStopSpeak = usePaperUi((s) => s.requestStopSpeak)

  // -----------------------------------------------------------------------
  // 录音器（惰性单例；电平订阅与端点检测挂在同一条 onLevel 通道上）
  // -----------------------------------------------------------------------

  // doTranscribe 声明在后（需要先有 getRecorder），这里经 ref 调用——闭包只在事件发生时取值
  const doTranscribeRef = useRef<() => Promise<void>>(async () => {})
  const handleEndpointStep = (step: EndpointStep): void => {
    const cur = stateRef.current
    if (cur.status !== 'listening') return
    if (step.stop === 'max') {
      const st = dispatch({ type: 'MAX_UTTERANCE' })
      if (st.status === 'transcribing') void doTranscribeRef.current()
      return
    }
    // 静默断句只服务免按会话（toggle / 连续重臂）；按住说话靠松手
    if (step.stop === 'silence' && cur.mode === 'toggle') {
      const st = dispatch({ type: 'SILENCE_DETECTED' })
      if (st.status === 'transcribing') void doTranscribeRef.current()
      return
    }
    if (
      autoSessionRef.current &&
      !step.speechDetected &&
      cur.utteranceStartedAt !== null &&
      Date.now() - cur.utteranceStartedAt > AUTO_NO_SPEECH_EXIT_MS
    ) {
      recorderRef.current?.cancel()
      dispatch({ type: 'CANCEL' })
    }
  }
  const handleStepRef = useRef(handleEndpointStep)
  handleStepRef.current = handleEndpointStep

  const getRecorder = useCallback((): Recorder => {
    if (recorderRef.current === null) {
      const rec = createRecorder()
      rec.onLevel((rms) => {
        // 电平走 CSS 变量：两大组件都是无 selector 订阅 store，高频数据绝不进 zustand
        levelElRef.current?.style.setProperty('--voice-level', String(1 + Math.min(1, rms * 6) * 0.6))
        const det = detectorRef.current
        if (det && stateRef.current.status === 'listening') handleStepRef.current(det.step(rms, Date.now()))
      })
      recorderRef.current = rec
    }
    return recorderRef.current
  }, [])

  // -----------------------------------------------------------------------
  // 采音 → 转写
  // -----------------------------------------------------------------------

  const openMic = useCallback(async () => {
    try {
      await getRecorder().start()
    } catch (e) {
      dispatch({ type: 'MIC_DENIED', message: micErrorMessage(e) })
      return
    }
    // await 窗口内被松手/取消（PRESS_END → idle）：状态机已离开 requesting，作废这次开麦
    if (stateRef.current.status !== 'requesting') {
      getRecorder().cancel()
      return
    }
    const opt = maxUtteranceRef.current
    detectorRef.current = createSilenceDetector(opt !== undefined ? { maxUtteranceMs: opt } : {})
    dispatch({ type: 'MIC_READY', at: Date.now() })
  }, [dispatch, getRecorder])

  const transcribeBlob = useCallback(
    async (audio: RecordedAudio) => {
      try {
        const { text } = await transcribeAudio(audio.blob, { lang: 'auto' })
        if (stateRef.current.status !== 'transcribing') return
        const trimmed = text.trim()
        if (trimmed === '') {
          dispatch({ type: 'ASR_EMPTY' })
          return
        }
        lastAudioRef.current = null
        dispatch({ type: 'ASR_OK', text: trimmed })
        onTranscriptRef.current(trimmed)
      } catch (e) {
        if (stateRef.current.status !== 'transcribing') return
        dispatch({
          type: 'ASR_FAIL',
          message: e instanceof Error ? e.message : '语音识别失败，请重试',
          retryable: e instanceof VoiceApiError ? e.retryable : true,
        })
      }
    },
    [dispatch],
  )

  const doTranscribe = useCallback(async () => {
    detectorRef.current = null
    const audio = await getRecorder().stop()
    if (stateRef.current.status !== 'transcribing') return
    if (audio === null || audio.blob.size < MIN_AUDIO_BYTES || audio.durationMs < MIN_UTTERANCE_MS) {
      dispatch({ type: 'AUDIO_TOO_SHORT' })
      return
    }
    lastAudioRef.current = audio
    await transcribeBlob(audio)
  }, [dispatch, getRecorder, transcribeBlob])
  doTranscribeRef.current = doTranscribe

  // -----------------------------------------------------------------------
  // 手势入口
  // -----------------------------------------------------------------------

  const press = useCallback(() => {
    if (!enabledRef.current) return
    // 语音独立授权：未授权的按下（含热键）不开麦，交给 UI 弹授权对话框
    if (!consentRef.current) {
      onNeedConsentRef.current?.()
      return
    }
    // 自动播放解锁必须发生在用户手势内（唯一可靠的时机就是这次按下）
    unlockAudio()
    const cur = stateRef.current
    if (cur.status === 'speaking') {
      requestStopSpeak()
      dispatch({ type: 'BARGE_IN' })
      pressAtRef.current = Date.now()
      autoSessionRef.current = false
      window.setTimeout(() => {
        if (stateRef.current.status === 'requesting') void openMic()
      }, BARGE_GUARD_MS)
      return
    }
    pressAtRef.current = Date.now()
    if (cur.status !== 'idle' && cur.status !== 'error') return // listening（免按锁定）等松手时按 TOGGLE 结束
    autoSessionRef.current = false
    const st = dispatch({ type: 'PRESS_START' })
    if (st.status === 'requesting') void openMic()
  }, [dispatch, openMic, requestStopSpeak])

  const release = useCallback(() => {
    const downAt = pressAtRef.current
    pressAtRef.current = null
    if (downAt === null) return
    const cur = stateRef.current
    if (cur.status !== 'requesting' && cur.status !== 'listening') return
    if (classifyPressGesture(downAt, Date.now()) === 'tap') {
      // 轻点：hold 升级为免按锁定；已锁定则结束本次说话
      const st = dispatch({ type: 'TOGGLE' })
      if (st.status === 'transcribing') void doTranscribeRef.current()
      return
    }
    let st = dispatch({ type: 'PRESS_END' })
    // 免按锁定下长按松手也应结束（PRESS_END 对 toggle 是 no-op）
    if (st.status === 'listening' && st.mode === 'toggle') st = dispatch({ type: 'TOGGLE' })
    if (st.status === 'transcribing') void doTranscribeRef.current()
    else if (st.status === 'idle') getRecorder().cancel() // 麦克风未就绪就松手
  }, [dispatch, getRecorder])

  const cancel = useCallback(() => {
    if (stateRef.current.status === 'speaking') requestStopSpeak()
    recorderRef.current?.cancel()
    detectorRef.current = null
    dispatch({ type: 'CANCEL' })
  }, [dispatch, requestStopSpeak])

  const retry = useCallback(() => {
    const audio = lastAudioRef.current
    const st = dispatch({ type: 'RETRY', stage: audio !== null ? 'transcribe' : 'record' })
    if (st.status === 'transcribing' && audio !== null) void transcribeBlob(audio)
    else if (st.status === 'requesting') void openMic()
  }, [dispatch, openMic, transcribeBlob])

  const dismiss = useCallback(() => {
    dispatch({ type: 'DISMISS' })
  }, [dispatch])

  const bindLevelEl = useCallback((el: HTMLElement | null) => {
    levelElRef.current = el
  }, [])

  // -----------------------------------------------------------------------
  // store 回流：面板轮次阶段 → 状态机事件
  // -----------------------------------------------------------------------

  const voiceTurnPhase = usePaperUi((s) => s.voiceTurnPhase)
  const voiceTurnError = usePaperUi((s) => s.voiceTurnError)
  useEffect(() => {
    switch (voiceTurnPhase) {
      case 'speaking':
        dispatch({ type: 'TURN_SPEAKING' })
        break
      case 'done':
        if (stateRef.current.status === 'speaking') dispatch({ type: 'TTS_DRAINED' })
        else dispatch({ type: 'TURN_DONE' })
        break
      case 'error':
        dispatch({ type: 'TURN_ERROR', message: voiceTurnError ?? '本轮语音提问失败', retryable: false })
        break
      default:
        break
    }
  }, [voiceTurnPhase, voiceTurnError, dispatch])

  // 偏好同步：连续对话开关
  const voiceContinuous = usePaperUi((s) => s.voiceContinuous)
  const setVoicePrefs = usePaperUi((s) => s.setVoicePrefs)
  useEffect(() => {
    dispatch({ type: 'SET_CONTINUOUS', value: voiceContinuous })
  }, [voiceContinuous, dispatch])

  // 机内自动退出连续对话（连续没听清）必须回写偏好：否则 chip 仍亮着，
  // 且上面的同步 effect 会用 store 的旧 true 把机内状态复活（QA R1 V17）。
  // 只认「true→false 的迁移」，避免挂载初始 false 误杀刚恢复的偏好。
  const prevContinuousRef = useRef(state.continuous)
  useEffect(() => {
    const prev = prevContinuousRef.current
    prevContinuousRef.current = state.continuous
    if (prev && !state.continuous && usePaperUi.getState().voiceContinuous) {
      setVoicePrefs({ voiceContinuous: false })
    }
  }, [state.continuous, setVoicePrefs])

  // 可用性：浏览器能力 + 上层开关（吸收态，任何迟到回调都唤不醒）
  useEffect(() => {
    if (!enabled || !isRecorderSupported()) {
      dispatch({
        type: 'SET_UNAVAILABLE',
        value: true,
        ...(isRecorderSupported() ? {} : { message: '当前浏览器不支持录音' }),
      })
    } else {
      dispatch({ type: 'SET_UNAVAILABLE', value: false })
    }
  }, [enabled, dispatch])

  // -----------------------------------------------------------------------
  // 连续对话：一轮收尾（thinking/speaking/transcribing → idle）后自动重臂
  // -----------------------------------------------------------------------

  const prevStatusRef = useRef(state.status)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = state.status
    if (state.status !== 'idle' || !state.continuous) return
    // 只有「一轮走完」的收尾才重臂：TTS 排空 / 无可朗读内容 / 没听清（机内限次）
    if (prev !== 'speaking' && prev !== 'thinking' && prev !== 'transcribing') return
    if (!enabledRef.current || document.visibilityState !== 'visible') return
    if (usePaperUi.getState().voicePanelBusy) return
    const t = window.setTimeout(() => {
      const cur = stateRef.current
      if (cur.status !== 'idle' || !cur.continuous || !enabledRef.current) return
      autoSessionRef.current = true
      const st = dispatch({ type: 'TOGGLE' }) // 免按会话：静默断句收音
      if (st.status === 'requesting') void openMic()
    }, REARM_GUARD_MS)
    return () => window.clearTimeout(t)
  }, [state.status, state.continuous, dispatch, openMic])

  // -----------------------------------------------------------------------
  // 全局热键：按住 V 说话；Escape 取消（空依赖 + ref 镜像，StrictMode 安全）
  // -----------------------------------------------------------------------

  const pressRef = useRef(press)
  pressRef.current = press
  const releaseRef = useRef(release)
  releaseRef.current = release
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!enabledRef.current) return
      if (e.key === 'Escape') {
        if (stateRef.current.status !== 'idle' && stateRef.current.status !== 'unavailable') cancelRef.current()
        return
      }
      if (!hotkeyRef.current) return
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (e.key !== 'v' && e.key !== 'V') return
      const target = e.target as Element | null
      if (target?.closest('textarea, input, [contenteditable="true"], [contenteditable=""]')) return
      e.preventDefault()
      hotkeyHeldRef.current = true
      pressRef.current()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (!hotkeyHeldRef.current) return
      if (e.key === 'v' || e.key === 'V') {
        hotkeyHeldRef.current = false
        releaseRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // 标签页隐藏：收麦归位（连续模式不重臂）；播报的停止由面板自身的可见性策略决定
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'hidden') return
      recorderRef.current?.cancel()
      detectorRef.current = null
      dispatch({ type: 'RESET' })
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [dispatch])

  // 切论文 / 卸载：释放麦克风与录音器，状态机归位
  useEffect(
    () => () => {
      recorderRef.current?.dispose()
      recorderRef.current = null
      detectorRef.current = null
      lastAudioRef.current = null
      stateRef.current = initialVoiceState
    },
    [paperId],
  )

  return {
    state,
    statusText: voiceStatusText(state, { hotkey: hotkeyEnabled }),
    press,
    release,
    cancel,
    retry,
    dismiss,
    bindLevelEl,
  }
}
