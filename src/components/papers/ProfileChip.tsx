import { useCallback, useEffect, useRef, useState } from 'react'
import { LEARNER_LEVELS, type LearnerLevel, type ProfileSummary } from '../../lib/paper/learnerProfile'

/**
 * 学习画像层级 chip（§6.2 UI）：展示当前生效层级与来源（自动/手动），
 * 点开可 pin 到指定层级、恢复自动，或重置画像（清 conceptStates + evidence）。
 *
 * 定位（§3.3 响应式）：popover 必须**向右**展开并把宽度压在**最窄**面板的内宽以内——
 * Copilot 面板容器是 `overflow-hidden`，宽度最窄一档是 w-80（标准档；加宽 30rem / 超宽 40rem /
 * 专注陪读整列都更宽），向左展开（right-0）会被整片裁掉，
 * 「入门」按钮与「重置画像」在桌面与 390px 下都点不到。
 */

/** popover 宽度上限：≤ 最窄档面板内宽（w-80 减 p-4 两侧 = 288px），390px 手机面板同样容得下 */
const POPOVER_CLASS = 'w-56 max-w-[min(14rem,calc(100vw-3rem))]'

interface Props {
  summary: ProfileSummary
  onPin: (level: LearnerLevel | null) => void
  onReset: () => void
}

export default function ProfileChip({ summary, onPin, onReset }: Props) {
  const [open, setOpen] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    setConfirmReset(false)
  }, [])

  // Escape 关闭 + 点击外部关闭（popover 覆盖在消息列表之上，没有这两条就只能靠再点 chip）
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target
      if (target instanceof Node && rootRef.current?.contains(target)) return
      close()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
    }
  }, [open, close])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        title="讲解层次由学习画像自适应，可手动固定"
        className="flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[0.65rem] text-accent transition-colors hover:bg-accent/20"
      >
        讲解层次：{summary.level}
        <span className="text-dim">{summary.source === 'manual' ? '手动' : '自动'}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="讲解层次设置"
          className={`absolute top-full left-0 z-30 mt-1 rounded-lg border border-line bg-panel p-2.5 shadow-lg ${POPOVER_CLASS}`}
        >
          <p className="mb-1.5 text-[0.7rem] text-dim">
            当前 {summary.level}（{summary.source === 'manual' ? '手动固定' : '按测验/反馈自动调整'}）
          </p>
          <div className="mb-2 flex flex-wrap gap-1">
            {LEARNER_LEVELS.map((lv) => (
              <button
                key={lv}
                type="button"
                onClick={() => {
                  onPin(lv)
                  close()
                }}
                className={`rounded border px-2 py-0.5 text-[0.7rem] transition-colors ${
                  summary.source === 'manual' && summary.level === lv
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-line text-dim hover:border-accent/40 hover:text-accent'
                }`}
              >
                {lv}
              </button>
            ))}
          </div>
          {summary.source === 'manual' && (
            <button
              type="button"
              onClick={() => {
                onPin(null)
                close()
              }}
              className="mb-2 text-[0.7rem] text-accent underline underline-offset-2"
            >
              恢复自动调整
            </button>
          )}
          {summary.weakConcepts.length > 0 && (
            <p className="mb-2 text-[0.7rem] leading-relaxed text-dim">
              薄弱概念：{summary.weakConcepts.join('、')}
            </p>
          )}
          <div className="border-t border-line pt-1.5">
            {confirmReset ? (
              <div className="flex items-center gap-2 text-[0.7rem]">
                <span className="text-warn">清空全部学习记录？</span>
                <button
                  type="button"
                  onClick={() => {
                    onReset()
                    close()
                  }}
                  className="text-bad underline underline-offset-2"
                >
                  确认
                </button>
                <button type="button" onClick={() => setConfirmReset(false)} className="text-dim underline underline-offset-2">
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmReset(true)}
                className="text-[0.7rem] text-dim transition-colors hover:text-bad"
              >
                重置画像（清空掌握度与证据）
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
