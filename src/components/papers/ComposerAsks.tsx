import { useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { chipText } from '../../lib/paper/askCompose'
import type { ComposerQuote, PendingAsk } from '../../pages/papers/paperUiStore'
import QuoteBlock from './CopilotQuote'

/**
 * Copilot 输入框上方的两行 chips：
 * - 「排队中」：回答进行中时点下的选区动作（解释这段 / 更简单 / …），本轮结束后面板自动按序发起；
 *   不忙时点 chip 立即发起（队列暂停后这是唯一的发起方式）；× 取消。
 * - 「引用」：「加入提问」攒下的选区，随下一条问题一起发送；点 chip 展开 QuoteBlock 预览；× 移除。
 * 两行都是 role=list；chip 聚焦时 Delete/Backspace 移除并把焦点交给下一 chip 或 textarea。
 * `data-queued-ask` / `data-composer-quote` 供 E2E 定位。
 */

interface Props {
  queued: readonly PendingAsk[]
  quotes: readonly ComposerQuote[]
  /** 回答进行中（含尚未进入 busy 的在飞窗口）：排队 chip 不可点发起 */
  busy: boolean
  /** 用户按过「■ 停止」或上一轮失败：不再自动发送，提示点 chip 手动发 */
  paused: boolean
  onFire: (ask: PendingAsk) => void
  onRemoveQueued: (id: string) => void
  onRemoveQuote: (id: string) => void
  /** 键盘移除后没有下一 chip 时的落脚点（面板的 textarea） */
  focusFallbackRef?: RefObject<HTMLElement | null>
}

const CHIP_CLASS =
  'inline-flex max-w-full items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[0.65rem] text-accent'
const CHIP_BODY_CLASS = 'min-w-0 truncate text-left disabled:cursor-not-allowed disabled:opacity-60'
const CHIP_X_CLASS = 'shrink-0 rounded-full px-0.5 leading-none transition-colors hover:text-bad'

export default function ComposerAsks({
  queued,
  quotes,
  busy,
  paused,
  onFire,
  onRemoveQueued,
  onRemoveQuote,
  focusFallbackRef,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 展开预览的引用 id；被移除后自然不再匹配 */
  const [openQuoteId, setOpenQuoteId] = useState<string | null>(null)

  if (queued.length === 0 && quotes.length === 0) return null

  /**
   * Delete/Backspace 移除：先在**移除前**定位 DOM 顺序上的下一 chip（React 的删除在事件返回后才提交，
   * 此时它仍在树里且 key 稳定，同步 focus 不会丢），没有则落到 textarea。
   */
  const removeByKey = (e: KeyboardEvent<HTMLButtonElement>, remove: () => void) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    e.preventDefault()
    const bodies = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-chip-body]') ?? [])
    const idx = bodies.indexOf(e.currentTarget)
    const next = idx >= 0 ? (bodies[idx + 1] ?? null) : null
    remove()
    ;(next ?? focusFallbackRef?.current)?.focus()
  }

  const openQuote = openQuoteId === null ? null : (quotes.find((q) => q.id === openQuoteId) ?? null)

  return (
    <div ref={rootRef} className="mb-1.5 space-y-1 text-[0.7rem]">
      {queued.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-dim">排队中</span>
          <ul role="list" aria-label="排队中的提问" className="contents">
            {queued.map((ask) => (
              <li key={ask.id} role="listitem" data-queued-ask={ask.id} className={CHIP_CLASS}>
                <button
                  type="button"
                  data-chip-body=""
                  disabled={busy}
                  onClick={() => onFire(ask)}
                  onKeyDown={(e) => removeByKey(e, () => onRemoveQueued(ask.id))}
                  title={busy ? '回答进行中，本轮结束后自动发送' : '点击立即发起'}
                  className={CHIP_BODY_CLASS}
                >
                  {ask.label} · {chipText(ask.text)}
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveQueued(ask.id)}
                  aria-label={`取消排队：${ask.label}`}
                  className={CHIP_X_CLASS}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          {paused && !busy && <span className="text-warn">已暂停自动发送，点击芯片发送</span>}
        </div>
      )}
      {quotes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-dim">引用</span>
          <ul role="list" aria-label="引用" className="contents">
            {quotes.map((q) => (
              <li key={q.id} role="listitem" data-composer-quote={q.id} className={CHIP_CLASS}>
                <button
                  type="button"
                  data-chip-body=""
                  aria-expanded={openQuoteId === q.id}
                  onClick={() => setOpenQuoteId((cur) => (cur === q.id ? null : q.id))}
                  onKeyDown={(e) => removeByKey(e, () => onRemoveQuote(q.id))}
                  title="点击展开预览"
                  className={CHIP_BODY_CLASS}
                >
                  {chipText(q.text)}
                </button>
                {q.translated && (
                  <span className="shrink-0 rounded border border-accent-2/40 bg-accent-2/10 px-1 text-accent-2">译文</span>
                )}
                <button type="button" onClick={() => onRemoveQuote(q.id)} aria-label="移除引用" className={CHIP_X_CLASS}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {openQuote && <QuoteBlock quote={openQuote} />}
    </div>
  )
}
