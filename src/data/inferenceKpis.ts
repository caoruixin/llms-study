import type { ArchComponentId } from './archAtlas'

export const KPI_IDS = [
  'ttft',
  'tpot',
  'e2e-latency',
  'single-user-output-tps',
  'system-output-tps',
  'rps',
  'concurrency',
  'goodput',
  'slo-attainment-rate',
  'gpu-utilization',
  'gpu-memory-utilization',
  'kv-cache-utilization',
  'queue-depth',
  'queue-time',
  'preemption-rate',
  'prefix-cache-hit-rate',
  'gpu-power',
  'gpu-count',
  'server-count',
  'rack-count',
  'cost-per-mtok',
  'cost-per-good-request',
] as const

export type KpiId = (typeof KPI_IDS)[number]
export type KpiCategory = 'experience' | 'capacity' | 'resource' | 'cost'
export type KpiDirection = 'lower-is-better' | 'higher-is-better' | 'target-range' | 'informational'
export type KpiScope = 'user' | 'request' | 'system' | 'gpu'
export type MeasurementPoint = 'client' | 'gateway' | 'scheduler' | 'engine' | 'gpu' | 'cost-model'
export type MetricStatistic =
  | 'value'
  | 'mean'
  | 'p50'
  | 'p90'
  | 'p95'
  | 'p99'
  | 'min'
  | 'max'
  | 'count'
  | 'total'
  | 'rate'

export interface KpiDefinition {
  id: KpiId
  category: KpiCategory
  label: string
  shortName: string
  definition: string
  /** Registry canonical unit. Imported observations retain the unit declared by their source artifact. */
  unit: string
  direction: KpiDirection
  scope: KpiScope
  measurementPoint: MeasurementPoint
  /** Recommended summaries; a benchmark may carry additional statistics. */
  statistics: readonly MetricStatistic[]
  /** Human-readable formula. null means the value must be observed or explicitly configured. */
  formula: string | null
  formulaDependencies: readonly KpiId[]
  relatedArchComponents: readonly ArchComponentId[]
  diagnosticMeaning: string
  sourceUrl: string
  asOf: string
}

interface ObservationBase {
  id: string
  kpiId: KpiId
  value: number
  /** Source-declared unit; do not silently replace it with the registry canonical unit. */
  unit: string
  statistic: MetricStatistic
  measurementPoint: MeasurementPoint
  runId: string
  recordedAt?: string
}

export type MetricObservation =
  | (ObservationBase & {
      kind: 'target'
      constraint: 'at-most' | 'at-least' | 'equal'
      source: 'customer-slo' | 'scenario'
    })
  | (ObservationBase & {
      kind: 'estimated'
      formula: string
      inputs: Readonly<Record<string, number>>
      assumptions: readonly string[]
    })
  | (ObservationBase & {
      kind: 'measured'
      artifactId: string
      sampleCount: number | null
      confidenceLevel: number | null
    })

export interface ExperienceSlo {
  ttftP95Ms: number | null
  tpotP95Ms: number | null
  e2eP95Ms: number | null
  /** Customer-defined minimum joint per-request attainment; null means not configured. */
  minimumAttainmentFraction: number | null
}

export type InferenceQuantization = 'fp16' | 'fp8' | 'int4'

export interface InferenceScenario {
  id: string
  modelId: string
  gpuId: string
  quantId: InferenceQuantization
  batch: number
  cacheRate: number
  inputTokens: number
  outputTokens: number
  peakRps: number
  concurrency: number
  targetGoodRps: number | null
  slo: ExperienceSlo
  gpuHourlyCostUsd: number | null
  headroom: number
  spareUnits: number
  gpusPerUnit: number
  gpusPerServer: number | null
  serversPerRack: number | null
}

/** The fields that must match before two benchmark runs can be ranked. null means unknown, not equal. */
export interface BenchmarkFingerprint {
  modelId: string | null
  quantization: string | null
  inputSequenceLength: number | null
  outputSequenceLength: number | null
  gpuModel: string | null
  gpuCount: number | null
  hardwareTopology: string | null
  engine: string | null
  engineVersion: string | null
  loadMode: string | null
  workloadFingerprint: string | null
  slo: Readonly<Record<string, number>> | null
}

export type BenchmarkArtifactKind =
  | 'profile'
  | 'confidence-aggregate'
  | 'collated'
  | 'sweep-aggregate'
  | 'server-metrics'

export interface BenchmarkArtifact {
  id: string
  kind: BenchmarkArtifactKind
  format: 'json' | 'csv'
  fileName: string
  schemaVersion: string | null
  benchmarkId: string | null
  sweepId: string | null
  variation: string | null
  trial: number | null
  fingerprint: BenchmarkFingerprint | null
  observations: readonly MetricObservation[]
  importedAt: string
  warnings: readonly string[]
}

export type FindingSeverity = 'info' | 'warning' | 'critical'

export interface AnalysisFinding {
  id: string
  severity: FindingSeverity
  category: KpiCategory
  title: string
  evidence: readonly string[]
  possibleCauses: readonly string[]
  nextChecks: readonly string[]
  relatedArchComponents: readonly ArchComponentId[]
}

export interface SizingResult {
  basis: 'measured-goodput' | 'estimated-throughput' | 'unavailable'
  /** true only when capacity came from a measured, SLO-qualified Goodput value. */
  sloValidated: boolean
  targetGoodRps: number
  headroom: number
  spareUnits: number
  capacityRpsPerUnit: number | null
  /** Units required for demand and headroom, before spare units. */
  baseUnits: number | null
  totalUnits: number | null
  gpuCount: number | null
  /** null until an explicit GPUs-per-server topology is supplied. */
  serverCount: number | null
  /** null until both server and rack topology are supplied. */
  rackCount: number | null
  note: string
}

const NIM_METRICS = 'https://docs.nvidia.com/nim/benchmarking/llm/latest/metrics.html'
const AIPERF_GOODPUT = 'https://github.com/ai-dynamo/aiperf/blob/main/docs/tutorials/goodput.md'
const VLLM_METRICS = 'https://docs.vllm.ai/en/latest/design/metrics.html'
const DCGM_TELEMETRY = 'https://docs.nvidia.com/datacenter/dcgm/latest/reference/dcgm-exporter-metrics.html'
const NIM_SIZING =
  'https://docs.nvidia.com/enterprise-reference-architectures/nim-llm-runai-vanilla-kubernetes/latest/performance-and-scale-methodology.html'
const AS_OF = '2026-08'

export const KPI_CATEGORIES: readonly { id: KpiCategory; label: string; question: string }[] = [
  { id: 'experience', label: '体验类', question: '用户感受到的响应是否够快、够稳？' },
  { id: 'capacity', label: '容量类', question: '满足 SLO 的前提下，系统能承载多少业务？' },
  { id: 'resource', label: '资源类', question: '瓶颈落在哪一层，为什么 GPU 没有有效跑满？' },
  { id: 'cost', label: '成本类', question: '达成目标容量需要多少基础设施与单位成本？' },
] as const

export const INFERENCE_KPIS = [
  {
    id: 'ttft',
    category: 'experience',
    label: '首 Token 延迟',
    shortName: 'TTFT',
    definition: '从客户端发出请求到收到第一个输出 token 的时间，包含网络、排队与 prefill。',
    unit: 'ms/request',
    direction: 'lower-is-better',
    scope: 'request',
    measurementPoint: 'client',
    statistics: ['mean', 'p50', 'p95', 'p99'],
    formula: null,
    formulaDependencies: [],
    relatedArchComponents: ['app-client', 'prefill-worker', 'pd-scheduler', 'chunked-prefill'],
    diagnosticMeaning: 'TTFT 长尾升高通常指向接入排队、prefill 算力不足或长输入干扰。',
    sourceUrl: NIM_METRICS,
    asOf: AS_OF,
  },
  {
    id: 'tpot',
    category: 'experience',
    label: '每输出 Token 延迟',
    shortName: 'TPOT / ITL',
    definition: '首 token 之后，相邻输出 token 之间的平均时间；不把 TTFT 计入。',
    unit: 'ms/output-token',
    direction: 'lower-is-better',
    scope: 'request',
    measurementPoint: 'client',
    statistics: ['mean', 'p50', 'p95', 'p99'],
    formula: null,
    formulaDependencies: [],
    relatedArchComponents: ['app-client', 'decode-worker', 'continuous-batching', 'chunked-prefill'],
    diagnosticMeaning: 'TPOT 反映持续出字流畅度，恶化常与 decode 带宽、批调度或 prefill 干扰相关。',
    sourceUrl: NIM_METRICS,
    asOf: AS_OF,
  },
  {
    id: 'e2e-latency',
    category: 'experience',
    label: '端到端请求延迟',
    shortName: 'E2E Latency',
    definition: '从客户端发出请求到收到完整响应的总时间。',
    unit: 'ms/request',
    direction: 'lower-is-better',
    scope: 'request',
    measurementPoint: 'client',
    statistics: ['mean', 'p50', 'p95', 'p99'],
    formula: 'TTFT + (输出 token 数 - 1) × TPOT',
    formulaDependencies: ['ttft', 'tpot'],
    relatedArchComponents: ['app-client', 'engine-replica', 'openai-api'],
    diagnosticMeaning: 'E2E 同时受排队、prefill、decode 和输出长度影响，必须结合 TTFT/TPOT 拆解。',
    sourceUrl: NIM_METRICS,
    asOf: AS_OF,
  },
  {
    id: 'single-user-output-tps',
    category: 'experience',
    label: '单用户输出速度',
    shortName: '单用户 tok/s',
    definition: '单个请求从发出到完成期间的平均输出 token 速度，即输出长度除以端到端延迟；它不是系统 TPS。',
    unit: 'output-token/s/request',
    direction: 'higher-is-better',
    scope: 'user',
    measurementPoint: 'client',
    statistics: ['mean', 'p50', 'p95'],
    formula: '输出 token 数 ÷ E2E 秒数',
    formulaDependencies: ['e2e-latency'],
    relatedArchComponents: ['app-client', 'decode-worker'],
    diagnosticMeaning: '用于解释单用户整次请求的平均速度；长输出时才逐渐接近 1000/TPOT，不能替代系统 TPS。',
    sourceUrl: NIM_METRICS,
    asOf: AS_OF,
  },
  {
    id: 'system-output-tps',
    category: 'capacity',
    label: '系统输出 Token 吞吐',
    shortName: '系统 TPS',
    definition: '整个被测系统在稳定测量窗口内，每秒完成的输出 token 总数。',
    unit: 'output-token/s/system',
    direction: 'higher-is-better',
    scope: 'system',
    measurementPoint: 'client',
    statistics: ['mean', 'p50', 'p95', 'max'],
    formula: '总输出 token 数 ÷ (最后响应时间 - 第一请求时间)',
    formulaDependencies: [],
    relatedArchComponents: ['engine-replica', 'continuous-batching', 'engine-metrics'],
    diagnosticMeaning: '衡量集群聚合产能；必须与单用户 tok/s 分开，并与延迟 SLO 一起解释。',
    sourceUrl: NIM_METRICS,
    asOf: AS_OF,
  },
  {
    id: 'rps',
    category: 'capacity',
    label: '请求吞吐',
    shortName: 'RPS',
    definition: '整个被测系统在稳定测量窗口内，每秒完成的请求数。',
    unit: 'request/s/system',
    direction: 'higher-is-better',
    scope: 'system',
    measurementPoint: 'client',
    statistics: ['mean', 'p50', 'p95', 'max'],
    formula: '成功完成请求数 ÷ (最后响应时间 - 第一请求时间)',
    formulaDependencies: [],
    relatedArchComponents: ['openai-api', 'tenant-gateway', 'engine-replica'],
    diagnosticMeaning: '把业务请求量映射到系统容量；输出长度变化时不能单独用 TPS 替代 RPS。',
    sourceUrl: NIM_METRICS,
    asOf: AS_OF,
  },
  {
    id: 'concurrency',
    category: 'capacity',
    label: '系统并发请求数',
    shortName: 'Concurrency',
    definition: '某时刻系统中正在排队或执行的未完成请求数；稳态均值可用 Little 定律校验。',
    unit: 'request',
    direction: 'informational',
    scope: 'system',
    measurementPoint: 'scheduler',
    statistics: ['mean', 'p50', 'p95', 'max'],
    formula: '稳态并发 ≈ RPS × 平均 E2E 秒数',
    formulaDependencies: ['rps', 'e2e-latency'],
    relatedArchComponents: ['continuous-batching', 'paged-attention', 'engine-metrics'],
    diagnosticMeaning: '并发增长但吞吐不再增长，通常意味着系统进入饱和区。',
    sourceUrl: NIM_METRICS,
    asOf: AS_OF,
  },
  {
    id: 'goodput',
    category: 'capacity',
    label: 'SLO 内有效请求吞吐',
    shortName: 'Goodput',
    definition: '同时满足本次运行所配置逐请求 SLO 的请求速率；必须读取 AIPerf 已计算结果。',
    unit: 'good-request/s/system',
    direction: 'higher-is-better',
    scope: 'system',
    measurementPoint: 'client',
    statistics: ['value'],
    formula: null,
    formulaDependencies: [],
    relatedArchComponents: ['sla-planner', 'engine-metrics', 'pd-scheduler'],
    diagnosticMeaning: '用于容量承诺与 Sizing；缺失时不可用多个独立 p95 条件拼出替代值。',
    sourceUrl: AIPERF_GOODPUT,
    asOf: AS_OF,
  },
  {
    id: 'slo-attainment-rate',
    category: 'capacity',
    label: 'SLO 达标请求占比',
    shortName: '达标率',
    definition: '满足全部已配置逐请求 SLO 的请求数，占记录请求数与错误请求数之和的比例。',
    unit: '%',
    direction: 'higher-is-better',
    scope: 'system',
    measurementPoint: 'client',
    statistics: ['value'],
    formula: 'good_request_count ÷ (request_count + error_request_count) × 100%',
    formulaDependencies: [],
    relatedArchComponents: ['sla-planner', 'engine-metrics'],
    diagnosticMeaning: '它是 0..1 的达标 gate（展示为百分比），与单位为合规请求/秒的 Goodput 必须分开。',
    sourceUrl: AIPERF_GOODPUT,
    asOf: AS_OF,
  },
  {
    id: 'gpu-utilization',
    category: 'resource',
    label: 'GPU 计算利用率',
    shortName: 'GPU Util',
    definition: '采样窗口内 GPU 流式多处理器处于忙状态的时间比例。',
    unit: '%',
    direction: 'target-range',
    scope: 'gpu',
    measurementPoint: 'gpu',
    statistics: ['mean', 'p50', 'p95', 'max'],
    formula: null,
    formulaDependencies: [],
    relatedArchComponents: ['gpu', 'engine-metrics'],
    diagnosticMeaning: '结合排队和吞吐判断计算瓶颈；高利用率本身不代表 SLO 或 Goodput 达标。',
    sourceUrl: DCGM_TELEMETRY,
    asOf: AS_OF,
  },
  {
    id: 'gpu-memory-utilization',
    category: 'resource',
    label: 'GPU 显存利用率',
    shortName: 'HBM Util',
    definition: '已分配或已使用 GPU 显存占设备总显存的比例，口径须随采集器声明。',
    unit: '%',
    direction: 'target-range',
    scope: 'gpu',
    measurementPoint: 'gpu',
    statistics: ['mean', 'p50', 'p95', 'max'],
    formula: null,
    formulaDependencies: [],
    relatedArchComponents: ['gpu', 'kv-hbm', 'quantization'],
    diagnosticMeaning: '高水位可能限制 batch 与并发，低水位则可能存在装载或并行策略浪费。',
    sourceUrl: DCGM_TELEMETRY,
    asOf: AS_OF,
  },
  {
    id: 'kv-cache-utilization',
    category: 'resource',
    label: 'KV Cache 使用率',
    shortName: 'KV Util',
    definition: '推理引擎已占用 KV cache block 占可用 KV cache block 的比例。',
    unit: '%',
    direction: 'target-range',
    scope: 'system',
    measurementPoint: 'engine',
    statistics: ['mean', 'p50', 'p95', 'max'],
    formula: null,
    formulaDependencies: [],
    relatedArchComponents: ['kv-hbm', 'paged-attention', 'engine-metrics'],
    diagnosticMeaning: '持续接近满水位会触发排队、抢占或拒绝请求，是并发容量的直接信号。',
    sourceUrl: VLLM_METRICS,
    asOf: AS_OF,
  },
  {
    id: 'queue-depth',
    category: 'resource',
    label: '排队请求数',
    shortName: 'Queue Depth',
    definition: '已被服务接收、但尚未进入模型执行阶段的请求数量。',
    unit: 'request',
    direction: 'lower-is-better',
    scope: 'system',
    measurementPoint: 'scheduler',
    statistics: ['mean', 'p50', 'p95', 'max'],
    formula: null,
    formulaDependencies: [],
    relatedArchComponents: ['engine-metrics', 'keda-autoscaler', 'gw-inference-ext'],
    diagnosticMeaning: '持续排队说明到达率超过当前有效服务率，常早于 GPU 指标暴露容量不足。',
    sourceUrl: VLLM_METRICS,
    asOf: AS_OF,
  },
  {
    id: 'queue-time',
    category: 'resource',
    label: '排队等待时间',
    shortName: 'Queue Time',
    definition: '请求从被服务接收到开始执行 prefill 之间的等待时间。',
    unit: 'ms/request',
    direction: 'lower-is-better',
    scope: 'request',
    measurementPoint: 'scheduler',
    statistics: ['mean', 'p50', 'p95', 'p99'],
    formula: null,
    formulaDependencies: [],
    relatedArchComponents: ['engine-metrics', 'keda-autoscaler', 'gpu-scheduler'],
    diagnosticMeaning: 'TTFT 同步升高且 queue time 占比扩大时，优先检查容量、调度与限流。',
    sourceUrl: VLLM_METRICS,
    asOf: AS_OF,
  },
  {
    id: 'preemption-rate',
    category: 'resource',
    label: '请求抢占速率',
    shortName: 'Preemption',
    definition: '引擎因 KV 空间不足等原因，在单位时间内抢占并重算或换出的请求次数。',
    unit: 'preemption/s/system',
    direction: 'lower-is-better',
    scope: 'system',
    measurementPoint: 'engine',
    statistics: ['rate', 'total'],
    formula: null,
    formulaDependencies: [],
    relatedArchComponents: ['paged-attention', 'kv-hbm', 'continuous-batching'],
    diagnosticMeaning: '非零且持续的抢占是 KV 压力、并发过高或调度配置不当的强信号。',
    sourceUrl: VLLM_METRICS,
    asOf: AS_OF,
  },
  {
    id: 'prefix-cache-hit-rate',
    category: 'resource',
    label: '前缀缓存命中率',
    shortName: 'Prefix Hit Rate',
    definition: '可复用的已缓存前缀 token 占本次可缓存查询 token 的比例。',
    unit: '%',
    direction: 'higher-is-better',
    scope: 'system',
    measurementPoint: 'engine',
    statistics: ['mean', 'p50', 'p95'],
    formula: null,
    formulaDependencies: [],
    relatedArchComponents: ['prefix-cache', 'radix-attention', 'kv-router'],
    diagnosticMeaning: '预期重复率高但命中率低时，应检查路由打散、缓存淘汰和模型/模板键不一致。',
    sourceUrl: VLLM_METRICS,
    asOf: AS_OF,
  },
  {
    id: 'gpu-power',
    category: 'resource',
    label: 'GPU 功耗',
    shortName: 'GPU Power',
    definition: 'GPU 设备在采样窗口内的板卡功率，可用于能耗与降频诊断。',
    unit: 'W/gpu',
    direction: 'informational',
    scope: 'gpu',
    measurementPoint: 'gpu',
    statistics: ['mean', 'p50', 'p95', 'max'],
    formula: null,
    formulaDependencies: [],
    relatedArchComponents: ['gpu'],
    diagnosticMeaning: '接近功率上限且性能下降可能是功率或散热限制；低功耗需结合利用率解释。',
    sourceUrl: DCGM_TELEMETRY,
    asOf: AS_OF,
  },
  {
    id: 'gpu-count',
    category: 'cost',
    label: '所需 GPU 数量',
    shortName: 'GPU 数',
    definition: '满足目标 Good RPS、容量余量和冗余单元后需要部署的 GPU 总数。',
    unit: 'gpu',
    direction: 'lower-is-better',
    scope: 'system',
    measurementPoint: 'cost-model',
    statistics: ['count'],
    formula: '(ceil(目标 Good RPS × (1 + 余量) ÷ 单元 Goodput) + 冗余单元) × 每单元 GPU 数',
    formulaDependencies: ['goodput'],
    relatedArchComponents: ['gpu', 'gpu-scheduler', 'engine-replica'],
    diagnosticMeaning: '实测 Goodput 缺失时只可给出未验证 SLO 的方向性估算。',
    sourceUrl: NIM_SIZING,
    asOf: AS_OF,
  },
  {
    id: 'server-count',
    category: 'cost',
    label: '所需服务器数量',
    shortName: '服务器数',
    definition: '按明确的每服务器 GPU 数，将 GPU 总数向上取整换算得到的服务器数量。',
    unit: 'server',
    direction: 'lower-is-better',
    scope: 'system',
    measurementPoint: 'cost-model',
    statistics: ['count'],
    formula: 'ceil(GPU 数 ÷ 每服务器 GPU 数)',
    formulaDependencies: ['gpu-count'],
    relatedArchComponents: ['gpu', 'nvlink', 'gpu-scheduler'],
    diagnosticMeaning: '未选择或填写服务器拓扑时必须保持 N/A，不能暗设每机卡数。',
    sourceUrl: NIM_SIZING,
    asOf: AS_OF,
  },
  {
    id: 'rack-count',
    category: 'cost',
    label: '所需机架数量',
    shortName: '机架数',
    definition: '按明确的每机架服务器数，将服务器总数向上取整换算得到的机架数量。',
    unit: 'rack',
    direction: 'lower-is-better',
    scope: 'system',
    measurementPoint: 'cost-model',
    statistics: ['count'],
    formula: 'ceil(服务器数 ÷ 每机架服务器数)',
    formulaDependencies: ['server-count'],
    relatedArchComponents: ['rdma-net', 'gpu-scheduler'],
    diagnosticMeaning: '机架换算必须绑定显式拓扑，且需另行核对网络、供电和散热容量。',
    sourceUrl: NIM_SIZING,
    asOf: AS_OF,
  },
  {
    id: 'cost-per-mtok',
    category: 'cost',
    label: '每百万输出 Token 成本',
    shortName: '$/MTok',
    definition: '稳定测量口径下，集群每小时成本摊到一百万个输出 token 的成本。',
    unit: 'USD/M output-token',
    direction: 'lower-is-better',
    scope: 'system',
    measurementPoint: 'cost-model',
    statistics: ['value'],
    formula: '集群每小时成本（GPU 数 × 单卡 $/h）÷ (系统输出 TPS × 3600 × 有效利用率) × 1,000,000',
    formulaDependencies: ['system-output-tps', 'gpu-count'],
    relatedArchComponents: ['gpu', 'quantization', 'model-router'],
    diagnosticMeaning: '只有当吞吐口径、利用率和成本边界一致时，才能跨方案比较。',
    sourceUrl: NIM_SIZING,
    asOf: AS_OF,
  },
  {
    id: 'cost-per-good-request',
    category: 'cost',
    label: '每个达标请求成本',
    shortName: '$/Good Request',
    definition: '集群每小时成本摊到同一窗口内满足全部已配置 SLO 的请求。',
    unit: 'USD/good-request',
    direction: 'lower-is-better',
    scope: 'system',
    measurementPoint: 'cost-model',
    statistics: ['value'],
    formula: '集群每小时成本（GPU 数 × 单卡 $/h）÷ (Goodput × 3600)',
    formulaDependencies: ['goodput', 'gpu-count'],
    relatedArchComponents: ['gpu', 'sla-planner', 'tenant-gateway'],
    diagnosticMeaning: '把性能与体验约束一起折算为商业成本；Goodput 缺失时不得计算。',
    sourceUrl: AIPERF_GOODPUT,
    asOf: AS_OF,
  },
] as const satisfies readonly KpiDefinition[]

export const KPI_BY_ID = Object.fromEntries(INFERENCE_KPIS.map((definition) => [definition.id, definition])) as {
  readonly [Id in KpiId]: Extract<(typeof INFERENCE_KPIS)[number], { id: Id }>
}
