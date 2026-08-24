import { useCallback, useEffect, useRef, useState } from 'react'
import { PERSONA_DEFS, findPersona, type PersonaId } from '../../lib/paper/personas'

/**
 * 售前视角 chip（Track 3）：仿 ProfileChip 的 chip+popover 形制，两档单选（默认 / 售前新人 SA）。
 *
 * 复用 ProfileChip 同一条定位约束：popover 向右展开、宽度压在**最窄**面板内宽以内——
 * Copilot 面板容器 overflow-hidden，最窄一档是 w-80（标准档；加宽/超宽/专注陪读整列更宽），
 * 向左展开（right-0）会被裁掉，选项在桌面与 390px 手机下都点不到。移动端两个 chip
 * 并排放不下时靠 flex-wrap 自然换行，不需要额外断点处理。
 */

/** popover 宽度上限：与 ProfileChip 一致，≤ 最窄档面板内宽（w-80 减 p-4 两侧 = 288px） */
const POPOVER_CLASS = 'w-56 max-w-[min(14rem,calc(100vw-3rem))]'

interface Props {
  /** CopilotSession.persona 原始值（可能是 undefined/未知字符串），组件内部统一归一 */
  value: string | null | undefined
  onChange: (id: PersonaId) => void
}

export default function PersonaChip({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = findPersona(value)

  const close = useCallback(() => setOpen(false), [])

  // Escape 关闭 + 点击外部关闭（popover 覆盖在消息列表之上，没有这两条就只能靠再点 chip）
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target
      if (target instanceof Node && rootRef.current?.contains(target)) return
      close()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
    }
  }, [open, close])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        title="切换回答的读者视角（默认 / 售前新人 SA）"
        className="flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[0.65rem] text-accent transition-colors hover:bg-accent/20"
      >
        视角：{current.label}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="读者视角设置"
          className={`absolute top-full left-0 z-30 mt-1 rounded-lg border border-line bg-panel p-2.5 shadow-lg ${POPOVER_CLASS}`}
        >
          <p className="mb-1.5 text-[0.7rem] text-dim">当前：{current.label}</p>
          <div className="mb-2 flex flex-col gap-1">
            {PERSONA_DEFS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onChange(p.id)
                  close()
                }}
                aria-pressed={current.id === p.id}
                className={`rounded border px-2 py-1 text-left text-[0.7rem] transition-colors ${
                  current.id === p.id
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-line text-dim hover:border-accent/40 hover:text-accent'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="text-[0.7rem] leading-relaxed text-dim">{current.description}</p>
        </div>
      )}
    </div>
  )
}
