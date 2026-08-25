// 架构图泳道渲染器(PLAN-arch-atlas.md「泳道渲染」节):单图视图与对比视图共用。
// 固定 6 泳道自上而下 = 请求流向;空泳道渲染置灰细条而不隐藏,保证对比模式两侧逐行对齐。
// 不引任何图形库:纯 HTML 盒子 + Tailwind,沿用 TransformerDiagram 的 node/arrow/dashed 形制。
import {
  ARCH_COMPONENTS,
  ARCH_LANES,
  type ArchComponentDef,
  type ArchComponentId,
  type ArchDiagram,
  type ArchEdge,
  type ArchGroup,
  type ArchNode,
  type LaneId,
} from '../../data/archAtlas'
import type { DiffState } from '../../lib/archDiff'

// ARCH_COMPONENTS 是 as const,直接索引会得到「部分成员没有 enName」的联合类型;
// 这里收敛成注册表接口,可选字段才可安全访问。
const COMPONENTS: Record<ArchComponentId, ArchComponentDef> = ARCH_COMPONENTS

export interface ArchDiagramCanvasProps {
  diagram: ArchDiagram
  selectedId: ArchComponentId | null
  onSelect: (id: ArchComponentId) => void
  /** 对比模式下的 diff 着色;只标记本图实际存在的节点 */
  diffStates?: Map<ArchComponentId, DiffState>
  /** 对比模式:缩小 padding 与字号 */
  dense?: boolean
}

// chip 背景用 color-mix 调成不透明色:半透明 bg 会让 group 的虚线边框从角标文字后透出来,像删除线
const TONE: Record<NonNullable<ArchGroup['tone']>, { box: string; chip: string }> = {
  accent: {
    box: 'border-accent/50',
    chip: 'bg-[color-mix(in_srgb,var(--color-accent)_18%,var(--color-panel))] text-accent',
  },
  'accent-2': {
    box: 'border-accent-2/50',
    chip: 'bg-[color-mix(in_srgb,var(--color-accent-2)_18%,var(--color-panel))] text-accent-2',
  },
  ok: {
    box: 'border-ok/50',
    chip: 'bg-[color-mix(in_srgb,var(--color-ok)_18%,var(--color-panel))] text-ok',
  },
  warn: {
    box: 'border-warn/50',
    chip: 'bg-[color-mix(in_srgb,var(--color-warn)_18%,var(--color-panel))] text-warn',
  },
}

// ring 与 bg 拆开:选中态要盖掉 diff 底色,但 ring 必须保留(同一节点可能既选中又有 diff)
const DIFF_RING: Record<DiffState, string> = {
  same: '',
  added: 'ring-2 ring-ok/60',
  removed: 'ring-2 ring-bad/50 opacity-70',
  changed: 'ring-2 ring-amber/60',
}
const DIFF_BG: Record<DiffState, string> = {
  same: '',
  added: 'bg-ok/10',
  removed: 'bg-bad/10',
  changed: 'bg-amber/10',
}

const ARROW_RE = /^[⇣⇢⇄↓→↔⤷]/
/** 数据里的 label 常自带箭头符号,避免渲染出「⇣ ⇣ ...」 */
function withArrow(label: string, arrow: string): string {
  return ARROW_RE.test(label.trim()) ? label : `${arrow} ${label}`
}

type Segment =
  | { kind: 'nodes'; nodes: ArchNode[] }
  | { kind: 'groups'; groups: { group: ArchGroup; nodes: ArchNode[] }[] }

interface LaneModel {
  id: LaneId
  name: string
  empty: boolean
  segments: Segment[]
  /** segment 下标 → 该段之后要渲染的 KV 传输 chip */
  kvAfter: Map<number, ArchEdge[]>
  /** 从本泳道发出的控制指令注解,渲染在本行之下、下一行之上 */
  controlOut: ArchEdge[]
  arrowBefore: boolean
}

function buildLanes(diagram: ArchDiagram): LaneModel[] {
  const models: LaneModel[] = []
  let lastNonEmpty = -2
  ARCH_LANES.forEach((lane, i) => {
    const laneNodes = diagram.nodes.filter((n) => COMPONENTS[n.id].lane === lane.id)
    // 保持数据数组顺序:group 出现在其首个节点的位置,连续的散节点合成一段
    const segments: Segment[] = []
    const segOfGroup = new Map<string, number>()
    const buckets = new Map<string, ArchNode[]>()
    for (const n of laneNodes) {
      if (n.group) {
        let arr = buckets.get(n.group)
        if (!arr) {
          arr = []
          buckets.set(n.group, arr)
          const def: ArchGroup = diagram.groups?.find((g) => g.id === n.group) ?? {
            id: n.group,
            label: n.group,
            lane: lane.id,
          }
          const last = segments[segments.length - 1]
          if (last && last.kind === 'groups') last.groups.push({ group: def, nodes: arr })
          else segments.push({ kind: 'groups', groups: [{ group: def, nodes: arr }] })
          segOfGroup.set(n.group, segments.length - 1)
        }
        arr.push(n)
      } else {
        const last = segments[segments.length - 1]
        if (last && last.kind === 'nodes') last.nodes.push(n)
        else segments.push({ kind: 'nodes', nodes: [n] })
      }
    }

    const kvAfter = new Map<number, ArchEdge[]>()
    const controlOut: ArchEdge[] = []
    for (const e of diagram.edges ?? []) {
      if (COMPONENTS[e.from].lane !== lane.id) continue
      if (e.kind === 'kv') {
        const fromNode = laneNodes.find((n) => n.id === e.from)
        const segIdx =
          (fromNode?.group !== undefined ? segOfGroup.get(fromNode.group) : undefined) ?? segments.length - 1
        const list = kvAfter.get(segIdx)
        if (list) list.push(e)
        else kvAfter.set(segIdx, [e])
      } else if (e.kind === 'control') {
        controlOut.push(e)
      }
    }

    const empty = laneNodes.length === 0
    const arrowBefore = !empty && lastNonEmpty === i - 1
    if (!empty) lastNonEmpty = i
    models.push({ id: lane.id, name: lane.name, empty, segments, kvAfter, controlOut, arrowBefore })
  })
  return models
}

export default function ArchDiagramCanvas({
  diagram,
  selectedId,
  onSelect,
  diffStates,
  dense = false,
}: ArchDiagramCanvasProps) {
  const lanes = buildLanes(diagram)
  const dataEdges = (diagram.edges ?? []).filter((e) => e.kind === 'data')

  const nodeBox = (n: ArchNode) => {
    const def = COMPONENTS[n.id]
    const state = diffStates?.get(n.id)
    const selected = selectedId === n.id
    const ring = state ? DIFF_RING[state] : ''
    const bg = selected ? 'bg-accent/10' : state && DIFF_BG[state] ? DIFF_BG[state] : 'bg-panel-2'
    const border = selected ? 'border-accent' : 'border-line hover:border-accent/50'
    return (
      <button
        key={n.id}
        type="button"
        onClick={() => onSelect(n.id)}
        title={def.what}
        className={`max-w-full rounded-lg border text-left transition-colors ${border} ${bg} ${ring} ${
          dense ? 'px-2 py-1' : 'px-3 py-2'
        }`}
      >
        <span className="flex items-start justify-between gap-2">
          <span className={dense ? 'text-xs font-medium' : 'text-sm font-medium'}>{def.name}</span>
          {n.badge && (
            <span className="shrink-0 rounded bg-accent-2/15 px-1 py-px text-[10px] leading-4 text-accent-2">
              {n.badge}
            </span>
          )}
        </span>
        {def.enName && <span className="block text-[10px] text-dim">{def.enName}</span>}
      </button>
    )
  }

  const groupBox = (group: ArchGroup, nodes: ArchNode[]) => {
    const tone = TONE[group.tone ?? 'accent']
    return (
      <div
        key={group.id}
        className={`relative min-w-0 rounded-xl border-2 border-dashed ${tone.box} ${dense ? 'p-2 pt-3' : 'p-3 pt-4'}`}
      >
        <span
          title={group.label}
          className={`absolute -top-2.5 left-3 max-w-[calc(100%_-_1.5rem)] truncate rounded px-2 py-0.5 text-[10px] font-semibold ${tone.chip}`}
        >
          {group.label}
        </span>
        <div className={`flex flex-wrap ${dense ? 'gap-1.5' : 'gap-2'}`}>{nodes.map(nodeBox)}</div>
      </div>
    )
  }

  const kvChip = (edges: ArchEdge[]) => (
    <div className="flex flex-wrap justify-center gap-2 py-1">
      {edges.map((e) => (
        <span
          key={`${e.from}-${e.to}-${e.label}`}
          className="rounded-full border border-amber/40 bg-amber/15 px-2 py-0.5 text-[11px] text-amber"
        >
          {withArrow(e.label, '⇄')}
        </span>
      ))}
    </div>
  )

  return (
    <div className={dense ? 'space-y-1' : 'space-y-1.5'}>
      {lanes.map((m, i) => {
        const prev = i > 0 ? lanes[i - 1] : undefined
        // 上一泳道若有控制指令注解,注解本身就是连接线,不再叠一个裸 ↓
        const showArrow = m.arrowBefore && !(prev && prev.controlOut.length > 0)
        return (
          <div key={m.id}>
            {showArrow && <div className="py-0.5 text-center text-dim">↓</div>}
            <div className={`flex flex-col gap-1 lg:flex-row lg:gap-3 ${m.empty ? 'opacity-40' : ''}`}>
              <div className="shrink-0 text-[10px] leading-tight text-dim lg:w-16 lg:pt-2">{m.name}</div>
              <div className="min-w-0 flex-1">
                {m.empty ? (
                  <div className="rounded-lg border border-dashed border-line bg-panel-2 px-3 py-1 text-[11px] text-dim">
                    本架构无此层
                  </div>
                ) : (
                  <div className={dense ? 'space-y-2' : 'space-y-3'}>
                    {m.segments.map((seg, si) => (
                      <div key={si}>
                        {seg.kind === 'nodes' ? (
                          <div className={`flex flex-wrap ${dense ? 'gap-1.5' : 'gap-2'}`}>{seg.nodes.map(nodeBox)}</div>
                        ) : (
                          <div
                            className={
                              seg.groups.length === 1
                                ? 'mt-2'
                                : seg.groups.length === 4
                                  ? 'mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4'
                                  : 'mt-2 grid gap-3 sm:grid-cols-2'
                            }
                          >
                            {seg.groups.map((g) => groupBox(g.group, g.nodes))}
                          </div>
                        )}
                        {m.kvAfter.get(si) && kvChip(m.kvAfter.get(si) ?? [])}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {m.controlOut.map((e) => (
              <div key={`${e.from}-${e.to}-${e.label}`} className="py-1 text-center text-[11px] text-dim">
                {withArrow(e.label, '⇣')}
              </div>
            ))}
          </div>
        )
      })}

      {dataEdges.length > 0 && (
        <div className="mt-2 space-y-0.5 border-t border-line pt-2 text-[11px] leading-relaxed text-dim">
          {dataEdges.map((e) => (
            <p key={`${e.from}-${e.to}-${e.label}`}>
              · {COMPONENTS[e.from].name} → {COMPONENTS[e.to].name}:{e.label}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
