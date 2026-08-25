// 对比视图:任选两张架构图并排,自动高亮结构差异。
// 方向定义为「从 A 演进到 B」:绿 = B 新增、红 = B 已移除、琥珀 = 同一组件角色调整。
// 两侧传同一份 diffStates,Canvas 只标记该图实际存在的节点——A 侧自然只见红/琥珀,B 侧只见绿/琥珀。
import { useMemo, useState } from 'react'
import {
  ARCH_COMPONENTS,
  ARCH_DIAGRAMS,
  type ArchComponentDef,
  type ArchComponentId,
  type ArchDiagram,
  type ArchId,
} from '../../data/archAtlas'
import { diffDiagrams, findPairNote } from '../../lib/archDiff'
import ArchDecisionCard from './ArchDecisionCard'
import ArchDiagramCanvas from './ArchDiagramCanvas'

const COMPONENTS: Record<ArchComponentId, ArchComponentDef> = ARCH_COMPONENTS

const BASELINE = ARCH_DIAGRAMS.find((d) => d.id === 'baseline') ?? ARCH_DIAGRAMS[0]
const DEFAULT_A = BASELINE
const DEFAULT_B = ARCH_DIAGRAMS.find((d) => d.id === 'pd-disagg') ?? ARCH_DIAGRAMS[1] ?? ARCH_DIAGRAMS[0]

export interface ArchCompareProps {
  onJumpToMemory: () => void
}

function pick(id: ArchId): ArchDiagram {
  return ARCH_DIAGRAMS.find((d) => d.id === id) ?? ARCH_DIAGRAMS[0]
}

function ChipList({ ids, tone, title }: { ids: ArchComponentId[]; tone: string; title: string }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold">{title}</div>
      {ids.length === 0 ? (
        <p className="text-xs text-dim">无</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {ids.map((id) => (
            <span key={id} className={`rounded border px-2 py-0.5 text-xs ${tone}`}>
              {COMPONENTS[id].name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export default function ArchCompare({ onJumpToMemory }: ArchCompareProps) {
  const [aId, setAId] = useState<ArchId>(DEFAULT_A.id)
  const [bId, setBId] = useState<ArchId>(DEFAULT_B.id)
  const [selectedId, setSelectedId] = useState<ArchComponentId | null>(null)

  const a = pick(aId)
  const b = pick(bId)
  const diff = useMemo(() => diffDiagrams(a, b), [a, b])
  const pairNote = findPairNote(aId, bId)

  const nodeA = selectedId ? a.nodes.find((n) => n.id === selectedId) : undefined
  const nodeB = selectedId ? b.nodes.find((n) => n.id === selectedId) : undefined
  const selectedDef = selectedId ? COMPONENTS[selectedId] : undefined

  const side = (d: ArchDiagram, label: string) => (
    <div className="min-w-0 rounded-xl border border-line bg-panel shadow-sm p-4">
      <div className="mb-1 text-xs font-semibold text-dim">{label}</div>
      <div className="mb-3 text-sm font-bold">{d.name}</div>
      <ArchDiagramCanvas
        diagram={d}
        selectedId={selectedId}
        onSelect={setSelectedId}
        diffStates={diff.states}
        dense
      />
    </div>
  )

  return (
    <div className="space-y-4">
      {/* 选择器 + 色例 */}
      <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-dim">
            架构 A(演进起点)
            <select
              value={aId}
              onChange={(e) => setAId(e.target.value as ArchId)}
              className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg"
            >
              {ARCH_DIAGRAMS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-dim">
            架构 B(演进终点)
            <select
              value={bId}
              onChange={(e) => setBId(e.target.value as ArchId)}
              className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-fg"
            >
              {ARCH_DIAGRAMS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dim">
          <span className="font-semibold text-fg">方向:从 A 演进到 B</span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-ok/60" />绿 = B 新增
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-bad/50" />红 = B 已移除
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber/60" />琥珀 = 角色调整
          </span>
        </div>
        {aId === bId && <p className="mt-2 text-xs text-amber">A、B 选了同一张图,差异自然为空——换一张再看。</p>}
      </div>

      {/* 移动端:先给文字化 diff 摘要,再纵向堆两张图 */}
      <div className="space-y-3 rounded-xl border border-line bg-panel shadow-sm p-4 lg:hidden">
        <div className="text-sm font-bold">
          差异摘要:{a.name} → {b.name}
        </div>
        <ChipList ids={diff.added} tone="border-ok/50 bg-ok/10 text-ok" title="新增组件" />
        <ChipList ids={diff.removed} tone="border-bad/50 bg-bad/10 text-bad" title="移除组件" />
        <ChipList ids={diff.changed} tone="border-amber/50 bg-amber/10 text-amber" title="角色调整" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {side(a, 'A · 演进起点')}
        {side(b, 'B · 演进终点')}
      </div>

      {/* 点击节点后的 A/B 角色对照 */}
      {selectedDef && selectedId && (
        <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
          <div className="mb-1 text-xs font-semibold text-dim">组件对照</div>
          <h4 className="text-base font-bold">
            {selectedDef.name}
            {selectedDef.enName && <span className="ml-2 text-sm font-normal text-dim">{selectedDef.enName}</span>}
          </h4>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {[
              { d: a, node: nodeA, label: `A · ${a.name}` },
              { d: b, node: nodeB, label: `B · ${b.name}` },
            ].map((s) => (
              <div key={s.d.id} className="rounded-lg border border-line bg-panel-2 p-3 text-sm leading-relaxed">
                <div className="mb-1 text-xs font-semibold text-accent">{s.label}</div>
                {!s.node ? (
                  <p className="text-dim">本架构中不存在该组件。</p>
                ) : (
                  <>
                    <p>{s.node.variantNote ?? '沿用通用角色,本图未做特殊说明。'}</p>
                    {s.node.badge && <p className="mt-1 text-xs text-accent-2">规格:{s.node.badge}</p>}
                    {s.node.detail && <p className="mt-1 text-xs text-dim">{s.node.detail}</p>}
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 space-y-1 text-sm leading-relaxed">
            <p>{selectedDef.what}</p>
            {selectedDef.why && <p className="text-dim">{selectedDef.why}</p>}
          </div>
        </div>
      )}

      {/* 差异解读:L3 预写优先,否则退回两图各自的 vsBaseline */}
      <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
        <div className="mb-2 text-sm font-bold">差异解读</div>
        {pairNote ? (
          <p className="text-sm leading-relaxed">{pairNote}</p>
        ) : (
          <>
            <p className="mb-3 text-xs text-dim">以下解读均相对{BASELINE.name}。</p>
            <div className="grid gap-3 lg:grid-cols-2">
              {[a, b].map((d, i) => (
                <div key={`${d.id}-${i}`} className="rounded-lg border border-line bg-panel-2 p-3">
                  <div className="mb-1 text-xs font-semibold text-accent">
                    {i === 0 ? 'A' : 'B'} · {d.name}
                  </div>
                  {d.vsBaseline && d.vsBaseline.length > 0 ? (
                    <ul className="space-y-1 text-sm leading-relaxed">
                      {d.vsBaseline.map((v) => (
                        <li key={v}>· {v}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-dim">本图即基线,其余架构的差异都相对它描述。</p>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 两张决策卡并排兜底 */}
      <div className="grid gap-4 lg:grid-cols-2">
        {[a, b].map((d, i) => (
          <div key={`${d.id}-card-${i}`} className="min-w-0 space-y-2">
            <div className="text-xs font-semibold text-dim">
              {i === 0 ? 'A' : 'B'} · {d.name}
            </div>
            <ArchDecisionCard decision={d.decision} sources={d.sources} onJumpToMemory={onJumpToMemory} />
          </div>
        ))}
      </div>
    </div>
  )
}
