import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import ArchitecturePage from './pages/ArchitecturePage'
import InferencePage from './pages/InferencePage'
import AgentPage from './pages/AgentPage'
import InterviewPage from './pages/InterviewPage'
import SettingsPage from './pages/SettingsPage'

const NAV = [
  { to: '/architecture', label: '架构演进' },
  { to: '/inference', label: '推理链路' },
  { to: '/agent', label: 'Agent 架构' },
  { to: '/interview', label: '面试陪练' },
  { to: '/settings', label: '设置' },
]

export default function App() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-line bg-ink/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold text-accent">LLM Infra Studio</span>
            <span className="text-xs text-dim">面试备战台 · Token & 算力售前</span>
          </div>
          <nav className="flex gap-1">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm transition-colors ${
                    isActive ? 'bg-accent/20 text-accent' : 'text-dim hover:bg-panel-2 hover:text-white'
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
          <Route path="/interview" element={<InterviewPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  )
}
