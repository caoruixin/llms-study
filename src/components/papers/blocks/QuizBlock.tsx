import { useMemo, useState } from 'react'
import type { QuizBlockData } from '../../../lib/paper/blockSchemas'
import { gradeChoice, optionOrder } from '../../../lib/paper/quizGrading'
import { evidenceFromQuiz, type QuizOutcome } from '../../../lib/paper/learnerProfile'
import type { CiteLevel } from '../../../lib/paper/citations'
import type { StoredCiteEntry } from '../../../lib/paper/types'
import BlockCites from './BlockCites'
import type { BlockInteractions } from './interactions'

/**
 * quiz 展示块（§7.2 / §6.1e：判分 0 次 LLM 调用）。
 * - 单选/多选：按块内 answer 键本地即时判分。
 * - 简答：不本地判分，展示参考答案后由用户自评 对/部分/错。
 * 判分结果 → L1 画像证据。选项顺序可确定性洗牌（默认关闭：解析文案常引用原顺序）。
 */

interface Props extends BlockInteractions {
  block: QuizBlockData
  /** 岛序号：洗牌种子（同一块每次渲染顺序一致） */
  seed: number
  citeIndex: ReadonlyMap<string, StoredCiteEntry>
  badges: Readonly<Record<string, CiteLevel>> | null
  onJump: (entry: StoredCiteEntry) => void
}

const SHUFFLE_OPTIONS = false

const OUTCOME_LABEL: Record<QuizOutcome, string> = { correct: '答对了', partial: '部分正确', wrong: '答错了' }
const OUTCOME_CLASS: Record<QuizOutcome, string> = { correct: 'text-ok', partial: 'text-warn', wrong: 'text-bad' }

export default function QuizBlock({ block, seed, citeIndex, badges, onJump, onEvidence }: Props) {
  const [picked, setPicked] = useState<number[]>([])
  const [outcome, setOutcome] = useState<QuizOutcome | null>(null)
  const [revealed, setRevealed] = useState(false)
  const order = useMemo(() => optionOrder(block.options.length, seed, SHUFFLE_OPTIONS), [block.options.length, seed])

  const concepts = block.concept ? [block.concept] : []
  const settle = (result: QuizOutcome) => {
    if (outcome !== null) return // 一题只记一次证据
    setOutcome(result)
    onEvidence?.(evidenceFromQuiz(result, concepts, Date.now()))
  }

  const toggle = (idx: number) => {
    if (outcome !== null) return
    setPicked((p) => (block.variant === 'single' ? [idx] : p.includes(idx) ? p.filter((x) => x !== idx) : [...p, idx]))
  }

  const grade = () => {
    if (picked.length === 0) return
    settle(gradeChoice(block, picked).outcome)
  }

  const answers = block.answer === null ? [] : Array.isArray(block.answer) ? block.answer : [block.answer]

  return (
    <div className="my-2 rounded-lg border border-accent/30 bg-panel-2 p-3">
      <p className="mb-0.5 text-[0.65rem] text-accent">
        理解检查 · {block.variant === 'single' ? '单选' : block.variant === 'multi' ? '多选' : '简答'}
      </p>
      <p className="mb-2 text-xs leading-relaxed break-words text-fg">{block.stem}</p>

      {block.variant === 'short' ? (
        <div className="space-y-1.5">
          {!revealed ? (
            <button
              type="button"
              onClick={() => setRevealed(true)}
              className="rounded border border-accent/40 px-2 py-0.5 text-[0.7rem] text-accent transition-colors hover:bg-accent/10"
            >
              先自己答，再看参考答案
            </button>
          ) : (
            <>
              <div className="rounded border border-line bg-panel p-2 text-[0.7rem] leading-relaxed text-fg">
                {block.reference ?? block.why ?? '（本题未提供参考答案）'}
              </div>
              {outcome === null ? (
                <div className="flex flex-wrap items-center gap-1.5 text-[0.7rem]">
                  <span className="text-dim">对照参考答案自评：</span>
                  {(
                    [
                      ['correct', '答对了'],
                      ['partial', '部分正确'],
                      ['wrong', '没答对'],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => settle(v)}
                      className="rounded border border-line px-2 py-0.5 text-dim transition-colors hover:border-accent/40 hover:text-accent"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : (
                <p className={`text-[0.7rem] ${OUTCOME_CLASS[outcome]}`}>已记录自评：{OUTCOME_LABEL[outcome]}</p>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <ul className="space-y-1">
            {order.map((idx) => {
              const isPicked = picked.includes(idx)
              const isAnswer = answers.includes(idx)
              const graded = outcome !== null
              return (
                <li key={idx}>
                  <button
                    type="button"
                    onClick={() => toggle(idx)}
                    disabled={graded}
                    aria-pressed={isPicked}
                    className={`flex w-full items-start gap-2 rounded border px-2 py-1 text-left text-xs transition-colors ${
                      graded && isAnswer
                        ? 'border-ok/50 bg-ok/10 text-fg'
                        : graded && isPicked
                          ? 'border-bad/50 bg-bad/10 text-fg'
                          : isPicked
                            ? 'border-accent/50 bg-accent/10 text-fg'
                            : 'border-line text-dim hover:border-accent/40'
                    }`}
                  >
                    <span className="mt-0.5 shrink-0 text-[0.65rem]">{String.fromCharCode(65 + idx)}</span>
                    <span className="min-w-0 flex-1 break-words">{block.options[idx]}</span>
                    {graded && isAnswer && <span className="shrink-0 text-[0.65rem] text-ok">正确</span>}
                  </button>
                </li>
              )
            })}
          </ul>
          {outcome === null ? (
            <button
              type="button"
              onClick={grade}
              disabled={picked.length === 0}
              className="mt-2 rounded-lg bg-accent px-2.5 py-1 text-[0.7rem] font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
            >
              提交答案
            </button>
          ) : (
            <p className={`mt-2 text-[0.7rem] font-medium ${OUTCOME_CLASS[outcome]}`}>{OUTCOME_LABEL[outcome]}</p>
          )}
        </>
      )}

      {outcome !== null && block.why && (
        <p className="mt-1.5 rounded border border-line bg-panel p-2 text-[0.7rem] leading-relaxed text-dim">
          {block.why}
        </p>
      )}

      <BlockCites cites={block.cites} citeIndex={citeIndex} badges={badges} onJump={onJump} />
    </div>
  )
}
