import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import ArchitecturePage from './pages/ArchitecturePage'
import InferencePage from './pages/InferencePage'
import AgentPage from './pages/AgentPage'
import KdaPage from './pages/KdaPage'
import InterviewPage from './pages/InterviewPage'
import SettingsPage from './pages/SettingsPage'
import SelectionAsk from './components/ask/SelectionAsk'
import { NAV } from './nav'

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
            <span className="truncate text-xs text-dim">面试备战台 · Token & 算力售前</span>
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
        <Routes>
          <Route path="/" element={<Navigate to="/architecture" replace />} />
          <Route path="/architecture" element={<ArchitecturePage />} />
          <Route path="/inference" element={<InferencePage />} />
          <Route path="/agent" element={<AgentPage />} />
          <Route path="/kda" element={<KdaPage />} />
          <Route path="/interview" element={<InterviewPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      <SelectionAsk />
    </div>
  )
}
