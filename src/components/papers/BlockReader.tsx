import { useEffect, type RefObject } from 'react'
import { CURRENT_PAGE_EPSILON, blockDomId } from '../../lib/paper/anchors'
import { splitByRanges, validRanges } from '../../lib/paper/highlight/highlightModel'
import { sanitizeDocxHtml } from '../../lib/paper/sanitize'
import { isTranslatableBlock } from '../../lib/paper/translate/translateBatch'
import type { LangMode, PaperBlock, PaperHighlight } from '../../lib/paper/types'

/**
 * 语义化正文视图：PDF 的「文本视图」与 DOCX 的唯一视图都是它。
 * 每个块带 `id=paper-block-N` 与 `data-block-index`，同时充当引用跳转目标与选区锚点来源。
 *
 * 虚拟化策略：**用浏览器原生的 `content-visibility: auto`**，不手写窗口化。
 * 视口外的块跳过渲染与样式计算（`contain-intrinsic-size` 提供占位高度），
 * 而 DOM 节点仍然存在——于是 `scrollIntoView`、浏览器内置查找、跨块选区全部照常工作，
 * 这是手写虚拟列表要付出很大代价才能保住的三件事。
 *
 * 全文翻译（三态 langMode）只改变**容器内**渲染什么：外层容器的 id / data-block-index
 * 永远不变，锚点与 [[cite]] 跳转在三态下全部照常。译文元素带 `data-translated="zh"`，
 * 供选区快捷条识别「引用的是译文」。
 *
 * 划词高亮的宿主约定：每个 textContent 恰好等于源字符串（block.text 或该块译文）的
 * 元素带 `data-hl-host="orig" | "zh"`——list 加在内层第二个 span（避开 '·' 前缀），
 * table 分支（dangerouslySetInnerHTML）不加即天然排除。selectionOffsets 按它算偏移，
 * HlText 按它渲染 mark；快照失配（重解析/译文重生成）的行渲染前被 validRanges 过滤。
 */

interface Props {
  blocks: PaperBlock[]
  /** 滚动容器（由工作台持有），用作 IntersectionObserver 的 root */
  containerRef: RefObject<HTMLElement | null>
  /** 视口内最靠上的块序号，用于阅读进度与目录高亮 */
  onVisibleBlock: (blockIndex: number) => void
  /** 正文语言三态；缺省 'orig' = 与翻译功能完全无关的旧行为 */
  langMode?: LangMode
  /** blockIndex → 译文（缺席且可译 = 骨架态） */
  translations?: ReadonlyMap<number, string>
  /** 修复/对分后仍失败的块：显示原文 + 重试 chip */
  failedTranslations?: ReadonlySet<number>
  onRetryTranslation?: (blockIndex: number) => void
  /** blockIndex → 该块全部高亮行（含两种 lang，渲染端按宿主语言过滤） */
  highlights?: ReadonlyMap<number, readonly PaperHighlight[]>
}

/** heading 字号映射：原文与译文共用，中文模式下标题「沿用原字号类」靠它 */
const headingSize = (level: number | undefined): string => {
  const l = level ?? 2
  return l <= 1 ? 'text-xl' : l === 2 ? 'text-lg' : 'text-base'
}

/**
 * 宿主内文本渲染：快照校验 → 区间切分 → 逐段建节点（纯函数切分返回段数组，
 * 禁止 HTML 字符串注入）。rows 是该块的全部高亮行，按宿主语言在这里过滤——
 * 原文高亮只进原文宿主，译文高亮只进译文宿主。
 */
function HlText({ text, rows, host }: { text: string; rows: readonly PaperHighlight[] | undefined; host: 'orig' | 'zh' }) {
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

function BlockBody({ block, rows }: { block: PaperBlock; rows?: readonly PaperHighlight[] | undefined }) {
  switch (block.kind) {
    case 'heading':
      return (
        <h3 data-hl-host="orig" className={`${headingSize(block.level)} mt-6 font-semibold text-fg first:mt-0`}>
          <HlText text={block.text} rows={rows} host="orig" />
        </h3>
      )
    case 'list':
      return (
        <p className="flex gap-2 text-[0.95rem] leading-7 text-fg">
          <span className="shrink-0 text-dim">·</span>
          {/* 宿主是内层 span：外层 textContent 混着 '·'，偏移口径会被污染 */}
          <span data-hl-host="orig">
            <HlText text={block.text} rows={rows} host="orig" />
          </span>
        </p>
      )
    case 'table':
      // DOCX 表格保留了结构化 HTML：渲染前**再清洗一次**（纵深防御，正文永远是不可信输入）；
      // 不带 data-hl-host——高亮偏移相对源字符串的约定在富结构 HTML 上不成立
      return block.html ? (
        <div
          className="paper-table overflow-x-auto text-sm"
          dangerouslySetInnerHTML={{ __html: sanitizeDocxHtml(block.html) }}
        />
      ) : (
        <pre className="overflow-x-auto rounded-lg border border-line bg-panel-2 p-3 text-xs leading-relaxed text-fg">
          {block.text}
        </pre>
      )
    case 'code':
      return (
        <pre
          data-hl-host="orig"
          className="overflow-x-auto rounded-lg border border-line bg-panel-2 p-3 font-mono text-xs leading-relaxed text-fg"
        >
          <HlText text={block.text} rows={rows} host="orig" />
        </pre>
      )
    default:
      return (
        <p data-hl-host="orig" className="text-[0.95rem] leading-7 text-fg">
          <HlText text={block.text} rows={rows} host="orig" />
        </p>
      )
  }
}

/** 中文模式的译文主体：heading 沿用原字号类，list 保留项目符号，其余按正文段落 */
function TranslatedBody({ block, text, rows }: { block: PaperBlock; text: string; rows?: readonly PaperHighlight[] | undefined }) {
  if (block.kind === 'heading') {
    return (
      <h3
        data-translated="zh"
        data-hl-host="zh"
        className={`${headingSize(block.level)} mt-6 font-semibold text-fg first:mt-0`}
      >
        <HlText text={text} rows={rows} host="zh" />
      </h3>
    )
  }
  if (block.kind === 'list') {
    return (
      <p data-translated="zh" className="flex gap-2 text-[0.95rem] leading-7 text-fg">
        <span className="shrink-0 text-dim">·</span>
        <span data-hl-host="zh">
          <HlText text={text} rows={rows} host="zh" />
        </span>
      </p>
    )
  }
  return (
    <p data-translated="zh" data-hl-host="zh" className="text-[0.95rem] leading-7 text-fg">
      <HlText text={text} rows={rows} host="zh" />
    </p>
  )
}

/** 骨架屏：两行灰条（不带 data-translated，无可选中文本） */
function TranslationSkeleton() {
  return (
    <div className="mt-1.5 animate-pulse space-y-1.5">
      <div className="h-3 rounded bg-panel-2" />
      <div className="h-3 w-2/3 rounded bg-panel-2" />
    </div>
  )
}

function TranslationError({ onRetry }: { onRetry?: (() => void) | undefined }) {
  return (
    <p className="mt-1 flex items-center gap-2 text-[0.7rem]">
      <span className="text-bad">这一段翻译失败</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded border border-line px-1.5 py-0.5 text-accent transition-colors hover:bg-accent/10"
        >
          重试
        </button>
      )}
    </p>
  )
}

export default function BlockReader({
  blocks,
  containerRef,
  onVisibleBlock,
  langMode = 'orig',
  translations,
  failedTranslations,
  onRetryTranslation,
  highlights,
}: Props) {
  useEffect(() => {
    const root = containerRef.current
    if (!root || !blocks.length) return
    // 只统计「视口上 1/4 区域」内的块：翻页时当前位置的判定不会来回跳。
    // 顶边再内缩 CURRENT_PAGE_EPSILON：跳转/切视图对齐后（scroll-mt-4）上一个块的底边会在
    // 顶边下方残留几个像素（实测 4px），不内缩就会被 min 取走，位置倒退一个块——
    // 若那个块正好跨页，页码就整整退一页（与 PdfViewer 的当前页判定同一个口径）。
    const visible = new Set<number>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset.blockIndex)
          if (Number.isNaN(i)) continue
          if (e.isIntersecting) visible.add(i)
          else visible.delete(i)
        }
        if (visible.size) onVisibleBlock(Math.min(...visible))
      },
      { root, rootMargin: `-${CURRENT_PAGE_EPSILON}px 0px -75% 0px`, threshold: 0 },
    )
    for (const el of root.querySelectorAll('[data-block-index]')) io.observe(el)
    return () => io.disconnect()
  }, [blocks, containerRef, onVisibleBlock])

  if (!blocks.length) return <p className="text-sm text-dim">这篇论文没有可显示的正文块。</p>

  /** 单块内容：orig / 中文 / 对照三态；不可译块（公式/代码/表格）三态下都渲染原文 */
  const renderContent = (b: PaperBlock) => {
    const rows = highlights?.get(b.index)
    if (langMode === 'orig' || !isTranslatableBlock(b.kind)) return <BlockBody block={b} rows={rows} />
    const zh = translations?.get(b.index)
    const failed = failedTranslations?.has(b.index) === true
    const retry = onRetryTranslation ? () => onRetryTranslation(b.index) : undefined

    if (langMode === 'zh') {
      if (zh !== undefined) return <TranslatedBody block={b} text={zh} rows={rows} />
      if (failed)
        return (
          <>
            <BlockBody block={b} rows={rows} />
            <TranslationError onRetry={retry} />
          </>
        )
      return <TranslationSkeleton />
    }
    // 对照：原文块下紧跟译文（accent 左边线区分层次）
    return (
      <>
        <BlockBody block={b} rows={rows} />
        {zh !== undefined ? (
          <div
            data-translated="zh"
            data-hl-host="zh"
            className="mt-1.5 border-l-2 border-accent/40 bg-accent/5 pl-3 text-[0.95rem] leading-7 text-fg"
          >
            <HlText text={zh} rows={rows} host="zh" />
          </div>
        ) : failed ? (
          <TranslationError onRetry={retry} />
        ) : (
          <TranslationSkeleton />
        )}
      </>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3 px-1 pb-24">
      {blocks.map((b) => (
        <div
          key={b.id}
          id={blockDomId(b.index)}
          data-block-index={b.index}
          data-page={b.anchor.page}
          data-section={b.anchor.section}
          className="paper-block scroll-mt-4"
        >
          {renderContent(b)}
        </div>
      ))}
    </div>
  )
}
