import { fmt } from '../../lib/kdaEngine'

export type TermRole = 'state' | 'residual' | 'decay' | 'beta' | 'input' | 'neutral'

export const ROLE_COLORS: Record<TermRole, string> = {
  residual: 'var(--color-accent)', // 酒红
  decay: 'var(--color-accent-2)', // 深紫
  beta: 'var(--color-amber)',
  state: 'var(--color-fg)',
  input: 'var(--color-fg)',
  neutral: 'var(--color-dim)',
}

const ROLE_LABELS: Record<TermRole, string> = {
  state: '状态',
  residual: '残差',
  decay: '衰减',
  beta: 'β',
  input: '输入',
  neutral: '中性',
}

export type ScalarKey = 'beta' | 'alphaMean' | 't' | 'residualNorm' | 'retrievalErr'

export type MathNode =
  | { kind: 'sym'; text: string; sub?: string; sup?: string; role?: TermRole; bind?: ScalarKey }
  | { kind: 'op'; text: string }
  | { kind: 'group'; children: MathNode[]; role?: TermRole; paren?: boolean }
  | { kind: 'stack'; op: 'Σ' | 'Π'; below: string; above?: string; children: MathNode[] }

interface FormulaProps {
  nodes: MathNode[]
  size?: 'sm' | 'md' | 'lg'
  focusRoles?: TermRole[]
  substitute?: boolean
  scalars?: Partial<Record<ScalarKey, number>>
  className?: string
}

const SIZE_CLS: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
}

// 数字与 Diag/I 直立，其余符号（S/k/v/q/α/β…）斜体衬线
function isUpright(text: string): boolean {
  return /^(Diag|I|\d+(\.\d+)?)$/.test(text)
}

function isDimmed(role: TermRole | undefined, focusRoles: FormulaProps['focusRoles']): boolean {
  if (!focusRoles || focusRoles.length === 0) return false
  if (!role) return false
  return !focusRoles.includes(role)
}

interface NodeViewProps {
  node: MathNode
  focusRoles?: TermRole[]
  substitute?: boolean
  scalars?: Partial<Record<ScalarKey, number>>
}

function NodeView({ node, focusRoles, substitute, scalars }: NodeViewProps) {
  switch (node.kind) {
    case 'sym':
      return <SymView node={node} focusRoles={focusRoles} substitute={substitute} scalars={scalars} />
    case 'op':
      return <span className="px-0.5 text-fg">{node.text}</span>
    case 'group': {
      const dimmed = isDimmed(node.role, focusRoles)
      const color = node.role ? ROLE_COLORS[node.role] : undefined
      return (
        <span
          className={`inline-flex items-baseline transition-opacity ${dimmed ? 'opacity-40' : ''}`}
          style={color ? { color } : undefined}
        >
          {node.paren && <span aria-hidden="true">(</span>}
          {node.children.map((child, i) => (
            <NodeView key={i} node={child} focusRoles={focusRoles} substitute={substitute} scalars={scalars} />
          ))}
          {node.paren && <span aria-hidden="true">)</span>}
        </span>
      )
    }
    case 'stack':
      return (
        <span className="inline-flex items-center gap-x-0.5">
          <span className="inline-flex flex-col items-center leading-none">
            {node.above && <span className="text-[0.6em]">{node.above}</span>}
            <span className="text-lg leading-none">{node.op}</span>
            <span className="text-[0.6em]">{node.below}</span>
          </span>
          <span className="inline-flex items-center gap-x-1">
            {node.children.map((child, i) => (
              <NodeView key={i} node={child} focusRoles={focusRoles} substitute={substitute} scalars={scalars} />
            ))}
          </span>
        </span>
      )
  }
}

interface SymViewProps {
  node: Extract<MathNode, { kind: 'sym' }>
  focusRoles?: TermRole[]
  substitute?: boolean
  scalars?: Partial<Record<ScalarKey, number>>
}

function SymView({ node, focusRoles, substitute, scalars }: SymViewProps) {
  const dimmed = isDimmed(node.role, focusRoles)
  const color = node.role ? ROLE_COLORS[node.role] : undefined
  const boundValue = node.bind !== undefined ? scalars?.[node.bind] : undefined
  const showValue = substitute === true && boundValue !== undefined
  // 代入态走引擎 fmt：与讲解正文（同样走 fmt）严格同一副面孔，杜绝「公式 1.00 / 正文 1」双轨。
  // （热力图格子刻意保留 toFixed：网格里需要定宽小数对齐，见 MatrixHeatmap.tsx 注释。）
  const displayText = showValue ? fmt(boundValue) : node.text
  const italic = !showValue && !isUpright(node.text)

  return (
    <span
      className={[
        'inline-flex items-baseline transition-opacity',
        dimmed ? 'opacity-40' : '',
        italic ? 'italic font-serif' : 'not-italic',
        showValue ? 'font-mono' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={color ? { color } : undefined}
    >
      {displayText}
      {/* 代入数值后不再渲染下/上标：βₜ 代入后应显示「1」而不是「1ₜ」——下标是符号的一部分，值没有下标 */}
      {!showValue && node.sub && <sub className="text-[0.65em]">{node.sub}</sub>}
      {!showValue && node.sup && <sup className="text-[0.65em]">{node.sup}</sup>}
    </span>
  )
}

export default function Formula({ nodes, size = 'md', focusRoles, substitute, scalars, className }: FormulaProps) {
  return (
    <div className={`overflow-x-auto ${className ?? ''}`}>
      <div className={`inline-flex flex-wrap items-center gap-x-1 ${SIZE_CLS[size]}`}>
        {nodes.map((n, i) => (
          <NodeView key={i} node={n} focusRoles={focusRoles} substitute={substitute} scalars={scalars} />
        ))}
      </div>
    </div>
  )
}

export function FormulaLegend({ roles }: { roles: TermRole[] }) {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-dim">
      {roles.map((r) => (
        <span key={r} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ROLE_COLORS[r] }} />
          {ROLE_LABELS[r]}
        </span>
      ))}
    </div>
  )
}
