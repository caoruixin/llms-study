import { useEffect, useRef, useState } from 'react'
import { synthesizeSpeech, type VoiceVoiceOption } from '../../lib/paper/voice/voiceApi'
import { usePaperUi } from '../../pages/papers/paperUiStore'

/**
 * 悬浮球的语音设置浮层：全部读写 usePaperUi 的 VoicePrefs（persist 白名单）。
 * 外点/Escape 关闭沿 PersonaChip 范式（document 级监听 + closest 豁免自身）。
 * 试听走一次真实 TTS（费用可忽略），失败只在行内提示，不打扰主流程。
 */

interface Props {
  voices: readonly VoiceVoiceOption[]
  defaultVoiceId?: string
  onClose: () => void
}

const PREVIEW_TEXT = '你好，我是论文陪读语音助手。'

function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onToggle,
}: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      title={hint}
      className="flex min-h-10 w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left text-xs text-fg transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-40 md:min-h-0"
    >
      <span className="min-w-0 flex-1">{label}</span>
      <span
        aria-hidden
        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-line'}`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}`}
        />
      </span>
    </button>
  )
}

export default function VoiceSettingsPopover({ voices, defaultVoiceId, onClose }: Props) {
  const {
    voiceSpeakAloud,
    voiceSpeakTypedTurns,
    voiceContinuous,
    voiceHotkey,
    voiceTtsVoice,
    voiceTtsEngine,
    setVoicePrefs,
  } = usePaperUi()

  const rootRef = useRef<HTMLDivElement | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewErr, setPreviewErr] = useState('')

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const el = e.target as Element | null
      if (el && rootRef.current?.contains(el)) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const preview = async (voiceId: string) => {
    if (previewing) return
    setPreviewing(true)
    setPreviewErr('')
    try {
      const blob = await synthesizeSpeech(PREVIEW_TEXT, voiceId ? { voice: voiceId } : {})
      const url = URL.createObjectURL(blob)
      const el = new Audio(url)
      el.onended = () => URL.revokeObjectURL(url)
      el.onerror = () => URL.revokeObjectURL(url)
      await el.play()
    } catch (e) {
      setPreviewErr(e instanceof Error ? e.message : '试听失败')
    } finally {
      setPreviewing(false)
    }
  }

  const effectiveVoice = voiceTtsVoice || defaultVoiceId || ''

  return (
    <div
      ref={rootRef}
      role="menu"
      className="absolute right-0 bottom-full z-50 mb-2 w-60 rounded-xl border border-line bg-panel p-2 shadow-xl"
    >
      <p className="px-2 pt-1 pb-1.5 text-[0.7rem] font-semibold text-dim">语音设置</p>
      <SwitchRow
        label="自动朗读语音提问的回答"
        checked={voiceSpeakAloud}
        onToggle={() => setVoicePrefs({ voiceSpeakAloud: !voiceSpeakAloud })}
      />
      <SwitchRow
        label="打字提问也自动朗读"
        checked={voiceSpeakTypedTurns}
        onToggle={() => setVoicePrefs({ voiceSpeakTypedTurns: !voiceSpeakTypedTurns })}
      />
      <SwitchRow
        label="连续对话（读完自动续听）"
        hint={voiceSpeakAloud ? undefined : '需要先开启自动朗读（以朗读结束为续听信号）'}
        checked={voiceContinuous}
        disabled={!voiceSpeakAloud}
        onToggle={() => setVoicePrefs({ voiceContinuous: !voiceContinuous })}
      />
      <div className="hidden md:block">
        <SwitchRow
          label="按住 V 键说话"
          checked={voiceHotkey}
          onToggle={() => setVoicePrefs({ voiceHotkey: !voiceHotkey })}
        />
      </div>
      <SwitchRow
        label="云端朗读（关闭用浏览器朗读）"
        hint="云端音色更自然；浏览器朗读免费离线"
        checked={voiceTtsEngine === 'cloud'}
        onToggle={() => setVoicePrefs({ voiceTtsEngine: voiceTtsEngine === 'cloud' ? 'browser' : 'cloud' })}
      />
      {voiceTtsEngine === 'cloud' && voices.length > 0 && (
        <div className="mt-1 flex items-center gap-1.5 px-2 py-1">
          <label className="shrink-0 text-[0.7rem] text-dim" htmlFor="voice-tts-voice">
            音色
          </label>
          <select
            id="voice-tts-voice"
            value={effectiveVoice}
            onChange={(e) => setVoicePrefs({ voiceTtsVoice: e.target.value === (defaultVoiceId ?? '') ? '' : e.target.value })}
            className="min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-1.5 py-1 text-xs"
          >
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
                {v.id === defaultVoiceId ? '（默认）' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={previewing}
            onClick={() => void preview(effectiveVoice)}
            className="shrink-0 rounded-lg border border-line px-2 py-1 text-[0.7rem] text-dim transition-colors hover:text-fg disabled:opacity-40"
          >
            {previewing ? '…' : '试听'}
          </button>
        </div>
      )}
      {previewErr && <p className="px-2 py-1 text-[0.65rem] text-bad">{previewErr}</p>}
      <div className="mt-1 border-t border-line pt-1">
        <button
          type="button"
          onClick={() => {
            setVoicePrefs({ voiceBallHidden: true })
            onClose()
          }}
          className="min-h-10 w-full rounded-lg px-2 py-1.5 text-left text-xs text-dim transition-colors hover:bg-panel-2 hover:text-fg md:min-h-0"
        >
          隐藏麦克风球（可在页面头部 🎙 按钮恢复）
        </button>
      </div>
    </div>
  )
}
