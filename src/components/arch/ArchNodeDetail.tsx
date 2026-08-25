// 右侧组件详情卡:注册表讲解(what/why/interview,跨图复用)+ 本图专属的 variantNote/detail。
// 形制沿用 StackExplorer 右栏 + TransformerDiagram 讲解面板。
import {
  ARCH_COMPONENTS,
  ARCH_LANES,
  type ArchComponentDef,
  type ArchComponentId,
  type ArchNode,
} from '../../data/archAtlas'

const COMPONENTS: Record<ArchComponentId, ArchComponentDef> = ARCH_COMPONENTS

export interface ArchNodeDetailProps {
  /** 当前选中的图内节点;null 表示未选中 */
  node: ArchNode | null
}

export default function ArchNodeDetail({ node }: ArchNodeDetailProps) {
  if (!node) {
    return (
      <div className="rounded-xl border border-line bg-panel shadow-sm p-5 text-sm leading-relaxed text-dim">
        点击图中任意组件,这里显示它的机制讲解、在本架构里的角色,以及客户常问要点。
      </div>
    )
  }

  const def = COMPONENTS[node.id]
  const lane = ARCH_LANES.find((l) => l.id === def.lane)

  return (
    <div className="rounded-xl border border-line bg-panel shadow-sm p-5">
      {lane && <div className="mb-1 text-xs font-semibold text-accent">{lane.name}</div>}
      <h3 className="text-lg font-bold">
        {def.name}
        {def.enName && <span className="ml-2 text-sm font-normal text-dim">{def.enName}</span>}
      </h3>
      {node.badge && (
        <span className="mt-2 inline-block rounded bg-accent-2/15 px-1.5 py-0.5 text-[11px] text-accent-2">
          {node.badge}
        </span>
      )}

      <div className="mt-4 space-y-4 text-sm leading-relaxed">
        <div>
          <div className="mb-1 text-xs font-semibold tracking-wide text-accent">是什么</div>
          <p>{def.what}</p>
        </div>

        {def.why && (
          <div>
            <div className="mb-1 text-xs font-semibold tracking-wide text-accent-2">为什么需要它</div>
            <p>{def.why}</p>
          </div>
        )}

        {node.variantNote && (
          <div className="rounded-lg border border-amber/40 bg-amber/10 p-3">
            <div className="mb-1 text-xs font-semibold tracking-wide text-amber">本架构中的角色</div>
            <p>{node.variantNote}</p>
          </div>
        )}

        {node.detail && (
          <div>
            <div className="mb-1 text-xs font-semibold tracking-wide text-dim">本图补充</div>
            <p className="text-dim">{node.detail}</p>
          </div>
        )}

        {def.interview && (
          <div className="rounded-lg border border-warn/30 bg-warn/10 p-3">
            <div className="mb-1 text-xs font-semibold tracking-wide text-warn">客户常问</div>
            <p>{def.interview}</p>
          </div>
        )}
      </div>
    </div>
  )
}
