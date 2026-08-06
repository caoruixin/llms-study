// KDA 数学引擎：Naive 线性注意力 → DeltaNet → Gated DeltaNet → KDA 的纯函数数值内核
// （PLAN-kda-demo.md §1/§2 的实现；UI 唯一取数来源，组件禁止自行计算或硬编码数字）
//
// 数学约定（全文件统一）：
//   S ∈ R^{d_v×d_k}：行 = value 维，列 = key 通道；读出 o_t = S_t·q_t，demo 约定 q_t = k_t
//   k 使用前一律归一化（‖k‖=1）；β ∈ [0,1]；α ∈ [0,1]
//   四变体递推（§1，四个单步函数各自独立实现，退化链单测交叉验证）：
//     Naive    S_t = S_{t-1} + v_t k_t^T
//     DeltaNet S_t = S_{t-1}(I − β k k^T) + β v k^T
//     Gated    S_t = α·S_{t-1}(I − β k k^T) + β v k^T
//     KDA      S_t = S_{t-1}·Diag(α)·(I − β k k^T) + β v k^T
//   分块并行（§1，恒等变形非近似）：块内累积衰减 γ_t = α^t（引擎将 α 视为场景常量，
//   但公式按逐 token 一般式实现，未来支持逐 token α 只需改 γ 累积来源）：
//     K⁺行t = k_t⊙γ_t   K⁻行t = k_t⊙γ_t⁻¹   K̂行t = k_t⊙(γ_C/γ_t)   Q⁺ = K⁺（q=k）
//     T = (I + tril(diag(β)·K⁺(K⁻)^T, −1))⁻¹·diag(β)   ← 单位下三角前代求解，不做通用求逆
//     X = T·(V − K⁺·S_in^T)（行 t = 缩放残差 u_t = β(v_t − S_{t-1}Diag(α)k_t)）
//     S_out = S_in·Diag(γ_C) + X^T·K̂
//     O = Q⁺·S_in^T + tril_incl(Q⁺(K⁻)^T)·X
//   推导核心恒等式：⟨k_i⊙γ_t/γ_i, k_t⟩ = ⟨K⁻行i, K⁺行t⟩（K⁺/K⁻ 因子化的由来）
//   确定性：全文件禁 Date.now/Math.random，无全局可变状态

export type Vec = readonly number[]
export type Mat = readonly (readonly number[])[] // 行优先

// ─────────── L0 线代原语 ───────────

export function zeros(rows: number, cols: number): Mat {
  return Array.from({ length: rows }, () => Array<number>(cols).fill(0))
}

export function identity(n: number): Mat {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
}

export function dot(a: Vec, b: Vec): number {
  if (a.length !== b.length) throw new Error(`dot: 维度不匹配 ${a.length} vs ${b.length}`)
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

// 逐元素积 a⊙b
export function hadamard(a: Vec, b: Vec): Vec {
  if (a.length !== b.length) throw new Error(`hadamard: 维度不匹配 ${a.length} vs ${b.length}`)
  return a.map((x, i) => x * b[i])
}

export function matVec(m: Mat, v: Vec): Vec {
  return m.map((row) => dot(row, v))
}

export function matMul(a: Mat, b: Mat): Mat {
  const bT = transpose(b)
  return a.map((row) => bT.map((col) => dot(row, col)))
}

// 外积 u·v^T（rows = |u|, cols = |v|）
export function outer(u: Vec, v: Vec): Mat {
  return u.map((x) => v.map((y) => x * y))
}

export function transpose(m: Mat): Mat {
  if (m.length === 0) return []
  return m[0].map((_, j) => m.map((row) => row[j]))
}

export function addMat(a: Mat, b: Mat): Mat {
  assertSameShape(a, b, 'addMat')
  return a.map((row, i) => row.map((x, j) => x + b[i][j]))
}

export function subMat(a: Mat, b: Mat): Mat {
  assertSameShape(a, b, 'subMat')
  return a.map((row, i) => row.map((x, j) => x - b[i][j]))
}

// m·Diag(α)：第 j 列整体缩放 α_j（衰减门作用在 key 通道上）
export function scaleColumns(m: Mat, alpha: Vec): Mat {
  if (m.length > 0 && m[0].length !== alpha.length) {
    throw new Error(`scaleColumns: 列数 ${m[0].length} ≠ α 长度 ${alpha.length}`)
  }
  return m.map((row) => row.map((x, j) => x * alpha[j]))
}

export function normalize(v: Vec): Vec {
  const n = Math.sqrt(dot(v, v))
  if (n < 1e-12) throw new Error('normalize: 零向量无法归一化')
  return v.map((x) => x / n)
}

export function maxAbsDiff(a: Mat, b: Mat): number {
  assertSameShape(a, b, 'maxAbsDiff')
  let m = 0
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a[i].length; j++) m = Math.max(m, Math.abs(a[i][j] - b[i][j]))
  }
  return m
}

// 前代替换解 (I + L)·X = RHS，L 为严格下三角（对角线为 0）——单位下三角专用，不做通用矩阵求逆
export function solveUnitLower(strictLower: Mat, rhs: Mat): Mat {
  const n = strictLower.length
  if (rhs.length !== n) throw new Error(`solveUnitLower: L 为 ${n}×${n} 但 RHS 有 ${rhs.length} 行`)
  const x: number[][] = []
  for (let i = 0; i < n; i++) {
    const row: number[] = []
    for (let j = 0; j < rhs[i].length; j++) {
      // X[i][j] = RHS[i][j] − Σ_{p<i} L[i][p]·X[p][j]
      let s = rhs[i][j]
      for (let p = 0; p < i; p++) s -= strictLower[i][p] * x[p][j]
      row.push(s)
    }
    x.push(row)
  }
  return x
}

// 全站唯一数字格式化入口（杜绝 0.71 / 0.707 两副面孔）：
// 四舍五入到 digits 位 → 去尾零 → “-0”归一为“0”。例：fmt(√2/2)='0.71'、fmt(2)='2'、fmt(-1e-13)='0'
export function fmt(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return String(x)
  let s = x.toFixed(digits)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' ? '0' : s
}

function assertSameShape(a: Mat, b: Mat, fn: string): void {
  if (a.length !== b.length || (a.length > 0 && a[0].length !== b[0].length)) {
    throw new Error(`${fn}: 形状不匹配 ${a.length}×${a[0]?.length ?? 0} vs ${b.length}×${b[0]?.length ?? 0}`)
  }
}

// ─────────── L1 四变体单步（独立实现，互不包装）+ DPLR 分解 ───────────

export type VariantId = 'naive' | 'deltanet' | 'gated' | 'kda'

// Naive：S_t = S_{t-1} + v k^T（只加不减 → 非正交 key 干扰累积）
export function stepNaive(sPrev: Mat, k: Vec, v: Vec): Mat {
  return addMat(sPrev, outer(v, k))
}

// DeltaNet：S_t = S_{t-1}(I − βkk^T) + βvk^T = S_{t-1} − β(S_{t-1}k)k^T + βvk^T
export function stepDeltaNet(sPrev: Mat, k: Vec, v: Vec, beta: number): Mat {
  const sk = matVec(sPrev, k)
  const erased = subMat(
    sPrev,
    outer(
      sk.map((x) => beta * x),
      k,
    ),
  )
  return addMat(
    erased,
    outer(
      v.map((x) => beta * x),
      k,
    ),
  )
}

// Gated：S_t = α·S_{t-1}(I − βkk^T) + βvk^T（标量遗忘门；标量与转移矩阵可交换，先衰减再擦写）
export function stepGated(sPrev: Mat, k: Vec, v: Vec, beta: number, alpha: number): Mat {
  const decayed = sPrev.map((row) => row.map((x) => alpha * x))
  const sk = matVec(decayed, k)
  const erased = subMat(
    decayed,
    outer(
      sk.map((x) => beta * x),
      k,
    ),
  )
  return addMat(
    erased,
    outer(
      v.map((x) => beta * x),
      k,
    ),
  )
}

// KDA：S_t = S_{t-1}·Diag(α)·(I − βkk^T) + βvk^T（逐 key 通道遗忘门）
export function stepKda(sPrev: Mat, k: Vec, v: Vec, beta: number, alphaVec: Vec): Mat {
  const decayed = scaleColumns(sPrev, alphaVec)
  const sk = matVec(decayed, k)
  const erased = subMat(
    decayed,
    outer(
      sk.map((x) => beta * x),
      k,
    ),
  )
  return addMat(
    erased,
    outer(
      v.map((x) => beta * x),
      k,
    ),
  )
}

// DPLR 分解：Diag(α)(I − βkk^T) = Diag(α) + a·b^T，a = −β(α⊙k)，b = k
// （低秩因子绑定同一 k：这是 KDA 相对一般 DPLR 换取 ≈2× kernel 加速的结构约束）
export interface DplrTransition {
  readonly full: Mat // d_k×d_k 完整转移矩阵
  readonly diag: Vec // Diag 部分 = α
  readonly lowRankA: Vec // a = −β(α⊙k)
  readonly lowRankB: Vec // b = k
}

export function dplrTransition(k: Vec, beta: number, alphaVec: Vec): DplrTransition {
  const a = hadamard(alphaVec, k).map((x) => -beta * x)
  const full = addMat(scaleColumns(identity(k.length), alphaVec), outer(a, k))
  return { full, diag: alphaVec, lowRankA: a, lowRankB: [...k] }
}

// ─────────── 单步 trace 类型（判别式联合：naive 无预测/残差，编译器强制分支） ───────────

// 检索探针语义（教学关键）：target = 「当前应检索到的最新值」。
// 若 srcT 之后存在向同一 key 方向的再次写入（如默认场景 t4 覆盖 t1、t7 覆盖 t2），
// target 切换为最新写入的 v（targetT 记录来源），originalTarget 保留原始写入值。
// 否则「覆盖写成功」会被误显示为“误差升高”，与教学结论相反。
export interface RetrievalProbe {
  readonly srcT: number // 探针来源 token（1-based）
  readonly retrieved: Vec // S_t·k_srcT
  readonly originalTarget: Vec // v_srcT：srcT 步原始写入值
  readonly target: Vec // 最新应检索值（见上）
  readonly targetT: number // target 来自哪个 token（无覆盖时 = srcT）
  readonly errorL2: number // ‖retrieved − target‖₂
}

export interface StepBase {
  readonly t: number // 1-based
  readonly kRaw: Vec
  readonly k: Vec // 归一化后的 key
  readonly v: Vec
  readonly sBefore: Mat
  readonly sAfter: Mat
  readonly output: Vec // o_t = S_t·q_t（q=k）
  readonly retrieval: readonly RetrievalProbe[] // 第 t 步含 srcT=1..t 全量探针
}

export type TokenStep =
  | (StepBase & { readonly kind: 'naive'; readonly writeOuter: Mat })
  | (StepBase & {
      readonly kind: 'delta'
      readonly variant: 'deltanet' | 'gated' | 'kda'
      readonly beta: number
      readonly alpha: Vec // gated 广播成向量（UI 统一渲染）；deltanet 为全 1
      readonly sDecayed: Mat // S_{t-1}·Diag(α)
      readonly prediction: Vec // v̂ = S_{t-1}·Diag(α)·k（衰减后预测）
      readonly residual: Vec // u = v − v̂
      readonly writeOuter: Mat // β·u·k^T（满足 sAfter = sDecayed + writeOuter − 数值恒等）
      readonly transition: DplrTransition
    })

// ─────────── L4 场景类型（提前声明，L2/L3 依赖） ───────────

export type TokenRole = 'write-ortho' | 'write-conflict' | 'overwrite'

export interface ScenarioToken {
  readonly t: number // 1-based，必须连续
  readonly kRaw: Vec
  readonly v: Vec
  readonly role: TokenRole
  readonly overwrites?: number // 声明式标注覆盖目标 t（仅供 UI 文案；探针目标由 key 方向自动判定）
}

export interface ScenarioSpec {
  readonly id: string
  readonly dK: number
  readonly dV: number
  readonly chunkSize: number
  readonly tokens: readonly ScenarioToken[]
  // β/α 默认值全站唯一出处（§5 数据一致性机制），任何组件禁止自设第二默认值
  readonly defaults: { readonly beta: number; readonly alphaScalar: number; readonly alphaVec: Vec }
}

export interface LabOverrides {
  readonly beta?: number
  readonly alphaScalar?: number
  readonly alphaVec?: Vec
}

export interface VariantParams {
  readonly beta: number
  readonly alphaScalar: number
  readonly alphaVec: Vec
}

// 预设场景（PLAN-kda-demo.md §3 表格原样）：d_k=d_v=4，8 token，chunkSize=4（恰 2 块）。
// KDA αVec=(1,1,0.5,0.9)：通道 1/2 永久记忆、通道 3 快遗忘、通道 4 慢遗忘。
export const DEFAULT_SCENARIO: ScenarioSpec = {
  id: 'kda-default-8tok',
  dK: 4,
  dV: 4,
  chunkSize: 4,
  tokens: [
    { t: 1, kRaw: [1, 0, 0, 0], v: [2, 0, 0, 0], role: 'write-ortho' },
    { t: 2, kRaw: [0, 1, 0, 0], v: [0, 2, 0, 0], role: 'write-ortho' },
    { t: 3, kRaw: [1, 1, 0, 0], v: [0, 0, 2, 0], role: 'write-conflict' },
    { t: 4, kRaw: [1, 0, 0, 0], v: [-2, 0, 0, 0], role: 'overwrite', overwrites: 1 },
    { t: 5, kRaw: [0, 0, 1, 0], v: [0, 0, 3, 0], role: 'write-ortho' },
    { t: 6, kRaw: [0, 0, 1, 1], v: [0, 0, 0, 2], role: 'write-conflict' },
    { t: 7, kRaw: [0, 1, 0, 0], v: [0, -1, 0, 0], role: 'overwrite', overwrites: 2 },
    { t: 8, kRaw: [0, 0, 0, 1], v: [1, 0, 0, 1], role: 'write-ortho' },
  ],
  defaults: { beta: 1, alphaScalar: 0.9, alphaVec: [1, 1, 0.5, 0.9] },
}

// 场景合法性校验（维度/取值范围违规 throw）。
// 注意：α ≥ 0.05 是「分块路径」的数值边界（K⁻ 含 γ⁻¹），由 runChunkedTrace 校验；
// 递推路径允许 α = 0，故此处只要求 α ∈ [0,1]。
export function validateScenario(s: ScenarioSpec): void {
  const isPosInt = (x: number) => Number.isInteger(x) && x > 0
  if (!isPosInt(s.dK) || !isPosInt(s.dV) || !isPosInt(s.chunkSize)) {
    throw new Error('validateScenario: dK/dV/chunkSize 必须为正整数')
  }
  if (s.tokens.length === 0) throw new Error('validateScenario: tokens 不能为空')
  s.tokens.forEach((tok, i) => {
    if (tok.t !== i + 1) throw new Error(`validateScenario: token t 必须连续 1..N（位置 ${i} 处为 ${tok.t}）`)
    if (tok.kRaw.length !== s.dK) throw new Error(`validateScenario: t=${tok.t} 的 kRaw 长度 ≠ dK`)
    if (tok.v.length !== s.dV) throw new Error(`validateScenario: t=${tok.t} 的 v 长度 ≠ dV`)
    if (Math.sqrt(dot(tok.kRaw, tok.kRaw)) < 1e-12) throw new Error(`validateScenario: t=${tok.t} 的 kRaw 不能为零向量`)
    if (tok.overwrites !== undefined && (!Number.isInteger(tok.overwrites) || tok.overwrites < 1 || tok.overwrites >= tok.t)) {
      throw new Error(`validateScenario: t=${tok.t} 的 overwrites 必须指向更早的 token`)
    }
  })
  const in01 = (x: number) => x >= 0 && x <= 1
  if (!in01(s.defaults.beta)) throw new Error('validateScenario: β 必须在 [0,1]')
  if (!in01(s.defaults.alphaScalar)) throw new Error('validateScenario: alphaScalar 必须在 [0,1]')
  if (s.defaults.alphaVec.length !== s.dK || !s.defaults.alphaVec.every(in01)) {
    throw new Error('validateScenario: alphaVec 长度必须为 dK 且每通道在 [0,1]')
  }
}

// defaults 与 LabOverrides 的唯一合并点（runVariantTrace / runChunkedTrace / buildKdaTrace 共用）
function resolveParams(s: ScenarioSpec, o: LabOverrides): VariantParams {
  const beta = o.beta ?? s.defaults.beta
  const alphaScalar = o.alphaScalar ?? s.defaults.alphaScalar
  const alphaVec = o.alphaVec ?? s.defaults.alphaVec
  const in01 = (x: number) => x >= 0 && x <= 1
  if (!in01(beta)) throw new Error('LabOverrides: β 必须在 [0,1]')
  if (!in01(alphaScalar)) throw new Error('LabOverrides: alphaScalar 必须在 [0,1]')
  if (alphaVec.length !== s.dK || !alphaVec.every(in01)) {
    throw new Error('LabOverrides: alphaVec 长度必须为 dK 且每通道在 [0,1]')
  }
  return { beta, alphaScalar, alphaVec }
}

// 各变体的等效逐通道衰减向量（deltanet/naive ≡ 1，gated 广播标量，kda 用向量）
function effectiveAlphaVec(variant: VariantId, params: VariantParams, dK: number): Vec {
  switch (variant) {
    case 'naive':
    case 'deltanet':
      return Array.from({ length: dK }, () => 1)
    case 'gated':
      return Array.from({ length: dK }, () => params.alphaScalar)
    case 'kda':
      return params.alphaVec
  }
}

// ─────────── L2 递推 trace ───────────

export interface VariantTrace {
  readonly variant: VariantId
  readonly params: VariantParams
  readonly steps: readonly TokenStep[]
  readonly finalS: Mat
}

// key 方向等价判定（探针覆盖语义用）：归一化后逐元素 |Δ| < 1e-9 且同号。
// 默认场景 t4↔t1、t7↔t2 命中；随机场景几乎不可能误撞。
const KEY_MATCH_TOL = 1e-9
function sameKeyDir(a: Vec, b: Vec): boolean {
  return a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < KEY_MATCH_TOL)
}

function buildProbes(scenario: ScenarioSpec, normKs: readonly Vec[], sAfter: Mat, t: number): RetrievalProbe[] {
  const probes: RetrievalProbe[] = []
  for (let src = 1; src <= t; src++) {
    const kSrc = normKs[src - 1]
    // 最新目标：j = max{ j ≤ t : k_j ≡ k_src }（无覆盖时即 src 自身）
    let targetT = src
    for (let j = src + 1; j <= t; j++) if (sameKeyDir(normKs[j - 1], kSrc)) targetT = j
    const target = scenario.tokens[targetT - 1].v
    const retrieved = matVec(sAfter, kSrc)
    const errorL2 = Math.sqrt(retrieved.reduce((acc, x, j) => acc + (x - target[j]) ** 2, 0))
    probes.push({ srcT: src, retrieved, originalTarget: scenario.tokens[src - 1].v, target, targetT, errorL2 })
  }
  return probes
}

export function runVariantTrace(scenario: ScenarioSpec, variant: VariantId, overrides: LabOverrides = {}): VariantTrace {
  validateScenario(scenario)
  const params = resolveParams(scenario, overrides)
  const normKs: Vec[] = scenario.tokens.map((tok) => normalize(tok.kRaw))
  let s: Mat = zeros(scenario.dV, scenario.dK)
  const steps: TokenStep[] = []
  scenario.tokens.forEach((tok, i) => {
    const t = i + 1
    const k = normKs[i]
    const sBefore = s
    let step: TokenStep
    if (variant === 'naive') {
      const sAfter = stepNaive(sBefore, k, tok.v)
      step = {
        kind: 'naive',
        t,
        kRaw: tok.kRaw,
        k,
        v: tok.v,
        sBefore,
        sAfter,
        output: matVec(sAfter, k),
        retrieval: buildProbes(scenario, normKs, sAfter, t),
        writeOuter: outer(tok.v, k),
      }
    } else {
      const beta = params.beta
      const alpha = effectiveAlphaVec(variant, params, scenario.dK)
      const sAfter =
        variant === 'deltanet'
          ? stepDeltaNet(sBefore, k, tok.v, beta)
          : variant === 'gated'
            ? stepGated(sBefore, k, tok.v, beta, params.alphaScalar)
            : stepKda(sBefore, k, tok.v, beta, alpha)
      const sDecayed = scaleColumns(sBefore, alpha)
      const prediction = matVec(sDecayed, k)
      const residual = tok.v.map((x, j) => x - prediction[j])
      step = {
        kind: 'delta',
        variant,
        t,
        kRaw: tok.kRaw,
        k,
        v: tok.v,
        sBefore,
        sAfter,
        output: matVec(sAfter, k),
        retrieval: buildProbes(scenario, normKs, sAfter, t),
        beta,
        alpha,
        sDecayed,
        prediction,
        residual,
        writeOuter: outer(
          residual.map((x) => beta * x),
          k,
        ),
        transition: dplrTransition(k, beta, alpha),
      }
    }
    steps.push(step)
    s = step.sAfter
  })
  return { variant, params, steps, finalS: s }
}

// ─────────── L3 分块 trace（一套广义实现；α≡1 即 DeltaNet 经典 WY 退化路径） ───────────

export interface ChunkStage {
  readonly chunkIndex: number // 0-based
  readonly tokenRange: readonly [number, number] // 1-based 闭区间 [startT, endT]
  readonly K: Mat // n×dK 归一化 key
  readonly V: Mat // n×dV
  readonly betaVec: Vec // 每行 β
  readonly gammas: readonly Vec[] // γ_t（块内累积衰减）
  readonly kPlus: Mat // K⁺行t = k_t⊙γ_t
  readonly kMinus: Mat // K⁻行t = k_t⊙γ_t⁻¹
  readonly kHat: Mat // K̂行t = k_t⊙(γ_C/γ_t)
  readonly gram: Mat // tril(diag(β)·K⁺(K⁻)^T, −1) 严格下三角
  readonly T: Mat // (I+gram)⁻¹·diag(β)（广义 UT 变换）
  readonly W: Mat // T·K⁺（经典 WY 教学量；α≡1 时 K⁺=K）
  readonly U: Mat // T·V
  readonly vEff: Mat // V − K⁺·S_in^T
  readonly X: Mat // T·vEff（行 t = 缩放残差 u_t）
  readonly sIn: Mat
  readonly sOut: Mat // S_in·Diag(γ_C) + X^T·K̂
  readonly outputs: Mat // O 行 t = o_t
}

export interface ChunkedTrace {
  readonly variant: 'deltanet' | 'kda'
  readonly chunkSize: number
  readonly params: VariantParams
  readonly chunks: readonly ChunkStage[]
  readonly finalS: Mat
  // 引擎内对拍（chunked vs recurrent 逐元素）：UI 恒等徽章直接显示此值，不重算
  readonly maxAbsDiffVsRecurrent: number
}

// 分块路径数值边界：K⁻ 含 γ⁻¹，α 过小会指数放大 → 每通道要求 α ≥ 0.05（递推路径允许 α=0）
const CHUNKED_ALPHA_MIN = 0.05

export function runChunkedTrace(
  scenario: ScenarioSpec,
  variant: 'deltanet' | 'kda',
  recurrent: VariantTrace,
  overrides: LabOverrides = {},
): ChunkedTrace {
  validateScenario(scenario)
  const params = resolveParams(scenario, overrides)
  // 一致性守卫（§5）：分块与递推必须同变体、同参数、同 token 数——否则 maxAbsDiffVsRecurrent 无意义
  if (recurrent.variant !== variant) {
    throw new Error(`runChunkedTrace: recurrent 变体 ${recurrent.variant} ≠ ${variant}`)
  }
  if (recurrent.steps.length !== scenario.tokens.length) {
    throw new Error('runChunkedTrace: recurrent 步数与场景 token 数不一致')
  }
  const alphaVec = effectiveAlphaVec(variant, params, scenario.dK)
  const refAlpha = effectiveAlphaVec(variant, recurrent.params, scenario.dK)
  if (recurrent.params.beta !== params.beta || alphaVec.some((a, j) => a !== refAlpha[j])) {
    throw new Error('runChunkedTrace: recurrent 参数与分块参数不一致')
  }
  if (alphaVec.some((a) => a < CHUNKED_ALPHA_MIN)) {
    throw new Error(`runChunkedTrace: 分块路径要求每通道 α ≥ ${CHUNKED_ALPHA_MIN}（K⁻ 含 γ⁻¹）`)
  }
  const beta = params.beta
  const { dK, dV, chunkSize } = scenario
  let sIn: Mat = zeros(dV, dK)
  const chunks: ChunkStage[] = []
  let maxDiff = 0
  for (let c0 = 0; c0 < scenario.tokens.length; c0 += chunkSize) {
    const toks = scenario.tokens.slice(c0, c0 + chunkSize)
    const n = toks.length // 尾块可短于 chunkSize
    const K = toks.map((tok) => normalize(tok.kRaw))
    const V = toks.map((tok) => tok.v)
    const betaVec = toks.map(() => beta)
    // 块内累积衰减 γ_t = α_1⊙…⊙α_t（引擎 α 为场景常量 ⇒ γ_t = α^t）
    const gammas: Vec[] = []
    let g: Vec = Array.from({ length: dK }, () => 1)
    for (let i = 0; i < n; i++) {
      g = hadamard(g, alphaVec)
      gammas.push(g)
    }
    const gC = gammas[n - 1]
    const kPlus = K.map((k, i) => hadamard(k, gammas[i]))
    const kMinus = K.map((k, i) => k.map((x, j) => x / gammas[i][j]))
    const kHat = K.map((k, i) => k.map((x, j) => (x * gC[j]) / gammas[i][j]))
    // attn[t][i] = ⟨K⁺行t, K⁻行i⟩ = ⟨k_i⊙γ_t/γ_i, k_t⟩（推导核心恒等式）
    const attn = matMul(kPlus, transpose(kMinus))
    const gram = attn.map((row, i) => row.map((x, j) => (j < i ? betaVec[i] * x : 0)))
    const T = solveUnitLower(gram, scaleColumns(identity(n), betaVec))
    const W = matMul(T, kPlus)
    const U = matMul(T, V)
    const vEff = subMat(V, matMul(kPlus, transpose(sIn)))
    const X = matMul(T, vEff)
    const sOut = addMat(scaleColumns(sIn, gC), matMul(transpose(X), kHat))
    // O = Q⁺·S_in^T + tril_incl(Q⁺(K⁻)^T)·X（q=k ⇒ Q⁺=K⁺，块内因果注意力含对角线）
    const attnIncl = attn.map((row, i) => row.map((x, j) => (j <= i ? x : 0)))
    const outputs = addMat(matMul(kPlus, transpose(sIn)), matMul(attnIncl, X))
    // 引擎内对拍：块尾状态 + 逐 token 输出，双指标取最大
    maxDiff = Math.max(maxDiff, maxAbsDiff(sOut, recurrent.steps[c0 + n - 1].sAfter))
    for (let i = 0; i < n; i++) {
      const recOut = recurrent.steps[c0 + i].output
      for (let j = 0; j < dV; j++) maxDiff = Math.max(maxDiff, Math.abs(outputs[i][j] - recOut[j]))
    }
    chunks.push({
      chunkIndex: chunks.length,
      tokenRange: [c0 + 1, c0 + n],
      K,
      V,
      betaVec,
      gammas,
      kPlus,
      kMinus,
      kHat,
      gram,
      T,
      W,
      U,
      vEff,
      X,
      sIn,
      sOut,
      outputs,
    })
    sIn = sOut
  }
  return { variant, chunkSize, params, chunks, finalS: sIn, maxAbsDiffVsRecurrent: maxDiff }
}

// ─────────── L4 组装（单一数据源入口）+ selectors ───────────

export interface KdaTrace {
  readonly scenario: ScenarioSpec
  readonly overrides: LabOverrides
  readonly variants: Readonly<Record<VariantId, VariantTrace>>
  readonly chunked: { readonly deltanet: ChunkedTrace; readonly kda: ChunkedTrace }
}

export function buildKdaTrace(scenario: ScenarioSpec = DEFAULT_SCENARIO, overrides: LabOverrides = {}): KdaTrace {
  validateScenario(scenario)
  const variants: Record<VariantId, VariantTrace> = {
    naive: runVariantTrace(scenario, 'naive', overrides),
    deltanet: runVariantTrace(scenario, 'deltanet', overrides),
    gated: runVariantTrace(scenario, 'gated', overrides),
    kda: runVariantTrace(scenario, 'kda', overrides),
  }
  // Tab3「分块并行」固定用 scenario.defaults（不受 Lab 滑块 overrides 影响，PLAN §6.1）：
  // ① 分块是恒等演示，参数随滑块漂移徒增困惑；② 避免滑块把 α 拖到 <0.05 触发分块数值校验 throw。
  // 对拍基准因此也在默认参数下重跑（overrides 非空时与 variants.* 参数不同属预期）。
  const chunked = {
    deltanet: runChunkedTrace(scenario, 'deltanet', runVariantTrace(scenario, 'deltanet')),
    kda: runChunkedTrace(scenario, 'kda', runVariantTrace(scenario, 'kda')),
  }
  return { scenario, overrides, variants, chunked }
}

export function selectStep(trace: KdaTrace, variant: VariantId, t: number): TokenStep {
  const steps = trace.variants[variant].steps
  if (t < 1 || t > steps.length) throw new Error(`selectStep: t=${t} 越界（1..${steps.length}）`)
  return steps[t - 1]
}

export interface ErrorCurvePoint {
  readonly t: number
  readonly meanErr: number // 第 t 步对已写入 srcT=1..t 的全量探针 errorL2 均值（最新目标语义）
  readonly maxErr: number
}

export function selectErrorCurve(trace: KdaTrace, variant: VariantId): readonly ErrorCurvePoint[] {
  return trace.variants[variant].steps.map((step) => {
    const errs = step.retrieval.map((p) => p.errorL2)
    return {
      t: step.t,
      meanErr: errs.reduce((a, b) => a + b, 0) / errs.length,
      maxErr: Math.max(...errs),
    }
  })
}

// recharts 友好：四变体误差曲线合并为一行一 t 的宽表
export interface ErrorChartPoint {
  readonly t: number
  readonly naive: number
  readonly deltanet: number
  readonly gated: number
  readonly kda: number
}

export function selectErrorChartData(trace: KdaTrace): readonly ErrorChartPoint[] {
  const curves = {
    naive: selectErrorCurve(trace, 'naive'),
    deltanet: selectErrorCurve(trace, 'deltanet'),
    gated: selectErrorCurve(trace, 'gated'),
    kda: selectErrorCurve(trace, 'kda'),
  }
  return curves.naive.map((pt, i) => ({
    t: pt.t,
    naive: pt.meanErr,
    deltanet: curves.deltanet[i].meanErr,
    gated: curves.gated[i].meanErr,
    kda: curves.kda[i].meanErr,
  }))
}

export interface ProbeSeriesPoint {
  readonly t: number
  readonly err: number
}

// 单个探针的误差随时间序列（t 从 srcT 起）
export function selectProbeSeries(trace: KdaTrace, variant: VariantId, srcT: number): readonly ProbeSeriesPoint[] {
  const steps = trace.variants[variant].steps
  if (srcT < 1 || srcT > steps.length) throw new Error(`selectProbeSeries: srcT=${srcT} 越界（1..${steps.length}）`)
  return steps.slice(srcT - 1).map((step) => {
    const probe = step.retrieval.find((p) => p.srcT === srcT)
    if (!probe) throw new Error(`selectProbeSeries: t=${step.t} 缺少 srcT=${srcT} 探针`)
    return { t: step.t, err: probe.errorL2 }
  })
}

export function selectChunk(trace: KdaTrace, variant: 'deltanet' | 'kda', i: number): ChunkStage {
  const chunks = trace.chunked[variant].chunks
  if (i < 0 || i >= chunks.length) throw new Error(`selectChunk: i=${i} 越界（0..${chunks.length - 1}）`)
  return chunks[i]
}
