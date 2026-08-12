import { useEffect, useRef, useState } from 'react'
import type { StepperBlockData } from '../../../lib/paper/blockSchemas'
import type { CiteLevel } from '../../../lib/paper/citations'
import type { StoredCiteEntry } from '../../../lib/paper/types'
import BlockCites from './BlockCites'

/**
 * stepper 展示块（§7.2）：算法/方法逐步执行。
 * 当前步高亮 + 上一步/下一步 + 可选自动播放（3s/步，读完停）。
 * 只渲染声明式数据；伪代码按等宽文本显示，不执行、不高亮。
 */

interface Props {
  block: StepperBlockData
  citeIndex: ReadonlyMap<string, StoredCiteEntry>
  badges: Readonly<Record<string, CiteLevel>> | null
  onJump: (entry: StoredCiteEntry) => void
}

const AUTO_MS = 3000

export default function StepperBlock({ block, citeIndex, badges, onJump }: Props) {
  const [current, setCurrent] = useState(0)
  const [playing, setPlaying] = useState(false)
  const total = block.steps.length
  const currentRef = useRef(current)
  currentRef.current = current

  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      setCurrent((c) => {
        if (c + 1 >= total) {
          setPlaying(false) // 播到最后一步自动停
          return c
        }
        return c + 1
      })
    }, AUTO_MS)
    return () => clearInterval(timer)
  }, [playing, total])

  const step = block.steps[Math.min(current, total - 1)]

  return (
    <div className="my-2 rounded-lg border border-line bg-panel-2 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-fg">{block.title ?? '步骤演示'}</p>
        <div className="flex items-center gap-1.5 text-[0.7rem]">
          <span className="text-dim">
            {current + 1}/{total}
          </span>
          <button
            type="button"
            onClick={() => setCurrent((c) => Math.max(0, c - 1))}
            disabled={current === 0}
            className="rounded border border-line px-1.5 py-0.5 text-dim transition-colors hover:text-fg disabled:opacity-40"
          >
            上一步
          </button>
          <button
            type="button"
            onClick={() => setCurrent((c) => Math.min(total - 1, c + 1))}
            disabled={current >= total - 1}
            className="rounded border border-line px-1.5 py-0.5 text-dim transition-colors hover:text-fg disabled:opacity-40"
          >
            下一步
          </button>
          {total > 1 && (
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              className="rounded border border-accent/40 px-1.5 py-0.5 text-accent transition-colors hover:bg-accent/10"
            >
              {playing ? '暂停' : '自动播放'}
            </button>
          )}
        </div>
      </div>

      <ol className="space-y-1">
        {block.steps.map((s, i) => {
          const active = i === current
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => {
                  setPlaying(false)
                  setCurrent(i)
                }}
                aria-current={active ? 'step' : undefined}
                className={`flex w-full gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors ${
                  active ? 'bg-accent/10 text-fg' : 'text-dim hover:bg-panel'
                }`}
              >
                <span
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[0.6rem] ${
                    active ? 'bg-accent text-white' : 'border border-line'
                  }`}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 break-words">{s.title}</span>
              </button>
            </li>
          )
        })}
      </ol>

      {step && (step.detail || step.code) && (
        <div className="mt-2 border-t border-line pt-2">
          {step.detail && <p className="text-xs leading-relaxed break-words text-fg">{step.detail}</p>}
          {step.code && (
            <pre className="mt-1.5 overflow-x-auto rounded bg-panel p-2 text-[0.7rem] leading-relaxed text-dim">
              <code>{step.code}</code>
            </pre>
          )}
        </div>
      )}

      <BlockCites cites={block.cites} citeIndex={citeIndex} badges={badges} onJump={onJump} />
    </div>
  )
}
