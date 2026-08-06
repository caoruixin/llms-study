// Tab2 数值实验室（PLAN-kda-demo.md §6.1）：四变体并排 + β/α 滑块 + 误差曲线。
//
// 数据一致性（§5 第 2 层）：滑块初值全部读 DEFAULT_SCENARIO.defaults，组件内**没有第二份默认值**；
// 任何滑块变化都只做一件事——用 LabOverrides 重建整棵 trace，热力图 / 曲线 / 误差数字随之同步刷新。
import { useEffect, useMemo, useState } from 'react'
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
import {
  buildKdaTrace,
  DEFAULT_SCENARIO,
  fmt,
  selectErrorChartData,
  selectStep,
  type ErrorChartPoint,
  type VariantId,
} from '../../lib/kdaEngine'
import { LAB_TAKEAWAYS, tokenLabel, VARIANT_META, VARIANT_ORDER } from '../../data/kda'
import MatrixHeatmap, { VectorStrip } from './MatrixHeatmap'
import StepControls from './StepControls'

const INK_MUTED = '#6e6a60'
const GRID = '#e3ded1'
const ACCENT = '#9e2b3a'
const PLAY_MS = 900

export default function KdaLab() {
  const scenario = DEFAULT_SCENARIO
  const defaults = scenario.defaults
  const tokenCount = scenario.tokens.length

  // 滑块状态：初值全部来自场景 defaults（唯一出处）
  const [beta, setBeta] = useState(defaults.beta)
  const [alphaScalar, setAlphaScalar] = useState(defaults.alphaScalar)
  const [alphaVec, setAlphaVec] = useState<number[]>(() => [...defaults.alphaVec])
  const [t, setT] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [hidden, setHidden] = useState<readonly VariantId[]>([])

  const trace = useMemo(
    () => buildKdaTrace(scenario, { beta, alphaScalar, alphaVec }),
    [scenario, beta, alphaScalar, alphaVec],
  )
  const chartData = useMemo(() => selectErrorChartData(trace), [trace])

  // 四变体全步共享色标：同一个数值在四张图里必须是同一个颜色
  const sharedMaxAbs = useMemo(() => {
    let m = 1e-9
    for (const id of VARIANT_ORDER) {
      for (const step of trace.variants[id].steps) {
        for (const row of step.sAfter) for (const x of row) m = Math.max(m, Math.abs(x))
      }
    }
    return m
  }, [trace])

  // 播放：setTimeout 链，到尾自停；切 tab / 卸载由 cleanup 清理
  useEffect(() => {
    if (!playing) return
    if (t >= tokenCount) {
      setPlaying(false)
      return
    }
    const id = setTimeout(() => setT((prev) => Math.min(tokenCount, prev + 1)), PLAY_MS)
    return () => clearTimeout(id)
  }, [playing, t, tokenCount])

  const clampT = (x: number) => Math.max(1, Math.min(tokenCount, x))
  const token = scenario.tokens[t - 1]
  const point: ErrorChartPoint | undefined = chartData[t - 1]

  function reset() {
    setPlaying(false)
    setBeta(defaults.beta)
    setAlphaScalar(defaults.alphaScalar)
    setAlphaVec([...defaults.alphaVec])
    setT(1)
  }

  function setChannelAlpha(i: number, value: number) {
    setAlphaVec((prev) => prev.map((x, j) => (j === i ? value : x)))
  }

  function toggleVariant(id: VariantId) {
    setHidden((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  return (
    <div className="space-y-4">
      {/* 步进 + 重置 */}
      <div className="flex flex-wrap items-stretch gap-3">
        <div className="min-w-0 flex-1">
          <StepControls
            index={t - 1}
            count={tokenCount}
            onChange={(i) => {
              setPlaying(false)
              setT(clampT(i + 1))
            }}
            playable
            playing={playing}
            onPlayingChange={(p) => {
              // 在末尾按播放：从头开始，避免「点了没反应」
              if (p && t >= tokenCount) setT(1)
              setPlaying(p)
            }}
            labels={scenario.tokens.map((tok) => tokenLabel(tok))}
          />
        </div>
        <button
          type="button"
          onClick={reset}
          className="rounded-xl border border-line bg-panel shadow-sm px-4 py-2 text-sm font-medium text-fg hover:bg-panel-2"
        >
          ↺ 重置参数与进度
        </button>
      </div>

      {/* 参数卡 */}
      <div className="grid gap-4 rounded-xl border border-line bg-panel shadow-sm p-4 md:grid-cols-2 xl:grid-cols-4">
        <label className="block text-xs text-dim">
          <span className="font-medium text-fg">
            t = {t} / {tokenCount}
          </span>
          <span className="ml-2">{tokenLabel(token)}</span>
          <input
            type="range"
            min={1}
            max={tokenCount}
            step={1}
            value={t}
            onChange={(e) => {
              setPlaying(false)
              setT(clampT(+e.target.value))
            }}
            className="mt-2 w-full"
          />
          <span className="mt-1 block font-mono text-[11px]">
            k = ({token.kRaw.map((x) => fmt(x)).join(', ')}) · v = ({token.v.map((x) => fmt(x)).join(', ')})
          </span>
        </label>

        <label className="block text-xs text-dim">
          <span className="font-medium text-fg">β 写入力度 = {fmt(beta)}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={beta}
            onChange={(e) => setBeta(+e.target.value)}
            className="mt-2 w-full"
          />
          <span className="mt-1 block text-[11px]">0 = 一笔不写 · 1 = 完全覆盖（对 DeltaNet / Gated / KDA 同时生效）</span>
        </label>

        <label className="block text-xs text-dim">
          <span className="font-medium text-fg">Gated 标量 α = {fmt(alphaScalar)}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={alphaScalar}
            onChange={(e) => setAlphaScalar(+e.target.value)}
            className="mt-2 w-full"
          />
          <span className="mt-1 block text-[11px]">整张状态每步统一乘这个数——所有通道同快同慢</span>
        </label>

        <div className="text-xs text-dim">
          <span className="font-medium text-fg">KDA 逐通道 α</span>
          <span className="ml-2 font-mono">({alphaVec.map((x) => fmt(x)).join(', ')})</span>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
            {alphaVec.map((a, i) => (
              <label key={i} className="flex items-center gap-2">
                <span className="w-10 shrink-0 font-mono text-[11px]">c{i + 1}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={a}
                  onChange={(e) => setChannelAlpha(i, +e.target.value)}
                  className="w-full"
                />
              </label>
            ))}
          </div>
          <span className="mt-1 block text-[11px]">每个 key 通道各自决定记多久——这是 KDA 相对标量门的核心自由度</span>
        </div>
      </div>

      {/* 四变体并排状态热力图 */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {VARIANT_ORDER.map((id) => {
          const meta = VARIANT_META[id]
          const step = selectStep(trace, id, t)
          const err = point ? point[id] : 0
          return (
            <div key={id} className="rounded-xl border border-line bg-panel shadow-sm p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${meta.badgeClass}`}>{meta.short}</span>
                <span className="ml-auto font-mono text-xs text-dim">误差 {fmt(err)}</span>
              </div>
              <MatrixHeatmap matrix={step.sAfter} maxAbs={sharedMaxAbs} cellSize="sm" changedFrom={step.sBefore} />
              <div className="mt-2">
                <VectorStrip vec={step.output} label="读出 o = Sₜ·k" maxAbs={sharedMaxAbs} cellSize="sm" />
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-dim">{meta.tagline}</p>
            </div>
          )
        })}
      </div>
      <p className="text-[11px] text-dim">
        四张热力图共享同一色标（当前 maxAbs = {fmt(sharedMaxAbs)}，取自四变体全部 8 步的最大绝对值）：
        同一个数值在四张图里颜色一致，可以直接横向比较深浅。格色只表示数值正负与幅值，与下方曲线的变体系列色无关。
      </p>

      {/* 误差曲线 */}
      <div className="rounded-xl border border-line bg-panel shadow-sm p-5">
        <div className="mb-1 flex flex-wrap items-center gap-3">
          <h4 className="text-sm font-semibold">检索误差随写入步数的变化</h4>
          <span className="text-xs text-dim">点击图表任意位置可跳到该步；点击图例可隐藏某条曲线</span>
        </div>
        <p className="mb-3 text-xs text-dim">
          纵轴 = 第 t 步对已写入的每个 key 各读一次、误差 ‖读出 − 当前应答‖₂ 的均值（覆盖写之后目标切换为最新写入值）。
        </p>
        <div className="h-72 w-full">
          <ResponsiveContainer>
            <LineChart
              data={chartData as ErrorChartPoint[]}
              margin={{ top: 8, right: 24, bottom: 4, left: 8 }}
              onClick={(e) => {
                const label = e?.activeLabel
                if (label !== undefined && label !== null) {
                  setPlaying(false)
                  setT(clampT(Number(label)))
                }
              }}
            >
              <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="t"
                stroke={INK_MUTED}
                tick={{ fill: INK_MUTED, fontSize: 11 }}
                label={{ value: 'token 步 t', position: 'insideBottomRight', offset: -2, fill: INK_MUTED, fontSize: 11 }}
              />
              <YAxis
                stroke={INK_MUTED}
                tick={{ fill: INK_MUTED, fontSize: 11 }}
                label={{ value: '误差均值', angle: -90, position: 'insideLeft', fill: INK_MUTED, fontSize: 11 }}
              />
              <Tooltip
                contentStyle={{
                  background: '#ffffff',
                  border: '1px solid #e3ded1',
                  borderRadius: 8,
                  fontSize: 12,
                  boxShadow: '0 4px 12px rgba(33,31,26,0.08)',
                  color: '#211f1a',
                }}
                labelStyle={{ color: INK_MUTED }}
                formatter={(v: number, name: string) => [fmt(v), VARIANT_META[name as VariantId]?.short ?? name]}
                labelFormatter={(v) => `t = ${v}`}
              />
              <Legend
                onClick={(e) => {
                  const id = (e as { dataKey?: unknown }).dataKey
                  if (typeof id === 'string') toggleVariant(id as VariantId)
                }}
                formatter={(v) => (
                  <span
                    style={{
                      color: INK_MUTED,
                      fontSize: 12,
                      cursor: 'pointer',
                      textDecoration: hidden.includes(v as VariantId) ? 'line-through' : 'none',
                    }}
                  >
                    {VARIANT_META[v as VariantId]?.short ?? v}
                  </span>
                )}
              />
              <ReferenceLine
                x={t}
                stroke={ACCENT}
                strokeDasharray="4 4"
                label={{ value: `t=${t}`, fill: ACCENT, fontSize: 11, position: 'insideTopRight' }}
              />
              {VARIANT_ORDER.map((id) => (
                <Line
                  key={id}
                  type="monotone"
                  dataKey={id}
                  stroke={VARIANT_META[id].color}
                  strokeWidth={id === 'kda' ? 2.5 : 2}
                  dot={{ r: 2 }}
                  activeDot={{ r: 4 }}
                  hide={hidden.includes(id)}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 观察要点 */}
      <div className="rounded-xl border border-line bg-panel shadow-sm p-5">
        <h4 className="mb-2 text-sm font-semibold text-accent">观察要点</h4>
        <ul className="list-inside list-disc space-y-1.5 text-sm leading-relaxed text-dim">
          {LAB_TAKEAWAYS.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-dim">
          注：「分块并行」tab 固定使用场景默认参数，不受这里的滑块影响——分块是恒等变形演示，参数随滑块漂移只会增加困惑。
        </p>
      </div>
    </div>
  )
}
