/**
 * Browser-only AIPerf artifact import and normalization.
 *
 * The parser deliberately has no upload or persistence side effects. Units are
 * copied from the artifact and values are never converted. In particular,
 * Goodput is only exposed when AIPerf exported `goodput` or
 * `good_request_fraction`; this module never reconstructs it from percentile
 * summaries.
 */

export type AiperfArtifactKind =
  | 'profile'
  | 'confidence-aggregate'
  | 'collated'
  | 'sweep-aggregate'
  | 'server-metrics'
  | 'unknown'

export type AiperfArtifactFormat = 'json' | 'csv' | 'unsupported'

export interface ImportIssue {
  code: string
  message: string
  artifactName?: string
  metric?: string
}

export interface NormalizedMetric {
  /** AIPerf metric tag (or a stable snake-case tag for display-name-only CSV). */
  name: string
  /** Authoritative unit copied from the artifact; empty when the artifact omitted it. */
  unit: string
  /** Only finite numeric observations are retained. */
  stats: Record<string, number>
  scope?: 'benchmark' | 'gpu' | 'server'
  endpoint?: string
  gpuId?: string
  metricType?: string
  labels?: Record<string, string>
  seriesKey?: string
  rawValue?: string
  /** True when the metric is not one of AIPerf's commonly-known benchmark tags. */
  unknown: boolean
}

export interface NormalizedBenchmarkRun {
  key: string
  benchmarkId?: string
  sweepId?: string
  variation?: string
  variationIndex?: number
  trial?: number
  valid: boolean
  cancelled: boolean
  sourceNames: string[]
  metrics: Record<string, NormalizedMetric>
  serverMetrics: NormalizedMetric[]
  inputConfig?: Record<string, unknown>
  metadata: Record<string, unknown>
  errors: ImportIssue[]
  warnings: ImportIssue[]
}

export interface SweepPoint {
  key: string
  sweepId?: string
  benchmarkId?: string
  variation: string
  variationIndex?: number
  trial?: number
  coordinates: Record<string, unknown>
  metrics: Record<string, NormalizedMetric>
  valid: boolean
  paretoOptimal?: boolean
  sourceName?: string
}

export interface ImportedArtifact {
  key: string
  name: string
  kind: AiperfArtifactKind
  format: AiperfArtifactFormat
  schemaVersion?: string
  aiperfVersion?: string
  benchmarkId?: string
  sweepId?: string
  variation?: string
  variationIndex?: number
  trial?: number
  valid: boolean
  cancelled: boolean
  /** CSV exports omit the workload/runtime configuration needed for comparison. */
  metadataRequired: boolean
  metrics: Record<string, NormalizedMetric>
  runs: NormalizedBenchmarkRun[]
  sweepPoints: SweepPoint[]
  serverMetrics: NormalizedMetric[]
  inputConfig?: Record<string, unknown>
  metadata: Record<string, unknown>
  errors: ImportIssue[]
  warnings: ImportIssue[]
}

export interface ImportDuplicate {
  type: 'artifact' | 'run' | 'sweep-point'
  key: string
  kept: string
  dropped: string
}

export interface ImportBatch {
  artifacts: ImportedArtifact[]
  runs: NormalizedBenchmarkRun[]
  sweepPoints: SweepPoint[]
  /** Flattened metrics that could not be joined to exactly one benchmark run. */
  unassociatedServerMetrics: NormalizedMetric[]
  /** Artifact-level view of the same unassociated server metrics. */
  unassociatedServerArtifacts: ImportedArtifact[]
  duplicates: ImportDuplicate[]
  errors: ImportIssue[]
  warnings: ImportIssue[]
}

type JsonObject = Record<string, unknown>

const PROFILE_STAT_NAMES = new Set([
  'avg',
  'mean',
  'min',
  'max',
  'std',
  'count',
  'sum',
  'cv',
  'se',
  'ci_low',
  'ci_high',
  't_critical',
  'total',
  'rate',
  'rate_avg',
  'rate_min',
  'rate_max',
  'rate_std',
  'count_rate',
  'sum_rate',
  'value',
  'p1',
  'p5',
  'p10',
  'p25',
  'p50',
  'p75',
  'p90',
  'p95',
  'p99',
  'p1_estimate',
  'p5_estimate',
  'p10_estimate',
  'p25_estimate',
  'p50_estimate',
  'p75_estimate',
  'p90_estimate',
  'p95_estimate',
  'p99_estimate',
])

const KNOWN_METRIC_TAGS = new Set([
  'request_throughput',
  'request_latency',
  'request_count',
  'time_to_first_token',
  'time_to_second_token',
  'inter_token_latency',
  'inter_chunk_latency',
  'output_token_throughput',
  'output_token_throughput_per_user',
  'e2e_output_token_throughput',
  'output_sequence_length',
  'input_sequence_length',
  'goodput',
  'good_request_fraction',
  'good_request_count',
  'output_token_count',
  'reasoning_token_count',
  'total_output_tokens',
  'total_reasoning_tokens',
  'benchmark_duration',
  'total_isl',
  'total_osl',
  'error_request_count',
  'error_isl',
  'total_error_isl',
])

const DISPLAY_NAME_ALIASES: Record<string, string> = {
  'request throughput': 'request_throughput',
  'request latency': 'request_latency',
  'request count': 'request_count',
  'time to first token': 'time_to_first_token',
  'time to second token': 'time_to_second_token',
  'inter token latency': 'inter_token_latency',
  'inter-token latency': 'inter_token_latency',
  'inter chunk latency': 'inter_chunk_latency',
  'output token throughput': 'output_token_throughput',
  'output token throughput per user': 'output_token_throughput_per_user',
  'e2e output token throughput': 'e2e_output_token_throughput',
  'output sequence length': 'output_sequence_length',
  'input sequence length': 'input_sequence_length',
  goodput: 'goodput',
  'good request fraction': 'good_request_fraction',
  goodrequestfraction: 'good_request_fraction',
  'good request count': 'good_request_count',
  'output token count': 'output_token_count',
  'reasoning token count': 'reasoning_token_count',
  'total output tokens': 'total_output_tokens',
  'total reasoning tokens': 'total_reasoning_tokens',
  'total input sequence length': 'total_isl',
  'total output sequence length': 'total_osl',
  'benchmark duration': 'benchmark_duration',
  'total isl': 'total_isl',
  'total osl': 'total_osl',
  ttft: 'time_to_first_token',
  tpot: 'inter_token_latency',
  itl: 'inter_token_latency',
}

const SERVER_STAT_NAMES = new Set([
  ...PROFILE_STAT_NAMES,
  'p1_estimate',
  'p5_estimate',
  'p10_estimate',
  'p25_estimate',
  'p50_estimate',
  'p75_estimate',
  'p90_estimate',
  'p95_estimate',
  'p99_estimate',
])

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asObject(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asIndex(value: unknown): number | undefined {
  const n = toFiniteNumber(value)
  return n === undefined || n < 0 ? undefined : Math.trunc(n)
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || !value.trim()) return undefined
  const n = Number(value.trim())
  return Number.isFinite(n) ? n : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  if (/^(true|yes|1)$/i.test(value.trim())) return true
  if (/^(false|no|0)$/i.test(value.trim())) return false
  return undefined
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const booleanValue = asBoolean(trimmed)
  if (booleanValue !== undefined) return booleanValue
  const numberValue = toFiniteNumber(trimmed)
  return numberValue === undefined ? trimmed : numberValue
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!isObject(value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) return null
    return value
  }
  const result: JsonObject = {}
  for (const key of Object.keys(value).sort()) {
    const child = value[key]
    if (child !== undefined) result[key] = stableValue(child)
  }
  return result
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function stableHash(value: string): string {
  // FNV-1a (32-bit) is sufficient for local deterministic identity/deduping.
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function serverSeriesKey(
  name: string,
  endpoint: string | undefined,
  metricType: string | undefined,
  labels: Record<string, string>,
): string {
  return stableHash(stableStringify([name, endpoint, metricType, labels]))
}

function normalizedHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

function snakeCase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function canonicalMetricName(displayName: string): string {
  const normalized = displayName.trim().toLowerCase().replace(/\s+/g, ' ')
  return DISPLAY_NAME_ALIASES[normalized] ?? snakeCase(displayName)
}

function metricBaseName(name: string): string {
  const sorted = [...KNOWN_METRIC_TAGS].sort((a, b) => b.length - a.length)
  return sorted.find((tag) => name === tag || name.startsWith(`${tag}_`)) ?? name
}

function isKnownMetric(name: string): boolean {
  return KNOWN_METRIC_TAGS.has(metricBaseName(name))
}

function issue(code: string, message: string, artifactName: string, metric?: string): ImportIssue {
  return { code, message, artifactName, ...(metric ? { metric } : {}) }
}

function collectStats(value: unknown, allowedNames?: ReadonlySet<string>): Record<string, number> {
  if (!isObject(value)) return {}
  const stats: Record<string, number> = {}
  for (const [name, raw] of Object.entries(value)) {
    if (name === 'unit' || (allowedNames && !allowedNames.has(name))) continue
    const numberValue = toFiniteNumber(raw)
    if (numberValue !== undefined) stats[name] = numberValue
  }
  return stats
}

function normalizeMetric(name: string, value: unknown, scope: NormalizedMetric['scope'] = 'benchmark'): NormalizedMetric {
  const metric = asObject(value) ?? {}
  return {
    name,
    unit: asString(metric.unit) ?? '',
    stats: collectStats(metric),
    scope,
    unknown: !isKnownMetric(name),
  }
}

function hasMetricStats(value: unknown): boolean {
  if (!isObject(value)) return false
  return Object.keys(value).some((key) => PROFILE_STAT_NAMES.has(key))
}

function extractMetricBlocks(container: unknown): Record<string, NormalizedMetric> {
  if (!isObject(container)) return {}
  const metrics: Record<string, NormalizedMetric> = {}
  for (const [name, value] of Object.entries(container)) {
    if (!isObject(value) || (!('unit' in value) && !hasMetricStats(value))) continue
    metrics[name] = normalizeMetric(name, value)
  }
  return metrics
}

function validateMetricUnits(
  metrics: Iterable<NormalizedMetric>,
  artifactName: string,
  errors: ImportIssue[],
): void {
  const seen = new Set<string>()
  for (const metric of metrics) {
    if (metric.unit.trim() || seen.has(metric.name)) continue
    seen.add(metric.name)
    errors.push(
      issue(
        'missing-unit',
        `指标 ${metric.name} 缺少 unit；不会根据指标名猜测单位。`,
        artifactName,
        metric.name,
      ),
    )
  }
}

function checkZeroRequests(
  metrics: Record<string, NormalizedMetric>,
  artifactName: string,
  errors: ImportIssue[],
): void {
  const metric =
    metrics.request_count ?? Object.values(metrics).find((candidate) => metricBaseName(candidate.name) === 'request_count')
  if (!metric) return
  const value =
    metric.stats.avg ?? metric.stats.mean ?? metric.stats.value ?? metric.stats.total ?? metric.stats.count
  if (value !== undefined && value <= 0) {
    errors.push(issue('zero-requests', '请求数为 0，无法作为有效 Benchmark 运行。', artifactName, metric.name))
  }
}

function validateSchemaVersion(
  schemaVersion: string | undefined,
  artifactName: string,
  errors: ImportIssue[],
): void {
  if (!schemaVersion) return
  const match = /^(\d+)(?:\.|$)/.exec(schemaVersion.trim())
  if (!match) {
    errors.push(issue('invalid-schema-version', `无法识别 schema_version: ${schemaVersion}`, artifactName))
    return
  }
  if (Number(match[1]) !== 1) {
    errors.push(
      issue(
        'unsupported-schema-major',
        `不支持 AIPerf schema major ${match[1]}；当前仅接受 1.x。`,
        artifactName,
      ),
    )
  }
}

function addMetadataRequiredWarning(artifact: ImportedArtifact): void {
  artifact.metadataRequired = true
  artifact.warnings.push(
    issue(
      'metadata-required',
      'CSV 不包含完整运行配置；比较前需补充模型、引擎、GPU 数与拓扑、ISL/OSL 和负载指纹。',
      artifact.name,
    ),
  )
}

function buildRunKey(
  benchmarkId: string | undefined,
  sweepId: string | undefined,
  variation: string | undefined,
  trial: number | undefined,
  fallback: string,
): string {
  if (!benchmarkId && !sweepId) return `run:fallback=${fallback}`
  return [
    'run',
    `benchmark=${benchmarkId ?? '-'}`,
    `sweep=${sweepId ?? '-'}`,
    `variation=${variation ?? 'base'}`,
    `trial=${trial ?? 0}`,
  ].join('|')
}

function buildSweepPointKey(
  sweepId: string | undefined,
  benchmarkId: string | undefined,
  coordinates: Record<string, unknown>,
  trial: number | undefined,
  fallback: string,
): string {
  return [
    'sweep-point',
    `sweep=${sweepId ?? '-'}`,
    `benchmark=${benchmarkId ?? '-'}`,
    `variation=${stableStringify(coordinates)}`,
    `trial=${trial ?? 'aggregate'}`,
    !sweepId && !benchmarkId ? `source=${fallback}` : '',
  ]
    .filter(Boolean)
    .join('|')
}

function buildArtifactKey(artifact: ImportedArtifact, fingerprint: string): string {
  const identity = [
    artifact.benchmarkId ? `benchmark=${artifact.benchmarkId}` : '',
    artifact.sweepId ? `sweep=${artifact.sweepId}` : '',
    artifact.variation ? `variation=${artifact.variation}` : '',
    artifact.trial !== undefined ? `trial=${artifact.trial}` : '',
  ]
    .filter(Boolean)
    .join('|')
  return `artifact:${artifact.kind}:${identity || 'anonymous'}:${fingerprint}`
}

function baseArtifact(
  name: string,
  format: AiperfArtifactFormat,
  kind: AiperfArtifactKind,
): ImportedArtifact {
  return {
    key: '',
    name,
    kind,
    format,
    valid: false,
    cancelled: false,
    metadataRequired: false,
    metrics: {},
    runs: [],
    sweepPoints: [],
    serverMetrics: [],
    metadata: {},
    errors: [],
    warnings: [],
  }
}

function finalizeArtifact(artifact: ImportedArtifact, fingerprint: string): ImportedArtifact {
  if (artifact.cancelled && !artifact.errors.some((entry) => entry.code === 'cancelled')) {
    artifact.errors.push(issue('cancelled', 'Benchmark 已取消，结果不可作为有效实测。', artifact.name))
  }
  artifact.valid = artifact.errors.length === 0
  artifact.key = buildArtifactKey(artifact, fingerprint)
  return artifact
}

function runFromArtifact(
  artifact: ImportedArtifact,
  fingerprint: string,
  metrics = artifact.metrics,
  overrides: Partial<NormalizedBenchmarkRun> = {},
): NormalizedBenchmarkRun {
  const variation = overrides.variation ?? artifact.variation
  const trial = overrides.trial ?? artifact.trial
  const runMetrics = { ...metrics }
  const runServerMetrics = overrides.serverMetrics ?? artifact.serverMetrics
  for (const [index, metric] of runServerMetrics.entries()) {
    const key = runMetrics[metric.name]
      ? `${metric.name}#${metric.seriesKey ?? index}`
      : metric.name
    runMetrics[key] = metric
  }
  return {
    key: buildRunKey(
      overrides.benchmarkId ?? artifact.benchmarkId,
      overrides.sweepId ?? artifact.sweepId,
      variation,
      trial,
      stableHash(`${fingerprint}:${variation ?? 'base'}:${trial ?? 0}`),
    ),
    benchmarkId: overrides.benchmarkId ?? artifact.benchmarkId,
    sweepId: overrides.sweepId ?? artifact.sweepId,
    variation,
    variationIndex: overrides.variationIndex ?? artifact.variationIndex,
    trial,
    valid: overrides.valid ?? artifact.valid,
    cancelled: overrides.cancelled ?? artifact.cancelled,
    sourceNames: overrides.sourceNames ?? [artifact.name],
    metrics: runMetrics,
    serverMetrics: runServerMetrics,
    inputConfig: overrides.inputConfig ?? artifact.inputConfig,
    metadata: overrides.metadata ?? artifact.metadata,
    errors: overrides.errors ?? [...artifact.errors],
    warnings: overrides.warnings ?? [...artifact.warnings],
  }
}

function jsonIdentity(artifact: ImportedArtifact, payload: JsonObject): void {
  const runInfo = asObject(payload.run_info)
  const metadata = asObject(payload.metadata)
  artifact.schemaVersion = asString(payload.schema_version)
  artifact.aiperfVersion = asString(payload.aiperf_version)
  artifact.benchmarkId =
    asString(payload.benchmark_id) ?? asString(runInfo?.benchmark_id) ?? asString(metadata?.benchmark_id)
  artifact.sweepId =
    asString(payload.sweep_id) ?? asString(runInfo?.sweep_id) ?? asString(metadata?.sweep_id)
  artifact.variation =
    asString(runInfo?.variation_label) ??
    (isObject(runInfo?.variation_values) && Object.keys(runInfo.variation_values).length > 0
      ? stableStringify(runInfo.variation_values)
      : undefined) ??
    asString(metadata?.variation_label) ??
    asString(payload.variation)
  artifact.variationIndex =
    asIndex(runInfo?.variation_index) ?? asIndex(metadata?.variation_index) ?? asIndex(payload.variation_index)
  artifact.trial = asIndex(runInfo?.trial) ?? asIndex(metadata?.trial) ?? asIndex(payload.trial)
  artifact.cancelled =
    asBoolean(payload.was_cancelled) ??
    asBoolean(metadata?.was_cancelled) ??
    asBoolean(metadata?._was_cancelled) ??
    false
  artifact.inputConfig = asObject(payload.input_config)
  artifact.metadata = metadata ?? {}
}

function flattenGpuTelemetry(telemetry: unknown): NormalizedMetric[] {
  const endpoints = asObject(asObject(telemetry)?.endpoints)
  if (!endpoints) return []
  const result: NormalizedMetric[] = []
  for (const [endpoint, endpointValue] of Object.entries(endpoints)) {
    const gpus = asObject(asObject(endpointValue)?.gpus)
    if (!gpus) continue
    for (const [gpuKey, gpuValue] of Object.entries(gpus)) {
      const gpu = asObject(gpuValue)
      const metricBlocks = asObject(gpu?.metrics)
      if (!gpu || !metricBlocks) continue
      const gpuId = asString(gpu.gpu_uuid) ?? gpuKey
      for (const [name, value] of Object.entries(metricBlocks)) {
        const metric = normalizeMetric(name, value, 'gpu')
        metric.endpoint = endpoint
        metric.gpuId = gpuId
        metric.labels = {
          ...(asString(gpu.gpu_name) ? { gpu_name: asString(gpu.gpu_name)! } : {}),
          ...(asString(gpu.platform) ? { platform: asString(gpu.platform)! } : {}),
        }
        metric.seriesKey = stableHash(stableStringify([endpoint, gpuId, name, metric.labels]))
        result.push(metric)
      }
    }
  }
  return result
}

function looksLikeServerMetrics(payload: JsonObject): boolean {
  const metrics = asObject(payload.metrics)
  if (!metrics) return false
  if (
    'summary' in payload &&
    ('metrics_phase' in payload || 'benchmark_id' in payload || 'warmup_metrics' in payload)
  )
    return true
  return Object.values(metrics).some((value) => {
    const metric = asObject(value)
    return Boolean(metric && typeof metric.type === 'string' && Array.isArray(metric.series))
  })
}

function looksLikeSweep(payload: JsonObject): boolean {
  return payload.aggregation_type === 'sweep' || Array.isArray(payload.per_combination_metrics)
}

function looksLikeCollated(payload: JsonObject): boolean {
  const metadata = asObject(payload.metadata)
  if (payload.aggregation_type === 'detailed' || payload.aggregation_type === 'collated') return true
  if (metadata?.aggregation_type === 'detailed') return true
  if (typeof payload.description === 'string' && /collated per-request/i.test(payload.description)) return true
  const metrics = asObject(payload.metrics)
  return Boolean(
    metrics &&
      Object.values(metrics).some((value) => {
        const metric = asObject(value)
        return metric && ('combined' in metric || Array.isArray(metric.per_run))
      }),
  )
}

function looksLikeConfidenceAggregate(payload: JsonObject): boolean {
  const metrics = asObject(payload.metrics)
  if (!metrics || looksLikeServerMetrics(payload)) return false
  const metadata = asObject(payload.metadata)
  if (typeof payload.aggregation_type === 'string' && payload.aggregation_type !== 'sweep') return true
  if (metadata?.aggregation_type && metadata.aggregation_type !== 'detailed') return true
  return Object.values(metrics).some((value) => {
    const metric = asObject(value)
    return Boolean(metric && ('ci_low' in metric || 't_critical' in metric || 'cv' in metric) && 'mean' in metric)
  })
}

function looksLikeProfile(payload: JsonObject): boolean {
  if ('input_config' in payload || 'run_info' in payload || 'was_cancelled' in payload) return true
  return Object.values(payload).some((value) => isObject(value) && ('unit' in value || hasMetricStats(value)))
}

function parseProfileJson(name: string, payload: JsonObject, fingerprint: string): ImportedArtifact {
  const artifact = baseArtifact(name, 'json', 'profile')
  jsonIdentity(artifact, payload)
  validateSchemaVersion(artifact.schemaVersion, name, artifact.errors)
  artifact.metrics = extractMetricBlocks(payload)
  artifact.serverMetrics = flattenGpuTelemetry(payload.telemetry_data)
  if (Object.keys(artifact.metrics).length === 0) {
    artifact.errors.push(issue('empty-profile', 'Profile JSON 不包含可用 Benchmark 指标。', name))
  }
  validateMetricUnits(Object.values(artifact.metrics), name, artifact.errors)
  checkZeroRequests(artifact.metrics, name, artifact.errors)
  finalizeArtifact(artifact, fingerprint)
  artifact.runs = [runFromArtifact(artifact, fingerprint)]
  return artifact
}

function parseConfidenceJson(name: string, payload: JsonObject, fingerprint: string): ImportedArtifact {
  const artifact = baseArtifact(name, 'json', 'confidence-aggregate')
  jsonIdentity(artifact, payload)
  validateSchemaVersion(artifact.schemaVersion, name, artifact.errors)
  artifact.metrics = extractMetricBlocks(payload.metrics)
  const rawMetrics = asObject(payload.metrics) ?? {}
  for (const [metricName, raw] of Object.entries(rawMetrics)) {
    if (artifact.metrics[metricName]) continue
    const value = toFiniteNumber(raw)
    if (value === undefined) continue
    artifact.metrics[metricName] = {
      name: metricName,
      unit: '',
      stats: { mean: value },
      scope: 'benchmark',
      unknown: !isKnownMetric(metricName),
    }
  }
  if (Object.keys(artifact.metrics).length === 0) {
    artifact.errors.push(issue('empty-aggregate', 'Confidence aggregate JSON 不包含可用指标。', name))
  }
  validateMetricUnits(Object.values(artifact.metrics), name, artifact.errors)
  checkZeroRequests(artifact.metrics, name, artifact.errors)
  const successfulRuns = toFiniteNumber(payload.num_successful_runs ?? artifact.metadata.num_successful_runs)
  if (successfulRuns !== undefined && successfulRuns <= 0) {
    artifact.errors.push(issue('zero-successful-runs', '成功运行数为 0，聚合结果无效。', name))
  }
  finalizeArtifact(artifact, fingerprint)
  artifact.runs = [runFromArtifact(artifact, fingerprint)]
  return artifact
}

function parseCollatedJson(name: string, payload: JsonObject, fingerprint: string): ImportedArtifact {
  const artifact = baseArtifact(name, 'json', 'collated')
  jsonIdentity(artifact, payload)
  validateSchemaVersion(artifact.schemaVersion, name, artifact.errors)
  const sourceMetrics = asObject(payload.metrics) ?? {}
  for (const [metricName, value] of Object.entries(sourceMetrics)) {
    const block = asObject(value)
    if (!block) continue
    const combined = asObject(block.combined) ?? block
    const metric = normalizeMetric(metricName, combined)
    metric.unit = asString(combined.unit) ?? asString(block.unit) ?? ''
    artifact.metrics[metricName] = metric
  }
  if (Object.keys(artifact.metrics).length === 0) {
    artifact.errors.push(issue('empty-collated', 'Collated JSON 不包含可用指标。', name))
  }
  validateMetricUnits(Object.values(artifact.metrics), name, artifact.errors)
  const successfulRuns = toFiniteNumber(artifact.metadata.num_successful_runs)
  if (successfulRuns !== undefined && successfulRuns <= 0) {
    artifact.errors.push(issue('zero-successful-runs', '成功运行数为 0，collated 结果无效。', name))
  }
  finalizeArtifact(artifact, fingerprint)
  artifact.runs = [runFromArtifact(artifact, fingerprint)]
  return artifact
}

function sweepMetric(metricName: string, raw: unknown): NormalizedMetric {
  if (isObject(raw)) return normalizeMetric(metricName, raw)
  const value = toFiniteNumber(raw)
  return {
    name: metricName,
    unit: '',
    stats: value === undefined ? {} : { mean: value },
    scope: 'benchmark',
    unknown: !isKnownMetric(metricName),
  }
}

function parseSweepJson(name: string, payload: JsonObject, fingerprint: string): ImportedArtifact {
  const artifact = baseArtifact(name, 'json', 'sweep-aggregate')
  jsonIdentity(artifact, payload)
  validateSchemaVersion(artifact.schemaVersion, name, artifact.errors)
  const combinations = Array.isArray(payload.per_combination_metrics) ? payload.per_combination_metrics : []
  if (combinations.length === 0) {
    artifact.errors.push(issue('empty-sweep', 'Sweep aggregate 不包含任何参数组合。', name))
  }
  const paretoProvided = Object.prototype.hasOwnProperty.call(payload, 'pareto_optimal')
  const paretoSet = new Set(
    (Array.isArray(payload.pareto_optimal) ? payload.pareto_optimal : [])
      .filter(isObject)
      .map((entry) => stableStringify(entry)),
  )
  combinations.forEach((entry, index) => {
    if (!isObject(entry)) return
    const coordinates = asObject(entry.parameters) ?? {}
    const rawMetrics = asObject(entry.metrics) ?? {}
    const metrics: Record<string, NormalizedMetric> = {}
    for (const [metricName, raw] of Object.entries(rawMetrics)) metrics[metricName] = sweepMetric(metricName, raw)
    const pointErrors: ImportIssue[] = []
    validateMetricUnits(Object.values(metrics), name, pointErrors)
    checkZeroRequests(metrics, name, pointErrors)
    artifact.errors.push(...pointErrors)
    const variation = asString(entry.variation_label) ?? stableStringify(coordinates)
    const trial = asIndex(entry.trial)
    artifact.sweepPoints.push({
      key: buildSweepPointKey(artifact.sweepId, artifact.benchmarkId, coordinates, trial, fingerprint),
      sweepId: artifact.sweepId,
      benchmarkId: artifact.benchmarkId,
      variation,
      variationIndex: asIndex(entry.variation_index) ?? index,
      trial,
      coordinates,
      metrics,
      valid: pointErrors.length === 0 && !artifact.cancelled,
      ...(paretoProvided ? { paretoOptimal: paretoSet.has(stableStringify(coordinates)) } : {}),
      sourceName: name,
    })
  })
  const successfulRuns = toFiniteNumber(payload.num_successful_runs)
  if (successfulRuns !== undefined && successfulRuns <= 0) {
    artifact.errors.push(issue('zero-successful-runs', '成功运行数为 0，Sweep 结果无效。', name))
  }
  finalizeArtifact(artifact, fingerprint)
  if (!artifact.valid) artifact.sweepPoints.forEach((point) => (point.valid = false))
  return artifact
}

function flattenServerJsonMetrics(payload: JsonObject): NormalizedMetric[] {
  const blocks = asObject(payload.metrics) ?? {}
  const result: NormalizedMetric[] = []
  for (const [name, rawBlock] of Object.entries(blocks)) {
    const block = asObject(rawBlock)
    if (!block) continue
    const unit = asString(block.unit) ?? ''
    const metricType = asString(block.type)
    const seriesList = Array.isArray(block.series) ? block.series : []
    if (seriesList.length === 0 && isObject(block.stats)) seriesList.push(block)
    for (const rawSeries of seriesList) {
      const series = asObject(rawSeries)
      if (!series) continue
      const stats = collectStats(series.stats, SERVER_STAT_NAMES)
      const labelsObject = asObject(series.labels)
      const labels: Record<string, string> = {}
      if (labelsObject) {
        for (const [key, value] of Object.entries(labelsObject)) labels[key] = String(value)
      }
      const endpoint = asString(series.endpoint_url)
      const metric: NormalizedMetric = {
        name,
        unit,
        stats,
        scope: 'server',
        endpoint,
        metricType,
        labels,
        seriesKey: serverSeriesKey(name, endpoint, metricType, labels),
        unknown: !isKnownMetric(name),
      }
      result.push(metric)
    }
  }
  return result
}

function parseServerJson(name: string, payload: JsonObject, fingerprint: string): ImportedArtifact {
  const artifact = baseArtifact(name, 'json', 'server-metrics')
  jsonIdentity(artifact, payload)
  validateSchemaVersion(artifact.schemaVersion, name, artifact.errors)
  artifact.serverMetrics = flattenServerJsonMetrics(payload)
  artifact.inputConfig = asObject(payload.input_config)
  artifact.metadata = asObject(payload.summary) ?? {}
  if (artifact.serverMetrics.length === 0) {
    artifact.errors.push(issue('empty-server-metrics', 'Server metrics 文件不包含可用指标。', name))
  }
  validateMetricUnits(artifact.serverMetrics, name, artifact.errors)
  finalizeArtifact(artifact, fingerprint)
  return artifact
}

function parseJsonArtifact(name: string, text: string): ImportedArtifact {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const artifact = baseArtifact(name, 'json', 'unknown')
    artifact.errors.push(issue('invalid-json', `JSON 解析失败：${String(error)}`, name))
    return finalizeArtifact(artifact, stableHash(text))
  }
  if (!isObject(parsed)) {
    const artifact = baseArtifact(name, 'json', 'unknown')
    artifact.errors.push(issue('invalid-json-root', 'AIPerf JSON 顶层必须是对象。', name))
    return finalizeArtifact(artifact, stableHash(stableStringify(parsed)))
  }
  const fingerprint = stableHash(stableStringify(parsed))
  if (looksLikeServerMetrics(parsed)) return parseServerJson(name, parsed, fingerprint)
  if (looksLikeSweep(parsed)) return parseSweepJson(name, parsed, fingerprint)
  if (looksLikeCollated(parsed)) return parseCollatedJson(name, parsed, fingerprint)
  if (looksLikeConfidenceAggregate(parsed)) return parseConfidenceJson(name, parsed, fingerprint)
  if (looksLikeProfile(parsed)) return parseProfileJson(name, parsed, fingerprint)
  const artifact = baseArtifact(name, 'json', 'unknown')
  artifact.errors.push(issue('unrecognized-artifact', '无法按内容识别 AIPerf JSON artifact 类型。', name))
  return finalizeArtifact(artifact, fingerprint)
}

interface CsvParseResult {
  rows: string[][]
  unterminatedQuote: boolean
}

/** RFC 4180 parser, including escaped quotes, commas, CRLF and quoted newlines. */
function parseCsv(text: string): CsvParseResult {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const source = text.replace(/^\uFEFF/, '')
  while (i < source.length) {
    const char = source[i]
    if (char === '"') {
      if (inQuotes && source[i + 1] === '"') {
        field += '"'
        i += 2
        continue
      }
      inQuotes = !inQuotes
      i += 1
      continue
    }
    if (!inQuotes && char === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (!inQuotes && (char === '\n' || char === '\r')) {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      if (char === '\r' && source[i + 1] === '\n') i += 1
      i += 1
      continue
    }
    field += char
    i += 1
  }
  if (field.length > 0 || row.length > 0 || (source.length > 0 && !/[\r\n]$/.test(source))) {
    row.push(field)
    rows.push(row)
  }
  return { rows, unterminatedQuote: inQuotes }
}

function rowIsBlank(row: string[]): boolean {
  return row.every((cell) => cell.trim() === '')
}

function csvComments(rows: string[][]): Record<string, string> {
  const metadata: Record<string, string> = {}
  for (const row of rows) {
    if (row.length !== 1 || !row[0].trim().startsWith('#')) continue
    const match = /^#\s*([^:]+):\s*(.*?)\s*$/.exec(row[0])
    if (match) metadata[snakeCase(match[1])] = match[2]
  }
  return metadata
}

function findHeaderIndex(row: string[], header: string): number {
  const expected = normalizedHeader(header)
  return row.findIndex((cell) => normalizedHeader(cell) === expected)
}

function isServerCsv(rows: string[][]): boolean {
  if (rows.some((row) => row.length === 1 && /aiperf server metrics export/i.test(row[0]))) return true
  return rows.some(
    (row) =>
      findHeaderIndex(row, 'Endpoint') >= 0 &&
      findHeaderIndex(row, 'Type') >= 0 &&
      findHeaderIndex(row, 'Metric') >= 0 &&
      findHeaderIndex(row, 'Unit') >= 0,
  )
}

function isSweepCsv(rows: string[][]): boolean {
  if (
    rows.some((row) =>
      ['best_configurations', 'pareto_optimal_points'].includes(normalizedHeader(row[0] ?? '')),
    )
  )
    return true
  return rows.some(
    (row) => row.some((cell, index) => Boolean(sweepCsvColumn(cell, index))) && findHeaderIndex(row, 'metric') < 0,
  )
}

function isConfidenceCsv(rows: string[][]): boolean {
  return rows.some(
    (row) =>
      findHeaderIndex(row, 'metric') === 0 &&
      findHeaderIndex(row, 'mean') >= 0 &&
      (findHeaderIndex(row, 'ci_low') >= 0 || findHeaderIndex(row, 't_critical') >= 0) &&
      findHeaderIndex(row, 'unit') >= 0,
  )
}

function isProfileCsv(rows: string[][]): boolean {
  return rows.some(
    (row) =>
      findHeaderIndex(row, 'metric') === 0 &&
      (findHeaderIndex(row, 'value') >= 0 || [...PROFILE_STAT_NAMES].some((stat) => findHeaderIndex(row, stat) >= 0)),
  )
}

function extractDisplayUnit(value: string): { displayName: string; unit: string } {
  // [\s\S] keeps RFC 4180 quoted display names with embedded newlines valid.
  const match = /^([\s\S]*?)\s*\(([^()]*)\)\s*$/.exec(value.trim())
  if (!match) return { displayName: value.trim(), unit: '' }
  return { displayName: match[1].trim(), unit: match[2].trim() }
}

function officialSuppressedCsvUnit(metricName: string): string {
  if (metricName === 'request_count' || metricName === 'good_request_count') return 'requests'
  return ''
}

function csvMetricFromRow(row: string[], header: string[], metricColumn: number): NormalizedMetric | undefined {
  const rawName = row[metricColumn]?.trim()
  if (!rawName) return undefined
  const { displayName, unit: displayUnit } = extractDisplayUnit(rawName)
  const name = canonicalMetricName(displayName)
  const unitColumn = findHeaderIndex(header, 'unit')
  const unit = (unitColumn >= 0 ? row[unitColumn]?.trim() : '') || displayUnit || officialSuppressedCsvUnit(name)
  const stats: Record<string, number> = {}
  header.forEach((column, index) => {
    const stat = normalizedHeader(column)
    if (index === metricColumn || stat === 'unit' || !PROFILE_STAT_NAMES.has(stat)) return
    const value = toFiniteNumber(row[index])
    if (value !== undefined) stats[stat] = value
  })
  return { name, unit, stats, scope: 'benchmark', unknown: !isKnownMetric(name) }
}

function parseProfileTelemetrySection(rows: string[][], start: number): { metrics: NormalizedMetric[]; end: number } {
  const header = rows[start]
  const endpointColumn = findHeaderIndex(header, 'Endpoint')
  const metricColumn = findHeaderIndex(header, 'Metric')
  const gpuUuidColumn = findHeaderIndex(header, 'GPU_UUID')
  const gpuIndexColumn = findHeaderIndex(header, 'GPU_Index')
  const result: NormalizedMetric[] = []
  let index = start + 1
  while (index < rows.length && !rowIsBlank(rows[index])) {
    const row = rows[index]
    const parsed = csvMetricFromRow(row, header, metricColumn)
    if (parsed) {
      parsed.scope = 'gpu'
      parsed.endpoint = row[endpointColumn]?.trim() || undefined
      parsed.gpuId = row[gpuUuidColumn]?.trim() || row[gpuIndexColumn]?.trim() || undefined
      parsed.seriesKey = stableHash(stableStringify([parsed.endpoint, parsed.gpuId, parsed.name]))
      result.push(parsed)
    }
    index += 1
  }
  return { metrics: result, end: index }
}

function applyCsvCommentIdentity(artifact: ImportedArtifact, comments: Record<string, string>): void {
  artifact.schemaVersion = asString(comments.schema_version)
  artifact.aiperfVersion = asString(comments.aiperf_version)
  const benchmarkId = asString(comments.benchmark_id)
  artifact.benchmarkId = benchmarkId && benchmarkId.toLowerCase() !== 'none' ? benchmarkId : undefined
  artifact.sweepId = asString(comments.sweep_id)
  artifact.variation = asString(comments.variation) ?? asString(comments.variation_label)
  artifact.trial = asIndex(comments.trial)
  artifact.cancelled = asBoolean(comments.was_cancelled) ?? false
}

function parseProfileCsv(name: string, rows: string[][], fingerprint: string): ImportedArtifact {
  const artifact = baseArtifact(name, 'csv', 'profile')
  applyCsvCommentIdentity(artifact, csvComments(rows))
  validateSchemaVersion(artifact.schemaVersion, name, artifact.errors)
  addMetadataRequiredWarning(artifact)
  let index = 0
  while (index < rows.length) {
    const header = rows[index]
    const metricColumn = findHeaderIndex(header, 'Metric')
    const isTelemetry =
      findHeaderIndex(header, 'Endpoint') >= 0 &&
      findHeaderIndex(header, 'GPU_Index') >= 0 &&
      metricColumn >= 0
    if (isTelemetry) {
      const section = parseProfileTelemetrySection(rows, index)
      artifact.serverMetrics.push(...section.metrics)
      index = section.end
      continue
    }
    if (
      metricColumn === 0 &&
      (findHeaderIndex(header, 'Value') >= 0 ||
        header.some((column) => PROFILE_STAT_NAMES.has(normalizedHeader(column))))
    ) {
      index += 1
      while (index < rows.length && !rowIsBlank(rows[index])) {
        if (findHeaderIndex(rows[index], 'Metric') === 0) break
        const metric = csvMetricFromRow(rows[index], header, metricColumn)
        if (metric) artifact.metrics[metric.name] = metric
        index += 1
      }
      continue
    }
    index += 1
  }
  if (Object.keys(artifact.metrics).length === 0) {
    artifact.errors.push(issue('empty-profile', 'Profile CSV 不包含可用 Benchmark 指标。', name))
  }
  validateMetricUnits(Object.values(artifact.metrics), name, artifact.errors)
  checkZeroRequests(artifact.metrics, name, artifact.errors)
  finalizeArtifact(artifact, fingerprint)
  artifact.runs = [runFromArtifact(artifact, fingerprint)]
  return artifact
}

function metadataFromTwoColumnRows(rows: string[][]): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  for (const row of rows) {
    if (row.length < 2 || !row[0].trim() || !row[1].trim()) continue
    const key = snakeCase(row[0])
    if (['metric', 'field', 'configuration'].includes(key)) continue
    metadata[key] = parseScalar(row[1])
  }
  return metadata
}

function parseConfidenceCsv(name: string, rows: string[][], fingerprint: string): ImportedArtifact {
  const artifact = baseArtifact(name, 'csv', 'confidence-aggregate')
  const comments = csvComments(rows)
  applyCsvCommentIdentity(artifact, comments)
  validateSchemaVersion(artifact.schemaVersion, name, artifact.errors)
  addMetadataRequiredWarning(artifact)
  const headerIndex = rows.findIndex(
    (row) => findHeaderIndex(row, 'metric') === 0 && findHeaderIndex(row, 'mean') >= 0,
  )
  if (headerIndex >= 0) {
    const header = rows[headerIndex]
    let index = headerIndex + 1
    while (index < rows.length && !rowIsBlank(rows[index])) {
      const metric = csvMetricFromRow(rows[index], header, 0)
      if (metric) artifact.metrics[metric.name] = metric
      index += 1
    }
    artifact.metadata = metadataFromTwoColumnRows(rows.slice(index))
  }
  artifact.benchmarkId = artifact.benchmarkId ?? asString(artifact.metadata.benchmark_id)
  artifact.sweepId = artifact.sweepId ?? asString(artifact.metadata.sweep_id)
  artifact.cancelled = artifact.cancelled || (asBoolean(artifact.metadata.was_cancelled) ?? false)
  if (Object.keys(artifact.metrics).length === 0) {
    artifact.errors.push(issue('empty-aggregate', 'Confidence aggregate CSV 不包含可用指标。', name))
  }
  validateMetricUnits(Object.values(artifact.metrics), name, artifact.errors)
  checkZeroRequests(artifact.metrics, name, artifact.errors)
  const successfulRuns = toFiniteNumber(artifact.metadata.successful_runs)
  if (successfulRuns !== undefined && successfulRuns <= 0) {
    artifact.errors.push(issue('zero-successful-runs', '成功运行数为 0，聚合结果无效。', name))
  }
  finalizeArtifact(artifact, fingerprint)
  artifact.runs = [runFromArtifact(artifact, fingerprint)]
  return artifact
}

interface SweepCsvColumn {
  index: number
  metricName: string
  stat: string
  unit: string
}

function sweepCsvColumn(value: string, index: number): SweepCsvColumn | undefined {
  const { displayName, unit } = extractDisplayUnit(value)
  const match = /^(.*?)_(mean|std|min|max|cv|avg|p\d+|ci_low|ci_high)$/i.exec(displayName.trim())
  if (!match) return undefined
  return { index, metricName: canonicalMetricName(match[1]), stat: match[2].toLowerCase(), unit }
}

function parseParetoCoordinateSet(rows: string[][]): { provided: boolean; points: Set<string> } {
  const title = rows.findIndex((row) => normalizedHeader(row[0] ?? '') === 'pareto_optimal_points')
  if (title < 0) return { provided: false, points: new Set() }
  if (title + 1 >= rows.length) return { provided: true, points: new Set() }
  const headers = rows[title + 1]
  const result = new Set<string>()
  let index = title + 2
  while (index < rows.length && !rowIsBlank(rows[index])) {
    if (normalizedHeader(rows[index][0] ?? '') === 'none') break
    const coordinates: Record<string, unknown> = {}
    headers.forEach((header, column) => {
      if (header.trim()) coordinates[header.trim()] = parseScalar(rows[index][column] ?? '')
    })
    result.add(stableStringify(coordinates))
    index += 1
  }
  return { provided: true, points: result }
}

function parseSweepCsvMetadata(rows: string[][]): Record<string, unknown> {
  const title = rows.findIndex((row) => normalizedHeader(row[0] ?? '') === 'metadata')
  return title < 0 ? {} : metadataFromTwoColumnRows(rows.slice(title + 1))
}

function parseSweepCsv(name: string, rows: string[][], fingerprint: string): ImportedArtifact {
  const artifact = baseArtifact(name, 'csv', 'sweep-aggregate')
  applyCsvCommentIdentity(artifact, csvComments(rows))
  validateSchemaVersion(artifact.schemaVersion, name, artifact.errors)
  addMetadataRequiredWarning(artifact)
  artifact.metadata = parseSweepCsvMetadata(rows)
  artifact.sweepId = artifact.sweepId ?? asString(artifact.metadata.sweep_id)
  artifact.benchmarkId = artifact.benchmarkId ?? asString(artifact.metadata.benchmark_id)
  artifact.cancelled = artifact.cancelled || (asBoolean(artifact.metadata.was_cancelled) ?? false)
  const tableIndex = rows.findIndex((row) => row.some((cell, index) => sweepCsvColumn(cell, index)))
  if (tableIndex < 0) {
    artifact.errors.push(issue('empty-sweep', 'Sweep CSV 不包含 per-combination 宽表。', name))
    return finalizeArtifact(artifact, fingerprint)
  }
  const header = rows[tableIndex]
  const metricColumns = header.flatMap((cell, index) => {
    const parsed = sweepCsvColumn(cell, index)
    return parsed ? [parsed] : []
  })
  const firstMetricIndex = Math.min(...metricColumns.map((column) => column.index))
  const parameterColumns = header
    .slice(0, firstMetricIndex)
    .map((parameter, index) => ({ name: parameter.trim(), index }))
    .filter((entry) => entry.name)
  const pareto = parseParetoCoordinateSet(rows)
  let rowIndex = tableIndex + 1
  let pointIndex = 0
  while (rowIndex < rows.length && !rowIsBlank(rows[rowIndex])) {
    const row = rows[rowIndex]
    const coordinates: Record<string, unknown> = {}
    parameterColumns.forEach((parameter) => {
      coordinates[parameter.name] = parseScalar(row[parameter.index] ?? '')
    })
    const metrics: Record<string, NormalizedMetric> = {}
    for (const column of metricColumns) {
      const metric =
        metrics[column.metricName] ??
        ({
          name: column.metricName,
          unit: column.unit,
          stats: {},
          scope: 'benchmark',
          unknown: !isKnownMetric(column.metricName),
        } satisfies NormalizedMetric)
      if (!metric.unit && column.unit) metric.unit = column.unit
      const value = toFiniteNumber(row[column.index])
      if (value !== undefined) metric.stats[column.stat] = value
      metrics[column.metricName] = metric
    }
    const pointErrors: ImportIssue[] = []
    validateMetricUnits(Object.values(metrics), name, pointErrors)
    checkZeroRequests(metrics, name, pointErrors)
    artifact.errors.push(...pointErrors)
    artifact.sweepPoints.push({
      key: buildSweepPointKey(artifact.sweepId, artifact.benchmarkId, coordinates, undefined, fingerprint),
      sweepId: artifact.sweepId,
      benchmarkId: artifact.benchmarkId,
      variation: stableStringify(coordinates),
      variationIndex: pointIndex,
      coordinates,
      metrics,
      valid: pointErrors.length === 0 && !artifact.cancelled,
      ...(pareto.provided ? { paretoOptimal: pareto.points.has(stableStringify(coordinates)) } : {}),
      sourceName: name,
    })
    pointIndex += 1
    rowIndex += 1
  }
  if (artifact.sweepPoints.length === 0) {
    artifact.errors.push(issue('empty-sweep', 'Sweep CSV 不包含任何参数组合。', name))
  }
  const successfulRuns = toFiniteNumber(artifact.metadata.number_of_successful_runs)
  if (successfulRuns !== undefined && successfulRuns <= 0) {
    artifact.errors.push(issue('zero-successful-runs', '成功运行数为 0，Sweep 结果无效。', name))
  }
  finalizeArtifact(artifact, fingerprint)
  if (!artifact.valid) artifact.sweepPoints.forEach((point) => (point.valid = false))
  return artifact
}

function serverCsvMetric(
  row: string[],
  header: string[],
  metricColumn: number,
  endpointColumn: number,
  typeColumn: number,
  unitColumn: number,
): NormalizedMetric | undefined {
  const name = row[metricColumn]?.trim()
  if (!name) return undefined
  const endpoint = row[endpointColumn]?.trim() || undefined
  const metricType = row[typeColumn]?.trim() || undefined
  const unit = row[unitColumn]?.trim() || ''
  const stats: Record<string, number> = {}
  const labels: Record<string, string> = {}
  const fixedColumns = new Set([
    'endpoint',
    'type',
    'metric',
    'unit',
    'description',
    'buckets',
    ...SERVER_STAT_NAMES,
  ])
  header.forEach((column, index) => {
    const normalized = normalizedHeader(column)
    if (SERVER_STAT_NAMES.has(normalized)) {
      const value = toFiniteNumber(row[index])
      if (value !== undefined) stats[normalized] = value
    } else if (!fixedColumns.has(normalized) && row[index]?.trim()) {
      labels[column.trim()] = row[index].trim()
    }
  })
  return {
    name,
    unit,
    stats,
    scope: 'server',
    endpoint,
    metricType,
    labels,
    seriesKey: serverSeriesKey(name, endpoint, metricType, labels),
    unknown: !isKnownMetric(name),
  }
}

function parseServerCsv(name: string, rows: string[][], fingerprint: string): ImportedArtifact {
  const artifact = baseArtifact(name, 'csv', 'server-metrics')
  applyCsvCommentIdentity(artifact, csvComments(rows))
  validateSchemaVersion(artifact.schemaVersion, name, artifact.errors)
  addMetadataRequiredWarning(artifact)
  let index = 0
  while (index < rows.length) {
    const header = rows[index]
    const endpointColumn = findHeaderIndex(header, 'Endpoint')
    const typeColumn = findHeaderIndex(header, 'Type')
    const metricColumn = findHeaderIndex(header, 'Metric')
    const unitColumn = findHeaderIndex(header, 'Unit')
    if (endpointColumn >= 0 && typeColumn >= 0 && metricColumn >= 0 && unitColumn >= 0) {
      index += 1
      while (index < rows.length && !rowIsBlank(rows[index])) {
        const metric = serverCsvMetric(
          rows[index],
          header,
          metricColumn,
          endpointColumn,
          typeColumn,
          unitColumn,
        )
        if (metric) artifact.serverMetrics.push(metric)
        index += 1
      }
      continue
    }
    // Info metrics use a transposed Endpoint,Metric,Key,Value,Description table.
    const keyColumn = findHeaderIndex(header, 'Key')
    const valueColumn = findHeaderIndex(header, 'Value')
    if (endpointColumn >= 0 && metricColumn >= 0 && keyColumn >= 0 && valueColumn >= 0) {
      index += 1
      while (index < rows.length && !rowIsBlank(rows[index])) {
        const metricName = rows[index][metricColumn]?.trim()
        if (metricName) {
          const rawValue = rows[index][valueColumn]?.trim() ?? ''
          const numericValue = toFiniteNumber(rawValue)
          const key = rows[index][keyColumn]?.trim() || 'value'
          artifact.serverMetrics.push({
            name: metricName,
            unit: '',
            stats: numericValue === undefined ? {} : { value: numericValue },
            scope: 'server',
            endpoint: rows[index][endpointColumn]?.trim() || undefined,
            metricType: 'info',
            labels: { key },
            rawValue,
            seriesKey: stableHash(stableStringify([metricName, key, rawValue])),
            unknown: !isKnownMetric(metricName),
          })
        }
        index += 1
      }
      continue
    }
    index += 1
  }
  if (artifact.serverMetrics.length === 0) {
    artifact.errors.push(issue('empty-server-metrics', 'Server metrics CSV 不包含可用指标。', name))
  }
  validateMetricUnits(artifact.serverMetrics, name, artifact.errors)
  finalizeArtifact(artifact, fingerprint)
  return artifact
}

function parseCsvArtifact(name: string, text: string): ImportedArtifact {
  const { rows, unterminatedQuote } = parseCsv(text)
  const fingerprint = stableHash(stableStringify(rows))
  if (unterminatedQuote) {
    const artifact = baseArtifact(name, 'csv', 'unknown')
    artifact.errors.push(issue('invalid-csv', 'CSV 存在未闭合的引号。', name))
    return finalizeArtifact(artifact, fingerprint)
  }
  if (isServerCsv(rows)) return parseServerCsv(name, rows, fingerprint)
  if (isSweepCsv(rows)) return parseSweepCsv(name, rows, fingerprint)
  if (isConfidenceCsv(rows)) return parseConfidenceCsv(name, rows, fingerprint)
  if (isProfileCsv(rows)) return parseProfileCsv(name, rows, fingerprint)
  const artifact = baseArtifact(name, 'csv', 'unknown')
  artifact.errors.push(issue('unrecognized-artifact', '无法按内容识别 AIPerf CSV artifact 类型。', name))
  return finalizeArtifact(artifact, fingerprint)
}

function unsupportedArtifact(name: string, code: string, message: string, text: string): ImportedArtifact {
  const artifact = baseArtifact(name, 'unsupported', 'unknown')
  artifact.errors.push(issue(code, message, name))
  return finalizeArtifact(artifact, stableHash(text))
}

/** Parse one AIPerf JSON/CSV artifact synchronously and without side effects. */
export function parseAiperfArtifact(name: string, text: string): ImportedArtifact {
  const lowerName = name.toLowerCase()
  if (lowerName.endsWith('.jsonl')) {
    return unsupportedArtifact(name, 'unsupported-jsonl', '不支持逐请求 JSONL；请导入 summary JSON/CSV。', text)
  }
  if (lowerName.endsWith('.parquet')) {
    return unsupportedArtifact(name, 'unsupported-parquet', '浏览器导入不支持 Parquet。', text)
  }
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed) return unsupportedArtifact(name, 'empty-file', '文件为空。', text)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseJsonArtifact(name, trimmed)
  return parseCsvArtifact(name, text)
}

function chooseBetterRun(a: NormalizedBenchmarkRun, b: NormalizedBenchmarkRun): NormalizedBenchmarkRun {
  if (a.valid !== b.valid) return a.valid ? a : b
  const aMetricCount = Object.keys(a.metrics).length + a.serverMetrics.length
  const bMetricCount = Object.keys(b.metrics).length + b.serverMetrics.length
  return bMetricCount > aMetricCount ? b : a
}

function mergeServerMetrics(target: NormalizedBenchmarkRun, artifact: ImportedArtifact): void {
  const known = new Set(
    target.serverMetrics.map((metric) => `${metric.name}:${metric.seriesKey ?? stableHash(stableStringify(metric))}`),
  )
  for (const metric of artifact.serverMetrics) {
    const key = `${metric.name}:${metric.seriesKey ?? stableHash(stableStringify(metric))}`
    if (!known.has(key)) {
      known.add(key)
      target.serverMetrics.push(metric)
      const recordKey = target.metrics[metric.name]
        ? `${metric.name}#${metric.seriesKey ?? stableHash(stableStringify(metric))}`
        : metric.name
      target.metrics[recordKey] = metric
    }
  }
  if (!target.sourceNames.includes(artifact.name)) target.sourceNames.push(artifact.name)
}

function duplicateWarning(duplicate: ImportDuplicate): ImportIssue {
  return issue(
    `duplicate-${duplicate.type}`,
    `已去重 ${duplicate.type} ${duplicate.key}；保留 ${duplicate.kept}，忽略 ${duplicate.dropped}。`,
    duplicate.dropped,
  )
}

function batchFromArtifacts(parsedArtifacts: ImportedArtifact[]): ImportBatch {
  const duplicates: ImportDuplicate[] = []
  const warnings: ImportIssue[] = []
  const artifactMap = new Map<string, ImportedArtifact>()
  for (const artifact of parsedArtifacts) {
    const existing = artifactMap.get(artifact.key)
    if (!existing) {
      artifactMap.set(artifact.key, artifact)
      continue
    }
    const duplicate: ImportDuplicate = {
      type: 'artifact',
      key: artifact.key,
      kept: existing.name,
      dropped: artifact.name,
    }
    duplicates.push(duplicate)
    warnings.push(duplicateWarning(duplicate))
  }
  const artifacts = [...artifactMap.values()]

  const runMap = new Map<string, NormalizedBenchmarkRun>()
  for (const artifact of artifacts) {
    for (const run of artifact.runs) {
      const existing = runMap.get(run.key)
      if (!existing) {
        runMap.set(run.key, run)
        continue
      }
      const chosen = chooseBetterRun(existing, run)
      const dropped = chosen === existing ? run : existing
      const duplicate: ImportDuplicate = {
        type: 'run',
        key: run.key,
        kept: chosen.sourceNames.join(', '),
        dropped: dropped.sourceNames.join(', '),
      }
      duplicates.push(duplicate)
      warnings.push(duplicateWarning(duplicate))
      runMap.set(run.key, chosen)
    }
  }

  const sweepPointMap = new Map<string, SweepPoint>()
  for (const artifact of artifacts) {
    for (const point of artifact.sweepPoints) {
      const existing = sweepPointMap.get(point.key)
      if (!existing) {
        sweepPointMap.set(point.key, point)
        continue
      }
      const duplicate: ImportDuplicate = {
        type: 'sweep-point',
        key: point.key,
        kept: existing.sourceName ?? '已导入 Sweep',
        dropped: point.sourceName ?? artifact.name,
      }
      duplicates.push(duplicate)
      warnings.push(duplicateWarning(duplicate))
      if (!existing.valid && point.valid) sweepPointMap.set(point.key, point)
    }
  }

  const runs = [...runMap.values()]
  const unassociatedServerArtifacts: ImportedArtifact[] = []
  for (const artifact of artifacts.filter((entry) => entry.kind === 'server-metrics')) {
    if (!artifact.valid) {
      unassociatedServerArtifacts.push(artifact)
      const invalidIssue = issue(
        'invalid-server-metrics',
        'Server metrics artifact 无效，未关联到 Benchmark 运行。',
        artifact.name,
      )
      artifact.warnings.push(invalidIssue)
      continue
    }
    const matches = artifact.benchmarkId
      ? runs.filter((run) => run.benchmarkId === artifact.benchmarkId)
      : []
    if (matches.length === 1) {
      mergeServerMetrics(matches[0], artifact)
      continue
    }
    unassociatedServerArtifacts.push(artifact)
    const associationIssue = issue(
      matches.length > 1 ? 'ambiguous-server-metrics' : 'unassociated-server-metrics',
      matches.length > 1
        ? `benchmark_id ${artifact.benchmarkId} 匹配多个运行，未自动关联。`
        : artifact.benchmarkId
          ? `没有找到 benchmark_id=${artifact.benchmarkId} 的运行，未自动关联。`
          : 'Server metrics 缺少 benchmark_id，未按文件名或导入顺序猜测关联。',
      artifact.name,
    )
    artifact.warnings.push(associationIssue)
  }

  return {
    artifacts,
    runs,
    sweepPoints: [...sweepPointMap.values()],
    unassociatedServerMetrics: unassociatedServerArtifacts.flatMap((artifact) => artifact.serverMetrics),
    unassociatedServerArtifacts,
    duplicates,
    errors: artifacts.flatMap((artifact) => artifact.errors),
    warnings: [...artifacts.flatMap((artifact) => artifact.warnings), ...warnings],
  }
}

/** Read and import browser File objects. Files are never uploaded or persisted. */
export async function importAiperfFiles(files: File[]): Promise<ImportBatch> {
  const artifacts = await Promise.all(
    files.map(async (file) => {
      try {
        return parseAiperfArtifact(file.name, await file.text())
      } catch (error) {
        return unsupportedArtifact(
          file.name,
          'file-read-failed',
          `读取文件失败：${error instanceof Error ? error.message : String(error)}`,
          file.name,
        )
      }
    }),
  )
  return batchFromArtifacts(artifacts)
}
