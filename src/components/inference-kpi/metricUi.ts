import type { NormalizedBenchmarkRun, NormalizedMetric, SweepPoint } from '../../lib/aiperfImport'

export type MetricRecord = Record<string, NormalizedMetric>

const simplify = (value: string) => value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')

export const METRIC_ALIASES = {
  systemTps: ['outputtokenthroughput', 'outputthroughput', 'systemoutputtps', 'tokenstps', 'tokenspersecond'],
  rps: ['requestthroughput', 'requestpersecond', 'requestspersecond', 'requesttps'],
  goodput: ['goodput', 'goodputrps'],
  goodFraction: ['goodrequestfraction', 'goodrequestpercentage', 'sloattainmentrate'],
  ttft: ['timetofirsttoken', 'ttft'],
  tpot: ['timeperoutputtoken', 'intertokenlatency', 'tpot', 'itl'],
  e2e: ['requestlatency', 'endtoendlatency', 'e2elatency', 'e2e'],
  gpuUtil: ['gpuutilization', 'gpuutil'],
  memoryUtil: ['gpumemoryutilization', 'gpumemoryusage', 'memoryutilization', 'hbmutilization'],
  kvUtil: ['kvcacheutilization', 'kvcacheusage', 'gpucacheusageperc', 'gpucacheusage'],
  cacheHit: ['prefixcachehitrate', 'prefixcachehit', 'cachehitrate', 'cachehit'],
  queue: ['queuedrequests', 'queuedrequest', 'queuetime', 'queuesize', 'numrequestswaiting'],
  queueTime: ['queuetime', 'requestqueuetime', 'waitingtime'],
  queueDepth: ['queuedrequests', 'queuedrequest', 'queuesize', 'numrequestswaiting', 'waitingrequests'],
  preemption: ['preemptionrate', 'preemptionspersecond', 'numrequestspreempted'],
} as const

export type MetricAlias = keyof typeof METRIC_ALIASES

export function findMetric(metrics: MetricRecord | undefined, alias: MetricAlias): NormalizedMetric | undefined {
  if (!metrics) return undefined
  const candidates = METRIC_ALIASES[alias]
  return Object.entries(metrics).find(([key, metric]) => {
    const haystack = `${simplify(key)}${simplify(metric.name)}`
    // AIPerf 的 output_token_throughput_per_user 是单用户速度，绝不能因子串匹配被当成系统 TPS。
    if (alias === 'systemTps' && haystack.includes('peruser')) return false
    return candidates.some((candidate) => haystack.includes(candidate))
  })?.[1]
}

export function metricValue(metric: NormalizedMetric | undefined, statistic = 'mean'): number | null {
  if (!metric) return null
  const stats = metric.stats
  const preferred = [statistic, statistic === 'mean' ? 'avg' : '', 'mean', 'avg', 'value', 'rate', 'p50', 'sum']
  for (const key of preferred) {
    if (key && Number.isFinite(stats[key])) return stats[key]
  }
  const first = Object.values(stats).find(Number.isFinite)
  return first ?? null
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

const coordinateValue = (point: SweepPoint): { value: number; label: string } => {
  const entries = Object.entries(point.coordinates)
  const preferred = entries.find(([key, value]) =>
    typeof value === 'number' && /concurr|request.?rate|rps|clients?|batch/i.test(key),
  )
  const numeric = preferred ?? entries.find(([, value]) => typeof value === 'number')
  return {
    value: typeof numeric?.[1] === 'number' ? numeric[1] : (point.variationIndex ?? 0),
    label: numeric?.[0] ?? 'variation',
  }
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

export function toSweepChartPoints(points: SweepPoint[]): SweepChartPoint[] {
  return points
    .filter((point) => point.valid)
    .map((point) => {
      const coordinate = coordinateValue(point)
      const e2e = findMetric(point.metrics, 'e2e')
      return {
        key: point.key,
        x: coordinate.value,
        xLabel: coordinate.label,
        systemTps: tokenRatePerSecond(findMetric(point.metrics, 'systemTps')),
        rps: requestRatePerSecond(findMetric(point.metrics, 'rps')),
        goodput: requestRatePerSecond(findMetric(point.metrics, 'goodput')),
        goodFraction: fractionValue(findMetric(point.metrics, 'goodFraction')),
        ttftP95: latencyPercentileMs(findMetric(point.metrics, 'ttft'), 'p95'),
        tpotP95: latencyPercentileMs(findMetric(point.metrics, 'tpot'), 'p95'),
        e2eP95: latencyPercentileMs(e2e, 'p95'),
        e2eP99: latencyPercentileMs(e2e, 'p99'),
        source: point,
      }
    })
    .sort((a, b) => a.x - b.x)
}

export function getRunLabel(run: NormalizedBenchmarkRun): string {
  const variation = run.variation || 'default'
  const trial = run.trial === undefined ? '' : ` · trial ${run.trial}`
  return `${variation}${trial}`
}

export function saturationPoint(points: SweepChartPoint[]): SweepChartPoint | null {
  const peak = Math.max(...points.map((point) => point.systemTps ?? -Infinity))
  if (!Number.isFinite(peak) || peak <= 0) return null
  return points.find((point) => (point.systemTps ?? 0) >= peak * 0.95) ?? null
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

export function hasMetric(metrics: MetricRecord | undefined, alias: MetricAlias): boolean {
  return Boolean(findMetric(metrics, alias))
}
