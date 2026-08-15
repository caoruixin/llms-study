import { Suspense, lazy, useEffect } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import ArchitecturePage from './pages/ArchitecturePage'
import InferencePage from './pages/InferencePage'
import AgentPage from './pages/AgentPage'
import KdaPage from './pages/KdaPage'
import InterviewPage from './pages/InterviewPage'
import SettingsPage from './pages/SettingsPage'
import SelectionAsk from './components/ask/SelectionAsk'
import ErrorBoundary from './components/ErrorBoundary'
import MobileTabBar from './components/ui/MobileTabBar'
// auth 模块固定放 src/lib/auth 与 src/components/auth：不许挪进 papers 目录——
// flag-off 构建会把 papers 子树整体虚模块化，auth 必须在两种构建下都存在
import LoginDialog from './components/auth/LoginDialog'
import UserMenu from './components/auth/UserMenu'
import { useAuthStore } from './lib/auth/authStore'
import { NAV } from './nav'

// 论文陪读 build-time flag：与 nav.ts 同一开关，一处关闭即无导航项也无路由（不留死链接）。
// 关键写法：lazy(...) 必须包在三元里而不是无条件写在模块顶层——flag-off 时 PAPER_ENABLED 被 Vite
// 内联为 false，整支三元被 Rollup 剪除，动态 import 不发射 chunk；若无条件调用 lazy()，Rollup 会
// 保守认为该调用有副作用而保留动态 import，flag-off 产物就会多出一份 paper chunk。
const PAPER_ENABLED = import.meta.env.VITE_ENABLE_PAPER_COPILOT === '1'
const PapersPage = PAPER_ENABLED ? lazy(() => import('./pages/papers/PapersPage')) : null
const PaperWorkbenchPage = PAPER_ENABLED ? lazy(() => import('./pages/papers/PaperWorkbenchPage')) : null

// 懒加载路由的 Suspense fallback：骨架卡片，避免切页瞬间的空白抖动
function PageLoading() {
  return (
    <div className="rounded-xl border border-line bg-panel shadow-sm p-6">
      <div className="mb-3 h-5 w-40 animate-pulse rounded bg-panel-2" />
      <div className="mb-2 h-4 w-full animate-pulse rounded bg-panel-2" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-panel-2" />
      <p className="mt-4 text-sm text-dim">正在加载模块…</p>
    </div>
  )
}

export default function App() {
  const { pathname } = useLocation()
  // 工作台是沉浸态，自带 z-40 底部 Copilot 面板：/papers/:id 下不与底部 Tab Bar 共存
  const hideTabBar = /^\/papers\/./.test(pathname)

  // 登录态生命周期：启动 whoami 一次 + 回前台 30s 节流 re-check
  // （session 被服务端吊销/其它设备改密后，回前台自愈为未登录，而不是等下一次 401）
  useEffect(() => {
    void useAuthStore.getState().refresh()
    let lastCheck = Date.now()
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastCheck < 30_000) return
      lastCheck = Date.now()
      void useAuthStore.getState().refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])
  return (
    /* 工作台（hideTabBar）手机端改为视口定高 flex 列：文档级滚动归零，滚动只发生在阅读列内部
       ——否则 scrollIntoView/键盘弹出随手一滚就把 sticky header 之外的工作台头部顶出屏幕。
       md+ 逐字还原 min-h-dvh 的文档流布局（桌面/平板零变化）。条件类是完整字面量（Tailwind v4 只认全串） */
    <div className={hideTabBar ? 'flex h-dvh flex-col md:block md:h-auto md:min-h-dvh' : 'min-h-dvh'}>
      <header className="sticky top-0 z-40 shrink-0 border-b border-line bg-ink/90 backdrop-blur">
        {/* 窄屏（~390px）导航横向溢出：整行允许换行，导航自身可横滚且不换行竖排 */}
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent text-xs font-bold text-white">
              L
            </span>
            <span className="shrink-0 text-base font-bold text-fg md:text-lg">LLM Infra Studio</span>
            <span className="hidden truncate text-xs text-dim md:inline">AI 学习与实践工作台</span>
          </div>
          <nav className="-mx-1 hidden min-w-0 max-w-full flex-1 gap-1 overflow-x-auto px-1 md:flex">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  `shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors ${
                    isActive
                      ? 'border-accent font-medium text-accent'
                      : 'border-transparent text-dim hover:text-fg'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          {/* 登录态入口只挂桌面 header；移动端 header 空间紧张，账号操作走设置页 */}
          <div className="hidden md:block">
            <UserMenu />
          </div>
        </div>
      </header>
      <main
        className={
          hideTabBar
            ? // 手机：满幅零左右/底 padding（工作台自己管内边距，pb-0 让 Copilot sheet 贴底）+
              // min-h-0 flex-1 吃掉 header 之外的整个视口高；md+ 逐字还原 px-4 py-6
              'mx-auto w-full max-w-7xl min-h-0 flex-1 px-0 pt-2 pb-0 md:min-h-fit md:flex-none md:px-4 md:py-6'
            : 'mx-auto max-w-7xl px-4 pt-6 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-6'
        }
      >
        {/* 每个页面各包一层 ErrorBoundary：单页 render 期 throw 只废该页，不白屏整站 */}
        <Routes>
          <Route path="/" element={<Navigate to="/architecture" replace />} />
          <Route path="/architecture" element={<ErrorBoundary><ArchitecturePage /></ErrorBoundary>} />
          <Route path="/inference" element={<ErrorBoundary><InferencePage /></ErrorBoundary>} />
          <Route path="/agent" element={<ErrorBoundary><AgentPage /></ErrorBoundary>} />
          <Route path="/kda" element={<ErrorBoundary><KdaPage /></ErrorBoundary>} />
          <Route path="/interview" element={<ErrorBoundary><InterviewPage /></ErrorBoundary>} />
          {/* 懒加载页：Suspense 嵌在 ErrorBoundary 内，chunk 加载失败同样只废该页 */}
          {PapersPage && (
            <Route
              path="/papers"
              element={
                <ErrorBoundary>
                  <Suspense fallback={<PageLoading />}>
                    <PapersPage />
                  </Suspense>
                </ErrorBoundary>
              }
            />
          )}
          {PaperWorkbenchPage && (
            <Route
              path="/papers/:paperId"
              element={
                <ErrorBoundary>
                  <Suspense fallback={<PageLoading />}>
                    <PaperWorkbenchPage />
                  </Suspense>
                </ErrorBoundary>
              }
            />
          )}
          <Route path="/settings" element={<ErrorBoundary><SettingsPage /></ErrorBoundary>} />
        </Routes>
      </main>
      {!hideTabBar && <MobileTabBar />}
      <SelectionAsk />
      {/* 全局登录弹窗：任何 requireLogin 调用点共用这一个实例 */}
      <LoginDialog />
    </div>
  )
}
