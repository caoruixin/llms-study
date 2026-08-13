import { useState } from 'react'
import type { TeachBackBlockData } from '../../../lib/paper/blockSchemas'
import type { CiteLevel } from '../../../lib/paper/citations'
import type { StoredCiteEntry } from '../../../lib/paper/types'
import BlockCites from './BlockCites'
import type { BlockInteractions, BlockStateSlot } from './interactions'

/**
 * teach-back 展示块（§7.2 / §6.1e'）：用户用自己的话复述 → 面板发起 1 次调用，
 * 模型给流式反馈 + copilot:verdict 尾岛（遗漏点/掌握证据），verdict 进画像。
 */

interface Props extends BlockInteractions, BlockStateSlot {
  block: TeachBackBlockData
  citeIndex: ReadonlyMap<string, StoredCiteEntry>
  badges: Readonly<Record<string, CiteLevel>> | null
  onJump: (entry: StoredCiteEntry) => void
}

export default function TeachBackBlock({ block, citeIndex, badges, onJump, onTeachBack, busy, state, onState }: Props) {
  const [answer, setAnswer] = useState('')
  // 已提交态持久化：刷新后不会又出现一个可再次提交的输入框（复述正文按 §8 不落库）
  const [submitted, setSubmitted] = useState(() => state?.submitted ?? false)

  const submit = () => {
    const text = answer.trim()
    if (!text || busy || submitted) return
    setSubmitted(true)
    onTeachBack?.({ prompt: block.prompt, answer: text, ...(block.concept ? { concept: block.concept } : {}) })
    onState?.({ submitted: true })
  }

  return (
    <div className="my-2 rounded-lg border border-accent/30 bg-panel-2 p-3">
      <p className="mb-0.5 text-[0.65rem] text-accent">复述检查</p>
      <p className="mb-2 text-xs leading-relaxed break-words text-fg">{block.prompt}</p>
      {block.hints.length > 0 && (
        <ul className="mb-2 list-disc space-y-0.5 pl-4 text-[0.7rem] text-dim">
          {block.hints.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      )}
      {submitted ? (
        <p className="text-[0.7rem] text-dim">已提交复述，反馈见下一条回答。</p>
      ) : (
        <>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
            rows={3}
            placeholder="用你自己的话解释一遍（⌘/Ctrl + Enter 提交）"
            className="w-full resize-y rounded border border-line bg-panel px-2 py-1.5 text-xs leading-relaxed"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!answer.trim() || busy}
            className="mt-1.5 rounded-lg bg-accent px-2.5 py-1 text-[0.7rem] font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
          >
            提交复述，让 Copilot 点评
          </button>
        </>
      )}
      <BlockCites cites={block.cites} citeIndex={citeIndex} badges={badges} onJump={onJump} />
    </div>
  )
}
