import { useMemo, useState } from 'react'
import { useInferenceScenario } from '../../store'
import { Panel, StatusBadge } from './KpiPrimitives'
import { CATEGORY_META, KPI_VIEW_MODELS, type KpiCategoryId, type KpiViewModel } from './kpiViewModel'

type JumpTarget = 'atlas' | 'lifecycle' | 'memory' | 'economics'

interface WorkloadMetric {
  id: string
  name: string
  value: string
  explanation: string
}

const STAGES: { id: 'workload' | KpiCategoryId; title: string; subtitle: string }[] = [
  { id: 'workload', title: '业务负载', subtitle: '请求从哪里来、长什么样' },
  { id: 'experience', title: '体验 SLO', subtitle: '用户愿意等多久' },
  { id: 'capacity', title: '容量 / Goodput', subtitle: '达标流量有多少' },
  { id: 'resource', title: '资源瓶颈', subtitle: '为什么开始变慢' },
  { id: 'cost', title: 'Sizing / 成本', subtitle: '最终需要多少基础设施' },
]

const buttonClass = (active: boolean) =>
  `min-h-11 w-full rounded-lg border px-3 py-2 text-left transition-colors ${
    active ? 'border-accent bg-accent/10 shadow-sm' : 'border-line bg-panel hover:border-accent/50 hover:bg-panel-2'
  }`

export interface KpiOverviewProps {
  onJumpTo: (target: JumpTarget) => void
}

export default function KpiOverview({ onJumpTo }: KpiOverviewProps) {
  const scenario = useInferenceScenario()
  const workload = useMemo<WorkloadMetric[]>(
    () => [
      { id: 'workload-rps', name: '峰值 RPS', value: `${scenario.peakRps.toLocaleString()} req/s`, explanation: '业务高峰每秒到达的请求数，是容量推导的入口。' },
      { id: 'workload-shape', name: 'ISL / OSL', value: `${scenario.inputTokens.toLocaleString()} / ${scenario.outputTokens.toLocaleString()} tok`, explanation: '输入长度决定 prefill 压力，输出长度决定 decode 占用与系统输出 TPS。' },
      { id: 'workload-concurrency', name: '并发度', value: `${scenario.concurrency}`, explanation: '同时在系统中的请求数，应与 RPS × E2E 延迟的 Little’s Law 估计交叉校验。' },
      { id: 'workload-cache', name: '前缀缓存命中', value: `${Math.round(scenario.cacheRate * 100)}%`, explanation: '重复前缀命中可减少 prefill 工作量；路由策略会直接影响集群级命中率。' },
    ],
    [scenario.peakRps, scenario.inputTokens, scenario.outputTokens, scenario.concurrency, scenario.cacheRate],
  )
  const firstKpi = KPI_VIEW_MODELS[0] ?? null
  const [selectedId, setSelectedId] = useState<string>(firstKpi?.id ?? workload[0].id)
  const selectedKpi = KPI_VIEW_MODELS.find((kpi) => kpi.id === selectedId) ?? null
  const selectedWorkload = workload.find((item) => item.id === selectedId) ?? null

  return (
    <div className="min-w-0 space-y-4">
      <div className="rounded-xl border border-accent/20 bg-gradient-to-br from-panel via-panel to-accent/5 p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-bold">AI 推理服务 KPI 全景因果链</h3>
              <StatusBadge tone="target">业务 → GPU</StatusBadge>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-dim">
              从业务负载与体验 SLO 出发，用 Goodput 校验真正可用容量，再沿资源信号定位瓶颈，最后换算 GPU、服务器、机架和成本。
            </p>
          </div>
          <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs leading-relaxed">
            <span className="font-semibold text-warn">口径先行：</span>TPS = 整个系统的输出 token/s；单用户输出 tok/s = OSL ÷ E2E；1 ÷ TPOT 只表示 decode cadence，三者不可混用。
          </div>
        </div>
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0">
          <div className="grid min-w-0 gap-3 xl:grid-cols-5">
            {STAGES.map((stage, stageIndex) => {
              const metrics = stage.id === 'workload' ? workload : KPI_VIEW_MODELS.filter((kpi) => kpi.category === stage.id)
              return (
                <div key={stage.id} className="relative min-w-0">
                  <Panel className="h-full min-w-0 p-3">
                    <div className="flex items-start gap-2">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-bold text-accent">{stageIndex + 1}</span>
                      <div className="min-w-0">
                        <h4 className="text-sm font-bold">{stage.title}</h4>
                        <p className="mt-0.5 text-[11px] leading-snug text-dim">{stage.subtitle}</p>
                      </div>
                    </div>
                    <div className="mt-3 space-y-2">
                      {metrics.map((item) => {
                        if ('value' in item) {
                          return (
                            <button key={item.id} type="button" onClick={() => setSelectedId(item.id)} className={buttonClass(selectedId === item.id)}>
                              <span className="block text-xs font-semibold">{item.name}</span>
                              <span className="mt-0.5 block break-words font-mono text-xs text-accent">{item.value}</span>
                            </button>
                          )
                        }
                        return (
                          <button key={item.id} type="button" onClick={() => setSelectedId(item.id)} className={buttonClass(selectedId === item.id)}>
                            <span className="block break-words text-xs font-semibold">{item.name}</span>
                            {item.englishName && <span className="mt-0.5 block truncate text-[10px] text-dim">{item.englishName}</span>}
                            <span className="mt-1 inline-block rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-dim">{item.unit}</span>
                          </button>
                        )
                      })}
                      {metrics.length === 0 && <p className="rounded-lg border border-dashed border-line p-3 text-xs text-dim">注册表暂无指标</p>}
                    </div>
                  </Panel>
                  {stageIndex < STAGES.length - 1 && (
                    <div aria-hidden="true" className="flex h-6 items-center justify-center text-lg text-accent xl:absolute xl:-right-3.5 xl:top-10 xl:z-10 xl:h-auto xl:rotate-0">
                      <span className="xl:hidden">↓</span><span className="hidden xl:inline">→</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <Panel className="mt-4">
            <h4 className="text-sm font-semibold">把四类指标放回架构因果链</h4>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {(Object.keys(CATEGORY_META) as KpiCategoryId[]).map((id) => (
                <div key={id} className="rounded-lg border border-line bg-panel-2/50 p-3">
                  <div className="text-xs font-semibold">{CATEGORY_META[id].symbol} {CATEGORY_META[id].label}</div>
                  <p className="mt-1 text-[11px] leading-relaxed text-dim">{CATEGORY_META[id].description}</p>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <aside className="min-w-0">
          <div className="lg:sticky lg:top-20">
            {selectedKpi ? (
              <KpiDetail kpi={selectedKpi} onJumpTo={onJumpTo} />
            ) : selectedWorkload ? (
              <Panel className="border-accent/30">
                <StatusBadge tone="target">场景输入</StatusBadge>
                <h3 className="mt-3 text-base font-bold">{selectedWorkload.name}</h3>
                <div className="mt-2 font-mono text-2xl font-bold text-accent">{selectedWorkload.value}</div>
                <p className="mt-3 text-sm leading-relaxed text-dim">{selectedWorkload.explanation}</p>
                <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-dim">这是当前场景目标/假设，不是 Benchmark 实测值。可在 Sizing 推导中修改。</p>
              </Panel>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  )
}

function KpiDetail({ kpi, onJumpTo }: { kpi: KpiViewModel; onJumpTo: (target: JumpTarget) => void }) {
  return (
    <Panel className="border-accent/30">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge>{CATEGORY_META[kpi.category].label}</StatusBadge>
        <StatusBadge tone="neutral">{kpi.scope}</StatusBadge>
      </div>
      <h3 className="mt-3 text-base font-bold">{kpi.name}</h3>
      {kpi.englishName && <p className="mt-0.5 text-xs text-dim">{kpi.englishName}</p>}
      <p className="mt-3 text-sm leading-relaxed">{kpi.definition}</p>
      <dl className="mt-4 grid gap-2 text-xs">
        <DetailRow label="单位" value={kpi.unit} />
        <DetailRow label="优化方向" value={kpi.direction} />
        <DetailRow label="统计口径" value={kpi.statistic} />
        <DetailRow label="测量点" value={kpi.measurementPoint} />
        <DetailRow label="公式" value={kpi.formula} />
        <DetailRow label="诊断意义" value={kpi.diagnosticMeaning} />
      </dl>
      {kpi.formulaDependencies.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-semibold">公式依赖</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {kpi.formulaDependencies.map((dependency) => <StatusBadge key={dependency}>{dependency}</StatusBadge>)}
          </div>
        </div>
      )}
      {kpi.relatedArchComponents.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-semibold">关联架构组件</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {kpi.relatedArchComponents.map((component) => <StatusBadge key={component} tone="estimated">{component}</StatusBadge>)}
          </div>
        </div>
      )}
      <div className="mt-4 grid grid-cols-2 gap-2 border-t border-line pt-3">
        <button type="button" onClick={() => onJumpTo('atlas')} className="min-h-11 rounded-lg border border-line bg-panel-2 px-3 text-xs font-semibold hover:border-accent/50">去架构图谱 →</button>
        <button type="button" onClick={() => onJumpTo(kpi.category === 'cost' ? 'economics' : kpi.category === 'resource' ? 'memory' : 'lifecycle')} className="min-h-11 rounded-lg border border-line bg-panel-2 px-3 text-xs font-semibold hover:border-accent/50">联动验证 →</button>
      </div>
      {kpi.sourceUrl && (
        <a href={kpi.sourceUrl} target="_blank" rel="noreferrer" className="mt-3 block break-all text-[11px] text-accent underline underline-offset-2">
          来源 · {kpi.asOf || '日期未注明'} ↗
        </a>
      )}
    </Panel>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2 rounded-lg bg-panel-2/60 px-2.5 py-2">
      <dt className="text-dim">{label}</dt>
      <dd className="break-words leading-relaxed">{value}</dd>
    </div>
  )
}
