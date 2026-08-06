// Tab1 原理推导（PLAN-kda-demo.md §6.1）：五阶段进度 → 主卡（双态公式 + 热力图算式 + 讲解）→ 步进条 → 图例。
//
// 数据一致性：本组件不持有任何场景默认值，也不做任何数学运算——
// trace 由 buildKdaTrace() 默认参数构建，每个视图渲染的都是 TokenStep 上已有的字段，
// 数字一律经引擎 fmt 格式化。
import { useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { buildKdaTrace, fmt, selectStep, type Mat, type TokenStep, type Vec, type VariantId } from '../../lib/kdaEngine'
import { DERIV_PHASES, KDA_DERIV_STEPS, tokenLabel, VARIANT_META, type DerivStep } from '../../data/kda'
import Formula, { FormulaLegend, type MathNode, type ScalarKey } from './Formula'
import MatrixHeatmap, { VectorStrip } from './MatrixHeatmap'
import StepControls from './StepControls'

// ─────────── 小工具（只做取值与取最大值，不做数学变换） ───────────

function maxAbsOfMats(...mats: readonly Mat[]): number {
  let m = 1e-9
  for (const mat of mats) for (const row of mat) for (const x of row) m = Math.max(m, Math.abs(x))
  return m
}

function maxAbsOfVecs(...vecs: readonly Vec[]): number {
  let m = 1e-9
  for (const v of vecs) for (const x of v) m = Math.max(m, Math.abs(x))
  return m
}

function diagOf(m: Mat): Vec {
  return m.map((row, i) => row[i])
}

function isAllOnes(v: Vec): boolean {
  return v.every((x) => x === 1)
}

function Conn({ text }: { text: string }) {
  return (
    <div className="flex shrink-0 items-center px-1 pt-5 text-base text-dim" aria-hidden="true">
      {text}
    </div>
  )
}

// ─────────── 视图块 ───────────

function StateEquation({ step }: { step: TokenStep }) {
  const decayed = step.kind === 'delta' && !isAllOnes(step.alpha)
  const maxAbs = maxAbsOfMats(
    step.sBefore,
    step.sAfter,
    step.writeOuter,
    step.kind === 'delta' ? step.sDecayed : step.sBefore,
  )
  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-max items-start gap-1">
        <MatrixHeatmap matrix={step.sBefore} title="S₍ₜ₋₁₎ 写入前" maxAbs={maxAbs} cellSize="sm" />
        {decayed && step.kind === 'delta' && (
          <>
            <Conn text="×" />
            <div className="pt-5">
              <VectorStrip vec={step.alpha} label="Diag(α) 对角" maxAbs={maxAbsOfVecs(step.alpha)} cellSize="sm" />
            </div>
            <Conn text="=" />
            <MatrixHeatmap matrix={step.sDecayed} title="衰减后" maxAbs={maxAbs} cellSize="sm" changedFrom={step.sBefore} />
          </>
        )}
        <Conn text="+" />
        <MatrixHeatmap
          matrix={step.writeOuter}
          title={step.kind === 'naive' ? 'v·kᵀ 写入项' : 'β·u·kᵀ 残差写入'}
          maxAbs={maxAbs}
          cellSize="sm"
        />
        <Conn text="→" />
        <MatrixHeatmap
          matrix={step.sAfter}
          title="Sₜ 写入后"
          maxAbs={maxAbs}
          cellSize="sm"
          changedFrom={step.kind === 'delta' && decayed ? step.sDecayed : step.sBefore}
        />
      </div>
    </div>
  )
}

function Readout({ step }: { step: TokenStep }) {
  const maxAbs = maxAbsOfVecs(step.k, step.v, step.output)
  return (
    <div className="flex flex-wrap items-end gap-3">
      <VectorStrip vec={step.k} label="q = k（归一化）" maxAbs={maxAbs} cellSize="sm" />
      <Conn text="→" />
      <VectorStrip vec={step.output} label="o = Sₜ·q 读出" maxAbs={maxAbs} cellSize="sm" />
      <Conn text="vs" />
      <VectorStrip vec={step.v} label="v 目标" maxAbs={maxAbs} cellSize="sm" />
    </div>
  )
}

function Prediction({ step }: { step: TokenStep }) {
  if (step.kind !== 'delta') return null
  const maxAbs = maxAbsOfVecs(step.prediction, step.v, step.residual)
  return (
    <div className="flex flex-wrap items-end gap-3">
      <VectorStrip vec={step.prediction} label="v̂ = S·Diag(α)·k 当前预测" maxAbs={maxAbs} cellSize="sm" />
      <Conn text="vs" />
      <VectorStrip vec={step.v} label="v 目标" maxAbs={maxAbs} cellSize="sm" />
      <Conn text="⇒" />
      <div>
        <VectorStrip vec={step.residual} label="u = v − v̂ 残差" maxAbs={maxAbs} cellSize="sm" />
        <div className="mt-1 text-[11px] text-accent">残差决定这一步写多少</div>
      </div>
    </div>
  )
}

function Transition({ step }: { step: TokenStep }) {
  if (step.kind !== 'delta') return null
  return (
    <div className="flex flex-wrap items-start gap-4">
      <MatrixHeatmap matrix={step.transition.full} title="转移矩阵 Aₜ = Diag(α)(I − βkkᵀ)" cellSize="sm" />
      <p className="max-w-md text-xs leading-relaxed text-dim">
        对角线 {diagOf(step.transition.full).map((x) => fmt(x)).join(' / ')}：值为 0 的通道被本步清空，值接近 1 的通道原样透传。
        非对角元来自 −β·k·kᵀ 那一项，只在 key 的非零通道之间产生耦合。
      </p>
    </div>
  )
}

function GateCompare({ gated, kda }: { gated: TokenStep; kda: TokenStep }) {
  if (gated.kind !== 'delta' || kda.kind !== 'delta') return null
  const maxAbs = maxAbsOfMats(gated.transition.full, kda.transition.full)
  return (
    <div className="flex flex-wrap items-start gap-5">
      <div>
        <MatrixHeatmap matrix={gated.transition.full} title="Gated：标量门 A" maxAbs={maxAbs} cellSize="sm" />
        <div className="mt-1 text-[11px] text-dim">α = {gated.alpha.map((x) => fmt(x)).join(' / ')}（各通道相同）</div>
      </div>
      <div>
        <MatrixHeatmap matrix={kda.transition.full} title="KDA：对角门 A" maxAbs={maxAbs} cellSize="sm" />
        <div className="mt-1 text-[11px] text-accent">α = {kda.alpha.map((x) => fmt(x)).join(' / ')}（逐通道不同）</div>
      </div>
    </div>
  )
}

function Dplr({ step }: { step: TokenStep }) {
  if (step.kind !== 'delta') return null
  const { diag, lowRankA, lowRankB } = step.transition
  const maxAbs = maxAbsOfVecs(diag, lowRankA, lowRankB)
  return (
    <div className="flex flex-wrap items-end gap-3">
      <VectorStrip vec={diag} label="Diag 部分 = α" maxAbs={maxAbs} cellSize="sm" />
      <Conn text="+" />
      <VectorStrip vec={lowRankA} label="a = −β(α⊙k)" maxAbs={maxAbs} cellSize="sm" />
      <Conn text="⊗" />
      <VectorStrip vec={lowRankB} label="b = k（绑定同一个 k）" maxAbs={maxAbs} cellSize="sm" />
      <Conn text="=" />
      <MatrixHeatmap matrix={step.transition.full} title="重构出的 Aₜ" cellSize="sm" />
    </div>
  )
}

function Probes({ step }: { step: TokenStep }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-xs">
        <thead className="text-left text-dim">
          <tr>
            <th className="py-1 pr-3 font-medium">探针 key</th>
            <th className="py-1 pr-3 font-medium">读出 Sₜ·k</th>
            <th className="py-1 pr-3 font-medium">当前应答</th>
            <th className="py-1 pr-3 font-medium text-right">误差 ‖·‖₂</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {step.retrieval.map((p) => (
            <tr key={p.srcT} className="border-t border-line">
              <td className="py-1 pr-3">k{p.srcT}</td>
              <td className="py-1 pr-3">({p.retrieved.map((x) => fmt(x)).join(', ')})</td>
              <td className="py-1 pr-3">
                ({p.target.map((x) => fmt(x)).join(', ')})
                {p.targetT !== p.srcT && <span className="ml-1 font-sans text-[10px] text-accent">← t{p.targetT} 覆盖</span>}
              </td>
              <td className={`py-1 pr-3 text-right ${p.errorL2 < 1e-9 ? 'text-ok' : 'text-fg'}`}>{fmt(p.errorL2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5 font-sans text-[11px] text-dim">
        「当前应答」＝该 key 最新一次写入的 value：覆盖写之后目标随之切换，所以覆盖成功表现为误差归零而不是升高。
      </p>
    </div>
  )
}

function TransitionChain({ steps }: { steps: readonly TokenStep[] }) {
  const rows: number[][] = []
  const labels: string[] = []
  for (const s of steps) {
    if (s.kind !== 'delta') continue
    rows.push([...diagOf(s.transition.full)])
    labels.push(`A${s.t}`)
  }
  if (rows.length === 0) return null
  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="flex items-start gap-2">
        <div className="flex flex-col gap-px pt-6 text-[10px] leading-7 text-dim">
          {labels.map((l) => (
            <span key={l} className="h-7 leading-7">
              {l}
            </span>
          ))}
        </div>
        <MatrixHeatmap matrix={rows} title="逐步转移矩阵的对角线（行 = 第几步，列 = key 通道）" cellSize="sm" />
      </div>
      <p className="max-w-md text-xs leading-relaxed text-dim">
        从上往下读就是一条乘性衰减链：某一列一路接近 1，说明该通道把早期写入完整带到了当前步；
        某一列反复出现小值或 0，说明该通道的记忆被快速冲刷。位置信息就编码在这串乘积里——不需要额外的 RoPE。
      </p>
    </div>
  )
}

// ─────────── 主组件 ───────────

function buildScalars(step: TokenStep): Partial<Record<ScalarKey, number>> {
  const scalars: Partial<Record<ScalarKey, number>> = { t: step.t }
  const last = step.retrieval[step.retrieval.length - 1]
  if (last) scalars.retrievalErr = last.errorL2
  if (step.kind === 'delta') {
    scalars.beta = step.beta
    scalars.residualNorm = Math.sqrt(step.residual.reduce((a, x) => a + x * x, 0))
    // α 为向量时不提供 alphaMean：用均值代入会把「逐通道」的核心卖点抹平成一个假标量
    if (isAllOnes(step.alpha) || step.alpha.every((x) => x === step.alpha[0])) scalars.alphaMean = step.alpha[0]
  }
  return scalars
}

// 公式里是否存在「能被当前 step 解析出数值」的绑定符号；没有就不渲染代入式那一行
// （否则两行完全相同，读者会以为代入没生效）
function hasResolvableBind(nodes: readonly MathNode[], scalars: Partial<Record<ScalarKey, number>>): boolean {
  for (const n of nodes) {
    if (n.kind === 'sym' && n.bind !== undefined && scalars[n.bind] !== undefined) return true
    if ((n.kind === 'group' || n.kind === 'stack') && hasResolvableBind(n.children, scalars)) return true
  }
  return false
}

function ViewBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 p-3">
      <div className="mb-2 text-xs font-semibold text-dim">{title}</div>
      {children}
    </div>
  )
}

export default function KdaDerivation() {
  const trace = useMemo(() => buildKdaTrace(), [])
  const [index, setIndex] = useState(0)

  const current: DerivStep = KDA_DERIV_STEPS[index]
  const step = selectStep(trace, current.variant, current.tokenT)
  const token = trace.scenario.tokens[current.tokenT - 1]
  const meta = VARIANT_META[current.variant as VariantId]
  const scalars = buildScalars(step)
  const has = (v: DerivStep['views'][number]) => current.views.includes(v)

  const chainSteps: readonly TokenStep[] = has('transition-chain')
    ? Array.from({ length: current.tokenT }, (_, i) => selectStep(trace, current.variant, i + 1))
    : []

  const clamp = (i: number) => Math.max(0, Math.min(KDA_DERIV_STEPS.length - 1, i))

  return (
    <div className="space-y-4">
      {/* 五阶段进度 */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-line bg-panel shadow-sm px-4 py-3">
        {DERIV_PHASES.map((phase) => {
          const active = current.phase === phase.id
          return (
            <div key={phase.id} className="flex items-center gap-2">
              <span className={`text-xs ${active ? 'font-semibold text-accent' : 'text-dim'}`}>{phase.label}</span>
              <div className="flex gap-1">
                {KDA_DERIV_STEPS.map((s, i) => {
                  if (s.phase !== phase.id) return null
                  return (
                    <button
                      key={s.id}
                      type="button"
                      title={s.title}
                      aria-label={s.title}
                      onClick={() => setIndex(i)}
                      className={`h-2.5 w-2.5 rounded-full transition-colors ${
                        i === index ? 'bg-accent' : i < index ? 'bg-accent/40' : 'bg-line hover:bg-accent/30'
                      }`}
                    />
                  )
                })}
              </div>
            </div>
          )
        })}
        <span className="ml-auto text-[11px] text-dim">{DERIV_PHASES.find((p) => p.id === current.phase)?.hint}</span>
      </div>

      {/* 主卡 */}
      <AnimatePresence mode="wait">
        <motion.div
          key={current.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.22 }}
          className="space-y-4 rounded-xl border border-line bg-panel shadow-sm p-5"
        >
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-lg font-bold">{current.title}</h3>
            <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${meta.badgeClass}`}>{meta.short}</span>
            <span className="rounded border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-dim">
              {tokenLabel(token)}
            </span>
          </div>

          {/* 公式双态：符号式 + 代入当前 trace 数值 */}
          <div className="space-y-2 rounded-lg border border-line bg-panel-2 p-3">
            <Formula nodes={current.formula} size="md" />
            {hasResolvableBind(current.formula, scalars) && (
              <div className="flex flex-wrap items-baseline gap-2 border-t border-line pt-2">
                <span className="shrink-0 text-[11px] text-dim">代入 t={step.t} 实测值</span>
                <Formula nodes={current.formula} size="sm" substitute scalars={scalars} />
              </div>
            )}
          </div>

          {/* 数值视图 */}
          <div className="space-y-3">
            {has('state-equation') && (
              <ViewBlock title="状态变换算式（矩阵按格取色：酒红为正、深紫为负，深浅为幅值）">
                <StateEquation step={step} />
              </ViewBlock>
            )}
            {has('prediction') && (
              <ViewBlock title="写入前先读：预测 / 目标 / 残差">
                <Prediction step={step} />
              </ViewBlock>
            )}
            {has('transition') && (
              <ViewBlock title="转移矩阵">
                <Transition step={step} />
              </ViewBlock>
            )}
            {has('gate-compare') && (
              <ViewBlock title="标量门 vs 对角门（同一 token 的转移矩阵并排）">
                <GateCompare
                  gated={selectStep(trace, 'gated', current.tokenT)}
                  kda={selectStep(trace, 'kda', current.tokenT)}
                />
              </ViewBlock>
            )}
            {has('dplr') && (
              <ViewBlock title="DPLR 分解：对角 + 秩 1">
                <Dplr step={step} />
              </ViewBlock>
            )}
            {has('transition-chain') && (
              <ViewBlock title="转移矩阵连乘 = 数据依赖的位置编码">
                <TransitionChain steps={chainSteps} />
              </ViewBlock>
            )}
            {has('readout') && (
              <ViewBlock title="读出 o = Sₜ·q">
                <Readout step={step} />
              </ViewBlock>
            )}
            {has('probes') && (
              <ViewBlock title="检索探针：对已写入的每个 key 各读一次">
                <Probes step={step} />
              </ViewBlock>
            )}
          </div>

          {/* 讲解正文 */}
          <p className="text-sm leading-relaxed">{current.body(step, fmt)}</p>

          {current.sourceUrl && (
            <p className="text-[11px] text-dim">
              出处：
              <a href={current.sourceUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                {current.sourceUrl}
              </a>
              （{current.asOf}）
            </p>
          )}

          {current.interview && (
            <div className="rounded-lg border border-warn/30 bg-warn/10 p-3">
              <div className="mb-1 text-xs font-semibold tracking-wide text-warn">面试一句话</div>
              <p className="text-sm leading-relaxed">{current.interview}</p>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      <StepControls
        index={index}
        count={KDA_DERIV_STEPS.length}
        onChange={(i) => setIndex(clamp(i))}
        labels={KDA_DERIV_STEPS.map((s) => s.title)}
      />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-line bg-panel shadow-sm px-4 py-3">
        <FormulaLegend roles={['state', 'decay', 'beta', 'residual', 'input']} />
        <span className="text-[11px] text-dim">
          热力图格色表示数值本身（正=酒红 / 负=深紫，深浅=幅值），与公式的角色配色不是同一套语义。
        </span>
      </div>
    </div>
  )
}
