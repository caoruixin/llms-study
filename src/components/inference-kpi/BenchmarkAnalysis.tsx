import { useMemo, useRef, useState } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ImportIssue, NormalizedBenchmarkRun, NormalizedMetric } from '../../lib/aiperfImport'
import type { AnalysisFinding, BenchmarkFingerprint } from '../../data/inferenceKpis'
import { compareBenchmarks, diagnoseInference } from '../../lib/kpiEngine'
import { useInferenceScenario } from '../../store'
import { EmptyState, MetricTile, Panel, StatusBadge, inputClass } from './KpiPrimitives'
import { useKpiUiStore, type ImportedRunMetadataDraft } from './kpiUiStore'
import {
  findMetric,
  formatMetric,
  fractionValue,
  getRunLabel,
  hasMetric,
  latencyPercentileMs,
  metricUnit,
  metricValue,
  paretoKeys,
  percentileValue,
  requestRatePerSecond,
  saturationPoint,
  tokenRatePerSecond,
  toSweepChartPoints,
  type MetricAlias,
} from './metricUi'

const GRID = '#e3ded1'
const DIM = '#6e6a60'
const ACCENT = '#9e2b3a'
const PURPLE = '#6d28d9'
const GREEN = '#166534'
const AMBER = '#d97706'

const METRIC_CARDS: { alias: MetricAlias; label: string; statistic?: 'p95' | 'p99' }[] = [
  { alias: 'systemTps', label: '系统输出 TPS' },
  { alias: 'rps', label: 'RPS' },
  { alias: 'goodput', label: 'Goodput' },
  { alias: 'ttft', label: 'TTFT p95', statistic: 'p95' },
  { alias: 'tpot', label: 'TPOT p95', statistic: 'p95' },
  { alias: 'e2e', label: 'E2E p99', statistic: 'p99' },
]

function IssueList({ title, issues, tone }: { title: string; issues: ImportIssue[]; tone: 'bad' | 'warn' }) {
  if (issues.length === 0) return null
  return (
    <div className={`rounded-lg border p-3 ${tone === 'bad' ? 'border-bad/30 bg-bad/10' : 'border-warn/30 bg-warn/10'}`}>
      <div className={`text-xs font-semibold ${tone === 'bad' ? 'text-bad' : 'text-warn'}`}>
        {tone === 'bad' ? '错误' : '警告'} · {title}（{issues.length}）
      </div>
      <ul className="mt-2 space-y-1 text-xs leading-relaxed text-fg">
        {issues.map((issue, index) => (
          <li key={`${issue.code}-${issue.artifactName ?? ''}-${index}`} className="break-words">
            <span className="font-mono text-[11px] text-dim">[{issue.code}]</span>{' '}
            {issue.artifactName && <span>{issue.artifactName}： </span>}
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
  )
}

function runMetricValue(run: NormalizedBenchmarkRun, alias: MetricAlias, statistic?: 'p95' | 'p99') {
  const metric = findMetric(run.metrics, alias)
  return {
    metric,
    value: statistic ? percentileValue(metric, statistic) : metricValue(metric),
  }
}

function readMetadata(run: NormalizedBenchmarkRun, keys: string[]): string {
  const metadata = { ...(run.inputConfig ?? {}), ...(run.metadata ?? {}) } as Record<string, unknown>
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function readNumber(run: NormalizedBenchmarkRun, keys: string[]): number | null {
  const value = readMetadata(run, keys)
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseSlo(value: unknown): Readonly<Record<string, number>> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    return entries.length > 0 ? Object.fromEntries(entries) : null
  }
  if (typeof value !== 'string') return null
  const entries: [string, number][] = []
  for (const fragment of value.split(/[,;]+/)) {
    const match = fragment.trim().match(/^([a-zA-Z0-9_-]+)\s*[:=]\s*(\d+(?:\.\d+)?)$/)
    if (match) entries.push([match[1], Number(match[2])])
  }
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

function fingerprintFor(run: NormalizedBenchmarkRun, draft?: ImportedRunMetadataDraft): BenchmarkFingerprint {
  const metadata = { ...(run.inputConfig ?? {}), ...(run.metadata ?? {}) } as Record<string, unknown>
  const draftNumber = (key: 'inputTokens' | 'outputTokens' | 'gpuCount') => {
    const value = draft?.[key]
    if (!value?.trim()) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const fallback = (draftValue: string | undefined, keys: string[]) => draftValue?.trim() || readMetadata(run, keys) || null
  return {
    modelId: fallback(draft?.model, ['model', 'model_name', 'modelId']),
    quantization: fallback(draft?.quantization, ['quantization', 'quant', 'precision']),
    inputSequenceLength: draftNumber('inputTokens') ?? readNumber(run, ['input_sequence_length', 'input_tokens', 'isl', 'inputTokens']),
    outputSequenceLength: draftNumber('outputTokens') ?? readNumber(run, ['output_sequence_length', 'output_tokens', 'osl', 'outputTokens']),
    gpuModel: fallback(draft?.gpuModel, ['gpu_model', 'gpu', 'accelerator']),
    gpuCount: draftNumber('gpuCount') ?? readNumber(run, ['gpu_count', 'num_gpus', 'gpuCount']),
    hardwareTopology: fallback(draft?.topology, ['hardware_topology', 'topology']),
    engine: fallback(draft?.engine, ['engine', 'backend', 'server']),
    engineVersion: fallback(draft?.engineVersion, ['engine_version', 'engineVersion', 'server_version']),
    loadMode: fallback(draft?.loadMode, ['load_mode', 'loadMode', 'benchmark_mode']),
    workloadFingerprint: fallback(draft?.workload, ['workload_fingerprint', 'workloadFingerprint']),
    slo: parseSlo(draft?.slo || metadata.slo || metadata.goodput_slo),
  }
}

function comparisonStatus(runs: NormalizedBenchmarkRun[], drafts: Record<string, ImportedRunMetadataDraft>) {
  if (runs.length < 2) return { comparable: false, reasons: ['至少需要两个有效 run 才能比较。'] }
  const [left, right] = runs
  const result = compareBenchmarks(fingerprintFor(left, drafts[left.key]), fingerprintFor(right, drafts[right.key]))
  return {
    comparable: result.comparable,
    reasons: result.mismatches.map((mismatch) =>
      mismatch.reason === 'missing'
        ? `${mismatch.label}缺失`
        : `${mismatch.label}不一致（${String(mismatch.left)} vs ${String(mismatch.right)}）`,
    ),
  }
}

function MetadataForm({ run }: { run: NormalizedBenchmarkRun }) {
  const draft = useKpiUiStore((state) => state.metadataDrafts[run.key])
  const update = useKpiUiStore((state) => state.updateMetadata)
  if (!draft) return null
  const fields = [
    ['model', '模型', '例如 Llama 3.1 70B'],
    ['quantization', '量化', '例如 FP8'],
    ['inputTokens', '输入长度 ISL', '例如 2048'],
    ['outputTokens', '输出长度 OSL', '例如 512'],
    ['engine', '推理引擎', '例如 vLLM'],
    ['engineVersion', '引擎版本', '例如 0.10'],
    ['gpuModel', 'GPU 型号', '例如 H100 SXM'],
    ['gpuCount', 'GPU 数量', '例如 8'],
    ['topology', '硬件拓扑', '例如 1×DGX H100 8-GPU'],
    ['loadMode', '负载模式', 'concurrency / request-rate'],
    ['workload', '负载指纹', '数据集、长度分布、并发配置'],
    ['slo', 'Goodput SLO', '例如 ttft=1000,tpot=30'],
  ] as const
  const complete = Object.values(draft).every((value) => value.trim().length > 0)
  return (
    <Panel className="border-warn/40 bg-warn/5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">补齐 CSV 运行上下文 · {getRunLabel(run)}</h4>
        <StatusBadge tone={complete ? 'ok' : 'warn'}>{complete ? '信息已补齐' : '尚不可下比较结论'}</StatusBadge>
      </div>
      <p className="mt-1 text-xs text-dim">CSV 通常不含完整运行配置。这里的信息只保留在当前页面内存中。</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {fields.map(([key, label, placeholder]) => (
          <label key={key} className="text-xs text-dim">
            {label}
            <input
              value={draft[key]}
              onChange={(event) => update(run.key, { [key]: event.target.value })}
              placeholder={placeholder}
              className={inputClass}
            />
          </label>
        ))}
      </div>
    </Panel>
  )
}

function ImportedMetrics({ run }: { run: NormalizedBenchmarkRun }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
      {METRIC_CARDS.map(({ alias, label, statistic }) => {
        const { metric, value } = runMetricValue(run, alias, statistic)
        return (
          <MetricTile
            key={alias}
            label={label}
            value={formatMetric(value, metricUnit(metric))}
            badge={<StatusBadge tone={metric ? 'measured' : 'neutral'}>{metric ? '实测' : '缺失'}</StatusBadge>}
            note={
              alias === 'systemTps'
                ? '整个服务系统每秒输出 token；不是单用户出字速度。'
                : alias === 'goodput'
                  ? '同时满足逐请求 SLO 的请求率；不由多个 p95 拼接。'
                  : undefined
            }
          />
        )
      })}
    </div>
  )
}

export default function BenchmarkAnalysis() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const { slo } = useInferenceScenario()
  const { batch, selectedRunKey, importing, importFailure, metadataDrafts, importFiles, selectRun, clearImport } = useKpiUiStore()
  const selectedRun = batch?.runs.find((run) => run.key === selectedRunKey) ?? batch?.runs[0] ?? null
  const chartPoints = useMemo(() => toSweepChartPoints(batch?.sweepPoints ?? []), [batch?.sweepPoints])
  const saturation = useMemo(() => saturationPoint(chartPoints), [chartPoints])
  const pareto = useMemo(() => paretoKeys(chartPoints), [chartPoints])
  const hasOfficialPareto = chartPoints.some((point) => point.source.paretoOptimal !== undefined)
  const xLabel = chartPoints[0]?.xLabel ?? '并发 / 请求率'
  const validRuns = batch?.runs.filter((run) => run.valid && !run.cancelled) ?? []
  const comparison = comparisonStatus(validRuns, metadataDrafts)

  const receiveFiles = (files: FileList | null) => {
    if (!files?.length) return
    void importFiles(Array.from(files))
  }

  return (
    <div className="min-w-0 space-y-4">
      <Panel className="overflow-hidden">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold">AIPerf 实测导入</h3>
            <p className="mt-1 text-xs leading-relaxed text-dim">
              支持 profile、confidence aggregate、collated、sweep aggregate 与 server metrics 的 JSON/CSV；按文件内容识别，不依赖固定文件名前缀。
            </p>
          </div>
          <StatusBadge tone="ok">🔒 仅在浏览器内解析 · 刷新清除</StatusBadge>
        </div>

        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".json,.csv,application/json,text/csv"
          className="sr-only"
          onChange={(event) => {
            receiveFiles(event.target.files)
            event.target.value = ''
          }}
        />
        <button
          type="button"
          disabled={importing}
          onClick={() => inputRef.current?.click()}
          onDragEnter={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            receiveFiles(event.dataTransfer.files)
          }}
          className={`mt-4 flex min-h-28 w-full flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors ${
            dragging ? 'border-accent bg-accent/10' : 'border-line bg-panel-2/50 hover:border-accent/50'
          } disabled:cursor-wait disabled:opacity-60`}
        >
          <span className="text-sm font-semibold">{importing ? '正在解析…' : '选择或拖入多个 AIPerf JSON / CSV'}</span>
          <span className="mt-1 text-xs text-dim">不会上传、不会写入 localStorage / IndexedDB</span>
        </button>
      </Panel>

      {importFailure && <IssueList title="文件读取失败" issues={[{ code: 'READ_FAILED', message: importFailure }]} tone="bad" />}

      {!batch ? (
        <EmptyState title="还没有 Benchmark 数据">
          导入一组 AIPerf 汇总或 sweep 文件后，这里会展示实测口径、饱和拐点、Pareto 点、SLO 可行区与资源诊断。
        </EmptyState>
      ) : (
        <>
          <Panel>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="mr-auto text-sm font-semibold">导入摘要</h3>
              <StatusBadge>{batch.artifacts.length} 个文件</StatusBadge>
              <StatusBadge tone="measured">{validRuns.length} 个有效 run</StatusBadge>
              <StatusBadge>{batch.sweepPoints.length} 个 sweep 点</StatusBadge>
              {batch.duplicates.length > 0 && <StatusBadge tone="warn">{batch.duplicates.length} 个重复项已去重</StatusBadge>}
              <button type="button" onClick={clearImport} className="min-h-11 rounded-md px-3 text-xs text-dim hover:bg-panel-2 hover:text-fg">
                清除导入
              </button>
            </div>
            <div className="mt-3 flex max-w-full gap-2 overflow-x-auto pb-1">
              {batch.runs.map((run) => (
                <button
                  key={run.key}
                  type="button"
                  onClick={() => selectRun(run.key)}
                  className={`min-h-11 shrink-0 rounded-lg border px-3 py-2 text-left text-xs ${
                    run.key === selectedRun?.key ? 'border-accent bg-accent/10' : 'border-line bg-panel-2 hover:border-accent/50'
                  }`}
                >
                  <span className="font-semibold">{getRunLabel(run)}</span>
                  <span className="ml-2 text-dim">{run.valid && !run.cancelled ? '✓ 有效' : run.cancelled ? '⊘ 已取消' : '✕ 无效'}</span>
                </button>
              ))}
            </div>
          </Panel>

          <IssueList title="导入批次" issues={batch.errors} tone="bad" />
          <IssueList title="导入批次" issues={batch.warnings} tone="warn" />

          {selectedRun && (
            <>
              <ImportedMetrics run={selectedRun} />
              {!hasMetric(selectedRun.metrics, 'goodput') && (
                <div className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm leading-relaxed">
                  <span className="font-semibold text-warn">Goodput：N/A。</span>{' '}
                  当前文件没有 AIPerf 已计算的逐请求联合达标率。请带 <code className="rounded bg-panel px-1 py-0.5 font-mono text-xs">--goodput</code>{' '}
                  重新运行；页面不会把 TTFT / TPOT / E2E 的多个 p95 条件拼成伪 Goodput，也不会在此修改 SLO 后重算。
                </div>
              )}
              <MetadataForm run={selectedRun} />
            </>
          )}

          {batch.unassociatedServerArtifacts.length > 0 && (
            <div className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-xs leading-relaxed">
              <span className="font-semibold text-warn">未自动关联 server metrics：</span>
              {batch.unassociatedServerArtifacts.length} 组文件没有与 run 相同的 benchmark ID。为避免误诊，页面不会按时间或文件名猜测关联关系。
            </div>
          )}

          {chartPoints.length > 0 ? (
            <div className="grid min-w-0 gap-4 xl:grid-cols-2">
              <Panel className="min-w-0 overflow-hidden">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">容量曲线</h3>
                    <p className="mt-1 text-[11px] text-dim">系统输出 TPS、RPS 与 AIPerf Goodput 是三个不同口径。</p>
                  </div>
                  {saturation && <StatusBadge tone="warn">饱和拐点 ≈ {saturation.x}</StatusBadge>}
                </div>
                <div className="mt-3 h-72 w-full" role="img" aria-label={`Sweep 容量曲线，横轴 ${xLabel}`}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartPoints} margin={{ top: 8, right: 10, left: -15, bottom: 12 }}>
                      <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="x" type="number" stroke={DIM} tick={{ fill: DIM, fontSize: 11 }} label={{ value: xLabel, position: 'insideBottomRight', offset: -7, fill: DIM, fontSize: 10 }} />
                      <YAxis stroke={DIM} tick={{ fill: DIM, fontSize: 11 }} />
                      <Tooltip contentStyle={{ background: '#fff', border: `1px solid ${GRID}`, borderRadius: 8, fontSize: 12 }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {saturation && <ReferenceLine x={saturation.x} stroke={AMBER} strokeDasharray="4 4" label={{ value: '饱和', fill: AMBER, fontSize: 10 }} />}
                      <Line type="monotone" dataKey="systemTps" name="系统输出 TPS" stroke={ACCENT} strokeWidth={2} connectNulls={false} />
                      <Line type="monotone" dataKey="rps" name="RPS" stroke={PURPLE} strokeWidth={2} connectNulls={false} />
                      <Line type="monotone" dataKey="goodput" name="Goodput RPS" stroke={GREEN} strokeWidth={2} connectNulls={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </Panel>

              <Panel className="min-w-0 overflow-hidden">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">体验延迟曲线</h3>
                    <p className="mt-1 text-[11px] text-dim">p95 / p99 按 artifact unit 归一为 ms 后与 SLO 同图校验。</p>
                  </div>
                  <StatusBadge tone="neutral">Pareto 前沿 {pareto.size} 点 · {hasOfficialPareto ? 'AIPerf 标记' : '页面 TPS/E2E p95 维度'}</StatusBadge>
                </div>
                <div className="mt-3 h-72 w-full" role="img" aria-label={`Sweep 延迟曲线，横轴 ${xLabel}`}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartPoints} margin={{ top: 8, right: 10, left: -15, bottom: 12 }}>
                      <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="x" type="number" stroke={DIM} tick={{ fill: DIM, fontSize: 11 }} label={{ value: xLabel, position: 'insideBottomRight', offset: -7, fill: DIM, fontSize: 10 }} />
                      <YAxis stroke={DIM} tick={{ fill: DIM, fontSize: 11 }} />
                      <Tooltip contentStyle={{ background: '#fff', border: `1px solid ${GRID}`, borderRadius: 8, fontSize: 12 }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {slo.e2eMs !== null && <ReferenceLine y={slo.e2eMs} stroke={ACCENT} strokeDasharray="5 4" label={{ value: 'E2E SLO', fill: ACCENT, fontSize: 10 }} />}
                      {slo.ttftMs !== null && <ReferenceLine y={slo.ttftMs} stroke={AMBER} strokeDasharray="5 4" label={{ value: 'TTFT SLO', fill: AMBER, fontSize: 10 }} />}
                      <Line type="monotone" dataKey="ttftP95" name="TTFT p95" stroke={AMBER} strokeWidth={2} connectNulls={false} />
                      <Line type="monotone" dataKey="e2eP95" name="E2E p95" stroke={PURPLE} strokeWidth={2} connectNulls={false} />
                      <Line type="monotone" dataKey="e2eP99" name="E2E p99" stroke={ACCENT} strokeWidth={2} connectNulls={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {chartPoints.filter((point) => pareto.has(point.key)).map((point) => (
                    <StatusBadge key={point.key} tone="ok">Pareto · {xLabel}={point.x}</StatusBadge>
                  ))}
                  {chartPoints.map((point) => {
                    // AIPerf 的 good_request_fraction 才是逐请求联合 SLO attainment gate；
                    // 多个 p95 同时达标并不等于同一批请求联合达标，绝不能据此伪造可行点。
                    const passes = point.goodFraction !== null && point.goodFraction >= slo.attainment
                    return passes ? <StatusBadge key={`slo-${point.key}`} tone="target">SLO 可行 · {point.x}（达标率 {(point.goodFraction! * 100).toFixed(1)}%）</StatusBadge> : null
                  })}
                  {chartPoints.every((point) => point.goodFraction === null) && (
                    <StatusBadge tone="warn">SLO 可行区未验证：缺少 good_request_fraction</StatusBadge>
                  )}
                </div>
              </Panel>
            </div>
          ) : (
            <EmptyState title="当前导入没有 Sweep 点">单次 profile 仍可查看实测摘要；导入 sweep aggregate 才能分析饱和与 Pareto 前沿。</EmptyState>
          )}

          <Panel>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">运行可比性保护</h3>
              <StatusBadge tone={comparison.comparable ? 'ok' : 'warn'}>
                {comparison.comparable ? '✓ 可下比较结论' : '△ 仅并排展示'}
              </StatusBadge>
            </div>
            {comparison.comparable ? (
              <p className="mt-2 text-xs leading-relaxed text-dim">前两个有效 run 的模型、量化、ISL/OSL、硬件拓扑、引擎版本、负载模式与 SLO 均一致。</p>
            ) : (
              <ul className="mt-2 grid gap-1 text-xs leading-relaxed text-dim sm:grid-cols-2">
                {comparison.reasons.map((reason) => <li key={reason}>△ {reason}</li>)}
              </ul>
            )}
          </Panel>

          <DiagnosticsPanel run={selectedRun} chartPoints={chartPoints} />
        </>
      )}
    </div>
  )
}

function DiagnosticsPanel({ run, chartPoints }: { run: NormalizedBenchmarkRun | null; chartPoints: ReturnType<typeof toSweepChartPoints> }) {
  if (!run) return null
  const { slo, cacheRate } = useInferenceScenario.getState()
  const metrics = {
    ...run.metrics,
    ...Object.fromEntries(run.serverMetrics.map((metric, index) => [`server-${metric.seriesKey ?? metric.name}-${index}`, metric])),
  }
  const metricRows: { label: string; metric?: NormalizedMetric; warning: string }[] = [
    { label: 'TTFT', metric: findMetric(metrics, 'ttft'), warning: '高 TTFT 常见于 prefill 算力、排队或冷启动。' },
    { label: 'TPOT', metric: findMetric(metrics, 'tpot'), warning: '高 TPOT 常见于 decode 带宽、batch 干扰或抢占。' },
    { label: '排队', metric: findMetric(metrics, 'queue'), warning: '队列增长而吞吐不再上升，是容量饱和信号。' },
    { label: 'GPU 利用率', metric: findMetric(metrics, 'gpuUtil'), warning: '低利用率要结合队列、batch 与通信判断，不能单指标归因。' },
    { label: '显存 / KV 压力', metric: findMetric(metrics, 'kvUtil') ?? findMetric(metrics, 'memoryUtil'), warning: '接近上限时检查 KV 水位、抢占与缓存块碎片。' },
    { label: '缓存命中', metric: findMetric(metrics, 'cacheHit'), warning: '命中率低时检查前缀稳定性与 KV-cache 感知路由。' },
  ]
  const available = metricRows.filter((row) => row.metric)
  const percentage = (metric: NormalizedMetric | undefined) => {
    const value = metricValue(metric)
    if (value === null) return null
    return value <= 1 && !metric?.unit.includes('%') ? value * 100 : value
  }
  const findings = diagnoseInference({
    ttftP95Ms: latencyPercentileMs(findMetric(metrics, 'ttft'), 'p95'),
    ttftTargetMs: slo.ttftMs,
    tpotP95Ms: latencyPercentileMs(findMetric(metrics, 'tpot'), 'p95'),
    tpotTargetMs: slo.tpotMs,
    e2eLatencyP95Ms: latencyPercentileMs(findMetric(metrics, 'e2e'), 'p95'),
    e2eTargetMs: slo.e2eMs,
    queueTimeP95Ms: latencyPercentileMs(findMetric(metrics, 'queueTime'), 'p95'),
    queuedRequests: metricValue(findMetric(metrics, 'queueDepth')),
    kvCacheUtilizationPct: percentage(findMetric(metrics, 'kvUtil')),
    preemptionRatePerSecond: metricValue(findMetric(metrics, 'preemption')),
    prefixCacheHitRatePct: percentage(findMetric(metrics, 'cacheHit')),
    expectedPrefixCacheHitRatePct: cacheRate * 100,
    gpuUtilizationPct: percentage(findMetric(metrics, 'gpuUtil')),
    gpuMemoryUtilizationPct: percentage(findMetric(metrics, 'memoryUtil')),
    rps: requestRatePerSecond(findMetric(metrics, 'rps')),
    systemOutputTps: tokenRatePerSecond(findMetric(metrics, 'systemTps')),
    goodputRps: requestRatePerSecond(findMetric(metrics, 'goodput')),
    goodRequestFraction: fractionValue(findMetric(metrics, 'goodFraction')),
    sweepPoints: chartPoints.map((point) => ({
      load: point.x,
      systemOutputTps: point.systemTps,
      rps: point.rps,
      goodputRps: point.goodput,
      ttftP95Ms: point.ttftP95,
      tpotP95Ms: point.tpotP95,
      e2eP95Ms: point.e2eP95,
    })),
  })
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">瓶颈诊断证据</h3>
          <p className="mt-1 text-[11px] text-dim">先列证据，再给原因与下一步；缺少 server metrics 时不猜测。</p>
        </div>
        <StatusBadge tone={available.length ? 'measured' : 'neutral'}>{available.length ? `${available.length} 类实测证据` : '证据不足'}</StatusBadge>
      </div>
      {findings.length > 0 && <FindingList findings={findings} />}
      {available.length ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {available.map((row) => (
            <div key={row.label} className="rounded-lg border border-line bg-panel-2/50 p-3 text-xs leading-relaxed">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{row.label}</span>
                <StatusBadge tone="measured">实测</StatusBadge>
              </div>
              <div className="mt-2 font-mono text-lg font-bold">{formatMetric(metricValue(row.metric), metricUnit(row.metric))}</div>
              <p className="mt-2 text-dim">可能原因 / 下一步：{row.warning}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs leading-relaxed text-dim">导入同 benchmark ID 的 server metrics 后，可关联 GPU、显存、KV、排队等资源证据。</p>
      )}
    </Panel>
  )
}

function FindingList({ findings }: { findings: AnalysisFinding[] }) {
  return (
    <div className="mt-3 space-y-3">
      {findings.map((finding) => (
        <div key={finding.id} className={`rounded-lg border p-3 ${finding.severity === 'critical' ? 'border-bad/30 bg-bad/5' : finding.severity === 'warning' ? 'border-warn/30 bg-warn/5' : 'border-line bg-panel-2/50'}`}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={finding.severity === 'critical' ? 'bad' : finding.severity === 'warning' ? 'warn' : 'neutral'}>
              {finding.severity === 'critical' ? '✕ 严重' : finding.severity === 'warning' ? '△ 注意' : 'ℹ 信息'}
            </StatusBadge>
            <h4 className="text-sm font-semibold">{finding.title}</h4>
          </div>
          <div className="mt-2 grid gap-3 text-xs leading-relaxed md:grid-cols-3">
            <div><div className="font-semibold">证据</div><ul className="mt-1 space-y-1 text-dim">{finding.evidence.map((item) => <li key={item}>· {item}</li>)}</ul></div>
            <div><div className="font-semibold">可能原因</div><ul className="mt-1 space-y-1 text-dim">{finding.possibleCauses.map((item) => <li key={item}>· {item}</li>)}</ul></div>
            <div><div className="font-semibold">下一步检查</div><ul className="mt-1 space-y-1 text-dim">{finding.nextChecks.map((item) => <li key={item}>· {item}</li>)}</ul></div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">{finding.relatedArchComponents.map((component) => <StatusBadge key={component} tone="estimated">{component}</StatusBadge>)}</div>
        </div>
      ))}
    </div>
  )
}
