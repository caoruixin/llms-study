import { describe, expect, it } from 'vitest'
import { importAiperfFiles, parseAiperfArtifact, parseScalar } from './aiperfImport'

function json(value: unknown): string {
  return JSON.stringify(value)
}

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1.5',
    aiperf_version: '0.4.0',
    benchmark_id: 'bench-1',
    run_info: {
      benchmark_id: 'bench-1',
      sweep_id: 'sweep-1',
      variation_label: 'concurrency_8',
      variation_index: 1,
      variation_values: { 'phases.profiling.concurrency': 8 },
      trial: 2,
    },
    input_config: { models: ['demo/model'] },
    was_cancelled: false,
    request_count: { unit: 'requests', avg: 20 },
    request_throughput: { unit: 'requests/sec', avg: 4.2 },
    time_to_first_token: { unit: 'ms', avg: 42, p95: 65, count: 20 },
    output_token_throughput: { unit: 'tokens/sec', avg: 800 },
    goodput: { unit: 'requests/sec', avg: 3.8 },
    good_request_fraction: { unit: 'ratio', avg: 0.9 },
    ...overrides,
  }
}

describe('parseScalar type inference order', () => {
  it.each<[string, unknown]>([
    ['0', 0],
    ['1', 1],
    ['2', 2],
    ['-5', -5],
    ['3.14', 3.14],
    [' 16 ', 16],
    ['true', true],
    ['True', true],
    ['yes', true],
    ['no', false],
    ['false', false],
    ['', ''],
    ['   ', ''],
    ['sweep-1', 'sweep-1'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
  ])('parses %j as %j', (input, expected) => {
    expect(parseScalar(input)).toBe(expected)
  })
})

describe('parseAiperfArtifact / JSON content detection', () => {
  it('accepts future 1.x profile schemas, preserves Goodput and unknown metrics', () => {
    const artifact = parseAiperfArtifact(
      'customer-defined-name.data',
      json(
        profile({
          schema_version: '1.99',
          future_top_level_field: { anything: true },
          vendor_magic: { unit: 'widgets', avg: 7, p95: null, p99: 'Infinity', future_stat: 12 },
        }),
      ),
    )

    expect(artifact.kind).toBe('profile')
    expect(artifact.valid).toBe(true)
    expect(artifact.schemaVersion).toBe('1.99')
    expect(artifact.metrics.goodput.stats.avg).toBe(3.8)
    expect(artifact.metrics.good_request_fraction.stats.avg).toBe(0.9)
    expect(artifact.metrics.vendor_magic).toMatchObject({ unit: 'widgets', unknown: true })
    expect(artifact.metrics.vendor_magic.stats).toEqual({ avg: 7, future_stat: 12 })
    expect(artifact.runs[0]).toMatchObject({
      benchmarkId: 'bench-1',
      sweepId: 'sweep-1',
      variation: 'concurrency_8',
      variationIndex: 1,
      trial: 2,
    })
    expect(artifact.runs[0].key).toContain('benchmark=bench-1')
  })

  it('rejects unknown schema majors but returns a diagnosable artifact', () => {
    const artifact = parseAiperfArtifact('future.json', json(profile({ schema_version: '2.0' })))

    expect(artifact.kind).toBe('profile')
    expect(artifact.valid).toBe(false)
    expect(artifact.errors.map((entry) => entry.code)).toContain('unsupported-schema-major')
  })

  it('marks cancelled, zero-request and known metrics without an authoritative unit invalid', () => {
    const cancelled = parseAiperfArtifact(
      'cancelled.json',
      json(profile({ was_cancelled: true, request_count: { unit: 'requests', avg: 0 } })),
    )
    const missingUnit = parseAiperfArtifact(
      'missing-unit.json',
      json(profile({ time_to_first_token: { avg: 10, p95: 12 } })),
    )

    expect(cancelled.valid).toBe(false)
    expect(cancelled.runs[0].cancelled).toBe(true)
    expect(cancelled.errors.map((entry) => entry.code)).toEqual(expect.arrayContaining(['cancelled', 'zero-requests']))
    expect(missingUnit.valid).toBe(false)
    expect(missingUnit.errors).toContainEqual(
      expect.objectContaining({ code: 'missing-unit', metric: 'time_to_first_token' }),
    )
  })

  it('degrades unknown unit-less top-level blocks to N/A audit data instead of invalidating the artifact', () => {
    const unknownMissingUnit = parseAiperfArtifact(
      'unknown-missing-unit.json',
      json(profile({ vendor_future_metric: { avg: 7 }, error_summary: { count: 3 } })),
    )

    expect(unknownMissingUnit.valid).toBe(true)
    expect(unknownMissingUnit.errors).not.toContainEqual(expect.objectContaining({ code: 'missing-unit' }))
    expect(unknownMissingUnit.metrics.vendor_future_metric).toMatchObject({
      available: false,
      stats: {},
      rawStats: { avg: 7 },
    })
    expect(unknownMissingUnit.metrics.error_summary).toMatchObject({
      available: false,
      stats: {},
      rawStats: { count: 3 },
    })
    expect(unknownMissingUnit.warnings).toContainEqual(
      expect.objectContaining({ code: 'unknown-metric-unit-unavailable', metric: 'vendor_future_metric' }),
    )
    expect(unknownMissingUnit.warnings).toContainEqual(
      expect.objectContaining({ code: 'unknown-metric-unit-unavailable', metric: 'error_summary' }),
    )
  })

  it('rejects negative core stats on known tags, warns on unknown tags, degrades out-of-range fractions', () => {
    const negativeKnown = parseAiperfArtifact(
      'negative-latency.json',
      json(profile({ time_to_first_token: { unit: 'ms', avg: -42, p95: 65, count: 20 } })),
    )
    const negativeUnknown = parseAiperfArtifact(
      'negative-unknown.json',
      json(profile({ vendor_magic: { unit: 'widgets', avg: -7 } })),
    )
    const fractionOverflow = parseAiperfArtifact(
      'fraction-overflow.json',
      json(profile({ good_request_fraction: { unit: 'ratio', avg: 1.2 } })),
    )

    expect(negativeKnown.valid).toBe(false)
    expect(negativeKnown.errors).toContainEqual(
      expect.objectContaining({ code: 'negative-value', metric: 'time_to_first_token' }),
    )
    expect(negativeUnknown.valid).toBe(true)
    expect(negativeUnknown.warnings).toContainEqual(
      expect.objectContaining({ code: 'negative-value', metric: 'vendor_magic' }),
    )
    expect(fractionOverflow.valid).toBe(true)
    expect(fractionOverflow.metrics.good_request_fraction).toMatchObject({
      available: false,
      stats: {},
      rawStats: { avg: 1.2 },
    })
    expect(fractionOverflow.warnings).toContainEqual(
      expect.objectContaining({ code: 'fraction-out-of-range', metric: 'good_request_fraction' }),
    )
  })

  it('detects confidence aggregate and keeps derived metrics without count/sum', () => {
    const artifact = parseAiperfArtifact(
      'not-using-the-default-prefix.json',
      json({
        schema_version: '1.7',
        aggregation_type: 'confidence',
        num_profile_runs: 3,
        num_successful_runs: 3,
        metadata: { aggregation_type: 'confidence', sweep_id: 'sweep-c' },
        metrics: {
          request_throughput: {
            mean: 12,
            std: 0.4,
            cv: 0.03,
            se: 0.2,
            ci_low: 11.5,
            ci_high: 12.5,
            t_critical: 2.7,
            unit: 'requests/sec',
          },
        },
      }),
    )

    expect(artifact.kind).toBe('confidence-aggregate')
    expect(artifact.valid).toBe(true)
    expect(artifact.metrics.request_throughput.stats).toMatchObject({ mean: 12, ci_low: 11.5, ci_high: 12.5 })
  })

  it('detects collated results and uses only exported combined statistics', () => {
    const artifact = parseAiperfArtifact(
      'pooled.json',
      json({
        schema_version: '1.0.0',
        description: 'Collated per-request metrics across all runs.',
        metadata: { aggregation_type: 'detailed', num_successful_runs: 2 },
        metrics: {
          time_to_first_token: {
            unit: 'ms',
            combined: { mean: 100, p50: 90, p95: 140, p99: 170, count: 20 },
            per_run: [
              { label: 'run_1', mean: 90, count: 10 },
              { label: 'run_2', mean: 110, count: 10 },
            ],
          },
        },
      }),
    )

    expect(artifact.kind).toBe('collated')
    expect(artifact.valid).toBe(true)
    expect(artifact.metrics.time_to_first_token).toMatchObject({ unit: 'ms', stats: { mean: 100, p95: 140 } })
  })

  it('keeps official unit-less collated combined stats as N/A without invalidating the artifact', () => {
    const artifact = parseAiperfArtifact(
      'profile_export_aiperf_collated.json',
      json({
        schema_version: '1.0.0',
        description: 'Collated per-request metrics across all runs.',
        metadata: { aggregation_type: 'detailed', num_profile_runs: 2, num_successful_runs: 2 },
        metrics: {
          time_to_first_token: {
            combined: { mean: 100, std: 10, p50: 95, p90: 115, p95: 125, p99: 140, count: 20 },
            per_run: [
              { label: 'run_0001', mean: 95, count: 10 },
              { label: 'run_0002', mean: 105, count: 10 },
            ],
          },
        },
      }),
    )

    expect(artifact.kind).toBe('collated')
    expect(artifact.valid).toBe(true)
    expect(artifact.metrics.time_to_first_token).toMatchObject({
      unit: '',
      available: false,
      stats: {},
      rawStats: { mean: 100, p95: 125, p99: 140, count: 20 },
    })
    expect(artifact.warnings).toContainEqual(
      expect.objectContaining({ code: 'collated-unit-unavailable', metric: 'time_to_first_token' }),
    )
    expect(artifact.runs[0].valid).toBe(true)
  })

  it('detects sweep aggregate, points and Pareto membership', () => {
    const artifact = parseAiperfArtifact(
      'experiment-output.json',
      json({
        aggregation_type: 'sweep',
        num_profile_runs: 2,
        num_successful_runs: 2,
        metadata: { sweep_id: 'sweep-json' },
        per_combination_metrics: [
          {
            parameters: { concurrency: 8 },
            metrics: {
              request_throughput_avg: { mean: 10, std: 0, unit: 'requests/sec' },
              goodput_avg: { mean: 8, unit: 'requests/sec' },
            },
          },
          {
            parameters: { concurrency: 16 },
            metrics: {
              request_throughput_avg: { mean: 17, std: 1, unit: 'requests/sec' },
              goodput_avg: { mean: 13, unit: 'requests/sec' },
            },
          },
        ],
        pareto_optimal: [{ concurrency: 16 }],
      }),
    )

    expect(artifact.kind).toBe('sweep-aggregate')
    expect(artifact.valid).toBe(true)
    expect(artifact.sweepPoints).toHaveLength(2)
    expect(artifact.runs).toHaveLength(2)
    expect(new Set(artifact.runs.map((run) => run.key)).size).toBe(2)
    expect(artifact.runs[1]).toMatchObject({
      sweepId: 'sweep-json',
      variation: '{"concurrency":16}',
      variationIndex: 1,
      metrics: { goodput_avg: { unit: 'requests/sec', stats: { mean: 13 } } },
    })
    expect(artifact.sweepPoints[1]).toMatchObject({
      coordinates: { concurrency: 16 },
      paretoOptimal: true,
      valid: true,
    })
    expect(artifact.sweepPoints[1].metrics.goodput_avg.stats.mean).toBe(13)
  })

  it('distinguishes a missing Pareto field from an official empty Pareto set', () => {
    const baseSweep = {
      aggregation_type: 'sweep',
      num_profile_runs: 1,
      num_successful_runs: 1,
      per_combination_metrics: [
        {
          parameters: { concurrency: 8 },
          metrics: { request_throughput_avg: { mean: 10, unit: 'requests/sec' } },
        },
      ],
    }
    const missing = parseAiperfArtifact('missing-pareto.json', json(baseSweep))
    const officialEmpty = parseAiperfArtifact(
      'empty-pareto.json',
      json({ ...baseSweep, pareto_optimal: [] }),
    )

    expect(missing.sweepPoints[0].paretoOptimal).toBeUndefined()
    expect(missing.sweepPoints[0]).not.toHaveProperty('paretoOptimal')
    expect(officialEmpty.sweepPoints[0].paretoOptimal).toBe(false)
  })

  it('creates runs for valid sweep points even when another point is invalid', () => {
    const artifact = parseAiperfArtifact(
      'mixed-validity-sweep.json',
      json({
        aggregation_type: 'sweep',
        metadata: { sweep_id: 'mixed-sweep' },
        num_profile_runs: 2,
        num_successful_runs: 2,
        per_combination_metrics: [
          {
            parameters: { concurrency: 8 },
            metrics: { goodput_avg: { mean: 7, unit: 'requests/sec' } },
          },
          {
            parameters: { concurrency: 16 },
            metrics: { goodput_avg: { mean: 12 } },
          },
        ],
      }),
    )

    expect(artifact.valid).toBe(false)
    expect(artifact.sweepPoints.map((point) => point.valid)).toEqual([true, false])
    expect(artifact.runs).toHaveLength(1)
    expect(artifact.runs[0]).toMatchObject({ variation: '{"concurrency":8}', valid: true, errors: [] })
  })

  it('detects server metrics and flattens every endpoint/label series', () => {
    const artifact = parseAiperfArtifact(
      'resource-observations.json',
      json({
        schema_version: '1.1',
        benchmark_id: 'bench-1',
        summary: { endpoints_successful: ['http://host/metrics'] },
        metrics_phase: 'profiling',
        metrics: {
          'vllm:kv_cache_usage_perc': {
            type: 'gauge',
            unit: 'ratio',
            series: [
              {
                endpoint_url: 'http://host/metrics',
                labels: { engine: '0' },
                stats: { avg: 0.5, p99: 0.9, ignored_null: null },
              },
              {
                endpoint_url: 'http://host/metrics',
                labels: { engine: '1' },
                stats: { avg: 0.4, p99: 0.8 },
              },
            ],
          },
        },
      }),
    )

    expect(artifact.kind).toBe('server-metrics')
    expect(artifact.valid).toBe(true)
    expect(artifact.serverMetrics).toHaveLength(2)
    expect(artifact.serverMetrics[0]).toMatchObject({
      name: 'vllm:kv_cache_usage_perc',
      unit: 'ratio',
      stats: { avg: 0.5, p99: 0.9 },
      labels: { engine: '0' },
    })
  })

  it('keeps unit-less JSON server info/series as unavailable audit data without invalidating usable series', () => {
    const artifact = parseAiperfArtifact(
      'mixed-server.json',
      json({
        schema_version: '1.2',
        benchmark_id: 'bench-mixed-server',
        summary: {},
        metrics_phase: 'profiling',
        metrics: {
          build_info: {
            type: 'info',
            series: [{ endpoint_url: 'host', value: 'v0.9.1', labels: { engine: 'vllm' }, stats: {} }],
          },
          unitless_gpu_load: {
            type: 'gauge',
            series: [{ endpoint_url: 'host', stats: { avg: 0.8, p95: 0.95 } }],
          },
          gpu_utilization: {
            type: 'gauge',
            unit: '%',
            series: [{ endpoint_url: 'host', stats: { avg: 80, p95: 95 } }],
          },
        },
      }),
    )

    expect(artifact.valid).toBe(true)
    expect(artifact.errors).not.toContainEqual(expect.objectContaining({ code: 'missing-unit' }))
    expect(artifact.serverMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'build_info', available: false, rawValue: 'v0.9.1', stats: {}, rawStats: {} }),
        expect.objectContaining({ name: 'unitless_gpu_load', available: false, stats: {}, rawStats: { avg: 0.8, p95: 0.95 } }),
        expect.objectContaining({ name: 'gpu_utilization', unit: '%', stats: { avg: 80, p95: 95 } }),
      ]),
    )
    expect(artifact.warnings.filter((entry) => entry.code === 'server-unit-unavailable')).toHaveLength(2)
  })

  it('quarantines unit-less embedded JSON GPU telemetry but keeps the profile valid', () => {
    const artifact = parseAiperfArtifact(
      'profile-with-telemetry.json',
      json(profile({
        telemetry_data: {
          endpoints: {
            host: {
              gpus: {
                gpu_0: {
                  gpu_uuid: 'GPU-0',
                  metrics: {
                    gpu_fraction_without_unit: { avg: 0.8 },
                    gpu_utilization: { unit: '%', avg: 80 },
                  },
                },
              },
            },
          },
        },
      })),
    )

    expect(artifact.valid).toBe(true)
    expect(artifact.serverMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'gpu_fraction_without_unit', available: false, stats: {}, rawStats: { avg: 0.8 } }),
        expect.objectContaining({ name: 'gpu_utilization', unit: '%', stats: { avg: 80 } }),
      ]),
    )
    expect(artifact.runs[0].metrics.gpu_fraction_without_unit.available).toBe(false)
  })
})

describe('parseAiperfArtifact / RFC 4180 and multi-section CSV', () => {
  it('parses profile sections, quoted commas/newlines and GPU telemetry', () => {
    const csv = [
      'Metric,avg,min,max,p95',
      'Time to First Token (ms),42,20,80,70',
      '"Vendor,\nMetric (widgets)",7,1,9,8',
      '',
      'Metric,Value',
      'Request Count,20',
      'Goodput (requests/sec),3.5',
      '',
      '',
      'Endpoint,GPU_Index,GPU_Name,GPU_UUID,Platform,Metric,avg,p95',
      'host,0,"GPU, Model",GPU-0,nvidia,NVIDIA GPU Utilization (%),85,99',
    ].join('\r\n')
    const artifact = parseAiperfArtifact('renamed.anything', csv)

    expect(artifact.kind).toBe('profile')
    expect(artifact.valid).toBe(true)
    expect(artifact.metadataRequired).toBe(true)
    expect(artifact.metrics.request_count.unit).toBe('requests')
    expect(artifact.metrics.goodput.stats.value).toBe(3.5)
    expect(artifact.metrics.vendor_metric).toMatchObject({ unit: 'widgets', unknown: true })
    expect(artifact.serverMetrics[0]).toMatchObject({ endpoint: 'host', gpuId: 'GPU-0', unit: '%' })
  })

  it('restores only the official request_count CSV-suppressed unit, not arbitrary counters', () => {
    const official = parseAiperfArtifact('request-count.csv', 'Metric,Value\nRequest Count,20')
    const arbitrary = parseAiperfArtifact('vendor-count.csv', 'Metric,Value\nVendor Counter,20')

    expect(official.valid).toBe(true)
    expect(official.metrics.request_count.unit).toBe('requests')
    // 未知计数器不猜单位也不判 artifact 无效：数值保留为不可解释的审计数据。
    expect(arbitrary.valid).toBe(true)
    expect(arbitrary.metrics.vendor_counter).toMatchObject({
      unit: '',
      available: false,
      stats: {},
      rawStats: { value: 20 },
    })
    expect(arbitrary.warnings).toContainEqual(
      expect.objectContaining({ code: 'unknown-metric-unit-unavailable', metric: 'vendor_counter' }),
    )
  })

  it('parses confidence aggregate CSV and ignores non-finite cells', () => {
    const csv = [
      'metric,mean,std,min,max,cv,se,ci_low,ci_high,t_critical,unit',
      'request_throughput,12,0.5,11,13,0.04,0.2,11.5,12.5,2.7,requests/sec',
      'vendor_metric,NaN,Infinity,1,2,,,,,,widgets',
      '',
      'Aggregation Type,confidence',
      'Total Runs,3',
      'Successful Runs,3',
    ].join('\n')
    const artifact = parseAiperfArtifact('aggregate.csv', csv)

    expect(artifact.kind).toBe('confidence-aggregate')
    expect(artifact.valid).toBe(true)
    expect(artifact.metrics.request_throughput.stats.mean).toBe(12)
    expect(artifact.metrics.vendor_metric.stats).toEqual({ min: 1, max: 2 })
  })

  it('does not misdetect tag-named metric rows in profile/confidence CSVs as a sweep wide-table', () => {
    const profileCsv = [
      'Metric,Value',
      'request_count,20',
      'time_to_first_token_avg (ms),42',
      'request_latency_p99 (ms),2800',
    ].join('\n')
    const confidenceCsv = [
      'metric,mean,std,ci_low,ci_high,unit',
      'time_to_first_token_avg,42,1,41,43,ms',
      'request_latency_p99,2800,20,2760,2840,ms',
    ].join('\n')

    const profileArtifact = parseAiperfArtifact('tag-profile.csv', profileCsv)
    const confidenceArtifact = parseAiperfArtifact('tag-confidence.csv', confidenceCsv)

    expect(profileArtifact.kind).toBe('profile')
    expect(profileArtifact.valid).toBe(true)
    expect(profileArtifact.metrics.time_to_first_token_avg).toMatchObject({ unit: 'ms', stats: { value: 42 } })
    expect(profileArtifact.metrics.request_latency_p99).toMatchObject({ unit: 'ms', stats: { value: 2800 } })
    expect(confidenceArtifact.kind).toBe('confidence-aggregate')
    expect(confidenceArtifact.valid).toBe(true)
    expect(confidenceArtifact.metrics.time_to_first_token_avg.stats.mean).toBe(42)
    expect(confidenceArtifact.metrics.request_latency_p99.stats.mean).toBe(2800)
  })

  it('flags Successful Runs = 0 in confidence CSV trailing metadata', () => {
    const csv = [
      'metric,mean,std,ci_low,ci_high,unit',
      'request_throughput,12,0.5,11.5,12.5,requests/sec',
      '',
      'Aggregation Type,confidence',
      'Total Runs,3',
      'Successful Runs,0',
    ].join('\n')
    const artifact = parseAiperfArtifact('zero-success.csv', csv)

    expect(artifact.kind).toBe('confidence-aggregate')
    expect(artifact.valid).toBe(false)
    expect(artifact.errors).toContainEqual(expect.objectContaining({ code: 'zero-successful-runs' }))
  })

  it('flags Number of Successful Runs = 0 in sweep CSV metadata', () => {
    const csv = [
      'concurrency,request_throughput_avg_mean (requests/sec),goodput_avg_mean (requests/sec)',
      '1,10,8',
      '',
      'Metadata',
      'Field,Value',
      'Sweep Id,sweep-zero',
      'Number of Successful Runs,0',
    ].join('\n')
    const artifact = parseAiperfArtifact('zero-sweep.csv', csv)

    expect(artifact.kind).toBe('sweep-aggregate')
    expect(artifact.valid).toBe(false)
    expect(artifact.errors).toContainEqual(expect.objectContaining({ code: 'zero-successful-runs' }))
  })

  it('parses sweep wide-table, Pareto and Metadata sections', () => {
    const csv = [
      'concurrency,request_throughput_avg_mean (requests/sec),request_throughput_avg_std (requests/sec),goodput_avg_mean (requests/sec)',
      '8,10,0,8',
      '16,17,1,13',
      '',
      'Best Configurations',
      'Configuration,concurrency,Metric,Unit',
      'Best Throughput,16,17,requests/sec',
      '',
      'Pareto Optimal Points',
      'concurrency',
      '16',
      '',
      'Metadata',
      'Field,Value',
      'Aggregation Type,sweep',
      'Sweep Id,sweep-csv',
      'Number of Successful Runs,2',
    ].join('\n')
    const artifact = parseAiperfArtifact('wide.csv', csv)

    expect(artifact.kind).toBe('sweep-aggregate')
    expect(artifact.valid).toBe(true)
    expect(artifact.sweepId).toBe('sweep-csv')
    expect(artifact.runs).toHaveLength(2)
    expect(artifact.runs[1].metrics.goodput_avg.stats.mean).toBe(13)
    expect(artifact.sweepPoints[0].paretoOptimal).toBe(false)
    expect(artifact.sweepPoints[1].paretoOptimal).toBe(true)
    expect(artifact.sweepPoints[1].metrics.request_throughput_avg).toMatchObject({
      unit: 'requests/sec',
      stats: { mean: 17, std: 1 },
    })
  })

  it('leaves CSV Pareto state undefined when the section is absent', () => {
    const artifact = parseAiperfArtifact(
      'sweep-without-pareto.csv',
      [
        'concurrency,request_throughput_avg_mean (requests/sec)',
        '8,10',
        '',
        'Metadata',
        'Field,Value',
        'Number of Successful Runs,1',
      ].join('\n'),
    )

    expect(artifact.kind).toBe('sweep-aggregate')
    expect(artifact.valid).toBe(true)
    expect(artifact.sweepPoints[0].paretoOptimal).toBeUndefined()
    expect(artifact.sweepPoints[0]).not.toHaveProperty('paretoOptimal')
  })

  it('marks official unit-less sweep KPI columns invalid instead of guessing', () => {
    const csv = [
      'concurrency,request_throughput_avg_mean,request_throughput_avg_std',
      '8,10,0',
      '',
      'Best Configurations',
      '',
      'Pareto Optimal Points',
      'None',
      '',
      'Metadata',
      'Field,Value',
      'Number of Successful Runs,1',
    ].join('\n')
    const artifact = parseAiperfArtifact('sweep.csv', csv)

    expect(artifact.kind).toBe('sweep-aggregate')
    expect(artifact.valid).toBe(false)
    expect(artifact.errors).toContainEqual(
      expect.objectContaining({ code: 'missing-unit', metric: 'request_throughput_avg' }),
    )
  })

  it('parses server metric type sections and metadata comments', () => {
    const csv = [
      '# AIPerf Server Metrics Export (CSV)',
      '# aiperf_version: 0.4.0',
      '# schema_version: 1.0',
      '# benchmark_id: bench-csv',
      '#',
      'Endpoint,Type,Metric,Unit,avg,min,max,std,p95,engine,Description',
      'host,gauge,vllm:kv_cache_usage_perc,ratio,0.5,0,0.9,0.1,0.85,0,"KV cache,\nusage"',
      '',
      'Endpoint,Type,Metric,Unit,total,rate,rate_avg,rate_min,rate_max,rate_std,Description',
      'host,counter,vllm:request_success,requests,20,4,4,3,5,0.2,Successful requests',
    ].join('\r\n')
    const artifact = parseAiperfArtifact('metrics.txt', csv)

    expect(artifact.kind).toBe('server-metrics')
    expect(artifact.benchmarkId).toBe('bench-csv')
    expect(artifact.serverMetrics).toHaveLength(2)
    expect(artifact.serverMetrics[0]).toMatchObject({
      labels: { engine: '0' },
      stats: { avg: 0.5, p95: 0.85 },
    })
  })

  it('accepts mixed CSV server info/unit-less/usable series and quarantines only missing units', () => {
    const csv = [
      '# AIPerf Server Metrics Export (CSV)',
      '# schema_version: 1.0',
      '# benchmark_id: bench-csv-mixed',
      '#',
      'Endpoint,Type,Metric,Unit,avg,p95,Description',
      'host,gauge,unitless_gpu_load,,0.8,0.95,Ambiguous fraction',
      'host,gauge,gpu_utilization,%,80,95,GPU utilization',
      '',
      'Endpoint,Metric,Key,Value,Description',
      'host,build_info,version,v0.9.1,Build version',
    ].join('\n')
    const artifact = parseAiperfArtifact('mixed-server.csv', csv)

    expect(artifact.valid).toBe(true)
    expect(artifact.serverMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'unitless_gpu_load', available: false, stats: {}, rawStats: { avg: 0.8, p95: 0.95 } }),
        expect.objectContaining({ name: 'gpu_utilization', unit: '%', stats: { avg: 80, p95: 95 } }),
        expect.objectContaining({ name: 'build_info', available: false, rawValue: 'v0.9.1', stats: {}, rawStats: {} }),
      ]),
    )
    expect(artifact.warnings.filter((entry) => entry.code === 'server-unit-unavailable')).toHaveLength(2)
  })

  it('recognizes a server CSV section even when the Unit column itself is omitted', () => {
    const artifact = parseAiperfArtifact(
      'custom-export.data',
      ['Endpoint,Type,Metric,avg,p95', 'host,gauge,unitless_gpu_load,0.8,0.95'].join('\n'),
    )

    expect(artifact.kind).toBe('server-metrics')
    expect(artifact.valid).toBe(true)
    expect(artifact.serverMetrics[0]).toMatchObject({
      name: 'unitless_gpu_load',
      available: false,
      stats: {},
      rawStats: { avg: 0.8, p95: 0.95 },
    })
  })

  it('quarantines unit-less profile CSV telemetry without affecting benchmark metrics', () => {
    const csv = [
      'Metric,Value',
      'Request Count,20',
      'Request Throughput (requests/sec),4',
      '',
      'Endpoint,GPU_Index,GPU_UUID,Metric,avg,p95',
      'host,0,GPU-0,GPU Fraction Without Unit,0.8,0.95',
      'host,0,GPU-0,NVIDIA GPU Utilization (%),80,95',
    ].join('\n')
    const artifact = parseAiperfArtifact('profile-telemetry.csv', csv)

    expect(artifact.kind).toBe('profile')
    expect(artifact.valid).toBe(true)
    expect(artifact.serverMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'gpu_fraction_without_unit', available: false, stats: {}, rawStats: { avg: 0.8, p95: 0.95 } }),
        expect.objectContaining({ name: 'nvidia_gpu_utilization', unit: '%', stats: { avg: 80, p95: 95 } }),
      ]),
    )
  })
})

describe('importAiperfFiles / dedupe and exact association', () => {
  it('deduplicates stable identities and associates server metrics only by benchmark_id', async () => {
    const profileText = json(profile({ run_info: { benchmark_id: 'bench-1', trial: 0 } }))
    const serverText = json({
      schema_version: '1.1',
      benchmark_id: 'bench-1',
      summary: {},
      metrics: {
        gpu_utilization: {
          type: 'gauge',
          unit: '%',
          series: [{ endpoint_url: 'host', stats: { avg: 80 } }],
        },
      },
    })
    const noIdServerText = json({
      schema_version: '1.1',
      summary: {},
      metrics: {
        kv_usage: { type: 'gauge', unit: 'ratio', series: [{ endpoint_url: 'other', stats: { avg: 0.5 } }] },
      },
    })

    const batch = await importAiperfFiles([
      new File([profileText], 'profile-a.json'),
      new File([profileText], 'profile-copy.json'),
      new File([serverText], 'server.json'),
      new File([noIdServerText], 'server-without-id.json'),
    ])

    expect(batch.artifacts).toHaveLength(3)
    expect(batch.runs).toHaveLength(1)
    expect(batch.runs[0].serverMetrics).toHaveLength(1)
    expect(batch.runs[0].metrics.gpu_utilization.stats.avg).toBe(80)
    expect(batch.runs[0].sourceNames).toContain('server.json')
    expect(batch.unassociatedServerArtifacts.map((artifact) => artifact.name)).toEqual(['server-without-id.json'])
    expect(batch.unassociatedServerMetrics).toHaveLength(1)
    expect(batch.duplicates).toContainEqual(expect.objectContaining({ type: 'artifact' }))
  })

  it('does not associate mismatched benchmark IDs even when filenames look related', async () => {
    const batch = await importAiperfFiles([
      new File([json(profile())], 'same-prefix-profile.json'),
      new File(
        [
          json({
            schema_version: '1.1',
            benchmark_id: 'different-benchmark',
            summary: {},
            metrics: {
              gpu: { type: 'gauge', unit: '%', series: [{ stats: { avg: 75 } }] },
            },
          }),
        ],
        'same-prefix-server.json',
      ),
    ])

    expect(batch.runs[0].serverMetrics).toHaveLength(0)
    expect(batch.unassociatedServerArtifacts).toHaveLength(1)
    expect(batch.warnings).toContainEqual(expect.objectContaining({ code: 'unassociated-server-metrics' }))
  })

  it('uses one server series identity across JSON and CSV and deduplicates it after association', async () => {
    const serverJson = json({
      schema_version: '1.1',
      benchmark_id: 'bench-series',
      summary: {},
      metrics: {
        gpu_utilization: {
          type: 'gauge',
          unit: '%',
          series: [{ endpoint_url: 'host', labels: { engine: '0' }, stats: { avg: 80 } }],
        },
      },
    })
    const serverCsv = [
      '# AIPerf Server Metrics Export (CSV)',
      '# schema_version: 1.0',
      '# benchmark_id: bench-series',
      '#',
      'Endpoint,Type,Metric,Unit,avg,engine,Description',
      'host,gauge,gpu_utilization,%,80,0,GPU utilization',
    ].join('\n')
    const jsonArtifact = parseAiperfArtifact('server.json', serverJson)
    const csvArtifact = parseAiperfArtifact('server.csv', serverCsv)

    expect(jsonArtifact.serverMetrics[0].seriesKey).toBe(csvArtifact.serverMetrics[0].seriesKey)

    const batch = await importAiperfFiles([
      new File([json(profile({ benchmark_id: 'bench-series', run_info: { benchmark_id: 'bench-series' } }))], 'profile.json'),
      new File([serverJson], 'server.json'),
      new File([serverCsv], 'server.csv'),
    ])
    expect(batch.runs).toHaveLength(1)
    expect(batch.runs[0].serverMetrics).toHaveLength(1)
  })

  it('exposes valid sweep points as normalized runs for downstream Sizing selection', async () => {
    const sweep = json({
      aggregation_type: 'sweep',
      num_profile_runs: 2,
      num_successful_runs: 2,
      metadata: { sweep_id: 'sizing-sweep' },
      per_combination_metrics: [
        {
          parameters: { concurrency: 8 },
          metrics: { goodput_avg: { mean: 7, unit: 'requests/sec' } },
        },
        {
          parameters: { concurrency: 16 },
          metrics: { goodput_avg: { mean: 12, unit: 'requests/sec' } },
        },
      ],
    })
    const batch = await importAiperfFiles([new File([sweep], 'sweep-only.json')])

    expect(batch.sweepPoints).toHaveLength(2)
    expect(batch.runs).toHaveLength(2)
    expect(batch.runs.map((run) => run.variation)).toEqual(['{"concurrency":8}', '{"concurrency":16}'])
    expect(batch.runs.map((run) => run.metrics.goodput_avg.stats.mean)).toEqual([7, 12])
  })

  it('keeps concurrency=1 sweep coordinates numeric and deduplicates them across CSV and JSON', async () => {
    const sweepCsv = [
      'concurrency,request_throughput_avg_mean (requests/sec)',
      '1,10',
      '2,17',
      '',
      'Metadata',
      'Field,Value',
      'Sweep Id,sweep-dedupe',
      'Number of Successful Runs,2',
    ].join('\n')
    const sweepJson = json({
      aggregation_type: 'sweep',
      num_successful_runs: 2,
      metadata: { sweep_id: 'sweep-dedupe' },
      per_combination_metrics: [
        {
          parameters: { concurrency: 1 },
          metrics: { request_throughput_avg: { mean: 10, unit: 'requests/sec' } },
        },
        {
          parameters: { concurrency: 2 },
          metrics: { request_throughput_avg: { mean: 17, unit: 'requests/sec' } },
        },
      ],
    })

    const csvArtifact = parseAiperfArtifact('one.csv', sweepCsv)
    expect(csvArtifact.sweepPoints.map((point) => point.coordinates)).toEqual([
      { concurrency: 1 },
      { concurrency: 2 },
    ])
    expect(typeof csvArtifact.sweepPoints[0].coordinates.concurrency).toBe('number')

    const batch = await importAiperfFiles([
      new File([sweepCsv], 'one.csv'),
      new File([sweepJson], 'one.json'),
    ])
    expect(batch.sweepPoints).toHaveLength(2)
    expect(batch.duplicates.filter((entry) => entry.type === 'sweep-point')).toHaveLength(2)
  })

  it('associates server metrics with a run whose CSV metadata benchmark_id is purely numeric', async () => {
    const confidenceCsv = [
      'metric,mean,std,ci_low,ci_high,unit',
      'request_throughput,12,0.5,11.5,12.5,requests/sec',
      '',
      'Aggregation Type,confidence',
      'Benchmark Id,314159',
      'Successful Runs,3',
    ].join('\n')
    const serverJson = json({
      schema_version: '1.1',
      benchmark_id: '314159',
      summary: {},
      metrics: {
        gpu_utilization: { type: 'gauge', unit: '%', series: [{ endpoint_url: 'host', stats: { avg: 80 } }] },
      },
    })
    const batch = await importAiperfFiles([
      new File([confidenceCsv], 'aggregate.csv'),
      new File([serverJson], 'server.json'),
    ])

    expect(batch.runs).toHaveLength(1)
    expect(batch.runs[0].benchmarkId).toBe('314159')
    expect(batch.runs[0].key).toContain('benchmark=314159')
    expect(batch.runs[0].serverMetrics).toHaveLength(1)
    expect(batch.unassociatedServerArtifacts).toHaveLength(0)
  })

  it('keeps JSON benchmark_id written as a raw number and still associates server metrics', async () => {
    const profileJson = json({
      schema_version: '1.1',
      benchmark_id: 314159,
      request_count: { unit: 'requests', count: 3 },
      time_to_first_token: { unit: 'ms', avg: 42 },
    })
    const serverJson = json({
      schema_version: '1.1',
      benchmark_id: 314159,
      summary: {},
      metrics: {
        gpu_utilization: { type: 'gauge', unit: '%', series: [{ endpoint_url: 'host', stats: { avg: 80 } }] },
      },
    })
    const batch = await importAiperfFiles([
      new File([profileJson], 'profile.json'),
      new File([serverJson], 'server.json'),
    ])

    expect(batch.runs).toHaveLength(1)
    expect(batch.runs[0].benchmarkId).toBe('314159')
    expect(batch.runs[0].serverMetrics).toHaveLength(1)
    expect(batch.unassociatedServerArtifacts).toHaveLength(0)
  })

  it('reports conflicting units across same-identity artifacts and marks the metric unavailable', async () => {
    const identity = { benchmark_id: 'bench-unit-conflict', variation_label: 'base', trial: 0 }
    const msProfile = json({
      schema_version: '1.5',
      benchmark_id: 'bench-unit-conflict',
      run_info: identity,
      time_to_first_token: { unit: 'ms', avg: 42 },
    })
    const secondsProfile = json({
      schema_version: '1.5',
      benchmark_id: 'bench-unit-conflict',
      run_info: identity,
      time_to_first_token: { unit: 'seconds', avg: 0.042 },
    })
    const files = [
      new File([msProfile], 'ttft-ms.json'),
      new File([secondsProfile], 'ttft-seconds.json'),
    ]
    const forward = await importAiperfFiles(files)
    const reverse = await importAiperfFiles([...files].reverse())

    expect(forward.runs).toHaveLength(1)
    const metric = forward.runs[0].metrics.time_to_first_token
    expect(metric.available).toBe(false)
    expect(metric.stats).toEqual({})
    expect(Object.keys(metric.rawStats ?? {})).toContain('avg')
    expect(forward.runs[0].warnings).toContainEqual(
      expect.objectContaining({ code: 'conflicting-metric-unit', metric: 'time_to_first_token' }),
    )
    expect(reverse.runs[0]).toEqual(forward.runs[0])
  })

  it('does not merge a trial-less aggregate with an explicit trial 0 run', async () => {
    const base = {
      schema_version: '1.5',
      benchmark_id: 'bench-trial',
      request_throughput: { unit: 'requests/sec', avg: 9 },
    }
    const batch = await importAiperfFiles([
      new File([json({ ...base, run_info: { benchmark_id: 'bench-trial', trial: 0 } })], 'trial-0.json'),
      new File([json({ ...base, run_info: { benchmark_id: 'bench-trial' } })], 'aggregate.json'),
    ])

    expect(batch.runs).toHaveLength(2)
    expect(new Set(batch.runs.map((run) => run.key)).size).toBe(2)
  })

  it('deterministically merges complementary duplicate sweep points and reports stable conflicts', async () => {
    const sweepArtifact = (metricVariant: 'latency' | 'goodput') => json({
      schema_version: '1.5',
      aggregation_type: 'sweep',
      benchmark_id: 'bench-sweep-merge',
      sweep_id: 'sweep-merge-points',
      num_successful_runs: 1,
      per_combination_metrics: [
        {
          parameters: { concurrency: 8 },
          metrics: metricVariant === 'latency'
            ? {
                request_throughput_avg: { unit: 'requests/sec', mean: 10 },
                request_latency_p95: { unit: 'ms', mean: 120 },
              }
            : {
                request_throughput_avg: { unit: 'requests/sec', mean: 12 },
                goodput_avg: { unit: 'requests/sec', mean: 8 },
              },
        },
      ],
    })
    const files = [
      new File([sweepArtifact('latency')], 'a-latency-sweep.json'),
      new File([sweepArtifact('goodput')], 'b-goodput-sweep.json'),
    ]

    const forward = await importAiperfFiles(files)
    const reverse = await importAiperfFiles([...files].reverse())

    expect(forward.sweepPoints).toHaveLength(1)
    expect(forward.sweepPoints[0].metrics).toMatchObject({
      request_throughput_avg: { unit: 'requests/sec', stats: { mean: 10 } },
      request_latency_p95: { unit: 'ms', stats: { mean: 120 } },
      goodput_avg: { unit: 'requests/sec', stats: { mean: 8 } },
    })
    expect(forward.warnings).toContainEqual(
      expect.objectContaining({ code: 'conflicting-sweep-point', message: expect.stringContaining('request_throughput_avg.mean') }),
    )
    expect(reverse.sweepPoints).toEqual(forward.sweepPoints)
    expect(reverse.duplicates.filter((entry) => entry.type === 'sweep-point')).toEqual(
      forward.duplicates.filter((entry) => entry.type === 'sweep-point'),
    )
    expect(reverse.warnings.filter((entry) => entry.code.includes('sweep-point'))).toEqual(
      forward.warnings.filter((entry) => entry.code.includes('sweep-point')),
    )
  })

  it('associates usable server series even when the same artifact also contains unit-less evidence', async () => {
    const server = json({
      schema_version: '1.5',
      benchmark_id: 'bench-server-association',
      summary: {},
      metrics: {
        ambiguous_utilization: { type: 'gauge', series: [{ endpoint_url: 'host', stats: { avg: 0.8 } }] },
        gpu_utilization: { type: 'gauge', unit: '%', series: [{ endpoint_url: 'host', stats: { avg: 80 } }] },
      },
    })
    const batch = await importAiperfFiles([
      new File([json(profile({ benchmark_id: 'bench-server-association', run_info: { benchmark_id: 'bench-server-association' } }))], 'profile.json'),
      new File([server], 'server.json'),
    ])

    expect(batch.runs).toHaveLength(1)
    expect(batch.unassociatedServerArtifacts).toHaveLength(0)
    expect(batch.runs[0].serverMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ambiguous_utilization', available: false, stats: {}, rawStats: { avg: 0.8 } }),
        expect.objectContaining({ name: 'gpu_utilization', unit: '%', stats: { avg: 80 } }),
      ]),
    )
    expect(batch.runs[0].warnings).toContainEqual(expect.objectContaining({ code: 'server-unit-unavailable' }))
  })

  it('deterministically upgrades the same server series when another artifact supplies its unit', async () => {
    const server = (unit?: string) => json({
      schema_version: '1.5',
      benchmark_id: 'bench-server-unit-merge',
      summary: {},
      metrics: {
        gpu_utilization: {
          type: 'gauge',
          ...(unit ? { unit } : {}),
          series: [{ endpoint_url: 'host', labels: { gpu: '0' }, stats: { avg: unit ? 80 : 0.8 } }],
        },
      },
    })
    const files = [
      new File([json(profile({ benchmark_id: 'bench-server-unit-merge', run_info: { benchmark_id: 'bench-server-unit-merge' } }))], 'profile.json'),
      new File([server()], 'server-unitless.json'),
      new File([server('%')], 'server-with-unit.json'),
    ]

    const forward = await importAiperfFiles(files)
    const reverse = await importAiperfFiles([...files].reverse())
    const metric = forward.runs[0].serverMetrics[0]

    expect(metric).toMatchObject({ unit: '%', available: true, stats: { avg: 80 }, rawStats: { avg: 0.8 } })
    expect(reverse.runs[0]).toEqual(forward.runs[0])
  })

  it('deterministically merges complementary same-identity artifacts without losing fields', async () => {
    const runInfo = {
      benchmark_id: 'bench-merge',
      sweep_id: 'sweep-merge',
      variation_label: 'concurrency_8',
      variation_index: 1,
      trial: 0,
    }
    const profileJson = json({
      schema_version: '1.5',
      benchmark_id: 'bench-merge',
      run_info: runInfo,
      metadata: { profile_note: 'profile' },
      input_config: { model: 'demo/model', nested: { profile_only: 1 } },
      time_to_first_token: { unit: 'ms', avg: 40, p95: 60 },
      telemetry_data: {
        endpoints: {
          host: {
            gpus: {
              gpu_0: {
                gpu_uuid: 'GPU-0',
                metrics: { nvidia_gpu_utilization: { unit: '%', avg: 80 } },
              },
            },
          },
        },
      },
    })
    const confidenceJson = json({
      schema_version: '1.0',
      benchmark_id: 'bench-merge',
      run_info: runInfo,
      metadata: { aggregation_type: 'confidence', confidence_note: 'aggregate' },
      input_config: { engine: 'vllm', nested: { confidence_only: 2 } },
      num_successful_runs: 3,
      metrics: { request_throughput: { unit: 'requests/sec', mean: 12, ci_low: 11, ci_high: 13 } },
    })
    const collatedJson = json({
      schema_version: '1.0.0',
      benchmark_id: 'bench-merge',
      run_info: runInfo,
      description: 'Collated per-request metrics across all runs.',
      metadata: { aggregation_type: 'detailed', collated_note: 'pooled', num_successful_runs: 3 },
      input_config: { hardware: 'H100', nested: { collated_only: 3 } },
      metrics: {
        request_latency: {
          combined: { mean: 200, p95: 260, p99: 300, count: 30 },
          per_run: [{ label: 'run_0001', mean: 200, count: 30 }],
        },
      },
    })
    const files = [
      new File([profileJson], 'profile.json'),
      new File([confidenceJson], 'confidence.json'),
      new File([collatedJson], 'collated.json'),
    ]
    const forward = await importAiperfFiles(files)
    const reverse = await importAiperfFiles([...files].reverse())
    const run = forward.runs[0]

    expect(forward.runs).toHaveLength(1)
    expect(run.valid).toBe(true)
    expect(run.sourceNames).toEqual(['collated.json', 'confidence.json', 'profile.json'])
    expect(run.metrics.time_to_first_token.stats.p95).toBe(60)
    expect(run.metrics.request_throughput.stats.mean).toBe(12)
    expect(run.metrics.request_latency).toMatchObject({ available: false, stats: {}, rawStats: { p95: 260 } })
    expect(run.metrics.nvidia_gpu_utilization.stats.avg).toBe(80)
    expect(run.serverMetrics).toHaveLength(1)
    expect(run.inputConfig).toMatchObject({
      model: 'demo/model',
      engine: 'vllm',
      hardware: 'H100',
      nested: { profile_only: 1, confidence_only: 2, collated_only: 3 },
    })
    expect(run.metadata).toMatchObject({
      profile_note: 'profile',
      confidence_note: 'aggregate',
      collated_note: 'pooled',
    })
    expect(run.warnings).toContainEqual(expect.objectContaining({ code: 'collated-unit-unavailable' }))
    expect(reverse.runs[0]).toEqual(run)
  })

  it('merges errors from complementary same-identity runs instead of discarding either artifact', async () => {
    const identity = { benchmark_id: 'bench-errors', variation_label: 'base', trial: 0 }
    const batch = await importAiperfFiles([
      new File(
        [
          json({
            schema_version: '1.5',
            benchmark_id: 'bench-errors',
            run_info: identity,
            time_to_first_token: { avg: 1 },
          }),
        ],
        'broken.json',
      ),
      new File(
        [
          json({
            schema_version: '1.5',
            benchmark_id: 'bench-errors',
            run_info: identity,
            request_throughput: { unit: 'requests/sec', avg: 9 },
          }),
        ],
        'usable.json',
      ),
    ])

    expect(batch.runs).toHaveLength(1)
    expect(batch.runs[0].metrics).toHaveProperty('time_to_first_token')
    expect(batch.runs[0].metrics).toHaveProperty('request_throughput')
    expect(batch.runs[0].errors).toContainEqual(
      expect.objectContaining({ code: 'missing-unit', metric: 'time_to_first_token' }),
    )
    expect(batch.runs[0].valid).toBe(false)
  })
})

describe('unsupported formats', () => {
  it('rejects JSONL and Parquet explicitly', () => {
    const jsonl = parseAiperfArtifact('records.jsonl', '{}\n{}')
    const parquet = parseAiperfArtifact('records.parquet', 'PAR1')

    expect(jsonl.errors[0].code).toBe('unsupported-jsonl')
    expect(parquet.errors[0].code).toBe('unsupported-parquet')
    expect(jsonl.valid).toBe(false)
    expect(parquet.valid).toBe(false)
  })
})
