import { useEffect, type RefObject } from 'react'
import { blockDomId } from '../../lib/paper/anchors'
import { sanitizeDocxHtml } from '../../lib/paper/sanitize'
import type { PaperBlock } from '../../lib/paper/types'

/**
 * 语义化正文视图：PDF 的「文本视图」与 DOCX 的唯一视图都是它。
 * 每个块带 `id=paper-block-N` 与 `data-block-index`，同时充当引用跳转目标与选区锚点来源。
 *
 * 虚拟化策略：**用浏览器原生的 `content-visibility: auto`**，不手写窗口化。
 * 视口外的块跳过渲染与样式计算（`contain-intrinsic-size` 提供占位高度），
 * 而 DOM 节点仍然存在——于是 `scrollIntoView`、浏览器内置查找、跨块选区全部照常工作，
 * 这是手写虚拟列表要付出很大代价才能保住的三件事。
 */

interface Props {
  blocks: PaperBlock[]
  /** 滚动容器（由工作台持有），用作 IntersectionObserver 的 root */
  containerRef: RefObject<HTMLElement | null>
  /** 视口内最靠上的块序号，用于阅读进度与目录高亮 */
  onVisibleBlock: (blockIndex: number) => void
}

function BlockBody({ block }: { block: PaperBlock }) {
  switch (block.kind) {
    case 'heading': {
      const level = block.level ?? 2
      const size = level <= 1 ? 'text-xl' : level === 2 ? 'text-lg' : 'text-base'
      return <h3 className={`${size} mt-6 font-semibold text-fg first:mt-0`}>{block.text}</h3>
    }
    case 'list':
      return (
        <p className="flex gap-2 text-[0.95rem] leading-7 text-fg">
          <span className="shrink-0 text-dim">·</span>
          <span>{block.text}</span>
        </p>
      )
    case 'table':
      // DOCX 表格保留了结构化 HTML：渲染前**再清洗一次**（纵深防御，正文永远是不可信输入）
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
        <pre className="overflow-x-auto rounded-lg border border-line bg-panel-2 p-3 font-mono text-xs leading-relaxed text-fg">
          {block.text}
        </pre>
      )
    default:
      return <p className="text-[0.95rem] leading-7 text-fg">{block.text}</p>
  }
}

export default function BlockReader({ blocks, containerRef, onVisibleBlock }: Props) {
  useEffect(() => {
    const root = containerRef.current
    if (!root || !blocks.length) return
    // 只统计「视口上 1/4 区域」内的块：翻页时当前位置的判定不会来回跳
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
      { root, rootMargin: '0px 0px -75% 0px', threshold: 0 },
    )
    for (const el of root.querySelectorAll('[data-block-index]')) io.observe(el)
    return () => io.disconnect()
  }, [blocks, containerRef, onVisibleBlock])

  if (!blocks.length) return <p className="text-sm text-dim">这篇论文没有可显示的正文块。</p>

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
          <BlockBody block={b} />
        </div>
      ))}
    </div>
  )
}
