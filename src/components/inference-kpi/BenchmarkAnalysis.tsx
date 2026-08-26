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
import { compareBenchmarks, diagnoseInference, estimateE2ELatencyMs, observed } from '../../lib/kpiEngine'
import { useInferenceScenario } from '../../store'
import { EmptyState, MetricTile, Panel, StatusBadge, inputClass } from './KpiPrimitives'
import { useKpiUiStore, type ImportedRunMetadataDraft } from './kpiUiStore'
import {
  findMetric,
  findMetrics,
  formatMetric,
  fractionValue,
  getRunLabel,
  groupSweepPoints,
  hasMetric,
  latencyPercentileMs,
  latencyStatisticMs,
  meanLatencyMs,
  metricStatisticValue,
  metricUnit,
  metricValue,
  paretoKeys,
  percentValue,
  preemptionEvidence,
  requestRatePerSecond,
  selectMetricStatistic,
  saturationPoint,
  tokenRatePerSecond,
  toSweepChartPoints,
  toSweepDiagnosticPoint,
  type MetricAlias,
  type SweepPointGroup,
} from './metricUi'

const GRID = '#e3ded1'
const DIM = '#6e6a60'
const ACCENT = '#9e2b3a'
const PURPLE = '#6d28d9'
const GREEN = '#166534'
const AMBER = '#d97706'

const METRIC_CARDS: { alias: MetricAlias; label: string; statistic?: 'p95' | 'p99' }[] = [
  { alias: 'systemTps', label: '系统输出 TPS' },
  { alias: 'perUserTps', label: '单用户输出 tok/s' },
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
  if (statistic) {
    const selection = selectMetricStatistic(run.metrics, alias, statistic)
    return { metric: selection?.metric, value: selection?.value ?? null }
  }
  const metric = findMetric(run.metrics, alias)
  return {
    metric,
    value: metricValue(metric),
  }
}

function scalarText(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value) && value.length === 1) return scalarText(value[0])
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    for (const key of ['model', 'model_name', 'name', 'id', 'value', 'type']) {
      const text = scalarText(object[key])
      if (text) return text
    }
  }
  return ''
}

function nestedValue(root: unknown, wanted: ReadonlySet<string>, depth = 0): unknown {
  if (depth > 6 || root === null || root === undefined) return undefined
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = nestedValue(item, wanted, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof root !== 'object') return undefined
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    if (wanted.has(key.toLowerCase()) && scalarText(value)) return value
  }
  for (const value of Object.values(root as Record<string, unknown>)) {
    const found = nestedValue(value, wanted, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function readMetadata(run: NormalizedBenchmarkRun, keys: string[]): string {
  const root = { inputConfig: run.inputConfig ?? {}, metadata: run.metadata ?? {} }
  return scalarText(nestedValue(root, new Set(keys.map((key) => key.toLowerCase()))))
}

function readNumber(run: NormalizedBenchmarkRun, keys: string[]): number | null {
  const value = readMetadata(run, keys)
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function configFingerprint(run: NormalizedBenchmarkRun): string {
  const input = run.inputConfig ?? {}
  const selected = {
    datasets: input.datasets ?? input.dataset ?? null,
    phases: input.phases ?? null,
    endpoint: input.endpoint ?? input.url ?? null,
  }
  return Object.values(selected).some((value) => value !== null) ? JSON.stringify(selected) : ''
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

export function fingerprintFor(run: NormalizedBenchmarkRun, draft?: ImportedRunMetadataDraft): BenchmarkFingerprint {
  const metadata = { ...(run.inputConfig ?? {}), ...(run.metadata ?? {}) } as Record<string, unknown>
  const draftNumber = (key: 'inputTokens' | 'outputTokens' | 'gpuCount') => {
    const value = draft?.[key]
    if (!value?.trim()) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const fallback = (draftValue: string | undefined, keys: string[]) => draftValue?.trim() || readMetadata(run, keys) || null
  return {
    modelId: fallback(draft?.model, ['model', 'models', 'model_name', 'modelId']),
    quantization: fallback(draft?.quantization, ['quantization', 'quant', 'precision']),
    inputSequenceLength: draftNumber('inputTokens') ?? readNumber(run, ['input_sequence_length', 'input_tokens', 'isl', 'inputTokens']),
    outputSequenceLength: draftNumber('outputTokens') ?? readNumber(run, ['output_sequence_length', 'output_tokens', 'osl', 'outputTokens']),
    gpuModel: fallback(draft?.gpuModel, ['gpu_model', 'gpu', 'accelerator']),
    gpuCount: draftNumber('gpuCount') ?? readNumber(run, ['gpu_count', 'num_gpus', 'gpuCount']),
    hardwareTopology: fallback(draft?.topology, ['hardware_topology', 'topology']),
    engine: fallback(draft?.engine, ['engine', 'backend', 'server']),
    engineVersion: fallback(draft?.engineVersion, ['engine_version', 'engineVersion', 'server_version']),
    loadMode: fallback(draft?.loadMode, ['load_mode', 'loadMode', 'benchmark_mode', 'type']),
    workloadFingerprint: fallback(draft?.workload, ['workload_fingerprint', 'workloadFingerprint']) || configFingerprint(run) || null,
    slo: parseSlo(draft?.slo || metadata.slo || metadata.goodput_slo || (run.inputConfig as Record<string, unknown> | undefined)?.goodput),
  }
}

export interface ComparisonReason {
  /** run.key 对 + 不一致字段的组合键，天然唯一，供 React key 使用（文案可能重复） */
  id: string
  runKeys: readonly [string, string]
  text: string
}

export interface ComparisonStatus {
  comparable: boolean
  /** 有效 run 不足两个：没有比较对象，属于中性事实而非告警 */
  singleRun: boolean
  reasons: ComparisonReason[]
}

export function comparisonStatus(runs: NormalizedBenchmarkRun[], drafts: Record<string, ImportedRunMetadataDraft>): ComparisonStatus {
  if (runs.length < 2) return { comparable: false, singleRun: true, reasons: [] }
  const baseline = runs[0]
  const reasons = runs.slice(1).flatMap((candidate) => {
    const result = compareBenchmarks(
      fingerprintFor(baseline, drafts[baseline.key]),
      fingerprintFor(candidate, drafts[candidate.key]),
    )
    const pair = `${getRunLabel(baseline)} ↔ ${getRunLabel(candidate)}`
    return result.mismatches.map((mismatch): ComparisonReason => ({
      id: `${baseline.key}|${candidate.key}|${mismatch.field}`,
      runKeys: [baseline.key, candidate.key],
      text: mismatch.reason === 'missing'
        ? `${pair}：${mismatch.label}缺失`
        : `${pair}：${mismatch.label}不一致（${String(mismatch.left)} vs ${String(mismatch.right)}）`,
    }))
  })
  return {
    comparable: reasons.length === 0,
    singleRun: false,
    reasons,
  }
}

function MetadataForm({ run, required }: { run: NormalizedBenchmarkRun; required: boolean }) {
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
  const fingerprint = fingerprintFor(run, draft)
  const complete = Object.values(fingerprint).every((value) => value !== null)
  if (!required && complete) return null
  return (
    <Panel className="border-warn/40 bg-warn/5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{required ? '补齐 CSV 运行上下文' : '补齐运行上下文'} · {getRunLabel(run)}</h4>
        <StatusBadge tone={complete ? 'ok' : 'warn'}>{complete ? '信息已补齐' : '尚不可下比较结论'}</StatusBadge>
      </div>
      <p className="mt-1 text-xs text-dim">{required ? 'CSV 通常不含完整运行配置。' : '导入配置仍缺少严格比较所需字段。'}这里的信息只保留在当前页面内存中。</p>
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
  const runUsable = run.valid && !run.cancelled

  return (
    // 7 张卡：xl 用 4 列成 4+3 两行，避免 6 列时第 7 张孤行
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {METRIC_CARDS.map(({ alias, label, statistic }) => {
        const { metric, value } = runMetricValue(run, alias, statistic)
        const usable = Boolean(runUsable && metric && metric.available !== false && metric.unit.trim() && value !== null)
        const badgeLabel = run.cancelled
          ? 'run 已取消'
          : !run.valid
            ? 'run 无效'
            : usable
              ? '实测'
              : metric
                ? '口径不可用'
                : '缺失'
        return (
          <MetricTile
            key={alias}
            label={label}
            value={formatMetric(value, metricUnit(metric))}
            badge={<StatusBadge tone={usable ? 'measured' : runUsable ? 'neutral' : 'warn'}>{badgeLabel}</StatusBadge>}
            note={
              alias === 'systemTps'
                ? '整个服务系统每秒输出 token；不是单用户出字速度。'
                : alias === 'perUserTps'
                  ? '单个请求视角的出字速度；与系统 TPS 口径不同，不能互相替代。'
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

function E2eCrossCheck({ run }: { run: NormalizedBenchmarkRun }) {
  if (!run.valid || run.cancelled) return null
  const ttftMeanMs = meanLatencyMs(run.metrics, 'ttft')
  const tpotMeanMs = meanLatencyMs(run.metrics, 'tpot')
  const oslMean = metricStatisticValue(run.metrics, 'osl', 'mean')
  const measuredE2eMs = meanLatencyMs(run.metrics, 'e2e')
  const estimatedE2eMs = ttftMeanMs !== null && tpotMeanMs !== null && oslMean !== null && oslMean >= 1
    ? estimateE2ELatencyMs(ttftMeanMs, Math.round(oslMean), tpotMeanMs)
    : null
  if (estimatedE2eMs === null) return null
  const deviation = measuredE2eMs !== null && measuredE2eMs > 0
    ? ((estimatedE2eMs - measuredE2eMs) / measuredE2eMs) * 100
    : null
  return (
    <div className="rounded-lg border border-line bg-panel-2/50 p-3 text-xs leading-relaxed">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">E2E 交叉校验</span>
        <StatusBadge tone="estimated">公式估算</StatusBadge>
        <span>TTFT + (OSL − 1) × TPOT ≈ {formatMetric(estimatedE2eMs, 'ms')}</span>
        {measuredE2eMs !== null && (
          <>
            <StatusBadge tone="measured">实测</StatusBadge>
            <span>
              E2E mean {formatMetric(measuredE2eMs, 'ms')}
              {deviation === null ? '' : `（估算偏差 ${deviation >= 0 ? '+' : ''}${deviation.toFixed(1)}%）`}
            </span>
          </>
        )}
      </div>
      <p className="mt-1 text-dim">
        估算来自本 run 实测 TTFT/TPOT 均值与平均 OSL；
        {measuredE2eMs === null
          ? '当前文件缺少实测 E2E，仅供方向性参考。'
          : '偏差过大时优先核对排队时间与输出长度分布。'}
      </p>
    </div>
  )
}

function runBelongsToSweep(run: NormalizedBenchmarkRun, group: SweepPointGroup): boolean {
  if (group.sweepId !== null) return run.sweepId === group.sweepId
  if (group.sourceName !== null) return run.sourceNames.includes(group.sourceName)
  return group.points.some((point) =>
    Boolean(
      point.benchmarkId &&
      run.benchmarkId === point.benchmarkId &&
      run.variation === point.variation &&
      run.trial === point.trial,
    ),
  )
}

export default function BenchmarkAnalysis() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const { slo } = useInferenceScenario()
  const {
    batch,
    selectedRunKey,
    selectedSweepKey,
    importing,
    importFailure,
    metadataDrafts,
    importFiles,
    selectRun,
    selectSweep,
    clearImport,
  } = useKpiUiStore()
  const selectedRun = batch?.runs.find((run) => run.key === selectedRunKey) ?? batch?.runs[0] ?? null
  const sweepGroups = useMemo(() => groupSweepPoints(batch?.sweepPoints ?? []), [batch?.sweepPoints])
  const selectedSweep = sweepGroups.find((group) => group.key === selectedSweepKey) ?? sweepGroups[0] ?? null
  const selectedSweepPoints = selectedSweep?.points ?? []
  const chartPoints = useMemo(() => toSweepChartPoints(selectedSweepPoints), [selectedSweepPoints])
  const saturation = useMemo(() => saturationPoint(chartPoints), [chartPoints])
  const pareto = useMemo(() => paretoKeys(chartPoints), [chartPoints])
  const hasOfficialPareto = chartPoints.some((point) => point.source.paretoOptimal !== undefined)
  const xLabel = chartPoints[0]?.xLabel ?? '并发 / 请求率'
  const validRuns = batch?.runs.filter((run) => run.valid && !run.cancelled) ?? []
  const comparison = comparisonStatus(validRuns, metadataDrafts)
  const diagnosticRun = selectedSweep === null
    ? selectedRun?.valid && !selectedRun.cancelled
      ? selectedRun
      : validRuns[0] ?? null
    : selectedRun?.valid && !selectedRun.cancelled && runBelongsToSweep(selectedRun, selectedSweep)
      ? selectedRun
      : validRuns.find((run) => runBelongsToSweep(run, selectedSweep)) ?? null

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
            {selectedSweep && (
              <div className="mt-3 flex flex-col gap-2 rounded-lg border border-line bg-panel-2/60 p-3 sm:flex-row sm:items-end">
                <label className="min-w-0 flex-1 text-xs text-dim">
                  当前 Sweep（图表、Pareto、饱和点与 Sweep 诊断严格隔离）
                  <select
                    value={selectedSweep.key}
                    onChange={(event) => {
                      const group = sweepGroups.find((candidate) => candidate.key === event.target.value)
                      if (!group) return
                      selectSweep(group.key)
                      const firstRun = validRuns.find((run) => runBelongsToSweep(run, group))
                      if (firstRun) selectRun(firstRun.key)
                    }}
                    className={inputClass}
                  >
                    {sweepGroups.map((group) => (
                      <option key={group.key} value={group.key}>{group.label}（{group.points.length} 点）</option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-wrap gap-2 pb-1">
                  <StatusBadge tone="measured">当前组 {selectedSweep.points.length} 点</StatusBadge>
                  {sweepGroups.length > 1 && <StatusBadge tone="warn">共 {sweepGroups.length} 组 · 不跨组连线</StatusBadge>}
                </div>
              </div>
            )}
            <div className="mt-3 flex max-w-full gap-2 overflow-x-auto pb-1">
              {batch.runs.map((run) => (
                <button
                  key={run.key}
                  type="button"
                  onClick={() => {
                    selectRun(run.key)
                    const group = sweepGroups.find((candidate) => runBelongsToSweep(run, candidate))
                    if (group) selectSweep(group.key)
                  }}
                  aria-pressed={run.key === selectedRun?.key}
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
              <E2eCrossCheck run={selectedRun} />
              {!hasMetric(selectedRun.metrics, 'goodput') && (
                <div className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm leading-relaxed">
                  <span className="font-semibold text-warn">Goodput：N/A。</span>{' '}
                  当前文件没有可用且单位明确的 AIPerf 联合 SLO 请求速率。请带 <code className="rounded bg-panel px-1 py-0.5 font-mono text-xs">--goodput</code>{' '}
                  重新运行；页面不会把 TTFT / TPOT / E2E 的多个 p95 条件拼成伪 Goodput，也不会在此修改 SLO 后重算。
                </div>
              )}
              <MetadataForm
                run={selectedRun}
                required={selectedRun.sourceNames.some((name) => batch.artifacts.find((artifact) => artifact.name === name)?.metadataRequired)}
              />
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
                    <LineChart data={chartPoints} margin={{ top: 8, right: 10, left: 4, bottom: 12 }}>
                      <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="x" type="number" stroke={DIM} tick={{ fill: DIM, fontSize: 11 }} label={{ value: xLabel, position: 'insideBottomRight', offset: -7, fill: DIM, fontSize: 10 }} />
                      <YAxis yAxisId="tps" stroke={ACCENT} tick={{ fill: DIM, fontSize: 11 }} width={54} />
                      <YAxis yAxisId="rps" orientation="right" stroke={GREEN} tick={{ fill: DIM, fontSize: 11 }} width={36} />
                      <Tooltip contentStyle={{ background: '#fff', border: `1px solid ${GRID}`, borderRadius: 8, fontSize: 12 }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {saturation && <ReferenceLine yAxisId="tps" x={saturation.x} stroke={AMBER} strokeDasharray="4 4" label={{ value: '饱和', fill: AMBER, fontSize: 10 }} />}
                      <Line yAxisId="tps" type="monotone" dataKey="systemTps" name="系统输出 TPS（左轴）" stroke={ACCENT} strokeWidth={2} connectNulls={false} isAnimationActive={false} />
                      <Line yAxisId="rps" type="monotone" dataKey="rps" name="RPS（右轴）" stroke={PURPLE} strokeWidth={2} connectNulls={false} isAnimationActive={false} />
                      <Line yAxisId="rps" type="monotone" dataKey="goodput" name="Goodput RPS（右轴）" stroke={GREEN} strokeWidth={2} connectNulls={false} isAnimationActive={false} />
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
                    <LineChart data={chartPoints} margin={{ top: 8, right: 10, left: 4, bottom: 12 }}>
                      <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="x" type="number" stroke={DIM} tick={{ fill: DIM, fontSize: 11 }} label={{ value: xLabel, position: 'insideBottomRight', offset: -7, fill: DIM, fontSize: 10 }} />
                      <YAxis yAxisId="latency" stroke={PURPLE} tick={{ fill: DIM, fontSize: 11 }} width={54} />
                      <YAxis yAxisId="tpot" orientation="right" stroke={GREEN} tick={{ fill: DIM, fontSize: 11 }} width={36} />
                      <Tooltip contentStyle={{ background: '#fff', border: `1px solid ${GRID}`, borderRadius: 8, fontSize: 12 }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {slo.e2eMs !== null && <ReferenceLine yAxisId="latency" y={slo.e2eMs} stroke={ACCENT} strokeDasharray="5 4" label={{ value: 'E2E SLO', fill: ACCENT, fontSize: 10 }} />}
                      {slo.ttftMs !== null && <ReferenceLine yAxisId="latency" y={slo.ttftMs} stroke={AMBER} strokeDasharray="5 4" label={{ value: 'TTFT SLO', fill: AMBER, fontSize: 10 }} />}
                      {slo.tpotMs !== null && <ReferenceLine yAxisId="tpot" y={slo.tpotMs} stroke={GREEN} strokeDasharray="5 4" label={{ value: 'TPOT SLO', fill: GREEN, fontSize: 10 }} />}
                      <Line yAxisId="latency" type="monotone" dataKey="ttftP95" name="TTFT p95（左轴）" stroke={AMBER} strokeWidth={2} connectNulls={false} isAnimationActive={false} />
                      <Line yAxisId="tpot" type="monotone" dataKey="tpotP95" name="TPOT p95（右轴）" stroke={GREEN} strokeWidth={2} connectNulls={false} isAnimationActive={false} />
                      <Line yAxisId="latency" type="monotone" dataKey="e2eP95" name="E2E p95（左轴）" stroke={PURPLE} strokeWidth={2} connectNulls={false} isAnimationActive={false} />
                      <Line yAxisId="latency" type="monotone" dataKey="e2eP99" name="E2E p99（左轴）" stroke={ACCENT} strokeWidth={2} connectNulls={false} isAnimationActive={false} />
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
                    const passes = slo.attainment !== null && point.goodFraction !== null && point.goodFraction >= slo.attainment
                    return passes ? <StatusBadge key={`slo-${point.key}`} tone="target">导入 SLO 可行 · {point.x}（达标率 {(point.goodFraction! * 100).toFixed(1)}%）</StatusBadge> : null
                  })}
                  {slo.attainment === null && (
                    <StatusBadge tone="warn">SLO 可行区未验证：请显式填写最低逐请求达标率</StatusBadge>
                  )}
                  {slo.attainment !== null && chartPoints.every((point) => point.goodFraction === null) && (
                    <StatusBadge tone="warn">SLO 可行区未验证：缺少 good_request_fraction</StatusBadge>
                  )}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-dim">“导入 SLO 可行”仅相对原 run 的 <code className="font-mono">--goodput</code> 联合阈值与当前最低达标率；页面修改 TTFT/TPOT/E2E 只叠加参考线，不会重算 Goodput。</p>
              </Panel>
            </div>
          ) : (
            <EmptyState title={selectedSweepPoints.length > 0 ? '当前 Sweep 为多维，暂不混线' : '当前导入没有 Sweep 点'}>
              {selectedSweepPoints.length > 0
                ? '该 Sweep 同时变化了多个坐标。为避免把不同 workload 连成一条伪曲线，请先在 AIPerf 中固定其余维度或导出单轴切片。'
                : '单次 profile 仍可查看实测摘要；导入 sweep aggregate 才能分析饱和与 Pareto 前沿。'}
            </EmptyState>
          )}

          <Panel>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">运行可比性保护</h3>
              <StatusBadge tone={comparison.comparable ? 'ok' : comparison.singleRun ? 'neutral' : 'warn'}>
                {comparison.comparable ? '✓ 可下比较结论' : comparison.singleRun ? '单个 run · 无对比对象' : '△ 不下比较结论'}
              </StatusBadge>
            </div>
            {comparison.comparable ? (
              <p className="mt-2 text-xs leading-relaxed text-dim">所有有效 run 的模型、量化、ISL/OSL、硬件拓扑、引擎版本、负载模式与 SLO 均一致。</p>
            ) : comparison.singleRun ? (
              <p className="mt-2 text-xs leading-relaxed text-dim">当前只有一个有效 run，没有可比较对象；再导入同口径 run 后这里会逐项核对可比性。</p>
            ) : (
              <ul className="mt-2 grid gap-1 text-xs leading-relaxed text-dim sm:grid-cols-2">
                {comparison.reasons.map((reason) => <li key={reason.id}>△ {reason.text}</li>)}
              </ul>
            )}
          </Panel>

          <DiagnosticsPanel run={diagnosticRun} chartPoints={chartPoints} sweepLabel={selectedSweep?.label ?? null} />
        </>
      )}
    </div>
  )
}

function DiagnosticsPanel({
  run,
  chartPoints,
  sweepLabel,
}: {
  run: NormalizedBenchmarkRun | null
  chartPoints: ReturnType<typeof toSweepChartPoints>
  sweepLabel: string | null
}) {
  // hook 订阅而非 getState()：SLO / 预期命中率变化时诊断区必须实时重算
  const slo = useInferenceScenario((state) => state.slo)
  const expectedPrefixHitRate = useInferenceScenario((state) => state.expectedPrefixHitRate)
  const setExpectedPrefixHitRate = useInferenceScenario((state) => state.setExpectedPrefixHitRate)
  const metrics = run
    ? {
        ...run.metrics,
        ...Object.fromEntries(run.serverMetrics.map((metric, index) => [`server-${metric.seriesKey ?? metric.name}-${index}`, metric])),
      }
    : {}
  type AggregateReading = { value: number; unit: string }
  const aggregate = (
    alias: MetricAlias,
    mode: 'mean' | 'min' | 'max',
    read: (metric: NormalizedMetric) => AggregateReading | null = (metric) => {
      const value = metricValue(metric)
      return value === null || !metric.unit.trim() ? null : { value, unit: metric.unit.trim().toLowerCase() }
    },
  ): NormalizedMetric | undefined => {
    const matches = findMetrics(metrics, alias)
    const rows = matches.flatMap((metric) => {
      const reading = read(metric)
      return reading === null ? [] : [{ metric, ...reading }]
    })
    if (rows.length === 0) return undefined
    if (new Set(rows.map((row) => row.unit)).size > 1) return undefined
    const values = rows.map((row) => row.value)
    const value = mode === 'min'
      ? Math.min(...values)
      : mode === 'max'
        ? Math.max(...values)
        : values.reduce((sum, current) => sum + current, 0) / values.length
    const first = rows[0].metric
    return {
      ...first,
      name: `${alias}_${mode}_across_series`,
      unit: rows[0].unit,
      stats: { mean: value },
      labels: { aggregation: `${mode} across ${rows.length} series` },
    }
  }
  const readPercent = (metric: NormalizedMetric): AggregateReading | null => {
    const fraction = fractionValue(metric)
    return fraction === null ? null : { value: fraction * 100, unit: '%' }
  }
  const readP95Ms = (metric: NormalizedMetric): AggregateReading | null => {
    const value = latencyPercentileMs(metric, 'p95')
    return value === null ? null : { value, unit: 'ms' }
  }
  const gpuUtilMetric = aggregate('gpuUtil', 'mean', readPercent)
  const memoryUtilMetric = aggregate('memoryUtil', 'max', readPercent)
  const kvUtilMetric = aggregate('kvUtil', 'max', readPercent)
  const cacheHitMetric = aggregate('cacheHit', 'min', readPercent)
  const queueTimeMetric = aggregate('queueTime', 'max', readP95Ms)
  const queueDepthMetric = aggregate('queueDepth', 'max')
  const preemptionMetrics = findMetrics(metrics, 'preemption')
  const metricRows: { label: string; metric?: NormalizedMetric; warning: string }[] = [
    { label: 'TTFT', metric: findMetric(metrics, 'ttft'), warning: '高 TTFT 常见于 prefill 算力、排队或冷启动。' },
    { label: 'TPOT', metric: findMetric(metrics, 'tpot'), warning: '高 TPOT 常见于 decode 带宽、batch 干扰或抢占。' },
    { label: '排队', metric: queueTimeMetric ?? queueDepthMetric, warning: '队列增长而吞吐不再上升，是容量饱和信号。' },
    { label: 'GPU 利用率（跨卡均值）', metric: gpuUtilMetric, warning: '低利用率要结合队列、batch 与通信判断，不能单指标归因。' },
    { label: '显存 / KV 压力（跨卡最高）', metric: kvUtilMetric ?? memoryUtilMetric, warning: '接近上限时检查 KV 水位、抢占与缓存块碎片。' },
    { label: '缓存命中（跨实例最低）', metric: cacheHitMetric, warning: '命中率低时检查前缀稳定性与 KV-cache 感知路由。' },
  ]
  const isUsableEvidence = (metric: NormalizedMetric | undefined) =>
    Boolean(metric && metric.available !== false && metric.unit.trim() && metricValue(metric) !== null)
  const available = metricRows.filter((row) => isUsableEvidence(row.metric))
  const hasSweepEvidence = chartPoints.some((point) =>
    point.systemTps !== null ||
    point.rps !== null ||
    point.goodput !== null ||
    point.ttftP95 !== null ||
    point.tpotP95 !== null ||
    point.e2eP95 !== null,
  )
  const hasMeasuredEvidence = available.length > 0 || hasSweepEvidence
  const evidenceLabel = available.length > 0 && hasSweepEvidence
    ? `${available.length} 类资源 / 体验证据 + Sweep 曲线`
    : available.length > 0
      ? `${available.length} 类实测证据`
      : hasSweepEvidence
        ? 'Sweep 曲线实测证据'
        : '证据不足'
  const percentage = (metric: NormalizedMetric | undefined) => {
    const fraction = fractionValue(metric)
    return fraction === null ? null : fraction * 100
  }
  // 窗口速率与窗口计数的甄别（含 *_total counter 抑制）统一走 preemptionEvidence，取值口径不在组件里复制。
  const preemption = preemptionEvidence(preemptionMetrics)
  const findings = diagnoseInference({
    ttftP95Ms: observed(latencyStatisticMs(metrics, 'ttft', 'p95')),
    ttftTargetMs: slo.ttftMs,
    tpotP95Ms: observed(latencyStatisticMs(metrics, 'tpot', 'p95')),
    tpotTargetMs: slo.tpotMs,
    e2eLatencyP95Ms: observed(latencyStatisticMs(metrics, 'e2e', 'p95')),
    e2eTargetMs: slo.e2eMs,
    queueTimeP95Ms: observed(metricValue(queueTimeMetric)),
    queuedRequests: observed(metricValue(queueDepthMetric)),
    kvCacheUtilizationPct: observed(percentage(kvUtilMetric)),
    preemptionRatePerSecond: observed(preemption.ratePerSecond),
    preemptionCountInWindow: observed(preemption.countInWindow),
    prefixCacheHitRatePct: observed(percentage(cacheHitMetric)),
    // 场景 cacheRate 是估算假设，不能自动当诊断预期；只有用户显式设置的预期命中率才参与比对。
    expectedPrefixCacheHitRatePct:
      expectedPrefixHitRate === null ? null : observed(expectedPrefixHitRate * 100, 'target'),
    gpuUtilizationPct: observed(percentage(gpuUtilMetric)),
    gpuMemoryUtilizationPct: observed(percentage(memoryUtilMetric)),
    rps: observed(requestRatePerSecond(findMetric(metrics, 'rps'))),
    systemOutputTps: observed(tokenRatePerSecond(findMetric(metrics, 'systemTps'))),
    goodputRps: observed(requestRatePerSecond(findMetric(metrics, 'goodput'))),
    goodRequestFraction: observed(fractionValue(findMetric(metrics, 'goodFraction'))),
    goodRequestFractionTarget: slo.attainment,
    sweepPoints: chartPoints.map(toSweepDiagnosticPoint),
  })
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">瓶颈诊断证据</h3>
          <p className="mt-1 text-[11px] text-dim">
            先列证据，再给原因与下一步；缺少 server metrics 时不猜测。{sweepLabel ? `当前 Sweep：${sweepLabel}。` : ''}
          </p>
        </div>
        <StatusBadge tone={hasMeasuredEvidence ? 'measured' : 'neutral'}>{evidenceLabel}</StatusBadge>
      </div>
      <label className="mt-3 block max-w-xs text-xs text-dim">
        预期前缀缓存命中率（可选，%）
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          value={expectedPrefixHitRate === null ? '' : percentValue(expectedPrefixHitRate)}
          placeholder="空 = 不启用该规则"
          onChange={(event) => {
            const raw = event.target.value.trim()
            if (raw === '') {
              setExpectedPrefixHitRate(null)
              return
            }
            const parsed = Number(raw)
            if (Number.isFinite(parsed)) setExpectedPrefixHitRate(parsed / 100)
          }}
          className={inputClass}
        />
        <span className="mt-1 block text-[10px] leading-snug">
          场景估算用的缓存命中率不会自动当诊断预期；显式填写后才启用命中率缺口（cache-hit-gap）比对。
        </span>
      </label>
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
