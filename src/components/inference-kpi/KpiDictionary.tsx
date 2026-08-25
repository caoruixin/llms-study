import { useMemo, useState } from 'react'
import { EmptyState, Panel, StatusBadge } from './KpiPrimitives'
import { CATEGORY_META, KPI_VIEW_MODELS, type KpiCategoryId } from './kpiViewModel'

type CategoryFilter = 'all' | KpiCategoryId

const FILTERS: { id: CategoryFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'experience', label: '体验类' },
  { id: 'capacity', label: '容量类' },
  { id: 'resource', label: '资源类' },
  { id: 'cost', label: '成本类' },
]

export default function KpiDictionary() {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const queryTerms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const results = useMemo(
    () => KPI_VIEW_MODELS.filter((kpi) => {
      if (category !== 'all' && kpi.category !== category) return false
      if (queryTerms.length === 0) return true
      const haystack = [kpi.name, kpi.englishName, kpi.definition, kpi.unit, kpi.formula, kpi.diagnosticMeaning, ...kpi.relatedArchComponents]
        .join(' ')
        .toLowerCase()
      return queryTerms.every((term) => haystack.includes(term))
    }),
    [category, queryTerms],
  )

  return (
    <div className="min-w-0 space-y-4">
      <Panel>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <label className="min-w-0 flex-1 text-xs text-dim">
            搜索指标、定义或架构组件
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="例如 TTFT、系统输出 TPS、KV cache…"
              className="mt-1 min-h-11 w-full rounded-lg border border-line bg-panel-2 px-3 text-sm text-fg placeholder:text-dim/70"
            />
          </label>
          <div className="flex max-w-full gap-1 overflow-x-auto pb-1" aria-label="指标分类筛选">
            {FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                onClick={() => setCategory(filter.id)}
                aria-pressed={category === filter.id}
                className={`min-h-11 shrink-0 rounded-lg border px-3 text-xs font-semibold ${
                  category === filter.id ? 'border-accent bg-accent text-white' : 'border-line bg-panel-2 text-dim hover:text-fg'
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-3 text-xs text-dim">找到 {results.length} / {KPI_VIEW_MODELS.length} 个指标。TPS 在本工作台始终表示系统输出 TPS。</p>
      </Panel>

      {results.length === 0 ? (
        <EmptyState title="没有匹配的指标">尝试缩短关键词，或切换到“全部”分类。</EmptyState>
      ) : (
        <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {results.map((kpi) => (
            <Panel key={kpi.id} className="flex min-w-0 flex-col">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <StatusBadge>{CATEGORY_META[kpi.category].label}</StatusBadge>
                <span className="font-mono text-[11px] text-dim">{kpi.unit}</span>
              </div>
              <h3 className="mt-3 break-words text-sm font-bold">{kpi.name}</h3>
              {kpi.englishName && <p className="mt-0.5 text-[11px] text-dim">{kpi.englishName}</p>}
              <p className="mt-2 text-xs leading-relaxed">{kpi.definition}</p>
              <dl className="mt-3 grid gap-1.5 text-[11px] leading-relaxed">
                <Row label="层级" value={kpi.scope} />
                <Row label="方向" value={kpi.direction} />
                <Row label="统计" value={kpi.statistic} />
                <Row label="测量" value={kpi.measurementPoint} />
                <Row label="公式" value={kpi.formula} />
              </dl>
              <div className="mt-3 rounded-lg border border-line bg-panel-2/60 p-2.5 text-[11px] leading-relaxed">
                <span className="font-semibold">诊断：</span>{kpi.diagnosticMeaning}
              </div>
              {kpi.relatedArchComponents.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {kpi.relatedArchComponents.map((component) => <StatusBadge key={component} tone="estimated">{component}</StatusBadge>)}
                </div>
              )}
              {kpi.sourceUrl && (
                <a href={kpi.sourceUrl} target="_blank" rel="noreferrer" className="mt-auto block break-all pt-4 text-[11px] text-accent underline underline-offset-2">
                  来源 · {kpi.asOf || '日期未注明'} ↗
                </a>
              )}
            </Panel>
          ))}
        </div>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
      <dt className="text-dim">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  )
}
