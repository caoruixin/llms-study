import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { MODELS } from '../data/models'
import { GPUS } from '../data/hardware'
import { isPromoExpired, PRICING } from '../data/pricing'
import {
  QUANTS,
  apiRequestCost,
  estimateTokens,
  estStepMs,
  estTTFTms,
  kvBytesPerToken,
  memoryBreakdown,
  minGpus,
  tflopsForQuant,
  tokensPerSecond,
} from '../lib/simEngine'
import { useInferenceParams, type QuantId } from '../store'

// 仅提供有公开 KV/维度参数、可数值估算的模型（KDA/DSA/CSA-HCA 等新架构无公开参数，不做伪精确估算）
const SIM_MODELS = MODELS.filter((m) => m.kvSpec.kind !== 'unsupported')

const STAGES = [
  { id: 'gateway', name: 'Gateway 鉴权/限流', desc: '校验 API key、检查 RPM/TPM 配额、计量埋点' },
  { id: 'router', name: '模型路由', desc: '按模型 ID / SLA / 地域选择目标推理集群' },
  { id: 'queue', name: '队列调度', desc: '等待推理实例空位，调度器按优先级分配' },
  { id: 'cache', name: 'KV cache 命中', desc: '前缀匹配：命中部分跳过 prefill，直接复用 KV' },
  { id: 'prefill', name: 'Prefill', desc: '未命中输入一次并行前向，写入 KV cache（TTFT 主体）' },
  { id: 'decode', name: 'Decode 逐 token', desc: '每步读全部激活权重+KV，生成一个 token（带宽受限）' },
  { id: 'billing', name: '计费与返回', desc: '按输入/命中/输出三段计量，流式返回完毕' },
] as const

const MOCK_OUTPUT =
  'KV cache 是推理系统的显存主角：prefill 阶段把输入的 K/V 存下来，decode 阶段每生成一个 token 都要读它。它随「上下文长度 × 并发数」线性膨胀，因此 GQA、MLA、稀疏注意力乃至线性注意力的演进，本质都是在给这份账单降价。'

export default function LifecycleSim() {
  // 模型/GPU/量化/batch/缓存命中率与 /inference 其他面板共享（src/store.ts useInferenceParams）
  const {
    modelId,
    gpuId,
    quantId,
    batch,
    cacheRate,
    inputTokens,
    outputTokens,
    systemTpsFingerprint,
    setModelId,
    setGpuId,
    setQuantId,
    setBatch,
    setCacheRate,
    setInputTokens,
    setOutputTokens,
    setGpusPerCapacityUnit,
    setSystemTps,
  } = useInferenceParams()
  const [priceKey, setPriceKey] = useState('DeepSeek|deepseek-v4-pro')
  const [prompt, setPrompt] = useState('你是资深售前顾问。请解释为什么长上下文会显著推高推理成本，并给出三个可落地的优化手段。')

  const [stageIdx, setStageIdx] = useState(-1) // -1 未开始
  const [outTokens, setOutTokens] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>[]>([])

  // 共享参数里的模型可能无公开 KV 参数（显存计算器可选）→ 本面板退回首个可估算模型并标注
  const sharedModel = SIM_MODELS.find((m) => m.id === modelId)
  const model = sharedModel ?? SIM_MODELS[0]
  const gpu = GPUS.find((g) => g.id === gpuId)!
  const quant = QUANTS.find((q) => q.id === quantId)!
  const price = PRICING.find((p) => `${p.provider}|${p.modelId}` === priceKey)!

  const cacheHitTokens = Math.round(inputTokens * cacheRate)

  const calc = useMemo(() => {
    const bd = memoryBreakdown(model.totalParamsB, quant.bytesPerParam, model.kvSpec, inputTokens + outputTokens, batch)
    const gpus = bd.totalGB === null ? 1 : minGpus(bd.totalGB, gpu.memoryGB)
    // 量化对应算力口径（无官方对应精度数据时回退 FP8，与显存计算器同口径）
    const ttft = estTTFTms(model.activeParamsB, inputTokens - cacheHitTokens, tflopsForQuant(gpu, quant.id).tflops, gpus)
    // KV 序列口径与上方 memoryBreakdown、显存墙计算器一致：ISL+OSL；
    // 只用 ISL 会与显存墙写入互相矛盾的共享 systemTps。
    const stepMs = estStepMs(
      model.activeParamsB,
      quant.bytesPerParam,
      kvBytesPerToken(model.kvSpec),
      inputTokens + outputTokens,
      batch,
      gpu.bandwidthTBs,
      gpus,
    )
    const tps = tokensPerSecond(stepMs, batch)
    const outN = outputTokens
    const cost = apiRequestCost(inputTokens, outN, cacheHitTokens, price.inputPerMTok ?? 0, price.outputPerMTok ?? 0, price.cachedInputPerMTok)
    const costNoCache = apiRequestCost(inputTokens, outN, 0, price.inputPerMTok ?? 0, price.outputPerMTok ?? 0, price.cachedInputPerMTok)
    return { bd, gpus, ttft, stepMs, tps, outN, cost, costNoCache }
  }, [model, gpu, quant, batch, inputTokens, outputTokens, cacheHitTokens, price])

  function clearTimers() {
    timerRef.current.forEach(clearTimeout)
    timerRef.current = []
  }

  useEffect(() => clearTimers, [])
  // 仅在场景 TPS 已失效（指纹为 null、无人认领）时自动写入；有效的手填 / 估算值
  // 不被挂载副作用静默覆盖（覆盖需走指标面板的显式同步按钮）。
  useEffect(() => {
    // 退回展示模型时不能把另一模型的 roofline TPS 写回共享场景。
    if (!sharedModel) return
    if (systemTpsFingerprint !== null) return
    setGpusPerCapacityUnit(calc.gpus)
    setSystemTps(calc.tps, 'estimated')
  }, [calc.gpus, calc.tps, systemTpsFingerprint, setGpusPerCapacityUnit, setSystemTps, sharedModel])

  const syncRooflineToScenario = () => {
    if (!sharedModel) return
    setGpusPerCapacityUnit(calc.gpus)
    setSystemTps(calc.tps, 'estimated')
  }

  function run() {
    clearTimers()
    setOutTokens([])
    setRunning(true)
    setStageIdx(0)
    // 服务层各阶段固定演示时长；prefill 与 decode 按估算值缩放（动画为示意节奏，非实时比例）
    const serviceDelay = 550
    const prefillDelay = Math.min(1800, Math.max(600, calc.ttft ?? 800))
    let t = 0
    const at = (ms: number, fn: () => void) => timerRef.current.push(setTimeout(fn, ms))
    for (let i = 1; i <= 4; i++) {
      t += serviceDelay
      const idx = i
      at(t, () => setStageIdx(idx))
    }
    t += prefillDelay
    at(t, () => setStageIdx(5))
    // decode：按字流式输出
    const chars = MOCK_OUTPUT.split('')
    const perChar = Math.min(90, Math.max(25, calc.stepMs / 1.6))
    chars.forEach((ch, i) => {
      at(t + (i + 1) * perChar, () => setOutTokens((prev) => [...prev, ch]))
    })
    t += chars.length * perChar + 300
    at(t, () => {
      setStageIdx(6)
      setRunning(false)
    })
  }

  const fmtMs = (v: number | null) =>
    v === null ? 'N/A（该卡算力无官方数据）' : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : v < 10 ? `${v.toFixed(1)}ms` : `${v.toFixed(0)}ms`
  const cur = price.currency === 'USD' ? '$' : '¥'

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-2 text-xs text-warn">
        ⚠️ 全部指标为 roofline 简化的示意估算（非实测 benchmark）；动画节奏经缩放便于观看。仅列出有公开架构参数的模型——KDA/DSA/CSA-HCA
        等新架构官方未公布维度，不做伪精确估算。
      </div>

      {/* 参数控制 */}
      <div className="grid gap-3 rounded-xl border border-line bg-panel shadow-sm p-4 md:grid-cols-3 lg:grid-cols-6">
        <label className="block text-xs text-dim">
          模型
          <select value={model.id} onChange={(e) => setModelId(e.target.value)} className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg">
            {SIM_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {!sharedModel && (
            <span className="mt-1 block text-[10px] leading-snug text-warn">
              共享参数所选模型无公开 KV 参数，本面板退回 {model.name} 估算
            </span>
          )}
        </label>
        <label className="block text-xs text-dim">
          GPU
          <select value={gpuId} onChange={(e) => setGpuId(e.target.value)} className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg">
            {GPUS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-dim">
          量化
          <select value={quantId} onChange={(e) => setQuantId(e.target.value as QuantId)} className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg">
            {QUANTS.map((q) => (
              <option key={q.id} value={q.id}>
                {q.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-dim">
          Batch：{batch}
          <input type="range" min={1} max={64} value={batch} onChange={(e) => setBatch(+e.target.value)} className="mt-2 w-full" />
        </label>
        <label className="block text-xs text-dim">
          前缀缓存命中率：{Math.round(cacheRate * 100)}%
          <input type="range" min={0} max={95} value={cacheRate * 100} onChange={(e) => setCacheRate(+e.target.value / 100)} className="mt-2 w-full" />
        </label>
        <label className="block text-xs text-dim">
          计费价目
          <select value={priceKey} onChange={(e) => setPriceKey(e.target.value)} className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg">
            {PRICING.filter((p) => p.inputPerMTok !== null).map((p) => (
              <option key={`${p.provider}|${p.modelId}`} value={`${p.provider}|${p.modelId}`}>
                {p.modelId}（{p.provider}）{isPromoExpired(p.validUntil) ? '·限时价已过期' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* prompt 输入 */}
      <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block basis-full sm:basis-auto sm:min-w-64 flex-1 text-xs text-dim">
            用户 Prompt（模拟，不调真实模型）
            <textarea
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value)
                setInputTokens(estimateTokens(e.target.value))
              }}
              rows={2}
              className="mt-1 w-full rounded-md border border-line bg-panel-2 px-3 py-2 text-sm text-fg"
            />
          </label>
          <label className="block text-xs text-dim">
            输入 token（估算，可改）
            <input
              type="number"
              value={inputTokens}
              onChange={(e) => setInputTokens(Number(e.target.value))}
              className="mt-1 w-28 rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg"
            />
          </label>
          <label className="block text-xs text-dim">
            目标输出 token
            <input
              type="number"
              min={1}
              value={outputTokens}
              onChange={(e) => setOutputTokens(Number(e.target.value))}
              className="mt-1 w-28 rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg"
            />
          </label>
          <button
            onClick={run}
            disabled={running}
            className="min-h-11 md:min-h-0 rounded-lg bg-accent px-6 py-2.5 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-40"
          >
            {running ? '模拟中…' : '▶ 发起请求'}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* 阶段流水 */}
        <div className="min-w-0 flex-1 space-y-2">
          {STAGES.map((s, i) => {
            const active = i === stageIdx
            const done = i < stageIdx
            return (
              <motion.div
                key={s.id}
                animate={{ scale: active ? 1.015 : 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 24 }}
                className={`relative rounded-lg border px-4 py-2.5 transition-colors ${
                  active
                    ? 'border-accent bg-accent/10 shadow-sm'
                    : done
                      ? 'border-ok/40 bg-ok/5'
                      : 'border-line bg-panel opacity-60'
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="request-pulse"
                    transition={{ type: 'spring', stiffness: 350, damping: 28 }}
                    className="absolute top-1/2 -left-2.5 h-4 w-4 -translate-y-1/2 rounded-full bg-accent"
                  >
                    <span className="absolute inset-0 animate-ping rounded-full bg-accent/40" />
                  </motion.span>
                )}
                <div className="flex items-center gap-2 text-sm">
                  <span className={done ? 'text-ok' : active ? 'text-accent' : 'text-dim'}>
                    {done ? '✓' : active ? '●' : '○'}
                  </span>
                  <span className="font-medium">{s.name}</span>
                  {s.id === 'cache' && (done || active) && (
                    <span className="ml-auto text-xs text-ok">命中 {cacheHitTokens} / {inputTokens} tokens</span>
                  )}
                  {s.id === 'prefill' && (done || active) && (
                    <span className="ml-auto text-xs text-dim">仅算未命中 {inputTokens - cacheHitTokens} tokens</span>
                  )}
                  {s.id === 'decode' && (done || active) && (
                    <span className="ml-auto text-xs text-dim">{outTokens.length} tokens</span>
                  )}
                </div>
                <div className="mt-0.5 pl-6 text-xs text-dim">{s.desc}</div>
                <AnimatePresence>
                  {s.id === 'decode' && outTokens.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="mt-2 ml-6 rounded-md bg-panel-2 p-3 text-sm leading-relaxed"
                    >
                      {outTokens.join('')}
                      {active && <span className="animate-pulse text-accent">▌</span>}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )
          })}
        </div>

        {/* 指标面板 */}
        <div className="w-full shrink-0 space-y-3 lg:w-80">
          <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
            <h4 className="mb-3 text-sm font-semibold text-accent">性能估算（{calc.gpus}× {gpu.name}）</h4>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-dim">TTFT（首 token）</dt><dd className="font-mono">{fmtMs(calc.ttft)}</dd></div>
              <div className="flex justify-between"><dt className="text-dim">TPOT（每 token）</dt><dd className="font-mono">{calc.stepMs.toFixed(1)}ms</dd></div>
              <div className="flex justify-between"><dt className="text-dim">集群吞吐（batch={batch}）</dt><dd className="font-mono">{calc.tps.toFixed(0)} tok/s</dd></div>
              <div className="flex justify-between"><dt className="text-dim">显存占用</dt><dd className="font-mono">{calc.bd.totalGB === null ? 'N/A' : `${calc.bd.totalGB.toFixed(0)} GB`}</dd></div>
            </dl>
            <p className="mt-2 text-[11px] leading-relaxed text-dim">
              缓存命中率 ↑ → prefill 量 ↓ → TTFT ↓；batch ↑ → 吞吐 ↑（权重读取被摊薄）、TPOT 略 ↑
            </p>
            <button
              type="button"
              onClick={syncRooflineToScenario}
              disabled={!sharedModel}
              className="mt-3 min-h-11 w-full rounded-lg border border-line bg-panel-2 px-3 text-sm font-semibold shadow-sm hover:border-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              同步 roofline 结果到场景（{calc.gpus} 卡/单元 + {calc.tps.toFixed(0)} tok/s）
            </button>
            <p className="mt-1.5 text-[10px] leading-relaxed text-dim">
              {!sharedModel
                ? '当前为退回展示模型，估算结果不写回共享场景。'
                : systemTpsFingerprint === null
                  ? '共享场景的 TPS 已失效，本页估算结果会自动认领写入。'
                  : '共享场景已有有效 TPS（手填或估算），本页不自动覆盖；确认口径后可显式同步。'}
            </p>
          </div>
          <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
            <h4 className="mb-3 text-sm font-semibold text-ok">本次请求计费（{price.modelId}）</h4>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-dim">输入 {inputTokens - cacheHitTokens} tok（未命中）</dt><dd className="font-mono">{cur}{(((inputTokens - cacheHitTokens) * (price.inputPerMTok ?? 0)) / 1e6).toFixed(6)}</dd></div>
              <div className="flex justify-between"><dt className="text-dim">命中 {cacheHitTokens} tok</dt><dd className="font-mono">{cur}{((cacheHitTokens * (price.cachedInputPerMTok ?? price.inputPerMTok ?? 0)) / 1e6).toFixed(6)}</dd></div>
              <div className="flex justify-between"><dt className="text-dim">输出 {calc.outN} tok</dt><dd className="font-mono">{cur}{((calc.outN * (price.outputPerMTok ?? 0)) / 1e6).toFixed(6)}</dd></div>
              <div className="flex justify-between border-t border-line pt-2 font-semibold"><dt>合计</dt><dd className="font-mono">{cur}{calc.cost.toFixed(6)}</dd></div>
              <div className="flex justify-between text-xs"><dt className="text-dim">若无缓存</dt><dd className="font-mono text-dim">{cur}{calc.costNoCache.toFixed(6)}（省 {calc.costNoCache > 0 ? Math.round((1 - calc.cost / calc.costNoCache) * 100) : 0}%）</dd></div>
              <div className="flex justify-between text-xs"><dt className="text-dim">× 日 100 万次</dt><dd className="font-mono text-warn">{cur}{(calc.cost * 1e6).toFixed(0)} / 天</dd></div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  )
}
