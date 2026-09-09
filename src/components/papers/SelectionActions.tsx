import { useEffect, useRef, useState, type RefObject } from 'react'
import { PAPER_ASK_ACTIONS, type PaperAskAction } from '../../pages/papers/paperUiStore'
import type { SourceAnchor } from '../../lib/paper/types'

/**
 * Paper 工作区的选区快捷条（§3.3）。
 *
 * 与全局 `SelectionAsk` 的关系：`/papers` 路由下全局 Ask 已按 pathname 早退，
 * 论文选区由本组件独占接管。定位思路（getBoundingClientRect + 上方空间不足则翻到下方）
 * 参考了 SelectionAsk，但代码独立在 papers 组件内，互不影响。
 *
 * 三种阅读视图都能用：文本视图的锚点来自块元素的 `data-block-index`，
 * 原版 PDF 的锚点来自页容器的 `data-page`（文字层 span 的最近祖先），
 * 网页原貌视图的选区发生在 **iframe 文档**里——那里的事件不会冒泡到父 document，
 * 所以监听按「选区源」逐文档挂（`getSources`），矩形再加上 iframe 在父视口里的偏移。
 */

/** 一个可划选的文档：父文档的阅读列，或快照 iframe 的文档 */
export interface SelectionSource {
  doc: Document
  /** 只有容器内的选区才弹出快捷条 */
  container: HTMLElement
  /** 该文档视口坐标 → 父视口坐标的平移（父文档为 0；iframe 为其 getBoundingClientRect 左上角） */
  offset: () => { x: number; y: number }
}

interface Props {
  /** 阅读区容器：只有容器内的选区才弹出快捷条（getSources 缺省时的唯一选区源） */
  containerRef: RefObject<HTMLElement | null>
  /** 由工作台注入：从选区所在元素解析出锚点（需要 anchorContext，故不在本组件内做） */
  anchorFromElement: (el: Element) => SourceAnchor | null
  /** opts.translated：选区起点落在应用内译文（[data-translated]）里 */
  onAction: (action: PaperAskAction, text: string, anchor: SourceAnchor | null, opts: { translated: boolean }) => void
  /** 有值才渲染「高亮」按钮（文本视图 / 网页原貌传入——原版 PDF 锚点只到页，不支持高亮） */
  onHighlight?: (range: Range) => void
  /**
   * 选区源列表；缺省 = `[{doc: document, container: containerRef.current}]`。
   * 监听器挂在每个源的 doc 上，函数**引用变化**时重挂（工作台用 useCallback 绑定 iframe 源的状态）。
   */
  getSources?: () => SelectionSource[]
}

interface BarState {
  x: number
  y: number
  text: string
  anchor: SourceAnchor | null
  /** 选区起点是否在译文元素内（Copilot 侧据此提示「以原文语义为准」） */
  translated: boolean
  /** 选区快照（cloneRange）：点按钮时 selection 可能已塌陷，高亮捕获只能靠它 */
  range: Range
  /** 选区所在文档：只有这个文档的 selectionchange 才能关掉快捷条 */
  doc: Document
}

const BAR_WIDTH = 400
const ZERO = () => ({ x: 0, y: 0 })

export default function SelectionActions({ containerRef, anchorFromElement, onAction, onHighlight, getSources }: Props) {
  const [bar, setBar] = useState<BarState | null>(null)
  // 容器 ref 在渲染期同步进来：选区 effect 不因父组件重渲染就重挂监听
  const containerRefRef = useRef(containerRef)
  containerRefRef.current = containerRef
  const anchorFnRef = useRef(anchorFromElement)
  anchorFnRef.current = anchorFromElement
  const getSourcesRef = useRef(getSources)
  getSourcesRef.current = getSources
  /** 快捷条当前所属文档（事件回调里读，不进依赖） */
  const barDocRef = useRef<Document | null>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const clear = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
    const open = (state: BarState) => {
      barDocRef.current = state.doc
      setBar(state)
    }
    const close = () => {
      barDocRef.current = null
      setBar(null)
    }
    const resolveSources = (): SelectionSource[] => {
      const custom = getSourcesRef.current?.()
      if (custom) return custom
      const box = containerRefRef.current.current
      return box ? [{ doc: document, container: box, offset: ZERO }] : []
    }
    const sourceFor = (doc: Document): SelectionSource | undefined => resolveSources().find((s) => s.doc === doc)

    // 按 nodeType 判定而非 instanceof：iframe 文档的节点属于另一个 realm，父窗口的 Element 认不出
    const asElement = (node: EventTarget | Node | null): Element | null => {
      const n = node as Node | null
      if (!n || typeof n.nodeType !== 'number') return null
      return n.nodeType === 1 ? (n as Element) : (n.parentElement ?? null)
    }
    const inOwnUi = (node: EventTarget | Node | null): boolean =>
      asElement(node)?.closest('[data-paper-selection-ui]') != null

    const onPointerUp = (e: Event) => {
      clear()
      const doc = e.currentTarget as Document
      const src = sourceFor(doc)
      if (!src) return
      if (inOwnUi(e.target)) return
      const target = asElement(e.target)
      if (!target || !src.container.contains(target)) {
        // 容器外的点按（页头、目录栏、iframe 边距）：关掉现有快捷条，而不是当没看见
        if (barDocRef.current) close()
        return
      }
      // 延后一拍读选区：pointerup 当帧 selection 可能还是旧值
      timer = setTimeout(() => {
        timer = null
        const sel = doc.getSelection()
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
        const text = sel.toString().trim()
        if (text.length < 2) return
        const anchorEl = asElement(sel.anchorNode)
        if (!anchorEl || !src.container.contains(anchorEl)) return

        const range = sel.getRangeAt(0)
        const r = range.getBoundingClientRect()
        const off = src.offset()
        const top = r.top + off.y
        const x = Math.min(Math.max(r.left + off.x + r.width / 2 - BAR_WIDTH / 2, 8), window.innerWidth - BAR_WIDTH - 8)
        // 钳进视口：快照 iframe 里程序化/跨屏的选区矩形可能落在视口之外，浮层至少要可点
        const y = Math.min(Math.max(top > 108 ? top - 44 : r.bottom + off.y + 10, 8), window.innerHeight - 48)
        // 以选区起点判定「引用的是译文」：跨原文/译文的混合选区按起点归类（精确切分不值得）
        const translated = anchorEl.closest('[data-translated]') != null
        open({ x, y, text, anchor: anchorFnRef.current(anchorEl), translated, range: range.cloneRange(), doc })
      }, 0)
    }

    const onSelectionChange = (e: Event) => {
      const doc = e.currentTarget as Document
      // 别的文档（父文档 vs iframe）的选区变化与本快捷条无关：点进 iframe 时父文档选区先塌陷
      if (barDocRef.current && barDocRef.current !== doc) return
      const sel = doc.getSelection()
      if (!sel || sel.isCollapsed || sel.toString().trim() === '') {
        clear()
        close()
      }
    }
    const onScroll = (e: Event) => {
      if (inOwnUi(e.target)) return
      clear()
      close()
    }
    const onKeyDown = (e: Event) => {
      if ((e as KeyboardEvent).key === 'Escape') close()
    }
    // 快捷条挂在 iframe 选区上时，父文档里的点按（目录栏、Copilot 面板、页头）既不会让 iframe 的
    // 选区塌陷（同源 iframe 的选区在焦点移走后仍保留，selectionchange 不触发），也不经过上面按源
    // 分发的 pointerup——父文档按下即关；只放过快捷条自己的按钮（它们 preventDefault 保选区）
    const onParentPointerDown = (e: Event) => {
      if (!barDocRef.current || barDocRef.current === document) return
      if (inOwnUi(e.target)) return
      clear()
      close()
    }

    // 父文档永远在列（默认源），其余文档来自 getSources；同一文档只挂一次
    const docs = new Set<Document>([document, ...resolveSources().map((s) => s.doc)])
    for (const doc of docs) {
      doc.addEventListener('pointerup', onPointerUp)
      doc.addEventListener('selectionchange', onSelectionChange)
      doc.addEventListener('keydown', onKeyDown)
    }
    document.addEventListener('pointerdown', onParentPointerDown, { capture: true })
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      clear()
      for (const doc of docs) {
        doc.removeEventListener('pointerup', onPointerUp)
        doc.removeEventListener('selectionchange', onSelectionChange)
        doc.removeEventListener('keydown', onKeyDown)
      }
      document.removeEventListener('pointerdown', onParentPointerDown, { capture: true })
      window.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [getSources])

  if (!bar) return null

  return (
    <div
      data-paper-selection-ui=""
      style={{ left: bar.x, top: bar.y, width: BAR_WIDTH }}
      className="fixed z-50 flex gap-1 rounded-lg border border-line bg-panel p-1 shadow-md"
    >
      {PAPER_ASK_ACTIONS.map((a) => (
        <button
          key={a.id}
          type="button"
          // 防止按下时选区塌陷 / 抢焦点
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            onAction(a.id, bar.text, bar.anchor, { translated: bar.translated })
            setBar(null)
          }}
          className="flex-1 rounded-md px-2 py-1 text-xs whitespace-nowrap text-accent transition-colors hover:bg-panel-2"
        >
          {a.label}
        </button>
      ))}
      {onHighlight && (
        <button
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            onHighlight(bar.range)
            setBar(null)
          }}
          className="flex-1 rounded-md px-2 py-1 text-xs whitespace-nowrap text-accent transition-colors hover:bg-panel-2"
        >
          高亮
        </button>
      )}
    </div>
  )
}
