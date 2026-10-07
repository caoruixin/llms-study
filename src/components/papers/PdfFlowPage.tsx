import { Fragment, memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type * as Pdfjs from 'pdfjs-dist'
import { pageDomId } from '../../lib/paper/anchors'
import { assignPointsToStrips, scaleRect, type FlowRow, type PageGeom, type Strip } from '../../lib/paper/pdfLayout'
import type { ZhSlice } from './PdfZhOverlay'
import { HlText, TranslationError, TranslationSkeleton } from './translationBits'

/**
 * 原版 PDF「对照」模式的一页：段落对照流（PLAN-pdf-inline-translation §5.3）。
 *
 * 每段原文按原样裁成一条画布图条（版式、公式、插图原封不动），译文紧跟在该块最后一条图条之下；
 * 双栏页仍左右并排（`.paper-flow-row` 两列各自一叠），页面只是变高。图条里叠一层同样裁切的 pdf.js
 * 文字层，原文照常可选中、可复制、可查找。
 *
 * 渲染纪律（沿 PdfViewer 的 PdfPage：取消 / 释放 / 错误分诊一致）：
 * - pdf.js 的 `page.render` 没有子矩形参数 → **一次离屏整页渲染**，再逐条带 `drawImage` 裁切到各自的
 *   canvas，离屏 canvas 立即归零（峰值 2× 页位图，稳态 1×）；
 * - 文字层的 span 按「页面百分比」定位（viewport.rawDims），与 offset 无关 → 每条带一个**整页尺寸**的
 *   文字层容器，负偏移对齐本条带、由条带 `overflow:clip` 裁掉其余；文本项按基线点归属条带
 *   （`assignPointsToStrips`），`getTextContent()` 只调一次；
 * - DOM（条带外框 + 译文）对所有页常驻，只有位图与文字层按 ±2 页窗口化：页高只在「译文到达 /
 *   scale 变化 / 页尺寸首次得知」时变化，滚动进出渲染窗口不会让页面跳动（WebKit 没有原生滚动锚定）。
 *   离窗清理只把条带 canvas 位图归零，不动 style 尺寸——布局不塌。
 *
 * DOM 契约：页容器 `#paper-page-N[data-page=N]`（无 height）；有块的条带带 `data-block-index`
 * （条带文字层里的划选 → 块级锚点）；译文 div 三态都带 `data-block-index`（当前块判定把译文区域算进块内），
 * 已译的再带 `data-translated="zh"` + `data-hl-host="zh"`（译文高亮宿主）。
 */

type PdfjsModule = typeof import('pdfjs-dist')
type PdfDocument = Pdfjs.PDFDocumentProxy
type TextContent = Awaited<ReturnType<Pdfjs.PDFPageProxy['getTextContent']>>
type TextItem = TextContent['items'][number]

/** 位图倍率上限（PdfViewer 的整页位图与这里的条带共用）：高 DPI 屏上 3x 只带来内存压力，看不出差别 */
export const MAX_DPR = 2

export interface FlowPageSize extends PageGeom {
  /** scale = 1 的 viewport 宽高 */
  width: number
  height: number
}

interface Props {
  lib: PdfjsModule
  doc: PdfDocument
  pageNumber: number
  scale: number
  layoutTick: number
  active: boolean
  /** 页尺寸（scale = 1）；null = 尚未取到 → 用 fallback 固定占位框 */
  size: FlowPageSize | null
  fallbackWidth: number
  fallbackHeight: number
  /** 分区结果（viewer 按 blocks + size 记忆化，引用稳定）；null = 尺寸未知 */
  rows: readonly FlowRow[] | null
  /**
   * 译文框横向范围 [x0, x1]（scale = 1，`translationBounds`）：左缘 = 块最后一片的文字左缘，右缘 = 所在栏的文字右缘——
   * 与原文栏对齐，而不是贴着条带（含页边距）的边，也不随末片短尾行变窄
   */
  textBounds?: ReadonlyMap<number, readonly [number, number]>
  zh: ZhSlice
  onRenderError: (message: string) => void
  /** 条带 DOM 首次就位（尺寸得知 → rows 非空）：viewer 兑现挂起的块对齐 */
  onLaidOut?: (page: number) => void
}

const flattenStrips = (rows: readonly FlowRow[]): Strip[] => {
  const out: Strip[] = []
  for (const row of rows) {
    if (row.kind === 'full') out.push(row.strip)
    else out.push(...row.left, ...row.right)
  }
  return out
}

const PdfFlowPage = memo(function PdfFlowPage({
  lib,
  doc,
  pageNumber,
  scale,
  layoutTick,
  active,
  size,
  fallbackWidth,
  fallbackHeight,
  rows,
  textBounds,
  zh,
  onRenderError,
  onLaidOut,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [rendered, setRendered] = useState(false)
  const [renderError, setRenderError] = useState(false)
  const [retryTick, setRetryTick] = useState(0)
  const [retrying, setRetrying] = useState(false)
  const [failCount, setFailCount] = useState(0)
  const [failMessage, setFailMessage] = useState('')
  /** 上一轮渲染任务：等它彻底结束再开新一轮（离屏 canvas 不共用，但 page 对象与 cleanup 时序要串行） */
  const inflightRef = useRef<Promise<unknown> | null>(null)

  useEffect(() => {
    setRenderError(false)
    if (!active || !rows) return
    const root = rootRef.current
    if (!root) return
    let cancelled = false
    let renderTask: { cancel: () => void } | null = null
    const layers: { cancel: () => void }[] = []
    let canvasDone = false
    let off: HTMLCanvasElement | null = null

    // 条带 DOM 与几何：按 key 对上（commit 之后跑，DOM 已是本轮 rows 的）
    const strips = flattenStrips(rows)
    const holders = new Map<string, HTMLElement>()
    for (const el of root.querySelectorAll<HTMLElement>('[data-strip]')) holders.set(el.dataset.strip ?? '', el)
    const placed = strips
      .map((s) => {
        const el = holders.get(s.key)
        const canvas = el?.querySelector('canvas') ?? null
        const text = el?.querySelector<HTMLElement>('.paper-flow-text') ?? null
        return el && canvas && text ? { rect: scaleRect(s.rect, scale), canvas, text } : null
      })
      .filter((p): p is { rect: ReturnType<typeof scaleRect>; canvas: HTMLCanvasElement; text: HTMLElement } => p !== null)

    const done = (async () => {
      await inflightRef.current?.catch(() => undefined)
      if (cancelled) return
      const page = await doc.getPage(pageNumber)
      if (cancelled) return
      const viewport = page.getViewport({ scale })
      const dpr = Math.min(MAX_DPR, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
      off = document.createElement('canvas')
      off.width = Math.floor(viewport.width * dpr)
      off.height = Math.floor(viewport.height * dpr)
      const task = page.render({
        canvas: off,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      })
      renderTask = task
      await task.promise
      if (cancelled) return
      for (const p of placed) {
        const { x, y, w, h } = p.rect
        p.canvas.width = Math.max(1, Math.round(w * dpr))
        p.canvas.height = Math.max(1, Math.round(h * dpr))
        const ctx = p.canvas.getContext('2d', { alpha: false })
        ctx?.drawImage(off, x * dpr, y * dpr, w * dpr, h * dpr, 0, 0, p.canvas.width, p.canvas.height)
      }
      // 离屏整页位图用完即释放：稳态只剩各条带自己的那一份
      off.width = 0
      off.height = 0
      off = null
      canvasDone = true
      setRendered(true)
      setRetrying(false)
      setFailCount(0)

      const content = await page.getTextContent()
      if (cancelled) return
      const items = content.items.filter((it): it is Extract<TextItem, { str: string }> => 'str' in it)
      // 基线点（viewport CSS px）→ 条带归属；条带矩形与显示用的是同一组取整后的 scaled rect
      const points = items.map((it) => {
        const [px, py] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]) as [number, number]
        return { x: px, y: py }
      })
      const owner = assignPointsToStrips(points, placed)
      const buckets: (typeof items)[] = placed.map(() => [])
      owner.forEach((s, i) => buckets[s]?.push(items[i]))
      for (let s = 0; s < placed.length; s += 1) {
        if (cancelled) return
        const holder = placed[s].text
        holder.replaceChildren()
        if (!buckets[s].length) continue
        const layer = new lib.TextLayer({
          textContentSource: { items: buckets[s], styles: content.styles, lang: content.lang },
          container: holder,
          viewport,
        })
        layers.push(layer)
        await layer.render()
      }
      page.cleanup()
    })().catch((e: unknown) => {
      // 分诊同 PdfPage：取消静默；位图已落地只是文字层失败 → 只记日志；位图失败 → 可重试按钮 + viewer 错误条
      if (cancelled || (e instanceof Error && e.name === 'RenderingCancelledException')) return
      if (canvasDone) {
        console.error(`[pdf] 第 ${pageNumber} 页（对照）文字层失败`, e)
        return
      }
      console.error(`[pdf] 第 ${pageNumber} 页（对照）渲染失败`, e)
      const message = e instanceof Error ? e.message : String(e)
      setRenderError(true)
      setRetrying(false)
      setFailCount((c) => c + 1)
      setFailMessage(message)
      onRenderError(message)
    })
    inflightRef.current = done

    return () => {
      cancelled = true
      renderTask?.cancel()
      for (const l of layers) l.cancel()
      for (const p of placed) {
        p.text.replaceChildren()
        // 归零即释放位图；只动位图尺寸，不动 style 尺寸（条带外框靠 style 撑住布局）
        p.canvas.width = 0
        p.canvas.height = 0
      }
      if (off) {
        off.width = 0
        off.height = 0
      }
      setRendered(false)
    }
    // rows 由 viewer 按 (blocks, 页尺寸) 记忆化：译文到达不会换引用，不会触发重绘
  }, [active, doc, lib, pageNumber, scale, layoutTick, retryTick, rows, onRenderError])

  useEffect(() => {
    if (rows) onLaidOut?.(pageNumber)
  }, [rows, onLaidOut, pageNumber])

  /** 译文框左右外边距：左对齐该块原文左缘、右对齐所在栏右缘（至少留 4px）；没有几何时用 CSS 默认 */
  const zhInset = (i: number, strip: { x: number; w: number }): CSSProperties | undefined => {
    const b = textBounds?.get(i)
    if (!b) return undefined
    const left = Math.round(b[0] * scale) - strip.x
    const right = strip.x + strip.w - Math.round(b[1] * scale)
    return left >= 0 && right >= 0 ? { marginLeft: Math.max(4, left), marginRight: Math.max(4, right) } : undefined
  }

  const renderZh = (i: number, strip: { x: number; w: number }): ReactNode => {
    const inset = zhInset(i, strip)
    const text = zh.texts.get(i)
    if (text !== undefined) {
      return (
        <div
          key={`zh:${i}`}
          data-block-index={i}
          data-translated="zh"
          data-hl-host="zh"
          className="paper-flow-zh"
          style={inset}
        >
          <HlText text={text} rows={zh.highlights.get(i)} host="zh" />
        </div>
      )
    }
    if (zh.failed.has(i)) {
      const retry = zh.onRetry
      return (
        <div key={`zh:${i}`} data-block-index={i} className="paper-flow-fail" style={inset}>
          <TranslationError onRetry={retry ? () => retry(i) : undefined} authIssue={zh.authIssue} />
        </div>
      )
    }
    return (
      <div key={`zh:${i}`} data-block-index={i} className="paper-flow-skel" style={inset}>
        <TranslationSkeleton />
      </div>
    )
  }

  const renderStrip = (s: Strip): ReactNode => {
    const r = scaleRect(s.rect, scale)
    return (
      <Fragment key={s.key}>
        <div
          data-strip={s.key}
          data-block-index={s.blockIndex}
          className="paper-flow-strip"
          style={{ width: r.w, height: r.h }}
        >
          <canvas className="block" style={{ width: r.w, height: r.h }} />
          <div className="paper-textlayer paper-flow-text" style={{ left: -r.x, top: -r.y }} />
        </div>
        {s.showTranslation && s.blockIndex !== undefined && renderZh(s.blockIndex, r)}
      </Fragment>
    )
  }

  const known = rows !== null && size !== null
  const width = known ? Math.round(size.pageWidth * scale) : Math.floor(fallbackWidth)

  return (
    <div
      ref={rootRef}
      id={pageDomId(pageNumber)}
      data-page={pageNumber}
      className="paper-flow-page relative mx-auto mb-4 scroll-mt-4 border border-line bg-white shadow-sm"
      style={
        {
          width: `${width}px`,
          // 条带文字层的字号 / 容器尺寸依赖这三个变量（同 PdfPage）
          '--total-scale-factor': scale,
          '--scale-round-x': '1px',
          '--scale-round-y': '1px',
        } as CSSProperties
      }
    >
      {known ? (
        rows.map((row) =>
          row.kind === 'full' ? (
            <Fragment key={row.key}>{renderStrip(row.strip)}</Fragment>
          ) : (
            <div key={row.key} className="paper-flow-row">
              <div className="paper-flow-col" style={{ width: Math.round(row.split * scale) }}>
                {row.left.map(renderStrip)}
              </div>
              <div className="paper-flow-col" style={{ width: width - Math.round(row.split * scale) }}>
                {row.right.map(renderStrip)}
              </div>
            </div>
          ),
        )
      ) : (
        <div style={{ height: `${Math.floor(fallbackHeight)}px` }} />
      )}
      {renderError ? (
        <button
          type="button"
          onClick={() => {
            setRetrying(true)
            setRetryTick((t) => t + 1)
          }}
          className="absolute inset-0 z-[3] flex min-h-11 flex-col items-center justify-center gap-1 bg-white/80 px-4 text-xs text-dim"
        >
          <span>本页渲染失败 · 点按重试</span>
          {failCount >= 2 && (
            <>
              <span className="max-w-full break-all text-[0.65rem] text-bad">
                {failMessage.length > 120 ? `${failMessage.slice(0, 120)}…` : failMessage}
              </span>
              <span className="text-[0.65rem]">可切换「文本视图」继续阅读</span>
            </>
          )}
        </button>
      ) : !rendered ? (
        // 未渲染：页码标在页顶（译文 DOM 常驻，别把居中大标签压在译文上）
        <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center pt-6 text-xs text-dim">
          {retrying ? '重试中…' : `第 ${pageNumber} 页`}
        </div>
      ) : null}
    </div>
  )
})

export default PdfFlowPage
