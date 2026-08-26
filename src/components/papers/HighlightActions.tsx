import { useEffect, useState } from 'react'

/**
 * 已高亮文本的「取消高亮」小浮层：document 级 click 委托命中 `<mark data-highlight-id>` 时弹出。
 *
 * 与 SelectionActions 的分工：那边管「有选区」的动作，这边只管「点一下已有 mark」——
 * click 时选区未塌陷（用户在划词）就不弹，两个浮层不会同时出现。
 * 根节点同样挂 `data-paper-selection-ui`：两个组件的 document 监听互相豁免对方的 UI。
 */

interface Props {
  onRemove: (id: string) => void
}

interface PopState {
  x: number
  y: number
  id: string
}

/** 单按钮小浮层：宽度远小于快捷条，钳位与上下翻转沿 SelectionActions 同一套思路 */
const POP_WIDTH = 96

export default function HighlightActions({ onRemove }: Props) {
  const [pop, setPop] = useState<PopState | null>(null)

  useEffect(() => {
    const asElement = (node: EventTarget | null): Element | null =>
      node instanceof Element ? node : node instanceof Node ? node.parentElement : null

    const onClick = (e: MouseEvent) => {
      const el = asElement(e.target)
      // 自己/快捷条内部的点击不处理：按钮各自的 onClick 负责
      if (el?.closest('[data-paper-selection-ui]')) return
      const mark = el?.closest('[data-highlight-id]')
      if (!(mark instanceof HTMLElement)) {
        setPop(null)
        return
      }
      // 划词落点恰好在 mark 上：选区未塌陷说明用户在选文字，让位给 SelectionActions
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed && sel.toString().trim() !== '') return
      const id = mark.dataset.highlightId
      if (!id) return
      const r = mark.getBoundingClientRect()
      const x = Math.min(Math.max(r.left + r.width / 2 - POP_WIDTH / 2, 8), window.innerWidth - POP_WIDTH - 8)
      const y = r.top > 108 ? r.top - 44 : r.bottom + 10
      setPop({ x, y, id })
    }

    const onScroll = (e: Event) => {
      const el = asElement(e.target)
      if (el?.closest('[data-paper-selection-ui]')) return
      setPop(null)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPop(null)
    }

    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [])

  if (!pop) return null

  return (
    <div
      data-paper-selection-ui=""
      style={{ left: pop.x, top: pop.y, width: POP_WIDTH }}
      className="fixed z-50 rounded-lg border border-line bg-panel p-1 shadow-md"
    >
      <button
        type="button"
        // 防止按下时抢焦点/塌陷选区（与快捷条按钮同一习惯）
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => {
          onRemove(pop.id)
          setPop(null)
        }}
        className="w-full rounded-md px-2 py-1 text-xs whitespace-nowrap text-accent transition-colors hover:bg-panel-2"
      >
        取消高亮
      </button>
    </div>
  )
}
