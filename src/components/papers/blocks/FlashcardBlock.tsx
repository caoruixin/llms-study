import { useState } from 'react'
import type { FlashcardBlockData } from '../../../lib/paper/blockSchemas'
import { evidenceFromFlashcard, type FlashcardRating } from '../../../lib/paper/learnerProfile'
import type { CiteLevel } from '../../../lib/paper/citations'
import type { StoredCiteEntry } from '../../../lib/paper/types'
import BlockCites from './BlockCites'
import type { BlockInteractions, BlockStateSlot } from './interactions'

/**
 * flashcard 展示块（§7.2）：术语卡正反面翻转 + 自评「认识/模糊/不认识」→ L1 画像证据（0 调用）。
 */

interface Props extends BlockInteractions, BlockStateSlot {
  block: FlashcardBlockData
  citeIndex: ReadonlyMap<string, StoredCiteEntry>
  badges: Readonly<Record<string, CiteLevel>> | null
  onJump: (entry: StoredCiteEntry) => void
}

const RATINGS: readonly (readonly [FlashcardRating, string])[] = [
  ['known', '认识'],
  ['fuzzy', '模糊'],
  ['unknown', '不认识'],
]

export default function FlashcardBlock({ block, citeIndex, badges, onJump, onEvidence, state, onState }: Props) {
  // 初值取自持久化状态：刷新后保持已翻面 + 已自评
  const [flipped, setFlipped] = useState(() => state?.revealed ?? state?.rating !== undefined)
  const [rated, setRated] = useState<FlashcardRating | null>(() => state?.rating ?? null)

  const flip = () => {
    const next = !flipped
    setFlipped(next)
    if (next && !state?.revealed) onState?.({ revealed: true })
  }

  const rate = (r: FlashcardRating) => {
    if (rated !== null) return
    setRated(r)
    onEvidence?.(evidenceFromFlashcard(r, block.concept ? [block.concept] : [], Date.now()))
    onState?.({ rating: r, revealed: true })
  }

  return (
    <div className="my-2 rounded-lg border border-line bg-panel-2 p-3">
      <p className="mb-1 text-[0.65rem] text-accent">术语卡</p>
      <button
        type="button"
        onClick={flip}
        aria-expanded={flipped}
        className="w-full rounded border border-line bg-panel px-2.5 py-2 text-left transition-colors hover:border-accent/40"
      >
        <span className="block text-xs font-medium break-words text-fg">{block.front}</span>
        {flipped ? (
          <span className="mt-1.5 block border-t border-line pt-1.5 text-[0.7rem] leading-relaxed break-words text-dim">
            {block.back}
          </span>
        ) : (
          <span className="mt-1 block text-[0.65rem] text-dim">点击查看解释</span>
        )}
      </button>

      {flipped && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[0.7rem]">
          {rated === null ? (
            <>
              <span className="text-dim">刚才你的掌握情况：</span>
              {RATINGS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => rate(value)}
                  className="rounded border border-line px-2 py-0.5 text-dim transition-colors hover:border-accent/40 hover:text-accent"
                >
                  {label}
                </button>
              ))}
            </>
          ) : (
            <span className="text-dim">已记录：{RATINGS.find(([v]) => v === rated)?.[1]}</span>
          )}
        </div>
      )}

      <BlockCites cites={block.cites} citeIndex={citeIndex} badges={badges} onJump={onJump} />
    </div>
  )
}
