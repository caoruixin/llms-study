import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type * as Pdfjs from 'pdfjs-dist'
import { isPageActive, pageDomId, pickCurrentPage } from '../../lib/paper/anchors'
import { ensurePdfCompat } from '../../lib/paper/pdfCompat'
import pdfWorkerUrl from '../../lib/paper/pdfWorkerEntry?worker&url'
import { MQ, useMediaQuery } from '../../lib/useMediaQuery'

/**
 * 原版 PDF 预览：pdf.js 页面渲染（canvas）+ 可选择文字层（textLayer），带视口虚拟化。
 *
 * 虚拟化要点（§11.4：20MB / 150 页要能流畅滚动）：
 * - 每页先占位（用第 1 页的尺寸估算高度），滚动条长度从一开始就正确；
 * - 只渲染视口前后 ±2 页，离开窗口立即 `canvas.width = 0` 释放位图内存——
 *   150 页 A4 若全部保留位图约需 3GB，必须及时释放；
 * - 渲染任务在页面卸载时 `cancel()`，快速滚动不会堆积任务。
 *
 * 「渲染窗口」与「当前第几页」是两件事，用两套判定：前者是 IntersectionObserver（要往外扩，
 * 提前渲染），后者是滚动时的纯几何判定（要贴着容器顶边，见 `pickCurrentPage`）。
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
  /** 位图渲染失败上报：viewer 级错误条靠它显示首个真实报错（真机用户截图即可远程定位） */
  onRenderError: (message: string) => void
}

/** memo 是必需的：滚动时 range 每变一次，父组件都会重渲染全部页占位（150 页文档尤其明显） */
const PdfPage = memo(function PdfPage({ lib, doc, pageNumber, scale, width, height, active, layoutTick, onRenderError }: PageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [rendered, setRendered] = useState(false)
  /** 位图渲染失败（非取消）：占位符换成「点按重试」按钮——此前所有失败都被静默吞掉，页面永远空白 */
  const [renderError, setRenderError] = useState(false)
  /** 点按重试计数：进 effect 依赖，递增即重跑同一条渲染路径 */
  const [retryTick, setRetryTick] = useState(0)
  /** 重试进行中：effect 重跑期间 renderError 已被幂等清掉，占位符要显示「重试中…」而不是页码 */
  const [retrying, setRetrying] = useState(false)
  /** 连续失败次数（成功清零）：≥2 次说明重试无望，追加真实报错 + 引导切文本视图 */
  const [failCount, setFailCount] = useState(0)
  const [failMessage, setFailMessage] = useState('')
  /**
   * 上一次渲染任务的 promise。pdf.js 不允许同一 canvas 上并发 render()——
   * 面板收起/展开改变容器宽度时 effect 会紧接着重跑，不等上一次任务落地就调 render()
   * 会直接抛「Cannot use the same canvas during multiple render operations」，
   * 被 catch 吞掉后页面就停在「已按新尺寸重建、但一个像素都没画」的空白态（QA P1-4）。
   */
  const inflightRef = useRef<Promise<unknown> | null>(null)

  useEffect(() => {
    // 幂等清错：每次重跑（滚回窗口/宽度变化/点按重试）都从干净状态开始，错误态绝不粘滞
    setRenderError(false)
    if (!active) return
    let cancelled = false
    let renderTask: { cancel: () => void } | null = null
    let textLayer: { cancel: () => void } | null = null
    // 位图是否已落地：用于把「文字层失败」与「位图失败」分开——前者不遮内容，后者才该报错
    let canvasDone = false

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
      canvasDone = true
      if (cancelled) return
      setRendered(true)
      setRetrying(false)
      setFailCount(0)

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
    })().catch((e: unknown) => {
      // 三类分诊——此前一律静默，单页损坏/低内存渲染失败在用户眼里就是「永远的空白占位符」：
      // 1) 取消（快速滚动/宽度变化重跑/卸载）：正常路径，保持静默
      if (cancelled || (e instanceof Error && e.name === 'RenderingCancelledException')) return
      // 2) 位图已落地、只是文字层失败：内容看得见（仅选字不可用），只记日志不遮页面
      if (canvasDone) {
        console.error(`[pdf] 第 ${pageNumber} 页文字层失败`, e)
        return
      }
      // 3) 位图失败：这一页确实什么都没画上，必须让用户看见并能重试
      console.error(`[pdf] 第 ${pageNumber} 页渲染失败`, e)
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
    // layoutTick：容器宽度变化后强制重跑；retryTick：渲染失败后点按重试（同一条渲染路径）
    // onRenderError 是 viewer 的 useCallback（空依赖），引用恒定，不会额外触发重跑
  }, [active, doc, lib, pageNumber, scale, layoutTick, retryTick, onRenderError])

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
      {/* 占位三态：渲染失败 → 可重试按钮；未渲染 → 页码占位（重试中要有反馈）；已渲染 → 无覆盖层 */}
      {renderError ? (
        <button
          type="button"
          onClick={() => {
            setRetrying(true)
            setRetryTick((t) => t + 1)
          }}
          className="absolute inset-0 flex min-h-11 flex-col items-center justify-center gap-1 bg-white/80 px-4 text-xs text-dim"
        >
          <span>本页渲染失败 · 点按重试</span>
          {/* 连续失败 ≥2 次：重试大概率无望，把真实报错亮出来（截图即可远程定位）并引导切文本视图 */}
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
        <div className="absolute inset-0 flex items-center justify-center text-xs text-dim">
          {retrying ? '重试中…' : `第 ${pageNumber} 页`}
        </div>
      ) : null}
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
  /** 「IO 首批全部不可见」只警告一次：这是环境指纹不是每帧事件，刷屏只会淹没真正的错误 */
  const ioEmptyWarnedRef = useRef(false)
  /**
   * viewer 级错误条：只记「首个」页渲染失败的报错（同一根因会逐页重复），可手动关闭。
   * 用户手机截不了 console——这条真实 e.message 是远程定位引擎级兼容问题的唯一线索。
   */
  const [engineError, setEngineError] = useState<string | null>(null)
  const [engineErrorDismissed, setEngineErrorDismissed] = useState(false)
  const handleRenderError = useCallback((message: string) => {
    setEngineError((prev) => prev ?? message)
  }, [])

  useEffect(() => {
    // pdf.js v4+ 依赖 Promise.withResolvers（iOS Safari ≥ 17.4）：旧内核会在 worker 深处抛
    // ReferenceError 且不走我们的 catch（发生在独立线程），表现就是无限「正在加载」。
    // 提前探测并给出明确的降级出路，而不是让用户对着白屏猜。
    if (!('withResolvers' in Promise)) {
      setError('当前浏览器版本过低（iOS 需 ≥ 17.4），无法渲染原版 PDF，请切换「文本视图」阅读')
      return
    }
    let cancelled = false
    let task: { destroy: () => Promise<void> } | null = null

    void (async () => {
      try {
        // WebKit 缺 ReadableStream 异步迭代:不补齐的话 getTextContent(文字层)整体抛错
        ensurePdfCompat()
        const pdfjs = await import('pdfjs-dist')
        if (cancelled) return
        // 官方 worker 换成 pdfWorkerEntry 包装:worker 线程也要装 WebKit 兼容 shim
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
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
        // 统一 [pdf] 前缀：远端排查（用户手机截不了 console）靠这条日志区分「打不开」与「渲染失败」
        console.error('[pdf] 打开 PDF 失败', e)
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
      // 专注陪读把正文整列 display:none：RO 会报 0 宽，若照单全收就会以 scale 下限重绘一遍，
      // 恢复正文时再重绘回来。短路掉这种「不可能是真实排版宽度」的读数，lastWidth 保持不变，
      // 恢复后同宽 → 零重绘。
      if (w < 50) return
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

  // 手机余量收窄到 8px：阅读列 padding 已从 p-4 降为 p-2，页面能多吃回 8px 宽度
  //（390 设备页宽 308 → 364px 的一部分来自这里，另一部分来自布局改造）
  const isTablet = useMediaQuery(MQ.md)
  const scale = useMemo(() => {
    if (!base || !boxWidth) return 1
    return Math.min(2, Math.max(0.3, (boxWidth - (isTablet ? 16 : 8)) / base.width))
  }, [base, boxWidth, isTablet])

  const pages = useMemo(() => (doc ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : []), [doc])

  /**
   * 渲染窗口：只观察占位容器，渲染与否由 active 决定。
   * `rootMargin: '20% 0px'` 是**预渲染**语义（视口上下各多算 20% 视口高），
   * 与「当前第几页」无关——后者见下一个 effect（QA P1：两件事共用这个可见集会累积回退一页）。
   */
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
        if (!visible.size) {
          // 可见集为空时保持现有 range 不动（滚动过程中的瞬时空批是常态）。
          // 但「首批就全不可见」值得留痕：那是移动端 WebView 懒布局/后台挂起的指纹，
          // 没有 range 兜底（isPageActive 的 null 分支）时整篇 PDF 会全白。只警一次防刷屏。
          if (!ioEmptyWarnedRef.current) {
            ioEmptyWarnedRef.current = true
            console.warn('[pdf] IO 首批全部不可见')
          }
          return
        }
        const min = Math.min(...visible)
        const max = Math.max(...visible)
        setRange((prev) => (prev && prev.min === min && prev.max === max ? prev : { min, max }))
      },
      { root, rootMargin: '20% 0px', threshold: 0 },
    )
    for (const node of el.querySelectorAll('[data-page]')) io.observe(node)
    return () => io.disconnect()
  }, [containerRef, pages.length])

  /**
   * 当前页：纯几何判定——盖住滚动容器顶边的那一页（`pickCurrentPage`）。
   * 用滚动事件 + rAF 节流而不是第二个 IntersectionObserver：一帧最多算一次，
   * 且读数与「这一帧的滚动位置」严格对应，没有 IO 回调的时序歧义。
   */
  useEffect(() => {
    const root = containerRef.current
    const el = wrapRef.current
    if (!root || !el || !pages.length) return
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-page]'))
    if (!nodes.length) return
    let frame = 0
    let reported = 0
    const measure = () => {
      frame = 0
      // 专注陪读把正文整列 display:none：矩形全塌成 0，这时的读数没有意义
      if (!root.clientHeight) return
      // clientTop = 上边框宽度：容器的滚动视口从边框内侧开始
      const viewportTop = root.getBoundingClientRect().top + root.clientTop
      const edges = nodes.map((node) => {
        const r = node.getBoundingClientRect()
        return { page: Number(node.dataset.page), top: r.top, bottom: r.bottom }
      })
      const page = pickCurrentPage(edges, viewportTop)
      if (page === undefined) return
      // 几何补种：IO 首批全不可见时 range 停在 null，首次滚动结算就把当前页种进渲染窗口。
      // 只填 null 不覆盖已有值——IO 正常工作时这里永远是 no-op，两套判定不打架
      setRange((prev) => prev ?? { min: page, max: page })
      if (page === reported) return
      reported = page
      onVisiblePage(page)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    root.addEventListener('scroll', schedule, { passive: true })
    // scrollTop 为 0 时不主动结算：PDF 刚挂载、alignToPosition 还没把恢复的阅读位置滚上去，
    // 此时结算只会把「当前页」冲成第 1 页。真正需要重算的场景（宽度变化改了页高）scrollTop 都不为 0。
    if (root.scrollTop > 0) schedule()
    return () => {
      root.removeEventListener('scroll', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [containerRef, onVisiblePage, pages.length, layoutTick])

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
      {engineError && !engineErrorDismissed && (
        <div className="mb-3 flex items-start justify-between gap-3 rounded-lg border border-bad/40 bg-panel px-3 py-2">
          <p className="min-w-0 break-all text-xs text-bad">
            PDF 渲染引擎报错：{engineError.length > 200 ? `${engineError.slice(0, 200)}…` : engineError}
            <span className="text-dim">（可切换「文本视图」继续阅读）</span>
          </p>
          <button
            type="button"
            onClick={() => setEngineErrorDismissed(true)}
            className="shrink-0 text-xs text-dim hover:text-fg"
          >
            关闭
          </button>
        </div>
      )}
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
            // range=null 时 isPageActive 兜底 {1,1}：首屏 1-3 页无条件渲染（手机全白修复的核心）
            active={isPageActive(p, range)}
            onRenderError={handleRenderError}
          />
        ))
      )}
    </div>
  )
}
