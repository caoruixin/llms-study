import { useState } from 'react'
import type { SourceAnchor } from '../../lib/paper/types'

/**
 * Copilot 里的一段选区引用块：用户气泡内（随问题落库的 quotes）与输入框引用 chip 的展开预览共用。
 * 样式沿 AskDialog 的 quoted 块（左侧 accent 竖线 + panel-2 底）；正文默认 line-clamp-3，
 * 长文 / 多行给「展开 / 收起」。三个按钮（回到原文、展开）互为兄弟，不嵌套在可点区域里。
 */

export interface QuoteLike {
  text: string
  anchor?: SourceAnchor
  translated?: boolean
}

interface Props {
  quote: QuoteLike
  /** 有值才出「回到原文 ↗」（输入框预览没有回跳语义） */
  onJump?: () => void
  /** 外边距 / 宽度由调用方给：气泡里限 max-w-[min(92%,36rem)]，输入框预览撑满 */
  className?: string
}

/** 超过三行量级或含换行才值得展开按钮：短引用常驻按钮只是噪音 */
export const isQuoteExpandable = (text: string): boolean => text.length > 160 || text.includes('\n')

/** `§section · p.N` 位置标签；两者都缺则为空串 */
export function quoteLocation(anchor: SourceAnchor | undefined): string {
  if (!anchor) return ''
  const parts: string[] = []
  if (anchor.section) parts.push(`§${anchor.section}`)
  if (anchor.page !== undefined) parts.push(`p.${anchor.page}`)
  return parts.join(' · ')
}

export default function QuoteBlock({ quote, onJump, className }: Props) {
  const [open, setOpen] = useState(false)
  const expandable = isQuoteExpandable(quote.text)
  const location = quoteLocation(quote.anchor)
  return (
    <div
      data-copilot-quote=""
      className={`border-l-2 border-accent bg-panel-2 px-3 py-2 text-xs text-dim ${className ?? ''}`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[0.65rem]">
        {quote.translated && (
          <span className="rounded border border-accent-2/40 bg-accent-2/10 px-1.5 py-0.5 text-accent-2">译文</span>
        )}
        {location && <span className="text-dim">{location}</span>}
        {onJump && (
          <button type="button" onClick={onJump} className="text-accent transition-colors hover:underline">
            回到原文 ↗
          </button>
        )}
      </div>
      <p className={`${open ? '' : 'line-clamp-3'} break-words whitespace-pre-wrap`}>{quote.text}</p>
      {expandable && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-1 text-[0.65rem] text-accent transition-colors hover:underline"
        >
          {open ? '收起 ▴' : '展开 ▾'}
        </button>
      )}
    </div>
  )
}
