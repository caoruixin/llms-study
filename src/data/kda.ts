// /kda 页面的全部讲解内容（PLAN-kda-demo.md §5/§6.1）。
//
// 数据一致性红线（§5 第 3 层）：本文件**不写死任何场景数值**。
// 每一步讲解的 body 都是取数函数 `(step: TokenStep, f) => string`，数字一律从引擎的 TokenStep 现取、
// 经引擎的 fmt 格式化；文案与引擎脱钩会被 src/data/kda.test.ts（测试组 H）当场拦下。
// 唯一允许出现在本文件里的常量是「结构性事实」（K3 层数），且与 src/data/models.ts 的 kimi-k3 条目
// 同源口径 + 测试互锁。
import type { Mat, ScenarioToken, TokenRole, TokenStep, Vec, VariantId } from '../lib/kdaEngine'
import type { MathNode, ScalarKey, TermRole } from '../components/kda/Formula'
import { MODELS } from './models'

// ─────────── 一句话主线 ───────────

export const KDA_SUMMARY =
  'KDA 把注意力换成一张固定大小的联想记忆表 S：每来一个 token，先按逐通道遗忘门 Diag(α) 衰减，' +
  '再沿当前 key 方向擦掉旧值、补写新值（delta 规则），读出只是一次 S·q。' +
  '状态大小与序列长度无关 → KV cache 不再随上下文增长；代价是精确长程召回要靠混合栈里少量 Gated MLA 层兜底。'

// ─────────── 取数小工具（供 body 使用；本身不含任何场景常量） ───────────

export type NumFmt = (x: number, digits?: number) => string

function vec(v: Vec, f: NumFmt): string {
  return `(${v.map((x) => f(x)).join(', ')})`
}

function colOf(m: Mat, j: number): Vec {
  return m.map((row) => row[j])
}

function diagOf(m: Mat): Vec {
  return m.map((row, i) => row[i])
}

// 探针查找：body 绑定的 tokenT 保证 srcT ≤ t，取不到即为内容/引擎脱钩，直接抛错让测试组 H 拦下
function probe(step: TokenStep, srcT: number) {
  const p = step.retrieval.find((x) => x.srcT === srcT)
  if (!p) throw new Error(`kda.ts: t=${step.t} 缺少 srcT=${srcT} 探针`)
  return p
}

// delta 分支收窄：绑定到 deltanet/gated/kda 的步骤才可用（naive 无预测/残差/转移矩阵）
function asDelta(step: TokenStep): Extract<TokenStep, { kind: 'delta' }> {
  if (step.kind !== 'delta') throw new Error(`kda.ts: t=${step.t} 期望 delta 步但拿到 naive 步`)
  return step
}

// ─────────── MathNode 构造糖 ───────────

interface SymOpts {
  sub?: string
  sup?: string
  role?: TermRole
  bind?: ScalarKey
}

function sym(text: string, opts: SymOpts = {}): MathNode {
  return { kind: 'sym', text, ...opts }
}

function op(text: string): MathNode {
  return { kind: 'op', text }
}

function grp(children: MathNode[], opts: { role?: TermRole; paren?: boolean } = {}): MathNode {
  return { kind: 'group', children, ...opts }
}

// ─────────── 变体元信息（徽章 / 系列色 / 排序的唯一出处） ───────────

export interface VariantMeta {
  readonly id: VariantId
  readonly name: string
  readonly short: string
  /** recharts / SVG 需要 JS 字面色值；此处与 src/index.css @theme 同值（dim / amber / accent-2 / accent） */
  readonly color: string
  readonly badgeClass: string
  readonly tagline: string
}

export const VARIANT_ORDER: readonly VariantId[] = ['naive', 'deltanet', 'gated', 'kda']

export const VARIANT_META: Readonly<Record<VariantId, VariantMeta>> = {
  naive: {
    id: 'naive',
    name: '朴素线性注意力',
    short: '朴素',
    color: '#6e6a60',
    badgeClass: 'border border-line bg-panel-2 text-dim',
    tagline: '只加不减：外积直接累加，key 不正交就互相污染',
  },
  deltanet: {
    id: 'deltanet',
    name: 'DeltaNet',
    short: 'DeltaNet',
    color: '#d97706',
    badgeClass: 'border border-amber/40 bg-amber/10 text-amber',
    tagline: '先读后写：沿当前 key 方向擦掉旧值再写，覆盖写可精确',
  },
  gated: {
    id: 'gated',
    name: 'Gated DeltaNet',
    short: 'Gated',
    color: '#6d28d9',
    badgeClass: 'border border-accent-2/40 bg-accent-2/10 text-accent-2',
    tagline: '标量遗忘门：整张状态一起按 α 褪色，与内容无关',
  },
  kda: {
    id: 'kda',
    name: 'KDA（Kimi Delta Attention）',
    short: 'KDA',
    color: '#9e2b3a',
    badgeClass: 'bg-accent text-white',
    tagline: '对角遗忘门：每个 key 通道各自决定记多久',
  },
}

// ─────────── token 角色标签（Tab1/Tab2 共用；文字标签的唯一出处） ───────────

export const TOKEN_ROLE_LABELS: Readonly<Record<TokenRole, string>> = {
  'write-ortho': '正交写入',
  'write-conflict': '非正交冲突',
  overwrite: '覆盖写',
}

/** 「t3 · 非正交冲突」形式的短标签；覆盖写附带被覆盖的 token 序号（数值全部取自场景本身） */
export function tokenLabel(token: ScenarioToken): string {
  const role = TOKEN_ROLE_LABELS[token.role]
  const suffix = token.overwrites !== undefined ? `→ 覆盖 t${token.overwrites}` : ''
  return `t${token.t} · ${role}${suffix}`
}

// ─────────── Tab1 原理推导：五阶段 + 11 步 ───────────

export type DerivPhase = 'naive' | 'delta' | 'gate' | 'dplr' | 'position'

export interface DerivPhaseMeta {
  readonly id: DerivPhase
  readonly label: string
  readonly hint: string
}

export const DERIV_PHASES: readonly DerivPhaseMeta[] = [
  { id: 'naive', label: '朴素写入', hint: '联想记忆表与外积累加，以及它必然带来的干扰' },
  { id: 'delta', label: 'Delta 规则', hint: '把写入看成最小二乘拟合，梯度一步 = 先擦后写' },
  { id: 'gate', label: '遗忘门', hint: '标量门 → 对角门：从「一起褪色」到「按通道褪色」' },
  { id: 'dplr', label: 'DPLR 分解', hint: '对角 + 秩 1，低秩因子绑定同一个 k 换取 kernel 加速' },
  { id: 'position', label: '位置编码', hint: '转移矩阵连乘 = 数据依赖的乘性位置编码，KDA 层免 RoPE' },
]

/** 主卡右侧要渲染哪些数值视图（组件按声明条件渲染，避免每步写死布局） */
export type DerivView =
  | 'state-equation' // sBefore ×transition +writeOuter → sAfter 的热力图算式
  | 'readout' // o = S·q 读出条
  | 'prediction' // v̂ / v / u 三条向量对比
  | 'transition' // transition.full 热力图
  | 'gate-compare' // 同一 t 上 Gated 与 KDA 的转移矩阵并排
  | 'dplr' // Diag(α) + a·bᵀ 分解
  | 'probes' // 检索探针表
  | 'transition-chain' // 转移矩阵连乘示意

export interface DerivStep {
  readonly id: string
  readonly title: string
  readonly phase: DerivPhase
  /** 该步用哪个变体的 trace 讲解 */
  readonly variant: VariantId
  /** 定位到第几个 token（1-based，由 selectStep 取步） */
  readonly tokenT: number
  readonly formula: MathNode[]
  readonly views: readonly DerivView[]
  /** 讲解正文：一律现取 trace 数值，禁止写死数字 */
  readonly body: (step: TokenStep, f: NumFmt) => string
  readonly interview?: string
  readonly sourceUrl?: string
  readonly asOf?: string
}

export const KDA_DERIV_STEPS: readonly DerivStep[] = [
  // ① 朴素写入阶段
  {
    id: 'assoc-memory',
    title: '① 状态就是一张联想记忆表',
    phase: 'naive',
    variant: 'naive',
    tokenT: 1,
    formula: [
      sym('o', { sub: 't' }),
      op('='),
      sym('S', { sub: 't', role: 'state' }),
      op('·'),
      sym('q', { sub: 't', role: 'input' }),
      op('，'),
      sym('S'),
      op('∈'),
      sym('R', { sup: 'dᵥ×dₖ' }),
      op('（行 = value 维 dᵥ，列 = key 通道 dₖ）'),
    ],
    views: ['state-equation', 'readout'],
    body: (step, f) =>
      `线性注意力不存 KV，它存一张 ${step.sBefore.length}×${step.sBefore[0].length} 的联想记忆表 S：每一列绑一个 key 通道，每一行绑一个 value 维度。` +
      `写入是往表里加一笔，读出只是一次矩阵–向量乘 o = S·q（本 demo 约定 q = k，读出即自检索）。` +
      `第 ${step.t} 步写入 k = ${vec(step.k, f)}、v = ${vec(step.v, f)} 后，用同一个 k 去读得到 o = ${vec(step.output, f)}——` +
      `与 v 完全一致：单条写入永远可以精确取回，问题都出在第二条之后。`,
    interview:
      '线性注意力的「状态」是固定尺寸的矩阵而非逐 token 增长的 KV cache——这一句就解释了它为什么长上下文便宜。',
  },
  {
    id: 'naive-write',
    title: '② 朴素写入：外积直接累加',
    phase: 'naive',
    variant: 'naive',
    tokenT: 2,
    formula: [
      sym('S', { sub: 't', role: 'state' }),
      op('='),
      sym('S', { sub: 't−1', role: 'state' }),
      op('+'),
      sym('v', { sub: 't', role: 'input' }),
      sym('k', { sub: 't', sup: 'T', role: 'input' }),
    ],
    views: ['state-equation', 'probes'],
    body: (step, f) => {
      const p1 = probe(step, 1)
      const p2 = probe(step, 2)
      return (
        `朴素做法：把 (k, v) 拍成外积 v·kᵀ 直接累加进 S，不读不减。` +
        `第 ${step.t} 步写完后，两条探针都精确：k₁ 读出 ${vec(p1.retrieved, f)}（误差 ${f(p1.errorL2)}）、` +
        `k₂ 读出 ${vec(p2.retrieved, f)}（误差 ${f(p2.errorL2)}）。` +
        `原因只有一个——前两个 key 恰好正交，写第二列不碰第一列。真实序列里 key 几乎不可能两两正交。`
      )
    },
  },
  {
    id: 'interference',
    title: '③ 干扰：key 一旦不正交就互相污染',
    phase: 'naive',
    variant: 'naive',
    tokenT: 3,
    formula: [
      sym('S', { sub: 't', role: 'state' }),
      sym('k', { sub: 'i', role: 'input' }),
      op('='),
      sym('v', { sub: 'i', role: 'input' }),
      op('+'),
      grp(
        [
          {
            kind: 'stack',
            op: 'Σ',
            below: 'j≠i',
            children: [op('⟨'), sym('k', { sub: 'j' }), op(','), sym('k', { sub: 'i' }), op('⟩'), sym('v', { sub: 'j' })],
          },
        ],
        { role: 'residual' },
      ),
    ],
    views: ['probes', 'readout'],
    body: (step, f) => {
      const p1 = probe(step, 1)
      const pt = probe(step, step.t)
      return (
        `第 ${step.t} 个 key ${vec(step.k, f)} 与前面的 key 有重叠，干扰立刻显形：` +
        `用当前 key 读出得到 ${vec(pt.retrieved, f)}，而想写进去的是 ${vec(pt.target, f)}，误差 ${f(pt.errorL2)}——新写的值还没落地就被旧内容顶歪；` +
        `回头读 k₁ 得到 ${vec(p1.retrieved, f)}、误差 ${f(p1.errorL2)}——旧记忆也被新写入蹭脏。` +
        `朴素写入只加不减，交叉项 ⟨k_j, k_i⟩·v_j 会一直累积，序列越长越糊。`
      )
    },
    interview:
      '朴素线性注意力的死穴不是容量而是干扰：写入前不检查表里已有什么，非正交 key 的交叉项无限累积。',
  },

  // ④–⑦ Delta 规则阶段
  {
    id: 'least-squares',
    title: '④ 换个视角：写入是一次最小二乘拟合',
    phase: 'delta',
    variant: 'deltanet',
    tokenT: 3,
    formula: [
      sym('L', { sub: 't' }),
      grp([sym('S', { role: 'state' })], { paren: true }),
      op('='),
      sym('½'),
      op('‖'),
      sym('S', { role: 'state' }),
      sym('k', { sub: 't', role: 'input' }),
      op('−'),
      sym('v', { sub: 't', role: 'input' }),
      op('‖²'),
      op('，'),
      op('∇'),
      op('='),
      grp([sym('S'), sym('k', { sub: 't' }), op('−'), sym('v', { sub: 't' })], { paren: true }),
      sym('k', { sub: 't', sup: 'T' }),
    ],
    views: ['prediction'],
    body: (step, f) => {
      const d = asDelta(step)
      return (
        `先别急着写，先问一句「这张表现在对当前 key 的回答是什么」：预测 v̂ = S·k = ${vec(d.prediction, f)}，` +
        `而目标 v = ${vec(d.v, f)}。两者之差就是残差 u = v − v̂ = ${vec(d.residual, f)}——「还欠多少」。` +
        `把写入定义成最小化 ½‖S·k − v‖² 的拟合问题，梯度恰好是 (S·k − v)·kᵀ = −u·kᵀ：` +
        `想让表答对，就该沿着 −梯度、也就是 u·kᵀ 的方向更新。朴素写入用的是 v·kᵀ，忽略了表里已有的内容。`
      )
    },
  },
  {
    id: 'delta-rule',
    title: '⑤ 梯度走一步 = Delta 规则',
    phase: 'delta',
    variant: 'deltanet',
    tokenT: 3,
    formula: [
      sym('S', { sub: 't', role: 'state' }),
      op('='),
      sym('S', { sub: 't−1', role: 'state' }),
      op('+'),
      sym('β', { sub: 't', role: 'beta', bind: 'beta' }),
      grp([sym('v', { sub: 't' }), op('−'), sym('S', { sub: 't−1' }), sym('k', { sub: 't' })], {
        paren: true,
        role: 'residual',
      }),
      sym('k', { sub: 't', sup: 'T', role: 'input' }),
    ],
    views: ['state-equation', 'prediction', 'probes'],
    body: (step, f) => {
      const d = asDelta(step)
      const p1 = probe(d, 1)
      const pt = probe(d, d.t)
      return (
        `把残差按力度 β = ${f(d.beta)} 写回去：S ← S + β·u·kᵀ。写完立刻自检索，o = ${vec(d.output, f)}，` +
        `与目标 ${vec(pt.target, f)} 误差 ${f(pt.errorL2)}——β = 1 就是一步到位的最小二乘解（‖k‖ = 1 时精确）。` +
        `代价也要说清楚：k₁ 与当前 key 有重叠，回头读 k₁ 得到 ${vec(p1.retrieved, f)}、误差 ${f(p1.errorL2)}。` +
        `Delta 规则修正的是「沿当前 key 方向」的一整段记忆，不是只动一个槽位——它换来的是当前 key 的精确，而不是所有 key 的精确。`
      )
    },
    interview:
      'Delta 规则 = 对「S·k 应该等于 v」这个目标做一步梯度下降；β 就是这一步的步长，β=1 时是闭式最小二乘解。',
  },
  {
    id: 'transition-form',
    title: '⑥ 重排成转移矩阵：广义 Householder',
    phase: 'delta',
    variant: 'deltanet',
    tokenT: 4,
    formula: [
      sym('S', { sub: 't', role: 'state' }),
      op('='),
      sym('S', { sub: 't−1', role: 'state' }),
      grp(
        [sym('I'), op('−'), sym('β', { sub: 't', bind: 'beta' }), sym('k', { sub: 't' }), sym('k', { sub: 't', sup: 'T' })],
        { paren: true, role: 'decay' },
      ),
      op('+'),
      sym('β', { sub: 't', role: 'beta', bind: 'beta' }),
      sym('v', { sub: 't', role: 'input' }),
      sym('k', { sub: 't', sup: 'T', role: 'input' }),
    ],
    views: ['transition', 'state-equation'],
    body: (step, f) => {
      const d = asDelta(step)
      const p1 = probe(d, 1)
      return (
        `把「先读后写」代数展开重排，就得到干净的两段式：先乘一个转移矩阵 (I − β·k·kᵀ)，再加一笔写入 β·v·kᵀ。` +
        `第 ${d.t} 步 k = ${vec(d.k, f)}、β = ${f(d.beta)}，转移矩阵的对角线是 ${vec(diagOf(d.transition.full), f)}——` +
        `沿 k 方向的分量被整段清零（这就是 Householder 投影 I − k·kᵀ 在做的事），与 k 正交的方向纹丝不动。` +
        `清空后写入 v = ${vec(d.v, f)}，于是 S 的第一列变成 ${vec(colOf(d.sAfter, 0), f)}：` +
        `t1 写下的旧值被精确覆盖，探针误差回到 ${f(p1.errorL2)}。这是朴素写入永远做不到的——它只会把新值叠在旧值上。`
      )
    },
    interview:
      '「覆盖写」是 delta 类线性注意力的核心卖点：转移矩阵先把当前 key 方向清空，再写新值，所以同一 key 的更新是替换而不是叠加。',
  },
  {
    id: 'beta-interp',
    title: '⑦ β：写入力度就是一根插值旋钮',
    phase: 'delta',
    variant: 'deltanet',
    tokenT: 4,
    formula: [
      sym('S', { sub: 't', role: 'state' }),
      sym('k', { sub: 't', role: 'input' }),
      op('='),
      grp([sym('1'), op('−'), sym('β', { sub: 't', bind: 'beta' })], { paren: true, role: 'beta' }),
      sym('v̂', { sub: 't', role: 'decay' }),
      op('+'),
      sym('β', { sub: 't', role: 'beta', bind: 'beta' }),
      sym('v', { sub: 't', role: 'input' }),
    ],
    views: ['prediction', 'readout'],
    body: (step, f) => {
      const d = asDelta(step)
      return (
        `β 不是玄学学习率，它有一个干净的闭式含义：写完之后再用同一个 key 去读，读到的是旧预测与新值的线性插值。` +
        `当前 β = ${f(d.beta)}，所以读出 ${vec(d.output, f)} 完全等于新值 ${vec(d.v, f)}，旧预测 ${vec(d.prediction, f)} 被彻底顶掉；` +
        `β 拖到 0 则一笔不写、状态原样保留；拖到中间值，读出就落在 v̂ 与 v 的连线上。` +
        `真实模型里 β 由当前 token 现算——「这条信息值不值得覆盖已有记忆」是数据自己决定的。到「数值实验室」拖 β 滑块即可看到整条曲线随之移动。`
      )
    },
  },

  // ⑧–⑨ 遗忘门阶段
  {
    id: 'scalar-gate',
    title: '⑧ 标量遗忘门：整张表一起褪色',
    phase: 'gate',
    variant: 'gated',
    tokenT: 8,
    formula: [
      sym('S', { sub: 't', role: 'state' }),
      op('='),
      sym('α', { sub: 't', role: 'decay', bind: 'alphaMean' }),
      op('·'),
      sym('S', { sub: 't−1', role: 'state' }),
      grp([sym('I'), op('−'), sym('β', { sub: 't', bind: 'beta' }), sym('k', { sub: 't' }), sym('k', { sub: 't', sup: 'T' })], {
        paren: true,
        role: 'decay',
      }),
      op('+'),
      sym('β', { sub: 't', role: 'beta', bind: 'beta' }),
      sym('v', { sub: 't', role: 'input' }),
      sym('k', { sub: 't', sup: 'T', role: 'input' }),
    ],
    views: ['transition', 'state-equation', 'probes'],
    body: (step, f) => {
      const d = asDelta(step)
      const p1 = probe(d, 1)
      return (
        `Delta 规则只会「按 key 方向替换」，没有随时间自然遗忘的能力。最简单的补法是每步整体乘一个标量 α = ${f(d.alpha[0])}：` +
        `第 ${d.t} 步衰减前 S 的第一列是 ${vec(colOf(d.sBefore, 0), f)}，乘完 α 变成 ${vec(colOf(d.sDecayed, 0), f)}。` +
        `t4 覆盖写下的值到这一步已经褪到 ${vec(p1.retrieved, f)}、探针误差涨到 ${f(p1.errorL2)}，而且还会继续涨。` +
        `注意这是无差别衰减：长期该记住的和早该忘掉的，一起按同一个比例变淡——这既是标量门的全部好处，也是它的全部局限。`
      )
    },
  },
  {
    id: 'diag-gate',
    title: '⑨ 对角遗忘门：KDA 的核心自由度',
    phase: 'gate',
    variant: 'kda',
    tokenT: 8,
    formula: [
      sym('S', { sub: 't', role: 'state' }),
      op('='),
      sym('S', { sub: 't−1', role: 'state' }),
      op('·'),
      grp([sym('Diag'), grp([sym('α', { sub: 't' })], { paren: true })], { role: 'decay' }),
      grp([sym('I'), op('−'), sym('β', { sub: 't', bind: 'beta' }), sym('k', { sub: 't' }), sym('k', { sub: 't', sup: 'T' })], {
        paren: true,
        role: 'decay',
      }),
      op('+'),
      sym('β', { sub: 't', role: 'beta', bind: 'beta' }),
      sym('v', { sub: 't', role: 'input' }),
      sym('k', { sub: 't', sup: 'T', role: 'input' }),
    ],
    views: ['transition', 'gate-compare', 'state-equation', 'probes'],
    body: (step, f) => {
      const d = asDelta(step)
      const p1 = probe(d, 1)
      const p5 = probe(d, 5)
      return (
        `把标量 α 换成逐通道的向量 α = ${vec(d.alpha, f)}，衰减就作用在 Diag(α) 上、按 key 通道分别生效。` +
        `第 ${d.t} 步的效果一眼可见：写在高 α 通道上的记忆读出 ${vec(p1.retrieved, f)}、误差仍是 ${f(p1.errorL2)}（分毫未动）；` +
        `写在低 α 通道上的 t5 记忆已经衰减到 ${vec(p5.retrieved, f)}、误差 ${f(p5.errorL2)}。` +
        `同一层里，一部分通道当长期记忆、另一部分当短期草稿纸——标量门只能整体调快慢，做不到这件事。` +
        `右侧把 Gated 与 KDA 的转移矩阵并排：标量门的每个通道缩放相同，对角门的每一列各缩各的。`
      )
    },
    interview:
      'Gated DeltaNet 的门是标量、KDA 的门是对角矩阵：前者只能决定「忘得多快」，后者能决定「哪些通道忘、哪些通道不忘」。',
  },

  // ⑩ DPLR 阶段
  {
    id: 'dplr',
    title: '⑩ DPLR 分解：对角 + 秩 1，且低秩因子绑定同一个 k',
    phase: 'dplr',
    variant: 'kda',
    tokenT: 6,
    formula: [
      grp([sym('Diag'), grp([sym('α')], { paren: true })], { role: 'decay' }),
      grp([sym('I'), op('−'), sym('β', { bind: 'beta' }), sym('k'), sym('k', { sup: 'T' })], { paren: true }),
      op('='),
      grp([sym('Diag'), grp([sym('α')], { paren: true })], { role: 'decay' }),
      op('+'),
      grp([sym('a'), sym('b', { sup: 'T' })], { role: 'residual' }),
      op('，'),
      sym('a'),
      op('='),
      op('−'),
      sym('β', { role: 'beta', bind: 'beta' }),
      grp([sym('α'), op('⊙'), sym('k')], { paren: true }),
      op('，'),
      sym('b'),
      op('='),
      sym('k', { role: 'input' }),
    ],
    views: ['dplr', 'transition'],
    body: (step, f) => {
      const d = asDelta(step)
      return (
        `那个看起来吓人的稠密转移矩阵，其实是「对角 + 秩 1」（DPLR，Diagonal Plus Low-Rank）。` +
        `第 ${d.t} 步实测：对角部分就是 α = ${vec(d.transition.diag, f)}，低秩因子 a = ${vec(d.transition.lowRankA, f)}、` +
        `b = k = ${vec(d.transition.lowRankB, f)}，两者重构出的矩阵与直接计算逐元素一致（右侧热力图可对照）。` +
        `关键在结构约束：一般 DPLR 允许 a、b 是两个互相独立的向量，而 KDA 强制 b ≡ k、a 只是 k 的逐通道缩放——` +
        `少一组独立参数，分块 kernel 就能省掉一半的矩阵乘与中间量，官方报告约 2× 的算子级加速。` +
        `务必分清层级：这是 kernel/算子级收益，不等于端到端吞吐翻倍。`
      )
    },
    interview:
      'KDA 是 DPLR 的一个受限特例——低秩两个因子绑定到同一个 k，用一点表达力换分块 kernel 约 2× 加速；这是算子级收益，别直接当成端到端提速。',
    sourceUrl: 'https://arxiv.org/abs/2510.26692',
    asOf: '2025-10',
  },

  // ⑪ 位置编码阶段
  {
    id: 'positional',
    title: '⑪ 转移矩阵连乘 = 数据依赖的乘性位置编码',
    phase: 'position',
    variant: 'kda',
    tokenT: 8,
    formula: [
      sym('S', { sub: 't', role: 'state' }),
      op('='),
      {
        kind: 'stack',
        op: 'Σ',
        below: 'i≤t',
        children: [
          sym('β', { sub: 'i', role: 'beta' }),
          sym('u', { sub: 'i', role: 'residual' }),
          sym('k', { sub: 'i', sup: 'T', role: 'input' }),
          { kind: 'stack', op: 'Π', below: 'j=i+1', above: 't', children: [sym('A', { sub: 'j', role: 'decay' })] },
        ],
      },
      op('，'),
      sym('A', { sub: 'j', role: 'decay' }),
      op('='),
      grp([sym('Diag'), grp([sym('α', { sub: 'j' })], { paren: true })], { role: 'decay' }),
      grp([sym('I'), op('−'), sym('β', { sub: 'j' }), sym('k', { sub: 'j' }), sym('k', { sub: 'j', sup: 'T' })], {
        paren: true,
      }),
    ],
    views: ['transition-chain', 'transition'],
    body: (step, f) => {
      const d = asDelta(step)
      return (
        `把递推展开就看清了：第 i 步写进去的那一笔，要先乘上其后所有步的转移矩阵 Π A_j 才会被第 t 步读到。` +
        `换句话说，「相对位置」不是加在 Q/K 上的固定旋转，而是一条由数据自己算出来的乘性衰减链——α 和 β 都由当前 token 现算。` +
        `第 ${d.t} 步的转移矩阵对角线是 ${vec(diagOf(d.transition.full), f)}：高 α 通道原样透传、低 α 通道快速缩水、` +
        `恰好等于本步写入方向的那一列被清零。同一层里，不同通道有各自的「记忆半衰期」。` +
        `正因为位置信息已经被这条链条编码进状态，KDA 层不再需要 RoPE；混合栈里保留的少量 Gated MLA 层才是负责精确长程召回的那一半。`
      )
    },
    interview:
      'KDA 层不加 RoPE：转移矩阵连乘本身就是数据依赖的乘性位置编码，固定旋转被换成了逐通道、由内容决定的衰减。',
  },
]

// ─────────── Tab2 数值实验室：观察要点（定性描述，不含具体数值） ───────────

export const LAB_TAKEAWAYS: readonly string[] = [
  '朴素写入只加不减：key 一旦不正交，交叉项就永久留在表里，误差曲线整体抬得最高且不回落。',
  'Delta 规则先读后写：沿当前 key 方向擦掉旧值再补新值，所以「同一 key 的覆盖写」能把误差压回去——曲线在覆盖步上明显下探。',
  'β 是写入力度：拖到 0 相当于一笔不写（delta 系状态停在原地），拖到 1 是完全覆盖，中间值让读出落在旧预测与新值之间。',
  '标量门无差别衰减：Gated 的所有通道乘同一个 α，早期正交写入也会跟着褪色，探针误差随步数缓慢爬升。',
  '对角门可选择性遗忘：把某些通道的 α 设到 1、另一些拖低，就能同时拥有长期记忆与快速清空的草稿纸——这正是 KDA 相对标量门的核心自由度。',
  '四张热力图共享同一色标（格色只表示数值正负与幅值，与曲线的变体系列色无关），因此可以直接横向比较同一格的深浅。',
  '曲线是「对所有已写入 key 的检索误差均值」，覆盖写之后目标切换为最新写入值——所以覆盖成功表现为误差下降而不是上升。',
]

// ─────────── Tab3 分块并行：中间矩阵职责说明 ───────────

export type ChunkMatrixKey =
  | 'K'
  | 'V'
  | 'gammas'
  | 'kPlus'
  | 'kMinus'
  | 'kHat'
  | 'gram'
  | 'T'
  | 'W'
  | 'U'
  | 'vEff'
  | 'X'
  | 'sIn'
  | 'sOut'
  | 'outputs'

export const CHUNK_MATRIX_NOTES: Readonly<Record<ChunkMatrixKey, string>> = {
  K: '块内归一化 key，一行一个 token——分块的起点是把整块的 K/V 一次性摊平成矩阵。',
  V: '块内 value，一行一个 token；与 K 同序。',
  gammas: 'γ_t = 块内累积衰减 α_1⊙…⊙α_t：把「逐步乘 α」提前折叠成每行一个缩放向量。',
  kPlus: 'K⁺ 行 t = k_t⊙γ_t：把 t 之前该吃的衰减先乘进 key，后续矩阵乘就不必再逐步衰减。',
  kMinus: 'K⁻ 行 t = k_t⊙γ_t⁻¹：与 K⁺ 配对，让 ⟨K⁺行t, K⁻行i⟩ 恰好等于「i 的 key 衰减到 t 时」与 k_t 的内积。',
  kHat: 'K̂ 行 t = k_t⊙(γ_C/γ_t)：块尾结算用的 key——把每行写入衰减到块末尾那一刻。',
  gram: '严格下三角的块内因果 Gram 矩阵 tril(diag(β)·K⁺(K⁻)ᵀ, −1)：第 i 行第 j 列 = 第 j 个 token 对第 i 个 token 的干扰量，上三角必须为 0（因果）。',
  T: 'T = (I + gram)⁻¹·diag(β)，广义 UT 变换。单位下三角前代求解即可，无需通用求逆——它一次性解开块内所有「先写的会影响后写的」依赖。',
  W: 'W = T·K⁺：经典 WY 表示里的 W 矩阵；α≡1 时 K⁺ = K，正好还原 Yang et al. 的 DeltaNet WY 形式。',
  U: 'U = T·V：WY 表示的另一半，与 W 一起把整块更新写成 S_in(I − WᵀK) + UᵀK。',
  vEff: 'V − K⁺·S_inᵀ：扣掉「块入口状态已经能答对的部分」，剩下的才是本块真正要补写的量。',
  X: 'X = T·vEff：行 t 正好等于逐步递推里的缩放残差 β·u_t——分块路径与递推路径在这里对齐。',
  sIn: '块入口状态：第 0 块为零矩阵，之后每块的 sIn 就是上一块的 sOut（跨块唯一的串行依赖）。',
  sOut: 'S_out = S_in·Diag(γ_C) + Xᵀ·K̂：一次矩阵乘结算整块，与逐 token 递推逐元素相等（恒等变形，非近似）。',
  outputs: 'O = Q⁺·S_inᵀ + tril_incl(Q⁺(K⁻)ᵀ)·X：块内所有 token 的读出一次算完，前项来自块入口状态、后项来自块内因果贡献。',
}

/** 中间矩阵的显示名（UI 标题用；键与 ChunkStage 字段一一对应） */
export const CHUNK_MATRIX_LABELS: Readonly<Record<ChunkMatrixKey, string>> = {
  K: 'K　块内 key',
  V: 'V　块内 value',
  gammas: 'γ　累积衰减（行 = 块内第几步）',
  kPlus: 'K⁺ = k ⊙ γ',
  kMinus: 'K⁻ = k ⊙ γ⁻¹',
  kHat: 'K̂ = k ⊙ (γ_C / γ)',
  gram: 'gram = tril(diag(β)·K⁺(K⁻)ᵀ, −1)',
  T: 'T = (I + gram)⁻¹·diag(β)',
  W: 'W = T·K⁺',
  U: 'U = T·V',
  vEff: 'V − K⁺·S_inᵀ',
  X: 'X = T·(V − K⁺·S_inᵀ)',
  sIn: 'S_in　块入口状态',
  sOut: 'S_out　块尾状态',
  outputs: 'O　块内逐 token 读出',
}

export interface ChunkViewMeta {
  readonly id: 'deltanet' | 'kda'
  readonly label: string
  readonly desc: string
}

export const CHUNK_VIEWS: readonly ChunkViewMeta[] = [
  {
    id: 'deltanet',
    label: 'DeltaNet 经典 WY',
    desc: 'α ≡ 1 的退化路径：γ 全为 1，K⁺ = K⁻ = K̂ = K，T/W/U 就是 Yang et al. 的 WY 表示——先把这台阶站稳。',
  },
  {
    id: 'kda',
    label: 'KDA 衰减折叠',
    desc: '带逐通道衰减的完整版：把 γ 折进 K⁺/K⁻/K̂ 三份 key，同一套 WY 骨架照样成立，块尾再统一乘 Diag(γ_C)。',
  },
]

export const CHUNK_INTRO =
  '递推是串行的（第 t 步要等第 t−1 步），训练时会把 GPU 饿死。分块并行把序列切成固定大小的 chunk：块内用矩阵乘一次算完、块间才串行传状态。' +
  '这是恒等变形而不是近似——右下角的恒等徽章直接显示引擎算出的 max|S_递推 − S_分块|。'

// ─────────── Tab4 网络结构 ───────────

let k3ModelCache: (typeof MODELS)[number] | null = null

/**
 * K3 事实字段的唯一引用出口（不复制第二份，字段更新只改 models.ts）。
 * 惰性求值：条目缺失时在首次调用（组件 render 期）才 throw，
 * 由路由级 ErrorBoundary 接住只废当前页——模块级 throw 会在 import 时炸掉整个 chunk，边界接不住。
 */
export function getK3ModelSpec(): (typeof MODELS)[number] {
  if (!k3ModelCache) {
    const found = MODELS.find((m) => m.id === 'kimi-k3')
    if (!found) throw new Error('kda.ts: models.ts 缺少 kimi-k3 条目，网络结构 tab 无法引用事实数据')
    k3ModelCache = found
  }
  return k3ModelCache
}

const KDA_LAYERS = 69
const MLA_LAYERS = 24

export interface K3Structure {
  readonly kdaLayers: number
  readonly mlaLayers: number
  readonly totalLayers: number
  readonly ratioNote: string
  readonly interleaveNote: string
  readonly sourceUrl: string
  readonly asOf: string
}

/**
 * K3 层结构的结构化计数（UI 条带与文案的唯一数字来源）。
 * 口径与 src/data/models.ts 的 kimi-k3 条目同源（该条目以文案形式记录 69/24），
 * src/data/kda.test.ts 断言两处数字一致，防止未来单边漂移。
 */
export const K3_STRUCTURE: K3Structure = {
  kdaLayers: KDA_LAYERS,
  mlaLayers: MLA_LAYERS,
  totalLayers: KDA_LAYERS + MLA_LAYERS,
  ratioNote: '约 3:1（每 3 层 KDA 配 1 层 Gated MLA）',
  interleaveNote: '条带按 3:1 顺序示意排布——官方未公布逐层的具体交错顺序，此处仅示意比例。',
  // getter 惰性引用 models.ts 条目：保持与 getK3ModelSpec 相同的「首次访问才 throw」语义
  get sourceUrl() {
    return getK3ModelSpec().sourceUrl
  },
  get asOf() {
    return getK3ModelSpec().asOf
  },
}

export type LayerKind = 'kda' | 'mla'

/**
 * 93 层条带的**示意**排布：把 24 层 Gated MLA 按比例均匀撒进 93 个槽位，其余为 KDA。
 * 官方未公布逐层的具体交错顺序（见 K3_STRUCTURE.interleaveNote），此处只保证比例与总数正确——
 * src/data/kda.test.ts 断言产出恰好是 kdaLayers / mlaLayers / totalLayers。
 */
export function buildLayerBand(): readonly LayerKind[] {
  const { kdaLayers, mlaLayers, totalLayers } = K3_STRUCTURE
  const mlaAt = new Set<number>()
  for (let j = 1; j <= mlaLayers; j++) mlaAt.add(Math.round((j * totalLayers) / mlaLayers) - 1)
  if (mlaAt.size !== mlaLayers) throw new Error('buildLayerBand: MLA 槽位分配发生碰撞，条带计数会与 K3_STRUCTURE 不符')
  const band = Array.from({ length: totalLayers }, (_, i): LayerKind => (mlaAt.has(i) ? 'mla' : 'kda'))
  if (band.filter((x) => x === 'kda').length !== kdaLayers) throw new Error('buildLayerBand: KDA 层计数与 K3_STRUCTURE 不符')
  return band
}

export interface NetworkNode {
  readonly id: string
  readonly name: string
  readonly enName: string
  readonly what: string
  readonly why: string
  readonly interview: string
}

export const NETWORK_NODES: readonly NetworkNode[] = [
  {
    id: 'hybrid-stack',
    name: '混合注意力栈',
    enName: 'Hybrid Attention Stack',
    what: '整栈按固定比例交错两种注意力层：绝大多数层是 KDA 线性注意力（状态恒定），少数层是 Gated MLA 全注意力（cache 随长度增长）。',
    why: '纯线性注意力在「大海捞针」式精确召回上会掉分，纯全注意力在 1M 上下文下 KV cache 又付不起。混合栈是当下的工程折中：把绝大部分层的 cache 压成常数，留少量层保召回。',
    interview: '不要说「K3 用线性注意力所以没有 KV cache」——只有 KDA 层没有，Gated MLA 层的 cache 照样随长度增长，长上下文显存账要按这少数层算。',
  },
  {
    id: 'kda-layer',
    name: 'KDA 层',
    enName: 'Kimi Delta Attention',
    what: '每个 token 从 x 投影出 q/k/v 与两个门 β、α，先用 Diag(α)(I − βkkᵀ) 更新固定大小的状态矩阵 S，再读出 o = S·q。',
    why: '状态大小只由 d_k×d_v 决定、与序列长度无关，所以推理显存不随上下文增长；delta 规则保证同一 key 的覆盖写是替换而非叠加，对角门让不同通道有各自的记忆半衰期。',
    interview: 'KDA = 带逐通道遗忘门的 delta-rule 线性注意力；DPLR 低秩因子绑定同一个 k 换来分块 kernel 约 2× 加速（算子级，非端到端）。',
  },
  {
    id: 'gated-mla',
    name: 'Gated MLA 层',
    enName: 'Gated Multi-head Latent Attention',
    what: '保留标准全注意力语义的层，K/V 低秩压缩成 latent 缓存（MLA），并加输出门控。K3 只在少数层使用。',
    why: '线性注意力的固定状态终究是有损压缩，精确定位「第几段第几句」这类任务需要真正的全注意力兜底。MLA 让这少数层的 cache 也尽量小。',
    interview: '混合栈里全注意力层的数量，直接决定长上下文 KV cache 的实际账单——这是评估「1M 上下文能不能部署」的关键数字。',
  },
  {
    id: 'moe-ffn',
    name: 'MoE 前馈层',
    enName: 'Mixture-of-Experts FFN',
    what: '把稠密 FFN 换成大量专家 + 路由，每个 token 只激活其中很小一部分（另有常驻共享专家）。',
    why: '总参数决定显存、激活参数决定算力：极稀疏化让模型容量涨上去而单 token 计算量不涨——这是「大模型还能更大」的主要杠杆。',
    interview: '售前算账口诀：总参看显存、激活参看算力、专家数看路由负载均衡——三件事分开算，别混成一个「参数量」。',
  },
  {
    id: 'attn-residual',
    name: 'Attention Residuals',
    enName: 'Attention Residuals',
    what: '替代逐层均匀累加的残差连接：让后面的层可以跨深度「选择性检索」前面各层的表征，而不是被动接收累加和。',
    why: '深栈里均匀残差会把不同层的信息糊在一起；选择性检索让每一层拿到自己真正需要的那部分历史表征。',
    interview: '官方口径的 ~2.5× 缩放效率提升是 KDA + Attention Residuals + MoE 稀疏化 + 训练配方的综合收益，不能单项归因给 KDA。',
  },
]

/** KDA 单层数据流动画的四幕说明（KdaLayerFlow 的文案来源） */
export const KDA_LAYER_ACTS: readonly { readonly title: string; readonly desc: string }[] = [
  { title: '① 投影', desc: '当前 token 的 x 投影出 q / k / v，以及写入力度 β 和逐通道遗忘门 α。' },
  { title: '② 衰减 + 擦除', desc: '状态先乘 Diag(α) 按通道褪色，再乘 (I − βkkᵀ) 清掉当前 key 方向的旧值。' },
  { title: '③ 写入', desc: '把 β·v·kᵀ 加回状态——同一个 key 的旧内容已被清空，所以这是替换而不是叠加。' },
  { title: '④ 读出', desc: 'o = S·q 一次矩阵–向量乘。状态尺寸恒定，读出成本与上下文长度无关。' },
]

export const KDA_LAYER_FOOTNOTE =
  '状态是固定大小的矩阵：整层没有随 token 数增长的缓存，这就是「KDA 层不贡献 KV cache 膨胀」的字面含义。'
