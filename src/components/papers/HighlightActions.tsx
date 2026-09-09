import { useEffect, useRef, useState } from 'react'
import type { SelectionSource } from './SelectionActions'

/**
 * 已高亮文本的「取消高亮」小浮层：document 级 click 委托命中 `<mark data-highlight-id>` 时弹出。
 *
 * 与 SelectionActions 的分工：那边管「有选区」的动作，这边只管「点一下已有 mark」——
 * click 时选区未塌陷（用户在划词）就不弹，两个浮层不会同时出现。
 * 根节点同样挂 `data-paper-selection-ui`：两个组件的 document 监听互相豁免对方的 UI。
 *
 * 网页原貌视图的 mark 在 iframe 文档里（click 不冒泡到父 document）：与 SelectionActions 同一套
 * `getSources` 逐文档挂监听，矩形加上该文档在父视口里的偏移。
 */

interface Props {
  onRemove: (id: string) => void
  /** 选区源列表（同 SelectionActions）；缺省只监听父 document */
  getSources?: () => SelectionSource[]
}

interface PopState {
  x: number
  y: number
  id: string
}

/** 单按钮小浮层：宽度远小于快捷条，钳位与上下翻转沿 SelectionActions 同一套思路 */
const POP_WIDTH = 96

export default function HighlightActions({ onRemove, getSources }: Props) {
  const [pop, setPop] = useState<PopState | null>(null)
  const getSourcesRef = useRef(getSources)
  getSourcesRef.current = getSources

  useEffect(() => {
    // 按 nodeType 判定而非 instanceof：iframe 文档的节点属于另一个 realm，父窗口的 Element 认不出
    const asElement = (node: EventTarget | null): Element | null => {
      const n = node as Node | null
      if (!n || typeof n.nodeType !== 'number') return null
      return n.nodeType === 1 ? (n as Element) : (n.parentElement ?? null)
    }
    const offsetFor = (doc: Document): { x: number; y: number } =>
      getSourcesRef.current?.().find((s) => s.doc === doc)?.offset() ?? { x: 0, y: 0 }

    const onClick = (e: Event) => {
      const doc = e.currentTarget as Document
      const el = asElement(e.target)
      // 自己/快捷条内部的点击不处理：按钮各自的 onClick 负责
      if (el?.closest('[data-paper-selection-ui]')) return
      const mark = el?.closest('[data-highlight-id]')
      if (!mark) {
        setPop(null)
        return
      }
      // 划词落点恰好在 mark 上：选区未塌陷说明用户在选文字，让位给 SelectionActions
      const sel = doc.getSelection()
      if (sel && !sel.isCollapsed && sel.toString().trim() !== '') return
      const id = mark.getAttribute('data-highlight-id')
      if (!id) return
      const r = mark.getBoundingClientRect()
      const off = offsetFor(doc)
      const top = r.top + off.y
      const x = Math.min(Math.max(r.left + off.x + r.width / 2 - POP_WIDTH / 2, 8), window.innerWidth - POP_WIDTH - 8)
      // 钳进视口（与 SelectionActions 同一口径）：mark 矩形越界时浮层仍可点
      const y = Math.min(Math.max(top > 108 ? top - 44 : r.bottom + off.y + 10, 8), window.innerHeight - 48)
      setPop({ x, y, id })
    }

    const onScroll = (e: Event) => {
      const el = asElement(e.target)
      if (el?.closest('[data-paper-selection-ui]')) return
      setPop(null)
    }
    const onKeyDown = (e: Event) => {
      if ((e as KeyboardEvent).key === 'Escape') setPop(null)
    }

    const docs = new Set<Document>([document, ...(getSourcesRef.current?.() ?? []).map((s) => s.doc)])
    for (const doc of docs) {
      doc.addEventListener('click', onClick)
      doc.addEventListener('keydown', onKeyDown)
    }
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      for (const doc of docs) {
        doc.removeEventListener('click', onClick)
        doc.removeEventListener('keydown', onKeyDown)
      }
      window.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [getSources])

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
