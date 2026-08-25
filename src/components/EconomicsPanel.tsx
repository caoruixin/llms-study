import { useMemo, useState } from 'react'
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
import { CLOUD_PRICES, GPUS } from '../data/hardware'
import { isPromoExpired, PRICING } from '../data/pricing'
import { WORKED_CASES } from '../data/cases'
import { apiBlendedPerMTok, breakEvenDailyMTok, selfHostCostPerMTok } from '../lib/simEngine'
import { useInferenceParams } from '../store'

const API_COLOR = '#9e2b3a'
const SELF_COLOR = '#0d9488'
const INK_MUTED = '#6e6a60'
const GRID = '#e3ded1'

const USD_PRICING = PRICING.filter((p) => p.currency === 'USD' && p.inputPerMTok !== null)
// 默认价目优先 DeepSeek（页面既有口径），该行不存在时退回列表第一项，价目表变动不至于崩
const DEFAULT_PRICE_ROW = USD_PRICING.find((p) => p.provider === 'DeepSeek') ?? USD_PRICING[0]
const DEFAULT_PRICE_KEY = DEFAULT_PRICE_ROW ? `${DEFAULT_PRICE_ROW.provider}|${DEFAULT_PRICE_ROW.modelId}` : ''

export default function EconomicsPanel() {
  // 自建参数与 KPI/Sizing 共享；这里的 utilization 是成本模型有效利用率，不是 GPU 遥测利用率。
  const {
    cacheRate,
    gpuId,
    gpuCount,
    systemTps: tps,
    utilization,
    hourlyCost: clusterHourly,
    setCacheRate,
    setGpuId,
    setGpuCount,
    setSystemTps,
    setUtilization,
    setHourlyCost,
  } = useInferenceParams()
  const [priceKey, setPriceKey] = useState(DEFAULT_PRICE_KEY)
  const [outputShare, setOutputShare] = useState(0.15)
  const [openCase, setOpenCase] = useState<string | null>(null)

  // 选中行不存在（数据行被移除等）时退回列表第一项，而非抛错白屏
  const price = USD_PRICING.find((p) => `${p.provider}|${p.modelId}` === priceKey) ?? USD_PRICING[0]
  const gpu = GPUS.find((g) => g.id === gpuId)!
  const cloud = CLOUD_PRICES.find((c) => c.gpuId === gpuId)
  const hourlyPerGpu = clusterHourly / Math.max(1, gpuCount)

  const r = useMemo(() => {
    const apiPerMTok = apiBlendedPerMTok(
      1 - outputShare,
      outputShare,
      cacheRate,
      price?.inputPerMTok ?? 0,
      price?.outputPerMTok ?? 0,
      price?.cachedInputPerMTok ?? null,
    )
    const selfPerMTok = selfHostCostPerMTok(clusterHourly, tps, utilization)
    const dailyCost = clusterHourly * 24 // 单副本（当前集群）日固定成本
    const capacityMTok = (tps * 86400 * utilization) / 1e6 // 该利用率下集群日产出
    // 自建成本按副本阶梯：负载超产能加副本 → 日成本 × ceil(负载/产能)。
    // 盈亏平衡取 API 线与阶梯线的首个交点：第 k 副本段 ((k-1)·产能, k·产能] 内解 api·x = k·日成本；
    // 若 API 单价始终低于满载自建单价则不存在交点 → null。
    let breakEven: number | null = null
    if (apiPerMTok > 0) {
      for (let k = 1; k <= 200; k++) {
        const segStart = (k - 1) * capacityMTok
        const x = (k * dailyCost) / apiPerMTok
        if (x <= segStart) {
          breakEven = segStart // 段起点即已越过（阶梯跳升前 API 已更贵）
          break
        }
        if (x <= k * capacityMTok) {
          breakEven = x
          break
        }
      }
    }
    const maxX = Math.max((breakEven ?? breakEvenDailyMTok(clusterHourly, apiPerMTok)) * 2.2, capacityMTok * 1.2)
    // 均匀采样 + 每个产能整数倍的边界点对，保证 stepAfter 的跳变恰好落在产能倍数上而非采样格点上
    const xs = Array.from({ length: 45 }, (_, i) => (maxX / 44) * i)
    for (let k = 1; k * capacityMTok < maxX; k++) {
      xs.push(k * capacityMTok, k * capacityMTok * 1.0001)
    }
    const points = xs
      .sort((a, b) => a - b)
      .map((x) => ({
        x: Math.round(x * 10) / 10,
        api: Math.round(x * apiPerMTok * 100) / 100,
        self: Math.round(dailyCost * Math.max(1, Math.ceil(x / capacityMTok)) * 100) / 100,
      }))
    return { apiPerMTok, selfPerMTok, breakEven, capacityMTok, points, maxX }
  }, [price, clusterHourly, tps, utilization, cacheRate, outputShare])

  if (!price) {
    // USD 价目为空的兜底（正常不会发生）：降级提示而非白屏
    return (
      <div className="rounded-xl border border-warn/40 bg-warn/10 p-4 text-sm text-warn">
        价目数据缺失（pricing.ts 无可用 USD 价目行），Token 经济面板暂不可用。
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 参数区 */}
      <div className="grid gap-3 rounded-xl border border-line bg-panel shadow-sm p-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-7">
        <label className="block text-xs text-dim">
          API 价目（USD）
          <select value={priceKey} onChange={(e) => setPriceKey(e.target.value)} className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg">
            {USD_PRICING.map((p) => (
              <option key={`${p.provider}|${p.modelId}`} value={`${p.provider}|${p.modelId}`}>
                {p.modelId}
                {isPromoExpired(p.validUntil) ? '（限时价已过期）' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-dim">
          自建 GPU
          <select
            value={gpuId}
            onChange={(e) => {
              const nextId = e.target.value
              const nextCloud = CLOUD_PRICES.find((c) => c.gpuId === nextId)
              setGpuId(nextId)
              if (nextCloud) setHourlyCost(nextCloud.typicalUSD * gpuCount)
            }}
            className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg"
          >
            {GPUS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-dim">
          卡数：{gpuCount}
          <input
            type="range"
            min={1}
            max={72}
            value={gpuCount}
            onChange={(e) => {
              const next = Number(e.target.value)
              setGpuCount(next)
              setHourlyCost(hourlyPerGpu * next)
            }}
            className="mt-2 w-full"
          />
        </label>
        <label className="block text-xs text-dim">
          集群成本 $/h（{hourlyPerGpu.toFixed(2)}/卡）
          <input type="number" step={0.1} min={0} value={clusterHourly} onChange={(e) => setHourlyCost(Number(e.target.value))} className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg" />
        </label>
        <label className="block text-xs text-dim">
          系统输出 TPS（tok/s）
          <input type="number" step={500} value={tps} onChange={(e) => setSystemTps(Number(e.target.value))} className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg" />
        </label>
        <label className="block text-xs text-dim">
          成本模型利用率：{Math.round(utilization * 100)}%
          <input type="range" min={5} max={95} value={utilization * 100} onChange={(e) => setUtilization(+e.target.value / 100)} className="mt-2 w-full" />
        </label>
        <label className="block text-xs text-dim">
          缓存命中：{Math.round(cacheRate * 100)}% / 输出占比：{Math.round(outputShare * 100)}%
          <input type="range" min={0} max={95} value={cacheRate * 100} onChange={(e) => setCacheRate(+e.target.value / 100)} className="mt-1 w-full" />
          <input type="range" min={5} max={60} value={outputShare * 100} onChange={(e) => setOutputShare(+e.target.value / 100)} className="mt-1 w-full" />
        </label>
      </div>

      {/* 结论指标 */}
      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
          <div className="text-xs text-dim">API 混合均价</div>
          <div className="mt-1 font-mono text-2xl font-bold" style={{ color: API_COLOR }}>${r.apiPerMTok.toFixed(2)}<span className="text-sm text-dim">/MTok</span></div>
          <div className="mt-1 text-[11px] text-dim">输入/输出/缓存按占比加权</div>
        </div>
        <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
          <div className="text-xs text-dim">自建单位成本</div>
          <div className="mt-1 font-mono text-2xl font-bold" style={{ color: SELF_COLOR }}>${r.selfPerMTok.toFixed(2)}<span className="text-sm text-dim">/MTok</span></div>
          <div className="mt-1 text-[11px] text-dim">集群$/h ÷ (tok/s×3600×利用率)×10⁶ —— 利用率在分母</div>
        </div>
        <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
          <div className="text-xs text-dim">盈亏平衡点</div>
          <div className="mt-1 font-mono text-2xl font-bold">
            {r.breakEven === null ? '—' : (
              <>
                {r.breakEven.toFixed(0)}
                <span className="text-sm text-dim"> MTok/日</span>
              </>
            )}
          </div>
          <div className="mt-1 text-[11px] text-dim">
            {r.breakEven === null ? '当前假设下自建单位成本高于 API，加副本也不打平' : '日均量超过此值自建开始更省（含加副本阶梯）'}
          </div>
        </div>
        <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
          <div className="text-xs text-dim">集群日产能（当前利用率）</div>
          <div className="mt-1 font-mono text-2xl font-bold">{r.capacityMTok.toFixed(0)}<span className="text-sm text-dim"> MTok/日</span></div>
          <div className="mt-1 text-[11px] text-dim">超出需加副本（成本阶梯上移）</div>
        </div>
      </div>

      {/* 盈亏平衡图 */}
      <div className="rounded-xl border border-line bg-panel shadow-sm p-5">
        <h4 className="mb-1 text-sm font-semibold">API vs 自建：日成本对比（示意测算）</h4>
        <p className="mb-3 text-xs text-dim">
          自建按副本阶梯计成本：单副本 {gpuCount}×{gpu.name} ≈ ${(clusterHourly * 24).toFixed(0)}/日，负载超产能（{r.capacityMTok.toFixed(0)} MTok/日）需加副本、成本上一个台阶；API 随用量线性。交点即盈亏平衡。
        </p>
        <div className="h-72 w-full">
          <ResponsiveContainer>
            <LineChart data={r.points} margin={{ top: 8, right: 24, bottom: 4, left: 8 }}>
              <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
              {/* type="number" 必须显式声明：category 轴上 ReferenceLine 只有恰好命中采样值才渲染 */}
              <XAxis dataKey="x" type="number" domain={[0, 'dataMax']} stroke={INK_MUTED} tick={{ fill: INK_MUTED, fontSize: 11 }} label={{ value: '日均用量（MTok）', position: 'insideBottomRight', offset: -2, fill: INK_MUTED, fontSize: 11 }} />
              <YAxis stroke={INK_MUTED} tick={{ fill: INK_MUTED, fontSize: 11 }} label={{ value: '$/日', angle: -90, position: 'insideLeft', fill: INK_MUTED, fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: '#ffffff', border: '1px solid #e3ded1', borderRadius: 8, fontSize: 12, boxShadow: '0 4px 12px rgba(33,31,26,0.08)', color: '#211f1a' }}
                labelStyle={{ color: INK_MUTED }}
                formatter={(v: number, name: string) => [`$${v}`, name === 'api' ? 'API 日成本' : '自建日成本']}
                labelFormatter={(v) => `日均 ${v} MTok`}
              />
              <Legend formatter={(v) => <span style={{ color: INK_MUTED, fontSize: 12 }}>{v === 'api' ? 'API 日成本' : '自建日成本（超产能加副本，阶梯上移）'}</span>} />
              {r.breakEven !== null && (
                <ReferenceLine x={Math.round(r.breakEven * 10) / 10} stroke={INK_MUTED} strokeDasharray="4 4" label={{ value: `盈亏平衡 ${r.breakEven.toFixed(0)}`, fill: INK_MUTED, fontSize: 11, position: 'insideTopLeft' }} />
              )}
              {/* 产能线靠近左缘时右锚标签会被裁切，改左锚 */}
              <ReferenceLine x={Math.round(r.capacityMTok * 10) / 10} stroke={SELF_COLOR} strokeDasharray="2 4" label={{ value: `产能上限 ${r.capacityMTok.toFixed(0)}（单副本）`, fill: SELF_COLOR, fontSize: 11, position: r.capacityMTok / r.maxX < 0.15 ? 'insideTopLeft' : 'insideTopRight' }} />
              <Line type="monotone" dataKey="api" stroke={API_COLOR} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              <Line type="stepAfter" dataKey="self" stroke={SELF_COLOR} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-dim">
          假设须诚实呈现：利用率（分母！）与吞吐是自建方案最脆弱的两个假设；自建另有运维/评测/冗余隐性成本未计入。时租参考：
          {cloud ? `${cloud.note}（${cloud.asOf}）` : 'N/A'}。示意测算，非报价依据。
        </p>
      </div>

      {/* worked cases */}
      <div className="space-y-3">
        {WORKED_CASES.map((c) => {
          const open = openCase === c.id
          return (
            <div key={c.id} className={`rounded-xl border bg-panel shadow-sm ${open ? 'border-accent/60' : 'border-line'}`}>
              <button onClick={() => setOpenCase(open ? null : c.id)} className="w-full px-5 py-4 text-left">
                <div className="flex items-center gap-3">
                  <span className="font-bold">{c.name}</span>
                  {isPromoExpired(c.priceValidUntil) && (
                    <span className="rounded bg-warn/15 px-1.5 py-0.5 text-xs font-semibold text-warn">价格假设已过期</span>
                  )}
                  <span className="ml-auto text-dim">{open ? '▾' : '▸'}</span>
                </div>
                <p className="mt-1 text-sm text-dim">{c.scenario}</p>
              </button>
              {open && (
                <div className="space-y-4 border-t border-line px-5 py-4">
                  {isPromoExpired(c.priceValidUntil) && (
                    <div className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm leading-relaxed text-warn">
                      本案例引用的限时价已于 {c.priceValidUntil} 到期，测算数字仅作口径示范；现价以对应官方定价页为准。
                    </div>
                  )}
                  {c.sections.map((s, i) => (
                    <div key={i}>
                      <h5 className="mb-2 text-sm font-semibold text-accent">{s.title}</h5>
                      <table className="w-full text-sm">
                        <tbody>
                          {s.rows.map(([k, v], j) => (
                            <tr key={j} className={j % 2 ? '' : 'bg-panel-2/50'}>
                              <td className="w-40 px-3 py-2 align-top text-dim">{k}</td>
                              <td className="px-3 py-2 leading-relaxed">{v}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                  <div className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm leading-relaxed">
                    <span className="font-semibold text-warn">Takeaway：</span>
                    {c.takeaway}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
