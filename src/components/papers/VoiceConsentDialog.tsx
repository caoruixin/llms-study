/**
 * 语音功能独立授权（PLAN-voice-copilot.md 隐私口径，PLAN-paper-copilot.md §9 修订）：
 * 首次开麦前弹出。与 LLM 的按厂商授权（ConsentDialog）互相独立——文本发给对话模型
 * 和录音发给语音服务商是两件事，各自记录在 Dexie consents 表（key 'voice'）。
 */

interface Props {
  /** 语音服务商展示名（来自 /voice/config，取不到时给通用文案） */
  providerLabel?: string
  onDecide: (granted: boolean) => void
}

const SCOPE_LINES = [
  '录音仅用于本次转写，转写完成即弃；不发送任何论文内容与身份信息',
  '回答文本会发送给该服务商合成朗读；合成音频播完即弃、不缓存',
  '服务端不存储、不记录任何音频与文本内容（审计仅有字节数 / 字符数 / 延迟）',
  '标记为敏感的论文全程禁用语音功能',
]

export default function VoiceConsentDialog({ providerLabel, onDecide }: Props) {
  const label = providerLabel ?? '语音服务商'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 backdrop-blur-[1px]">
      <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-xl">
        <h3 className="mb-2 font-semibold text-fg">开启语音陪读？</h3>
        <p className="mb-3 text-sm leading-relaxed text-dim">
          语音提问会把录音上传到 {label} 做识别，朗读回答会把文本发送给它合成语音。继续前请确认：
        </p>
        <ul className="mb-4 space-y-1.5 text-xs leading-relaxed text-dim">
          {SCOPE_LINES.map((l) => (
            <li key={l} className="flex gap-2">
              <span className="shrink-0 text-accent">·</span>
              <span>{l}</span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onDecide(false)}
            className="rounded-lg border border-line bg-panel px-4 py-1.5 text-sm text-fg transition-colors hover:bg-panel-2"
          >
            暂不开启
          </button>
          <button
            type="button"
            onClick={() => onDecide(true)}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
          >
            开启语音
          </button>
        </div>
      </div>
    </div>
  )
}
