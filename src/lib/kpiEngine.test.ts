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
  findSaturationPair,
  littleLawConcurrency,
  observed,
  preserveAiperfGoodput,
  requiredSystemOutputTps,
  singleUserOutputTokensPerSecond,
  validateMeasuredSizingGate,
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

    // 空窗口没有达标率可言：0/0 是 null，不是 0% 达标。
    const invalid = deriveCapacityMetrics({
      durationSeconds: 0,
      requestCount: 0,
      errorRequestCount: 0,
      outputTokenCount: 0,
      goodRequestCount: 0,
    })
    expect(invalid).toEqual({ rps: null, systemOutputTps: null, goodputRps: null, goodRequestFraction: null })
    expect(Object.values(invalid).some((value) => typeof value === 'number' && Number.isNaN(value))).toBe(false)
  })

  it('derives costs only with a positive throughput denominator', () => {
    expect(costPerMillionOutputTokens(36, 1000)).toBe(10)
    expect(costPerMillionOutputTokens(36, 0)).toBeNull()
    expect(costPerGoodRequest(36, 10)).toBe(0.001)
    expect(costPerGoodRequest(36, null)).toBeNull()
    expect(costPerGoodRequest(36, 0)).toBeNull()
  })

  it('applies effective utilization to $/MTok exactly as the registry formula states', () => {
    // 注册表公式：集群每小时成本 ÷ (系统输出 TPS × 3600 × 有效利用率) × 1,000,000
    const clusterHourlyUsd = 36
    const systemOutputTps = 1000
    const utilization = 0.4
    const registryFormula = (clusterHourlyUsd / (systemOutputTps * 3600 * utilization)) * 1_000_000
    expect(costPerMillionOutputTokens(clusterHourlyUsd, systemOutputTps, utilization)).toBeCloseTo(registryFormula)
    expect(costPerMillionOutputTokens(clusterHourlyUsd, systemOutputTps, utilization)).toBe(25)
    expect(costPerMillionOutputTokens(36, 1000, 0)).toBeNull()
    expect(costPerMillionOutputTokens(36, 1000, 1.5)).toBeNull()
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
      ttftP95Ms: observed(900),
      ttftTargetMs: 500,
      tpotP95Ms: observed(45),
      tpotTargetMs: 30,
      queueTimeP95Ms: observed(250),
      queuedRequests: observed(12),
      kvCacheUtilizationPct: observed(98),
      preemptionRatePerSecond: observed(1.5),
      prefixCacheHitRatePct: observed(40),
      expectedPrefixCacheHitRatePct: observed(75, 'target'),
      gpuUtilizationPct: observed(45),
      gpuMemoryUtilizationPct: observed(99),
      powerWatts: observed(690),
      maxPowerWatts: observed(700),
      rps: observed(20),
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
      goodputRps: observed(8),
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
    const withLowFraction = diagnoseInference({
      rps: observed(10),
      goodputRps: observed(8),
      goodRequestFraction: observed(0.7),
      goodRequestFractionTarget: 0.8,
    })
    expect(withLowFraction.map((finding) => finding.id)).toContain('good-request-fraction-low')
    expect(withLowFraction.map((finding) => finding.id)).not.toContain('goodput-missing')
    expect(withLowFraction.find((finding) => finding.id === 'good-request-fraction-low')?.severity).toBe('warning')

    const materiallyBelowCustomerGate = diagnoseInference({
      goodRequestFraction: observed(0.7),
      goodRequestFractionTarget: 0.95,
    })
    expect(
      materiallyBelowCustomerGate.find((finding) => finding.id === 'good-request-fraction-low')?.severity,
    ).toBe('critical')

    const withoutFraction = diagnoseInference({ rps: observed(10), goodputRps: observed(8) })
    expect(withoutFraction.map((finding) => finding.id)).not.toContain('good-request-fraction-low')

    const noUniversalDefault = diagnoseInference({
      rps: observed(10),
      goodputRps: observed(8),
      goodRequestFraction: observed(0.7),
    })
    expect(noUniversalDefault.map((finding) => finding.id)).not.toContain('good-request-fraction-low')
  })

  it('accepts a sampled in-window preemption count without pretending it is a rate', () => {
    const findings = diagnoseInference({ preemptionCountInWindow: observed(3) })
    const finding = findings.find((candidate) => candidate.id === 'preemption-active')
    expect(finding?.evidence[0]).toContain('采样窗口抢占计数 3')
    expect(finding?.severity).toBe('warning')
  })

  it('suppresses the preemption rule when only a cumulative counter reading exists', () => {
    // 单调 counter 无法折算成窗口计数：取值侧必须传 null，规则应保持沉默。
    expect(
      diagnoseInference({ preemptionCountInWindow: null, preemptionRatePerSecond: null }).map((finding) => finding.id),
    ).not.toContain('preemption-active')
    // 有真正窗口速率时仍然触发。
    expect(
      diagnoseInference({ preemptionRatePerSecond: observed(1.2) }).map((finding) => finding.id),
    ).toContain('preemption-active')
  })

  it('scores queue pressure relative to the TTFT budget instead of absolute thresholds', () => {
    const share = (queueMs: number, snapshot: Partial<Parameters<typeof diagnoseInference>[0]> = {}) =>
      diagnoseInference({ queueTimeP95Ms: observed(queueMs), ...snapshot }).find(
        (finding) => finding.id === 'queue-pressure',
      )

    // 分母优先场景 TTFT SLO：25% 触发 warning，50% 升级 critical，24% 沉默。
    expect(share(120, { ttftTargetMs: 500 })).toBeUndefined()
    expect(share(125, { ttftTargetMs: 500 })?.severity).toBe('warning')
    expect(share(250, { ttftTargetMs: 500 })?.severity).toBe('critical')
    // 缺 SLO 时退回实测 TTFT p95 作分母。
    expect(share(250, { ttftP95Ms: observed(900) })?.severity).toBe('warning')
    // 排队深度只是证据，不再决定 severity。
    expect(share(130, { ttftTargetMs: 500, queuedRequests: observed(500) })?.severity).toBe('warning')
    // 没有任何可用分母时抑制规则，绝对毫秒数不再单独定罪。
    expect(share(10_000)).toBeUndefined()
  })

  it('rejects estimated or target observations as measured evidence', () => {
    expect(diagnoseInference({ ttftP95Ms: observed(900, 'estimated'), ttftTargetMs: 500 })).toEqual([])
    expect(
      diagnoseInference({
        prefixCacheHitRatePct: observed(40, 'estimated'),
        expectedPrefixCacheHitRatePct: observed(75, 'target'),
      }),
    ).toEqual([])
    // 预期命中率若被塞进另一份实测值，同样抑制：两种来源不得混同比较。
    expect(
      diagnoseInference({
        prefixCacheHitRatePct: observed(40),
        expectedPrefixCacheHitRatePct: observed(75, 'measured'),
      }),
    ).toEqual([])
  })

  it('reports a cache-hit gap only against an explicit expectation', () => {
    const findings = diagnoseInference({
      prefixCacheHitRatePct: observed(40),
      expectedPrefixCacheHitRatePct: observed(75, 'target'),
    })
    const finding = findings.find((candidate) => candidate.id === 'cache-hit-gap')
    expect(finding?.evidence[0]).toContain('用户设定预期')
    expect(
      diagnoseInference({ prefixCacheHitRatePct: observed(40) }).map((candidate) => candidate.id),
    ).not.toContain('cache-hit-gap')
  })

  it('never divides a TTFT tail by an E2E tail when judging saturation', () => {
    // 前一点只有 E2E，后一点只有 TTFT：不存在可比的同名延迟指标，不得判定恶化。
    const mixedMetric = findSaturationPair([
      { load: 10, systemOutputTps: 1000, rps: 8, goodputRps: null, ttftP95Ms: null, tpotP95Ms: null, e2eP95Ms: 2000 },
      { load: 20, systemOutputTps: 1030, rps: 9, goodputRps: null, ttftP95Ms: 450, tpotP95Ms: null, e2eP95Ms: null },
    ])
    expect(mixedMetric).toBeNull()

    // 两端同为 TTFT 时仍可判定。
    const sameMetric = findSaturationPair([
      { load: 10, systemOutputTps: 1000, rps: 8, goodputRps: null, ttftP95Ms: 300, tpotP95Ms: null },
      { load: 20, systemOutputTps: 1030, rps: 9, goodputRps: null, ttftP95Ms: 450, tpotP95Ms: null },
    ])
    expect(sameMetric?.[1].load).toBe(20)
  })

  it('does not invent findings from missing or non-finite metrics', () => {
    expect(diagnoseInference({})).toEqual([])
    expect(diagnoseInference({ ttftP95Ms: observed(Number.NaN), ttftTargetMs: 500 })).toEqual([])
  })
})

describe('kpiEngine sizing', () => {
  it('sizes from measured Goodput with headroom, spare, GPU, server, and rack rounding', () => {
    expect(
      calculateSizing({
        targetGoodRps: 80,
        goodputRpsPerUnit: observed(20, 'measured'),
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
    const result = calculateSizing({ targetGoodRps: 40, goodputRpsPerUnit: observed(10), gpusPerUnit: 2 })
    expect(result.gpuCount).toBe(12)
    expect(result.serverCount).toBeNull()
    expect(result.rackCount).toBeNull()
  })

  it('never converts units into GPUs without an explicit unit topology', () => {
    // 缺 gpusPerUnit 不暗设 1 卡单元：单元数照算，GPU/服务器/机架保持 N/A。
    const result = calculateSizing({
      targetGoodRps: 40,
      goodputRpsPerUnit: observed(10),
      topology: { gpusPerServer: 8, serversPerRack: 4 },
    })
    expect(result.totalUnits).toBe(6)
    expect(result.gpuCount).toBeNull()
    expect(result.serverCount).toBeNull()
    expect(result.rackCount).toBeNull()
  })

  it('marks an estimated-throughput fallback as not SLO-validated', () => {
    const result = calculateSizing({ targetGoodRps: 40, estimatedRpsPerUnit: 12.5, gpusPerUnit: 1 })
    expect(result).toMatchObject({
      basis: 'estimated-throughput',
      sloValidated: false,
      baseUnits: 4,
      totalUnits: 5,
      gpuCount: 5,
    })
    expect(result.note).toContain('未验证体验 SLO')
  })

  it('refuses the SLO-validated path for a non-measured Goodput observation', () => {
    const estimated = calculateSizing({ targetGoodRps: 40, goodputRpsPerUnit: observed(10, 'estimated') })
    expect(estimated.basis).toBe('estimated-throughput')
    expect(estimated.sloValidated).toBe(false)
    expect(estimated.note).toContain('未验证体验 SLO')

    // target 是需求侧目标而非容量证据：整体回落到 estimatedRpsPerUnit。
    const target = calculateSizing({
      targetGoodRps: 40,
      goodputRpsPerUnit: observed(10, 'target'),
      estimatedRpsPerUnit: 12.5,
    })
    expect(target.basis).toBe('estimated-throughput')
    expect(target.capacityRpsPerUnit).toBe(12.5)
  })

  it('does not hide a measured zero Goodput behind an estimate', () => {
    const result = calculateSizing({
      targetGoodRps: 10,
      goodputRpsPerUnit: observed(0, 'measured'),
      estimatedRpsPerUnit: 100,
    })
    expect(result.basis).toBe('unavailable')
    expect(result.capacityRpsPerUnit).toBeNull()
    expect(result.gpuCount).toBeNull()
  })

  it('handles zero demand and invalid values without NaN or division by zero', () => {
    const zero = calculateSizing({ targetGoodRps: 0, goodputRpsPerUnit: observed(10), gpusPerUnit: 1 })
    expect(zero).toMatchObject({ baseUnits: 0, totalUnits: 1, gpuCount: 1 })

    const noCapacity = calculateSizing({ targetGoodRps: 10 })
    expect(noCapacity.basis).toBe('unavailable')
    expect(noCapacity.totalUnits).toBeNull()

    const invalid = calculateSizing({ targetGoodRps: Number.NaN, goodputRpsPerUnit: observed(10) })
    expect(invalid.basis).toBe('unavailable')
    expect(Object.values(invalid).some((value) => typeof value === 'number' && Number.isNaN(value))).toBe(false)
  })
})

describe('kpiEngine measured sizing gate', () => {
  const scenarioSlo = { ttftMs: 500, tpotMs: 30, e2eMs: 8000 }

  it('passes only when every run constraint is at least as strict as the scenario SLO', () => {
    const result = validateMeasuredSizingGate({
      runSlo: { ttft: 500, tpot: 25, e2e: 8000 },
      runGpuCount: 8,
      scenarioSlo,
      scenarioGpusPerUnit: 8,
    })
    expect(result).toEqual({ eligible: true, mismatches: [] })
  })

  it('rejects a run whose --goodput thresholds are looser than the scenario SLO', () => {
    const result = validateMeasuredSizingGate({
      runSlo: { ttft: 750, tpot: 30, e2e: 8000 },
      runGpuCount: 8,
      scenarioSlo,
      scenarioGpusPerUnit: 8,
    })
    expect(result.eligible).toBe(false)
    expect(result.mismatches).toEqual([
      { key: 'ttftMs', label: 'TTFT p95', runValue: 750, scenarioValue: 500 },
    ])
  })

  it('treats a scenario constraint missing on the run side as a mismatch', () => {
    const result = validateMeasuredSizingGate({
      runSlo: { ttft: 400 },
      runGpuCount: null,
      scenarioSlo,
      scenarioGpusPerUnit: 8,
    })
    expect(result.eligible).toBe(false)
    expect(result.mismatches.map((mismatch) => [mismatch.key, mismatch.runValue])).toEqual([
      ['tpotMs', null],
      ['e2eMs', null],
    ])
  })

  it('rejects a GPU topology mismatch and recognizes aliased run SLO keys', () => {
    const result = validateMeasuredSizingGate({
      runSlo: { time_to_first_token: 450, inter_token_latency: 28, request_latency: 7000 },
      runGpuCount: 4,
      scenarioSlo,
      scenarioGpusPerUnit: 8,
    })
    expect(result.eligible).toBe(false)
    expect(result.mismatches).toEqual([
      { key: 'gpuCount', label: '部署单元 GPU 数', runValue: 4, scenarioValue: 8 },
    ])
  })

  it('compares only the SLO dimensions the scenario has defined', () => {
    const result = validateMeasuredSizingGate({
      runSlo: { ttft: 480 },
      runGpuCount: null,
      scenarioSlo: { ttftMs: 500, tpotMs: null, e2eMs: null },
      scenarioGpusPerUnit: 8,
    })
    expect(result).toEqual({ eligible: true, mismatches: [] })
  })
})
