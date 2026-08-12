import type { PlanIsland } from '../../lib/paper/blockSchemas'

/** plan 控制岛的 chip 行（§7.2）：层级/策略/概念，advisory 展示，坏岛时整行不出现 */
export default function PlanChip({ plan }: { plan: PlanIsland }) {
  return (
    <div className="my-1 flex flex-wrap items-center gap-1.5 text-[0.65rem]">
      {plan.level && (
        <span className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-accent">{plan.level}</span>
      )}
      {plan.strategy && (
        <span className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-dim">{plan.strategy}</span>
      )}
      {plan.concepts.slice(0, 4).map((c) => (
        <span key={c} className="rounded-full border border-line px-2 py-0.5 text-dim">
          {c}
        </span>
      ))}
    </div>
  )
}
