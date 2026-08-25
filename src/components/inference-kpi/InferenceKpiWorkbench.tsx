import { useState } from 'react'
import SegmentedTabs from '../ui/SegmentedTabs'
import BenchmarkAnalysis from './BenchmarkAnalysis'
import KpiDictionary from './KpiDictionary'
import KpiOverview from './KpiOverview'
import SizingDerivation from './SizingDerivation'

const VIEWS = [
  { id: 'overview', label: '全景因果图' },
  { id: 'benchmark', label: 'Benchmark 分析' },
  { id: 'sizing', label: 'Sizing 推导' },
  { id: 'dictionary', label: '指标词典' },
] as const

type ViewId = (typeof VIEWS)[number]['id']
export type InferenceKpiJumpTarget = 'atlas' | 'lifecycle' | 'memory' | 'economics'

export interface InferenceKpiWorkbenchProps {
  onJumpTo: (target: InferenceKpiJumpTarget) => void
}

export default function InferenceKpiWorkbench({ onJumpTo }: InferenceKpiWorkbenchProps) {
  const [view, setView] = useState<ViewId>('overview')

  return (
    <section className="min-w-0 space-y-4" aria-labelledby="inference-kpi-heading">
      <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-panel p-4 shadow-sm md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-wide text-accent uppercase">Inference KPI Atlas</p>
          <h2 id="inference-kpi-heading" className="mt-1 text-lg font-bold">推理 KPI 工作台</h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-dim">
            用同一套口径对齐客户体验、系统容量、GPU 资源与成本；目标、公式估算、AIPerf 实测始终分开展示。
          </p>
        </div>
        <div className="shrink-0 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs leading-relaxed text-dim">
          <span className="font-semibold text-fg">TPS</span> = 系统输出 token/s
          <span className="mx-2 text-line">|</span>
          <span className="font-semibold text-fg">单用户输出 tok/s</span> = OSL ÷ E2E
        </div>
      </div>

      <SegmentedTabs tabs={VIEWS} value={view} onChange={setView} />

      {view === 'overview' && <KpiOverview onJumpTo={onJumpTo} />}
      {view === 'benchmark' && <BenchmarkAnalysis />}
      {view === 'sizing' && <SizingDerivation onJumpTo={onJumpTo} />}
      {view === 'dictionary' && <KpiDictionary />}
    </section>
  )
}
