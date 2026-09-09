import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import katexCssUrl from 'katex/dist/katex.min.css?url'
import type { LlmAuthCode } from '../../lib/llmClient'
import { CURRENT_PAGE_EPSILON, readerScrollTop } from '../../lib/paper/anchors'
import type { LangMode, PaperBlock, PaperHighlight } from '../../lib/paper/types'
import { decodeWebSnapshot, type WebSnapshotHeader } from '../../lib/paper/url/webSnapshot'
import { flashElement } from './ReaderContext'
import type { SelectionSource } from './SelectionActions'
import {
  READER_STYLE_ID,
  applyHighlights,
  applyLangState,
  buildReaderSrcdoc,
  hostRectInParent,
  pickLinkAction,
} from './snapshotDom'

/**
 * 「网页原貌」视图（PLAN-web-snapshot-sync.md §2.3）：快照字节 → 同源无脚本 iframe。
 *
 * 安全边界：`sandbox="allow-same-origin"`，**绝不加 allow-scripts**——同源沙箱 + 脚本 = 页面可自行
 * 摘掉沙箱（WebSnapshotView.test.ts 断言 sandbox 属性恰为 allow-same-origin）。文档内还有一层 CSP meta。
 *
 * 布局：iframe 是**惰性自适应高度**的文档，放在工作台现有的 `main` 滚动容器里，**不在 iframe 内滚动**
 * （iOS Safari 会自动撑开 iframe；scrollReaderTo / IntersectionObserver / 选区条都假定 main 滚动）。
 * 高度由 iframe 自己窗口的 ResizeObserver 观察 documentElement 同步过来。
 *
 * 观察器建在**父窗口**（root 隐式 = 顶层视口；规范要求 root 与 target 同文档，不能传 main），
 * 祖先链 main 的 overflow 裁剪已计入交集，两个观察器与 rootMargin 语义照 BlockReader。
 *
 * 译文/高亮/链接/跳转全部委托 snapshotDom.ts 的纯 DOM 函数；本组件只管生命周期与事件。
 */

export interface WebSnapshotApi {
  /** 滚动 main 使块 i 顶边对齐（scroll-mt 口径），可选闪烁；块不存在返回 false */
  scrollToBlock(index: number, opts?: { flash?: boolean; behavior?: ScrollBehavior }): boolean
  /** 高亮捕获用的容器（iframe body）；文档未就绪为 null */
  container(): HTMLElement | null
  /** iframe 内当前选区文本（trim 后） */
  selectionText(): string
}

interface Props {
  bytes: ArrayBuffer
  blocks: PaperBlock[]
  /** 滚动容器（工作台的 main）：跳转/锚点滚动只滚它 */
  containerRef: RefObject<HTMLElement | null>
  langMode?: LangMode
  translations?: ReadonlyMap<number, string>
  failedTranslations?: ReadonlySet<number>
  translationAuthIssue?: LlmAuthCode | null
  onRetryTranslation?: (blockIndex: number) => void
  highlights?: ReadonlyMap<number, readonly PaperHighlight[]>
  /** 视口上 1/4 区域内最靠上的块（阅读进度与目录高亮） */
  onVisibleBlock: (blockIndex: number) => void
  /** 全视口可见块区间（语音陪读）；不传则不建第二观察器 */
  onVisibleRange?: (range: { min: number; max: number }) => void
  /** 文档载入并绑定完成后回传命令式 API（每次重载都会再回一次） */
  onReady?: (api: WebSnapshotApi) => void
  /** iframe 文档作为选区源注册/注销（卸载或重载时先传 null） */
  onSelectionSource?: (source: SelectionSource | null) => void
  onMarkClick?: (highlightId: string) => void
  /** 译文失败 chip 里的应用内链接（`[data-pc-nav]`，如 /settings） */
  onNavigate?: (path: string) => void
  /** 快照字节损坏等致命错误（组件同时会渲染内联错误框） */
  onError?: (message: string) => void
}

type Decoded = { header: WebSnapshotHeader; assetBytes: (id: string) => Uint8Array | null } | { error: string }

interface Bound {
  doc: Document
  win: Window
  cleanup: () => void
}

/** iframe 高度上限：防御未知的高度回环（vh 已在水合时钉死，正常文档远达不到） */
const MAX_HEIGHT_PX = 400_000
/** 等文档解析就绪的轮询间隔：只在绑定前跑，绑上即停 */
const BIND_POLL_MS = 50
const EMPTY_HIGHLIGHTS: ReadonlyMap<number, readonly PaperHighlight[]> = new Map()

const cssEscape = (s: string): string =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&')

/** 事件目标 → 元素；按 nodeType 判定（iframe 节点属于另一个 realm，父窗口的 instanceof 认不出） */
const asElement = (target: EventTarget | null): Element | null => {
  const n = target as Node | null
  if (!n || typeof n.nodeType !== 'number') return null
  return n.nodeType === 1 ? (n as Element) : (n.parentElement ?? null)
}

export default function WebSnapshotView({
  bytes,
  blocks,
  containerRef,
  langMode = 'orig',
  translations,
  failedTranslations,
  translationAuthIssue,
  onRetryTranslation,
  highlights,
  onVisibleBlock,
  onVisibleRange,
  onReady,
  onSelectionSource,
  onMarkClick,
  onNavigate,
  onError,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const boundRef = useRef<Bound | null>(null)
  const [srcdoc, setSrcdoc] = useState<string | null>(null)
  /** 每次 iframe 文档载入并绑定后 +1：依赖它的 effect 才会去碰新文档 */
  const [docTick, setDocTick] = useState(0)

  // 回调走 ref：文档绑定发生在 load 时，不因回调引用变化重绑
  const callbacks = useRef({ onRetryTranslation, onReady, onSelectionSource, onMarkClick, onNavigate, onError })
  callbacks.current = { onRetryTranslation, onReady, onSelectionSource, onMarkClick, onNavigate, onError }

  const decoded = useMemo<Decoded>(() => {
    try {
      return decodeWebSnapshot(bytes)
    } catch (e) {
      return { error: (e as Error).message || '快照文件无法解析' }
    }
  }, [bytes])

  /** 把 iframe 里的元素滚到 main 视口顶边（scroll-mt 口径），与工作台 scrollReaderTo 同一公式 */
  const scrollMainTo = useCallback(
    (el: Element, behavior: ScrollBehavior) => {
      const main = containerRef.current
      const iframe = iframeRef.current
      if (!main || !iframe) return
      const rect = hostRectInParent(iframe, el)
      const viewportTop = main.getBoundingClientRect().top + main.clientTop
      main.scrollTo({ top: readerScrollTop(main.scrollTop, rect.top, viewportTop), behavior })
    },
    [containerRef],
  )

  const api = useMemo<WebSnapshotApi>(
    () => ({
      scrollToBlock: (index, opts) => {
        const bound = boundRef.current
        if (!bound) return false
        const el = bound.doc.querySelector(`[data-pc-block="${index}"]`)
        if (!el) return false
        scrollMainTo(el, opts?.behavior ?? 'smooth')
        if (opts?.flash) flashElement(el)
        return true
      },
      container: () => boundRef.current?.doc.body ?? null,
      selectionText: () => boundRef.current?.win.getSelection()?.toString().trim() ?? '',
    }),
    [scrollMainTo],
  )

  // blob URL 生命周期：挂载/换字节时创建并水合 srcdoc，卸载/换字节时 revoke
  useEffect(() => {
    if ('error' in decoded) {
      callbacks.current.onError?.(decoded.error)
      return
    }
    const urls = new Map<string, string>()
    for (const a of decoded.header.assets) {
      const view = decoded.assetBytes(a.id)
      if (!view) continue
      try {
        urls.set(a.id, URL.createObjectURL(new Blob([view as BlobPart], { type: a.mime })))
      } catch {
        /* 单个资源建不出 blob：CSS/图片回落原 https URL */
      }
    }
    const katexCssHref =
      decoded.header.capture.katex && katexCssUrl ? new URL(katexCssUrl, window.location.href).href : undefined
    const viewportHeightPx = containerRef.current?.clientHeight || window.innerHeight
    setSrcdoc(
      buildReaderSrcdoc(decoded.header, (id) => urls.get(id) ?? null, {
        ...(katexCssHref ? { katexCssHref } : {}),
        viewportHeightPx,
      }),
    )
    return () => {
      for (const u of urls.values()) URL.revokeObjectURL(u)
    }
  }, [decoded, containerRef])

  // 首屏占位高度：ResizeObserver 接管前给个体面的高度；写 DOM 而不走 style prop，免得重渲染覆盖 RO 的写入
  useEffect(() => {
    const iframe = iframeRef.current
    if (iframe && !iframe.style.height) iframe.style.height = '60vh'
  }, [])

  const handleLoad = useCallback(() => {
    const iframe = iframeRef.current
    const doc = iframe?.contentDocument
    const win = iframe?.contentWindow
    if (!iframe || !doc || !win) return
    // 同一份文档只绑一次：解析就绪的轮询与 load 事件都会走到这里
    if (boundRef.current?.doc === doc) return
    boundRef.current?.cleanup()
    boundRef.current = null
    // srcdoc 赋值前的 about:blank 首载：没有阅读器样式就不是我们的文档
    if (!doc.getElementById(READER_STYLE_ID) || !doc.body) return
    const header = 'error' in decoded ? null : decoded.header
    if (!header) return

    // 高度同步：观察 documentElement 与 body（绝对定位溢出只反映在 scrollHeight 上，两者取大）
    let lastHeight = 0
    const syncHeight = () => {
      const root = doc.documentElement
      if (!root) return
      const h = Math.ceil(Math.max(root.scrollHeight, root.getBoundingClientRect().height, doc.body?.scrollHeight ?? 0))
      if (!h || Math.abs(h - lastHeight) < 1) return
      lastHeight = h
      iframe.style.height = `${Math.min(h, MAX_HEIGHT_PX)}px`
    }
    // 用 iframe 自己窗口的 ResizeObserver（观察对象属于那个 realm）；类型上 Window 没有该属性，按 globalThis 取
    const RO = (win as unknown as typeof globalThis).ResizeObserver ?? window.ResizeObserver
    const ro = new RO(syncHeight)
    ro.observe(doc.documentElement)
    ro.observe(doc.body)
    syncHeight()

    // 捕获阶段拦截全部点击：沙箱无 popups/forms，但 iframe 仍可自导航到外站
    const onClick = (e: Event) => {
      const el = asElement(e.target)
      if (!el) return
      const retry = el.closest('[data-pc-retry]')
      if (retry) {
        e.preventDefault()
        const index = Number(retry.getAttribute('data-pc-retry'))
        if (Number.isInteger(index)) callbacks.current.onRetryTranslation?.(index)
        return
      }
      const nav = el.closest('[data-pc-nav]')
      if (nav) {
        e.preventDefault()
        const path = nav.getAttribute('data-pc-nav')
        if (path) callbacks.current.onNavigate?.(path)
        return
      }
      const mark = el.closest('mark[data-highlight-id]')
      if (mark) {
        const id = mark.getAttribute('data-highlight-id')
        if (id) callbacks.current.onMarkClick?.(id)
        // 不 preventDefault：HighlightActions 在冒泡阶段还要收到这次 click
      }
      const a = el.closest('a[href]')
      if (!a) return
      e.preventDefault()
      const action = pickLinkAction(a, header.finalUrl)
      if (action.kind === 'fragment') {
        const target = doc.getElementById(action.id) ?? doc.querySelector(`a[name="${cssEscape(action.id)}"]`)
        if (target) scrollMainTo(target, 'smooth')
      } else if (action.kind === 'external') {
        window.open(action.href, '_blank', 'noopener')
      }
    }
    doc.addEventListener('click', onClick, true)

    const source: SelectionSource = {
      doc,
      container: doc.body,
      offset: () => {
        const r = iframe.getBoundingClientRect()
        return { x: r.left + iframe.clientLeft, y: r.top + iframe.clientTop }
      },
    }
    boundRef.current = {
      doc,
      win,
      cleanup: () => {
        ro.disconnect()
        doc.removeEventListener('click', onClick, true)
        callbacks.current.onSelectionSource?.(null)
      },
    }
    setDocTick((t) => t + 1)
    callbacks.current.onSelectionSource?.(source)
    callbacks.current.onReady?.(api)
  }, [decoded, api, scrollMainTo])

  /**
   * 绑定时机：文档**解析完毕**即可，不等 `load`。
   *
   * `load` 要等文档里所有子资源落地——快照里只要留下一个够不着的远程资源（站点自己的字体
   * CDN 打不通就够了），readyState 会永远停在 `interactive`，load 永不触发，整个阅读器卡死在
   * 「正在渲染网页原貌…」：高度停在占位的 60vh 把正文裁掉，译文/高亮/可见块也全都绑不上。
   * 轮询而不用 rAF：后台标签页里 rAF 会被挂起，同一份快照在别的 tab 打开就永远不绑。
   */
  useEffect(() => {
    if (srcdoc === null) return
    let timer = 0
    const tick = (): void => {
      const doc = iframeRef.current?.contentDocument
      // readyState 过了 loading 才算解析完；样式在则说明这是我们写进去的那份文档（不是首载的 about:blank）
      if (doc && doc.readyState !== 'loading' && doc.getElementById(READER_STYLE_ID)) {
        handleLoad()
        if (boundRef.current?.doc === doc) return
      }
      timer = window.setTimeout(tick, BIND_POLL_MS)
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [srcdoc, handleLoad])

  // 卸载：解绑文档（RO / 点击拦截 / 选区源注销）
  useEffect(
    () => () => {
      boundRef.current?.cleanup()
      boundRef.current = null
    },
    [],
  )

  // 译文三态 + 高亮：顺序固定（译文重建会丢 mark，高亮永远在译文之后重放）
  useEffect(() => {
    const bound = boundRef.current
    if (!bound || docTick === 0) return
    applyLangState(bound.doc, blocks, {
      langMode,
      translations,
      failed: failedTranslations,
      authIssue: translationAuthIssue,
    })
    applyHighlights(bound.doc, highlights ?? EMPTY_HIGHLIGHTS)
  }, [docTick, blocks, langMode, translations, failedTranslations, translationAuthIssue, highlights])

  // 当前块：只统计「视口上 1/4 区域」内的块，顶边内缩 CURRENT_PAGE_EPSILON（语义同 BlockReader）
  useEffect(() => {
    const bound = boundRef.current
    if (!bound || docTick === 0 || !blocks.length) return
    const visible = new Set<number>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = Number(e.target.getAttribute('data-block-index'))
          if (Number.isNaN(i)) continue
          if (e.isIntersecting) visible.add(i)
          else visible.delete(i)
        }
        if (visible.size) onVisibleBlock(Math.min(...visible))
      },
      { rootMargin: `-${CURRENT_PAGE_EPSILON}px 0px -75% 0px`, threshold: 0 },
    )
    for (const el of bound.doc.querySelectorAll('[data-pc-block]')) io.observe(el)
    return () => io.disconnect()
  }, [docTick, blocks.length, onVisibleBlock])

  // 第二观察器：全视口可见块区间（语音陪读用）；onVisibleRange 缺省时完全不建
  useEffect(() => {
    const bound = boundRef.current
    if (!bound || docTick === 0 || !blocks.length || !onVisibleRange) return
    const visible = new Set<number>()
    let last: { min: number; max: number } | null = null
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = Number(e.target.getAttribute('data-block-index'))
          if (Number.isNaN(i)) continue
          if (e.isIntersecting) visible.add(i)
          else visible.delete(i)
        }
        if (!visible.size) return
        const next = { min: Math.min(...visible), max: Math.max(...visible) }
        if (last && last.min === next.min && last.max === next.max) return
        last = next
        onVisibleRange(next)
      },
      { threshold: 0 },
    )
    for (const el of bound.doc.querySelectorAll('[data-pc-block]')) io.observe(el)
    return () => io.disconnect()
  }, [docTick, blocks.length, onVisibleRange])

  if ('error' in decoded) {
    return (
      <div className="m-4 rounded-lg border border-bad/40 p-4 text-sm text-bad">
        <p>网页原貌快照无法解析：{decoded.error}</p>
        <p className="mt-2 text-dim">可切换到「文本视图」阅读，或在论文库用「重新导入（网页原貌）」重建快照。</p>
      </div>
    )
  }

  return (
    <>
      {docTick === 0 && <p className="p-4 text-sm text-dim">正在渲染网页原貌…</p>}
      <iframe
        ref={iframeRef}
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        scrolling="no"
        title="网页原貌"
        srcDoc={srcdoc ?? undefined}
        onLoad={handleLoad}
        className="block w-full border-0 bg-white"
      />
    </>
  )
}
