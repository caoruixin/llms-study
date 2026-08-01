import { useState } from 'react'
import SegmentedTabs from '../components/ui/SegmentedTabs'
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
      <SegmentedTabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'stack' && <StackExplorer />}
      {tab === 'lifecycle' && <LifecycleSim />}
      {tab === 'memory' && <MemoryCalculator />}
      {tab === 'economics' && <EconomicsPanel />}
    </div>
  )
}
