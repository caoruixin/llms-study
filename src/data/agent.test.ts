// agent.ts 数据一致性（对应 PLAN-page-audit-fixes.md P1-18/19）：
// - GRAPH_NODES 的节点/条件边由 kind 字段声明，UI 不按数组下标猜——名称与 kind 必须互相印证
// - 「Token 放大效应」量级断言无实测来源，必须显式标注经验量级（非实测），防止回退成伪精确
// - Kimi K3 多模态口径与 pricing.ts 条目对齐：两处都用「权重卡称/自称」的保留措辞，不单边写成事实
import { describe, expect, it } from 'vitest'
import { AGENT_ELEMENTS, AGENT_PITFALLS, GRAPH_NODES } from './agent'
import { PRICING } from './pricing'

describe('GRAPH_NODES kind 字段', () => {
  it('每个条目 kind 合法，且名称与 kind 互相印证（条件边 ⇔ kind=edge）', () => {
    expect(GRAPH_NODES.length).toBeGreaterThan(0)
    for (const n of GRAPH_NODES) {
      expect(['node', 'edge'], `${n.id} kind 非法`).toContain(n.kind)
      expect(n.name.includes('条件边'), `${n.id} 的名称与 kind=${n.kind} 不一致`).toBe(n.kind === 'edge')
    }
  })
})

describe('量级断言与事实口径', () => {
  it('「Token 放大效应」的倍数断言标注为经验量级（非实测）', () => {
    const pitfall = AGENT_PITFALLS.find((p) => p.name.includes('Token 放大'))
    expect(pitfall).toBeDefined()
    expect(pitfall!.detail).toContain('经验量级')
    expect(pitfall!.detail).toContain('非实测')
  })

  it('Kimi K3 多模态措辞与 pricing.ts 保留口径对齐（权重卡自称，非直陈事实）', () => {
    const multimodal = AGENT_ELEMENTS.find((e) => e.id === 'multimodal')
    expect(multimodal).toBeDefined()
    expect(multimodal!.what).toContain('权重卡')

    const k3 = PRICING.find((p) => p.modelId === 'kimi-k3')
    expect(k3).toBeDefined()
    expect(k3!.modality).toContain('权重卡')
  })
})
