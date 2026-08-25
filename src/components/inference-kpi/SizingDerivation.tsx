import { useMemo, useState } from 'react'
import { MODELS } from '../../data/models'
import { GPUS } from '../../data/hardware'
import { QUANTS } from '../../lib/simEngine'
import { calculateSizing, littleLawConcurrency, requiredSystemOutputTps } from '../../lib/kpiEngine'
import { useInferenceScenario, type QuantId } from '../../store'
import { EmptyState, MetricTile, Panel, StatusBadge, inputClass } from './KpiPrimitives'
import { useKpiUiStore } from './kpiUiStore'
import { findMetric, formatMetric, fractionValue, requestRatePerSecond } from './metricUi'

type JumpTarget = 'atlas' | 'lifecycle' | 'memory' | 'economics'

export interface SizingDerivationProps {
  onJumpTo: (target: JumpTarget) => void
}

const nullableNumber = (value: string): number | null => {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const resultTone = (basis: string) => basis === 'measured-goodput' ? 'measured' : basis === 'estimated-throughput' ? 'estimated' : 'neutral'

export default function SizingDerivation({ onJumpTo }: SizingDerivationProps) {
  const scenario = useInferenceScenario()
  const batch = useKpiUiStore((state) => state.batch)
  const selectedRunKey = useKpiUiStore((state) => state.selectedRunKey)
  const requestedRun = batch?.runs.find((candidate) => candidate.key === selectedRunKey)
  const run = requestedRun?.valid && !requestedRun.cancelled
    ? requestedRun
    : batch?.runs.find((candidate) => candidate.valid && !candidate.cancelled) ?? null
  const measuredGoodput = requestRatePerSecond(findMetric(run?.metrics, 'goodput'))
  const goodFraction = fractionValue(findMetric(run?.metrics, 'goodFraction'))
  const [confirmedMeasurementKey, setConfirmedMeasurementKey] = useState<string | null>(null)
  const estimatedRpsPerUnit = scenario.outputTokens > 0 ? scenario.systemTps / scenario.outputTokens : null
  const targetGoodRps = scenario.peakRps
  const hasExperienceSlo = scenario.slo.ttftMs !== null || scenario.slo.tpotMs !== null || scenario.slo.e2eMs !== null
  const attainmentVerified = goodFraction !== null && goodFraction >= scenario.slo.attainment
  // 任一场景口径变更都会自动使人工确认失效，避免拿旧 run 套新场景。
  const measurementKey = run
    ? JSON.stringify([
        run.key,
        scenario.modelId,
        scenario.gpuId,
        scenario.quantId,
        scenario.inputTokens,
        scenario.outputTokens,
        scenario.gpusPerCapacityUnit,
        scenario.slo,
      ])
    : null
  const measurementConfirmed = measurementKey !== null && confirmedMeasurementKey === measurementKey
  const measuredSizingEligible =
    measuredGoodput !== null && hasExperienceSlo && attainmentVerified && measurementConfirmed
  const sizingMeasuredGoodput = measuredSizingEligible ? measuredGoodput : null
  const sizing = useMemo(
    () => calculateSizing({
      measuredGoodputRpsPerUnit: sizingMeasuredGoodput,
      estimatedRpsPerUnit,
      targetGoodRps,
      headroom: scenario.headroom,
      spareUnits: scenario.spareUnits,
      gpusPerUnit: scenario.gpusPerCapacityUnit,
      topology: {
        gpusPerServer: scenario.gpusPerServer,
        serversPerRack: scenario.serversPerRack,
      },
    }),
    [
      sizingMeasuredGoodput,
      estimatedRpsPerUnit,
      targetGoodRps,
      scenario.headroom,
      scenario.spareUnits,
      scenario.gpusPerCapacityUnit,
      scenario.gpusPerServer,
      scenario.serversPerRack,
    ],
  )
  const requiredTps = requiredSystemOutputTps(scenario.peakRps, scenario.outputTokens)
  const concurrencyCheck = scenario.slo.e2eMs === null ? null : littleLawConcurrency(scenario.peakRps, scenario.slo.e2eMs)
  const costPerMTok = scenario.systemTps > 0 && scenario.utilization > 0
    ? (scenario.hourlyCost / (scenario.systemTps * 3600 * scenario.utilization)) * 1_000_000
    : null
  const goodRequestCost = sizingMeasuredGoodput && sizingMeasuredGoodput > 0
    ? scenario.hourlyCost / (sizingMeasuredGoodput * 3600)
    : null

  return (
    <div className="min-w-0 space-y-4">
      <Panel>
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <h3 className="text-base font-bold">场景输入</h3>
            <p className="mt-1 text-xs leading-relaxed text-dim">与架构图谱、Prompt 生命周期、显存墙和 Token 经济共享同一份会话状态。</p>
          </div>
          <StatusBadge tone="target">目标值 / 场景假设</StatusBadge>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <label className="text-xs text-dim">
            模型
            <select value={scenario.modelId} onChange={(event) => scenario.setModelId(event.target.value)} className={inputClass}>
              {MODELS.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-dim">
            GPU
            <select value={scenario.gpuId} onChange={(event) => scenario.setGpuId(event.target.value)} className={inputClass}>
              {GPUS.map((gpu) => <option key={gpu.id} value={gpu.id}>{gpu.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-dim">
            量化
            <select value={scenario.quantId} onChange={(event) => scenario.setQuantId(event.target.value as QuantId)} className={inputClass}>
              {QUANTS.map((quant) => <option key={quant.id} value={quant.id}>{quant.label}</option>)}
            </select>
          </label>
          <NumberField label="输入长度 ISL" value={scenario.inputTokens} unit="token" min={1} onChange={scenario.setInputTokens} />
          <NumberField label="输出长度 OSL" value={scenario.outputTokens} unit="token" min={1} onChange={scenario.setOutputTokens} />
          <NumberField label="峰值 Good RPS 目标" value={scenario.peakRps} unit="req/s" min={0} step={0.1} onChange={scenario.setPeakRps} />
          <NumberField label="并发度" value={scenario.concurrency} unit="request" min={1} onChange={scenario.setConcurrency} />
          <NumberField label="当前系统输出 TPS" value={scenario.systemTps} unit="tok/s" min={1} onChange={scenario.setSystemTps} />
          <NumberField label="容量单元 GPU 数" value={scenario.gpusPerCapacityUnit} unit="GPU" min={1} onChange={scenario.setGpusPerCapacityUnit} />
          <NumberField label="容量余量" value={scenario.headroom * 100} unit="%" min={0} max={100} step={1} onChange={(value) => scenario.setHeadroom(value / 100)} />
          <NumberField label="冗余单元" value={scenario.spareUnits} unit="unit" min={0} onChange={scenario.setSpareUnits} />
          <NumberField label="容量单元时成本" value={scenario.hourlyCost} unit="USD/h" min={0} step={0.1} onChange={scenario.setHourlyCost} />
        </div>
      </Panel>

      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">体验 SLO</h3>
            <p className="mt-1 text-[11px] text-dim">不提供通用默认值；空白表示当前客户场景尚未定义该目标。</p>
          </div>
          <StatusBadge tone="target">客户目标</StatusBadge>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <NullableField label="TTFT p95" value={scenario.slo.ttftMs} unit="ms" onChange={(value) => scenario.setSlo({ ttftMs: value })} />
          <NullableField label="TPOT p95" value={scenario.slo.tpotMs} unit="ms/token" onChange={(value) => scenario.setSlo({ tpotMs: value })} />
          <NullableField label="E2E p95" value={scenario.slo.e2eMs} unit="ms" onChange={(value) => scenario.setSlo({ e2eMs: value })} />
          <NumberField label="最低逐请求达标率" value={scenario.slo.attainment * 100} unit="%" min={0} max={100} step={1} onChange={(value) => scenario.setSlo({ attainment: value / 100 })} />
        </div>
      </Panel>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="目标系统输出 TPS"
          value={formatMetric(requiredTps, 'tok/s')}
          badge={<StatusBadge tone="estimated">公式估算</StatusBadge>}
          note="峰值 RPS × 每请求输出 token；这是容量需求，不是 Benchmark 结果。"
        />
        <MetricTile
          label="Little’s Law 并发校验"
          value={formatMetric(concurrencyCheck, 'request')}
          badge={<StatusBadge tone="estimated">公式估算</StatusBadge>}
          note={scenario.slo.e2eMs === null ? '需先填写 E2E SLO。' : `输入并发 ${scenario.concurrency}；估算仅适用于稳态窗口。`}
        />
        <MetricTile
          label="实测单元 Goodput"
          value={formatMetric(measuredGoodput, 'req/s')}
          badge={<StatusBadge tone={measuredGoodput === null ? 'neutral' : 'measured'}>{measuredGoodput === null ? 'N/A' : 'AIPerf 实测'}</StatusBadge>}
          note={measuredGoodput === null ? '未导入带 --goodput 的有效 run。' : attainmentVerified ? `逐请求达标率 ${(goodFraction! * 100).toFixed(1)}%，达到目标。` : 'Goodput 已实测，但缺少或未达到当前 attainment gate。'}
        />
        <MetricTile
          label="方向性单元 RPS"
          value={formatMetric(estimatedRpsPerUnit, 'req/s')}
          badge={<StatusBadge tone="estimated">未验证 SLO</StatusBadge>}
          note="当前系统输出 TPS ÷ OSL；只在缺少 Goodput 时作为方向性估算。"
        />
      </div>

      {measuredGoodput !== null && (
        <Panel className={measuredSizingEligible ? 'border-ok/30 bg-ok/5' : 'border-warn/30 bg-warn/5'}>
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">实测 Goodput 适用性门禁</h3>
              <p className="mt-1 text-xs leading-relaxed text-dim">
                页面不会因修改 SLO 而重算 Goodput。只有导入 run 的模型、量化、ISL/OSL、引擎/版本、负载模式、
                GPU 拓扑与 <code className="rounded bg-panel px-1 font-mono text-[11px]">--goodput</code> 约束都与当前场景一致时，才能用于 Sizing。
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <StatusBadge tone={hasExperienceSlo ? 'ok' : 'warn'}>{hasExperienceSlo ? '已设体验 SLO' : '缺体验 SLO'}</StatusBadge>
                <StatusBadge tone={attainmentVerified ? 'ok' : 'warn'}>
                  {goodFraction === null
                    ? '缺 good_request_fraction'
                    : `达标率 ${(goodFraction * 100).toFixed(1)}% ${attainmentVerified ? '通过' : '未通过'}`}
                </StatusBadge>
                <StatusBadge tone={measurementConfirmed ? 'ok' : 'warn'}>{measurementConfirmed ? '口径已确认' : '待确认 run 口径'}</StatusBadge>
              </div>
            </div>
            <label className="flex min-h-11 max-w-md cursor-pointer items-start gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-xs leading-relaxed">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                checked={measurementConfirmed}
                disabled={!hasExperienceSlo || !attainmentVerified || measurementKey === null}
                onChange={(event) => setConfirmedMeasurementKey(event.target.checked ? measurementKey : null)}
              />
              <span>我已核对导入 run 与当前场景完全可比，且该 run 的部署单元恰为 {scenario.gpusPerCapacityUnit} GPU。</span>
            </label>
          </div>
        </Panel>
      )}

      <Panel className={sizing.basis === 'measured-goodput' ? 'border-ok/30' : 'border-warn/30'}>
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <h3 className="text-base font-bold">Sizing 推导结果</h3>
            <p className="mt-1 text-xs leading-relaxed text-dim">
              ceil(目标 Good RPS × {`(1 + ${Math.round(scenario.headroom * 100)}%)`} ÷ 单元容量) + {scenario.spareUnits} 个冗余单元
            </p>
          </div>
          <StatusBadge tone={resultTone(sizing.basis)}>
            {sizing.basis === 'measured-goodput' ? '实测 Goodput 基线' : sizing.basis === 'estimated-throughput' ? '方向性估算 · 未验证 SLO' : '容量基线不可用'}
          </StatusBadge>
        </div>

        {sizing.totalUnits === null ? (
          <div className="mt-4"><EmptyState title="暂时无法计算卡数">需要正数的目标 Good RPS，以及实测 Goodput 或可用的方向性 RPS 基线。</EmptyState></div>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <MetricTile label="需求单元" value={sizing.baseUnits ?? 'N/A'} badge={<StatusBadge tone={resultTone(sizing.basis)}>含余量</StatusBadge>} />
            <MetricTile label="总容量单元" value={sizing.totalUnits} note={`含 ${sizing.spareUnits} 个冗余单元`} />
            <MetricTile label="GPU 数" value={sizing.gpuCount ?? 'N/A'} note={`${scenario.gpusPerCapacityUnit} GPU / 容量单元`} />
            <MetricTile label="服务器数" value={sizing.serverCount ?? 'N/A'} badge={<StatusBadge tone={sizing.serverCount === null ? 'warn' : 'neutral'}>{sizing.serverCount === null ? '缺拓扑' : '显式拓扑'}</StatusBadge>} />
            <MetricTile label="机架数" value={sizing.rackCount ?? 'N/A'} badge={<StatusBadge tone={sizing.rackCount === null ? 'warn' : 'neutral'}>{sizing.rackCount === null ? '缺拓扑' : '显式拓扑'}</StatusBadge>} />
          </div>
        )}
        <p className="mt-3 rounded-lg border border-line bg-panel-2/60 p-3 text-xs leading-relaxed text-dim">{sizing.note}</p>
      </Panel>

      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">服务器与机架拓扑</h3>
            <p className="mt-1 text-[11px] text-dim">必须明确填写；系统不会暗设“8 卡服务器”或“若干服务器/机架”。</p>
          </div>
          <StatusBadge tone={scenario.gpusPerServer !== null && scenario.serversPerRack !== null ? 'ok' : 'warn'}>
            {scenario.gpusPerServer !== null && scenario.serversPerRack !== null ? '拓扑已提供' : 'N/A 保护中'}
          </StatusBadge>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <NullableField label="每服务器 GPU 数" value={scenario.gpusPerServer} unit="GPU/server" integer onChange={scenario.setGpusPerServer} />
          <NullableField label="每机架服务器数" value={scenario.serversPerRack} unit="server/rack" integer onChange={scenario.setServersPerRack} />
          <NumberField label="有效利用率" value={scenario.utilization * 100} unit="%" min={1} max={99} onChange={(value) => scenario.setUtilization(value / 100)} />
          <div className="rounded-lg border border-line bg-panel-2/50 p-3 text-xs leading-relaxed text-dim">
            拓扑来源需要在正式方案中记录。机架数之外还要单独核对网络、供电、散热与 NVLink 域边界。
          </div>
        </div>
      </Panel>

      <div className="grid gap-3 md:grid-cols-2">
        <MetricTile
          label="每百万输出 Token 成本"
          value={costPerMTok === null ? 'N/A' : `$${costPerMTok.toFixed(2)}`}
          badge={<StatusBadge tone="estimated">成本假设</StatusBadge>}
          note="容量单元 $/h ÷（系统输出 TPS × 3600 × 有效利用率）× 10⁶。"
        />
        <MetricTile
          label="每个达标请求成本"
          value={goodRequestCost === null ? 'N/A' : `$${goodRequestCost.toFixed(5)}`}
          badge={<StatusBadge tone={goodRequestCost === null ? 'neutral' : 'measured'}>{goodRequestCost === null ? '缺 Goodput' : '实测容量 + 成本假设'}</StatusBadge>}
          note="容量单元 $/h ÷（实测 Goodput × 3600）；Goodput 缺失时不计算。"
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <button type="button" onClick={() => onJumpTo('memory')} className="min-h-11 rounded-lg border border-line bg-panel px-3 text-sm font-semibold shadow-sm hover:border-accent/50">去显存墙验证 GPU →</button>
        <button
          type="button"
          disabled={sizing.gpuCount === null}
          onClick={() => {
            if (sizing.gpuCount === null) return
            const hourlyCostPerGpu = scenario.hourlyCost / scenario.gpuCount
            scenario.setGpuCount(sizing.gpuCount)
            scenario.setHourlyCost(hourlyCostPerGpu * sizing.gpuCount)
            onJumpTo('economics')
          }}
          className="min-h-11 rounded-lg border border-line bg-panel px-3 text-sm font-semibold shadow-sm hover:border-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sizing.gpuCount === null ? '卡数不可用，暂不能应用成本 →' : `应用 ${sizing.gpuCount} GPU 与同单卡成本 →`}
        </button>
        <button type="button" onClick={() => onJumpTo('atlas')} className="min-h-11 rounded-lg border border-line bg-panel px-3 text-sm font-semibold shadow-sm hover:border-accent/50">去架构图谱核对拓扑 →</button>
      </div>
    </div>
  )
}

function NumberField({
  label,
  value,
  unit,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string
  value: number
  unit: string
  min?: number
  max?: number
  step?: number
  onChange: (value: number) => void
}) {
  return (
    <label className="min-w-0 text-xs text-dim">
      {label} <span className="font-mono text-[10px]">({unit})</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const parsed = Number(event.target.value)
          if (Number.isFinite(parsed)) onChange(parsed)
        }}
        className={inputClass}
      />
    </label>
  )
}

function NullableField({
  label,
  value,
  unit,
  integer = false,
  onChange,
}: {
  label: string
  value: number | null
  unit: string
  integer?: boolean
  onChange: (value: number | null) => void
}) {
  return (
    <label className="min-w-0 text-xs text-dim">
      {label} <span className="font-mono text-[10px]">({unit})</span>
      <input
        type="number"
        min={0}
        step={integer ? 1 : 0.1}
        value={value ?? ''}
        placeholder="未设置"
        onChange={(event) => {
          const parsed = nullableNumber(event.target.value)
          onChange(parsed === null ? null : integer ? Math.round(parsed) : parsed)
        }}
        className={inputClass}
      />
    </label>
  )
}
