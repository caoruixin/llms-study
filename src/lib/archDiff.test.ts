import { describe, expect, it } from 'vitest'
import { ARCH_DIAGRAMS, ARCH_PAIR_NOTES, type ArchDiagram, type ArchNode } from '../data/archAtlas'
import { diffDiagrams, findPairNote } from './archDiff'

// fixture 只需 nodes(diffDiagrams 收 Pick<ArchDiagram, 'nodes'>);id 必须取真实 ArchComponentId
function fix(nodes: ArchNode[]): Pick<ArchDiagram, 'nodes'> {
  return { nodes }
}

function byId(id: ArchDiagram['id']): ArchDiagram {
  const d = ARCH_DIAGRAMS.find((x) => x.id === id)
  if (!d) throw new Error(`缺少架构图 ${id}`)
  return d
}

describe('archDiff / fixture 四态', () => {
  const a = fix([{ id: 'app-client' }, { id: 'gpu', variantNote: '同构 8 卡' }, { id: 'chunked-prefill' }])
  const b = fix([{ id: 'app-client' }, { id: 'gpu', variantNote: '异构选卡' }, { id: 'kv-transfer' }])

  it('same / changed / removed / added 各归其位', () => {
    const d = diffDiagrams(a, b)
    expect(d.states.get('app-client')).toBe('same')
    expect(d.states.get('gpu')).toBe('changed')
    expect(d.states.get('chunked-prefill')).toBe('removed')
    expect(d.states.get('kv-transfer')).toBe('added')
    expect(d.added).toEqual(['kv-transfer'])
    expect(d.removed).toEqual(['chunked-prefill'])
    expect(d.changed).toEqual(['gpu'])
    // states 覆盖两图 node id 并集
    expect(d.states.size).toBe(4)
  })

  it('norm:variantNote 首尾空白与 undefined/空串 视为相同', () => {
    const x = fix([{ id: 'gpu', variantNote: '  异构选卡 ' }, { id: 'nvlink' }])
    const y = fix([{ id: 'gpu', variantNote: '异构选卡' }, { id: 'nvlink', variantNote: '  ' }])
    const d = diffDiagrams(x, y)
    expect(d.states.get('gpu')).toBe('same')
    expect(d.states.get('nvlink')).toBe('same')
    expect(d.changed).toEqual([])
  })
})

describe('archDiff / 真数据 ①→②', () => {
  const baseline = byId('baseline')
  const pd = byId('pd-disagg')

  it('added 含 prefill/decode 池节点,infra GPU 节点为 changed', () => {
    const d = diffDiagrams(baseline, pd)
    expect(d.added).toContain('prefill-worker')
    expect(d.added).toContain('decode-worker')
    expect(d.states.get('gpu')).toBe('changed')
    expect(d.changed).toContain('gpu')
  })

  it('自比对全 same', () => {
    for (const diagram of ARCH_DIAGRAMS) {
      const d = diffDiagrams(diagram, diagram)
      expect(d.added).toEqual([])
      expect(d.removed).toEqual([])
      expect(d.changed).toEqual([])
      for (const [id, state] of d.states) {
        expect(state, `${diagram.id} 自比对 ${id} 应为 same`).toBe('same')
      }
      expect(d.states.size).toBe(diagram.nodes.length)
    }
  })

  it('方向反转:added/removed 互换,changed 不变', () => {
    const fwd = diffDiagrams(baseline, pd)
    const rev = diffDiagrams(pd, baseline)
    expect([...fwd.added].sort()).toEqual([...rev.removed].sort())
    expect([...fwd.removed].sort()).toEqual([...rev.added].sort())
    expect([...fwd.changed].sort()).toEqual([...rev.changed].sort())
  })
})

describe('archDiff / findPairNote', () => {
  it('顺序无关命中;查不到返回 undefined', () => {
    // 阶段 A 时 ARCH_PAIR_NOTES 为空,临时注入一条验证顺序无关性(finally 恢复)
    ARCH_PAIR_NOTES.push({ pair: ['baseline', 'pd-disagg'], note: '测试用差异解读' })
    try {
      expect(findPairNote('baseline', 'pd-disagg')).toBe('测试用差异解读')
      expect(findPairNote('pd-disagg', 'baseline')).toBe('测试用差异解读')
      expect(findPairNote('baseline', 'large-ep')).toBeUndefined()
    } finally {
      ARCH_PAIR_NOTES.pop()
    }
  })
})
