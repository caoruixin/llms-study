import { useState } from 'react'
import { LEARNER_LEVELS, type LearnerLevel, type ProfileSummary } from '../../lib/paper/learnerProfile'

/**
 * 学习画像层级 chip（§6.2 UI）：展示当前生效层级与来源（自动/手动），
 * 点开可 pin 到指定层级、恢复自动，或重置画像（清 conceptStates + evidence）。
 */

interface Props {
  summary: ProfileSummary
  onPin: (level: LearnerLevel | null) => void
  onReset: () => void
}

export default function ProfileChip({ summary, onPin, onReset }: Props) {
  const [open, setOpen] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="讲解层次由学习画像自适应，可手动固定"
        className="flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[0.65rem] text-accent transition-colors hover:bg-accent/20"
      >
        讲解层次：{summary.level}
        <span className="text-dim">{summary.source === 'manual' ? '手动' : '自动'}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1 w-56 rounded-lg border border-line bg-panel p-2.5 shadow-lg">
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
                  setOpen(false)
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
                setOpen(false)
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
                    setConfirmReset(false)
                    setOpen(false)
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
