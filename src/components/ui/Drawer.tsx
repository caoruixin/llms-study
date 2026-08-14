import type { ReactNode } from 'react'

interface DrawerProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  widthClass?: string
}

// 从 PaperWorkbenchPage 的目录抽屉抽取（逐字迁移 className）。
// 不用 portal：调用处可能挂在有 transform 祖先的容器下，fixed 以该容器为包含块是既有验收行为，
// 保持调用处渲染能让两种上下文（有/无 transform 祖先）各自正确。
export default function Drawer({ open, onClose, title, children, widthClass = 'w-[min(20rem,85vw)]' }: DrawerProps) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-ink/60 backdrop-blur-[1px]" role="presentation" onClick={onClose} />
      <div className={`h-full ${widthClass} overflow-hidden border-l border-line bg-panel p-4 shadow-lg`}>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-fg">{title}</span>
          <button type="button" onClick={onClose} className="text-sm text-dim hover:text-fg">
            关闭
          </button>
        </div>
        <div className="h-[calc(100%-2rem)]">{children}</div>
      </div>
    </div>
  )
}
