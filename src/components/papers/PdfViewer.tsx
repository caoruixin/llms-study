import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import type * as Pdfjs from 'pdfjs-dist'
import type { LlmAuthCode } from '../../lib/llmClient'
import {
  CURRENT_BLOCK_BAND_RATIO,
  CURRENT_PAGE_EPSILON,
  isPageActive,
  pageDomId,
  pickCurrentPage,
  readerScrollTop,
  type PageEdges,
} from '../../lib/paper/anchors'
import { ensurePdfCompat } from '../../lib/paper/pdfCompat'
import {
  groupBlocksByPage,
  hasPdfLayout,
  insertionPushesReader,
  partitionPageFlow,
  pickCurrentBlock,
  pickNearestBlock,
  scaleRect,
  segmentsOnPage,
  translationBounds,
  visibleBlockRange,
  type BlockEdges,
  type FlowRow,
  type PageGeom,
  type PortionRect,
} from '../../lib/paper/pdfLayout'
import pdfWorkerUrl from '../../lib/paper/pdfWorkerEntry?worker&url'
import { hasTranslatableText } from '../../lib/paper/translate/translateBatch'
import type { LangMode, PaperBlock, PaperHighlight } from '../../lib/paper/types'
import { MQ, useMediaQuery } from '../../lib/useMediaQuery'
import PdfFlowPage, { MAX_DPR, type FlowPageSize } from './PdfFlowPage'
import PdfZhOverlay, { type ZhFlashRegistry, type ZhPageData, type ZhSlice } from './PdfZhOverlay'
import { flashElement } from './ReaderContext'

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
 *
 * 就地译文（PLAN-pdf-inline-translation §5，块带 `layout` 几何且语言不是「原文」时才启用）：
 * - 中文 → 每页在文字层之上叠 `PdfZhOverlay`（译文原位覆盖原段落框，页框尺寸不变）；
 * - 对照 → 整页换成 `PdfFlowPage`（段落对照流：原文裁成图条、译文紧跟其下，页面变高）；
 * - 当前位置升级到**块**精度（`onVisibleBlock`），翻译窗口跟着段落走而不是整页跳。
 * 不传 blocks / langMode、或语言是「原文」、或块没有几何（旧解析）时，渲染树与 effect 与改动前**逐一相同**——
 * 原文模式逐像素不变（PdfViewer.test.ts 的源码级护栏盯着 PdfPage 渲染 effect 的依赖数组）。
 */

/** 命令式 API：工作台的目录跳转 / 续读对齐按块定位（就地译文模式才可用） */
export interface PdfViewerApi {
  /** 滚动阅读窗格使块 i 顶边对齐（scroll-mt 口径），可选闪烁；块没有几何 / 越界 / 文档未就绪返回 false（调用方回退页级） */
  scrollToBlock(index: number, opts?: { flash?: boolean; behavior?: ScrollBehavior }): boolean
}

type PdfjsModule = typeof import('pdfjs-dist')
type PdfDocument = Pdfjs.PDFDocumentProxy

interface Props {
  bytes: ArrayBuffer
  /** 滚动容器（由工作台持有），用作 IntersectionObserver 的 root */
  containerRef: RefObject<HTMLElement | null>
  onVisiblePage: (page: number) => void
  onLoaded?: (pageCount: number) => void
  /** 正文块（带 layout 几何才启用就地译文）；以下全部可选，缺省 = 今天的原文视图 */
  blocks?: readonly PaperBlock[]
  langMode?: LangMode
  translations?: ReadonlyMap<number, string>
  failedTranslations?: ReadonlySet<number>
  translationAuthIssue?: LlmAuthCode | null
  onRetryTranslation?: (blockIndex: number) => void
  highlights?: ReadonlyMap<number, readonly PaperHighlight[]>
  /** 观察带（窗格上 1/4）里序号最小的块 + 当前页；就地译文模式才上报 */
  onVisibleBlock?: (blockIndex: number, page: number) => void
  /** 整个窗格可见的块区间（语音陪读）；就地译文模式才上报 */
  onVisibleRange?: (range: { min: number; max: number }) => void
  /** 文档就绪后回传命令式 API */
  onReady?: (api: PdfViewerApi) => void
  /** WebKit 没有原生 overflow-anchor：对照流的高度变化由 viewer 自己补偿滚动位置 */
  compensateScroll?: boolean
}

/** 容器宽度变化 → 重绘的防抖窗口：面板收起/展开动画与拖拽期间只重渲一次 */
const RESIZE_DEBOUNCE_MS = 150
/** 页尺寸（getViewport scale=1）每批取多少页：一批 setState 一次，150 页文档 15 次提交 */
const PAGE_SIZE_BATCH = 10
/** WebKit 滚动补偿的静默窗：最近这么久内有用户滚动（触摸惯性中）就不写 scrollTop——写了会被滚动线程覆盖 */
const SCROLL_QUIET_MS = 150
/** 程序化对齐（behavior 'auto'）两帧后复核，偏差超过它就再对一次（上方页尺寸 / 译文刚落地） */
const REALIGN_TOLERANCE_PX = 2
/**
 * viewer 自己发起的滚动（scrollToBlock / 两帧复核）在这么久内产生的 scroll 事件不算「用户滚动」：
 * 否则 WebKit 补偿的静默窗正好在刚对齐的块的译文落地时被它自己打开（审查 P1-3）。平滑滚动给足时长，
 * 到达目标值（或用户有任何滚动意图）即提前结束。
 */
const PROGRAMMATIC_SMOOTH_MS = 1500
const PROGRAMMATIC_INSTANT_MS = 120
/**
 * 平滑跳转结束判定：scrollTop 连续这么多帧不变即算停稳，然后复核一次目标位置。平滑滚动奔向的是点击那一刻算出的
 * 绝对 scrollTop，途中目标上方的译文落地 / 放行会让目标最终停在 +16 以下（实测 +82）；'auto' 早有两帧复核，平滑没有。
 */
const SMOOTH_SETTLE_FRAMES = 6
/** 平滑跳转发出后这么久 scrollTop 一直没动：目标本来就在原位附近，直接复核 */
const SMOOTH_IDLE_MS = 400
/** 读者视线：窗格顶下这么多 px 的水平线（块对齐在 +16，再往下 4px 让刚对齐的块顶边也算「跨过视线」） */
const READING_LINE_PX = 20

/**
 * 页面在 scale=1 下的几何：rawDims（换算行框）+ viewport 宽高；rotated = 页面带 /Rotate（非 0°）。
 * 行框存的是未旋转的页面空间，覆盖层 / 对照流都没有做旋转换算（PLAN §9.8）——旋转页一律按原文渲染。
 */
type PageSize = FlowPageSize & { rotated: boolean }

/** 没有任何块落在该页时对照流用的空切片（稳定引用） */
const EMPTY_SLICE: ZhSlice = {
  texts: new Map(),
  failed: new Set(),
  highlights: new Map(),
  authIssue: undefined,
  onRetry: undefined,
}

/**
 * 块在该页可翻译（对照流的 showTranslation、覆盖层的三态都只给可译块）。
 * 图内孤立短标签是段落片级的判定（PortionRect.label），由 partitionPageFlow / PdfZhOverlay 各自排除。
 */
const translatable = (b: PaperBlock | undefined): boolean => b !== undefined && hasTranslatableText(b)

/** 一块的译文 / 失败 / 高亮签名：签名不变 → 复用上次的页切片对象，memo(PdfPage) 跳过重渲染 */
const blockSig = (
  i: number,
  translations: ReadonlyMap<number, string> | undefined,
  failed: ReadonlySet<number> | undefined,
  highlights: ReadonlyMap<number, readonly PaperHighlight[]> | undefined,
): string => {
  const t = translations?.get(i)
  const hl = highlights?.get(i)
  const hs = hl?.length ? hl.map((h) => `${h.id}:${h.lang}:${h.start}:${h.end}`).join(',') : ''
  return `${t ?? (failed?.has(i) ? '\u0002' : '\u0003')}\u0004${hs}`
}

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
  /** 中文覆盖的本页数据；缺省 = 原文视图（不挂覆盖层，DOM 与改动前相同） */
  zh?: ZhPageData
}

/** memo 是必需的：滚动时 range 每变一次，父组件都会重渲染全部页占位（150 页文档尤其明显） */
const PdfPage = memo(function PdfPage({
  lib,
  doc,
  pageNumber,
  scale,
  width,
  height,
  active,
  layoutTick,
  onRenderError,
  zh,
}: PageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  /** 本页位图所用 viewport：中文覆盖按它的 scale / rawDims 换算行框（在 setRendered(true) 前写入） */
  const viewportRef = useRef<Pdfjs.PageViewport | null>(null)
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
      viewportRef.current = viewport
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
      {/* 中文覆盖：位图落地后才挂（背景要从 canvas 取样）；原文视图 zh 缺省，这里什么都不渲染 */}
      {rendered && zh && viewportRef.current && (
        <PdfZhOverlay
          page={pageNumber}
          scale={viewportRef.current.scale}
          geom={viewportRef.current.rawDims as PageGeom}
          canvasRef={canvasRef}
          {...zh}
        />
      )}
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

/** measure 里的就地译文上报去重状态（每次 effect 重建时清空：换模式后第一次测量必定上报） */
interface TrackState {
  block: number | undefined
  range: { min: number; max: number } | null
}

export default function PdfViewer({
  bytes,
  containerRef,
  onVisiblePage,
  onLoaded,
  blocks,
  langMode,
  translations,
  failedTranslations,
  translationAuthIssue,
  onRetryTranslation,
  highlights,
  onVisibleBlock,
  onVisibleRange,
  onReady,
  compensateScroll = false,
}: Props) {
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

  // -------------------------------------------------------------------------
  // 就地译文：模式判定、页尺寸、按页切片（原文视图下全部是空操作）
  // -------------------------------------------------------------------------

  const hasLayout = useMemo(() => (blocks ? hasPdfLayout(blocks) : false), [blocks])
  /** 中文 / 对照且块有几何：就地译文；否则一切照旧 */
  const inPlace = hasLayout && langMode !== undefined && langMode !== 'orig'
  /** 对照 = 段落对照流（整页换成 PdfFlowPage） */
  const flow = inPlace && langMode === 'both'

  /**
   * 每页 scale=1 的几何（rawDims + 宽高）。只在就地译文时取：覆盖层的当前块判定 / 跳转、对照流的分区都要它；
   * 原文视图沿用「全部页按第 1 页尺寸占位」不变。按文档缓存，切回原文再切回来不重取。
   */
  const [pageSizes, setPageSizes] = useState<{ doc: PdfDocument; map: ReadonlyMap<number, PageSize> } | null>(null)
  const pageSizesRef = useRef(pageSizes)
  pageSizesRef.current = pageSizes
  useEffect(() => {
    if (!inPlace || !doc) return
    let cancelled = false
    void (async () => {
      const prev = pageSizesRef.current
      let acc: Map<number, PageSize> = prev?.doc === doc ? new Map(prev.map) : new Map()
      for (let start = 1; start <= doc.numPages; start += PAGE_SIZE_BATCH) {
        const want: number[] = []
        for (let p = start; p < start + PAGE_SIZE_BATCH && p <= doc.numPages; p += 1) if (!acc.has(p)) want.push(p)
        if (!want.length) continue
        const got = await Promise.all(
          want.map(async (p) => {
            const page = await doc.getPage(p)
            const vp = page.getViewport({ scale: 1 })
            const raw = vp.rawDims as PageGeom
            const size: PageSize = {
              pageX: raw.pageX,
              pageY: raw.pageY,
              pageWidth: raw.pageWidth,
              pageHeight: raw.pageHeight,
              width: vp.width,
              height: vp.height,
              rotated: vp.rotation % 360 !== 0,
            }
            return [p, size] as const
          }),
        )
        if (cancelled) return
        // 新 Map、旧条目原样搬过去：已知页的尺寸对象引用不变 → 该页的分区缓存与 memo 都不失效
        acc = new Map(acc)
        for (const [p, size] of got) acc.set(p, size)
        const next = { doc, map: acc }
        pageSizesRef.current = next
        setPageSizes(next)
      }
    })().catch((e: unknown) => console.error('[pdf] 读取页面尺寸失败', e))
    return () => {
      cancelled = true
    }
  }, [inPlace, doc])

  const sizeOf = useCallback(
    (p: number): PageSize | undefined => (pageSizes && pageSizes.doc === doc ? pageSizes.map.get(p) : undefined),
    [pageSizes, doc],
  )

  /** 页 → 在该页有 seg 的块（文档序）；与导出内核共用 groupBlocksByPage（isLabelLike 的页级上下文才一致） */
  const blocksByPage = useMemo(
    () => (blocks && hasLayout ? groupBlocksByPage(blocks) : new Map<number, PaperBlock[]>()),
    [blocks, hasLayout],
  )
  const blockByIndex = useMemo(() => {
    const m = new Map<number, PaperBlock>()
    for (const b of blocks ?? []) m.set(b.index, b)
    return m
  }, [blocks])

  /** 页 → 段落片（页面 CSS 空间，scale=1）。按 (该页块列表, 几何对象) 缓存：页尺寸分批到达不会让已知页重算 */
  const portionCacheRef = useRef(new Map<number, { list: PaperBlock[] | undefined; geom: PageGeom; rects: PortionRect[] }>())
  const portionsOf = useCallback(
    (p: number, geom: PageGeom): PortionRect[] => {
      // 旋转页：行框在未旋转空间，换算不成立 → 当作没有块（按原文渲染、当前块 / 跳转退回页级）
      if ((geom as Partial<PageSize>).rotated) return []
      const list = blocksByPage.get(p)
      const hit = portionCacheRef.current.get(p)
      if (hit && hit.list === list && hit.geom === geom) return hit.rects
      const rects = list ? segmentsOnPage(list, p, geom) : []
      portionCacheRef.current.set(p, { list, geom, rects })
      return rects
    },
    [blocksByPage],
  )
  /** 页几何：已取到用真值，否则用第 1 页尺寸兜底（与占位同口径，页尺寸一到就换真值） */
  const baseGeom = useMemo<PageGeom | null>(
    () => (base ? { pageX: 0, pageY: 0, pageWidth: base.width, pageHeight: base.height } : null),
    [base],
  )
  const geomOf = useCallback((p: number): PageGeom | null => sizeOf(p) ?? baseGeom, [sizeOf, baseGeom])

  /** 对照流分区：按 (段落片, 页尺寸) 缓存 → 译文到达、页尺寸分批到达都不换引用，PdfFlowPage 不重绘位图 */
  type FlowLayout = { rows: FlowRow[]; textBounds: Map<number, readonly [number, number]> }
  const rowsCacheRef = useRef(new Map<number, { rects: PortionRect[]; size: PageSize; layout: FlowLayout }>())
  const flowLayoutOf = (p: number): FlowLayout | null => {
    const size = sizeOf(p)
    if (!size) return null
    const rects = portionsOf(p, size)
    const hit = rowsCacheRef.current.get(p)
    if (hit && hit.rects === rects && hit.size === size) return hit.layout
    const rows = partitionPageFlow({ pageWidth: size.pageWidth, pageHeight: size.pageHeight, page: p }, rects, {
      isTranslatable: (i) => translatable(blockByIndex.get(i)),
    })
    // 译文挂在块的最后一片之后：左缘对齐那一片的文字左缘，右缘伸到所在栏的右缘（短尾行不再压出窄框；标题 / 单行通栏片除外）
    const layout = { rows, textBounds: translationBounds(rects, (i) => blockByIndex.get(i)?.kind) }
    rowsCacheRef.current.set(p, { rects, size, layout })
    return layout
  }

  /** 跳转闪烁通道（覆盖层登记 / 挂起请求）：整个 viewer 生命周期一份 */
  const [flashRegistry] = useState<ZhFlashRegistry>(() => ({ pending: null, handlers: new Map() }))

  // -------------------------------------------------------------------------
  // 对照流：双栏行里「插在观察带之上」的译文延后挂出（QA r1 C13）
  // -------------------------------------------------------------------------
  /**
   * 双栏行（`.paper-flow-row`）里左右两栏各自一叠：观察带之上某栏插进一段译文，只有那一栏往下推——
   * 单一的 scrollTop 补偿（Chromium 原生 overflow-anchor / WebKit 的 compensateScroll）只能保住一栏，
   * 另一栏照样被推走（实测：停在第 5 页中部、右栏上方 3 块译文落地，正在读的右栏条带下移 316px）。
   * 所以：新到的译文若插入点（块最后一条图条的底边）在视线（窗格顶 + READING_LINE_PX）之上、且所在双栏行与窗格相交，
   * 就先不挂出（保留骨架）；等插入点回到视线之下（用户往回看到它）时再挂。
   * 进入对照流时已有的译文、通栏条带（单栏页 / 跨栏块）的译文不受影响。离开对照流即清空。
   */
  const deferredRef = useRef<Set<number>>(new Set())
  /** 已挂出（或进入对照流时就在）的译文块；null = 尚未进入对照流 */
  const shownRef = useRef<Set<number> | null>(null)
  const [deferTick, setDeferTick] = useState(0)
  /** 块 i 的插入点（最后一条图条的底边）与它所在的双栏行；DOM 里还没有（页尺寸未到）→ null */
  const insertionOf = useCallback((i: number): { stripBottom: number; row: DOMRect | null } | null => {
    const wrap = wrapRef.current
    if (!wrap) return null
    const strips = wrap.querySelectorAll<HTMLElement>(`[data-strip][data-block-index="${i}"]`)
    const last = strips[strips.length - 1]
    if (!last) return null
    const row = last.closest('.paper-flow-row')
    return { stripBottom: last.getBoundingClientRect().bottom, row: row ? row.getBoundingClientRect() : null }
  }, [])
  /** 该插入点现在挂出会不会推动观察带处正在读的内容（判定见 pdfLayout.insertionPushesReader） */
  const wouldPushReader = useCallback(
    (ins: { stripBottom: number; row: DOMRect | null }): boolean => {
      const root = containerRef.current
      if (!root) return false
      const top = root.getBoundingClientRect().top + root.clientTop
      return insertionPushesReader(ins, { top, bottom: top + root.clientHeight }, top + READING_LINE_PX)
    },
    [containerRef],
  )
  /** 实际渲染的译文：对照流里扣掉延后的块（渲染期读 DOM 只为给「新到的块」分类，读的是上一次提交的布局） */
  const renderTranslations = useMemo(() => {
    if (!flow || !translations) {
      shownRef.current = null
      deferredRef.current.clear()
      return translations
    }
    if (shownRef.current === null) {
      shownRef.current = new Set(translations.keys())
      return translations
    }
    for (const i of translations.keys()) {
      if (shownRef.current.has(i) || deferredRef.current.has(i)) continue
      const ins = insertionOf(i)
      if (ins && wouldPushReader(ins)) deferredRef.current.add(i)
      else shownRef.current.add(i)
    }
    if (!deferredRef.current.size) return translations
    const out = new Map(translations)
    for (const i of deferredRef.current) out.delete(i)
    return out
    // deferTick：测量里放行了延后的块 → 重新扣一遍
  }, [flow, translations, insertionOf, wouldPushReader, deferTick])
  /**
   * 测量帧里调用：插入点回到视线之下（读者往回看到了它，或整行已在窗格下方）的延后块 → 放行。
   * 不在「行离开窗格上沿」时放行：那时用户多半正在往下滚，WebKit 的补偿在滚动静默窗内不写 scrollTop，
   * 窗格上方插进一段译文会让正在看的内容整体下跳；留到用户回看时再挂，插入点就在视线处，没有位移可言。
   */
  const releaseDeferred = useCallback(() => {
    if (!deferredRef.current.size) return
    const root = containerRef.current
    if (!root) return
    const line = root.getBoundingClientRect().top + root.clientTop + READING_LINE_PX
    let released = false
    for (const i of [...deferredRef.current]) {
      const ins = insertionOf(i)
      if (ins && ins.stripBottom <= line) continue
      deferredRef.current.delete(i)
      shownRef.current?.add(i)
      released = true
    }
    if (released) setDeferTick((t) => t + 1)
  }, [containerRef, insertionOf])

  /**
   * 每页译文切片：签名（本页各块的译文 / 失败 / 高亮）不变就复用上次的对象——一批译文落地只让涉及的那几页重渲染，
   * 其余页 memo 命中（对照流 DOM 常驻 150 页时尤其要紧）。
   */
  const sliceCacheRef = useRef(new Map<number, { sig: string; data: ZhPageData }>())
  const zhByPage = useMemo(() => {
    if (!inPlace) return null
    const out = new Map<number, ZhPageData>()
    const cache = sliceCacheRef.current
    for (const [p, list] of blocksByPage) {
      let sig = ''
      for (const b of list) sig += `${b.index}=${blockSig(b.index, renderTranslations, failedTranslations, highlights)}\u0001`
      const hit = cache.get(p)
      if (
        hit &&
        hit.sig === sig &&
        hit.data.blocks === list &&
        hit.data.authIssue === translationAuthIssue &&
        hit.data.onRetry === onRetryTranslation
      ) {
        out.set(p, hit.data)
        continue
      }
      const texts = new Map<number, string>()
      const failed = new Set<number>()
      const hls = new Map<number, readonly PaperHighlight[]>()
      for (const b of list) {
        const t = renderTranslations?.get(b.index)
        if (t !== undefined) texts.set(b.index, t)
        if (failedTranslations?.has(b.index)) failed.add(b.index)
        const h = highlights?.get(b.index)
        if (h?.length) hls.set(b.index, h)
      }
      const data: ZhPageData = {
        blocks: list,
        texts,
        failed,
        highlights: hls,
        authIssue: translationAuthIssue,
        onRetry: onRetryTranslation,
        flash: flashRegistry,
      }
      cache.set(p, { sig, data })
      out.set(p, data)
    }
    return out
  }, [inPlace, blocksByPage, renderTranslations, failedTranslations, highlights, translationAuthIssue, onRetryTranslation, flashRegistry])

  /**
   * 当前块 / 可见区间的测量（挂在「当前页」rAF 测量的同一帧里，见下方 effect）。
   * 观察带 = [窗格顶 + EPS, 窗格顶 + 0.25 × 窗格高]，与 BlockReader 的 IO `-8px … -75%` 同口径。
   * - 覆盖模式：块边来自几何（页框 top + scaleRect(片).y），页没渲染也能算；
   * - 对照流：量候选页内 `[data-block-index]`（图条 + 译文 div）的 DOM 矩形——译文区域算进块内。
   * 只在就地译文时挂（原文视图 trackRef 为 null，测量与改动前完全一样）。
   */
  const onVisibleBlockRef = useRef(onVisibleBlock)
  onVisibleBlockRef.current = onVisibleBlock
  const onVisibleRangeRef = useRef(onVisibleRange)
  onVisibleRangeRef.current = onVisibleRange
  /** 当前测量 effect 的「排一帧测量」入口（高度变化后补测用；effect 重建时换新） */
  const remeasureRef = useRef<(() => void) | null>(null)
  /** WebKit 补偿的锚元素：测量时记下「当前页里第一个底边过探测线的图条 / 译文」与它离窗格顶的距离 */
  const scrollAnchorRef = useRef<{ el: Element; offset: number } | null>(null)
  /**
   * 程序化跳转（目录 / 引用回跳 / 续读对齐）的目标块：它仍在观察带里就报它。双栏页上与目标同高的左栏块序号更小，
   * 按「带内序号最小」会把目标冲成左栏那块（实测跳到右栏的 Notes 记成 227 而不是 231，重开就对到别处）。
   * 用户任何滚动意图（滚轮 / 触摸 / 键盘 / 按下）或目标离开观察带即解除。
   */
  const pinRef = useRef<number | null>(null)
  /** viewer 自己发起的滚动：目标 scrollTop 与截止时刻（见 PROGRAMMATIC_*_MS） */
  const programmaticRef = useRef<{ target: number; until: number } | null>(null)
  /** 平滑跳转的停稳复核令牌：新跳转或用户滚动意图会换掉 / 清掉它，旧的复核随即作废 */
  const smoothRealignRef = useRef<object | null>(null)
  /**
   * viewer 发起的滚动还在路上：平滑跳转的停稳复核还没做（它可能还要再挪一次），或 scrollTop 未到目标值且未超时。
   * 停稳复核也算在途：平滑滚动先停在点击时算的旧目标上（途中上方译文落地把目标推下去了），这一刻目标不在观察带里，
   * 若就此解除钉住，复核把目标挪回 +16 后报的已是同高的别栏块（QA r1 E22：Conclusion 记成 101）。
   */
  const programmaticInFlight = (): boolean => {
    if (smoothRealignRef.current) return true
    const prog = programmaticRef.current
    const root = containerRef.current
    return !!prog && !!root && performance.now() <= prog.until && Math.abs(root.scrollTop - prog.target) >= 1
  }
  const releaseDeferredRef = useRef(releaseDeferred)
  releaseDeferredRef.current = releaseDeferred
  /**
   * 读者视线处的元素与视线在它内部的相对位置（测量帧里记）：宽度变化（Copilot 开合、窗口缩放）改 scale 后据此复位。
   * Chromium 的原生 overflow-anchor 在锚点或其祖先的尺寸变化时按规范「抑制」调整——对照流 / 覆盖页的图条与页框
   * 正是按 scale 改 style 尺寸，于是开个 Copilot 视线就被推走一千多 px（QA r1 C14）；WebKit 的锚点差值补偿也只保一栏。
   * 中文覆盖：页框整体等比缩放，记页框；对照流：优先记当前块跨过视线的那个元素（图条 / 译文），否则 DOM 序第一个。
   */
  const readingRef = useRef<{ el: Element; frac: number } | null>(null)
  const compensating = flow && compensateScroll
  const trackRef = useRef<
    | ((state: TrackState, nodes: readonly HTMLElement[], edges: readonly PageEdges[], viewportTop: number, height: number, page: number) => void)
    | null
  >(null)
  trackRef.current = inPlace
    ? (state, nodes, edges, viewportTop, height, page) => {
        const bandTop = viewportTop + CURRENT_PAGE_EPSILON
        const bandBottom = viewportTop + height * CURRENT_BLOCK_BAND_RATIO
        const viewBottom = viewportTop + height
        const cache = new Map<number, BlockEdges[]>()
        const blockEdgesOf = (k: number): BlockEdges[] => {
          const hit = cache.get(k)
          if (hit) return hit
          const node = nodes[k]
          const out: BlockEdges[] = []
          if (flow) {
            for (const el of node.querySelectorAll<HTMLElement>('[data-block-index]')) {
              const r = el.getBoundingClientRect()
              out.push({ blockIndex: Number(el.dataset.blockIndex), top: r.top, bottom: r.bottom })
            }
          } else {
            const p = edges[k].page
            const geom = geomOf(p)
            if (geom) {
              // 页框有 1px 边框：canvas 与覆盖层从内侧开始
              const top = edges[k].top + node.clientTop
              for (const pr of portionsOf(p, geom)) {
                const r = scaleRect(pr.rect, scale)
                out.push({ blockIndex: pr.blockIndex, top: top + r.y, bottom: top + r.y + r.h })
              }
            }
          }
          cache.set(k, out)
          return out
        }
        const band: BlockEdges[] = []
        const visible: BlockEdges[] = []
        for (let k = 0; k < edges.length; k += 1) {
          const e = edges[k]
          if (e.bottom > bandTop && e.top < bandBottom) band.push(...blockEdgesOf(k))
          if (onVisibleRangeRef.current && e.bottom > viewportTop && e.top < viewBottom) visible.push(...blockEdgesOf(k))
        }
        let current = pickCurrentBlock(band, bandTop, bandBottom)
        const pin = pinRef.current
        if (pin !== null) {
          if (band.some((e) => e.blockIndex === pin && e.bottom > bandTop && e.top < bandBottom)) current = pin
          else if (!programmaticInFlight()) pinRef.current = null // 平滑滚动途中目标还没进带：别提前解除
        }
        if (current === undefined) {
          // 观察带里没有块（整页插图 / 页间空隙）：报当前页前后一页里刚读过的那块（其次带下方最近的一块），
          // 页码与块序号保持一致；当前页附近一个块都没有才沿用上次
          const k = edges.findIndex((e) => e.page === page)
          const near: BlockEdges[] = []
          for (let j = Math.max(0, k - 1); j <= Math.min(edges.length - 1, k + 1); j += 1) near.push(...blockEdgesOf(j))
          current = pickNearestBlock(near, bandTop, bandBottom)
        }
        // 程序化跳转途中不上报：工作台已把位置设成目标，途经的块冲掉它只会让翻译窗口白译一路（到达后按钉住的目标上报）
        if (current !== undefined && current !== state.block && !programmaticInFlight()) {
          state.block = current
          onVisibleBlockRef.current?.(current, page)
        }
        {
          const line = viewportTop + READING_LINE_PX
          let picked: { el: Element; frac: number } | null = null
          for (let k = 0; k < edges.length && !picked; k += 1) {
            const e = edges[k]
            if (!(e.top <= line && e.bottom > line)) continue
            const node = nodes[k]
            if (!flow) {
              picked = { el: node, frac: (line - e.top) / Math.max(1, e.bottom - e.top) }
              break
            }
            let first: { el: Element; frac: number } | null = null
            for (const el of node.querySelectorAll('[data-strip], .paper-flow-zh, .paper-flow-skel, .paper-flow-fail')) {
              const r = el.getBoundingClientRect()
              if (!(r.top <= line && r.bottom > line)) continue
              const cand = { el, frac: (line - r.top) / Math.max(1, r.height) }
              if (Number((el as HTMLElement).dataset.blockIndex) === state.block) {
                picked = cand
                break
              }
              first ??= cand
            }
            picked ??= first
          }
          if (picked) readingRef.current = picked
        }
        const onRange = onVisibleRangeRef.current
        if (onRange) {
          const r = visibleBlockRange(visible, viewportTop, viewBottom)
          if (r && (!state.range || state.range.min !== r.min || state.range.max !== r.max)) {
            state.range = r
            onRange(r)
          }
        }
        if (flow) releaseDeferredRef.current()
        if (compensating) {
          const k = edges.findIndex((e) => e.page === page)
          const node = k >= 0 ? nodes[k] : undefined
          let anchor: { el: Element; offset: number } | null = null
          if (node) {
            for (const el of node.querySelectorAll('[data-strip], [data-block-index]')) {
              const r = el.getBoundingClientRect()
              if (r.bottom > bandTop) {
                anchor = { el, offset: r.top - viewportTop }
                break
              }
            }
          }
          scrollAnchorRef.current = anchor
        }
      }
    : null

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
    // flow：对照流与普通页是两种组件，切换时页节点整批换新，必须重新观察（原文视图恒为 false）
  }, [containerRef, pages.length, flow])

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
    const track: TrackState = { block: undefined, range: null }
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
      if (page !== reported) {
        reported = page
        onVisiblePage(page)
      }
      // 就地译文：同一帧再算当前块 / 可见区间（原文视图 trackRef 为 null，与改动前完全一样）
      trackRef.current?.(track, nodes, edges, viewportTop, root.clientHeight, page)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    remeasureRef.current = schedule
    root.addEventListener('scroll', schedule, { passive: true })
    // scrollTop 为 0 时不主动结算：PDF 刚挂载、alignToPosition 还没把恢复的阅读位置滚上去，
    // 此时结算只会把「当前页」冲成第 1 页。真正需要重算的场景（宽度变化改了页高）scrollTop 都不为 0。
    if (root.scrollTop > 0) schedule()
    return () => {
      if (remeasureRef.current === schedule) remeasureRef.current = null
      root.removeEventListener('scroll', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
    // flow：页节点整批换新要重取 nodes；inPlace：切入就地译文要从干净的上报状态开始（原文视图两者恒为 false）
  }, [containerRef, onVisiblePage, pages.length, layoutTick, flow, inPlace])

  /**
   * 对照流的高度变化（译文挂出 / 延后放行 / 页尺寸到达）之后补测一帧：观察带下的块可能已经换了，
   * 不等用户滚动才重算当前块（charter 记录的 P2）。只在对照流做，覆盖 / 原文模式页高恒定。
   */
  useEffect(() => {
    if (flow) remeasureRef.current?.()
  }, [flow, renderTranslations, pageSizes])

  // -------------------------------------------------------------------------
  // WebKit 滚动补偿（对照流）：Chromium / Firefox 的原生 overflow-anchor 会兜住视口上方的高度变化，
  // WebKit 没有——译文落地 / 页尺寸到达 / scale 变化让上方变高，正在读的内容就被推走。
  // 提交后、绘制前按锚元素的位移补 scrollTop；用户滚动中（惯性）不写，写了会被滚动线程覆盖。
  // -------------------------------------------------------------------------

  /** 最近一次「用户」滚动的时刻（自己写 scrollTop、viewer 程序化滚动引起的 scroll 事件不算） */
  const userScrollAtRef = useRef(0)
  const ownScrollTopRef = useRef<number | null>(null)
  useEffect(() => {
    const root = containerRef.current
    if (!compensating || !root) return
    const onScroll = () => {
      const own = ownScrollTopRef.current
      if (own !== null && Math.abs(root.scrollTop - own) < 1) {
        ownScrollTopRef.current = null
        return
      }
      const prog = programmaticRef.current
      if (prog) {
        // 程序化滚动途中 / 到达：不打开静默窗；到达目标或超时即结束标记
        if (Math.abs(root.scrollTop - prog.target) < 1 || performance.now() > prog.until) programmaticRef.current = null
        if (performance.now() <= prog.until) return
      }
      userScrollAtRef.current = performance.now()
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [compensating, containerRef])

  /**
   * 用户的滚动意图（滚轮 / 触摸 / 键盘 / 按下滚动条）：解除跳转钉住的当前块、结束程序化滚动标记——
   * 此后的 scroll 事件都按用户滚动处理（含触摸惯性：手指离开后的 scroll 事件照样打开静默窗）。
   */
  useEffect(() => {
    const root = containerRef.current
    if (!root || !inPlace) return
    const onIntent = () => {
      pinRef.current = null
      programmaticRef.current = null
      smoothRealignRef.current = null
    }
    const opts = { passive: true, capture: true } as const
    root.addEventListener('wheel', onIntent, opts)
    root.addEventListener('touchstart', onIntent, opts)
    root.addEventListener('pointerdown', onIntent, opts)
    window.addEventListener('keydown', onIntent, opts)
    return () => {
      root.removeEventListener('wheel', onIntent, opts)
      root.removeEventListener('touchstart', onIntent, opts)
      root.removeEventListener('pointerdown', onIntent, opts)
      window.removeEventListener('keydown', onIntent, opts)
    }
  }, [containerRef, inPlace])

  useLayoutEffect(() => {
    if (!compensating) return
    const root = containerRef.current
    const anchor = scrollAnchorRef.current
    if (!root || !anchor || !anchor.el.isConnected) return
    if (performance.now() - userScrollAtRef.current < SCROLL_QUIET_MS) return
    const viewportTop = root.getBoundingClientRect().top + root.clientTop
    const delta = anchor.el.getBoundingClientRect().top - viewportTop - anchor.offset
    if (Math.abs(delta) < 1) return
    root.scrollTop += delta
    ownScrollTopRef.current = root.scrollTop
    anchor.offset = anchor.el.getBoundingClientRect().top - viewportTop
    // renderTranslations（而非 translations）：延后放行也会改高度，补偿要跟着实际挂出的译文跑
  }, [compensating, containerRef, renderTranslations, failedTranslations, pageSizes])

  /**
   * scale 变化（宽度变化）后、绘制前把读者视线复位到同一元素的同一相对位置（见 readingRef）。
   * 只在就地译文模式做——原文模式的滚动行为保持改动前原样。复位后顺手刷新 WebKit 补偿锚点的偏移，
   * 否则下一批译文落地时补偿会把「scale 带来的位移」当成「译文带来的位移」再挪一次。
   */
  const prevScaleRef = useRef(scale)
  useLayoutEffect(() => {
    const prev = prevScaleRef.current
    prevScaleRef.current = scale
    if (prev === scale || !inPlace) return
    const root = containerRef.current
    const reading = readingRef.current
    if (!root || !reading || !reading.el.isConnected) return
    const viewportTop = root.getBoundingClientRect().top + root.clientTop
    const r = reading.el.getBoundingClientRect()
    const delta = r.top + reading.frac * r.height - (viewportTop + READING_LINE_PX)
    if (Math.abs(delta) >= 1) {
      root.scrollTop += delta
      ownScrollTopRef.current = root.scrollTop
    }
    const anchor = scrollAnchorRef.current
    if (anchor?.el.isConnected) anchor.offset = anchor.el.getBoundingClientRect().top - viewportTop
  }, [scale, inPlace, containerRef])

  // -------------------------------------------------------------------------
  // 块级跳转（命令式 API）
  // -------------------------------------------------------------------------

  /** 对照流里目标块的条带还没就位（页尺寸未知）时挂起的对齐：该页 onLaidOut 时兑现 */
  const pendingAlignRef = useRef<{ index: number; page: number; opts?: { flash?: boolean; behavior?: ScrollBehavior } } | null>(null)
  const liveRef = useRef({ hasLayout, inPlace, flow, scale, blockByIndex, portionsOf, geomOf })
  liveRef.current = { hasLayout, inPlace, flow, scale, blockByIndex, portionsOf, geomOf }

  const scrollToBlock = useCallback(
    (index: number, opts?: { flash?: boolean; behavior?: ScrollBehavior }): boolean => {
      const live = liveRef.current
      // 只要块有几何就能按块对齐（原文页同样适用：页框 + 片的 y），工作台据此在进出对照流时同步接回位置
      if (!live.hasLayout) return false
      const segs = live.blockByIndex.get(index)?.layout?.segs
      const root = containerRef.current
      const wrap = wrapRef.current
      if (!segs?.length || !root || !wrap) return false
      const page = segs[0].page
      const node = wrap.querySelector<HTMLElement>(`[data-page="${page}"]`)
      if (!node) return false
      const behavior = opts?.behavior ?? 'smooth'
      const viewportTop = () => root.getBoundingClientRect().top + root.clientTop
      /** 程序化滚动：登记目标值，期间的 scroll 事件不算用户滚动（WebKit 补偿的静默窗不被自己打开） */
      const scrollRoot = (to: number, how: ScrollBehavior) => {
        const target = Math.max(0, Math.min(to, root.scrollHeight - root.clientHeight))
        programmaticRef.current = {
          target,
          until: performance.now() + (how === 'smooth' ? PROGRAMMATIC_SMOOTH_MS : PROGRAMMATIC_INSTANT_MS),
        }
        root.scrollTo({ top: target, behavior: how })
      }
      /** 复核：目标此刻量不到（NaN：页节点 / 条带已被换掉且还没就位）就不动，绝不按 0 去「对齐」 */
      let realign = () => undefined as void
      const go = (top: () => number) => {
        realign = () => {
          const t = top()
          if (!Number.isFinite(t)) return
          const want = readerScrollTop(root.scrollTop, t, viewportTop())
          if (Math.abs(want - root.scrollTop) > REALIGN_TOLERANCE_PX) scrollRoot(want, 'auto')
        }
        const t0 = top()
        if (!Number.isFinite(t0)) return
        scrollRoot(readerScrollTop(root.scrollTop, t0, viewportTop()), behavior)
        if (behavior === 'smooth') {
          // 停稳后复核一次（见 SMOOTH_SETTLE_FRAMES）；用户中途接手（滚动意图清掉令牌）或又发起新跳转则作废
          const token = {}
          smoothRealignRef.current = token
          const started = performance.now()
          let last = root.scrollTop
          let still = 0
          // 平滑动画头几帧可能还没动：没动过就不算停稳（除非已过了足够长的时间——目标就在眼前、根本不用滚）
          let moved = false
          const tick = () => {
            if (smoothRealignRef.current !== token) return
            const cur = root.scrollTop
            if (Math.abs(cur - last) >= 0.5) moved = true
            still = Math.abs(cur - last) < 0.5 ? still + 1 : 0
            last = cur
            const elapsed = performance.now() - started
            const settled = still >= SMOOTH_SETTLE_FRAMES && (moved || elapsed > SMOOTH_IDLE_MS)
            if (!settled && elapsed < PROGRAMMATIC_SMOOTH_MS) {
              requestAnimationFrame(tick)
              return
            }
            smoothRealignRef.current = null
            realign()
            // 复核没挪（无 scroll 事件）也补测一帧：在途期间压住的上报此刻按钉住的目标结算
            remeasureRef.current?.()
          }
          requestAnimationFrame(tick)
          return
        }
        // 两帧后复核：上方页尺寸 / 译文刚落地会让目标再挪一点
        requestAnimationFrame(() => requestAnimationFrame(realign))
      }
      pendingAlignRef.current = null
      // 钉住目标：滚动结算后它仍在观察带里就报它（双栏页不被同高的左栏块冲掉）
      pinRef.current = index
      /**
       * 复核时**重新查**页节点与目标元素：点击那一刻拿到的元素在平滑滚动途中可能被换掉（页尺寸到达后占位换成条带、
       * 进出对照流整批换页组件），对着已脱离文档的元素量 getBoundingClientRect 得 0，复核会把窗格滚到错处、
       * 目标掉出观察带、钉住失效（QA r1 E22 偶发：跳 Conclusion 记成别栏的 101）。
       */
      const pageNow = (): HTMLElement | null => wrap.querySelector<HTMLElement>(`[data-page="${page}"]`)
      if (live.flow) {
        const el = node.querySelector<HTMLElement>(`[data-block-index="${index}"]`)
        if (!el) {
          // 该页尺寸未知、条带还没就位：先滚到页，PdfFlowPage.onLaidOut 时再对齐到块
          go(() => pageNow()?.getBoundingClientRect().top ?? Number.NaN)
          pendingAlignRef.current = { index, page, opts }
          return true
        }
        go(() => {
          const cur = el.isConnected ? el : pageNow()?.querySelector<HTMLElement>(`[data-block-index="${index}"]`)
          return cur ? cur.getBoundingClientRect().top : Number.NaN
        })
        if (opts?.flash) for (const target of wrap.querySelectorAll(`[data-block-index="${index}"]`)) flashElement(target)
        return true
      }
      // 覆盖 / 原文：页框 top + 首片 y，纯几何——目标页没渲染也能对齐
      const geom = live.geomOf(page)
      const portion = geom ? live.portionsOf(page, geom).find((p) => p.blockIndex === index) : undefined
      go(() => {
        const n = pageNow()
        if (!n) return Number.NaN
        return n.getBoundingClientRect().top + n.clientTop + (portion ? scaleRect(portion.rect, liveRef.current.scale).y : 0)
      })
      if (opts?.flash) {
        if (live.inPlace) {
          const flashNow = flashRegistry.handlers.get(page)
          flashRegistry.pending = flashNow?.(index) ? null : { index, at: performance.now() }
        } else {
          // 原文页没有覆盖层：闪整页（与改动前的页级跳转同一表现）
          flashElement(node)
        }
      }
      return true
    },
    [containerRef, flashRegistry],
  )

  const handleLaidOut = useCallback(
    (page: number) => {
      const pending = pendingAlignRef.current
      if (!pending || pending.page !== page) return
      pendingAlignRef.current = null
      scrollToBlock(pending.index, pending.opts)
    },
    [scrollToBlock],
  )

  const api = useMemo<PdfViewerApi>(() => ({ scrollToBlock }), [scrollToBlock])
  useEffect(() => {
    if (doc && lib && base) onReady?.(api)
  }, [doc, lib, base, api, onReady])

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
        pages.map((p) => {
          // 旋转页（PLAN §9.8）：就地译文不做旋转换算，按原文页渲染
          const rotated = sizeOf(p)?.rotated === true
          if (flow && !rotated) {
            const fl = flowLayoutOf(p)
            return (
              <PdfFlowPage
                key={p}
                lib={lib}
                doc={doc}
                pageNumber={p}
                scale={scale}
                layoutTick={layoutTick}
                active={isPageActive(p, range)}
                size={sizeOf(p) ?? null}
                fallbackWidth={base.width * scale}
                fallbackHeight={base.height * scale}
                rows={fl?.rows ?? null}
                textBounds={fl?.textBounds}
                zh={zhByPage?.get(p) ?? EMPTY_SLICE}
                onRenderError={handleRenderError}
                onLaidOut={handleLaidOut}
              />
            )
          }
          return (
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
              zh={inPlace && !rotated ? zhByPage?.get(p) : undefined}
            />
          )
        })
      )}
    </div>
  )
}
