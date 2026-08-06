import { motion } from 'framer-motion'

// 正=酒红、负=深紫（与 --color-accent / --color-accent-2 同值），framer-motion 插值需 JS hex 常量合成 rgba
const POS_HEX = '9e2b3a'
const NEG_HEX = '6d28d9'

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const CELL_CLS = {
  sm: 'h-7 w-7 text-[9px]',
  md: 'h-10 w-10 text-[11px]',
} as const

// 格内数字**刻意不走引擎 fmt**：网格需要定宽小数对齐（fmt 会去尾零，'2' 与 '0.71' 宽度不一列就歪了）。
// 公式代入值与讲解正文走 fmt，两者是不同场景、不冲突。
// 唯一要修的是 toFixed 的 -0 问题：-1e-17 会渲染成 '-0.00'（Tab3 差值热力图必现）——先归一再格式化。
function cellText(v: number, precision: number): string {
  const rounded = Number(v.toFixed(precision))
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(precision)
}

interface MatrixHeatmapProps {
  matrix: readonly (readonly number[])[]
  title?: string
  maxAbs?: number
  cellSize?: 'sm' | 'md'
  changedFrom?: readonly (readonly number[])[]
  highlight?: readonly (readonly [number, number])[]
  precision?: number
}

export default function MatrixHeatmap({
  matrix,
  title,
  maxAbs,
  cellSize = 'md',
  changedFrom,
  highlight,
  precision = 2,
}: MatrixHeatmapProps) {
  const flat = matrix.flat()
  const computedMax = maxAbs ?? Math.max(1e-9, ...flat.map((v) => Math.abs(v)))
  const cols = matrix[0]?.length ?? 0

  function isHighlighted(r: number, c: number): boolean {
    return highlight?.some(([hr, hc]) => hr === r && hc === c) ?? false
  }

  return (
    <div>
      {title && <div className="mb-1.5 text-xs font-medium text-dim">{title}</div>}
      <div
        className="inline-grid gap-px rounded-md bg-line p-px"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {matrix.map((row, r) =>
          row.map((v, c) => {
            const a = Math.min(0.9, Math.abs(v) / computedMax)
            const bg = v >= 0 ? hexToRgba(POS_HEX, a) : hexToRgba(NEG_HEX, a)
            const changed = changedFrom !== undefined && changedFrom[r]?.[c] !== v
            const textCls = a > 0.55 ? 'text-white' : 'text-fg'
            return (
              <motion.div
                key={`${r}-${c}`}
                animate={{ backgroundColor: bg, scale: changed ? [1, 1.15, 1] : 1 }}
                transition={{
                  backgroundColor: { duration: 0.35 },
                  scale: { duration: 0.35, times: [0, 0.5, 1] },
                }}
                className={`flex items-center justify-center rounded-[2px] font-mono tabular-nums ${CELL_CLS[cellSize]} ${textCls} ${
                  isHighlighted(r, c) ? 'ring-2 ring-accent' : ''
                }`}
              >
                {cellText(v, precision)}
              </motion.div>
            )
          }),
        )}
      </div>
    </div>
  )
}

interface VectorStripProps {
  vec: readonly number[]
  label?: string
  maxAbs?: number
  cellSize?: 'sm' | 'md'
  changedFrom?: readonly number[]
  precision?: number
}

export function VectorStrip({ vec, label, maxAbs, cellSize = 'md', changedFrom, precision = 2 }: VectorStripProps) {
  return (
    <MatrixHeatmap
      matrix={[vec]}
      title={label}
      maxAbs={maxAbs}
      cellSize={cellSize}
      changedFrom={changedFrom ? [changedFrom] : undefined}
      precision={precision}
    />
  )
}
