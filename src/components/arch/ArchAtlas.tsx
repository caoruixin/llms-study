// 「架构图谱」主组件:二级切换(图谱 / 对比 / 总表)。
// 图谱视图沿用 StackExplorer 双栏形制:左列 = 架构说明 + 泳道图 + 决策卡 + 参考资料,右列 = sticky 组件详情。
import { useState } from 'react'
import { ARCH_DIAGRAMS, type ArchComponentId, type ArchId } from '../../data/archAtlas'
import SegmentedTabs from '../ui/SegmentedTabs'
import ArchCompare from './ArchCompare'
import ArchDecisionCard from './ArchDecisionCard'
import ArchDiagramCanvas from './ArchDiagramCanvas'
import ArchDimensionTable from './ArchDimensionTable'
import ArchNodeDetail from './ArchNodeDetail'
import ArchSources from './ArchSources'

const VIEW_TABS = [
  { id: 'map', label: '图谱' },
  { id: 'compare', label: '对比' },
  { id: 'table', label: '总表' },
] as const

type ViewId = (typeof VIEW_TABS)[number]['id']

export interface ArchAtlasProps {
  /** 决策卡「用显存墙计算器验证 →」跳转回显存墙 tab */
  onJumpToMemory: () => void
}

export default function ArchAtlas({ onJumpToMemory }: ArchAtlasProps) {
  const [view, setView] = useState<ViewId>('map')
  const [archId, setArchId] = useState<ArchId>(ARCH_DIAGRAMS[0].id)
  const [selectedId, setSelectedId] = useState<ArchComponentId | null>(ARCH_DIAGRAMS[0].nodes[0]?.id ?? null)

  const diagram = ARCH_DIAGRAMS.find((d) => d.id === archId) ?? ARCH_DIAGRAMS[0]
  const selectedNode = (selectedId && diagram.nodes.find((n) => n.id === selectedId)) || null

  // 切图时选中项重置为该图第一个节点,避免右栏停在本图并不存在的组件上
  const selectDiagram = (id: ArchId) => {
    setArchId(id)
    const next = ARCH_DIAGRAMS.find((d) => d.id === id)
    setSelectedId(next?.nodes[0]?.id ?? null)
  }

  return (
    <div className="space-y-4">
      <SegmentedTabs tabs={VIEW_TABS} value={view} onChange={setView} />

      {view === 'map' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {ARCH_DIAGRAMS.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => selectDiagram(d.id)}
                className={`rounded-lg border px-3 py-2 md:py-1.5 text-sm transition-colors ${
                  d.id === archId ? 'border-accent bg-accent/10' : 'border-line bg-panel-2 hover:border-accent/50'
                }`}
              >
                {d.name}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-5 lg:flex-row">
            <div className="min-w-0 flex-1 space-y-4">
              <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
                <h3 className="text-base font-bold">{diagram.name}</h3>
                <p className="mt-1 text-sm leading-relaxed">{diagram.tagline}</p>
                <p className="mt-2 text-xs leading-relaxed text-dim">代表实现:{diagram.exemplars}</p>
              </div>

              <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
                <p className="mb-3 text-xs text-dim">
                  自上而下 6 层即请求流向;置灰的层表示本架构没有这一层。点击任意组件看讲解。
                </p>
                <ArchDiagramCanvas diagram={diagram} selectedId={selectedId} onSelect={setSelectedId} />
              </div>

              <ArchDecisionCard
                decision={diagram.decision}
                sources={diagram.sources}
                onJumpToMemory={onJumpToMemory}
              />

              <ArchSources sources={diagram.sources} />
            </div>

            <div className="w-full shrink-0 lg:w-96">
              <div className="lg:sticky lg:top-20">
                <ArchNodeDetail node={selectedNode} />
              </div>
            </div>
          </div>
        </div>
      )}

      {view === 'compare' && <ArchCompare onJumpToMemory={onJumpToMemory} />}

      {view === 'table' && <ArchDimensionTable />}
    </div>
  )
}
