import { describe, expect, it } from 'vitest'
import type { BenchmarkFingerprint } from '../data/inferenceKpis'
import {
  calculateSizing,
  checkLittleLaw,
  compareBenchmarks,
  costPerGoodRequest,
  costPerMillionOutputTokens,
  decodeCadenceTokensPerSecond,
  deriveCapacityMetrics,
  diagnoseInference,
  estimateE2ELatencyMs,
  littleLawConcurrency,
  preserveAiperfGoodput,
  requiredSystemOutputTps,
  singleUserOutputTokensPerSecond,
} from './kpiEngine'

const BASE_FINGERPRINT: BenchmarkFingerprint = {
  modelId: 'meta/llama-3.1-70b',
  quantization: 'fp8',
  inputSequenceLength: 1024,
  outputSequenceLength: 128,
  gpuModel: 'H100 SXM',
  gpuCount: 8,
  hardwareTopology: '1 node / NVLink',
  engine: 'TensorRT-LLM',
  engineVersion: '1.1.0',
  loadMode: 'concurrency',
  workloadFingerprint: 'fixed-isl-osl',
  slo: { ttft_p95_ms: 500, tpot_p95_ms: 30 },
}

describe('kpiEngine formulas', () => {
  it('estimates E2E with TPOT excluding the first token', () => {
    expect(estimateE2ELatencyMs(100, 10, 20)).toBe(280)
    expect(estimateE2ELatencyMs(100, 1, 20)).toBe(100)
    expect(estimateE2ELatencyMs(100, 0, 20)).toBeNull()
    expect(estimateE2ELatencyMs(Number.POSITIVE_INFINITY, 10, 20)).toBeNull()
    expect(estimateE2ELatencyMs(100, 10, -1)).toBeNull()
  })

  it('distinguishes per-user throughput from decode cadence', () => {
    expect(singleUserOutputTokensPerSecond(100, 2000)).toBe(50)
    expect(singleUserOutputTokensPerSecond(0, 2000)).toBe(0)
    expect(singleUserOutputTokensPerSecond(100, 0)).toBeNull()
    expect(decodeCadenceTokensPerSecond(20)).toBe(50)
    expect(decodeCadenceTokensPerSecond(0)).toBeNull()
  })

  it('derives Little Law and required output TPS without NaN', () => {
    expect(littleLawConcurrency(10, 1500)).toBe(15)
    expect(littleLawConcurrency(0, 1500)).toBe(0)
    expect(littleLawConcurrency(10, Number.NaN)).toBeNull()
    expect(requiredSystemOutputTps(12.5, 80)).toBe(1000)
    expect(requiredSystemOutputTps(0, 80)).toBe(0)
    expect(requiredSystemOutputTps(-1, 80)).toBeNull()

    expect(checkLittleLaw(10, 1500, 16)).toMatchObject({
      expectedConcurrency: 15,
      observedConcurrency: 16,
      consistent: true,
    })
    expect(checkLittleLaw(10, 1500, 20, 0.2)).toMatchObject({
      expectedConcurrency: 15,
      observedConcurrency: 20,
      consistent: false,
    })
    expect(checkLittleLaw(0, 0, 0)).toEqual({
      expectedConcurrency: 0,
      observedConcurrency: 0,
      relativeError: 0,
      consistent: true,
    })
  })

  it('derives raw capacity while preserving source-computed Goodput only', () => {
    const metrics = deriveCapacityMetrics({
      durationSeconds: 10,
      requestCount: 100,
      errorRequestCount: 5,
      outputTokenCount: 2000,
      goodRequestCount: 80,
      aiperfGoodputRps: 7,
    })
    expect(metrics.rps).toBe(10)
    expect(metrics.systemOutputTps).toBe(200)
    expect(metrics.goodputRps).toBe(7)
    expect(metrics.goodRequestFraction).toBeCloseTo(80 / 105)

    const withoutGoodput = deriveCapacityMetrics({
      durationSeconds: 10,
      requestCount: 100,
      outputTokenCount: 2000,
      goodRequestCount: 80,
    })
    expect(withoutGoodput.goodputRps).toBeNull()
    expect(withoutGoodput.goodRequestFraction).toBe(0.8)
    expect(preserveAiperfGoodput(0)).toBe(0)
    expect(preserveAiperfGoodput(-1)).toBeNull()
  })

  it('honors an explicit AIPerf good_request_fraction and rejects broken windows', () => {
    const explicit = deriveCapacityMetrics({
      durationSeconds: 1,
      requestCount: 3,
      errorRequestCount: 1,
      outputTokenCount: 30,
      goodRequestCount: 1,
      aiperfGoodRequestFraction: 0.75,
    })
    expect(explicit.goodRequestFraction).toBe(0.75)

    const invalid = deriveCapacityMetrics({
      durationSeconds: 0,
      requestCount: 0,
      errorRequestCount: 0,
      outputTokenCount: 0,
      goodRequestCount: 0,
    })
    expect(invalid).toEqual({ rps: null, systemOutputTps: null, goodputRps: null, goodRequestFraction: 0 })
    expect(Object.values(invalid).some((value) => typeof value === 'number' && Number.isNaN(value))).toBe(false)
  })

  it('derives costs only with a positive throughput denominator', () => {
    expect(costPerMillionOutputTokens(36, 1000)).toBe(10)
    expect(costPerMillionOutputTokens(36, 0)).toBeNull()
    expect(costPerGoodRequest(36, 10)).toBe(0.001)
    expect(costPerGoodRequest(36, null)).toBeNull()
    expect(costPerGoodRequest(36, 0)).toBeNull()
  })
})

describe('kpiEngine benchmark comparability', () => {
  it('allows ranking only when all material fields and SLOs match', () => {
    const reorderedAndNormalized: BenchmarkFingerprint = {
      ...BASE_FINGERPRINT,
      modelId: ' META/LLAMA-3.1-70B ',
      slo: { tpot_p95_ms: 30, ttft_p95_ms: 500 },
    }
    expect(compareBenchmarks(BASE_FINGERPRINT, reorderedAndNormalized)).toEqual({ comparable: true, mismatches: [] })
  })

  it('reports configuration differences rather than declaring a winner', () => {
    const result = compareBenchmarks(BASE_FINGERPRINT, {
      ...BASE_FINGERPRINT,
      quantization: 'int4',
      outputSequenceLength: 256,
      engineVersion: '1.2.0',
      slo: { ttft_p95_ms: 750, tpot_p95_ms: 30 },
    })
    expect(result.comparable).toBe(false)
    expect(result.mismatches.map((mismatch) => mismatch.field)).toEqual([
      'quantization',
      'outputSequenceLength',
      'engineVersion',
      'slo',
    ])
    expect(result.mismatches.every((mismatch) => mismatch.reason === 'different')).toBe(true)
  })

  it('treats missing run context as incomparable instead of guessing', () => {
    const result = compareBenchmarks(BASE_FINGERPRINT, { ...BASE_FINGERPRINT, hardwareTopology: null })
    expect(result.comparable).toBe(false)
    expect(result.mismatches).toContainEqual({
      field: 'hardwareTopology',
      label: '硬件拓扑',
      left: '1 node / nvlink',
      right: null,
      reason: 'missing',
    })
  })
})

describe('kpiEngine diagnosis', () => {
  it('emits evidence-backed findings for SLO, queue, KV, preemption, cache, and GPU pressure', () => {
    const findings = diagnoseInference({
      ttftP95Ms: 900,
      ttftTargetMs: 500,
      tpotP95Ms: 45,
      tpotTargetMs: 30,
      queueTimeP95Ms: 250,
      queuedRequests: 12,
      kvCacheUtilizationPct: 98,
      preemptionRatePerSecond: 1.5,
      prefixCacheHitRatePct: 40,
      expectedPrefixCacheHitRatePct: 75,
      gpuUtilizationPct: 45,
      gpuMemoryUtilizationPct: 99,
      powerWatts: 690,
      maxPowerWatts: 700,
      rps: 20,
    })
    const ids = findings.map((finding) => finding.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'ttft-slo-breach',
        'tpot-slo-breach',
        'queue-pressure',
        'kv-pressure',
        'preemption-active',
        'cache-hit-gap',
        'gpu-underfed-with-queue',
        'gpu-memory-pressure',
        'gpu-power-limit',
        'goodput-missing',
      ]),
    )
    for (const finding of findings) {
      expect(finding.evidence.length, finding.id).toBeGreaterThan(0)
      expect(finding.possibleCauses.length, finding.id).toBeGreaterThan(0)
      expect(finding.nextChecks.length, finding.id).toBeGreaterThan(0)
      expect(finding.relatedArchComponents.length, finding.id).toBeGreaterThan(0)
    }
  })

  it('detects throughput saturation from a sweep plateau', () => {
    const findings = diagnoseInference({
      goodputRps: 8,
      sweepPoints: [
        {
          load: 10,
          systemOutputTps: 1000,
          rps: 8,
          goodputRps: 8,
          ttftP95Ms: 300,
          tpotP95Ms: 20,
        },
        {
          load: 20,
          systemOutputTps: 1030,
          rps: 9,
          goodputRps: 8.1,
          ttftP95Ms: 450,
          tpotP95Ms: 24,
        },
      ],
    })
    expect(findings.map((finding) => finding.id)).toContain('throughput-saturation')
  })

  it('keeps Goodput and good_request_fraction as separate diagnostic inputs', () => {
    const withLowFraction = diagnoseInference({ rps: 10, goodputRps: 8, goodRequestFraction: 0.7 })
    expect(withLowFraction.map((finding) => finding.id)).toContain('good-request-fraction-low')
    expect(withLowFraction.map((finding) => finding.id)).not.toContain('goodput-missing')

    const withoutFraction = diagnoseInference({ rps: 10, goodputRps: 8 })
    expect(withoutFraction.map((finding) => finding.id)).not.toContain('good-request-fraction-low')
  })

  it('does not invent findings from missing or non-finite metrics', () => {
    expect(diagnoseInference({})).toEqual([])
    expect(diagnoseInference({ ttftP95Ms: Number.NaN, ttftTargetMs: 500 })).toEqual([])
  })
})

describe('kpiEngine sizing', () => {
  it('sizes from measured Goodput with headroom, spare, GPU, server, and rack rounding', () => {
    expect(
      calculateSizing({
        targetGoodRps: 80,
        measuredGoodputRpsPerUnit: 20,
        headroom: 0.2,
        spareUnits: 1,
        gpusPerUnit: 2,
        topology: { gpusPerServer: 8, serversPerRack: 4 },
      }),
    ).toEqual({
      basis: 'measured-goodput',
      sloValidated: true,
      targetGoodRps: 80,
      headroom: 0.2,
      spareUnits: 1,
      capacityRpsPerUnit: 20,
      baseUnits: 5,
      totalUnits: 6,
      gpuCount: 12,
      serverCount: 2,
      rackCount: 1,
      note: '按实测 AIPerf Goodput 计算，容量已由本次运行的 SLO 验证。',
    })
  })

  it('keeps topology-derived counts null until explicit divisors exist', () => {
    const result = calculateSizing({ targetGoodRps: 40, measuredGoodputRpsPerUnit: 10, gpusPerUnit: 2 })
    expect(result.gpuCount).toBe(12)
    expect(result.serverCount).toBeNull()
    expect(result.rackCount).toBeNull()
  })

  it('marks an estimated-throughput fallback as not SLO-validated', () => {
    const result = calculateSizing({ targetGoodRps: 40, estimatedRpsPerUnit: 12.5 })
    expect(result).toMatchObject({
      basis: 'estimated-throughput',
      sloValidated: false,
      baseUnits: 4,
      totalUnits: 5,
      gpuCount: 5,
    })
    expect(result.note).toContain('未验证体验 SLO')
  })

  it('does not hide a measured zero Goodput behind an estimate', () => {
    const result = calculateSizing({
      targetGoodRps: 10,
      measuredGoodputRpsPerUnit: 0,
      estimatedRpsPerUnit: 100,
    })
    expect(result.basis).toBe('unavailable')
    expect(result.capacityRpsPerUnit).toBeNull()
    expect(result.gpuCount).toBeNull()
  })

  it('handles zero demand and invalid values without NaN or division by zero', () => {
    const zero = calculateSizing({ targetGoodRps: 0, measuredGoodputRpsPerUnit: 10 })
    expect(zero).toMatchObject({ baseUnits: 0, totalUnits: 1, gpuCount: 1 })

    const noCapacity = calculateSizing({ targetGoodRps: 10 })
    expect(noCapacity.basis).toBe('unavailable')
    expect(noCapacity.totalUnits).toBeNull()

    const invalid = calculateSizing({ targetGoodRps: Number.NaN, measuredGoodputRpsPerUnit: 10 })
    expect(invalid.basis).toBe('unavailable')
    expect(Object.values(invalid).some((value) => typeof value === 'number' && Number.isNaN(value))).toBe(false)
  })
})
