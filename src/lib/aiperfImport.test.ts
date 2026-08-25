import { describe, expect, it } from 'vitest'
import { importAiperfFiles, parseAiperfArtifact } from './aiperfImport'

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

  it('marks cancelled, zero-request and any metric without an authoritative unit invalid', () => {
    const cancelled = parseAiperfArtifact(
      'cancelled.json',
      json(profile({ was_cancelled: true, request_count: { unit: 'requests', avg: 0 } })),
    )
    const missingUnit = parseAiperfArtifact(
      'missing-unit.json',
      json(profile({ time_to_first_token: { avg: 10, p95: 12 } })),
    )
    const unknownMissingUnit = parseAiperfArtifact(
      'unknown-missing-unit.json',
      json(profile({ vendor_future_metric: { avg: 7 } })),
    )

    expect(cancelled.valid).toBe(false)
    expect(cancelled.runs[0].cancelled).toBe(true)
    expect(cancelled.errors.map((entry) => entry.code)).toEqual(expect.arrayContaining(['cancelled', 'zero-requests']))
    expect(missingUnit.valid).toBe(false)
    expect(missingUnit.errors).toContainEqual(
      expect.objectContaining({ code: 'missing-unit', metric: 'time_to_first_token' }),
    )
    expect(unknownMissingUnit.errors).toContainEqual(
      expect.objectContaining({ code: 'missing-unit', metric: 'vendor_future_metric' }),
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
