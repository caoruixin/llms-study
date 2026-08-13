import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type * as Pdfjs from 'pdfjs-dist'
import { pageDomId } from '../../lib/paper/anchors'

/**
 * 原版 PDF 预览：pdf.js 页面渲染（canvas）+ 可选择文字层（textLayer），带视口虚拟化。
 *
 * 虚拟化要点（§11.4：20MB / 150 页要能流畅滚动）：
 * - 每页先占位（用第 1 页的尺寸估算高度），滚动条长度从一开始就正确；
 * - 只渲染视口前后 ±2 页，离开窗口立即 `canvas.width = 0` 释放位图内存——
 *   150 页 A4 若全部保留位图约需 3GB，必须及时释放；
 * - 渲染任务在页面卸载时 `cancel()`，快速滚动不会堆积任务。
 */

type PdfjsModule = typeof import('pdfjs-dist')
type PdfDocument = Pdfjs.PDFDocumentProxy

interface Props {
  bytes: ArrayBuffer
  /** 滚动容器（由工作台持有），用作 IntersectionObserver 的 root */
  containerRef: RefObject<HTMLElement | null>
  onVisiblePage: (page: number) => void
  onLoaded?: (pageCount: number) => void
}

/** 视口前后各多渲染几页 */
const WINDOW_PAGES = 2
/** 位图倍率上限：高 DPI 屏上 3x 只带来内存压力，看不出差别 */
const MAX_DPR = 2
/** 容器宽度变化 → 重绘的防抖窗口：面板收起/展开动画与拖拽期间只重渲一次 */
const RESIZE_DEBOUNCE_MS = 150

interface PageProps {
  lib: PdfjsModule
  doc: PdfDocument
  pageNumber: number
  scale: number
  width: number
  height: number
  active: boolean
  /** 容器宽度变化计数：进 effect 依赖，宽度变了就主动重跑渲染（scale 被钳位时也生效） */
  layoutTick: number
}

/** memo 是必需的：滚动时 range 每变一次，父组件都会重渲染全部页占位（150 页文档尤其明显） */
const PdfPage = memo(function PdfPage({ lib, doc, pageNumber, scale, width, height, active, layoutTick }: PageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [rendered, setRendered] = useState(false)
  /**
   * 上一次渲染任务的 promise。pdf.js 不允许同一 canvas 上并发 render()——
   * 面板收起/展开改变容器宽度时 effect 会紧接着重跑，不等上一次任务落地就调 render()
   * 会直接抛「Cannot use the same canvas during multiple render operations」，
   * 被 catch 吞掉后页面就停在「已按新尺寸重建、但一个像素都没画」的空白态（QA P1-4）。
   */
  const inflightRef = useRef<Promise<unknown> | null>(null)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let renderTask: { cancel: () => void } | null = null
    let textLayer: { cancel: () => void } | null = null

    const done = (async () => {
      // 先等上一轮（可能刚被 cancel）彻底结束，再开始新一轮
      await inflightRef.current?.catch(() => undefined)
      if (cancelled) return
      const page = await doc.getPage(pageNumber)
      if (cancelled) return
      const viewport = page.getViewport({ scale })
      const canvas = canvasRef.current
      if (!canvas) return
      const dpr = Math.min(MAX_DPR, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`

      const task = page.render({
        canvas,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      })
      renderTask = task
      await task.promise
      if (cancelled) return
      setRendered(true)

      const holder = textRef.current
      if (holder) {
        const textContent = await page.getTextContent()
        if (cancelled) return
        holder.replaceChildren()
        const layer = new lib.TextLayer({ textContentSource: textContent, container: holder, viewport })
        textLayer = layer
        await layer.render()
      }
      page.cleanup()
    })().catch(() => {
      // 渲染被取消（快速滚动）或单页损坏：不影响其他页，占位继续显示
    })
    inflightRef.current = done

    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayer?.cancel()
      textRef.current?.replaceChildren()
      const canvas = canvasRef.current
      if (canvas) {
        // 归零即释放位图；只 remove 元素不足以立刻回收内存
        canvas.width = 0
        canvas.height = 0
      }
      setRendered(false)
    }
    // layoutTick：容器宽度变化后强制重跑（与滚动触发同一条渲染路径）
  }, [active, doc, lib, pageNumber, scale, layoutTick])

  return (
    <div
      id={pageDomId(pageNumber)}
      data-page={pageNumber}
      className="relative mx-auto mb-4 scroll-mt-4 border border-line bg-white shadow-sm"
      style={
        {
          width: `${Math.floor(width)}px`,
          height: `${Math.floor(height)}px`,
          // pdf.js 的 textLayer 定位依赖这三个变量（setLayerDimensions / 字号计算）
          '--total-scale-factor': scale,
          '--scale-round-x': '1px',
          '--scale-round-y': '1px',
        } as CSSProperties
      }
    >
      <canvas ref={canvasRef} className="block" />
      <div ref={textRef} className="paper-textlayer" />
      {!rendered && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-dim">第 {pageNumber} 页</div>
      )}
    </div>
  )
})

export default function PdfViewer({ bytes, containerRef, onVisiblePage, onLoaded }: Props) {
  const [lib, setLib] = useState<PdfjsModule | null>(null)
  const [doc, setDoc] = useState<PdfDocument | null>(null)
  const [base, setBase] = useState<{ width: number; height: number } | null>(null)
  const [range, setRange] = useState<{ min: number; max: number } | null>(null)
  const [error, setError] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const [boxWidth, setBoxWidth] = useState(0)
  const [layoutTick, setLayoutTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    let task: { destroy: () => Promise<void> } | null = null

    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        if (cancelled) return
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
        // 必须传副本：pdf.js 会把 ArrayBuffer transfer 进 worker 并 detach 原对象，
        // 而这份字节是我们从 IndexedDB 取出的唯一实例，切模式回来还要用。
        const loading = pdfjs.getDocument({ data: bytes.slice(0) })
        task = loading
        const document_ = await loading.promise
        // StrictMode 双跑 / 快速切视图时 cleanup 可能早于这里：显式销毁，别把 worker 漏在后台
        if (cancelled) {
          void loading.destroy().catch(() => undefined)
          return
        }
        const first = await document_.getPage(1)
        const viewport = first.getViewport({ scale: 1 })
        first.cleanup()
        if (cancelled) return
        setBase({ width: viewport.width, height: viewport.height })
        setLib(pdfjs)
        setDoc(document_)
        onLoaded?.(document_.numPages)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '无法打开原始 PDF')
      }
    })()

    return () => {
      cancelled = true
      // 销毁 loadingTask 会一并释放 worker 侧资源
      void task?.destroy().catch(() => undefined)
    }
  }, [bytes, onLoaded])

  /**
   * 容器宽度 → 适宽缩放。防抖 150ms：Copilot 面板收起/展开、窗口拖拽都会连发 resize，
   * 每一次都会让视口内页面整体重绘一遍。
   * layoutTick 与 boxWidth 一起递增——scale 被 min/max 钳住（宽度变化但 scale 不变）时，
   * 光靠 scale 依赖无法触发重绘，页面会停在旧位图/空白 canvas 上（QA P1-4）。
   */
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let timer = 0
    let lastWidth = el.clientWidth
    const apply = (w: number) => {
      // 只认宽度变化：被观察元素的高度会随页面渲染不断增长，若一并触发就成了自激重绘
      if (Math.abs(w - lastWidth) < 1) return
      lastWidth = w
      setBoxWidth(w)
      setLayoutTick((t) => t + 1)
    }
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width
      clearTimeout(timer)
      timer = setTimeout(() => apply(w), RESIZE_DEBOUNCE_MS) as unknown as number
    })
    ro.observe(el)
    setBoxWidth(lastWidth)
    return () => {
      clearTimeout(timer)
      ro.disconnect()
    }
  }, [])

  const scale = useMemo(() => {
    if (!base || !boxWidth) return 1
    return Math.min(2, Math.max(0.3, (boxWidth - 16) / base.width))
  }, [base, boxWidth])

  const pages = useMemo(() => (doc ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : []), [doc])

  // 可见页窗口：只观察占位容器，渲染与否由 active 决定
  useEffect(() => {
    const root = containerRef.current
    const el = wrapRef.current
    if (!root || !el || !pages.length) return
    const visible = new Set<number>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const p = Number((e.target as HTMLElement).dataset.page)
          if (Number.isNaN(p)) continue
          if (e.isIntersecting) visible.add(p)
          else visible.delete(p)
        }
        if (!visible.size) return
        const min = Math.min(...visible)
        const max = Math.max(...visible)
        setRange((prev) => (prev && prev.min === min && prev.max === max ? prev : { min, max }))
        onVisiblePage(min)
      },
      { root, rootMargin: '20% 0px', threshold: 0 },
    )
    for (const node of el.querySelectorAll('[data-page]')) io.observe(node)
    return () => io.disconnect()
  }, [containerRef, onVisiblePage, pages.length])

  if (error) {
    return (
      <div className="rounded-xl border border-bad/40 bg-panel p-4 text-sm text-bad">
        {error}
        <span className="ml-1 text-dim">（可以切换到「文本视图」继续阅读）</span>
      </div>
    )
  }

  return (
    <div ref={wrapRef} className="pb-24">
      {!doc || !base || !lib ? (
        <p className="p-4 text-sm text-dim">正在加载原版 PDF…</p>
      ) : (
        pages.map((p) => (
          <PdfPage
            key={p}
            lib={lib}
            doc={doc}
            pageNumber={p}
            scale={scale}
            width={base.width * scale}
            height={base.height * scale}
            layoutTick={layoutTick}
            active={range !== null && p >= range.min - WINDOW_PAGES && p <= range.max + WINDOW_PAGES}
          />
        ))
      )}
    </div>
  )
}
