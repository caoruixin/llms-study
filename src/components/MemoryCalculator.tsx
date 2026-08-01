import { useMemo, useState } from 'react'
import { MODELS } from '../data/models'
import { GPUS, RACKS } from '../data/hardware'
import {
  QUANTS,
  estStepMs,
  estTTFTms,
  kvBytesPerToken,
  memoryBreakdown,
  minGpus,
  tokensPerSecond,
} from '../lib/simEngine'

const CTX_STEPS = [4, 8, 16, 32, 64, 128, 256, 512, 1000] // K tokens

export default function MemoryCalculator() {
  const [modelId, setModelId] = useState('llama3-70b')
  const [gpuId, setGpuId] = useState('h100')
  const [quantId, setQuantId] = useState<'fp16' | 'fp8' | 'int4'>('fp8')
  const [ctxIdx, setCtxIdx] = useState(2) // 16K
  const [batch, setBatch] = useState(8)

  const model = MODELS.find((m) => m.id === modelId)!
  const gpu = GPUS.find((g) => g.id === gpuId)!
  const quant = QUANTS.find((q) => q.id === quantId)!
  const contextTokens = CTX_STEPS[ctxIdx] * 1000

  const r = useMemo(() => {
    const bd = memoryBreakdown(model.totalParamsB, quant.bytesPerParam, model.kvSpec, contextTokens, batch)
    const unsupported = model.kvSpec.kind === 'unsupported'
    // 无 KV 公式时给「权重下限」估卡数，并明确标注
    const baseGB = bd.totalGB ?? bd.weightsGB + bd.overheadGB
    const gpus = minGpus(baseGB, gpu.memoryGB)
    const ttft = estTTFTms(model.activeParamsB, contextTokens, gpu.fp8Tflops, gpus)
    const stepMs = estStepMs(
      model.activeParamsB,
      quant.bytesPerParam,
      kvBytesPerToken(model.kvSpec),
      contextTokens,
      batch,
      gpu.bandwidthTBs,
      gpus,
    )
    return { bd, unsupported, baseGB, gpus, ttft, stepMs, tps: tokensPerSecond(stepMs, batch) }
  }, [model, gpu, quant, contextTokens, batch])

  const seg = (gb: number, color: string, label: string) => {
    const total = r.baseGB
    const pct = Math.max(2, (gb / total) * 100)
    return (
      <div className={`${color} flex items-center justify-center overflow-hidden rounded px-1 text-[11px] font-medium whitespace-nowrap text-white`} style={{ width: `${pct}%` }} title={`${label} ${gb.toFixed(1)} GB`}>
        {label} {gb.toFixed(0)}G
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-xl border border-line bg-panel shadow-sm p-4 md:grid-cols-5">
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
          <select value={quantId} onChange={(e) => setQuantId(e.target.value as typeof quantId)} className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg">
            {QUANTS.map((q) => (
              <option key={q.id} value={q.id}>
                {q.label}（{q.bytesPerParam} B/参数）
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-dim">
          上下文：{CTX_STEPS[ctxIdx] >= 1000 ? '1M' : `${CTX_STEPS[ctxIdx]}K`}
          <input type="range" min={0} max={CTX_STEPS.length - 1} value={ctxIdx} onChange={(e) => setCtxIdx(+e.target.value)} className="mt-2 w-full" />
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
              {seg(r.bd.weightsGB, 'bg-accent', '权重')}
              {r.bd.kvGB !== null && seg(r.bd.kvGB, 'bg-warn', 'KV cache')}
              {seg(r.bd.overheadGB, 'bg-dim', '开销')}
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
          <div className="text-xs text-dim">TTFT（prefill {CTX_STEPS[ctxIdx] >= 1000 ? '1M' : `${CTX_STEPS[ctxIdx]}K`} tokens）</div>
          <div className="mt-1 font-mono text-2xl font-bold">
            {r.ttft === null ? 'N/A' : r.ttft >= 1000 ? `${(r.ttft / 1000).toFixed(1)}s` : `${r.ttft.toFixed(0)}ms`}
          </div>
          <div className="mt-1 text-[11px] text-dim">算力瓶颈：2×激活参数×tokens ÷ (FP8 算力×MFU 0.4)</div>
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
