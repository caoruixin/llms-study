import { useEffect, useRef, useState } from 'react'
import { motion, useDragControls } from 'framer-motion'
import { MQ, useMediaQuery } from '../../lib/useMediaQuery'
import { getRepos } from '../../lib/paper/repo/repos'
import type { VoiceVoiceOption } from '../../lib/paper/voice/voiceApi'
import { usePaperUi } from '../../pages/papers/paperUiStore'
import VoiceConsentDialog from './VoiceConsentDialog'
import VoiceSettingsPopover from './VoiceSettingsPopover'
import { useVoiceCopilot } from './useVoiceCopilot'

/**
 * 语音陪读悬浮球（PLAN-voice-copilot.md）：按住说话 / 轻点锁定免按 / 播报中按下打断。
 *
 * - 定位沿工作台 toast 先例：工作台根带 transform、是 fixed 后代的包含块。
 * - 拖动沿 AskDialog 先例：dragListener=false + 拖柄 controls.start(e)，仅 ≥md 可拖，
 *   constraints 是 pointer-events-none 的 fixed inset-0 包层；位置不持久化。
 * - `data-paper-selection-ui` 让 SelectionActions 忽略球上的 pointerup。
 * - 电平不进 React：hook 把 --voice-level 写在内环元素上，纯 CSS 缩放。
 * - 首次开麦前弹语音独立授权（consents 表 key 'voice'），热键路径同受 hook 的授权闸约束。
 */

interface Props {
  paperId: string
  /** 服务端语音开启 && 非敏感论文（工作台已把守，这里透传给 hook 的吸收态判定） */
  enabled: boolean
  onTranscript: (text: string) => void
  maxUtteranceMs?: number
  providerLabel?: string
  voices?: readonly VoiceVoiceOption[]
  defaultVoiceId?: string
  /** 手机端布局位：free=右下 / sheet=Copilot 底部面板开启（挪到上方阅读区） / sheetFull=右上 */
  mobileLayout?: 'free' | 'sheet' | 'sheetFull'
  /**
   * 桌面（≥md）默认锚位，由工作台按 Copilot 列实测宽度计算（QA R1 V13：
   * 固定 right-6 会盖住面板的输入行与 🎙）。像素值走内联样式，拖动偏移叠加其上。
   */
  desktopPos?: { right: number; bottom: number }
}

const BALL_STYLE: Record<string, string> = {
  idle: 'border-line bg-panel text-dim hover:bg-panel-2 hover:text-fg',
  requesting: 'border-accent/60 bg-accent/5 text-accent',
  listening: 'border-accent bg-accent/10 text-accent voice-listening',
  transcribing: 'border-accent/60 bg-panel text-accent',
  thinking: 'border-accent/60 bg-panel text-accent',
  speaking: 'border-accent bg-panel text-accent',
  error: 'border-bad/60 bg-panel text-bad',
}

/**
 * 手机端锚位类名（完整字面量，Tailwind 扫描规则）。sheet 开启时不再用
 * `bottom-[calc(70dvh+…)]`：dvh 与「transform 包含块内的 fixed」混算在真机上有
 * 系统性偏差（QA R1 V11 实测叠进面板 26px），改为确定性的顶部定位——
 * sheet 只占底部 70dvh，顶部阅读区余量放球必然无遮挡。
 */
const POS_MOBILE: Record<NonNullable<Props['mobileLayout']>, string> = {
  free: 'right-4 bottom-16',
  sheet: 'right-3 top-[7.5rem]',
  sheetFull: 'right-3 top-14',
}

const DEFAULT_DESKTOP_POS = { right: 24, bottom: 32 }

export default function VoiceMicBall({
  paperId,
  enabled,
  onTranscript,
  maxUtteranceMs,
  providerLabel,
  voices = [],
  defaultVoiceId,
  mobileLayout = 'free',
  desktopPos = DEFAULT_DESKTOP_POS,
}: Props) {
  const isTablet = useMediaQuery(MQ.md)
  const voiceHotkey = usePaperUi((s) => s.voiceHotkey)
  const voiceContinuous = usePaperUi((s) => s.voiceContinuous)
  const voiceSpeakAloud = usePaperUi((s) => s.voiceSpeakAloud)
  const setVoicePrefs = usePaperUi((s) => s.setVoicePrefs)

  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 'unknown' = 未授权（按下时弹窗）；读库是异步的，挂载后回填 */
  const [consent, setConsent] = useState<'unknown' | 'granted' | 'ask'>('unknown')
  useEffect(() => {
    let alive = true
    void getRepos()
      .copilot.getConsent('voice')
      .then((row) => {
        if (alive && row?.granted) setConsent('granted')
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [paperId])

  const voice = useVoiceCopilot({
    paperId,
    enabled,
    onTranscript,
    ...(maxUtteranceMs !== undefined ? { maxUtteranceMs } : {}),
    hotkeyEnabled: voiceHotkey && isTablet,
    consentGranted: consent === 'granted',
    onNeedConsent: () => setConsent('ask'),
  })
  const { state, statusText } = voice

  const controls = useDragControls()
  const constraintsRef = useRef<HTMLDivElement | null>(null)

  // 浏览器不支持录音 / 上层关闭：整组不渲染（工作台层还有服务端开关与敏感论文把守）
  if (state.status === 'unavailable') return null

  const active = state.status !== 'idle' || state.error !== null
  const busy = state.status === 'transcribing' || state.status === 'thinking'

  return (
    <>
      {/* 拖动约束层：pointer-events-none 不挡任何交互，只提供边界（AskDialog 先例） */}
      <div ref={constraintsRef} className="pointer-events-none fixed inset-0 z-50" aria-hidden />
      <motion.div
        // 布局位切换（桌面↔手机 / sheet 三态）时重挂：framer 的拖动位移是 transform，
        // 换锚位不清残留会把球带出视口（QA R2 V11）。桌面档位内 key 恒定，拖动位置保留。
        key={isTablet ? 'desktop' : mobileLayout}
        drag={isTablet}
        dragListener={false}
        dragControls={controls}
        dragMomentum={false}
        dragElastic={0}
        dragConstraints={constraintsRef}
        data-paper-selection-ui=""
        data-voice-phase={state.status}
        style={isTablet ? { right: desktopPos.right, bottom: desktopPos.bottom } : undefined}
        className={`fixed z-50 flex flex-col items-end gap-1.5 ${isTablet ? '' : POS_MOBILE[mobileLayout]}`}
      >
        {active && (
          <div className="flex max-w-[16rem] items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-[0.7rem] text-dim shadow-md">
            <span className="min-w-0 flex-1">{statusText}</span>
            {state.status === 'error' && state.error?.retryable && (
              <button type="button" onClick={voice.retry} className="shrink-0 text-accent hover:underline">
                重试
              </button>
            )}
            {(state.status === 'error' || (state.status === 'idle' && state.error !== null)) && (
              <button type="button" onClick={voice.dismiss} title="关闭提示" className="shrink-0 hover:text-fg">
                ×
              </button>
            )}
            {(state.status === 'listening' || state.status === 'transcribing' || state.status === 'thinking') && (
              <button type="button" onClick={voice.cancel} title="取消本次语音" className="shrink-0 hover:text-bad">
                ×
              </button>
            )}
          </div>
        )}
        <div className="relative flex items-center gap-1.5">
          {settingsOpen && (
            <VoiceSettingsPopover voices={voices} {...(defaultVoiceId ? { defaultVoiceId } : {})} onClose={() => setSettingsOpen(false)} />
          )}
          {/* 拖柄：仅桌面（触屏拖动与滚动手势冲突，AskDialog 同判断） */}
          {isTablet && (
            <span
              onPointerDown={(e) => controls.start(e)}
              title="拖动移动位置"
              className="cursor-grab touch-none rounded px-0.5 py-1 text-xs text-dim/60 select-none hover:text-dim active:cursor-grabbing"
              aria-hidden
            >
              ⠿
            </span>
          )}
          <button
            type="button"
            aria-pressed={voiceContinuous}
            onClick={() => setVoicePrefs({ voiceContinuous: !voiceContinuous })}
            disabled={!voiceSpeakAloud}
            title={
              !voiceSpeakAloud
                ? '连续对话需要先开启自动朗读（设置里打开）'
                : voiceContinuous
                  ? '连续对话已开：回答读完自动继续听'
                  : '开启连续对话'
            }
            className={`rounded-full border px-2 py-0.5 text-[0.65rem] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              voiceContinuous ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-panel text-dim hover:text-fg'
            }`}
          >
            连续
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen}
            title="语音设置"
            className="rounded-full border border-line bg-panel px-1.5 py-0.5 text-[0.7rem] text-dim transition-colors hover:text-fg"
          >
            ⚙
          </button>
          <button
            type="button"
            aria-pressed={state.status === 'listening'}
            aria-label={statusText}
            title={statusText}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              voice.press()
            }}
            onPointerUp={voice.release}
            onPointerCancel={voice.release}
            onContextMenu={(e) => e.preventDefault()}
            className={`relative flex h-12 w-12 touch-none items-center justify-center rounded-full border shadow-lg transition-colors select-none ${BALL_STYLE[state.status] ?? BALL_STYLE.idle}`}
          >
            {/* 电平内环：hook 写 --voice-level（1..1.6），纯 CSS 缩放，零重渲染 */}
            <span
              ref={voice.bindLevelEl}
              aria-hidden
              className={`absolute inset-0 rounded-full ${state.status === 'listening' ? 'bg-accent/15' : ''}`}
              style={{ transform: 'scale(var(--voice-level, 1))' }}
            />
            <span className="relative text-xl leading-none">
              {state.status === 'speaking' ? '🔊' : state.status === 'error' ? '⚠️' : '🎙'}
            </span>
            {busy && <span className="absolute -top-0.5 -right-0.5 h-2 w-2 animate-pulse rounded-full bg-accent" />}
          </button>
        </div>
      </motion.div>
      {consent === 'ask' && (
        <VoiceConsentDialog
          {...(providerLabel ? { providerLabel } : {})}
          onDecide={(granted) => {
            if (granted) {
              void getRepos().copilot.setConsent('voice', true).catch(() => undefined)
              setConsent('granted')
            } else {
              setConsent('unknown')
            }
          }}
        />
      )}
    </>
  )
}
