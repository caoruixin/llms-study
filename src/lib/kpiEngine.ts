import type {
  AnalysisFinding,
  BenchmarkFingerprint,
  KpiCategory,
  SizingResult,
} from '../data/inferenceKpis'

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegative(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}

function isPositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0
}

function safeDivide(numerator: number, denominator: number): number | null {
  if (!isFiniteNumber(numerator) || !isPositive(denominator)) return null
  const result = numerator / denominator
  return Number.isFinite(result) ? result : null
}

/** E2E estimate for a streamed response. TPOT excludes the first output token. */
export function estimateE2ELatencyMs(ttftMs: number, outputTokens: number, tpotMs: number): number | null {
  if (!isNonNegative(ttftMs) || !Number.isInteger(outputTokens) || outputTokens < 1 || !isNonNegative(tpotMs)) {
    return null
  }
  const result = ttftMs + (outputTokens - 1) * tpotMs
  return Number.isFinite(result) ? result : null
}

/** NIM per-user throughput: output sequence length / full E2E latency. */
export function singleUserOutputTokensPerSecond(outputTokens: number, e2eLatencyMs: number): number | null {
  if (!isNonNegative(outputTokens) || !isPositive(e2eLatencyMs)) return null
  return safeDivide(outputTokens * 1000, e2eLatencyMs)
}

/** Decode cadence after the first token. Kept separate because it is only an asymptotic proxy for per-user throughput. */
export function decodeCadenceTokensPerSecond(tpotMs: number): number | null {
  return safeDivide(1000, tpotMs)
}

/** Steady-state Little's Law check: concurrency = request rate × mean time in system. */
export function littleLawConcurrency(rps: number, meanE2ELatencyMs: number): number | null {
  if (!isNonNegative(rps) || !isNonNegative(meanE2ELatencyMs)) return null
  const result = rps * (meanE2ELatencyMs / 1000)
  return Number.isFinite(result) ? result : null
}

export interface LittleLawCheck {
  expectedConcurrency: number | null
  observedConcurrency: number | null
  relativeError: number | null
  consistent: boolean | null
}

/** Verifies whether an observed steady-state concurrency is within a relative tolerance of Little's Law. */
export function checkLittleLaw(
  rps: number,
  meanE2ELatencyMs: number,
  observedConcurrency: number,
  tolerance = 0.2,
): LittleLawCheck {
  const expectedConcurrency = littleLawConcurrency(rps, meanE2ELatencyMs)
  if (expectedConcurrency === null || !isNonNegative(observedConcurrency) || !isNonNegative(tolerance)) {
    return { expectedConcurrency, observedConcurrency: null, relativeError: null, consistent: null }
  }
  if (expectedConcurrency === 0) {
    return {
      expectedConcurrency,
      observedConcurrency,
      relativeError: observedConcurrency === 0 ? 0 : null,
      consistent: observedConcurrency === 0,
    }
  }
  const relativeError = Math.abs(observedConcurrency - expectedConcurrency) / expectedConcurrency
  return {
    expectedConcurrency,
    observedConcurrency,
    relativeError,
    consistent: relativeError <= tolerance,
  }
}

/** Output-token capacity required by a request workload. */
export function requiredSystemOutputTps(rps: number, outputTokensPerRequest: number): number | null {
  if (!isNonNegative(rps) || !isNonNegative(outputTokensPerRequest)) return null
  const result = rps * outputTokensPerRequest
  return Number.isFinite(result) ? result : null
}

/** Goodput is accepted only when AIPerf supplied it; this helper never reconstructs it from percentiles. */
export function preserveAiperfGoodput(value: number | null | undefined): number | null {
  return isNonNegative(value) ? value : null
}

export interface CapacityDerivationInput {
  durationSeconds: number
  /** AIPerf request_count (successful/recorded requests), excluding error_request_count. */
  requestCount: number
  errorRequestCount?: number | null
  outputTokenCount: number
  /** Optional count used only for good_request_fraction; never used to manufacture Goodput. */
  goodRequestCount?: number | null
  /** Source-computed AIPerf Goodput in compliant requests/s. */
  aiperfGoodputRps?: number | null
  /** Source-computed fraction in [0, 1]. Takes precedence over count-derived fraction. */
  aiperfGoodRequestFraction?: number | null
}

export interface DerivedCapacityMetrics {
  rps: number | null
  systemOutputTps: number | null
  goodputRps: number | null
  /** good_request_count / (request_count + error_request_count), kept distinct from Goodput. */
  goodRequestFraction: number | null
}

export function deriveCapacityMetrics(input: CapacityDerivationInput): DerivedCapacityMetrics {
  const duration = isPositive(input.durationSeconds) ? input.durationSeconds : null
  const requests = isNonNegative(input.requestCount) ? input.requestCount : null
  const errors = input.errorRequestCount == null ? 0 : isNonNegative(input.errorRequestCount) ? input.errorRequestCount : null
  const outputTokens = isNonNegative(input.outputTokenCount) ? input.outputTokenCount : null

  const rps = duration !== null && requests !== null ? safeDivide(requests, duration) : null
  const systemOutputTps = duration !== null && outputTokens !== null ? safeDivide(outputTokens, duration) : null
  const goodputRps = preserveAiperfGoodput(input.aiperfGoodputRps)

  let goodRequestFraction: number | null = null
  if (
    isFiniteNumber(input.aiperfGoodRequestFraction) &&
    input.aiperfGoodRequestFraction >= 0 &&
    input.aiperfGoodRequestFraction <= 1
  ) {
    goodRequestFraction = input.aiperfGoodRequestFraction
  } else if (isNonNegative(input.goodRequestCount) && requests !== null && errors !== null) {
    const denominator = requests + errors
    const fraction = denominator === 0 ? 0 : safeDivide(input.goodRequestCount, denominator)
    if (fraction !== null && fraction <= 1) goodRequestFraction = fraction
  }

  return { rps, systemOutputTps, goodputRps, goodRequestFraction }
}

export function costPerMillionOutputTokens(clusterHourlyUsd: number, systemOutputTps: number): number | null {
  if (!isNonNegative(clusterHourlyUsd) || !isPositive(systemOutputTps)) return null
  return safeDivide(clusterHourlyUsd * 1_000_000, systemOutputTps * 3600)
}

export function costPerGoodRequest(clusterHourlyUsd: number, goodputRps: number | null | undefined): number | null {
  if (!isNonNegative(clusterHourlyUsd)) return null
  const preserved = preserveAiperfGoodput(goodputRps)
  if (!isPositive(preserved)) return null
  return safeDivide(clusterHourlyUsd, preserved * 3600)
}

export type ComparisonField = keyof BenchmarkFingerprint

export interface ComparisonMismatch {
  field: ComparisonField
  label: string
  left: string | number | null
  right: string | number | null
  reason: 'missing' | 'different'
}

export interface ComparisonResult {
  comparable: boolean
  mismatches: readonly ComparisonMismatch[]
}

const FINGERPRINT_FIELDS: readonly { field: Exclude<ComparisonField, 'slo'>; label: string }[] = [
  { field: 'modelId', label: '模型' },
  { field: 'quantization', label: '量化' },
  { field: 'inputSequenceLength', label: '输入长度 ISL' },
  { field: 'outputSequenceLength', label: '输出长度 OSL' },
  { field: 'gpuModel', label: 'GPU 型号' },
  { field: 'gpuCount', label: 'GPU 数量' },
  { field: 'hardwareTopology', label: '硬件拓扑' },
  { field: 'engine', label: '推理引擎' },
  { field: 'engineVersion', label: '引擎版本' },
  { field: 'loadMode', label: '负载模式' },
  { field: 'workloadFingerprint', label: '负载指纹' },
]

function normalizedComparableValue(value: string | number | null): string | number | null {
  if (typeof value === 'string') {
    const normalized = value.trim().toLocaleLowerCase()
    return normalized.length > 0 ? normalized : null
  }
  return isFiniteNumber(value) ? value : null
}

function serializeSlo(slo: Readonly<Record<string, number>> | null): string | null {
  if (slo === null) return null
  const entries = Object.entries(slo)
  if (entries.some(([key, value]) => key.trim().length === 0 || !isFiniteNumber(value) || value < 0)) return null
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key.trim().toLocaleLowerCase()}=${value}`)
    .join(';')
}

/** Returns comparable=false for either missing context or a material workload/configuration difference. */
export function compareBenchmarks(left: BenchmarkFingerprint, right: BenchmarkFingerprint): ComparisonResult {
  const mismatches: ComparisonMismatch[] = []

  for (const { field, label } of FINGERPRINT_FIELDS) {
    const leftValue = normalizedComparableValue(left[field])
    const rightValue = normalizedComparableValue(right[field])
    if (leftValue === null || rightValue === null) {
      mismatches.push({ field, label, left: leftValue, right: rightValue, reason: 'missing' })
    } else if (leftValue !== rightValue) {
      mismatches.push({ field, label, left: leftValue, right: rightValue, reason: 'different' })
    }
  }

  const leftSlo = serializeSlo(left.slo)
  const rightSlo = serializeSlo(right.slo)
  if (leftSlo === null || rightSlo === null) {
    mismatches.push({ field: 'slo', label: 'SLO', left: leftSlo, right: rightSlo, reason: 'missing' })
  } else if (leftSlo !== rightSlo) {
    mismatches.push({ field: 'slo', label: 'SLO', left: leftSlo, right: rightSlo, reason: 'different' })
  }

  return { comparable: mismatches.length === 0, mismatches }
}

export interface SweepDiagnosticPoint {
  /** Concurrency or offered request rate; all points in one sweep must use the same load axis. */
  load: number
  systemOutputTps: number | null
  rps: number | null
  goodputRps: number | null
  ttftP95Ms: number | null
  tpotP95Ms: number | null
  e2eP95Ms?: number | null
}

export interface DiagnosticSnapshot {
  ttftP95Ms?: number | null
  ttftTargetMs?: number | null
  tpotP95Ms?: number | null
  tpotTargetMs?: number | null
  e2eLatencyP95Ms?: number | null
  e2eTargetMs?: number | null
  queueTimeP95Ms?: number | null
  queuedRequests?: number | null
  kvCacheUtilizationPct?: number | null
  preemptionRatePerSecond?: number | null
  prefixCacheHitRatePct?: number | null
  expectedPrefixCacheHitRatePct?: number | null
  gpuUtilizationPct?: number | null
  gpuMemoryUtilizationPct?: number | null
  powerWatts?: number | null
  maxPowerWatts?: number | null
  rps?: number | null
  systemOutputTps?: number | null
  goodputRps?: number | null
  /** Official AIPerf good_request_fraction in [0, 1], not Goodput/RPS. */
  goodRequestFraction?: number | null
  sweepPoints?: readonly SweepDiagnosticPoint[]
}

function pct(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

function numberText(value: number, suffix = ''): string {
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)}${suffix}`
}

function breachFinding(
  id: string,
  title: string,
  observed: number | null | undefined,
  target: number | null | undefined,
  metric: 'TTFT' | 'TPOT' | 'E2E',
): AnalysisFinding | null {
  if (!isNonNegative(observed) || !isPositive(target) || observed <= target) return null
  const ratio = observed / target
  const isTpot = metric === 'TPOT'
  const isE2e = metric === 'E2E'
  return {
    id,
    severity: ratio >= 1.5 ? 'critical' : 'warning',
    category: 'experience',
    title,
    evidence: [`${metric} p95 ${numberText(observed, ' ms')}，目标 ≤ ${numberText(target, ' ms')}（${ratio.toFixed(2)}×）`],
    possibleCauses: isTpot
      ? ['decode 显存带宽或批调度已饱和', '长 prefill 与 decode 相互干扰']
      : isE2e
        ? ['排队、prefill 或 decode 任一阶段超预算', '输出长度分布与目标场景不一致']
        : ['接入/引擎排队扩大', 'prefill 算力不足或长输入阻塞'],
    nextChecks: isTpot
      ? ['检查 decode batch、GPU 利用率和 TPOT 随负载曲线', '评估 chunked prefill 或 P/D 分离']
      : isE2e
        ? ['拆分 TTFT、TPOT、排队时间和实际 OSL', '按同一 workload fingerprint 重跑 sweep']
        : ['拆分 queue time 与 prefill time', '核对 ISL 分布、缓存命中和 prefill 池容量'],
    relatedArchComponents: isTpot
      ? ['decode-worker', 'continuous-batching', 'chunked-prefill']
      : isE2e
        ? ['app-client', 'engine-replica', 'pd-scheduler']
        : ['prefill-worker', 'engine-metrics', 'pd-scheduler'],
  }
}

function findSaturationPair(points: readonly SweepDiagnosticPoint[]): [SweepDiagnosticPoint, SweepDiagnosticPoint] | null {
  const valid = points
    .filter((point) => isNonNegative(point.load) && isNonNegative(point.systemOutputTps))
    .sort((left, right) => left.load - right.load)

  for (let index = 1; index < valid.length; index += 1) {
    const previous = valid[index - 1]
    const current = valid[index]
    if (!previous || !current || !isPositive(previous.load) || !isPositive(previous.systemOutputTps)) continue
    const loadGrowth = current.load / previous.load - 1
    const throughputGrowth = (current.systemOutputTps ?? 0) / previous.systemOutputTps - 1
    if (loadGrowth < 0.1 || throughputGrowth > 0.05) continue

    const previousLatency = previous.e2eP95Ms ?? previous.ttftP95Ms
    const currentLatency = current.e2eP95Ms ?? current.ttftP95Ms
    const latencyWorsened =
      isPositive(previousLatency) && isNonNegative(currentLatency) ? currentLatency / previousLatency >= 1.1 : false
    const goodputStopped =
      isNonNegative(previous.goodputRps) && isNonNegative(current.goodputRps)
        ? current.goodputRps <= previous.goodputRps * 1.05
        : false
    if (latencyWorsened || goodputStopped) return [previous, current]
  }
  return null
}

/** Deterministic evidence rules. Missing metrics simply suppress their rule; they are never treated as zero. */
export function diagnoseInference(snapshot: DiagnosticSnapshot): AnalysisFinding[] {
  const findings: AnalysisFinding[] = []
  const breaches = [
    breachFinding('ttft-slo-breach', 'TTFT 已超过体验 SLO', snapshot.ttftP95Ms, snapshot.ttftTargetMs, 'TTFT'),
    breachFinding('tpot-slo-breach', 'TPOT 已超过流畅度 SLO', snapshot.tpotP95Ms, snapshot.tpotTargetMs, 'TPOT'),
    breachFinding(
      'e2e-slo-breach',
      '端到端延迟已超过 SLO',
      snapshot.e2eLatencyP95Ms,
      snapshot.e2eTargetMs,
      'E2E',
    ),
  ]
  for (const finding of breaches) if (finding !== null) findings.push(finding)

  if (
    isPositive(snapshot.queueTimeP95Ms) &&
    (snapshot.queueTimeP95Ms >= 100 ||
      (isPositive(snapshot.ttftP95Ms) && snapshot.queueTimeP95Ms / snapshot.ttftP95Ms >= 0.25))
  ) {
    findings.push({
      id: 'queue-pressure',
      severity: isPositive(snapshot.queuedRequests) && snapshot.queuedRequests >= 10 ? 'critical' : 'warning',
      category: 'resource',
      title: '排队正在吞噬 TTFT 预算',
      evidence: [
        `queue time p95 ${numberText(snapshot.queueTimeP95Ms, ' ms')}`,
        isNonNegative(snapshot.queuedRequests) ? `排队请求 ${numberText(snapshot.queuedRequests)}` : '排队深度未采集',
      ],
      possibleCauses: ['到达率超过当前有效服务率', '路由或配额造成局部副本热点'],
      nextChecks: ['查看各副本队列分布与 arrival rate', '核对限流、路由和扩容信号'],
      relatedArchComponents: ['engine-metrics', 'keda-autoscaler', 'gw-inference-ext'],
    })
  }

  if (isFiniteNumber(snapshot.kvCacheUtilizationPct) && snapshot.kvCacheUtilizationPct >= 90) {
    findings.push({
      id: 'kv-pressure',
      severity: snapshot.kvCacheUtilizationPct >= 97 ? 'critical' : 'warning',
      category: 'resource',
      title: 'KV cache 接近容量上限',
      evidence: [`KV cache 使用率 ${pct(snapshot.kvCacheUtilizationPct)}`],
      possibleCauses: ['并发或上下文长度超出显存预算', 'KV block 配置或显存预留不合理'],
      nextChecks: ['联查抢占率、上下文长度和 batch', '评估量化、分页配置或扩容'],
      relatedArchComponents: ['kv-hbm', 'paged-attention', 'quantization'],
    })
  }

  if (isPositive(snapshot.preemptionRatePerSecond)) {
    findings.push({
      id: 'preemption-active',
      severity: snapshot.preemptionRatePerSecond >= 1 ? 'critical' : 'warning',
      category: 'resource',
      title: '引擎正在抢占请求',
      evidence: [`抢占速率 ${numberText(snapshot.preemptionRatePerSecond, '/s')}`],
      possibleCauses: ['KV cache 空间不足', '调度并发超过稳定容量'],
      nextChecks: ['核对引擎抢占模式与重算开销', '降低并发或增加 KV 容量后复测'],
      relatedArchComponents: ['paged-attention', 'kv-hbm', 'continuous-batching'],
    })
  }

  if (
    isNonNegative(snapshot.prefixCacheHitRatePct) &&
    isNonNegative(snapshot.expectedPrefixCacheHitRatePct) &&
    snapshot.expectedPrefixCacheHitRatePct - snapshot.prefixCacheHitRatePct >= 10
  ) {
    findings.push({
      id: 'cache-hit-gap',
      severity: 'warning',
      category: 'resource',
      title: '前缀缓存命中低于场景预期',
      evidence: [
        `实测命中 ${pct(snapshot.prefixCacheHitRatePct)}，场景预期 ${pct(snapshot.expectedPrefixCacheHitRatePct)}`,
      ],
      possibleCauses: ['负载均衡打散相同前缀', '缓存容量、淘汰策略或模板键不一致'],
      nextChecks: ['检查请求路由与 prefix hash', '按副本查看命中率和淘汰指标'],
      relatedArchComponents: ['prefix-cache', 'kv-router', 'radix-attention'],
    })
  }

  if (
    isFiniteNumber(snapshot.gpuUtilizationPct) &&
    snapshot.gpuUtilizationPct < 50 &&
    (isPositive(snapshot.queuedRequests) || isPositive(snapshot.queueTimeP95Ms))
  ) {
    findings.push({
      id: 'gpu-underfed-with-queue',
      severity: 'warning',
      category: 'resource',
      title: 'GPU 未跑满但请求仍在排队',
      evidence: [`GPU 利用率 ${pct(snapshot.gpuUtilizationPct)}`, '排队信号为非零'],
      possibleCauses: ['CPU/tokenizer、网络或调度成为前置瓶颈', '负载路由不均或 batch 组不起来'],
      nextChecks: ['检查 tokenizer/网关耗时和每副本流量', '核对连续批处理与调度配置'],
      relatedArchComponents: ['openai-api', 'gw-inference-ext', 'continuous-batching', 'gpu'],
    })
  }

  if (isFiniteNumber(snapshot.gpuMemoryUtilizationPct) && snapshot.gpuMemoryUtilizationPct >= 95) {
    findings.push({
      id: 'gpu-memory-pressure',
      severity: snapshot.gpuMemoryUtilizationPct >= 99 ? 'critical' : 'warning',
      category: 'resource',
      title: 'GPU 显存余量过低',
      evidence: [`显存利用率 ${pct(snapshot.gpuMemoryUtilizationPct)}`],
      possibleCauses: ['权重、KV cache 和运行时预留挤占显存', '并发或上下文峰值超出规划'],
      nextChecks: ['拆分权重/KV/运行时显存', '核对峰值上下文并评估量化或扩容'],
      relatedArchComponents: ['gpu', 'kv-hbm', 'quantization'],
    })
  }

  if (
    isNonNegative(snapshot.powerWatts) &&
    isPositive(snapshot.maxPowerWatts) &&
    snapshot.powerWatts / snapshot.maxPowerWatts >= 0.95
  ) {
    findings.push({
      id: 'gpu-power-limit',
      severity: 'warning',
      category: 'resource',
      title: 'GPU 功耗接近配置上限',
      evidence: [
        `板卡功耗 ${numberText(snapshot.powerWatts, ' W')} / 上限 ${numberText(snapshot.maxPowerWatts, ' W')}`,
      ],
      possibleCauses: ['工作负载已触及功率预算', '机房供电或散热策略触发功率限制'],
      nextChecks: ['联查 GPU 时钟、温度与 power throttle 原因', '核对机架供电和散热容量'],
      relatedArchComponents: ['gpu'],
    })
  }

  const saturationPair = snapshot.sweepPoints ? findSaturationPair(snapshot.sweepPoints) : null
  if (saturationPair !== null) {
    const [previous, current] = saturationPair
    findings.push({
      id: 'throughput-saturation',
      severity: 'warning',
      category: 'capacity',
      title: 'Sweep 已进入吞吐饱和区',
      evidence: [
        `负载 ${numberText(previous.load)} → ${numberText(current.load)}`,
        `系统 TPS ${numberText(previous.systemOutputTps ?? 0)} → ${numberText(current.systemOutputTps ?? 0)}`,
      ],
      possibleCauses: ['计算、显存带宽或调度容量已达到平台上限', '更高 offered load 主要转化为排队与长尾'],
      nextChecks: ['将饱和点前最后一个 SLO 可行点作为候选运行区', '联查 GPU、KV、排队和 Goodput 曲线'],
      relatedArchComponents: ['engine-metrics', 'continuous-batching', 'gpu'],
    })
  }

  if (!isNonNegative(snapshot.goodputRps) && (isNonNegative(snapshot.rps) || isNonNegative(snapshot.systemOutputTps))) {
    findings.push({
      id: 'goodput-missing',
      severity: 'info',
      category: 'capacity',
      title: '本次结果未携带 Goodput',
      evidence: ['存在裸吞吐指标，但没有 AIPerf 预计算 Goodput'],
      possibleCauses: ['运行时未配置 --goodput SLO', '导入的汇总文件未包含 Goodput 字段'],
      nextChecks: ['使用明确的逐请求 SLO 和 --goodput 重新运行 AIPerf'],
      relatedArchComponents: ['engine-metrics', 'sla-planner'],
    })
  }

  if (isFiniteNumber(snapshot.goodRequestFraction) && snapshot.goodRequestFraction < 0.95) {
    findings.push({
      id: 'good-request-fraction-low',
      severity: snapshot.goodRequestFraction < 0.8 ? 'critical' : 'warning',
      category: 'capacity',
      title: '达标请求占比偏低',
      evidence: [`good_request_fraction ${pct(snapshot.goodRequestFraction * 100)}`],
      possibleCauses: ['请求延迟未同时满足已配置 SLO', '错误请求计入了达标率分母'],
      nextChecks: ['分别检查 good_request_count、request_count 与 error_request_count', '定位违反最多的逐请求 SLO'],
      relatedArchComponents: ['engine-metrics', 'sla-planner', 'tenant-gateway'],
    })
  }

  return findings
}

export interface SizingTopology {
  gpusPerServer: number | null
  serversPerRack: number | null
}

export interface SizingInput {
  targetGoodRps: number
  /** AIPerf Goodput for one deployment unit. null/undefined means no measured SLO-qualified capacity. */
  measuredGoodputRpsPerUnit?: number | null
  /** Optional roofline or raw-throughput fallback; its result is explicitly not SLO-validated. */
  estimatedRpsPerUnit?: number | null
  headroom?: number
  spareUnits?: number
  gpusPerUnit?: number
  topology?: SizingTopology | null
}

function unavailableSizing(
  targetGoodRps: number,
  headroom: number,
  spareUnits: number,
  note: string,
): SizingResult {
  return {
    basis: 'unavailable',
    sloValidated: false,
    targetGoodRps,
    headroom,
    spareUnits,
    capacityRpsPerUnit: null,
    baseUnits: null,
    totalUnits: null,
    gpuCount: null,
    serverCount: null,
    rackCount: null,
    note,
  }
}

/**
 * Capacity units = ceil(target Good RPS × (1 + headroom) / per-unit capacity) + spare units.
 * Server/rack counts remain null until their explicit topology divisors are provided.
 */
export function calculateSizing(input: SizingInput): SizingResult {
  const targetGoodRps = input.targetGoodRps
  const headroom = input.headroom ?? 0.2
  const spareUnits = input.spareUnits ?? 1
  const gpusPerUnit = input.gpusPerUnit ?? 1

  if (
    !isNonNegative(targetGoodRps) ||
    !isNonNegative(headroom) ||
    !Number.isInteger(spareUnits) ||
    spareUnits < 0 ||
    !Number.isInteger(gpusPerUnit) ||
    gpusPerUnit < 1
  ) {
    return unavailableSizing(
      isNonNegative(targetGoodRps) ? targetGoodRps : 0,
      isNonNegative(headroom) ? headroom : 0,
      Number.isInteger(spareUnits) && spareUnits >= 0 ? spareUnits : 0,
      'Sizing 输入无效：目标、余量必须为非负有限数，单元与 GPU 数必须为有效整数。',
    )
  }

  let basis: SizingResult['basis'] = 'unavailable'
  let capacityRpsPerUnit: number | null = null
  let note = '缺少实测 Goodput 与可用估算，无法计算容量。'

  if (input.measuredGoodputRpsPerUnit != null) {
    if (isPositive(input.measuredGoodputRpsPerUnit)) {
      basis = 'measured-goodput'
      capacityRpsPerUnit = input.measuredGoodputRpsPerUnit
      note = '按实测 AIPerf Goodput 计算，容量已由本次运行的 SLO 验证。'
    } else {
      return unavailableSizing(targetGoodRps, headroom, spareUnits, '实测 Goodput 为零或无效，当前配置没有可承诺容量。')
    }
  } else if (isPositive(input.estimatedRpsPerUnit)) {
    basis = 'estimated-throughput'
    capacityRpsPerUnit = input.estimatedRpsPerUnit
    note = '仅按公式/裸吞吐估算，未验证体验 SLO；不可作为容量承诺。'
  }

  if (capacityRpsPerUnit === null) return unavailableSizing(targetGoodRps, headroom, spareUnits, note)

  const requiredWithHeadroom = targetGoodRps * (1 + headroom)
  if (!Number.isFinite(requiredWithHeadroom)) {
    return unavailableSizing(targetGoodRps, headroom, spareUnits, '目标与余量乘积溢出，无法计算容量。')
  }
  const baseUnits = Math.ceil(requiredWithHeadroom / capacityRpsPerUnit)
  const totalUnits = baseUnits + spareUnits
  const gpuCount = totalUnits * gpusPerUnit
  if (![baseUnits, totalUnits, gpuCount].every(Number.isSafeInteger)) {
    return unavailableSizing(targetGoodRps, headroom, spareUnits, 'Sizing 结果超出安全整数范围。')
  }

  const gpusPerServer = input.topology?.gpusPerServer
  const serversPerRack = input.topology?.serversPerRack
  const serverCount = Number.isInteger(gpusPerServer) && isPositive(gpusPerServer) ? Math.ceil(gpuCount / gpusPerServer) : null
  const rackCount =
    serverCount !== null && Number.isInteger(serversPerRack) && isPositive(serversPerRack)
      ? Math.ceil(serverCount / serversPerRack)
      : null

  return {
    basis,
    sloValidated: basis === 'measured-goodput',
    targetGoodRps,
    headroom,
    spareUnits,
    capacityRpsPerUnit,
    baseUnits,
    totalUnits,
    gpuCount,
    serverCount,
    rackCount,
    note,
  }
}

/** Useful to group findings without coupling the UI to rule identifiers. */
export function groupFindingsByCategory(
  findings: readonly AnalysisFinding[],
): Readonly<Record<KpiCategory, readonly AnalysisFinding[]>> {
  return {
    experience: findings.filter((finding) => finding.category === 'experience'),
    capacity: findings.filter((finding) => finding.category === 'capacity'),
    resource: findings.filter((finding) => finding.category === 'resource'),
    cost: findings.filter((finding) => finding.category === 'cost'),
  }
}
