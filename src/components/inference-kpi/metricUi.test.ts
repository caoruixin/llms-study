import { describe, expect, it } from 'vitest'
import type { NormalizedMetric } from '../../lib/aiperfImport'
import {
  findMetric,
  fractionValue,
  latencyPercentileMs,
  percentileValue,
  requestRatePerSecond,
  tokenRatePerSecond,
} from './metricUi'

const metric = (name: string, unit: string, stats: Record<string, number>): NormalizedMetric => ({
  name,
  unit,
  stats,
  unknown: false,
})

describe('inference KPI metric UI normalization', () => {
  it('never mistakes per-user throughput for system TPS', () => {
    const perUser = metric('output_token_throughput_per_user', 'tokens/sec/user', { avg: 42 })
    const system = metric('output_token_throughput', 'tokens/sec', { avg: 8000 })

    expect(findMetric({ perUser }, 'systemTps')).toBeUndefined()
    expect(findMetric({ perUser, system }, 'systemTps')).toBe(system)
  })

  it('does not label an average as p95 unless the sweep metric tag encodes p95', () => {
    expect(percentileValue(metric('time_to_first_token', 'ms', { avg: 100 }), 'p95')).toBeNull()
    expect(percentileValue(metric('time_to_first_token_p95', 'ms', { mean: 140 }), 'p95')).toBe(140)
    expect(percentileValue(metric('server_latency', 's', { p99_estimate: 2.5 }), 'p99')).toBe(2.5)
  })

  it('uses artifact units when normalizing latency and rates', () => {
    expect(latencyPercentileMs(metric('request_latency', 'seconds', { p95: 1.2 }), 'p95')).toBe(1200)
    expect(latencyPercentileMs(metric('request_latency', 'µs', { p95: 1500 }), 'p95')).toBe(1.5)
    expect(latencyPercentileMs(metric('request_latency', 'ticks', { p95: 12 }), 'p95')).toBeNull()

    expect(requestRatePerSecond(metric('goodput', 'requests/minute', { avg: 120 }))).toBe(2)
    expect(requestRatePerSecond(metric('goodput', 'widgets/sec', { avg: 120 }))).toBeNull()
    expect(tokenRatePerSecond(metric('output_token_throughput', 'tokens/hour', { avg: 3600 }))).toBe(1)
  })

  it('normalizes attainment percentages to a 0..1 fraction', () => {
    expect(fractionValue(metric('good_request_fraction', '%', { avg: 97 }))).toBe(0.97)
    expect(fractionValue(metric('good_request_fraction', 'ratio', { avg: 0.97 }))).toBe(0.97)
    expect(fractionValue(metric('good_request_fraction', 'ratio', { avg: 1.1 }))).toBeNull()
    expect(fractionValue(metric('good_request_fraction', 'widgets', { avg: 0.97 }))).toBeNull()
  })
})
