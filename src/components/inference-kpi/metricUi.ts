import type { NormalizedBenchmarkRun, NormalizedMetric, SweepPoint } from '../../lib/aiperfImport'
import { findSaturationPair, type SweepDiagnosticPoint } from '../../lib/kpiEngine'

export type MetricRecord = Record<string, NormalizedMetric>

const simplify = (value: string) => value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')

export const METRIC_ALIASES = {
  systemTps: ['outputtokenthroughput', 'outputthroughput', 'systemoutputtps', 'tokenstps', 'tokenspersecond'],
  perUserTps: ['outputtokenthroughputperuser'],
  osl: ['outputsequencelength'],
  rps: ['requestthroughput', 'requestpersecond', 'requestspersecond', 'requesttps'],
  goodput: ['goodput', 'goodputrps'],
  goodFraction: ['goodrequestfraction', 'goodrequestpercentage', 'sloattainmentrate'],
  ttft: ['timetofirsttoken', 'ttft'],
  tpot: ['timeperoutputtoken', 'intertokenlatency', 'tpot', 'itl'],
  e2e: ['requestlatency', 'endtoendlatency', 'e2elatency', 'e2e'],
  gpuUtil: ['gpuutilization', 'gpuutil'],
  memoryUtil: ['gpumemoryutilization', 'gpumemoryusage', 'memoryutilization', 'hbmutilization'],
  kvUtil: ['kvcacheutilization', 'kvcacheusage', 'gpucacheusageperc', 'gpucacheusage', 'sglangtokenusage'],
  cacheHit: ['prefixcachehitrate', 'prefixcachehit', 'cachehitrate', 'cachehit'],
  queue: ['queuedrequests', 'queuedrequest', 'queuetime', 'queuesize', 'numrequestswaiting'],
  queueTime: ['queuetime', 'requestqueuetime', 'waitingtime'],
  queueDepth: ['queuedrequests', 'queuedrequest', 'queuesize', 'numrequestswaiting', 'waitingrequests', 'sglangnumqueuereqs'],
  preemption: ['preemptionrate', 'preemptionspersecond', 'numrequestspreempted', 'numpreemptions'],
} as const

export type MetricAlias = keyof typeof METRIC_ALIASES

export type MetricStatisticKey = 'mean' | 'p50' | 'p90' | 'p95' | 'p99' | 'min' | 'max' | 'value' | 'rate' | 'sum'

interface MetricMatch {
  key: string
  metric: NormalizedMetric
  encodedStatistic: MetricStatisticKey | null
}

const STATISTIC_SUFFIX = /(p50|p90|p95|p99)(?:estimate)?$|(avg|mean)$/

function statisticEncodedBy(key: string, metric: NormalizedMetric): MetricStatisticKey | null {
  for (const identity of [key, metric.name]) {
    const match = simplify(identity).match(STATISTIC_SUFFIX)
    if (!match) continue
    if (match[1]) return match[1] as MetricStatisticKey
    if (match[2]) return 'mean'
  }
  return null
}

function matchesAlias(key: string, metric: NormalizedMetric, alias: MetricAlias): boolean {
  const haystack = `${simplify(key)}${simplify(metric.name)}`
  // system TPS 只允许系统聚合输出吞吐；per-user 与 e2e per-user 两个 AIPerf 指标均不能靠子串混入。
  if (alias === 'systemTps' && (haystack.includes('peruser') || haystack.includes('e2eoutputtokenthroughput'))) {
    return false
  }
  return METRIC_ALIASES[alias].some((candidate) => haystack.includes(candidate))
}

function matchingMetrics(metrics: MetricRecord | undefined, alias: MetricAlias): MetricMatch[] {
  if (!metrics) return []
  return Object.entries(metrics)
    .filter(([key, metric]) => matchesAlias(key, metric, alias))
    .map(([key, metric]) => ({ key, metric, encodedStatistic: statisticEncodedBy(key, metric) }))
}

/** Returns every matching source series so diagnostics can aggregate across GPUs/endpoints. */
export function findMetrics(metrics: MetricRecord | undefined, alias: MetricAlias): NormalizedMetric[] {
  return matchingMetrics(metrics, alias).map((match) => match.metric)
}

function directStatistic(metric: NormalizedMetric, statistic: MetricStatisticKey): number | null {
  const keys = statistic === 'mean'
    ? ['mean', 'avg']
    : statistic.startsWith('p')
      ? [statistic, statistic.toUpperCase(), statistic.slice(1), `${statistic}_estimate`]
      : [statistic]
  for (const key of keys) {
    if (Number.isFinite(metric.stats[key])) return metric.stats[key]
  }
  return null
}

function encodedMetricValue(match: MetricMatch, statistic: MetricStatisticKey): number | null {
  const direct = directStatistic(match.metric, statistic)
  if (direct !== null) return direct
  if (match.encodedStatistic !== statistic) return null
  // 分列 aggregate 的 *_p95 / *_p99 本身是一条跨 trial 汇总指标，数值通常放在 mean；
  // 白名单之外的统计量（std/min 等）不是"该指标的值"，取不到就返回 null 走 N/A 通路。
  for (const key of ['mean', 'avg', 'value', 'rate']) {
    if (Number.isFinite(match.metric.stats[key])) return match.metric.stats[key]
  }
  return null
}

export interface MetricStatisticSelection {
  metric: NormalizedMetric
  value: number
}

/**
 * 按 alias + statistic 选择原始指标并取值。显式 *_p95/_p99 分列优先于 avg，
 * 其次才读指标内嵌的 p95/p99(_estimate)；不存在时返回 null，不让均值冒充百分位。
 */
export function selectMetricStatistic(
  metrics: MetricRecord | undefined,
  alias: MetricAlias,
  statistic: MetricStatisticKey = 'mean',
): MetricStatisticSelection | null {
  const matches = matchingMetrics(metrics, alias)
  const encoded = matches.find((match) => match.encodedStatistic === statistic && encodedMetricValue(match, statistic) !== null)
  if (encoded) return { metric: encoded.metric, value: encodedMetricValue(encoded, statistic)! }

  const embedded = matches.find((match) =>
    (statistic !== 'mean' || match.encodedStatistic === null || match.encodedStatistic === 'mean') &&
    directStatistic(match.metric, statistic) !== null,
  )
  if (embedded) return { metric: embedded.metric, value: directStatistic(embedded.metric, statistic)! }
  return null
}

/** 只取 alias + statistic 的数值；调用方需要 unit 时使用 selectMetricStatistic。 */
export function metricStatisticValue(
  metrics: MetricRecord | undefined,
  alias: MetricAlias,
  statistic: MetricStatisticKey = 'mean',
): number | null {
  return selectMetricStatistic(metrics, alias, statistic)?.value ?? null
}

export function findMetric(metrics: MetricRecord | undefined, alias: MetricAlias): NormalizedMetric | undefined {
  const matches = matchingMetrics(metrics, alias)
  if (matches.length === 0) return undefined
  if (matches.length === 1) return matches[0].metric

  // 优先以未分列指标为展示基底，其次 avg/mean；百分位分列只补对应 stats，不能覆盖 mean。
  const preferred = matches.find((match) => match.encodedStatistic === null && match.metric.available !== false && match.metric.unit.trim())
    ?? matches.find((match) => match.encodedStatistic === 'mean' && match.metric.available !== false && match.metric.unit.trim())
    ?? matches.find((match) => match.encodedStatistic === null)
    ?? matches.find((match) => match.encodedStatistic === 'mean')
    ?? matches[0]
  const stats = { ...preferred.metric.stats }
  for (const statistic of ['mean', 'p50', 'p90', 'p95', 'p99'] as const) {
    const selected = selectMetricStatistic(metrics, alias, statistic)
    if (selected) stats[statistic] = selected.value
  }
  return { ...preferred.metric, stats }
}

export function metricValue(metric: NormalizedMetric | undefined, statistic = 'mean'): number | null {
  if (!metric) return null
  const stats = metric.stats
  const preferred = [statistic, statistic === 'mean' ? 'avg' : '', 'mean', 'avg', 'value', 'rate', 'p50', 'sum']
  for (const key of preferred) {
    if (key && Number.isFinite(stats[key])) return stats[key]
  }
  // 不做任意 stat 兜底：只剩 std/min 之类时它们不能冒充均值，返回 null 走 N/A 通路。
  return null
}

export function percentileValue(metric: NormalizedMetric | undefined, percentile: 'p95' | 'p99'): number | null {
  if (!metric) return null
  const stats = metric.stats
  const exact = [percentile, percentile.toUpperCase(), percentile.replace('p', ''), `${percentile}_estimate`]
  for (const key of exact) {
    if (Number.isFinite(stats[key])) return stats[key]
  }
  // Sweep aggregate 常把统计量放在 metric tag（如 *_p95），其值则存在 mean。
  // 只有这种情况才允许回退；普通 avg 不能冒充 p95/p99。
  return simplify(metric.name).includes(percentile) ? metricValue(metric) : null
}

const compactUnit = (unit: string) => unit.trim().toLowerCase().replace(/\s+/g, '')

function perSecondScale(unit: string, family: 'request' | 'token'): number | null {
  const normalized = compactUnit(unit)
  const hasFamily = family === 'request'
    ? normalized.includes('request') || normalized.includes('req')
    : normalized.includes('token')
  if (!hasFamily) return null
  if (/\/(?:s|sec|second|seconds)(?:\/|$)/.test(normalized) || normalized.includes('persecond')) return 1
  if (/\/(?:min|minute|minutes)(?:\/|$)/.test(normalized) || normalized.includes('perminute')) return 1 / 60
  if (/\/(?:h|hr|hour|hours)(?:\/|$)/.test(normalized) || normalized.includes('perhour')) return 1 / 3600
  return null
}

function ratePerSecond(metric: NormalizedMetric | undefined, family: 'request' | 'token'): number | null {
  const value = metricValue(metric)
  if (!metric || value === null) return null
  const scale = perSecondScale(metric.unit, family)
  return scale === null ? null : value * scale
}

/** 按 artifact unit 归一为 requests/s；未知单位不猜测。 */
export const requestRatePerSecond = (metric: NormalizedMetric | undefined): number | null =>
  ratePerSecond(metric, 'request')

/** 按 artifact unit 归一为 output tokens/s；未知单位不猜测。 */
export const tokenRatePerSecond = (metric: NormalizedMetric | undefined): number | null =>
  ratePerSecond(metric, 'token')

/** 按 artifact unit 归一为 0..1 的 attainment fraction。 */
export function fractionValue(metric: NormalizedMetric | undefined): number | null {
  const value = metricValue(metric)
  if (!metric || value === null) return null
  const unit = compactUnit(metric.unit)
  const isPercent = unit === '%' || unit.includes('percent')
  const isFraction = unit === '1' || unit.includes('ratio') || unit.includes('fraction') || unit.includes('proportion')
  if (!isPercent && !isFraction) return null
  const fraction = isPercent ? value / 100 : value
  return Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction : null
}

/** 按 artifact unit 归一为毫秒；未知单位不猜测。 */
export function latencyPercentileMs(
  metric: NormalizedMetric | undefined,
  percentile: 'p95' | 'p99',
): number | null {
  const value = percentileValue(metric, percentile)
  if (!metric || value === null) return null
  const unit = compactUnit(metric.unit)
  if (/^(?:ms|millisecond|milliseconds)(?:\/|$)/.test(unit)) return value
  if (/^(?:us|µs|microsecond|microseconds)(?:\/|$)/.test(unit)) return value / 1000
  if (/^(?:s|sec|second|seconds)(?:\/|$)/.test(unit)) return value * 1000
  return null
}

function latencyValueMs(value: number, unit: string): number | null {
  const normalized = compactUnit(unit)
  if (/^(?:ms|millisecond|milliseconds)(?:\/|$)/.test(normalized)) return value
  if (/^(?:us|µs|microsecond|microseconds)(?:\/|$)/.test(normalized)) return value / 1000
  if (/^(?:ns|nanosecond|nanoseconds)(?:\/|$)/.test(normalized)) return value / 1_000_000
  if (/^(?:s|sec|second|seconds)(?:\/|$)/.test(normalized)) return value * 1000
  return null
}

/** 给 Little's Law 等公式使用：按 alias 选择 mean，并严格按 artifact unit 归一为 ms。 */
export function meanLatencyMs(metrics: MetricRecord | undefined, alias: MetricAlias): number | null {
  const selection = selectMetricStatistic(metrics, alias, 'mean')
  return selection ? latencyValueMs(selection.value, selection.metric.unit) : null
}

/** Selects the percentile together with its own source unit before converting to ms. */
export function latencyStatisticMs(
  metrics: MetricRecord | undefined,
  alias: MetricAlias,
  statistic: 'p95' | 'p99',
): number | null {
  const selection = selectMetricStatistic(metrics, alias, statistic)
  return selection ? latencyValueMs(selection.value, selection.metric.unit) : null
}

export function metricUnit(metric: NormalizedMetric | undefined, fallback = ''): string {
  return metric?.unit || fallback
}

export function formatMetric(value: number | null | undefined, unit = '', digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A'
  const absolute = Math.abs(value)
  const shown = absolute >= 10_000
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value)
    : value.toLocaleString('zh-CN', { maximumFractionDigits: digits })
  return `${shown}${unit ? ` ${unit}` : ''}`
}

function sharedSweepAxis(points: readonly SweepPoint[]): string | null {
  if (points.length === 0) return null
  const keys = new Set(points.flatMap((point) => Object.keys(point.coordinates)))
  const varying = [...keys].filter((key) => {
    const values = points.map((point) => JSON.stringify(point.coordinates[key]))
    return new Set(values).size > 1
  })

  if (varying.length === 1) {
    const key = varying[0]
    return points.every((point) => typeof point.coordinates[key] === 'number' && Number.isFinite(point.coordinates[key]))
      ? key
      : null
  }

  // 单点或重复 trial 没有“变化”维度时，仅在整个坐标中恰有一个共同数值轴才可画。
  if (varying.length === 0) {
    const numeric = [...keys].filter((key) =>
      points.every((point) => typeof point.coordinates[key] === 'number' && Number.isFinite(point.coordinates[key])),
    )
    return numeric.length === 1 ? numeric[0] : null
  }
  return null
}

export interface SweepChartPoint {
  key: string
  x: number
  xLabel: string
  systemTps: number | null
  rps: number | null
  goodput: number | null
  goodFraction: number | null
  ttftP95: number | null
  tpotP95: number | null
  e2eP95: number | null
  e2eP99: number | null
  source: SweepPoint
}

export interface SweepPointGroup {
  key: string
  label: string
  sweepId: string | null
  sourceName: string | null
  points: SweepPoint[]
}

/** Sweep ID is authoritative; legacy/no-ID exports are isolated by source file, never merged globally. */
export function sweepPointGroupKey(point: SweepPoint): string {
  const sweepId = point.sweepId?.trim()
  if (sweepId) return `sweep:${sweepId}`
  const sourceName = point.sourceName?.trim()
  if (sourceName) return `source:${sourceName}`
  // Missing both identifiers is ambiguous: isolate the point instead of inventing a shared experiment.
  return `point:${point.key}`
}

export function groupSweepPoints(points: readonly SweepPoint[]): SweepPointGroup[] {
  const groups = new Map<string, SweepPointGroup>()
  for (const point of points) {
    const key = sweepPointGroupKey(point)
    const existing = groups.get(key)
    if (existing) {
      existing.points.push(point)
      continue
    }
    const sweepId = point.sweepId?.trim() || null
    const sourceName = point.sourceName?.trim() || null
    groups.set(key, {
      key,
      label: sweepId ?? sourceName ?? `未标识 Sweep · ${point.key}`,
      sweepId,
      sourceName,
      points: [point],
    })
  }
  return [...groups.values()]
}

export function toSweepChartPoints(points: SweepPoint[]): SweepChartPoint[] {
  const validPoints = points.filter((point) => point.valid)
  const axis = sharedSweepAxis(validPoints)
  if (axis === null) return []
  return validPoints
    .map((point) => {
      return {
        key: point.key,
        x: point.coordinates[axis] as number,
        xLabel: axis,
        systemTps: tokenRatePerSecond(findMetric(point.metrics, 'systemTps')),
        rps: requestRatePerSecond(findMetric(point.metrics, 'rps')),
        goodput: requestRatePerSecond(findMetric(point.metrics, 'goodput')),
        goodFraction: fractionValue(findMetric(point.metrics, 'goodFraction')),
        ttftP95: latencyStatisticMs(point.metrics, 'ttft', 'p95'),
        tpotP95: latencyStatisticMs(point.metrics, 'tpot', 'p95'),
        e2eP95: latencyStatisticMs(point.metrics, 'e2e', 'p95'),
        e2eP99: latencyStatisticMs(point.metrics, 'e2e', 'p99'),
        source: point,
      }
    })
    .sort((a, b) => a.x - b.x)
}

export function getRunLabel(run: NormalizedBenchmarkRun): string {
  // variation 缺失时回退来源文件名：多个无 variation 的 run 才能相互区分，不全叫 default
  const variation = run.variation || run.sourceNames[0] || 'default'
  const trial = run.trial === undefined ? '' : ` · trial ${run.trial}`
  return `${variation}${trial}`
}

/** 渲染侧百分比取整（保留一位小数）：0.29 显示 29 而非 28.999999999999996。 */
export function percentValue(fraction: number): number {
  return Math.round(fraction * 1000) / 10
}

/** 图表点与引擎诊断点共用同一映射，图表口径与诊断口径不允许各自漂移。 */
export function toSweepDiagnosticPoint(point: SweepChartPoint): SweepDiagnosticPoint {
  return {
    load: point.x,
    systemOutputTps: point.systemTps,
    rps: point.rps,
    goodputRps: point.goodput,
    ttftP95Ms: point.ttftP95,
    tpotP95Ms: point.tpotP95,
    e2eP95Ms: point.e2eP95,
  }
}

/** 饱和判定只保留 kpiEngine 一份实现；这里仅做图表点到诊断点的映射与回指。 */
export function saturationPoint(points: SweepChartPoint[]): SweepChartPoint | null {
  const pair = findSaturationPair(points.map((point) => ({ ...toSweepDiagnosticPoint(point), chart: point })))
  return pair === null ? null : pair[1].chart
}

export function paretoKeys(points: SweepChartPoint[]): Set<string> {
  const hasOfficialMembership = points.some((point) => point.source.paretoOptimal !== undefined)
  if (hasOfficialMembership) {
    return new Set(points.filter((point) => point.source.paretoOptimal === true).map((point) => point.key))
  }
  const eligible = points.filter((point) => point.systemTps !== null && point.e2eP95 !== null)
  return new Set(
    eligible
      .filter((candidate) =>
        !eligible.some(
          (other) =>
            other.key !== candidate.key &&
            (other.systemTps ?? 0) >= (candidate.systemTps ?? 0) &&
            (other.e2eP95 ?? Infinity) <= (candidate.e2eP95 ?? Infinity) &&
            ((other.systemTps ?? 0) > (candidate.systemTps ?? 0) ||
              (other.e2eP95 ?? Infinity) < (candidate.e2eP95 ?? Infinity)),
        ),
      )
      .map((point) => point.key),
  )
}

/** 进程级单调 counter：Prometheus counter 类型，或 *_total / cumulative 命名（如 vllm:num_preemptions_total）。 */
export function isCumulativeCounter(metric: NormalizedMetric): boolean {
  if (metric.metricType?.trim().toLowerCase() === 'counter') return true
  const name = simplify(metric.name)
  return name.endsWith('total') || name.includes('cumulative')
}

export interface PreemptionEvidence {
  ratePerSecond: number | null
  countInWindow: number | null
}

/**
 * 抢占证据只有两条合法通路：真正的窗口速率（stats.rate 或单位含 /s），
 * 以及非 counter 语义的采样窗口计数。单调累计 counter 是启动以来的总量，
 * 拿不到窗口差分时宁可双双置 null 抑制规则，也不能当窗口计数误报。
 */
export function preemptionEvidence(metrics: readonly NormalizedMetric[]): PreemptionEvidence {
  const rates = metrics.flatMap((metric) => {
    if (Number.isFinite(metric.stats.rate)) return [metric.stats.rate]
    const unit = metric.unit.toLowerCase()
    const value = metricValue(metric)
    return value !== null && (unit.includes('/s') || unit.includes('per second')) ? [value] : []
  })
  const ratePerSecond = rates.length > 0 ? Math.max(...rates) : null
  const counts = ratePerSecond === null
    ? metrics.flatMap((metric) => {
        if (isCumulativeCounter(metric)) return []
        const value = metricValue(metric)
        return value === null ? [] : [value]
      })
    : []
  return { ratePerSecond, countInWindow: counts.length > 0 ? Math.max(...counts) : null }
}

export function hasMetric(metrics: MetricRecord | undefined, alias: MetricAlias): boolean {
  const metric = findMetric(metrics, alias)
  return Boolean(metric && metric.available !== false && metric.unit.trim() && metricValue(metric) !== null)
}
