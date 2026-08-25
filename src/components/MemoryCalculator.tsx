import { useEffect, useMemo } from 'react'
import { MODELS } from '../data/models'
import { GPUS, RACKS } from '../data/hardware'
import {
  QUANTS,
  estStepMs,
  estTTFTms,
  kvBytesPerToken,
  memoryBreakdown,
  minGpus,
  tflopsForQuant,
  tokensPerSecond,
} from '../lib/simEngine'
import { useInferenceParams, type QuantId } from '../store'

export default function MemoryCalculator() {
  // 上下文长度也进入统一场景：KPI 工作台、显存墙和生命周期始终用同一口径。
  const {
    modelId,
    gpuId,
    quantId,
    batch,
    inputTokens,
    outputTokens,
    setModelId,
    setGpuId,
    setQuantId,
    setBatch,
    setInputTokens,
    setOutputTokens,
    setSystemTps,
  } = useInferenceParams()

  const model = MODELS.find((m) => m.id === modelId)!
  const gpu = GPUS.find((g) => g.id === gpuId)!
  const quant = QUANTS.find((q) => q.id === quantId)!
  // KV 容量覆盖 prefill 后的整段序列；TTFT 则只与输入 prefill 长度相关。
  const contextTokens = inputTokens + outputTokens
  const contextLabel = contextTokens >= 1_000_000 ? `${(contextTokens / 1_000_000).toFixed(1)}M` : `${(contextTokens / 1000).toFixed(contextTokens % 1000 ? 1 : 0)}K`

  const r = useMemo(() => {
    const bd = memoryBreakdown(model.totalParamsB, quant.bytesPerParam, model.kvSpec, contextTokens, batch)
    const unsupported = model.kvSpec.kind === 'unsupported'
    // 无 KV 公式时给「权重下限」估卡数，并明确标注
    const baseGB = bd.totalGB ?? bd.weightsGB + bd.overheadGB
    const gpus = minGpus(baseGB, gpu.memoryGB)
    // 量化对应算力口径：仅 INT4/FP4 且该卡有官方 FP4 值时切换，否则回退 FP8 并在下方标注
    const cap = tflopsForQuant(gpu, quant.id)
    const ttft = estTTFTms(model.activeParamsB, inputTokens, cap.tflops, gpus)
    const stepMs = estStepMs(
      model.activeParamsB,
      quant.bytesPerParam,
      kvBytesPerToken(model.kvSpec),
      contextTokens,
      batch,
      gpu.bandwidthTBs,
      gpus,
    )
    return { bd, unsupported, baseGB, gpus, ttft, ttftBasis: cap.basis, stepMs, tps: tokensPerSecond(stepMs, batch) }
  }, [model, gpu, quant, inputTokens, contextTokens, batch])

  useEffect(() => setSystemTps(r.tps), [r.tps, setSystemTps])

  // 分段先给 2% 可见性下限，再整体归一化——三段之和恒为 100%，不会溢出
  const segs = (defs: { gb: number; color: string; label: string }[]) => {
    const floored = defs.map((d) => Math.max(2, (d.gb / r.baseGB) * 100))
    const sum = floored.reduce((a, b) => a + b, 0)
    return defs.map((d, i) => (
      <div
        key={d.label}
        className={`${d.color} flex items-center justify-center overflow-hidden rounded px-1 text-[11px] font-medium whitespace-nowrap text-white`}
        style={{ width: `${(floored[i] / sum) * 100}%` }}
        title={`${d.label} ${d.gb.toFixed(1)} GB`}
      >
        {d.label} {d.gb.toFixed(0)}G
      </div>
    ))
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-xl border border-line bg-panel shadow-sm p-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <label className="block text-xs text-dim">
          模型
          <select value={modelId} onChange={(e) => setModelId(e.target.value)} className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg">
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}{m.kvSpec.kind === 'unsupported' ? '（KV 不可估）' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-dim">
          GPU
          <select value={gpuId} onChange={(e) => setGpuId(e.target.value)} className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg">
            {GPUS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}（{g.memoryGB}GB / {g.bandwidthTBs}TB/s）
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-dim">
          量化
          <select value={quantId} onChange={(e) => setQuantId(e.target.value as QuantId)} className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg">
            {QUANTS.map((q) => (
              <option key={q.id} value={q.id}>
                {q.label}（{q.bytesPerParam} B/参数）
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-dim">
          输入长度 ISL
          <input
            type="number"
            min={1}
            max={1_000_000}
            step={1000}
            value={inputTokens}
            onChange={(e) => setInputTokens(Number(e.target.value))}
            className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg"
          />
        </label>
        <label className="block text-xs text-dim">
          输出长度 OSL
          <input
            type="number"
            min={1}
            max={1_000_000}
            step={100}
            value={outputTokens}
            onChange={(e) => setOutputTokens(Number(e.target.value))}
            className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg"
          />
          <span className="mt-1 block text-[10px]">总 KV 序列 {contextLabel}</span>
        </label>
        <label className="block text-xs text-dim">
          并发 batch：{batch}
          <input type="range" min={1} max={64} value={batch} onChange={(e) => setBatch(+e.target.value)} className="mt-2 w-full" />
        </label>
      </div>

      <div className="rounded-xl border border-line bg-panel shadow-sm p-5">
        <h4 className="mb-1 text-sm font-semibold">
          显存构成 <span className="font-normal text-dim">（公式：权重 = 总参数×字节 + KV = 每token字节×上下文×并发 + ~10% 开销）</span>
        </h4>
        {r.unsupported ? (
          <div className="mt-3 rounded-lg border border-warn/40 bg-warn/10 p-4 text-sm leading-relaxed">
            <span className="font-semibold text-warn">该架构不支持 KV 数值估算：</span>
            {model.kvSpec.kind === 'unsupported' && model.kvSpec.note}
            <div className="mt-2 text-dim">
              下方仅按「权重 + 开销」给出下限：{r.baseGB.toFixed(0)} GB → 至少 {r.gpus}× {gpu.name}
            </div>
          </div>
        ) : (
          <>
            <div className="mt-3 flex h-9 w-full gap-0.5 overflow-hidden rounded-lg bg-panel-2">
              {segs([
                { gb: r.bd.weightsGB, color: 'bg-accent', label: '权重' },
                ...(r.bd.kvGB !== null ? [{ gb: r.bd.kvGB, color: 'bg-warn', label: 'KV cache' }] : []),
                { gb: r.bd.overheadGB, color: 'bg-dim', label: '开销' },
              ])}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                合计 <b className="font-mono">{r.bd.totalGB!.toFixed(0)} GB</b>
              </span>
              <span className="text-dim">
                → 需要 <b className="font-mono text-fg">{r.gpus}× {gpu.name}</b>（每卡按 90% 可用算）
              </span>
              {r.bd.kvGB !== null && r.bd.kvGB > r.bd.weightsGB && (
                <span className="text-warn">⚠ KV cache 已超过权重——长上下文×高并发的「显存墙」现场</span>
              )}
            </div>
          </>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
          <div className="text-xs text-dim">TTFT（prefill {(inputTokens / 1000).toLocaleString()}K tokens）</div>
          <div className="mt-1 font-mono text-2xl font-bold">
            {r.ttft === null ? 'N/A' : r.ttft >= 1000 ? `${(r.ttft / 1000).toFixed(1)}s` : `${r.ttft.toFixed(0)}ms`}
          </div>
          <div className="mt-1 text-[11px] text-dim">
            {r.ttft === null
              ? '该卡算力无官方数据（见硬件层备注），不做伪精确估算'
              : `算力瓶颈：2×激活参数×tokens ÷ (${r.ttftBasis === 'fp4' ? 'FP4' : 'FP8'} 算力×MFU 0.4)${
                  r.ttftBasis === 'fp8' && quantId !== 'fp8' ? '——所选量化无官方算力数据，按 FP8 算力口径' : ''
                }`}
          </div>
        </div>
        <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
          <div className="text-xs text-dim">TPOT（每 token 步长）</div>
          <div className="mt-1 font-mono text-2xl font-bold">{r.stepMs.toFixed(1)}ms</div>
          <div className="mt-1 text-[11px] text-dim">带宽瓶颈：(激活权重 + batch×KV) ÷ (带宽×MBU 0.6)</div>
        </div>
        <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
          <div className="text-xs text-dim">集群吞吐（batch={batch}）</div>
          <div className="mt-1 font-mono text-2xl font-bold">{r.tps.toFixed(0)} tok/s</div>
          <div className="mt-1 text-[11px] text-dim">每步出 batch 个 token；MoE 用激活参数（{model.activeParamsB}B）</div>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-panel shadow-sm p-4 text-xs leading-relaxed text-dim">
        <span className="font-semibold text-warn">机架级参考（与单卡不同层级实体，不直接对比）：</span>
        {RACKS.map((rk) => (
          <span key={rk.id} className="ml-2">
            {rk.name}：{rk.gpus}× {rk.gpuName} + {rk.cpus}× Grace，HBM {rk.totalHbmTB}TB，FP4 稠密 {rk.fp4Pflops} PFLOPS；
          </span>
        ))}
        <span className="ml-1">示意估算非实测，数据来源见硬件层各组件（NVIDIA 官方页，2026-07）。</span>
      </div>
    </div>
  )
}
