import { Link } from 'react-router-dom'
import type { LlmAuthCode } from '../../lib/llmClient'
import { splitByRanges, validRanges } from '../../lib/paper/highlight/highlightModel'
import type { PaperHighlight } from '../../lib/paper/types'

/**
 * 译文三态的共用小件：文本视图（BlockReader）与原版 PDF 就地译文（PdfZhOverlay / PdfFlowPage）同源，
 * 文案、高亮切分、失败引导只有一份——两处视图的「这一段翻译失败」「去设置页配置」永远一致。
 */

/**
 * 宿主内文本渲染：快照校验 → 区间切分 → 逐段建节点（纯函数切分返回段数组，
 * 禁止 HTML 字符串注入）。rows 是该块的全部高亮行，按宿主语言在这里过滤——
 * 原文高亮只进原文宿主，译文高亮只进译文宿主。
 */
export function HlText({ text, rows, host }: { text: string; rows: readonly PaperHighlight[] | undefined; host: 'orig' | 'zh' }) {
  const mine = rows?.length ? validRanges(text, rows.filter((r) => r.lang === host)) : []
  if (!mine.length) return <>{text}</>
  return (
    <>
      {splitByRanges(text, mine).map((seg, i) =>
        seg.id !== undefined ? (
          <mark
            key={i}
            data-highlight-id={seg.id}
            className="cursor-pointer rounded-[3px] bg-amber/30 text-fg transition-colors hover:bg-amber/45"
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  )
}

/** 骨架屏：两行灰条（不带 data-translated，无可选中文本） */
export function TranslationSkeleton() {
  return (
    <div className="mt-1.5 animate-pulse space-y-1.5">
      <div className="h-3 rounded bg-panel-2" />
      <div className="h-3 w-2/3 rounded bg-panel-2" />
    </div>
  )
}

/** 失败文案：auth 细分（未登录 / 未配 key）给对应引导，其余笼统「翻译失败」 */
const failureMessage = (authIssue: LlmAuthCode | null | undefined): string =>
  authIssue === 'unauthenticated'
    ? '登录已过期，请重新登录后重试翻译'
    : authIssue
      ? '该账号尚未配置 DeepSeek Key，无法翻译'
      : '这一段翻译失败'

/**
 * 失败 chip。`compact`：原版 PDF 中文覆盖用——叠在原文段落框右下角的单行小签，不能占流内高度、
 * 不能盖住原文（失败态显示的就是原文），所以去掉外边距、加不透明底与描边，字号再降一档。
 */
export function TranslationError({
  onRetry,
  authIssue,
  compact = false,
}: {
  onRetry?: (() => void) | undefined
  authIssue?: LlmAuthCode | null
  compact?: boolean
}) {
  return (
    <p
      className={
        compact
          ? 'flex items-center gap-1.5 whitespace-nowrap rounded border border-bad/30 bg-panel px-1.5 py-0.5 text-[10px] leading-tight shadow-sm'
          : 'mt-1 flex items-center gap-2 text-[0.7rem]'
      }
    >
      <span className="text-bad">{failureMessage(authIssue)}</span>
      {authIssue && authIssue !== 'unauthenticated' && (
        // 与 AskDialog 的 no-user-key 分支同一引导：账号侧配置问题 → 设置页
        <Link to="/settings" className="text-accent underline underline-offset-2 hover:text-accent">
          去设置页配置
        </Link>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={`rounded border border-line ${compact ? 'px-1 py-0' : 'px-1.5 py-0.5'} text-accent transition-colors hover:bg-accent/10`}
        >
          重试
        </button>
      )}
    </p>
  )
}
