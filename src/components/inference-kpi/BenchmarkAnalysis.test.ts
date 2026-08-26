import { describe, expect, it } from 'vitest'
import type { NormalizedBenchmarkRun } from '../../lib/aiperfImport'
import type { ImportedRunMetadataDraft } from './kpiUiStore'
import { comparisonStatus, fingerprintFor } from './BenchmarkAnalysis'
import { measurementConfirmationKey, runConcurrency } from './SizingDerivation'

const run = (key: string, inputConfig: Record<string, unknown> = {}): NormalizedBenchmarkRun => ({
  key,
  valid: true,
  cancelled: false,
  sourceNames: [`${key}.json`],
  metrics: {},
  serverMetrics: [],
  inputConfig,
  metadata: {},
  errors: [],
  warnings: [],
})

const draft = (model: string): ImportedRunMetadataDraft => ({
  model,
  quantization: 'FP8',
  inputTokens: '2048',
  outputTokens: '512',
  engine: 'vLLM',
  engineVersion: '1.0',
  gpuModel: 'H100',
  gpuCount: '8',
  topology: '1x8 NVLink',
  loadMode: 'concurrency',
  workload: 'fixed-2048-512',
  slo: 'ttft=500,tpot=30',
})

describe('Benchmark comparison protection', () => {
  it('checks every valid run, not only the first pair', () => {
    const runs = [run('a'), run('b'), run('c')]
    const status = comparisonStatus(runs, { a: draft('same'), b: draft('same'), c: draft('different') })
    expect(status.comparable).toBe(false)
    expect(status.singleRun).toBe(false)
    expect(status.reasons.some((reason) => reason.text.includes('different'))).toBe(true)
  })

  it('gives structured reasons with unique ids usable as React keys', () => {
    const runs = [run('a'), run('b'), run('c')]
    const status = comparisonStatus(runs, { a: draft('base'), b: draft('other'), c: draft('other') })
    // b 与 c 对 baseline 的不一致文案完全相同，只有 run.key 组合能区分
    const ids = status.reasons.map((reason) => reason.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(status.reasons.every((reason) => reason.runKeys.length === 2)).toBe(true)
  })

  it('treats a single valid run as a neutral fact, not a warning with reasons', () => {
    const status = comparisonStatus([run('only')], { only: draft('solo') })
    expect(status).toEqual({ comparable: false, singleRun: true, reasons: [] })
  })

  it('reads common nested AIPerf input_config fields without flattening the artifact', () => {
    const fingerprint = fingerprintFor(
      run('nested', {
        models: [{ model: 'demo/model', quantization: 'FP8' }],
        phases: [{ name: 'profiling', type: 'concurrency', concurrency: 16 }],
        input_sequence_length: 2048,
        output_sequence_length: 512,
      }),
    )
    expect(fingerprint).toMatchObject({
      modelId: 'demo/model',
      quantization: 'FP8',
      inputSequenceLength: 2048,
      outputSequenceLength: 512,
      loadMode: 'concurrency',
    })
    expect(fingerprint.workloadFingerprint).toContain('phases')
  })

  it('uses the profiling phase concurrency for Little’s Law', () => {
    expect(runConcurrency(run('phases', {
      phases: [
        { name: 'warmup', concurrency: 2 },
        { name: 'profiling', concurrency: 16 },
      ],
    }))).toBe(16)
  })

  it('invalidates Goodput applicability confirmation when workload assumptions change', () => {
    const context = {
      modelId: 'demo/model',
      gpuId: 'h100',
      quantId: 'fp8' as const,
      batch: 16,
      cacheRate: 0.7,
      inputTokens: 2048,
      outputTokens: 512,
      concurrency: 32,
      gpusPerCapacityUnit: 8,
      slo: { ttftMs: 500, tpotMs: 30, e2eMs: 8000, attainment: 0.95 },
    }
    const baseline = measurementConfirmationKey('run-1', context)

    expect(measurementConfirmationKey('run-1', { ...context, concurrency: 64 })).not.toBe(baseline)
    expect(measurementConfirmationKey('run-1', { ...context, batch: 32 })).not.toBe(baseline)
    expect(measurementConfirmationKey('run-1', { ...context, cacheRate: 0.8 })).not.toBe(baseline)
  })
})
