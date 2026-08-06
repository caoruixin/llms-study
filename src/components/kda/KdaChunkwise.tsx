// Tab3 分块并行（PLAN-kda-demo.md §6.1）：递推 vs 分块（WY 表示）的逐块数值对照。
//
// 数据一致性：本 tab 固定使用场景默认参数（引擎的 chunked 分支恒用 scenario.defaults，
// 不受实验室滑块影响）；恒等徽章直接显示引擎算好的 maxAbsDiffVsRecurrent，UI 不重算；
// 差值矩阵用引擎的 subMat，组件内不手写任何数学。
import { useMemo, useState } from 'react'
import {
  buildKdaTrace,
  selectChunk,
  selectStep,
  subMat,
  type ChunkStage,
  type Mat,
} from '../../lib/kdaEngine'
import {
  CHUNK_INTRO,
  CHUNK_MATRIX_LABELS,
  CHUNK_MATRIX_NOTES,
  CHUNK_VIEWS,
  type ChunkMatrixKey,
} from '../../data/kda'
import Formula, { type MathNode } from './Formula'
import MatrixHeatmap from './MatrixHeatmap'
import SegmentedTabs from '../ui/SegmentedTabs'

const IDENTITY_TOL = 1e-10

function maxAbsOf(...mats: readonly Mat[]): number {
  let m = 1e-9
  for (const mat of mats) for (const row of mat) for (const x of row) m = Math.max(m, Math.abs(x))
  return m
}

function sym(text: string, opts: { sub?: string; sup?: string } = {}): MathNode {
  return { kind: 'sym', text, ...opts }
}
const op = (text: string): MathNode => ({ kind: 'op', text })

const CHUNK_FORMULAS: { readonly label: string; readonly nodes: MathNode[] }[] = [
  {
    label: '衰减折叠：三份 key',
    nodes: [
      sym('K', { sup: '+' }),
      op('行t = '),
      sym('k', { sub: 't' }),
      op('⊙'),
      sym('γ', { sub: 't' }),
      op('，'),
      sym('K', { sup: '−' }),
      op('行t = '),
      sym('k', { sub: 't' }),
      op('⊙'),
      sym('γ', { sub: 't', sup: '−1' }),
      op('，'),
      sym('K̂'),
      op('行t = '),
      sym('k', { sub: 't' }),
      op('⊙'),
      op('('),
      sym('γ', { sub: 'C' }),
      op('/'),
      sym('γ', { sub: 't' }),
      op(')'),
    ],
  },
  {
    label: '广义 UT 变换',
    nodes: [
      sym('T'),
      op('='),
      op('('),
      sym('I'),
      op('+ tril('),
      op('diag('),
      sym('β'),
      op(')'),
      sym('K', { sup: '+' }),
      op('('),
      sym('K', { sup: '−' }),
      op(')'),
      sym('', { sup: 'T' }),
      op(', −1))'),
      sym('', { sup: '−1' }),
      op('·'),
      op('diag('),
      sym('β'),
      op(')'),
    ],
  },
  {
    label: '块内残差与块尾结算',
    nodes: [
      sym('X'),
      op('='),
      sym('T'),
      op('('),
      sym('V'),
      op('−'),
      sym('K', { sup: '+' }),
      sym('S', { sub: 'in', sup: 'T' }),
      op(')'),
      op('，'),
      sym('S', { sub: 'out' }),
      op('='),
      sym('S', { sub: 'in' }),
      op('Diag('),
      sym('γ', { sub: 'C' }),
      op(')'),
      op('+'),
      sym('X', { sup: 'T' }),
      sym('K̂'),
    ],
  },
  {
    label: '块内读出',
    nodes: [
      sym('O'),
      op('='),
      sym('Q', { sup: '+' }),
      sym('S', { sub: 'in', sup: 'T' }),
      op('+ tril_incl('),
      sym('Q', { sup: '+' }),
      op('('),
      sym('K', { sup: '−' }),
      op(')'),
      sym('', { sup: 'T' }),
      op(')'),
      sym('X'),
    ],
  },
  {
    label: 'α ≡ 1 退化：经典 DeltaNet WY',
    nodes: [
      sym('W'),
      op('='),
      sym('T'),
      sym('K'),
      op('，'),
      sym('U'),
      op('='),
      sym('T'),
      sym('V'),
      op('，'),
      sym('S', { sub: 'out' }),
      op('='),
      sym('S', { sub: 'in' }),
      op('('),
      sym('I'),
      op('−'),
      sym('W', { sup: 'T' }),
      sym('K'),
      op(')'),
      op('+'),
      sym('U', { sup: 'T' }),
      sym('K'),
    ],
  },
]

function MatrixCard({
  matrixKey,
  matrix,
  maxAbs,
  emphasis,
}: {
  matrixKey: ChunkMatrixKey
  matrix: Mat
  maxAbs?: number
  emphasis?: boolean
}) {
  return (
    <div className={`rounded-lg border p-3 ${emphasis ? 'border-accent bg-accent/10 shadow-sm' : 'border-line bg-panel-2'}`}>
      <MatrixHeatmap matrix={matrix} title={CHUNK_MATRIX_LABELS[matrixKey]} maxAbs={maxAbs} cellSize="sm" />
      <p className="mt-1.5 max-w-lg text-[11px] leading-relaxed text-dim">{CHUNK_MATRIX_NOTES[matrixKey]}</p>
    </div>
  )
}

function Arrow() {
  return (
    <div className="py-0.5 text-center text-dim" aria-hidden="true">
      ↓
    </div>
  )
}

export default function KdaChunkwise() {
  const trace = useMemo(() => buildKdaTrace(), [])
  const [view, setView] = useState<'deltanet' | 'kda'>('kda')
  const [chunkIndex, setChunkIndex] = useState(0)

  const chunked = trace.chunked[view]
  const chunkCount = chunked.chunks.length
  const i = Math.max(0, Math.min(chunkCount - 1, chunkIndex))
  const chunk: ChunkStage = selectChunk(trace, view, i)
  const [startT, endT] = chunk.tokenRange
  const viewMeta = CHUNK_VIEWS.find((v) => v.id === view)!

  // 左栏：块内逐 token 递推状态（同一变体的 recurrent trace）
  const recurrentSteps = Array.from({ length: endT - startT + 1 }, (_, j) => selectStep(trace, view, startT + j))
  const recurrentSOut = recurrentSteps[recurrentSteps.length - 1].sAfter
  const prevSOut = i > 0 ? selectChunk(trace, view, i - 1).sOut : null

  const stateMaxAbs = maxAbsOf(...recurrentSteps.map((s) => s.sAfter), chunk.sIn, chunk.sOut)
  const diff = subMat(recurrentSOut, chunk.sOut)
  const identical = chunked.maxAbsDiffVsRecurrent < IDENTITY_TOL

  return (
    <div className="space-y-4">
      {/* 顶栏：说明 + 子视图 + chunk 步进 + 恒等徽章 */}
      <div className="space-y-3 rounded-xl border border-line bg-panel shadow-sm p-4">
        <p className="text-sm leading-relaxed text-dim">{CHUNK_INTRO}</p>
        {/* 与 Tab1/Tab2 同一副表述：本 tab 有 20+ 张热力图，色彩语义必须常驻说明 */}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: 'var(--color-accent)' }} />
            格色 = 数值正负：酒红为正
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: 'var(--color-accent-2)' }} />
            深紫为负
          </span>
          <span>色深 = 幅值（并排的矩阵若共享色标会在标题下注明）</span>
        </p>
        <SegmentedTabs
          tabs={CHUNK_VIEWS.map((v) => ({ id: v.id, label: v.label }))}
          value={view}
          onChange={(v) => {
            setView(v)
            setChunkIndex(0)
          }}
        />
        <p className="text-xs leading-relaxed text-dim">{viewMeta.desc}</p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setChunkIndex(Math.max(0, i - 1))}
            disabled={i <= 0}
            className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-fg hover:bg-panel-2 disabled:opacity-40"
          >
            ◀ 上一块
          </button>
          <span className="font-mono text-sm">
            chunk {i + 1} / {chunkCount}
          </span>
          <button
            type="button"
            onClick={() => setChunkIndex(Math.min(chunkCount - 1, i + 1))}
            disabled={i >= chunkCount - 1}
            className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-fg hover:bg-panel-2 disabled:opacity-40"
          >
            下一块 ▶
          </button>
          <span className="text-xs text-dim">
            token {startT}–{endT}（chunkSize = {chunked.chunkSize}）
          </span>
          <span
            className={`ml-auto rounded-lg border px-3 py-1.5 font-mono text-xs ${
              identical ? 'border-ok/40 bg-ok/10 text-ok' : 'border-bad/40 bg-bad/10 text-bad'
            }`}
          >
            max|S₍递推₎ − S₍分块₎| = {chunked.maxAbsDiffVsRecurrent.toExponential(1)}
            {identical ? ' ✓ 浮点精度内一致' : ' ✗ 超出容差'}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-4 xl:flex-row">
        {/* 左：逐 token recurrent */}
        <div className="min-w-0 xl:w-[380px] xl:shrink-0">
          <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
            <h4 className="mb-1 text-sm font-semibold">串行路径：逐 token 递推</h4>
            <p className="mb-3 text-[11px] leading-relaxed text-dim">
              第 t 步必须等第 t−1 步算完——推理时天然如此，训练时会把 GPU 饿死。
            </p>
            <div className="overflow-x-auto">
              <div className="flex min-w-max items-start gap-2">
                {recurrentSteps.map((s, j) => (
                  <div key={s.t} className="flex items-start gap-2">
                    {j > 0 && (
                      <div className="pt-6 text-dim" aria-hidden="true">
                        →
                      </div>
                    )}
                    <MatrixHeatmap
                      matrix={s.sAfter}
                      title={`t=${s.t}`}
                      maxAbs={stateMaxAbs}
                      cellSize="sm"
                      changedFrom={s.sBefore}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-3 rounded-lg border border-accent bg-accent/10 shadow-sm p-3">
              <MatrixHeatmap matrix={recurrentSOut} title={`块尾状态（t=${endT} 的 Sₜ）`} maxAbs={stateMaxAbs} cellSize="sm" />
            </div>
          </div>
        </div>

        {/* 右：分块 WY 流程 */}
        <div className="min-w-0 flex-1">
          <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
            <h4 className="mb-1 text-sm font-semibold">并行路径：分块 WY 表示</h4>
            <p className="mb-3 text-[11px] leading-relaxed text-dim">
              块内全部依赖被一次性解开成矩阵乘，只有「上一块 → 下一块」这一条串行边。以下每个中间量都取自引擎，未做任何近似。
            </p>

            <div className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <MatrixCard matrixKey="K" matrix={chunk.K} />
                <MatrixCard matrixKey="V" matrix={chunk.V} />
              </div>

              {view === 'kda' && (
                <>
                  <Arrow />
                  <div className="grid gap-2 sm:grid-cols-2">
                    <MatrixCard matrixKey="gammas" matrix={chunk.gammas} />
                    <MatrixCard matrixKey="kPlus" matrix={chunk.kPlus} />
                    <MatrixCard matrixKey="kMinus" matrix={chunk.kMinus} />
                    <MatrixCard matrixKey="kHat" matrix={chunk.kHat} />
                  </div>
                  <p className="text-[11px] leading-relaxed text-dim">
                    γ 在每个块内从 1 重新累积（跨块的衰减由块尾的 Diag(γ_C) 一次性结算），所以每块的 γ 表都一样——
                    这正是「块内并行、块间串行」的边界。
                  </p>
                </>
              )}

              <Arrow />
              <MatrixCard matrixKey="gram" matrix={chunk.gram} />
              <Arrow />
              <MatrixCard matrixKey="T" matrix={chunk.T} />
              <Arrow />
              <div className="grid gap-2 sm:grid-cols-2">
                <MatrixCard matrixKey="W" matrix={chunk.W} />
                <MatrixCard matrixKey="U" matrix={chunk.U} />
              </div>
              <Arrow />
              <div className="grid gap-2 sm:grid-cols-2">
                <MatrixCard matrixKey="sIn" matrix={chunk.sIn} maxAbs={stateMaxAbs} />
                <MatrixCard matrixKey="vEff" matrix={chunk.vEff} />
              </div>
              {prevSOut && (
                <div className="rounded-lg border border-line bg-panel-2 p-3">
                  <MatrixHeatmap
                    matrix={prevSOut}
                    title={`上一块（chunk ${i}）的 sOut`}
                    maxAbs={stateMaxAbs}
                    cellSize="sm"
                  />
                  <p className="mt-1.5 text-[11px] leading-relaxed text-dim">
                    跨块唯一的串行依赖：本块的 sIn 就是上一块的 sOut，两张图应当逐格相同。
                  </p>
                </div>
              )}
              <Arrow />
              <MatrixCard matrixKey="X" matrix={chunk.X} />
              <Arrow />
              <div className="text-center text-xs text-dim">一次矩阵乘结算整块</div>
              <div className="grid gap-2 sm:grid-cols-2">
                <MatrixCard matrixKey="sOut" matrix={chunk.sOut} maxAbs={stateMaxAbs} emphasis />
                <MatrixCard matrixKey="outputs" matrix={chunk.outputs} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 对照卡 */}
      <div className="rounded-xl border border-line bg-panel shadow-sm p-5">
        <h4 className="mb-3 text-sm font-semibold">两条路径的块尾状态对照</h4>
        <div className="flex flex-wrap items-start gap-5">
          <MatrixHeatmap matrix={recurrentSOut} title="递推路径 S_out" maxAbs={stateMaxAbs} cellSize="md" />
          <MatrixHeatmap matrix={chunk.sOut} title="分块路径 S_out" maxAbs={stateMaxAbs} cellSize="md" />
          <div>
            <MatrixHeatmap matrix={diff} title="逐元素差值（与左侧共享色标）" maxAbs={stateMaxAbs} cellSize="md" />
            <p className="mt-1.5 max-w-xs text-[11px] leading-relaxed text-dim">
              在与两侧相同的色标下差值完全不可见——本块最大差值 {maxAbsOf(diff).toExponential(1)}，
              全序列最大差值 {chunked.maxAbsDiffVsRecurrent.toExponential(1)}，属双精度浮点舍入量级。
              分块是恒等变形而非近似：如果这里出现肉眼可见的颜色，那是实现出了 bug，不该靠放宽容差掩盖。
            </p>
          </div>
        </div>
      </div>

      {/* 公式对照 */}
      <details className="rounded-xl border border-line bg-panel shadow-sm p-5">
        <summary className="cursor-pointer text-sm font-semibold">公式对照（点开）</summary>
        <div className="mt-3 space-y-3">
          {CHUNK_FORMULAS.map((f) => (
            <div key={f.label} className="rounded-lg border border-line bg-panel-2 p-3">
              <div className="mb-1.5 text-xs font-medium text-dim">{f.label}</div>
              <Formula nodes={f.nodes} size="sm" />
            </div>
          ))}
          <p className="text-[11px] leading-relaxed text-dim">
            T 用单位下三角前代求解得到，不做通用矩阵求逆；K⁻ 含 γ⁻¹，α 过小会指数放大，所以分块路径要求每通道 α
            有下界（递推路径没有这个限制）。
          </p>
        </div>
      </details>
    </div>
  )
}
