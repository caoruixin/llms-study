import { useState } from 'react'
import StackExplorer from '../components/StackExplorer'
import LifecycleSim from '../components/LifecycleSim'
import MemoryCalculator from '../components/MemoryCalculator'
import EconomicsPanel from '../components/EconomicsPanel'

const TABS = [
  { id: 'stack', label: '全链路四层' },
  { id: 'lifecycle', label: 'Prompt 生命周期模拟' },
  { id: 'memory', label: '显存墙计算器' },
  { id: 'economics', label: 'Token 经济' },
] as const

type TabId = (typeof TABS)[number]['id']

export default function InferencePage() {
  const [tab, setTab] = useState<TabId>('stack')

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.id ? 'bg-accent text-white' : 'bg-panel text-dim hover:bg-panel-2 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'stack' && <StackExplorer />}
      {tab === 'lifecycle' && <LifecycleSim />}
      {tab === 'memory' && <MemoryCalculator />}
      {tab === 'economics' && <EconomicsPanel />}
    </div>
  )
}
