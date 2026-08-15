import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '../../lib/auth/authStore'

/**
 * header 右侧登录态入口：未登录 =「登录」按钮（走 requireLogin promise-gate），
 * 已登录 = 用户名下拉（账号设置 / 登出）。移动端 header 不挂它（设置页可达），
 * 由 App 层用 hidden md:block 控制。
 */
export default function UserMenu() {
  const status = useAuthStore((s) => s.status)
  const user = useAuthStore((s) => s.user)
  const requireLogin = useAuthStore((s) => s.requireLogin)
  const logout = useAuthStore((s) => s.logout)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 外点收起（InterviewPage confirmTarget 同款 pointerdown 判定）
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !rootRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // 启动校准完成前不渲染：避免「登录」按钮闪现又变成用户名
  if (status === 'unknown') return null

  if (status !== 'authed' || !user) {
    return (
      <button
        type="button"
        onClick={() => void requireLogin('manual')}
        className="min-h-9 shrink-0 rounded-lg border border-line px-3 text-sm text-dim transition-colors hover:text-fg"
      >
        登录
      </button>
    )
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-sm text-fg transition-colors hover:bg-panel-2"
      >
        <span className="max-w-32 truncate">{user.username}</span>
        {user.role === 'admin' && (
          <span className="rounded bg-accent/15 px-1 text-[0.65rem] text-accent">admin</span>
        )}
        <span className="text-[0.6rem] text-dim">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-36 overflow-hidden rounded-lg border border-line bg-panel shadow-xl">
          <Link
            to="/settings"
            onClick={() => setOpen(false)}
            className="flex min-h-11 items-center px-3 text-sm text-fg transition-colors hover:bg-panel-2"
          >
            账号设置
          </Link>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              void logout()
            }}
            className="flex min-h-11 w-full items-center px-3 text-sm text-bad transition-colors hover:bg-panel-2"
          >
            登出
          </button>
        </div>
      )}
    </div>
  )
}
