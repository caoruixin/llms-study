import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import ArchitecturePage from './pages/ArchitecturePage'
import InferencePage from './pages/InferencePage'
import AgentPage from './pages/AgentPage'
import InterviewPage from './pages/InterviewPage'
import SettingsPage from './pages/SettingsPage'
import SelectionAsk from './components/ask/SelectionAsk'
import { NAV } from './nav'

export default function App() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-line bg-ink/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-xs font-bold text-white">
              L
            </span>
            <span className="text-lg font-bold text-fg">LLM Infra Studio</span>
            <span className="text-xs text-dim">面试备战台 · Token & 算力售前</span>
          </div>
          <nav className="flex gap-1">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  `border-b-2 px-3 py-2 text-sm transition-colors ${
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
          <Route path="/interview" element={<InterviewPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      <SelectionAsk />
    </div>
  )
}
