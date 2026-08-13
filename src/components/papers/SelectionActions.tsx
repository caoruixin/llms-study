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
 * 两种阅读视图都能用：文本视图的锚点来自块元素的 `data-block-index`，
 * 原版 PDF 的锚点来自页容器的 `data-page`（文字层 span 的最近祖先）。
 */

interface Props {
  /** 阅读区容器：只有容器内的选区才弹出快捷条 */
  containerRef: RefObject<HTMLElement | null>
  /** 由工作台注入：从选区所在元素解析出锚点（需要 anchorContext，故不在本组件内做） */
  anchorFromElement: (el: Element) => SourceAnchor | null
  onAction: (action: PaperAskAction, text: string, anchor: SourceAnchor | null) => void
}

interface BarState {
  x: number
  y: number
  text: string
  anchor: SourceAnchor | null
}

const BAR_WIDTH = 336

export default function SelectionActions({ containerRef, anchorFromElement, onAction }: Props) {
  const [bar, setBar] = useState<BarState | null>(null)
  // 容器 ref 在渲染期同步进来：选区 effect 空依赖，不能因为父组件重渲染就重挂监听
  const containerRefRef = useRef(containerRef)
  containerRefRef.current = containerRef
  const anchorFnRef = useRef(anchorFromElement)
  anchorFnRef.current = anchorFromElement

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const clear = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
    const asElement = (node: EventTarget | Node | null): Element | null =>
      node instanceof Element ? node : node instanceof Node ? node.parentElement : null
    const inOwnUi = (node: EventTarget | Node | null): boolean =>
      asElement(node)?.closest('[data-paper-selection-ui]') != null

    const onPointerUp = (e: PointerEvent) => {
      clear()
      const box = containerRefRef.current.current
      if (!box) return
      if (inOwnUi(e.target)) return
      const target = asElement(e.target)
      if (!target || !box.contains(target)) return
      // 延后一拍读选区：pointerup 当帧 selection 可能还是旧值
      timer = setTimeout(() => {
        timer = null
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
        const text = sel.toString().trim()
        if (text.length < 2) return
        const anchorEl = asElement(sel.anchorNode)
        if (!anchorEl || !box.contains(anchorEl)) return

        const r = sel.getRangeAt(0).getBoundingClientRect()
        const x = Math.min(Math.max(r.left + r.width / 2 - BAR_WIDTH / 2, 8), window.innerWidth - BAR_WIDTH - 8)
        const y = r.top > 108 ? r.top - 44 : r.bottom + 10
        setBar({ x, y, text, anchor: anchorFnRef.current(anchorEl) })
      }, 0)
    }

    const onSelectionChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.toString().trim() === '') {
        clear()
        setBar(null)
      }
    }
    const onScroll = (e: Event) => {
      if (inOwnUi(e.target)) return
      clear()
      setBar(null)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBar(null)
    }

    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      clear()
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [])

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
            onAction(a.id, bar.text, bar.anchor)
            setBar(null)
          }}
          className="flex-1 rounded-md px-2 py-1 text-xs whitespace-nowrap text-accent transition-colors hover:bg-panel-2"
        >
          {a.label}
        </button>
      ))}
    </div>
  )
}
