// 选型决策卡:问题/收益(带来源角标)/衡量指标/代价/何时不该用/GPU 规模。
// 「用显存墙计算器验证 →」仅在显式点击时把 memoryPreset 写入 useInferenceParams,再跳到显存墙 tab。
import type { ArchSource, DecisionCard } from '../../data/archAtlas'
import { useInferenceParams } from '../../store'

export interface ArchDecisionCardProps {
  decision: DecisionCard
  /** 用于把 benefits[].sourceIdx 渲染成可点的 [n] 角标 */
  sources: readonly ArchSource[]
  onJumpToMemory: () => void
}

export default function ArchDecisionCard({ decision, sources, onJumpToMemory }: ArchDecisionCardProps) {
  const setModelId = useInferenceParams((s) => s.setModelId)
  const setGpuId = useInferenceParams((s) => s.setGpuId)
  const setQuantId = useInferenceParams((s) => s.setQuantId)
  const setBatch = useInferenceParams((s) => s.setBatch)

  const applyPreset = () => {
    const p = decision.memoryPreset
    if (p) {
      if (p.modelId !== undefined) setModelId(p.modelId)
      if (p.gpuId !== undefined) setGpuId(p.gpuId)
      if (p.quantId !== undefined) setQuantId(p.quantId)
      if (p.batch !== undefined) setBatch(p.batch)
    }
    onJumpToMemory()
  }

  return (
    <div className="rounded-xl border border-line bg-panel shadow-sm p-5">
      <h3 className="text-base font-bold">选型决策卡</h3>

      <div className="mt-3 space-y-4 text-sm leading-relaxed">
        <div>
          <div className="mb-1 text-xs font-semibold tracking-wide text-accent">解决什么问题</div>
          <p>{decision.problem}</p>
        </div>

        <div>
          <div className="mb-1 text-xs font-semibold tracking-wide text-ok">收益(带实测来源)</div>
          <ul className="space-y-1">
            {decision.benefits.map((b, i) => {
              const src = b.sourceIdx !== undefined ? sources[b.sourceIdx] : undefined
              return (
                <li key={i}>
                  · {b.text}
                  {src && (
                    <a
                      href={src.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      title={src.title}
                      className="ml-0.5 align-super text-[10px] text-accent hover:underline"
                    >
                      [{(b.sourceIdx ?? 0) + 1}]
                    </a>
                  )}
                </li>
              )
            })}
          </ul>
        </div>

        <div>
          <div className="mb-1 text-xs font-semibold tracking-wide text-accent-2">衡量指标</div>
          <div className="flex flex-wrap gap-1.5">
            {decision.metrics.map((m) => (
              <span key={m} className="rounded border border-line bg-panel-2 px-2 py-0.5 text-xs">
                {m}
              </span>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1 text-xs font-semibold tracking-wide text-amber">代价</div>
          <ul className="space-y-1">
            {decision.costs.map((c) => (
              <li key={c}>· {c}</li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border border-warn/30 bg-warn/10 p-3">
          <div className="mb-1 text-xs font-semibold tracking-wide text-warn">何时不该用</div>
          <ul className="space-y-1">
            {decision.avoidWhen.map((a) => (
              <li key={a}>· {a}</li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-2 border-t border-line pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="mb-1 text-xs font-semibold tracking-wide text-dim">每实例 GPU 数量级</div>
            <p>{decision.gpuScale}</p>
          </div>
          <button
            type="button"
            onClick={applyPreset}
            className="shrink-0 rounded-lg border border-accent/50 bg-accent/10 px-3 py-2 text-sm text-accent transition-colors hover:bg-accent/20"
          >
            用显存墙计算器验证 →
          </button>
        </div>
      </div>
    </div>
  )
}
