import { describe, expect, it } from 'vitest'
import { NODE_H, NODE_W, layerNodes, layoutFlow, layoutGraph, layoutRadial } from './graphLayout'
import type { GraphEdge, GraphNode } from './blockSchemas'

const nodes = (...ids: string[]): GraphNode[] => ids.map((id) => ({ id, label: id.toUpperCase() }))
const edge = (from: string, to: string): GraphEdge => ({ from, to })

describe('layerNodes（flow 分层）', () => {
  it('链式图逐层展开', () => {
    expect(layerNodes(nodes('a', 'b', 'c'), [edge('a', 'b'), edge('b', 'c')])).toEqual([['a'], ['b'], ['c']])
  })
  it('多入边节点等所有前驱就位后才下沉', () => {
    const layers = layerNodes(nodes('a', 'b', 'c', 'd'), [edge('a', 'c'), edge('b', 'c'), edge('c', 'd')])
    expect(layers[0].sort()).toEqual(['a', 'b'])
    expect(layers[1]).toEqual(['c'])
    expect(layers[2]).toEqual(['d'])
  })
  it('孤立节点进第一层', () => {
    expect(layerNodes(nodes('a', 'b'), [])).toEqual([['a', 'b']])
  })
  it('纯环不死循环，且每个节点恰好出现一次', () => {
    const layers = layerNodes(nodes('a', 'b', 'c'), [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')])
    expect(layers.flat().sort()).toEqual(['a', 'b', 'c'])
  })
  it('带环的复杂图同样收敛', () => {
    const layers = layerNodes(nodes('a', 'b', 'c', 'd'), [edge('a', 'b'), edge('b', 'c'), edge('c', 'b'), edge('c', 'd')])
    expect(layers.flat().sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('layoutFlow', () => {
  it('所有节点落在 viewBox 内（含节点半宽/半高）', () => {
    const layout = layoutFlow(nodes('a', 'b', 'c'), [edge('a', 'b'), edge('a', 'c')])
    for (const n of layout.nodes) {
      expect(n.x - NODE_W / 2).toBeGreaterThanOrEqual(0)
      expect(n.x + NODE_W / 2).toBeLessThanOrEqual(layout.width)
      expect(n.y - NODE_H / 2).toBeGreaterThanOrEqual(0)
      expect(n.y + NODE_H / 2).toBeLessThanOrEqual(layout.height)
    }
  })
  it('层序体现在 y 坐标上（后层更靠下）', () => {
    const layout = layoutFlow(nodes('a', 'b'), [edge('a', 'b')])
    const a = layout.nodes.find((n) => n.id === 'a')!
    const b = layout.nodes.find((n) => n.id === 'b')!
    expect(b.y).toBeGreaterThan(a.y)
  })
  it('边端点被裁到节点边界外侧，且带中点标签锚', () => {
    const layout = layoutFlow(nodes('a', 'b'), [{ from: 'a', to: 'b', label: '推动' }])
    const e = layout.edges[0]
    const a = layout.nodes.find((n) => n.id === 'a')!
    expect(e.y1).toBeGreaterThan(a.y) // 从 a 的下边界出发
    expect(e.label).toBe('推动')
    expect(e.mx).toBeCloseTo((e.x1 + e.x2) / 2, 6)
    expect(e.my).toBeCloseTo((e.y1 + e.y2) / 2, 6)
  })
  it('端点缺失的边不进布局', () => {
    expect(layoutFlow(nodes('a'), [edge('a', 'ghost')]).edges).toHaveLength(0)
  })
  it('布局确定性：同输入同输出', () => {
    const args: [GraphNode[], GraphEdge[]] = [nodes('a', 'b', 'c'), [edge('a', 'b'), edge('b', 'c')]]
    expect(layoutFlow(...args)).toEqual(layoutFlow(...args))
  })
})

describe('layoutRadial（concept-map）', () => {
  it('度数最高的节点在中心', () => {
    const layout = layoutRadial(nodes('a', 'b', 'c', 'd'), [edge('b', 'a'), edge('b', 'c'), edge('b', 'd')])
    const center = layout.nodes.find((n) => n.id === 'b')!
    expect(center.x).toBeCloseTo(layout.width / 2, 0)
    expect(center.y).toBeCloseTo(layout.height / 2, 0)
  })
  it('环上节点均分且互不重合', () => {
    const layout = layoutRadial(nodes('c0', 'c1', 'c2', 'c3', 'c4'), [])
    const points = layout.nodes.map((n) => `${n.x},${n.y}`)
    expect(new Set(points).size).toBe(points.length)
  })
  it('节点 ≤2 时退回分层布局（环形没有意义）', () => {
    const two = nodes('a', 'b')
    expect(layoutRadial(two, [edge('a', 'b')])).toEqual(layoutFlow(two, [edge('a', 'b')]))
  })
  it('layoutGraph 按 kind 分派', () => {
    const ns = nodes('a', 'b', 'c', 'd')
    expect(layoutGraph('flow', ns, [])).toEqual(layoutFlow(ns, []))
    expect(layoutGraph('concept-map', ns, [])).toEqual(layoutRadial(ns, []))
  })
})
