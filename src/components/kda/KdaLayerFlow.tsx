// KDA 单层数据流循环动画（QKVFlow 同款手写 SVG + framer-motion）。
//
// QKVFlow 既有 QA 教训（必须遵守）：
//   ① 竖直位移一律走 attrY——motion 把 y 当 transform，translateY 会叠加在 y 属性上把元素顶出 viewBox；
//   ② 每条 times 都从 0 铺到 1，否则这条 JS 驱动的关键帧动画不会启动。
// 色值一律用 var(--color-*)（本文件无 recharts / 色值插值需求）。
import { motion } from 'framer-motion'
import { KDA_LAYER_ACTS, KDA_LAYER_FOOTNOTE } from '../../data/kda'

const CYCLE = 6 // 秒

// 四幕时间窗（占整个循环的比例）；每条 times 都补齐 0 与 1
const ACTS: readonly [number, number][] = [
  [0.02, 0.24],
  [0.28, 0.5],
  [0.54, 0.74],
  [0.78, 0.98],
]

/** 只在第 act 幕可见的淡入淡出关键帧（times 铺满 0→1） */
function fade(act: number, peak = 1): {
  animate: { opacity: number[] }
  transition: { duration: number; times: number[]; repeat: number }
} {
  const [start, end] = ACTS[act]
  const f = 0.03
  return {
    animate: { opacity: [0, 0, peak, peak, 0, 0] },
    transition: {
      duration: CYCLE,
      times: [0, start, start + f, end - f, end, 1],
      repeat: Infinity,
    },
  }
}

// 状态矩阵网格几何
const GRID_X = 236
const GRID_Y = 42
const CELL = 17
const GRID_N = 4
const GRID_W = CELL * GRID_N
const PROJ = [
  { label: 'q', color: 'var(--color-fg)' },
  { label: 'k', color: 'var(--color-fg)' },
  { label: 'v', color: 'var(--color-fg)' },
  { label: 'β', color: 'var(--color-amber)' },
  { label: 'α', color: 'var(--color-accent-2)' },
]

export default function KdaLayerFlow() {
  return (
    <div className="mt-4 rounded-lg border border-line bg-panel-2 p-3">
      <div className="mb-1 text-xs font-semibold text-accent">KDA 单层数据流（循环播放：投影 → 衰减擦除 → 写入 → 读出）</div>
      <svg viewBox="0 0 440 200" className="w-full" role="img" aria-label="KDA 单层数据流动画">
        {/* 输入 token */}
        <rect x={12} y={80} width={58} height={26} rx={6} fill="var(--color-panel)" stroke="var(--color-line)" />
        <text x={41} y={97} textAnchor="middle" fontSize="11" fill="var(--color-fg)">
          token x
        </text>

        {/* 第一幕：投影出 q/k/v/β/α */}
        {PROJ.map((p, i) => {
          const y = 24 + i * 30
          return (
            <g key={p.label}>
              <motion.line
                x1={72}
                y1={93}
                x2={126}
                y2={y + 9}
                stroke={p.color}
                strokeWidth={1.4}
                strokeDasharray="4 3"
                initial={{ opacity: 0 }}
                {...fade(0, 0.85)}
              />
              <motion.g initial={{ opacity: 0 }} {...fade(0)}>
                <rect x={128} y={y - 3} width={34} height={22} rx={5} fill="var(--color-panel)" stroke={p.color} />
                <text x={145} y={y + 12} textAnchor="middle" fontSize="11" fill={p.color}>
                  {p.label}
                </text>
              </motion.g>
            </g>
          )
        })}

        {/* 状态矩阵 S（恒定大小） */}
        <text x={GRID_X + GRID_W / 2} y={GRID_Y - 8} textAnchor="middle" fontSize="10" fill="var(--color-dim)">
          状态 S（d_v × d_k，大小恒定）
        </text>
        {Array.from({ length: GRID_N }).map((_, r) =>
          Array.from({ length: GRID_N }).map((_, c) => (
            <rect
              key={`${r}-${c}`}
              x={GRID_X + c * CELL}
              y={GRID_Y + r * CELL}
              width={CELL - 2}
              height={CELL - 2}
              rx={2}
              fill="var(--color-panel)"
              stroke="var(--color-line)"
            />
          )),
        )}

        {/* 第二幕：Diag(α) 逐列衰减 + (I − βkkᵀ) 擦除 —— 紫色收缩脉冲 */}
        {Array.from({ length: GRID_N }).map((_, c) => (
          <motion.rect
            key={`decay-${c}`}
            x={GRID_X + c * CELL}
            width={CELL - 2}
            fill="var(--color-accent-2)"
            initial={{ opacity: 0, height: CELL * GRID_N - 2, attrY: GRID_Y }}
            animate={{
              opacity: [0, 0, 0.55, 0.55, 0, 0],
              // 逐列收缩：不同通道缩得不一样多，正是「对角门」的视觉表达
              height: [
                CELL * GRID_N - 2,
                CELL * GRID_N - 2,
                (CELL * GRID_N - 2) * (1 - c * 0.18),
                (CELL * GRID_N - 2) * (1 - c * 0.18),
                CELL * GRID_N - 2,
                CELL * GRID_N - 2,
              ],
              attrY: [GRID_Y, GRID_Y, GRID_Y + (CELL * GRID_N - 2) * c * 0.18, GRID_Y + (CELL * GRID_N - 2) * c * 0.18, GRID_Y, GRID_Y],
            }}
            transition={{ duration: CYCLE, times: [0, 0.28, 0.33, 0.47, 0.5, 1], repeat: Infinity, delay: c * 0.04 }}
          />
        ))}
        <motion.text
          x={GRID_X + GRID_W / 2}
          y={GRID_Y + CELL * GRID_N + 18}
          textAnchor="middle"
          fontSize="10"
          fill="var(--color-accent-2)"
          initial={{ opacity: 0 }}
          {...fade(1)}
        >
          S ← S·Diag(α)·(I − βkkᵀ)
        </motion.text>

        {/* 第三幕：写入 β·u·kᵀ —— 酒红写入脉冲 */}
        <motion.rect
          x={GRID_X}
          width={GRID_W - 2}
          height={CELL - 2}
          rx={2}
          fill="var(--color-accent)"
          initial={{ opacity: 0, attrY: GRID_Y + CELL * GRID_N + 24 }}
          animate={{
            opacity: [0, 0, 0.85, 0.85, 0, 0],
            attrY: [
              GRID_Y + CELL * GRID_N + 24,
              GRID_Y + CELL * GRID_N + 24,
              GRID_Y + CELL * 2,
              GRID_Y + CELL * 2,
              GRID_Y + CELL * 2,
              GRID_Y + CELL * 2,
            ],
          }}
          transition={{ duration: CYCLE, times: [0, 0.54, 0.63, 0.71, 0.74, 1], repeat: Infinity }}
        />
        <motion.text
          x={GRID_X + GRID_W / 2}
          y={GRID_Y + CELL * GRID_N + 34}
          textAnchor="middle"
          fontSize="10"
          fill="var(--color-accent)"
          initial={{ opacity: 0 }}
          {...fade(2)}
        >
          S ← S + β·u·kᵀ（u = v − v̂）
        </motion.text>

        {/* 第四幕：读出 o = S·q */}
        <motion.line
          x1={GRID_X + GRID_W + 4}
          y1={GRID_Y + CELL * 2}
          x2={366}
          y2={GRID_Y + CELL * 2}
          stroke="var(--color-fg)"
          strokeWidth={2}
          initial={{ opacity: 0 }}
          {...fade(3, 0.9)}
        />
        <motion.circle
          cx={382}
          cy={GRID_Y + CELL * 2}
          r={13}
          fill="var(--color-accent)"
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: [0, 0, 1, 1, 0, 0], scale: [0.6, 0.6, 1.12, 1, 0.6, 0.6] }}
          transition={{ duration: CYCLE, times: [0, 0.78, 0.84, 0.95, 0.98, 1], repeat: Infinity }}
        />
        <motion.text
          x={382}
          y={GRID_Y + CELL * 2 + 4}
          textAnchor="middle"
          fontSize="10"
          fill="#ffffff"
          initial={{ opacity: 0 }}
          {...fade(3)}
        >
          o
        </motion.text>
        <motion.text
          x={382}
          y={GRID_Y + CELL * 2 + 32}
          textAnchor="middle"
          fontSize="10"
          fill="var(--color-fg)"
          initial={{ opacity: 0 }}
          {...fade(3)}
        >
          o = S·q
        </motion.text>
      </svg>

      <ol className="mt-2 space-y-1 text-[11px] leading-relaxed text-dim">
        {KDA_LAYER_ACTS.map((a) => (
          <li key={a.title}>
            <span className="font-semibold text-fg">{a.title}</span> {a.desc}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-[11px] leading-relaxed text-accent">{KDA_LAYER_FOOTNOTE}</p>
    </div>
  )
}
