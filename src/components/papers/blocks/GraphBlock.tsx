import { useId, useMemo } from 'react'
import type { GraphBlockData } from '../../../lib/paper/blockSchemas'
import { layoutGraph, NODE_H, NODE_W } from '../../../lib/paper/graphLayout'
import type { CiteLevel } from '../../../lib/paper/citations'
import type { StoredCiteEntry } from '../../../lib/paper/types'
import BlockCites from './BlockCites'

/**
 * concept-map / flow 展示块（§7.2）：固定 SVG 组件渲染。
 * 模型只给节点与边的声明式数据，SVG 全部由本组件生成——绝不渲染模型提供的 SVG/HTML。
 *
 * - flow：分层有向图，箭头 marker；concept-map：环形，中心节点强调、连线无箭头。
 * - 超限（节点 >12 / 边 >24）：overflow 标志 → 降级为节点与关系列表。
 * - viewBox + preserveAspectRatio：窄屏等比缩放，容器内不横向溢出。
 */

interface Props {
  block: GraphBlockData
  citeIndex: ReadonlyMap<string, StoredCiteEntry>
  badges: Readonly<Record<string, CiteLevel>> | null
  onJump: (entry: StoredCiteEntry) => void
}

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export default function GraphBlock({ block, citeIndex, badges, onJump }: Props) {
  const layout = useMemo(
    () => (block.overflow ? null : layoutGraph(block.kind, block.nodes, block.edges)),
    [block.kind, block.nodes, block.edges, block.overflow],
  )
  const isFlow = block.kind === 'flow'
  // marker id 必须全局唯一：同一条消息里可能有多张图
  const arrowId = `pc-arrow-${useId().replace(/[^a-zA-Z0-9]/g, '')}`

  return (
    <div className="my-2 rounded-lg border border-line bg-panel-2 p-3">
      <p className="mb-2 text-xs font-medium text-fg">{block.title ?? (isFlow ? '流程图' : '概念关系图')}</p>

      {layout === null ? (
        // 降级列表：节点过多时图形不可读，改为结构化列表（§7.2）
        <div className="text-xs">
          <p className="mb-1 text-[0.7rem] text-dim">节点/关系较多，已改为列表展示：</p>
          <ul className="mb-2 flex flex-wrap gap-1">
            {block.nodes.map((n) => (
              <li key={n.id} className="rounded border border-line px-1.5 py-0.5 text-[0.7rem] text-fg">
                {n.label}
              </li>
            ))}
          </ul>
          <ul className="space-y-0.5 text-[0.7rem] text-dim">
            {block.edges.map((e, i) => (
              <li key={i}>
                {e.from} {isFlow ? '→' : '—'} {e.to}
                {e.label ? `（${e.label}）` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={block.title ?? (isFlow ? '流程图' : '概念关系图')}
            className="h-auto w-full"
            style={{ maxHeight: '18rem' }}
          >
            <defs>
              <marker id={arrowId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" className="text-accent" />
              </marker>
            </defs>
            {layout.edges.map((e, i) => (
              <g key={i}>
                <line
                  x1={e.x1}
                  y1={e.y1}
                  x2={e.x2}
                  y2={e.y2}
                  stroke="currentColor"
                  strokeWidth={1.2}
                  className="text-accent/60"
                  markerEnd={isFlow ? `url(#${arrowId})` : undefined}
                />
                {e.label && (
                  <text x={e.mx} y={e.my - 3} textAnchor="middle" fontSize={9} fill="currentColor" className="text-dim">
                    {truncate(e.label, 12)}
                  </text>
                )}
              </g>
            ))}
            {layout.nodes.map((n) => (
              <g key={n.id}>
                <rect
                  x={n.x - NODE_W / 2}
                  y={n.y - NODE_H / 2}
                  width={NODE_W}
                  height={NODE_H}
                  rx={isFlow ? 6 : 14}
                  fill="currentColor"
                  className="text-panel"
                  stroke="currentColor"
                  strokeWidth={1}
                />
                <text
                  x={n.x}
                  y={n.y + 3.5}
                  textAnchor="middle"
                  fontSize={10}
                  fill="currentColor"
                  className="text-fg"
                >
                  {truncate(n.label, 12)}
                </text>
              </g>
            ))}
          </svg>
        </div>
      )}

      <BlockCites cites={block.cites} citeIndex={citeIndex} badges={badges} onJump={onJump} />
    </div>
  )
}
