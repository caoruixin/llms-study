import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import katexCssUrl from 'katex/dist/katex.min.css?url'
import type { LlmAuthCode } from '../../lib/llmClient'
import { READER_ALIGN_MARGIN, readerScrollTop } from '../../lib/paper/anchors'
import type { LangMode, PaperBlock, PaperHighlight } from '../../lib/paper/types'
import { decodeWebSnapshot, type WebSnapshotHeader } from '../../lib/paper/url/webSnapshot'
import { flashElement } from './ReaderContext'
import type { SelectionSource } from './SelectionActions'
import {
  ANCHOR_EPSILON_PX,
  READER_STYLE_ID,
  SMOOTH_PROGRESS_START,
  SNAPSHOT_BAND_INSET,
  anchorRestoreTarget,
  applyHighlights,
  applyLangState,
  buildReaderSrcdoc,
  classifyScroll,
  currentBlockRootMargin,
  docSpanOf,
  findScrollAnchor,
  hostRectInParent,
  inheritIdealScrollTop,
  paneSpanInFrame,
  pickLinkAction,
  resolveIdealScrollTop,
  runAnchoredMutation,
  sharedRecordVerdict,
  shouldHoldMutation,
  smoothStartsInPlace,
  stampScrollers,
  syncFrameHeight,
  trackSmoothProgress,
  wheelScrollTarget,
  type AnchorState,
  type FrameCoupling,
  type FrameHeightIO,
  type IdealScroll,
  type SmoothProgress,
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
 * 祖先链 main 的 overflow 裁剪已计入交集。语义照 BlockReader，但 rootMargin 不能照抄：那边的
 * root 是 main，这边是浏览器视口，「当前块」的观察带要按 main 的实时几何换算（currentBlockRootMargin）。
 *
 * 滚动锚定（PLAN-snapshot-scroll-anchoring.md §2.1）：原生 scroll anchoring 看不进 iframe，视口上方的内容一变高
 * 正在读的内容就被整体推走，所以自己锚（规则见 pickScrollAnchor）。A 为主：改 DOM 的地方同步包一层
 * （withScrollAnchor）；B 兜底：iframe 的 RO 回调里按「静止时」记下的锚点补偿非本组件引起的重排。两路共用一份记录。
 * 用户的原生滚动（触摸惯性、键盘翻页、WebKit 的滚轮）由浏览器的滚动线程驱动，途中写 scrollTop 会被它覆盖，
 * 所以滚动进行中的改动先暂缓，停稳再带着锚定一起落。判定全在 snapshotDom.ts 的纯函数里，这里只接线。
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
  /** 按内容同步 iframe 高度（判定与编排见 syncFrameHeight）；锚定包裹里改完 DOM 同步调用 */
  syncHeight: () => void
  cleanup: () => void
}

/**
 * 锚点记录：A 改 DOM 前现量一份；共享的那份（anchorRef）供 B 用。
 * docTop / offsetTop / contained / ideal 的含义见 AnchorState，scrollTop / ideal 见 IdealScroll。
 */
interface ScrollAnchor extends AnchorState, IdealScroll {
  /** 锚点块（iframe 文档里的宿主元素） */
  el: Element
}

/** 平滑跳转进行中（scrollMainTo(el,'smooth')：目录跳转、页内锚点链接） */
interface SmoothJump {
  el: Element
  /** performance.now() 超过它一律视为已结束 */
  deadline: number
  /** 当前瞄准的 scrollTop（发起时记下，重新瞄准时更新） */
  target: number
  /** 逼近进度：判定用户是否已接管滚动（见 trackSmoothProgress） */
  progress: SmoothProgress
}

/** 原生滚动进行中被暂缓的那次 DOM 改动（永远只留最新一次）与它开始等待的时刻 */
interface PendingMutation {
  mutate: () => void
  since: number
}

/** iframe 高度上限：防御未知的高度回环（vh 已在水合时钉死，正常文档远达不到） */
const MAX_HEIGHT_PX = 400_000
/** 等文档解析就绪的轮询间隔：只在绑定前跑，绑上即停 */
const BIND_POLL_MS = 50
/** deltaMode=DOM_DELTA_LINE 时一行按多少 px 折算（Chrome/Firefox 的常规行高档位） */
const WHEEL_LINE_PX = 16
/** 滚动静止多久算停稳：重新记录锚点、冲刷暂缓的改动；也是平滑跳转结束的兜底（WebKit 没有 scrollend） */
const SCROLL_IDLE_MS = 150
/** 平滑跳转最长持续：超时一律视为结束 */
const SMOOTH_MAX_MS = 3000
/** 平滑动画「其实已到位」的容差 */
const SMOOTH_ARRIVED_PX = 2
/** 原生滚动之后多久内的 DOM 改动要暂缓（见 shouldHoldMutation）。必须小于 SCROLL_IDLE_MS，否则停稳时的冲刷自己也会被暂缓 */
const NATIVE_SCROLL_HOLD_MS = 120
/** 暂缓的上限：连续滚动（按住方向键、自动滚屏、拖着滚动条不放）一直不停稳时，等到这么久就不再等，照常带锚定应用 */
const NATIVE_HOLD_MAX_MS = 3000
/** main 上意味着用户接管滚动的输入（滚动条拖动、键盘、触摸、滚轮）：平滑跳转就此结束 */
const USER_SCROLL_INPUTS = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const
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
  /** 「当前块」观察器的 rootMargin（按 main 的实时几何换算）；null = main 不可见，不建观察器 */
  const [bandMargin, setBandMargin] = useState<string | null>(null)

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

  // ---------------------------------------------------------------------------
  // 滚动锚定（A/B 共用的状态与帮手；全部走 ref，回调引用恒定。怎么判定都在 snapshotDom.ts 的纯函数里，这里只读 DOM / 写 scrollTop）
  // ---------------------------------------------------------------------------

  /**
   * 共享锚点记录（B 用）。写入：A 结束时、B 补偿后、瞬时的程序化对齐之后（scrollMainTo 非 smooth）、
   * 滚动静止 SCROLL_IDLE_MS 后、平滑跳转的 scrollend 时；
   * 作废：main 的 scrollTop 与记录差 ≥1px（用户滚动、平滑跳转）——自己写 scrollTop 引起的 scroll 事件值与记录一致，不作废。
   */
  const anchorRef = useRef<ScrollAnchor | null>(null)
  /** 平滑跳转进行中：期间有改动不写 scrollTop（会打断动画、落点偏掉），改为按新布局对同一元素重新瞄准 */
  const smoothRef = useRef<SmoothJump | null>(null)
  /** 滚动静止计时器（main 的每个 scroll 事件重置） */
  const idleTimerRef = useRef(0)
  /** 组件自己最后一次写 main.scrollTop 后读回的值：scroll 事件里据此认出「这是自己滚的」（见 classifyScroll） */
  const ownWriteRef = useRef<number | null>(null)
  /** 最近一次原生滚动（不是平滑跳转、不是自己写的）的时刻，performance.now() */
  const nativeAtRef = useRef(Number.NEGATIVE_INFINITY)
  /** 原生滚动进行中被暂缓的 DOM 改动：后来的覆盖先来的（每次改动都是按最新状态全量应用），停稳时冲刷 */
  const pendingRef = useRef<PendingMutation | null>(null)

  /** 阅读窗格可见且 iframe 有布局时返回三件套；专注陪读下 main 是 display:none，此时不量、不补偿 */
  const paneOf = useCallback(() => {
    const main = containerRef.current
    const iframe = iframeRef.current
    const bound = boundRef.current
    if (!main || !iframe || !bound || main.clientHeight === 0 || iframe.getClientRects().length === 0) return null
    return { main, iframe, bound }
  }, [containerRef])

  /** 自己瞬时写 main.scrollTop 的入口：记下读回值（可能被取整 / 钳位），随后那次 scroll 事件不会被当成用户的原生滚动 */
  const writeScrollTop = useCallback((main: HTMLElement, top: number): number => {
    main.scrollTop = top
    const actual = main.scrollTop
    ownWriteRef.current = actual
    return actual
  }, [])

  /**
   * 现选锚点（规则见 pickScrollAnchor），记下它的文档坐标顶边、离窗格顶的偏移与 main.scrollTop。
   * 理想 scrollTop 在共享记录仍新鲜时沿用它的（见 inheritIdealScrollTop），所以先把共享记录指向谁、再调这里，新记录就继承谁。
   */
  const captureAnchor = useCallback((): ScrollAnchor | null => {
    const pane = paneOf()
    if (!pane) return null
    const { main, iframe, bound } = pane
    const scrollY = bound.win.scrollY || 0
    const paneSpan = paneSpanInFrame(main, iframe, scrollY)
    const hit = findScrollAnchor(bound.doc, paneSpan, scrollY)
    if (!hit) return null
    const scrollTop = main.scrollTop
    return {
      el: hit.el,
      docTop: hit.top,
      offsetTop: hit.top - paneSpan.top,
      contained: hit.contained,
      scrollTop,
      ideal: inheritIdealScrollTop(scrollTop, anchorRef.current),
    }
  }, [paneOf])

  /** 程序化对齐到 `top` 之后记录锚点：理想值取对齐目标本身（读回被取整也不丢小数） */
  const captureAligned = useCallback(
    (top: number): ScrollAnchor | null => {
      const rec = captureAnchor()
      if (rec) rec.ideal = resolveIdealScrollTop(top, rec.scrollTop)
      return rec
    },
    [captureAnchor],
  )

  /** 按记录补偿（写多少见 anchorRestoreTarget：锚点位移 + 塌缩重对齐，按未取整的理想值累计），并让记录跟上写入后的实际状态 */
  const restoreAnchor = useCallback(
    (a: ScrollAnchor): void => {
      const pane = paneOf()
      if (!pane || !a.el.isConnected || a.el.ownerDocument !== pane.bound.doc) return
      const span = docSpanOf(a.el, pane.bound.win.scrollY || 0)
      if (!span) return
      const target = anchorRestoreTarget(a, span)
      if (!target) return
      // 读回值可能被取整（WebKit）或钳位：随后这次写入引起的 scroll 事件值与记录一致，不会把记录当成过期
      a.scrollTop = writeScrollTop(pane.main, target.top)
      a.ideal = resolveIdealScrollTop(target.top, a.scrollTop)
      a.docTop = span.top
      if (target.realigned) a.offsetTop = READER_ALIGN_MARGIN
    },
    [paneOf, writeScrollTop],
  )

  /** 进行中的平滑跳转；超时或目标已断开即清掉 */
  const activeSmooth = useCallback((): SmoothJump | null => {
    const s = smoothRef.current
    if (s && (performance.now() > s.deadline || !s.el.isConnected)) smoothRef.current = null
    return smoothRef.current
  }, [])

  /** 元素对齐到 main 视口顶边（scroll-mt 口径）时 main 应有的 scrollTop，与工作台 scrollReaderTo 同一公式 */
  const alignedScrollTop = useCallback(
    (el: Element): number | null => {
      const main = containerRef.current
      const iframe = iframeRef.current
      if (!main || !iframe) return null
      const rect = hostRectInParent(iframe, el)
      const viewportTop = main.getBoundingClientRect().top + main.clientTop
      return readerScrollTop(main.scrollTop, rect.top, viewportTop)
    },
    [containerRef],
  )

  /**
   * 按共享记录把「上次记录之后、还没补偿的外部重排」补掉，返回是否按它补过（判定见 sharedRecordVerdict：没有记录、
   * 记录之后滚动过、平滑跳转进行中都不补；过期的记录就地作废）。B 的 RO 回调与 A 现量锚点之前共用这一个帮手——
   * A 为什么也要先走一遍，见 runAnchoredMutation。
   * 先同步高度再补：外部重排可能让文档变高而 iframe 还没跟上，直接写 scrollTop 会被钳位。
   */
  const compensateFromRecord = useCallback((): boolean => {
    const rec = anchorRef.current
    const main = containerRef.current
    // 新鲜与否要在同步高度之前看：同步时 iframe 变矮，浏览器可能钳位 scrollTop
    const verdict = sharedRecordVerdict(rec, main ? main.scrollTop : null, activeSmooth() !== null)
    if (verdict === 'stale') anchorRef.current = null
    if (verdict !== 'use' || !rec) return false
    boundRef.current?.syncHeight()
    restoreAnchor(rec)
    return true
  }, [containerRef, activeSmooth, restoreAnchor])

  /**
   * A 的本体：先把还没轮到 B 处理的外部重排补掉，再现选锚点，改完同步高度、按锚点位移补 main.scrollTop
   * （顺序见 runAnchoredMutation），全在同一个任务里完成——用户看不到中间帧，IntersectionObserver 也只看到补偿后的布局
   * （当前块不变）。滚轮转发桥在 wheel 事件里同步写 scrollTop，这里在另一个任务里现量现补，两者加法叠加，不抖。
   *
   * 平滑跳转进行中不写 scrollTop：按旧布局/新布局各算一次目标的对齐位置，变了就对同一元素重新瞄准——
   * 动画其实已到位就瞬时对齐（免得再动画一小段），否则重新发起平滑滚动。
   */
  const applyAnchored = useCallback(
    (mutate: () => void) => {
      const smooth = activeSmooth()
      if (!smooth) {
        runAnchoredMutation<ScrollAnchor>({
          compensatePending: compensateFromRecord,
          capture: captureAnchor,
          mutate,
          syncHeight: () => boundRef.current?.syncHeight(),
          restore: restoreAnchor,
          commit: (anchor) => {
            // 先把共享记录指向刚补偿过的这条，重新记录时才继承它未取整的理想值
            if (anchor) anchorRef.current = anchor
            anchorRef.current = captureAnchor()
          },
        })
        return
      }
      const main = containerRef.current
      const targetBefore = alignedScrollTop(smooth.el)
      const scrollBefore = main?.scrollTop ?? 0
      const maxBefore = main ? main.scrollHeight - main.clientHeight : 0
      mutate()
      boundRef.current?.syncHeight()
      const targetAfter = alignedScrollTop(smooth.el)
      if (main && targetBefore !== null && targetAfter !== null && Math.abs(targetAfter - targetBefore) >= ANCHOR_EPSILON_PX) {
        const arrived = Math.abs(scrollBefore - Math.min(targetBefore, maxBefore)) < SMOOTH_ARRIVED_PX
        // 自己重新瞄准：目标变了，逼近进度从头量——别把「离旧目标变远」误判成用户接管
        smooth.target = targetAfter
        smooth.progress = SMOOTH_PROGRESS_START
        main.scrollTo({ top: targetAfter, behavior: arrived ? 'auto' : 'smooth' })
        if (arrived) ownWriteRef.current = main.scrollTop
      }
      anchorRef.current = captureAnchor()
    },
    [containerRef, activeSmooth, compensateFromRecord, captureAnchor, alignedScrollTop, restoreAnchor],
  )

  /**
   * A 的入口：改 iframe 文档 DOM 的地方一律经过这里。用户的原生滚动刚发生过就先不改（见 shouldHoldMutation），
   * 把这次改动存起来——后来的覆盖先来的——等停稳（settleScroll）再带着锚定一起落；否则立即走 applyAnchored。
   * 滚轮转发桥写的 scrollTop 算自己的，不触发暂缓（Chromium 的滚轮中落地照旧加法叠加）。
   */
  const withScrollAnchor = useCallback(
    (mutate: () => void) => {
      const now = performance.now()
      const hold = shouldHoldMutation({
        smooth: activeSmooth() !== null,
        paneVisible: paneOf() !== null,
        sinceNativeMs: now - nativeAtRef.current,
        holdMs: NATIVE_SCROLL_HOLD_MS,
      })
      if (hold) {
        pendingRef.current = { mutate, since: pendingRef.current?.since ?? now }
        return
      }
      pendingRef.current = null
      applyAnchored(mutate)
    },
    [activeSmooth, paneOf, applyAnchored],
  )

  /**
   * 滚动停稳（静止 SCROLL_IDLE_MS，或平滑跳转的 scrollend）：平滑跳转视为结束，按停稳后的位置重新记录锚点
   * （刚结束的是平滑跳转时，理想值取它瞄准的位置），再把滚动期间暂缓的改动冲刷掉。
   *
   * 重新记录之前，旧记录还新鲜就先按它把待处理的外部重排补掉（compensateFromRecord，道理同 runAnchoredMutation 的第一步）：
   * 自己补偿写入 scrollTop 之后也会走到这里，字体恰好在这一刻换上的话，直接现量就把那次位移当成既成事实吸收了，
   * 随后到来的 B 位移为 0（实测字体冷加载的重开：第一次重排补上了，150ms 后的第二次 15px 就这样丢了）。
   * 用户滚动过的记录已经作废，那种情况只能按现状重记。
   */
  const settleScroll = useCallback(() => {
    window.clearTimeout(idleTimerRef.current)
    idleTimerRef.current = 0
    const smooth = smoothRef.current
    smoothRef.current = null
    if (smooth) {
      anchorRef.current = captureAligned(smooth.target)
    } else {
      compensateFromRecord()
      anchorRef.current = captureAnchor()
    }
    const pending = pendingRef.current
    if (pending) {
      pendingRef.current = null
      applyAnchored(pending.mutate)
    }
  }, [captureAnchor, captureAligned, compensateFromRecord, applyAnchored])

  /**
   * （重新）起静止计时。到点时位置和起计时那一刻不一样，说明滚动其实还在走——主线程卡住、scroll 事件还没派发——
   * 这时不算停稳，接着计时：否则一次长任务就能把进行中的平滑跳转判成结束。
   */
  const armIdleTimer = useCallback(() => {
    const arm = (): void => {
      const base = containerRef.current?.scrollTop ?? 0
      idleTimerRef.current = window.setTimeout(() => {
        const main = containerRef.current
        if (main && Math.abs(main.scrollTop - base) >= 1) arm()
        else settleScroll()
      }, SCROLL_IDLE_MS)
    }
    window.clearTimeout(idleTimerRef.current)
    arm()
  }, [containerRef, settleScroll])

  /** 把 iframe 里的元素滚到 main 视口顶边（scroll-mt 口径）；平滑滚动记下目标，期间的改动按它重新瞄准 */
  const scrollMainTo = useCallback(
    (el: Element, behavior: ScrollBehavior) => {
      const main = containerRef.current
      const top = alignedScrollTop(el)
      if (!main || top === null) return
      if (behavior === 'smooth') {
        const inPlace = smoothStartsInPlace(top, main.scrollTop, main.scrollHeight - main.clientHeight)
        smoothRef.current = { el, deadline: performance.now() + SMOOTH_MAX_MS, target: top, progress: SMOOTH_PROGRESS_START }
        main.scrollTo({ top, behavior })
        // 静止计时只在目标已在原位时从发起就起（不会有 scroll 事件，得靠它结束跳转）；否则等第一个 scroll 事件来起，
        // 连先前滚动留下的那个计时也撤掉——见 smoothStartsInPlace：发起后主线程一卡，计时器会抢在动画前把跳转判成结束。
        // 这期间只留时长上限兜底：万一始终没有 scroll 事件（窗格其实不可见等），到点照样收尾（结束跳转、冲刷暂缓的改动）
        window.clearTimeout(idleTimerRef.current)
        if (inPlace) armIdleTimer()
        else idleTimerRef.current = window.setTimeout(settleScroll, SMOOTH_MAX_MS)
      } else {
        smoothRef.current = null
        main.scrollTo({ top, behavior })
        ownWriteRef.current = main.scrollTop
        // 瞬时的程序化对齐（续读对齐、切视图）没有手势在进行：按新位置立即记下锚点。随后的 scroll 事件值与记录一致，
        // 不会作废；否则要等静止 SCROLL_IDLE_MS 才重新记录，字体换上、图片解码恰好落在这段空当里，B 就补不上
        anchorRef.current = captureAligned(top)
      }
    },
    [containerRef, alignedScrollTop, armIdleTimer, settleScroll, captureAligned],
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
    // 换了文档：旧文档里的锚点、跳转目标与暂缓的改动全部作废
    anchorRef.current = null
    smoothRef.current = null
    pendingRef.current = null
    // srcdoc 赋值前的 about:blank 首载：没有阅读器样式就不是我们的文档
    if (!doc.getElementById(READER_STYLE_ID) || !doc.body) return
    const header = 'error' in decoded ? null : decoded.header
    if (!header) return

    /**
     * 高度同步（判定与编排见 syncFrameHeight）：html.scrollHeight 含绝对定位溢出，但不小于 iframe 当前视口高，只能当下限；
     * 内容装得下时先降到流内高度再量一次，溢出的绝对定位版式这时才看得出来。内容尺寸跟着视口走的文档另按耦合模式同步，
     * 不再追高。一次同步里的几次量 / 写都在同一个任务里，没有中间帧。
     */
    let lastHeight = 0
    const frameIO: FrameHeightIO = {
      measure: () => {
        const root = doc.documentElement
        return {
          inFlow: Math.ceil(Math.max(root.getBoundingClientRect().height, doc.body?.scrollHeight ?? 0)),
          scroll: root.scrollHeight,
          view: root.clientHeight,
        }
      },
      write: (h) => {
        const next = Math.min(Math.ceil(h), MAX_HEIGHT_PX)
        if (next && Math.abs(next - lastHeight) >= 1) {
          lastHeight = next
          iframe.style.height = `${next}px`
        }
        return lastHeight
      },
    }
    /** 这份文档的内容尺寸跟着视口走的量（见 FrameCoupling）；探到之后一直按耦合模式同步 */
    let coupling: FrameCoupling | null = null
    /** 隐藏期间跳过过同步：重新显示时由下面的 hostRo 补一次 */
    let skippedHidden = false
    const syncHeight = () => {
      if (!doc.documentElement) return
      // 没有布局（专注陪读下 main 是 display:none）：量出来是 0 或旧值（Chromium），跳过，保留上次的好高度
      const main = containerRef.current
      if (iframe.getClientRects().length === 0 || (main && main.clientHeight === 0)) {
        skippedHidden = true
        return
      }
      skippedHidden = false
      const keep = main?.scrollTop
      coupling = syncFrameHeight(frameIO, coupling)
      // 同步高度不该挪动阅读位置。绝对定位溢出撑着高度时（scrollHeight 恰等于视口高），稳态下每次都要先降再升，中间那次降高
      // 可能让浏览器把 main 的 scrollTop 钳位（读到底部附近时）：量完放回原值——最终高度装得下就原样复位，装不下浏览器会
      // 再钳一次，与真变矮时一致。平滑跳转进行中不写（会打断动画；动画下一帧自己会按目标重设位置）
      if (main && keep !== undefined && main.scrollTop !== keep && !smoothRef.current) writeScrollTop(main, keep)
    }
    /**
     * B：静止时兜底——非本组件引起的布局变化（窗口改宽、Copilot 栏开合导致重排、字体/图片/KaTeX 样式晚到）。
     * 共享记录一滚动就作废、停稳（或瞬时的程序化对齐之后）才重新记录，出手前还要核对 scrollTop 自记录以来没动过
     * （程序化滚动刚写过、scroll 事件还没派发时——rAF 里的续读对齐——记录已过期，作废而不是按它去补）；
     * 平滑跳转期间也不出手——所以 B 永远不和用户或平滑动画抢滚动。代价：恰好在滚动中发生的外部重排不补偿，表现与原先相同。
     * 补偿本身与 A 现量之前那一步共用 compensateFromRecord（它自己会先同步高度）；没补也照常同步高度。
     */
    const onFrameResize = () => {
      if (compensateFromRecord()) anchorRef.current = captureAnchor()
      else syncHeight()
    }
    // 用 iframe 自己窗口的 ResizeObserver（观察对象属于那个 realm）；类型上 Window 没有该属性，按 globalThis 取
    const RO = (win as unknown as typeof globalThis).ResizeObserver ?? window.ResizeObserver
    const ro = new RO(onFrameResize)
    ro.observe(doc.documentElement)
    ro.observe(doc.body)
    /**
     * 重新显示时补同步：WebKit 在 main 隐藏期间照样排版 iframe 文档、把新尺寸报给上面的 RO（那次同步被跳过），
     * 重新显示时尺寸没再变，RO 不会再报——高度就停在隐藏前。iframe 元素自己从 0×0 恢复时父窗口的 RO 必报，借它补一次。
     */
    const hostRo =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (skippedHidden) syncHeight()
          })
    hostRo?.observe(iframe)
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

    // 站点自带的内部纵向滚动容器：整篇平铺的快照里它们只会吃掉滚轮，渲染期统一解除（存量快照免重导）
    stampScrollers(doc)

    /**
     * 滚轮转发桥：iframe 自己不滚（`scrolling="no"` + 注入的 `html{overflow:hidden}`），滚轮落在
     * iframe 上时必须**链式传递**出去才能滚到外层 main。而快照里保留着站点自己的 CSS——
     * 例如 `html{overscroll-behavior-y:none}`，它本就是「别把滚动传给宿主页」的专用开关——
     * 链路一断，触摸板/滚轮就整页滚不动，只剩拖 main 的滚动条能用（拖滚动条不经过 iframe 命中测试）。
     *
     * 这里不赌引擎的链式行为，直接把滚轮转发给外层容器；iframe 内还有能滚的祖先则让位给它。
     */
    const onWheel = (e: WheelEvent) => {
      // ctrl+滚轮是捏合缩放，别抢
      if (e.ctrlKey) return
      // 用户滚轮 = 接管滚动：平滑跳转就此结束（之后的改动由锚定现量现补，不再按跳转目标重新瞄准）
      if (e.deltaY) smoothRef.current = null
      // 拦不住原生行为（passive）就别插手，否则会叠成双倍滚动
      if (e.defaultPrevented || !e.cancelable) return
      const container = containerRef.current
      const dy = e.deltaY
      if (!container || !dy) return
      if (wheelScrollTarget(e.target as Node | null, dy, doc.documentElement)) return
      const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? container.clientHeight : 1
      // 经 writeScrollTop 记账：这一格是组件自己写的，不算用户的原生滚动——滚轮中落地的改动不暂缓，照旧与滚轮加法叠加
      writeScrollTop(container, container.scrollTop + dy * unit)
      e.preventDefault()
    }
    doc.addEventListener('wheel', onWheel, { capture: true, passive: false })

    // iframe 覆盖了整个阅读窗格，里面的触摸/按键到不了 main 上的监听：在这里同样视为用户接管滚动。
    // WebKit 不给无脚本沙箱文档派发父窗口挂的监听（滚轮转发桥同样不跑，滚轮走原生链式滚动），那边靠 scroll 事件里的
    // 「离目标反而变远」判定接管（trackSmoothProgress），再有静止计时与时长上限兜底
    const onUserInput = () => {
      smoothRef.current = null
    }
    doc.addEventListener('touchstart', onUserInput, { capture: true, passive: true })
    doc.addEventListener('keydown', onUserInput, { capture: true, passive: true })

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
      syncHeight,
      cleanup: () => {
        ro.disconnect()
        hostRo?.disconnect()
        doc.removeEventListener('click', onClick, true)
        doc.removeEventListener('wheel', onWheel, true)
        doc.removeEventListener('touchstart', onUserInput, true)
        doc.removeEventListener('keydown', onUserInput, true)
        callbacks.current.onSelectionSource?.(null)
      },
    }
    setDocTick((t) => t + 1)
    callbacks.current.onSelectionSource?.(source)
    callbacks.current.onReady?.(api)
  }, [decoded, api, scrollMainTo, containerRef, compensateFromRecord, captureAnchor, writeScrollTop])

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

  /**
   * 共享锚点记录的维护（B 用）、滚动来源的区分与平滑跳转的结束判定，都挂在 main 上：
   * - scroll：scrollTop 与记录差 ≥1px 就作废记录（自己补偿写入的值与记录一致，不作废），并重置静止计时。
   *   同时区分是谁滚的（classifyScroll）：平滑跳转进行中喂一次逼近进度，离目标反而变远就判定用户已接管；
   *   既不是平滑跳转、也不是自己写的，就是用户的原生滚动——记下时刻，随后的 DOM 改动暂缓到停稳（见 withScrollAnchor）；
   * - 静止 SCROLL_IDLE_MS：平滑跳转结束，按停稳后的位置重新记录，冲刷暂缓的改动；
   * - scrollend：只用来结束平滑跳转（顺带记录）。Chromium 对每一次瞬时的程序化滚动都发 scrollend——滚轮转发桥的
   *   每一格都算——拿它当「停稳」，记录会在连续滚轮的两格之间复活，B 就在滚动中出手了。WebKit 没有 scrollend，靠静止计时兜底；
   * - 用户输入（滚动条拖动、键盘、触摸、main 上的滚轮）：平滑跳转结束。iframe 里的滚轮/触摸/按键在 handleLoad 里接。
   */
  useEffect(() => {
    const main = containerRef.current
    if (!main) return
    const onScroll = () => {
      const top = main.scrollTop
      const rec = anchorRef.current
      if (rec && Math.abs(top - rec.scrollTop) >= 1) anchorRef.current = null
      const now = performance.now()
      const smooth = activeSmooth()
      const source = classifyScroll(top, ownWriteRef.current, smooth !== null)
      if (smooth) {
        const { progress, takenOver } = trackSmoothProgress(smooth.progress, Math.abs(top - smooth.target))
        smooth.progress = progress
        if (takenOver) {
          smoothRef.current = null
          nativeAtRef.current = now
        }
      } else if (source === 'native') {
        nativeAtRef.current = now
        // 一直滚、一直不停稳（按住方向键、自动滚屏）：暂缓的改动等够上限就不再等，照常带锚定应用
        const pending = pendingRef.current
        if (pending && now - pending.since > NATIVE_HOLD_MAX_MS) {
          pendingRef.current = null
          applyAnchored(pending.mutate)
        }
      }
      armIdleTimer()
    }
    const onScrollEnd = () => {
      if (smoothRef.current) settleScroll()
    }
    const onUserInput = () => {
      smoothRef.current = null
    }
    main.addEventListener('scroll', onScroll, { passive: true })
    main.addEventListener('scrollend', onScrollEnd)
    for (const type of USER_SCROLL_INPUTS) main.addEventListener(type, onUserInput, { capture: true, passive: true })
    return () => {
      main.removeEventListener('scroll', onScroll)
      main.removeEventListener('scrollend', onScrollEnd)
      for (const type of USER_SCROLL_INPUTS) main.removeEventListener(type, onUserInput, true)
      window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = 0
      // 卸载：暂缓的改动不再落（它闭包里的文档已经解绑）
      pendingRef.current = null
    }
  }, [containerRef, activeSmooth, applyAnchored, armIdleTimer, settleScroll])

  // 译文三态 + 高亮：顺序固定（译文重建会丢 mark，高亮永远在译文之后重放）；外面包一层滚动锚定（A，见 withScrollAnchor）
  useEffect(() => {
    const bound = boundRef.current
    if (!bound || docTick === 0) return
    withScrollAnchor(() => {
      applyLangState(bound.doc, blocks, {
        langMode,
        translations,
        failed: failedTranslations,
        authIssue: translationAuthIssue,
      })
      applyHighlights(bound.doc, highlights ?? EMPTY_HIGHLIGHTS)
    })
  }, [docTick, blocks, langMode, translations, failedTranslations, translationAuthIssue, highlights, withScrollAnchor])

  /**
   * 「当前块」观察带跟着阅读窗格（main）的几何走，否则它会落到 main 之外，当前块就此冻住
   * （见 currentBlockRootMargin）。重算时机：main 改尺寸、窗口改尺寸、任何滚动。main 只挪位置不改尺寸
   * （头部换行把它整体顶下去）时没有事件可挂，带子会旧到下一次滚动才追上——滚动正是需要它准的时候。
   * 带子没变不 setState，滚动零重渲染。
   */
  useEffect(() => {
    const main = containerRef.current
    if (!main) return
    let last: string | null | undefined
    const update = () => {
      const next = currentBlockRootMargin(
        main.getBoundingClientRect().top + main.clientTop,
        main.clientHeight,
        document.documentElement.clientHeight || window.innerHeight,
        SNAPSHOT_BAND_INSET,
      )
      if (next === last) return
      last = next
      setBandMargin(next)
    }
    update()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    ro?.observe(main)
    window.addEventListener('resize', update)
    // capture：scroll 不冒泡。main 自己滚、页面整体滚（main 位置变了而尺寸没变）都从这里过
    window.addEventListener('scroll', update, { capture: true, passive: true })
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
    // docTick：文档绑定后再量一次（首帧 main 可能还没排版完）
  }, [containerRef, docTick])

  // 当前块：只统计「阅读窗格上 1/4 区域」内的块，顶边内缩 SNAPSHOT_BAND_INSET（语义同 BlockReader，内缩更大的原因见常量注释）
  useEffect(() => {
    const bound = boundRef.current
    if (!bound || docTick === 0 || !blocks.length || bandMargin === null) return
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
      { rootMargin: bandMargin, threshold: 0 },
    )
    for (const el of bound.doc.querySelectorAll('[data-pc-block]')) io.observe(el)
    return () => io.disconnect()
  }, [docTick, blocks.length, onVisibleBlock, bandMargin])

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

  /**
   * 加载提示叠在 iframe 顶部，**不占流内高度**。它在「已绑定」那次提交时消失；要是排在 iframe 上方，工作台的续读对齐
   * （两帧 rAF 后 scrollToBlock）一旦抢在这次提交之前，对齐完 iframe 又整体上移一行（52px）——iframe 文档内部没变，
   * 按文档坐标做的锚定看不见这次位移。Chromium 的原生 scroll anchoring 会拿 iframe 元素当锚点补上，WebKit 没有：
   * 实测带缓存重开约 5% 停在 −35.5px。main 里 iframe 上方不能再有任何会变高变矮的流内内容。
   */
  return (
    <div className="relative">
      {docTick === 0 && (
        <p className="pointer-events-none absolute inset-x-0 top-0 p-4 text-sm text-dim">正在渲染网页原貌…</p>
      )}
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
    </div>
  )
}
