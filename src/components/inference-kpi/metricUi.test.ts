import { describe, expect, it } from 'vitest'
import type { NormalizedBenchmarkRun, NormalizedMetric, SweepPoint } from '../../lib/aiperfImport'
import {
  findMetric,
  findMetrics,
  fractionValue,
  getRunLabel,
  groupSweepPoints,
  hasMetric,
  isCumulativeCounter,
  latencyPercentileMs,
  latencyStatisticMs,
  meanLatencyMs,
  metricStatisticValue,
  metricValue,
  paretoKeys,
  percentValue,
  percentileValue,
  preemptionEvidence,
  requestRatePerSecond,
  saturationPoint,
  selectMetricStatistic,
  toSweepChartPoints,
  tokenRatePerSecond,
  type SweepChartPoint,
} from './metricUi'

const metric = (name: string, unit: string, stats: Record<string, number>): NormalizedMetric => ({
  name,
  unit,
  stats,
  unknown: false,
})

const sweepPoint = (key: string, coordinates: Record<string, unknown>): SweepPoint => ({
  key,
  variation: key,
  coordinates,
  metrics: {},
  valid: true,
})

const sweepPointWithMetrics = (
  key: string,
  coordinates: Record<string, unknown>,
  metrics: Record<string, NormalizedMetric>,
): SweepPoint => ({ ...sweepPoint(key, coordinates), metrics })

const chartPoint = (
  x: number,
  systemTps: number,
  e2eP95: number | null,
  goodput: number | null,
): SweepChartPoint => ({
  key: String(x),
  x,
  xLabel: 'concurrency',
  systemTps,
  rps: null,
  goodput,
  goodFraction: null,
  ttftP95: null,
  tpotP95: null,
  e2eP95,
  e2eP99: null,
  source: sweepPoint(String(x), { concurrency: x }),
})

describe('inference KPI metric UI normalization', () => {
  it('never mistakes per-user throughput for system TPS', () => {
    const perUser = metric('output_token_throughput_per_user', 'tokens/sec/user', { avg: 42 })
    const e2ePerUser = metric('e2e_output_token_throughput', 'tokens/sec/user', { avg: 40 })
    const system = metric('output_token_throughput', 'tokens/sec', { avg: 8000 })

    expect(findMetric({ perUser }, 'systemTps')).toBeUndefined()
    expect(findMetric({ e2ePerUser }, 'systemTps')).toBeUndefined()
    expect(findMetric({ perUser, system }, 'systemTps')).toBe(system)
    // per-user 有自己的 alias，与系统 TPS 互不吞并。
    expect(findMetric({ perUser, system }, 'perUserTps')).toBe(perUser)
    expect(findMetric({ system }, 'perUserTps')).toBeUndefined()
  })

  it('selects the average output sequence length for the E2E cross-check', () => {
    const metrics = { output_sequence_length: metric('output_sequence_length', 'tokens', { avg: 511.6 }) }
    expect(metricStatisticValue(metrics, 'osl', 'mean')).toBe(511.6)
    expect(metricStatisticValue({}, 'osl', 'mean')).toBeNull()
  })

  it('returns all server series and recognizes vLLM preemption counters', () => {
    const metrics = {
      gpu0: metric('nvidia_gpu_utilization', '%', { mean: 20 }),
      gpu1: metric('nvidia_gpu_utilization', '%', { mean: 95 }),
      preemptions: metric('vllm:num_preemptions', 'requests', { mean: 3 }),
    }
    expect(findMetrics(metrics, 'gpuUtil')).toHaveLength(2)
    expect(findMetric(metrics, 'preemption')).toBe(metrics.preemptions)
  })

  it('recognizes official SGLang queue depth and KV token usage metrics', () => {
    const metrics = {
      'sglang:num_queue_reqs': metric('sglang:num_queue_reqs', 'requests', { avg: 4 }),
      'sglang:token_usage': metric('sglang:token_usage', 'ratio', { avg: 0.82 }),
    }

    expect(findMetric(metrics, 'queueDepth')).toBe(metrics['sglang:num_queue_reqs'])
    expect(findMetric(metrics, 'kvUtil')).toBe(metrics['sglang:token_usage'])
  })

  it('merges split avg/p95/p99 columns by alias without letting avg shadow a percentile', () => {
    const metrics = {
      time_to_first_token_avg: metric('time_to_first_token_avg', 'ms', { mean: 100 }),
      time_to_first_token_p95: metric('time_to_first_token_p95', 'ms', { mean: 180 }),
      request_latency_avg: metric('request_latency_avg', 'ms', { mean: 1200 }),
      request_latency_p99: metric('request_latency_p99', 'ms', { mean: 2800 }),
    }

    const ttft = findMetric(metrics, 'ttft')
    expect(metricValue(ttft, 'mean')).toBe(100)
    expect(percentileValue(ttft, 'p95')).toBe(180)
    expect(metricStatisticValue(metrics, 'ttft', 'p95')).toBe(180)
    expect(selectMetricStatistic(metrics, 'ttft', 'p95')?.metric).toBe(metrics.time_to_first_token_p95)
    expect(metricStatisticValue(metrics, 'e2e', 'mean')).toBe(1200)
    expect(metricStatisticValue(metrics, 'e2e', 'p99')).toBe(2800)
    expect(latencyStatisticMs({
      time_to_first_token_avg: metric('time_to_first_token_avg', 'ms', { mean: 100 }),
      time_to_first_token_p95: metric('time_to_first_token_p95', 'seconds', { mean: 0.18 }),
    }, 'ttft', 'p95')).toBe(180)
  })

  it('returns null instead of presenting std/min as the requested statistic', () => {
    const onlyStd = { time_to_first_token_p95: metric('time_to_first_token_p95', 'ms', { std: 1.2 }) }
    expect(metricStatisticValue(onlyStd, 'ttft', 'p95')).toBeNull()
    expect(selectMetricStatistic(onlyStd, 'ttft', 'p95')).toBeNull()

    expect(metricValue(metric('time_to_first_token', 'ms', { std: 1.2, min: 3 }))).toBeNull()
    expect(metricValue(metric('time_to_first_token', 'ms', { std: 1.2, min: 3 }), 'min')).toBe(3)
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

  it('normalizes an alias-selected mean E2E latency to milliseconds', () => {
    expect(meanLatencyMs({ request_latency_avg: metric('request_latency_avg', 'seconds', { mean: 1.25 }) }, 'e2e')).toBe(1250)
    expect(meanLatencyMs({ request_latency_avg: metric('request_latency_avg', 'ns', { mean: 2_000_000 }) }, 'e2e')).toBe(2)
    expect(meanLatencyMs({ request_latency_avg: metric('request_latency_avg', 'ticks', { mean: 12 }) }, 'e2e')).toBeNull()
  })

  it('normalizes attainment percentages to a 0..1 fraction', () => {
    expect(fractionValue(metric('good_request_fraction', '%', { avg: 97 }))).toBe(0.97)
    expect(fractionValue(metric('good_request_fraction', 'ratio', { avg: 0.97 }))).toBe(0.97)
    expect(fractionValue(metric('good_request_fraction', 'ratio', { avg: 1.1 }))).toBeNull()
    expect(fractionValue(metric('good_request_fraction', 'widgets', { avg: 0.97 }))).toBeNull()
  })

  it('does not count an unavailable unit-less metric as usable data', () => {
    const unavailable = { ...metric('goodput', '', {}), available: false, rawStats: { mean: 10 } }
    expect(hasMetric({ goodput: unavailable }, 'goodput')).toBe(false)
  })

  it('refuses to mix a multi-dimensional sweep into one chart axis', () => {
    const oneDimension = [
      sweepPoint('a', { concurrency: 8, input_tokens: 2048, engine: 'vllm' }),
      sweepPoint('b', { concurrency: 16, input_tokens: 2048, engine: 'vllm' }),
    ]
    expect(toSweepChartPoints(oneDimension).map((point) => point.x)).toEqual([8, 16])

    const twoNumericDimensions = [
      sweepPoint('a', { concurrency: 8, input_tokens: 2048 }),
      sweepPoint('b', { concurrency: 16, input_tokens: 4096 }),
    ]
    expect(toSweepChartPoints(twoNumericDimensions)).toEqual([])

    const numericAndCategoricalDimensions = [
      sweepPoint('a', { concurrency: 8, engine: 'vllm' }),
      sweepPoint('b', { concurrency: 16, engine: 'sglang' }),
    ]
    expect(toSweepChartPoints(numericAndCategoricalDimensions)).toEqual([])
  })

  it('maps sweep metrics onto chart fields with per-statistic selection and unit normalization', () => {
    const point = sweepPointWithMetrics('c8', { concurrency: 8 }, {
      output_token_throughput: metric('output_token_throughput', 'tokens/min', { avg: 60000 }),
      request_throughput: metric('request_throughput', 'requests/min', { avg: 120 }),
      goodput: metric('goodput', 'requests/sec', { avg: 5 }),
      good_request_fraction: metric('good_request_fraction', '%', { avg: 97 }),
      time_to_first_token: metric('time_to_first_token', 'seconds', { avg: 0.1, p95: 0.18 }),
      // tpot 走分列 *_p95 通路：p95 数值放在该列的 mean，avg 列不得冒充。
      time_per_output_token_avg: metric('time_per_output_token_avg', 'ms', { mean: 10 }),
      time_per_output_token_p95: metric('time_per_output_token_p95', 'ms', { mean: 12 }),
      request_latency: metric('request_latency', 'seconds', { avg: 1, p95: 1.2, p99: 2.5 }),
    })

    const [chart] = toSweepChartPoints([point])
    expect(chart.key).toBe('c8')
    expect(chart.x).toBe(8)
    expect(chart.xLabel).toBe('concurrency')
    expect(chart.source).toBe(point)
    // 吞吐类按 unit 归一到 /s：tokens/min、requests/min ÷60,requests/sec 原样。
    expect(chart.systemTps).toBe(1000)
    expect(chart.rps).toBe(2)
    expect(chart.goodput).toBe(5)
    expect(chart.goodFraction).toBe(0.97)
    // 延迟类取 p95/p99 统计量(而非 avg)并按 unit 归一为 ms。
    expect(chart.ttftP95).toBeCloseTo(180)
    expect(chart.tpotP95).toBe(12)
    expect(chart.e2eP95).toBeCloseTo(1200)
    expect(chart.e2eP99).toBeCloseTo(2500)
  })

  it('nulls chart fields whose unit is missing or unknown instead of guessing', () => {
    const point = sweepPointWithMetrics('c8', { concurrency: 8 }, {
      output_token_throughput: metric('output_token_throughput', '', { avg: 8000 }),
      request_throughput: metric('request_throughput', 'widgets/sec', { avg: 12 }),
      goodput: metric('goodput', 'requests', { avg: 5 }),
      good_request_fraction: metric('good_request_fraction', 'widgets', { avg: 0.9 }),
      time_to_first_token: metric('time_to_first_token', 'ticks', { p95: 100 }),
      request_latency: metric('request_latency', 'seconds', { p95: 1.2 }),
    })

    const [chart] = toSweepChartPoints([point])
    expect(chart.systemTps).toBeNull()
    expect(chart.rps).toBeNull()
    expect(chart.goodput).toBeNull()
    expect(chart.goodFraction).toBeNull()
    expect(chart.ttftP95).toBeNull()
    expect(chart.tpotP95).toBeNull() // 指标缺失同样走 null
    expect(chart.e2eP95).toBeCloseTo(1200)
    expect(chart.e2eP99).toBeNull() // p99 统计量缺失不能拿 p95 顶替
  })

  it('drops invalid sweep points before axis detection and sorts by the shared axis', () => {
    const tps = (value: number) => ({
      output_token_throughput: metric('output_token_throughput', 'tokens/sec', { avg: value }),
    })
    const points = [
      sweepPointWithMetrics('c32', { concurrency: 32, input_tokens: 2048 }, tps(9000)),
      sweepPointWithMetrics('c8', { concurrency: 8, input_tokens: 2048 }, tps(4000)),
      // invalid 点连带第二个变化维度:若未先过滤,轴检测会因多维直接判空。
      { ...sweepPointWithMetrics('bad', { concurrency: 4, input_tokens: 4096 }, tps(1)), valid: false },
    ]

    const charts = toSweepChartPoints(points)
    expect(charts.map((chart) => chart.key)).toEqual(['c8', 'c32'])
    expect(charts.map((chart) => chart.x)).toEqual([8, 32])
    expect(charts.map((chart) => chart.systemTps)).toEqual([4000, 9000])
  })

  it('groups by sweepId and falls back to sourceName without cross-sweep merging', () => {
    const points = [
      { ...sweepPoint('a-1', { concurrency: 8 }), sweepId: 'sweep-a', sourceName: 'a.json' },
      { ...sweepPoint('a-2', { concurrency: 16 }), sweepId: 'sweep-a', sourceName: 'other-a.json' },
      { ...sweepPoint('b-1', { concurrency: 8 }), sweepId: 'sweep-b', sourceName: 'b.json' },
      { ...sweepPoint('legacy-1', { concurrency: 4 }), sourceName: 'legacy.csv' },
      { ...sweepPoint('legacy-2', { concurrency: 8 }), sourceName: 'legacy.csv' },
      sweepPoint('anonymous-1', { concurrency: 1 }),
      sweepPoint('anonymous-2', { concurrency: 2 }),
    ]

    expect(groupSweepPoints(points).map((group) => [group.key, group.points.map((point) => point.key)])).toEqual([
      ['sweep:sweep-a', ['a-1', 'a-2']],
      ['sweep:sweep-b', ['b-1']],
      ['source:legacy.csv', ['legacy-1', 'legacy-2']],
      ['point:anonymous-1', ['anonymous-1']],
      ['point:anonymous-2', ['anonymous-2']],
    ])
  })

  it('never treats a cumulative preemption counter as an in-window count', () => {
    const cumulativeByName = metric('vllm:num_preemptions_total', 'preemptions', { value: 1874 })
    const cumulativeByType = { ...metric('vllm:num_preemptions', 'preemptions', { value: 1874 }), metricType: 'counter' }
    const sampledWindow = metric('vllm:num_preemptions', 'requests', { mean: 3 })
    const trueRate = metric('preemption_rate', 'preemptions/s', { rate: 1.5 })

    expect(isCumulativeCounter(cumulativeByName)).toBe(true)
    expect(isCumulativeCounter(cumulativeByType)).toBe(true)
    expect(isCumulativeCounter(sampledWindow)).toBe(false)

    // 单调 counter：既不是速率也不是窗口计数，规则输入双双为 null。
    expect(preemptionEvidence([cumulativeByName])).toEqual({ ratePerSecond: null, countInWindow: null })
    expect(preemptionEvidence([cumulativeByType])).toEqual({ ratePerSecond: null, countInWindow: null })
    // 采样窗口计数与真正的窗口速率各走各的分支。
    expect(preemptionEvidence([sampledWindow])).toEqual({ ratePerSecond: null, countInWindow: 3 })
    expect(preemptionEvidence([cumulativeByName, trueRate])).toEqual({ ratePerSecond: 1.5, countInWindow: null })
  })

  it('marks saturation only when extra load stops throughput and worsens latency or Goodput', () => {
    const linear = [
      chartPoint(10, 100, 100, 90),
      chartPoint(20, 200, 105, 180),
      chartPoint(30, 300, 110, 270),
    ]
    expect(saturationPoint(linear)).toBeNull()

    const plateau = [
      chartPoint(10, 100, 100, 90),
      chartPoint(20, 104, 120, 91),
    ]
    expect(saturationPoint(plateau)?.x).toBe(20)

    const unsupportedPlateau = [
      chartPoint(10, 100, null, null),
      chartPoint(20, 103, null, null),
    ]
    expect(saturationPoint(unsupportedPlateau)).toBeNull()
  })

  it('does not compare a TTFT tail against an E2E tail across sweep points', () => {
    // 前一点只有 TTFT p95、后一点只有 E2E p95：旧实现会拿 2000/300 判成 6.7× 恶化误报。
    const mixed = [
      { ...chartPoint(10, 100, null, null), ttftP95: 300 },
      { ...chartPoint(20, 103, 2000, null), ttftP95: null },
    ]
    expect(saturationPoint(mixed)).toBeNull()

    // 两端同为 TTFT 时仍能判定（吞吐平台 + TTFT 恶化）。
    const sameMetric = [
      { ...chartPoint(10, 100, null, null), ttftP95: 300 },
      { ...chartPoint(20, 103, null, null), ttftP95: 450 },
    ]
    expect(saturationPoint(sameMetric)?.x).toBe(20)
  })
})

describe('paretoKeys', () => {
  const withMembership = (point: SweepChartPoint, paretoOptimal: boolean | undefined): SweepChartPoint => ({
    ...point,
    source: { ...point.source, paretoOptimal },
  })

  it('lets official Pareto membership override derived dominance entirely', () => {
    // a 在数值上被 b/c 双双支配,但官方标记说它在前沿:官方口径优先。
    const a = withMembership({ ...chartPoint(8, 100, 500, null), key: 'a' }, true)
    const b = withMembership({ ...chartPoint(16, 300, 100, null), key: 'b' }, false)
    // 存在官方标记时,未标记的点视为不在前沿,不再做支配推导。
    const c = { ...chartPoint(32, 400, 50, null), key: 'c' }

    expect(paretoKeys([a, b, c])).toEqual(new Set(['a']))
    // 官方标记全为 false → 空前沿,同样不回退推导。
    expect(paretoKeys([b])).toEqual(new Set())
  })

  it('derives the frontier by TPS-up/E2E-p95-down dominance when no official markers exist', () => {
    const frontierLowLatency = { ...chartPoint(8, 100, 100, null), key: 'a' }
    const frontierBalanced = { ...chartPoint(16, 200, 150, null), key: 'b' }
    // c 被 b 支配(TPS 更高且 E2E 更低);d 与 b 同 TPS 但 E2E 更差,弱支配同样出局。
    const dominated = { ...chartPoint(24, 150, 200, null), key: 'c' }
    const weaklyDominated = { ...chartPoint(28, 200, 180, null), key: 'd' }
    const frontierHighTps = { ...chartPoint(32, 300, 300, null), key: 'e' }
    // 任一维为 null 的点不参与推导,也永不进前沿。
    const missingTps = { ...chartPoint(40, 0, 50, null), key: 'f', systemTps: null }
    const missingLatency = { ...chartPoint(48, 250, null, null), key: 'g' }

    const keys = paretoKeys([
      frontierLowLatency, frontierBalanced, dominated, weaklyDominated,
      frontierHighTps, missingTps, missingLatency,
    ])
    expect(keys).toEqual(new Set(['a', 'b', 'e']))
  })

  it('keeps exact ties on the derived frontier and handles single/empty inputs', () => {
    // 完全相同的两点互不严格支配,应双双保留。
    const twinA = { ...chartPoint(8, 100, 100, null), key: 'twin-a' }
    const twinB = { ...chartPoint(16, 100, 100, null), key: 'twin-b' }
    expect(paretoKeys([twinA, twinB])).toEqual(new Set(['twin-a', 'twin-b']))

    expect(paretoKeys([{ ...chartPoint(8, 100, 100, null), key: 'solo' }])).toEqual(new Set(['solo']))
    expect(paretoKeys([{ ...chartPoint(8, 0, null, null), key: 'unusable', systemTps: null }])).toEqual(new Set())
    expect(paretoKeys([])).toEqual(new Set())
  })
})

describe('run label and percent rendering', () => {
  const runFixture = (overrides: Partial<NormalizedBenchmarkRun>): NormalizedBenchmarkRun => ({
    key: 'run-key',
    valid: true,
    cancelled: false,
    sourceNames: [],
    metrics: {},
    serverMetrics: [],
    metadata: {},
    errors: [],
    warnings: [],
    ...overrides,
  })

  it('prefers variation, then falls back to the source file name, then default', () => {
    expect(getRunLabel(runFixture({ variation: 'concurrency=8', sourceNames: ['a.json'] }))).toBe('concurrency=8')
    // variation 缺失时用来源文件名区分同名 run，不再统统显示 default
    expect(getRunLabel(runFixture({ sourceNames: ['profile_export_a.json'] }))).toBe('profile_export_a.json')
    expect(getRunLabel(runFixture({ sourceNames: ['b.csv'], trial: 2 }))).toBe('b.csv · trial 2')
    expect(getRunLabel(runFixture({}))).toBe('default')
  })

  it('rounds rendered percentages to one decimal, killing float garbage', () => {
    expect(percentValue(0.29)).toBe(29) // 0.29 * 100 === 28.999999999999996
    expect(percentValue(0.955)).toBe(95.5)
    expect(percentValue(1)).toBe(100)
    expect(percentValue(0)).toBe(0)
  })
})
