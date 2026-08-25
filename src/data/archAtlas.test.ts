// 架构图谱数据守卫(沿用 kda.test.ts 溯源红线风格,PLAN-arch-atlas.md「验证」节)。
// 所有断言对 ARCH_DIAGRAMS 全量循环——阶段 C 补 ③~⑦ 后自动生效,无需改测试。
import { describe, expect, it } from 'vitest'
import {
  ARCH_COMPONENTS,
  ARCH_DIAGRAMS,
  ARCH_LANES,
  ARCH_PAIR_NOTES,
  DIMENSIONS,
  type ArchComponentDef,
  type LaneId,
} from './archAtlas'
import { GPUS } from './hardware'
import { MODELS } from './models'

const QUANT_IDS = ['fp16', 'fp8', 'int4'] // 与 src/store.ts 的 QuantId 联合成员一致
const LANE_IDS = ARCH_LANES.map((l) => l.id)

function laneOf(componentId: keyof typeof ARCH_COMPONENTS): LaneId {
  return (ARCH_COMPONENTS[componentId] as ArchComponentDef).lane
}

describe('archAtlas / 泳道与组件注册表', () => {
  it('泳道固定 6 条且 id 唯一,名称非空', () => {
    expect(ARCH_LANES.length).toBe(6)
    expect(new Set(LANE_IDS).size).toBe(6)
    expect(LANE_IDS).toEqual(['client', 'access', 'orchestration', 'engine', 'kv', 'infra'])
    for (const l of ARCH_LANES) expect(l.name.length).toBeGreaterThan(0)
  })

  it('每个组件 what 非空且 lane 合法;name 非空', () => {
    for (const [id, def] of Object.entries(ARCH_COMPONENTS) as [string, ArchComponentDef][]) {
      expect(def.name.length, `${id}.name 为空`).toBeGreaterThan(0)
      expect(def.what.length, `${id}.what 过短`).toBeGreaterThan(10)
      expect(LANE_IDS, `${id}.lane 非法`).toContain(def.lane)
    }
  })

  it('DIMENSIONS 10 维齐全、id 唯一、显示名非空', () => {
    expect(DIMENSIONS.length).toBe(10)
    expect(new Set(DIMENSIONS.map((d) => d.id)).size).toBe(10)
    for (const d of DIMENSIONS) expect(d.name.length).toBeGreaterThan(0)
  })
})

describe('archAtlas / 图结构完整性', () => {
  it('图 id 唯一;name/tagline/exemplars 非空', () => {
    const ids = new Set(ARCH_DIAGRAMS.map((d) => d.id))
    expect(ids.size).toBe(ARCH_DIAGRAMS.length)
    for (const d of ARCH_DIAGRAMS) {
      expect(d.name.length).toBeGreaterThan(0)
      expect(d.tagline.length).toBeGreaterThan(0)
      expect(d.exemplars.length).toBeGreaterThan(0)
    }
  })

  it('node id 图内唯一', () => {
    for (const d of ARCH_DIAGRAMS) {
      const ids = d.nodes.map((n) => n.id)
      expect(new Set(ids).size, `${d.id} 存在重复 node id`).toBe(ids.length)
    }
  })

  it('node.group 引用存在,且 group.lane 与成员组件 lane 一致;group id 图内唯一', () => {
    for (const d of ARCH_DIAGRAMS) {
      const groups = d.groups ?? []
      expect(new Set(groups.map((g) => g.id)).size, `${d.id} 存在重复 group id`).toBe(groups.length)
      for (const n of d.nodes) {
        if (n.group === undefined) continue
        const g = groups.find((x) => x.id === n.group)
        expect(g, `${d.id}/${n.id} 引用了不存在的 group ${n.group}`).toBeDefined()
        if (g) expect(g.lane, `${d.id}/${n.id} 所在 group ${g.id} 泳道不一致`).toBe(laneOf(n.id))
      }
    }
  })

  it('edge 端点都在本图 nodes 中,label 非空', () => {
    for (const d of ARCH_DIAGRAMS) {
      const nodeIds = new Set(d.nodes.map((n) => n.id))
      for (const e of d.edges ?? []) {
        expect(nodeIds.has(e.from), `${d.id} edge from ${e.from} 不在图内`).toBe(true)
        expect(nodeIds.has(e.to), `${d.id} edge to ${e.to} 不在图内`).toBe(true)
        expect(e.label.length).toBeGreaterThan(0)
      }
    }
  })

  it('布局上限:每泳道 ≤6 节点、每 group ≤4 节点、variantNote ≤40 字', () => {
    for (const d of ARCH_DIAGRAMS) {
      const perLane = new Map<LaneId, number>()
      const perGroup = new Map<string, number>()
      for (const n of d.nodes) {
        const lane = laneOf(n.id)
        perLane.set(lane, (perLane.get(lane) ?? 0) + 1)
        if (n.group !== undefined) perGroup.set(n.group, (perGroup.get(n.group) ?? 0) + 1)
        if (n.variantNote !== undefined) {
          expect(n.variantNote.trim().length, `${d.id}/${n.id} variantNote 为空串请直接省略`).toBeGreaterThan(0)
          expect(n.variantNote.length, `${d.id}/${n.id} variantNote 超 40 字`).toBeLessThanOrEqual(40)
        }
      }
      for (const [lane, count] of perLane) {
        expect(count, `${d.id} 泳道 ${lane} 超 6 节点`).toBeLessThanOrEqual(6)
      }
      for (const [gid, count] of perGroup) {
        expect(count, `${d.id} group ${gid} 超 4 节点`).toBeLessThanOrEqual(4)
      }
    }
  })
})

describe('archAtlas / 溯源红线(裸数字禁入)', () => {
  it('每图 sources ≥3,sourceUrl 为 https,asOf 为 YYYY-MM,title 非空', () => {
    for (const d of ARCH_DIAGRAMS) {
      expect(d.sources.length, `${d.id} sources 不足 3 条`).toBeGreaterThanOrEqual(3)
      for (const s of d.sources) {
        expect(s.sourceUrl.startsWith('https://'), `${d.id} 来源 ${s.title} 非 https`).toBe(true)
        expect(/^\d{4}-(0[1-9]|1[0-2])$/.test(s.asOf), `${d.id} 来源 ${s.title} asOf 非 YYYY-MM`).toBe(true)
        expect(s.title.length).toBeGreaterThan(0)
      }
    }
  })

  it('benefits 中含数字的条目必带合法 sourceIdx', () => {
    for (const d of ARCH_DIAGRAMS) {
      for (const b of d.decision.benefits) {
        expect(b.text.length).toBeGreaterThan(0)
        if (/\d/.test(b.text)) {
          expect(b.sourceIdx, `${d.id} 裸数字 benefit:「${b.text}」缺 sourceIdx`).toBeDefined()
        }
        if (b.sourceIdx !== undefined) {
          expect(Number.isInteger(b.sourceIdx)).toBe(true)
          expect(b.sourceIdx).toBeGreaterThanOrEqual(0)
          expect(b.sourceIdx, `${d.id} benefit sourceIdx 越界`).toBeLessThan(d.sources.length)
        }
      }
    }
  })
})

describe('archAtlas / 决策卡与对比维度', () => {
  it('决策卡各栏非空;meta.opsComplexity ∈ 1..5', () => {
    for (const d of ARCH_DIAGRAMS) {
      const c = d.decision
      expect(c.problem.length, `${d.id} problem 为空`).toBeGreaterThan(10)
      expect(c.benefits.length).toBeGreaterThan(0)
      expect(c.metrics.length).toBeGreaterThan(0)
      expect(c.costs.length).toBeGreaterThan(0)
      expect(c.avoidWhen.length).toBeGreaterThan(0)
      expect(c.gpuScale.length).toBeGreaterThan(0)
      expect(d.meta.opsComplexity).toBeGreaterThanOrEqual(1)
      expect(d.meta.opsComplexity).toBeLessThanOrEqual(5)
      expect(d.meta.minDeploy.length).toBeGreaterThan(0)
      expect(d.meta.qpsThreshold.length).toBeGreaterThan(0)
      expect(d.meta.network.length).toBeGreaterThan(0)
      expect(d.meta.avoidWhen.length).toBeGreaterThan(0)
    }
  })

  it('非 baseline 必有非空 vsBaseline;baseline 免写', () => {
    for (const d of ARCH_DIAGRAMS) {
      if (d.id === 'baseline') continue
      expect(d.vsBaseline, `${d.id} 缺 vsBaseline`).toBeDefined()
      expect(d.vsBaseline!.length, `${d.id} vsBaseline 为空数组`).toBeGreaterThan(0)
      for (const line of d.vsBaseline!) expect(line.length).toBeGreaterThan(10)
    }
  })

  it('dims 10 键全非空且单格 ≤20 字', () => {
    for (const d of ARCH_DIAGRAMS) {
      for (const { id } of DIMENSIONS) {
        const cell = d.dims[id]
        expect(cell.trim().length, `${d.id} dims.${id} 为空`).toBeGreaterThan(0)
        expect(cell.length, `${d.id} dims.${id} 超 20 字:「${cell}」`).toBeLessThanOrEqual(20)
      }
    }
  })

  it('memoryPreset 的 modelId/gpuId/quantId 必须真实存在(联动显存墙计算器)', () => {
    const modelIds = new Set(MODELS.map((m) => m.id))
    const gpuIds = new Set(GPUS.map((g) => g.id))
    for (const d of ARCH_DIAGRAMS) {
      const p = d.decision.memoryPreset
      if (!p) continue
      if (p.modelId !== undefined) expect(modelIds.has(p.modelId), `${d.id} modelId ${p.modelId} 不存在`).toBe(true)
      if (p.gpuId !== undefined) expect(gpuIds.has(p.gpuId), `${d.id} gpuId ${p.gpuId} 不存在`).toBe(true)
      if (p.quantId !== undefined) expect(QUANT_IDS, `${d.id} quantId 非法`).toContain(p.quantId)
      if (p.batch !== undefined) expect(p.batch).toBeGreaterThan(0)
    }
  })
})

describe('archAtlas / 架构对解读', () => {
  it('ARCH_PAIR_NOTES 的 pair 两端不同图、无重复对(顺序无关)', () => {
    const seen = new Set<string>()
    for (const { pair, note } of ARCH_PAIR_NOTES) {
      expect(pair[0]).not.toBe(pair[1])
      const key = [...pair].sort().join('~')
      expect(seen.has(key), `重复的架构对 ${key}`).toBe(false)
      seen.add(key)
      expect(note.length).toBeGreaterThan(10)
    }
  })
})
