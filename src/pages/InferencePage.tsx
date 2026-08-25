import { lazy, Suspense, useState } from 'react'
import SegmentedTabs from '../components/ui/SegmentedTabs'
import StackExplorer from '../components/StackExplorer'
import LifecycleSim from '../components/LifecycleSim'
import MemoryCalculator from '../components/MemoryCalculator'
import EconomicsPanel from '../components/EconomicsPanel'

// 架构图谱数据量大且只有点开这个 tab 才用得上：独立 chunk 懒加载，入口体积不涨
const ArchAtlas = lazy(() => import('../components/arch/ArchAtlas'))
const InferenceKpiWorkbench = lazy(() => import('../components/inference-kpi/InferenceKpiWorkbench'))

const TABS = [
  { id: 'kpi', label: '推理 KPI' },
  { id: 'stack', label: '全链路四层' },
  { id: 'atlas', label: '架构图谱' },
  { id: 'lifecycle', label: 'Prompt 生命周期模拟' },
  { id: 'memory', label: '显存墙计算器' },
  { id: 'economics', label: 'Token 经济' },
] as const

type TabId = (typeof TABS)[number]['id']

export default function InferencePage() {
  const [tab, setTab] = useState<TabId>('kpi')

  return (
    <div className="space-y-5">
      <SegmentedTabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'kpi' && (
        <Suspense
          fallback={
            <div className="space-y-3" aria-label="正在加载推理 KPI 工作台">
              <div className="h-24 animate-pulse rounded-xl border border-line bg-panel" />
              <div className="h-64 animate-pulse rounded-xl border border-line bg-panel" />
            </div>
          }
        >
          <InferenceKpiWorkbench onJumpTo={(target) => setTab(target)} />
        </Suspense>
      )}
      {tab === 'stack' && <StackExplorer />}
      {tab === 'atlas' && (
        <Suspense
          fallback={
            <div className="space-y-3">
              <div className="h-9 w-64 animate-pulse rounded-lg border border-line bg-panel-2" />
              <div className="h-64 animate-pulse rounded-xl border border-line bg-panel" />
            </div>
          }
        >
          <ArchAtlas onJumpToMemory={() => setTab('memory')} />
        </Suspense>
      )}
      {tab === 'lifecycle' && <LifecycleSim />}
      {tab === 'memory' && <MemoryCalculator />}
      {tab === 'economics' && <EconomicsPanel />}
    </div>
  )
}
