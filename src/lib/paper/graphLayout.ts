import type { GraphEdge, GraphNode } from './blockSchemas'

/**
 * concept-map / flow 的手写布局引擎（§7.2：固定 SVG 组件渲染，不引新依赖）。
 *
 * 两种布局共用一套输出形状，组件只换样式与箭头语义：
 * - layered（flow）：按入度做 BFS 分层，层内均分；有环时把剩余节点顺次挂到下一层，永不死循环。
 * - radial（concept-map）：度数最高的节点居中，其余按环形均分。
 *
 * 输出坐标在固定 viewBox 内，SVG 用 preserveAspectRatio 缩放——窄屏自适应，页面不横向滚动。
 */

export interface LaidOutNode {
  id: string
  label: string
  group?: string
  /** 节点中心 */
  x: number
  y: number
  w: number
  h: number
}

export interface LaidOutEdge {
  from: string
  to: string
  label?: string
  x1: number
  y1: number
  x2: number
  y2: number
  /** 标签锚点（线段中点） */
  mx: number
  my: number
}

export interface GraphLayout {
  nodes: LaidOutNode[]
  edges: LaidOutEdge[]
  width: number
  height: number
}

export const NODE_W = 108
export const NODE_H = 34
const H_GAP = 18
const V_GAP = 46
const PAD = 12

/** flow：按依赖关系分层（入度为 0 的是第一层；孤立节点进第一层） */
export function layerNodes(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string[][] {
  const indeg = new Map<string, number>()
  const outs = new Map<string, string[]>()
  for (const n of nodes) {
    indeg.set(n.id, 0)
    outs.set(n.id, [])
  }
  for (const e of edges) {
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
    outs.get(e.from)?.push(e.to)
  }

  const layers: string[][] = []
  const placed = new Set<string>()
  let frontier = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id)
  // 全是环：从第一个节点破环起步
  if (frontier.length === 0 && nodes.length > 0) frontier = [nodes[0].id]

  const remainingIndeg = new Map(indeg)
  while (frontier.length > 0) {
    layers.push(frontier)
    for (const id of frontier) placed.add(id)
    const next: string[] = []
    for (const id of frontier) {
      for (const to of outs.get(id) ?? []) {
        if (placed.has(to) || next.includes(to)) continue
        remainingIndeg.set(to, (remainingIndeg.get(to) ?? 1) - 1)
        // 入边都来自已放置层 → 可以放到下一层
        if ((remainingIndeg.get(to) ?? 0) <= 0) next.push(to)
      }
    }
    // 环导致谁都没就绪：把还没放的节点里第一个强制放下去，保证收敛
    if (next.length === 0) {
      const stuck = nodes.find((n) => !placed.has(n.id))
      if (stuck) next.push(stuck.id)
    }
    frontier = next
  }
  return layers
}

function place(layers: readonly string[][], byId: ReadonlyMap<string, GraphNode>): { nodes: LaidOutNode[]; width: number; height: number } {
  const widest = Math.max(1, ...layers.map((l) => l.length))
  const width = PAD * 2 + widest * NODE_W + (widest - 1) * H_GAP
  const height = PAD * 2 + layers.length * NODE_H + Math.max(0, layers.length - 1) * V_GAP
  const nodes: LaidOutNode[] = []
  layers.forEach((layer, li) => {
    const rowW = layer.length * NODE_W + (layer.length - 1) * H_GAP
    const startX = (width - rowW) / 2
    layer.forEach((id, i) => {
      const n = byId.get(id)
      if (!n) return
      const node: LaidOutNode = {
        id,
        label: n.label,
        x: startX + i * (NODE_W + H_GAP) + NODE_W / 2,
        y: PAD + li * (NODE_H + V_GAP) + NODE_H / 2,
        w: NODE_W,
        h: NODE_H,
      }
      if (n.group) node.group = n.group
      nodes.push(node)
    })
  })
  return { nodes, width, height }
}

/** 线段裁到节点矩形边界（箭头不插进方框里） */
function trimToBorder(from: LaidOutNode, to: LaidOutNode): { x1: number; y1: number; x2: number; y2: number } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const cut = (node: LaidOutNode, sx: number, sy: number) => {
    if (dx === 0 && dy === 0) return { x: node.x, y: node.y }
    const halfW = node.w / 2 + 2
    const halfH = node.h / 2 + 2
    const tx = dx === 0 ? Infinity : halfW / Math.abs(dx)
    const ty = dy === 0 ? Infinity : halfH / Math.abs(dy)
    const t = Math.min(tx, ty)
    return { x: node.x + sx * dx * t, y: node.y + sy * dy * t }
  }
  const a = cut(from, 1, 1)
  const b = cut(to, -1, -1)
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
}

function connect(nodes: readonly LaidOutNode[], edges: readonly GraphEdge[]): LaidOutEdge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: LaidOutEdge[] = []
  for (const e of edges) {
    const from = byId.get(e.from)
    const to = byId.get(e.to)
    if (!from || !to) continue
    const seg = trimToBorder(from, to)
    const edge: LaidOutEdge = { from: e.from, to: e.to, ...seg, mx: (seg.x1 + seg.x2) / 2, my: (seg.y1 + seg.y2) / 2 }
    if (e.label) edge.label = e.label
    out.push(edge)
  }
  return out
}

/** flow：自上而下分层 */
export function layoutFlow(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphLayout {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const layers = layerNodes(nodes, edges)
  const { nodes: laid, width, height } = place(layers, byId)
  return { nodes: laid, edges: connect(laid, edges), width, height }
}

/** concept-map：度数最高者居中，其余环形均分（确定性：并列取节点表靠前者） */
export function layoutRadial(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphLayout {
  if (nodes.length <= 2) return layoutFlow(nodes, edges)

  const degree = new Map<string, number>(nodes.map((n) => [n.id, 0]))
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
  }
  let center = nodes[0]
  for (const n of nodes) {
    if ((degree.get(n.id) ?? 0) > (degree.get(center.id) ?? 0)) center = n
  }
  const ring = nodes.filter((n) => n.id !== center.id)
  const radius = Math.max(84, 26 * ring.length)
  const width = Math.round((radius + NODE_W / 2 + PAD) * 2)
  const height = Math.round((radius + NODE_H / 2 + PAD) * 2)
  const cx = width / 2
  const cy = height / 2

  const mk = (n: GraphNode, x: number, y: number): LaidOutNode => {
    const node: LaidOutNode = { id: n.id, label: n.label, x, y, w: NODE_W, h: NODE_H }
    if (n.group) node.group = n.group
    return node
  }

  const laid: LaidOutNode[] = [mk(center, cx, cy)]
  ring.forEach((n, i) => {
    // 从正上方开始顺时针铺开
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / ring.length
    laid.push(mk(n, Math.round(cx + radius * Math.cos(angle)), Math.round(cy + radius * Math.sin(angle))))
  })
  return { nodes: laid, edges: connect(laid, edges), width, height }
}

export function layoutGraph(
  kind: 'concept-map' | 'flow',
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): GraphLayout {
  return kind === 'flow' ? layoutFlow(nodes, edges) : layoutRadial(nodes, edges)
}
