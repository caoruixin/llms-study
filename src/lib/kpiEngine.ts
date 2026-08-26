import type {
  AnalysisFinding,
  BenchmarkFingerprint,
  KpiCategory,
  MetricObservation,
  SizingResult,
} from '../data/inferenceKpis'

export type ObservationKind = MetricObservation['kind']

/**
 * MetricObservation 的轻量入参形态：诊断与 Sizing 只需要区分目标值/估算值/实测值，
 * 不强求完整 MetricObservation 字段，避免调用侧为一次判定构造整条观测记录。
 */
export interface ObservedValue {
  value: number
  kind: ObservationKind
}

export function observed(value: number | null | undefined, kind: ObservationKind = 'measured'): ObservedValue | null {
  return typeof value === 'number' && Number.isFinite(value) ? { value, kind } : null
}

/** 证据规则只认实测值；目标/估算来源的数字不能冒充实测证据。 */
function measuredNumber(observation: ObservedValue | null | undefined): number | null {
  return observation != null && observation.kind === 'measured' && Number.isFinite(observation.value)
    ? observation.value
    : null
}

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
    // 空窗口（0 请求）没有达标率可言：0/0 必须是 null，不能被解读成 0% 达标。
    const fraction = safeDivide(input.goodRequestCount, requests + errors)
    if (fraction !== null && fraction <= 1) goodRequestFraction = fraction
  }

  return { rps, systemOutputTps, goodputRps, goodRequestFraction }
}

/**
 * 有效利用率是成本模型的一部分：集群不可能全天贴着基准吞吐跑，
 * 摊薄分母是「系统输出 TPS × 有效利用率」。默认 1 表示按名义满载口径。
 */
export function costPerMillionOutputTokens(
  clusterHourlyUsd: number,
  systemOutputTps: number,
  utilization = 1,
): number | null {
  if (!isNonNegative(clusterHourlyUsd) || !isPositive(systemOutputTps)) return null
  if (!isPositive(utilization) || utilization > 1) return null
  return safeDivide(clusterHourlyUsd * 1_000_000, systemOutputTps * 3600 * utilization)
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
  // 空对象等同于「没有声明任何约束」：显式归入 missing，不能与另一个空对象比出 comparable。
  if (entries.length === 0) return null
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

/**
 * 证据字段一律携带观测来源（{value, kind}）：诊断规则只消费 kind==='measured' 的数值，
 * 目标值走独立的 *TargetMs / *Target 字段（字段名即语义），场景假设不能混进实测证据。
 */
export interface DiagnosticSnapshot {
  ttftP95Ms?: ObservedValue | null
  ttftTargetMs?: number | null
  tpotP95Ms?: ObservedValue | null
  tpotTargetMs?: number | null
  e2eLatencyP95Ms?: ObservedValue | null
  e2eTargetMs?: number | null
  queueTimeP95Ms?: ObservedValue | null
  queuedRequests?: ObservedValue | null
  kvCacheUtilizationPct?: ObservedValue | null
  preemptionRatePerSecond?: ObservedValue | null
  /**
   * 采样窗口内的抢占次数。vLLM `vllm:num_preemptions_total` 这类进程级单调 counter
   * 是启动以来的累计值，不是窗口计数；取值侧拿不到窗口差分时必须传 null 抑制规则。
   */
  preemptionCountInWindow?: ObservedValue | null
  prefixCacheHitRatePct?: ObservedValue | null
  /** 预期命中率是用户/场景侧输入（kind 为 target 或 estimated），不与实测值同源。 */
  expectedPrefixCacheHitRatePct?: ObservedValue | null
  gpuUtilizationPct?: ObservedValue | null
  gpuMemoryUtilizationPct?: ObservedValue | null
  powerWatts?: ObservedValue | null
  maxPowerWatts?: ObservedValue | null
  rps?: ObservedValue | null
  systemOutputTps?: ObservedValue | null
  goodputRps?: ObservedValue | null
  /** Official AIPerf good_request_fraction in [0, 1], not Goodput/RPS. */
  goodRequestFraction?: ObservedValue | null
  /** Customer-required attainment in [0, 1]; no universal threshold is assumed. */
  goodRequestFractionTarget?: number | null
  /** Sweep 曲线点均来自实测图表数据，保持数值形态。 */
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

/** 饱和判定的唯一实现；metricUi 的图表侧同样调用这里，不再各持一份拷贝。 */
export function findSaturationPair<T extends SweepDiagnosticPoint>(points: readonly T[]): [T, T] | null {
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

    // 相除的两端必须是同一延迟指标：优先两点都有的 e2eP95，其次两点都有的 ttftP95；
    // 一端 E2E 一端 TTFT 直接对比会凭空放大或掩盖恶化，宁可判 false。
    const latencyPair: [number, number] | null =
      isFiniteNumber(previous.e2eP95Ms) && isFiniteNumber(current.e2eP95Ms)
        ? [previous.e2eP95Ms, current.e2eP95Ms]
        : isFiniteNumber(previous.ttftP95Ms) && isFiniteNumber(current.ttftP95Ms)
          ? [previous.ttftP95Ms, current.ttftP95Ms]
          : null
    const latencyWorsened =
      latencyPair !== null && isPositive(latencyPair[0]) && isNonNegative(latencyPair[1])
        ? latencyPair[1] / latencyPair[0] >= 1.1
        : false
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
  const ttftP95Ms = measuredNumber(snapshot.ttftP95Ms)
  const queueTimeP95Ms = measuredNumber(snapshot.queueTimeP95Ms)
  const queuedRequests = measuredNumber(snapshot.queuedRequests)
  const kvCacheUtilizationPct = measuredNumber(snapshot.kvCacheUtilizationPct)
  const preemptionRatePerSecond = measuredNumber(snapshot.preemptionRatePerSecond)
  const preemptionCountInWindow = measuredNumber(snapshot.preemptionCountInWindow)
  const prefixCacheHitRatePct = measuredNumber(snapshot.prefixCacheHitRatePct)
  const gpuUtilizationPct = measuredNumber(snapshot.gpuUtilizationPct)
  const gpuMemoryUtilizationPct = measuredNumber(snapshot.gpuMemoryUtilizationPct)
  const powerWatts = measuredNumber(snapshot.powerWatts)
  const maxPowerWatts = measuredNumber(snapshot.maxPowerWatts)
  const rps = measuredNumber(snapshot.rps)
  const systemOutputTps = measuredNumber(snapshot.systemOutputTps)
  const goodputRps = measuredNumber(snapshot.goodputRps)
  const goodRequestFraction = measuredNumber(snapshot.goodRequestFraction)

  const breaches = [
    breachFinding('ttft-slo-breach', 'TTFT 已超过体验 SLO', ttftP95Ms, snapshot.ttftTargetMs, 'TTFT'),
    breachFinding('tpot-slo-breach', 'TPOT 已超过流畅度 SLO', measuredNumber(snapshot.tpotP95Ms), snapshot.tpotTargetMs, 'TPOT'),
    breachFinding(
      'e2e-slo-breach',
      '端到端延迟已超过 SLO',
      measuredNumber(snapshot.e2eLatencyP95Ms),
      snapshot.e2eTargetMs,
      'E2E',
    ),
  ]
  for (const finding of breaches) if (finding !== null) findings.push(finding)

  // 排队没有普适的绝对阈值：只能看它挤占了多少 TTFT 预算。
  // 分母优先取场景 TTFT SLO，缺 SLO 时退回实测 TTFT p95；两者都没有就抑制规则。
  const queueBudgetMs = isPositive(snapshot.ttftTargetMs)
    ? snapshot.ttftTargetMs
    : isPositive(ttftP95Ms)
      ? ttftP95Ms
      : null
  if (isPositive(queueTimeP95Ms) && queueBudgetMs !== null) {
    const queueShare = queueTimeP95Ms / queueBudgetMs
    if (queueShare >= 0.25) {
      findings.push({
        id: 'queue-pressure',
        severity: queueShare >= 0.5 ? 'critical' : 'warning',
        category: 'resource',
        title: '排队正在吞噬 TTFT 预算',
        evidence: [
          `queue time p95 ${numberText(queueTimeP95Ms, ' ms')}，占${
            isPositive(snapshot.ttftTargetMs) ? ' TTFT SLO 预算' : '实测 TTFT p95 '
          }的 ${pct(queueShare * 100)}`,
          isNonNegative(queuedRequests) ? `排队请求 ${numberText(queuedRequests)}` : '排队深度未采集',
        ],
        possibleCauses: ['到达率超过当前有效服务率', '路由或配额造成局部副本热点'],
        nextChecks: ['查看各副本队列分布与 arrival rate', '核对限流、路由和扩容信号'],
        relatedArchComponents: ['engine-metrics', 'keda-autoscaler', 'gw-inference-ext'],
      })
    }
  }

  if (isFiniteNumber(kvCacheUtilizationPct) && kvCacheUtilizationPct >= 90) {
    findings.push({
      id: 'kv-pressure',
      severity: kvCacheUtilizationPct >= 97 ? 'critical' : 'warning',
      category: 'resource',
      title: 'KV cache 接近容量上限',
      evidence: [`KV cache 使用率 ${pct(kvCacheUtilizationPct)}`],
      possibleCauses: ['并发或上下文长度超出显存预算', 'KV block 配置或显存预留不合理'],
      nextChecks: ['联查抢占率、上下文长度和 batch', '评估量化、分页配置或扩容'],
      relatedArchComponents: ['kv-hbm', 'paged-attention', 'quantization'],
    })
  }

  if (isPositive(preemptionRatePerSecond) || isPositive(preemptionCountInWindow)) {
    const preemptionEvidence = isPositive(preemptionRatePerSecond)
      ? `抢占速率 ${numberText(preemptionRatePerSecond, '/s')}`
      : `采样窗口抢占计数 ${numberText(preemptionCountInWindow ?? 0)}`
    findings.push({
      id: 'preemption-active',
      severity: (preemptionRatePerSecond ?? 0) >= 1 || (preemptionCountInWindow ?? 0) >= 10 ? 'critical' : 'warning',
      category: 'resource',
      title: '引擎正在抢占请求',
      evidence: [preemptionEvidence],
      possibleCauses: ['KV cache 空间不足', '调度并发超过稳定容量'],
      nextChecks: ['核对引擎抢占模式与重算开销', '降低并发或增加 KV 容量后复测'],
      relatedArchComponents: ['paged-attention', 'kv-hbm', 'continuous-batching'],
    })
  }

  // 预期命中率是用户目标或场景估算，与实测命中率分属两种来源；
  // kind 混同（拿另一次实测冒充预期）时直接抑制，不做跨来源判定。
  const expectedHit = snapshot.expectedPrefixCacheHitRatePct
  if (
    isNonNegative(prefixCacheHitRatePct) &&
    expectedHit != null &&
    (expectedHit.kind === 'target' || expectedHit.kind === 'estimated') &&
    isNonNegative(expectedHit.value) &&
    expectedHit.value - prefixCacheHitRatePct >= 10
  ) {
    findings.push({
      id: 'cache-hit-gap',
      severity: 'warning',
      category: 'resource',
      title: '前缀缓存命中低于预期',
      evidence: [
        `实测命中 ${pct(prefixCacheHitRatePct)}，${expectedHit.kind === 'target' ? '用户设定预期' : '场景估算预期'} ${pct(expectedHit.value)}`,
      ],
      possibleCauses: ['负载均衡打散相同前缀', '缓存容量、淘汰策略或模板键不一致'],
      nextChecks: ['检查请求路由与 prefix hash', '按副本查看命中率和淘汰指标'],
      relatedArchComponents: ['prefix-cache', 'kv-router', 'radix-attention'],
    })
  }

  if (
    isFiniteNumber(gpuUtilizationPct) &&
    gpuUtilizationPct < 50 &&
    (isPositive(queuedRequests) || isPositive(queueTimeP95Ms))
  ) {
    findings.push({
      id: 'gpu-underfed-with-queue',
      severity: 'warning',
      category: 'resource',
      title: 'GPU 未跑满但请求仍在排队',
      evidence: [`GPU 利用率 ${pct(gpuUtilizationPct)}`, '排队信号为非零'],
      possibleCauses: ['CPU/tokenizer、网络或调度成为前置瓶颈', '负载路由不均或 batch 组不起来'],
      nextChecks: ['检查 tokenizer/网关耗时和每副本流量', '核对连续批处理与调度配置'],
      relatedArchComponents: ['openai-api', 'gw-inference-ext', 'continuous-batching', 'gpu'],
    })
  }

  if (isFiniteNumber(gpuMemoryUtilizationPct) && gpuMemoryUtilizationPct >= 95) {
    findings.push({
      id: 'gpu-memory-pressure',
      severity: gpuMemoryUtilizationPct >= 99 ? 'critical' : 'warning',
      category: 'resource',
      title: 'GPU 显存余量过低',
      evidence: [`显存利用率 ${pct(gpuMemoryUtilizationPct)}`],
      possibleCauses: ['权重、KV cache 和运行时预留挤占显存', '并发或上下文峰值超出规划'],
      nextChecks: ['拆分权重/KV/运行时显存', '核对峰值上下文并评估量化或扩容'],
      relatedArchComponents: ['gpu', 'kv-hbm', 'quantization'],
    })
  }

  if (isNonNegative(powerWatts) && isPositive(maxPowerWatts) && powerWatts / maxPowerWatts >= 0.95) {
    findings.push({
      id: 'gpu-power-limit',
      severity: 'warning',
      category: 'resource',
      title: 'GPU 功耗接近配置上限',
      evidence: [
        `板卡功耗 ${numberText(powerWatts, ' W')} / 上限 ${numberText(maxPowerWatts, ' W')}`,
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

  if (!isNonNegative(goodputRps) && (isNonNegative(rps) || isNonNegative(systemOutputTps))) {
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

  if (
    isFiniteNumber(goodRequestFraction) &&
    isFiniteNumber(snapshot.goodRequestFractionTarget) &&
    snapshot.goodRequestFractionTarget >= 0 &&
    snapshot.goodRequestFractionTarget <= 1 &&
    goodRequestFraction < snapshot.goodRequestFractionTarget
  ) {
    findings.push({
      id: 'good-request-fraction-low',
      // Severity is relative to the customer-provided gate; do not introduce a
      // second, hidden universal attainment threshold.
      severity:
        snapshot.goodRequestFractionTarget > 0 &&
        goodRequestFraction / snapshot.goodRequestFractionTarget < 0.8
          ? 'critical'
          : 'warning',
      category: 'capacity',
      title: '达标请求占比偏低',
      evidence: [
        `good_request_fraction ${pct(goodRequestFraction * 100)}，客户目标 ${pct(snapshot.goodRequestFractionTarget * 100)}`,
      ],
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
  /**
   * 单个部署单元的 Goodput 观测值。只有 kind==='measured' 才能进入
   * measured-goodput / sloValidated 路径；estimated 来源一律降级为方向性估算。
   */
  goodputRpsPerUnit?: ObservedValue | null
  /** Optional roofline or raw-throughput fallback; its result is explicitly not SLO-validated. */
  estimatedRpsPerUnit?: number | null
  headroom?: number
  spareUnits?: number
  /** 缺失时不暗设 1 卡单元：gpuCount 保持 null，对齐 server/rack 的显式拓扑要求。 */
  gpusPerUnit?: number | null
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
  const gpusPerUnit = input.gpusPerUnit ?? null

  if (
    !isNonNegative(targetGoodRps) ||
    !isNonNegative(headroom) ||
    !Number.isInteger(spareUnits) ||
    spareUnits < 0 ||
    (gpusPerUnit !== null && (!Number.isInteger(gpusPerUnit) || gpusPerUnit < 1))
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

  const goodputObservation = input.goodputRpsPerUnit ?? null
  if (goodputObservation !== null && goodputObservation.kind === 'measured') {
    if (isPositive(goodputObservation.value)) {
      basis = 'measured-goodput'
      capacityRpsPerUnit = goodputObservation.value
      note = '按实测 AIPerf Goodput 计算，容量已由本次运行的 SLO 验证。'
    } else {
      return unavailableSizing(targetGoodRps, headroom, spareUnits, '实测 Goodput 为零或无效，当前配置没有可承诺容量。')
    }
  } else {
    // estimated 来源的 Goodput 不携带任何 SLO 验证效力，与裸吞吐估算同级；
    // target 是需求侧目标而非容量证据，直接忽略。
    const fallbackRpsPerUnit =
      goodputObservation?.kind === 'estimated' && isPositive(goodputObservation.value)
        ? goodputObservation.value
        : isPositive(input.estimatedRpsPerUnit)
          ? input.estimatedRpsPerUnit
          : null
    if (fallbackRpsPerUnit !== null) {
      basis = 'estimated-throughput'
      capacityRpsPerUnit = fallbackRpsPerUnit
      note = '仅按公式/裸吞吐估算，未验证体验 SLO；不可作为容量承诺。'
    }
  }

  if (capacityRpsPerUnit === null) return unavailableSizing(targetGoodRps, headroom, spareUnits, note)

  const requiredWithHeadroom = targetGoodRps * (1 + headroom)
  if (!Number.isFinite(requiredWithHeadroom)) {
    return unavailableSizing(targetGoodRps, headroom, spareUnits, '目标与余量乘积溢出，无法计算容量。')
  }
  const baseUnits = Math.ceil(requiredWithHeadroom / capacityRpsPerUnit)
  const totalUnits = baseUnits + spareUnits
  const gpuCount = gpusPerUnit === null ? null : totalUnits * gpusPerUnit
  if (![baseUnits, totalUnits, ...(gpuCount === null ? [] : [gpuCount])].every(Number.isSafeInteger)) {
    return unavailableSizing(targetGoodRps, headroom, spareUnits, 'Sizing 结果超出安全整数范围。')
  }

  const gpusPerServer = input.topology?.gpusPerServer
  const serversPerRack = input.topology?.serversPerRack
  const serverCount =
    gpuCount !== null && Number.isInteger(gpusPerServer) && isPositive(gpusPerServer)
      ? Math.ceil(gpuCount / gpusPerServer)
      : null
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

export type MeasuredSizingGateKey = 'ttftMs' | 'tpotMs' | 'e2eMs' | 'gpuCount'

export interface MeasuredSizingGateMismatch {
  key: MeasuredSizingGateKey
  label: string
  /** null 表示场景声明了该约束，但 run 侧没有对应 --goodput 约束或元数据。 */
  runValue: number | null
  scenarioValue: number
}

export interface MeasuredSizingGateResult {
  eligible: boolean
  mismatches: readonly MeasuredSizingGateMismatch[]
}

export interface MeasuredSizingGateInput {
  /** fingerprint 解析出的 run 侧 --goodput 约束（键名自由格式，数值按 AIPerf 惯例视为 ms）。 */
  runSlo: Readonly<Record<string, number>> | null
  runGpuCount: number | null
  scenarioSlo: { ttftMs: number | null; tpotMs: number | null; e2eMs: number | null }
  scenarioGpusPerUnit: number
}

const SLO_GATE_DIMENSIONS: readonly { key: Exclude<MeasuredSizingGateKey, 'gpuCount'>; label: string; pattern: RegExp }[] = [
  { key: 'ttftMs', label: 'TTFT p95', pattern: /ttft|timetofirsttoken/ },
  { key: 'tpotMs', label: 'TPOT p95', pattern: /tpot|itl|intertokenlatency|timeperoutputtoken/ },
  { key: 'e2eMs', label: 'E2E p95', pattern: /e2e|requestlatency|endtoend/ },
]

/**
 * 实测 Goodput 是「相对 run 自己的 --goodput 约束」统计出来的。要把它套到当前场景的
 * 容量承诺上，run 的每一维阈值必须不宽于（<=）场景 SLO：场景声明了而 run 没配同维约束、
 * 或 run 阈值更宽，实测 Goodput 都可能高估场景口径下的容量，必须禁用 measured 路径。
 */
export function validateMeasuredSizingGate(input: MeasuredSizingGateInput): MeasuredSizingGateResult {
  const mismatches: MeasuredSizingGateMismatch[] = []
  const runEntries = Object.entries(input.runSlo ?? {}).map(
    ([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ''), value] as const,
  )

  for (const { key, label, pattern } of SLO_GATE_DIMENSIONS) {
    const scenarioValue = input.scenarioSlo[key]
    if (!isNonNegative(scenarioValue)) continue
    const matched = runEntries.filter(([runKey, value]) => pattern.test(runKey) && isFiniteNumber(value))
    // run 侧同维出现多条时取最宽阈值做保守判断，避免更严的一条掩盖更宽的一条。
    const runValue = matched.length === 0 ? null : Math.max(...matched.map(([, value]) => value))
    if (runValue === null || runValue > scenarioValue) {
      mismatches.push({ key, label, runValue, scenarioValue })
    }
  }

  // GPU 数只在 run 侧提供时做证伪比对；缺失无法自动证伪，仍由人工口径确认兜底。
  if (
    isFiniteNumber(input.runGpuCount) &&
    isPositive(input.scenarioGpusPerUnit) &&
    input.runGpuCount !== input.scenarioGpusPerUnit
  ) {
    mismatches.push({
      key: 'gpuCount',
      label: '部署单元 GPU 数',
      runValue: input.runGpuCount,
      scenarioValue: input.scenarioGpusPerUnit,
    })
  }

  return { eligible: mismatches.length === 0, mismatches }
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
