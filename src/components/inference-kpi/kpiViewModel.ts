import { INFERENCE_KPIS, type KpiDefinition } from '../../data/inferenceKpis'

export type KpiCategoryId = 'experience' | 'capacity' | 'resource' | 'cost'

export interface KpiViewModel {
  raw: KpiDefinition
  id: string
  name: string
  englishName: string
  category: KpiCategoryId
  definition: string
  unit: string
  direction: string
  statistic: string
  scope: string
  measurementPoint: string
  formula: string
  formulaDependencies: string[]
  relatedArchComponents: string[]
  diagnosticMeaning: string
  sourceUrl: string
  asOf: string
}

const text = (value: unknown, fallback = '未注明') =>
  typeof value === 'string' && value.trim() ? value : fallback

const list = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  if (typeof value === 'string' && value.trim()) return [value]
  return []
}

const category = (value: unknown): KpiCategoryId => {
  if (value === 'experience' || value === 'capacity' || value === 'resource' || value === 'cost') return value
  return 'capacity'
}

/** 将数据注册表适配为稳定 UI 形状；字段内容仍完全来自类型化注册表。 */
export function toKpiViewModel(definition: KpiDefinition): KpiViewModel {
  const value = definition as unknown as Record<string, unknown>
  return {
    raw: definition,
    id: text(value.id, 'unknown'),
    name: text(value.name ?? value.label, '未命名指标'),
    englishName: text(value.englishName ?? value.shortName ?? value.abbreviation, ''),
    category: category(value.category),
    definition: text(value.definition ?? value.description),
    unit: text(value.unit),
    direction: text(value.direction),
    statistic: list(value.statistics ?? value.statistic ?? value.aggregation ?? value.statisticalBasis).join(' / ') || '未注明',
    scope: text(value.scope ?? value.level),
    measurementPoint: text(value.measurementPoint ?? value.measuredAt),
    formula: text(value.formula, '直接测量 / 配置，无派生公式'),
    formulaDependencies: list(value.formulaDependencies ?? value.dependsOn),
    relatedArchComponents: list(value.relatedArchComponents ?? value.archComponentIds),
    diagnosticMeaning: text(value.diagnosticMeaning ?? value.diagnosticUse),
    sourceUrl: text(value.sourceUrl, ''),
    asOf: text(value.asOf, ''),
  }
}

export const KPI_VIEW_MODELS = INFERENCE_KPIS.map(toKpiViewModel)

export const CATEGORY_META: Record<KpiCategoryId, { label: string; description: string; symbol: string }> = {
  experience: { label: '体验类', description: '用户真正感受到的等待与出字节奏', symbol: '①' },
  capacity: { label: '容量类', description: '系统在目标 SLO 下能承接多少流量', symbol: '②' },
  resource: { label: '资源类', description: '解释 GPU 为什么没有跑满或为何开始饱和', symbol: '③' },
  cost: { label: '成本类', description: '把容量换算为卡、服务器、机架与单位成本', symbol: '④' },
}
