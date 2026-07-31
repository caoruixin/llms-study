import { motion } from 'framer-motion'

// QKV 流动动画：4 个历史 token 的 K/V，当前 token 发出 Q，
// 循环三幕：① Q·K 打分 → ② 权重分布 → ③ 加权 V 汇聚成输出
const TOKENS = ['解释', 'KV', 'cache', '的']
const WEIGHTS = [0.12, 0.42, 0.34, 0.12] // 示意注意力权重
const CYCLE = 4.5 // 秒

const X0 = 40
const GAP = 90
const tokenX = (i: number) => X0 + i * GAP

export default function QKVFlow() {
  return (
    <div className="mt-4 rounded-lg border border-line bg-panel-2 p-3">
      <div className="mb-1 text-xs font-semibold text-accent">QKV 流动动画（当前 token「作用」对全部历史做注意力）</div>
      <svg viewBox="0 0 420 190" className="w-full">
        {/* 历史 token 及其 K/V */}
        {TOKENS.map((t, i) => (
          <g key={i}>
            <rect x={tokenX(i) - 28} y={18} width={56} height={24} rx={6} fill="#1a2340" stroke="#2a3558" />
            <text x={tokenX(i)} y={34} textAnchor="middle" fontSize="11" fill="#e6eaf5">
              {t}
            </text>
            <text x={tokenX(i) - 14} y={58} textAnchor="middle" fontSize="9" fill="#8b96b5">
              K
            </text>
            <circle cx={tokenX(i) - 14} cy={68} r={5} fill="#5b8def" opacity={0.8} />
            <text x={tokenX(i) + 14} y={58} textAnchor="middle" fontSize="9" fill="#8b96b5">
              V
            </text>
            <circle cx={tokenX(i) + 14} cy={68} r={5} fill="#8b5cf6" opacity={0.8} />
          </g>
        ))}

        {/* 当前 token 的 Q */}
        <rect x={352} y={18} width={56} height={24} rx={6} fill="#5b8def33" stroke="#5b8def" />
        <text x={380} y={34} textAnchor="middle" fontSize="11" fill="#e6eaf5">
          作用 ←Q
        </text>

        {/* 第一幕：Q 射线到各 K */}
        {TOKENS.map((_, i) => (
          <motion.line
            key={`qk-${i}`}
            x1={372}
            y1={44}
            x2={tokenX(i) - 14}
            y2={64}
            stroke="#5b8def"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.9, 0.9, 0, 0] }}
            transition={{ duration: CYCLE, times: [0, 0.1, 0.3, 0.38, 1], repeat: Infinity, delay: i * 0.06 }}
          />
        ))}

        {/* 第二幕：注意力权重条 */}
        {WEIGHTS.map((w, i) => (
          <g key={`w-${i}`}>
            <motion.rect
              x={tokenX(i) - 12}
              y={112 - 0}
              width={24}
              rx={3}
              fill="#d97706"
              initial={{ height: 0, y: 112 }}
              animate={{ height: [0, w * 80, w * 80, 0], y: [112, 112 - w * 80, 112 - w * 80, 112] }}
              transition={{ duration: CYCLE, times: [0.3, 0.42, 0.72, 0.8], repeat: Infinity }}
            />
            <motion.text
              x={tokenX(i)}
              y={126}
              textAnchor="middle"
              fontSize="9"
              fill="#8b96b5"
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 1, 1, 0] }}
              transition={{ duration: CYCLE, times: [0.36, 0.44, 0.72, 0.8], repeat: Infinity }}
            >
              {Math.round(w * 100)}%
            </motion.text>
          </g>
        ))}
        <motion.text
          x={210}
          y={100}
          textAnchor="middle"
          fontSize="10"
          fill="#8b96b5"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 1, 0] }}
          transition={{ duration: CYCLE, times: [0.32, 0.4, 0.68, 0.76], repeat: Infinity }}
        >
          softmax(Q·Kᵀ/√d) → 注意力权重
        </motion.text>

        {/* 第三幕：V 按权重汇聚到输出 */}
        {WEIGHTS.map((w, i) => (
          <motion.line
            key={`v-${i}`}
            x1={tokenX(i) + 14}
            y1={74}
            x2={210}
            y2={162}
            stroke="#8b5cf6"
            strokeWidth={Math.max(1, w * 7)}
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.9, 0.9, 0] }}
            transition={{ duration: CYCLE, times: [0.55, 0.66, 0.88, 0.98], repeat: Infinity }}
          />
        ))}
        <motion.circle
          cx={210}
          cy={165}
          r={9}
          fill="#8b5cf6"
          initial={{ scale: 0 }}
          animate={{ scale: [0, 1.15, 1, 0] }}
          transition={{ duration: CYCLE, times: [0.6, 0.75, 0.92, 1], repeat: Infinity }}
        />
        <motion.text
          x={252}
          y={169}
          fontSize="10"
          fill="#e6eaf5"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 1, 0] }}
          transition={{ duration: CYCLE, times: [0.62, 0.75, 0.92, 1], repeat: Infinity }}
        >
          Σ wᵢ·Vᵢ = 输出
        </motion.text>
      </svg>
      <p className="mt-1 text-[11px] leading-relaxed text-dim">
        推理时历史 K/V（蓝/紫点）就是被缓存的 KV cache；每个新 token 只需算自己的 Q 再与缓存交互——这就是「KV cache 避免重算」的含义。
      </p>
    </div>
  )
}
