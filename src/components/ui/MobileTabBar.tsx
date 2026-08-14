import { NavLink } from 'react-router-dom'
import { NAV } from '../../nav'

// 移动端底部导航：<md 顶部横滚 nav 隐藏后由它承接一级导航；与桌面 nav 同源 NAV，短标签 short 字段专用
export default function MobileTabBar() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-ink/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      <div className="flex">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            className={({ isActive }) =>
              `relative flex min-h-12 flex-1 items-center justify-center text-[13px] ${
                isActive ? 'font-medium text-accent' : 'text-dim'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute inset-x-0 top-0 h-0.5 bg-accent" />}
                {n.short}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
