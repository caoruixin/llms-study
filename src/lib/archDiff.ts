// 架构图结构 diff(L1 层,PLAN-arch-atlas.md):纯函数,无 React 依赖。
// 同 ID = 同概念由 ARCH_COMPONENTS 注册表构造保证,因此跨图 diff 只需按 node id 求并集:
// - 仅 B 有 → added(绿);仅 A 有 → removed(红)
// - 都有且 norm(variantNote) 不等 → changed(琥珀);相等 → same
// norm = trim 且 undefined 归空串——variantNote 是唯一参与琥珀判定的字段。
import { ARCH_PAIR_NOTES, type ArchComponentId, type ArchDiagram, type ArchId } from '../data/archAtlas'

export type DiffState = 'same' | 'added' | 'removed' | 'changed'

export interface DiagramDiff {
  states: Map<ArchComponentId, DiffState>
  added: ArchComponentId[]
  removed: ArchComponentId[]
  changed: ArchComponentId[]
}

function norm(note: string | undefined): string {
  return (note ?? '').trim()
}

/** 方向 A→B:「从 A 演进到 B」;B 有 A 无 = added,A 有 B 无 = removed */
export function diffDiagrams(a: Pick<ArchDiagram, 'nodes'>, b: Pick<ArchDiagram, 'nodes'>): DiagramDiff {
  const aNotes = new Map(a.nodes.map((n) => [n.id, norm(n.variantNote)]))
  const bNotes = new Map(b.nodes.map((n) => [n.id, norm(n.variantNote)]))
  const states = new Map<ArchComponentId, DiffState>()
  const added: ArchComponentId[] = []
  const removed: ArchComponentId[] = []
  const changed: ArchComponentId[] = []
  for (const [id, noteA] of aNotes) {
    const noteB = bNotes.get(id)
    if (noteB === undefined) {
      states.set(id, 'removed')
      removed.push(id)
    } else if (noteA !== noteB) {
      states.set(id, 'changed')
      changed.push(id)
    } else {
      states.set(id, 'same')
    }
  }
  for (const id of bNotes.keys()) {
    if (!aNotes.has(id)) {
      states.set(id, 'added')
      added.push(id)
    }
  }
  return { states, added, removed, changed }
}

/** L3 层稀疏预写的架构对解读,顺序无关查找;查不到返回 undefined */
export function findPairNote(x: ArchId, y: ArchId): string | undefined {
  return ARCH_PAIR_NOTES.find(
    (p) => (p.pair[0] === x && p.pair[1] === y) || (p.pair[0] === y && p.pair[1] === x),
  )?.note
}
