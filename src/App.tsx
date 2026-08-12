import { Suspense, lazy } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import ArchitecturePage from './pages/ArchitecturePage'
import InferencePage from './pages/InferencePage'
import AgentPage from './pages/AgentPage'
import KdaPage from './pages/KdaPage'
import InterviewPage from './pages/InterviewPage'
import SettingsPage from './pages/SettingsPage'
import SelectionAsk from './components/ask/SelectionAsk'
import ErrorBoundary from './components/ErrorBoundary'
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
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-line bg-ink/90 backdrop-blur">
        {/* 窄屏（~390px）导航横向溢出：整行允许换行，导航自身可横滚且不换行竖排 */}
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent text-xs font-bold text-white">
              L
            </span>
            <span className="shrink-0 text-lg font-bold text-fg">LLM Infra Studio</span>
            <span className="truncate text-xs text-dim">AI 学习与实践工作台</span>
          </div>
          <nav className="-mx-1 flex min-w-0 max-w-full flex-1 gap-1 overflow-x-auto px-1">
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
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
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
      <SelectionAsk />
    </div>
  )
}
