import type { DepthFeedback } from '../../lib/paper/learnerProfile'

/**
 * 每条回答尾部的轻量反馈条（§6.2 L1 显式证据 + §5.1 Kimi 深度升级入口）：
 * 「太浅 / 刚好 / 太深」→ 画像证据（0 调用）；「换一种深度解释」→ deepAlt 档独立深度回答（deepseek-v4-pro）。
 * 朗读按钮同排（浏览器不支持时由父组件隐藏）。
 */

const OPTIONS: readonly (readonly [DepthFeedback, string])[] = [
  ['shallow', '太浅'],
  ['right', '刚好'],
  ['deep', '太深'],
]

interface Props {
  value?: DepthFeedback
  onFeedback: (kind: DepthFeedback) => void
  onDeepAlt?: () => void
  deepAltLabel?: string
  disabled?: boolean
  speech?: { label: string; onClick: () => void } | null
}

export default function TurnFeedback({ value, onFeedback, onDeepAlt, deepAltLabel, disabled, speech }: Props) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[0.65rem]">
      <span className="text-dim">这段讲解</span>
      {OPTIONS.map(([kind, label]) => (
        <button
          key={kind}
          type="button"
          onClick={() => onFeedback(kind)}
          disabled={disabled}
          aria-pressed={value === kind}
          className={`rounded border px-1.5 py-0.5 transition-colors disabled:opacity-40 ${
            value === kind ? 'border-accent bg-accent/10 text-accent' : 'border-line text-dim hover:text-fg'
          }`}
        >
          {label}
        </button>
      ))}
      {onDeepAlt && (
        <button
          type="button"
          onClick={onDeepAlt}
          disabled={disabled}
          className="rounded border border-line px-1.5 py-0.5 text-dim transition-colors hover:text-accent disabled:opacity-40"
        >
          {deepAltLabel ?? '换一种深度解释'}
        </button>
      )}
      {speech && (
        <button
          type="button"
          onClick={speech.onClick}
          className="rounded border border-line px-1.5 py-0.5 text-dim transition-colors hover:text-accent"
        >
          {speech.label}
        </button>
      )}
    </div>
  )
}
