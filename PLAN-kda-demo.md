# /kda「KDA 拆解」— K3 KDA 机制交互式讲解 Demo 实施计划

> **进度（2026-08-07）：全部交付并上线。** typecheck 干净、`npm test` 123/123、build 通过；浏览器 E2E 首轮 0 P0/P1 + 5 P2，修复批后定点复测 6/6 PASS。已合并 main（PR #3，1dc9c34）；已部署 rkb-ecs：**http://8.130.208.123/llms/#/kda**（`vite build --base=./` + rsync 至 `/work/llms-study/dist`，Caddy IP:80 站点 `/llms/` 子路径 + LLM API allowlist 反代；线上浏览器冒烟通过，部署细节见项目记忆 `ecs-deploy-llms-study`）。详见文末「交付日志」与「E2E 交付记录」。

## Context

用户读完一篇拆解 Kimi K3 KDA（Kimi Delta Attention）的文章后，希望站内新增一个带 UI 的交互式 demo：
- 从朴素线性注意力一步步推导到 KDA 的完整数学主线，**公式 + 真实小规模数值 + 网络结构图三者联动**，清晰展示数据在每一步的变换过程；
- 配套 K3 网络结构可视化（69 层 KDA + 24 层 Gated MLA 约 3:1 混合、KDA 单层内部数据流），一目了然。

**用户已确认的范围决策**：
- 新增**顶级导航页 `/kda`**（与「架构演进」「推理链路」平级）；
- 分块并行 / WY 表示做**完整数值演示**（recurrent vs chunked 恒等对比）；
- 交互程度：**步进播放 + β/α 门控滑块**（预设场景，输入向量不可编辑）；
- 「做完一定要做好测试，避免之前各环节数据不一致的问题」→ 本计划的最高设计约束：**纯函数引擎单一数据源 + 已知算例单测 + UI 零硬编码数字**。

**零新增 npm 依赖**：公式渲染用手写结构化组件（见 §6.2），不引 KaTeX。

## 现状基线（已核实）

- 路由/导航：`src/nav.ts`（NAV 数组，App 与 SelectionAsk 同源引用）+ `src/App.tsx:42-49`（Routes）。各加一行即可接入。
- 页面模板：`src/pages/InferencePage.tsx`（29 行，`SegmentedTabs` + `as const` TABS + 条件渲染）。
- 可视化模板：`src/components/TransformerDiagram.tsx`（左可点节点+右详情）、`src/components/QKVFlow.tsx`（手写 SVG + framer-motion 循环动画，色值用 `var(--color-*)`）、`src/components/LifecycleSim.tsx`（步进/播放+滑块）、`src/components/EconomicsPanel.tsx`（recharts + JS hex 系列色先例）。
- K3 事实数据：`src/data/models.ts:247-294`（id `kimi-k3`：69 层 KDA + 24 层 Gated MLA、896 专家选 16+2、1048K 上下文、Attention Residuals、sourceUrl+asOf）。网络结构 tab 直接 import 引用，**不复制第二份**。
- 主题：`src/index.css` Tailwind v4 `@theme`（accent 酒红 #9e2b3a / accent-2 深紫 #6d28d9 / amber / ok / warn / bad…）。硬约束见 `PLAN-ui-light-theme.md`：text-white 仅用于实心深色填充；禁霓虹光晕；选中态 `border-accent bg-accent/10 shadow-sm`；卡片 `rounded-xl border border-line bg-panel shadow-sm`。
- 测试：vitest `environment: 'node'`，只收 `src/**/*.test.ts`（无 DOM，组件不可单测）。范式：`src/lib/simEngine.ts` + 28 已知算例。回归三连 `npm run typecheck && npm test && npm run build`。
- 依赖：已有 framer-motion@12、recharts@2、zustand@5；无 katex/d3/mermaid。
- 「数据不一致」在仓库无归档记录，属用户过往体验；结构性根因候选是「多面板各持独立默认值」（如 InferencePage 三面板 batch/cacheRate/tps 互相打架）——本计划用机制杜绝（§5）。

## 1. 数学规范（引擎实现依据，已核对自洽）

约定 **S ∈ R^{d_v×d_k}**（行=value 维，列=key 通道），读出 `o_t = S_t q_t`，demo 约定 q_t = k_t（读出即自检索）。

| 变体 | 递推 | 残差等价形式 |
|---|---|---|
| Naive | `S_t = S_{t-1} + v_t k_t^T` | —（只加不减 → 非正交 key 干扰） |
| DeltaNet | `S_t = S_{t-1}(I − β_t k_t k_t^T) + β_t v_t k_t^T` | `S_t = S_{t-1} + β_t u_t k_t^T`，`v̂_t = S_{t-1}k_t`，`u_t = v_t − v̂_t` |
| Gated | `S_t = α_t·S_{t-1}(I − β_t k_t k_t^T) + β_t v_t k_t^T` | `v̂_t = α_t S_{t-1} k_t`（衰减后预测） |
| KDA | `S_t = S_{t-1}·Diag(α_t)·(I − β_t k_t k_t^T) + β_t v_t k_t^T` | `v̂_t = S_{t-1}Diag(α_t)k_t` |

- DPLR：`Diag(α)(I − βkk^T) = Diag(α) + a·b^T`，**a = −β(α⊙k)，b = k**（低秩因子绑定同一 k）。
- 关键性质（全部进单测）：‖k‖=1 且 β=1 ⇒ `S_t k_t = v_t` 精确覆盖写（衰减存在时依然成立）；β=0 且 α=1 ⇒ 状态不变；退化链 KDA(αVec=c·1) ≡ Gated(α=c)，α=1 ⇒ DeltaNet；与 k 正交方向不受 `(I−βkk^T)` 影响。

**分块并行（恒等变形，非近似）**：带逐通道衰减的完整 KDA 分块可行。块内 t=1..C，累积衰减 `γ_t = α_1⊙…⊙α_t`：

```
K⁺行t = k_t⊙γ_t   K⁻行t = k_t⊙γ_t⁻¹   K̂行t = k_t⊙(γ_C/γ_t)   Q⁺行t = q_t⊙γ_t
T = (I + tril(diag(β)·K⁺(K⁻)^T, −1))⁻¹ · diag(β)      ← 广义 UT 变换（单位下三角前代求解）
W = T·K⁺   U = T·V   X = T·(V − K⁺·S_in^T)
S_out = S_in·Diag(γ_C) + X^T·K̂
O = Q⁺·S_in^T + tril_incl(Q⁺(K⁻)^T)·X
```

α≡1 时严格还原 Yang et al. 经典 DeltaNet WY（T/W/U、`S_out = S_in(I−W^TK) + U^TK`）。分块做两套演示：① DeltaNet 经典 WY（教学台阶）② KDA 衰减折叠版。**核心验收单测：chunked 与逐步递推逐元素相差 < 1e-10**。数值边界：K⁻ 含 γ⁻¹，分块路径 `validateScenario` 校验 α ≥ 0.05（递推路径允许 α=0）。若随机对拍超容差，先查实现而非放宽容差。

## 2. 引擎 API（`src/lib/kdaEngine.ts`，纯函数，UI 唯一取数来源）

分 5 层，类型深 readonly。（UI 一律走 L4 的 trace + selectors。）

```ts
// L0 线代原语（导出供单测）：matMul/matVec/outer/transpose/addMat/
//   scaleColumns(m, alpha)（=m·Diag(α)）/normalize/zeros/maxAbsDiff/
//   solveUnitLower(strictLower, rhs)（前代替换）/fmt(x, digits?)（全站唯一数字格式化）

// L1 单步（四变体独立实现，退化链单测交叉验证）
export type VariantId = 'naive' | 'deltanet' | 'gated' | 'kda'
export function stepNaive/stepDeltaNet/stepGated/stepKda(...): Mat
export function dplrTransition(k, beta, alphaVec): DplrTransition  // {full, diag, lowRankA, lowRankB}

// 单步 trace（判别式联合：naive 无预测/残差，编译器强制分支）
export type TokenStep =
  | (StepBase & { kind: 'naive'; writeOuter: Mat })
  | (StepBase & { kind: 'delta'; variant: 'deltanet'|'gated'|'kda'; beta: number; alpha: Vec
      sDecayed: Mat; prediction: Vec; residual: Vec; writeOuter: Mat; transition: DplrTransition })
// StepBase: { t; kRaw; k; v; sBefore; sAfter; output; retrieval: RetrievalProbe[] }
// RetrievalProbe: { srcT; retrieved; target; errorL2 }（第 t 步含 srcT=1..t 全量探针）

// L2 递推：runVariantTrace(scenario, params) → VariantTrace { variant; params; steps; finalS }
// L3 分块：runChunkedTrace(scenario, params, recurrent) → ChunkedTrace
//   ChunkStage: { chunkIndex; tokenRange; K; V; betaVec; gammas; kPlus; kMinus; kHat;
//                 gram; T; W; U; vEff; X; sIn; sOut; outputs }
//   ChunkedTrace 含 maxAbsDiffVsRecurrent（引擎内对拍，UI 徽章直接显示，不重算）

// L4 组装（单一数据源入口）
export interface ScenarioSpec { id; dK; dV; chunkSize; tokens: ScenarioToken[]
  defaults: { beta; alphaScalar; alphaVec } }   // ← β/α 默认值全站唯一出处
export const DEFAULT_SCENARIO: ScenarioSpec
export function validateScenario(s): void       // 维度/α 范围违规 throw
export function buildKdaTrace(scenario?, overrides?: LabOverrides): KdaTrace
// KdaTrace: { scenario; variants: Record<VariantId, VariantTrace>;
//             chunked: { deltanet: ChunkedTrace; kda: ChunkedTrace } }
// LabOverrides: { beta?; alphaScalar?; alphaVec? }

// selectors（recharts 友好形状在此产出，组件零计算）
export function selectStep(tr, v, t): TokenStep
export function selectErrorCurve(tr, v): { t; meanErr; maxErr }[]
export function selectErrorChartData(tr): { t; naive; deltanet; gated; kda }[]  // 四线合并
export function selectProbeSeries(tr, v, srcT): { t; err }[]
export function selectChunk(tr, v, i): ChunkStage
```

## 3. 预设场景（DEFAULT_SCENARIO）

d_k = d_v = 4，8 token，chunkSize = 4（恰 2 块）。默认 β=1、gated α=0.9、KDA αVec=(1, 1, 0.5, 0.9)——通道 1/2 永久记忆、通道 3 快遗忘（热力图第 3 列持续褪色）、通道 4 慢遗忘。

| t | 块 | kRaw | v | role | 教学目的 |
|---|---|---|---|---|---|
| 1 | 1 | (1,0,0,0) | (2,0,0,0) | write-ortho | 正交写入基线，检索精确 |
| 2 | 1 | (0,1,0,0) | (0,2,0,0) | write-ortho | 第二正交槽 |
| 3 | 1 | (1,1,0,0) | (0,0,2,0) | write-conflict | **非正交冲突**：naive 检索污染，delta 残差修正 |
| 4 | 1 | (1,0,0,0) | (−2,0,0,0) | overwrite(t1) | **覆盖写**：β=1 ⇒ S₄k₁=v₄ 精确；符号翻转视觉强烈 |
| 5 | 2 | (0,0,1,0) | (0,0,3,0) | write-ortho | 写入快遗忘通道 α₃=0.5 |
| 6 | 2 | (0,0,1,1) | (0,0,0,2) | write-conflict | 块 2 冲突，保证第二块 T 非平凡 |
| 7 | 2 | (0,1,0,0) | (0,−1,0,0) | overwrite(t2) | **跨块远程覆盖**：KDA 通道 2 α=1 老值仍在被改写 |
| 8 | 2 | (0,0,0,1) | (1,0,0,1) | write-ortho | 正交方向不受转移矩阵影响 |

手算锚点（进单测，也是 E2E 抽查基准）：DeltaNet β=1 时 `S₃e₁ = (1, −1, √2, 0)`、`S₄e₁ = (−2,0,0,0)` 精确。

## 4. 测试清单（`src/lib/kdaEngine.test.ts`，约 30 条 it / 35+ 断言）

容差：恒等类 1e-12，分块对拍 1e-10，已知算例 `toBeCloseTo(…,10)` 或整数 `toEqual`。

- **A 原语**：matMul/outer/transpose 已知算例；solveUnitLower 回代验证 `(I+L)X ≡ B`。
- **B Naive**：正交两写精确整数矩阵；t3 冲突后 probe(1) 误差手算值；重复 key 叠加 `S k = v_a+v_b`。
- **C DeltaNet**：两种等价形式随机对拍；覆盖写公理；β=0 不变；β=0.5 中点 `S_t k = 0.5v̂+0.5v`；正交不变（e₄ 探测）；已知算例 `S₃e₁`/`S₄e₁`。
- **D Gated**：α=1 ≡ DeltaNet 全 trace；α=0 完全遗忘 `S_t = βv_tk_t^T`；衰减下覆盖写仍成立；标量衰减已知算例。
- **E KDA**：退化链全 trace 对拍；通道级选择性（αVec=(1,0.5,1,1) ⇒ 仅列 2 精确 ×0.5）；`prediction ≡ S_{t-1}Diag(α)k`；DPLR 重构 `full ≡ Diag(α)+a·b^T`。
- **F 分块 ≡ 递推（核心验收）**：DeltaNet/KDA 默认场景 `maxAbsDiffVsRecurrent < 1e-10` 且逐块 outputs 对拍；`W≡TK⁺`、`U≡TV`、T 重构 `(I+gram)T ≡ diag(β)`；WY 状态双路径 `sIn(I−W^TK)+U^TK ≡ sIn+X^TK`（α≡1）；gram 公式直接重算对拍；正交块手算例；**seeded PRNG（mulberry32）5 组随机场景压力对拍**；chunkSize=1 退化；跨块 `chunks[1].sIn ≡ chunks[0].sOut`；α 含 0 时分块 throw、递推不 throw。
- **G 组装**：buildKdaTrace 确定性（两次 deep-equal）；validateScenario throw；LabOverrides 生效（β=0 且 α=1 ⇒ 全程 S=0…）；第 t 步恰 t 个 probe；selectors 形状与已知点；`fmt` 格式约定。
- **H 文案一致性**（配 §5）：遍历 `KDA_DERIV_STEPS`，`body(selectStep(...), fmt)` 产出不含 `NaN`/`undefined`，`tokenT`/字段引用全部在界内——**文案与引擎脱钩即测试失败**。

## 5. 数据一致性机制（防「各环节数据不一致」，四层）

1. **类型层**：Vec/Mat 深 readonly；trace 不存冗余派生量（曲线/图表形状全走 selector）；`Record<VariantId,·>` 漏变体编译不过。
2. **默认值唯一出处**：β/α/token 数值只存在于 `DEFAULT_SCENARIO`。**任何组件禁止 `useState(0.9)` 式第二默认值**——滑块初值读 `trace.scenario.defaults`，滑块变化经 `buildKdaTrace(DEFAULT_SCENARIO, overrides)`（useMemo）重建整棵 trace，公式代入/热力图/曲线/文案同步刷新。
3. **文案层**：`src/data/kda.ts` 讲解步骤不写死数字，用取数函数绑定 trace：`body: (step: TokenStep, fmt) => string`，配测试组 H。
4. **显示层**：`fmt` 是唯一数字格式化入口（杜绝 0.71/0.707 两副面孔）；分块「恒等徽章」直接显示引擎的 `maxAbsDiffVsRecurrent`，UI 不重算。

## 6. UI 设计

### 6.1 页面结构（`src/pages/KdaPage.tsx`，InferencePage 模板）

四 tab（均 4 字，避开长标签换行 P2）：**原理推导 / 数值实验室 / 分块并行 / 网络结构**。tabs 下方常驻「一句话主线」卡（`border-accent/40 bg-accent/10`，文案 `KDA_SUMMARY`）。

**Tab1 原理推导（KdaDerivation.tsx）**：约 11 步步进讲解，覆盖：①S=联想记忆与读出 ②朴素写入 ③干扰问题（pred vs v 对比+残差酒红）④最小二乘视角 ⑤GD 一步→Delta 规则 ⑥转移矩阵形式（广义 Householder，transition 热力图）⑦β 插值含义（引流实验室）⑧标量门 Gated ⑨对角门 KDA（标量门 vs 对角门 transition 对比）⑩DPLR+绑定 k 约束 ≈2× kernel 加速（带 sourceUrl+asOf）⑪转移矩阵连乘=数据依赖乘性位置编码 vs RoPE、KDA 层免 RoPE。
布局：五阶段进度圆点 → 主卡（AnimatePresence 步间过渡：公式区**双态渲染**——符号式 + 代入当前数值式；状态区用热力图+「×」「+」「→」连接符拼出视觉算式；讲解文案；可选「面试一句话」warn 卡）→ 底部 StepControls → 常驻 FormulaLegend（角色→颜色图例）。

**Tab2 数值实验室（KdaLab.tsx）**：控制卡（▶播放/⏸/单步/重置 + t 滑块显示 token 标签 + β 滑块 + Gated α 标量滑块 + **KDA 4 个通道 α 小滑块**——通道级遗忘正是 KDA 核心卖点，初值全部来自 `trace.scenario.defaults`）；四变体并排 S 热力图（`grid-cols-2 xl:grid-cols-4`，**共享色标 maxAbs**，KDA 徽章实心酒红白字）；recharts 误差曲线（四线色 naive #6e6a60 / deltanet #d97706 / gated #6d28d9 / kda #9e2b3a，与徽章同源于 `VARIANT_META`；ReferenceLine 随 t 移动；图表 onClick 反向设 t；Tooltip 白底样式抄 EconomicsPanel）；观察要点卡（`LAB_TAKEAWAYS`，只描述定性趋势不含数字）。播放：setInterval ~900ms/步，到尾自停，卸载/换 tab 清理；β/α 变更 → useMemo 重算 trace，t 保持。

**Tab3 分块并行（KdaChunkwise.tsx）**：固定默认参数（不受 Lab 滑块影响）。顶栏：chunk 说明 + ◀ chunk c/N ▶ + **恒等徽章**（`max|S_rec−S_chunk| = {maxAbsDiffVsRecurrent.toExponential(1)}`，<1e-10 ⇒ ok 绿「✓ 浮点精度内一致」，条件渲染不写死结论）；DeltaNet 经典 WY / KDA 衰减折叠两个子视图切换；双栏：左「逐 token recurrent」（块内每步 S 小热力图横排 → S_out 强调），右「chunked（WY）」纵向流程 K/V → gram → T（C×C 下三角，非零结构即教学点）→ W/U → X →「一次矩阵乘」→ S_out，各中间矩阵配 `CHUNK_MATRIX_NOTES` 一行职责说明；对照卡：两个 S_out 并排 + 差值放大热力图；`<details>` 折叠公式对照。

**Tab4 网络结构（KdaNetwork.tsx + KdaLayerFlow.tsx）**：TransformerDiagram 双栏模式。左：93 层全景条带（69 格 `bg-accent/70` KDA + 24 格 `bg-accent-2/70` Gated MLA，计数来自 `K3_STRUCTURE`；**标注「交错顺序为示意」**——官方未公布具体交错）+ 重复单元可点节点（[KDA×3] ↓ [Gated MLA×1] ↓ [MoE FFN 896选16+2] ↓ [Attention Residuals]）。右 sticky 详情：what/why/面试一句话（`NETWORK_NODES`；K3 事实字段直接 `MODELS.find(m => m.id === 'kimi-k3')` 引用 models.ts，不复制）；选中 KDA 层时嵌 `<KdaLayerFlow/>`（QKVFlow 同款 SVG 循环动画四幕：x→q/k/v/β/α 投影 → `Diag(α)(I−βkk^T)` 紫色收缩脉冲 → `+βvk^T` 酒红写入脉冲 → `o=Sq` 读出；底注「状态恒定大小 → 无 KV cache 膨胀」；竖直位移用 `attrY`，`times` 铺满 0→1——QKVFlow 既有 QA 教训）。
文案红线（PLAN.md:20）：~2.5× 效率提升是架构+训练配方**综合收益，不单项归因 KDA**。

### 6.2 公式渲染：手写结构化组件（不引 KaTeX）

决定性理由：「符号式↔代入数值式」双态是本页核心交互——公式是数据驱动的活组件而非静态插图。结构化 `MathNode[]` + 类型化绑定键远优于拼 LaTeX 字符串（有类型保护、零依赖、颜色语义与热力图/图例单点定义）。本页公式复杂度上限是「下上标+括号+范数+Σ/Π 上下限」，手写可覆盖；未来若需嵌套分式再引 KaTeX。

```ts
// src/components/kda/Formula.tsx
export type TermRole = 'state' | 'residual' | 'decay' | 'beta' | 'input' | 'neutral'
export const ROLE_COLORS: Record<TermRole, string>  // residual=酒红 decay=深紫 beta=琥珀…
                                                    // MatrixHeatmap/曲线/Legend 全部 import 此表
export type MathNode =
  | { kind: 'sym'; text; sub?; sup?; role?; bind?: ScalarKey }  // bind+substitute ⇒ 渲染 trace 数值
  | { kind: 'op'; text } | { kind: 'group'; children; role?; paren? }
  | { kind: 'stack'; op: 'Σ'|'Π'; below; above?; children }
// Formula({ nodes, size, focusRoles?, substitute?, scalars?, className? }) + FormulaLegend
```

变量 `font-serif italic`，真实 `<sub>/<sup>`，外层 `overflow-x-auto`；`focusRoles` 非空时其余角色 opacity-40 实现分步聚焦。

### 6.3 热力图：`src/components/kda/MatrixHeatmap.tsx`（div grid，非 SVG）

```ts
MatrixHeatmap({ matrix, title?, maxAbs?, cellSize?: 'sm'|'md', changedFrom?, highlight?, precision? })
VectorStrip({ vec, label?, ... })  // 同文件薄包装（1×d）
```

正值→酒红、负值→深紫（与 residual/decay 语义一致），幅值→透明度 `min(0.9, |v|/maxAbs)`；framer-motion 插值需 JS hex 常量合成 rgba（EconomicsPanel 先例）；`a>0.55` 格内文字 text-white（深格属白名单），否则 text-fg；`gap-px bg-line` 细线网格；`changedFrom` 变化格 `scale:[1,1.15,1]` 脉冲（times 铺满）；数值 `font-mono tabular-nums` + 引擎 `fmt`。并排必传共享 `maxAbs`。

## 7. 文件清单

**新增 12 个**：

```
src/lib/kdaEngine.ts               引擎：类型+纯函数五层（§2）
src/lib/kdaEngine.test.ts          30 条测试（§4）
src/data/kda.ts                    全部内容：KDA_SUMMARY / KDA_DERIV_STEPS（取数函数绑定 trace）/
                                   VARIANT_META / LAB_TAKEAWAYS / CHUNK_MATRIX_NOTES /
                                   NETWORK_NODES / K3_STRUCTURE（69/24 结构化计数，sourceUrl+asOf）
src/pages/KdaPage.tsx              四 tab 容器
src/components/kda/Formula.tsx     MathNode 渲染 + ROLE_COLORS + FormulaLegend
src/components/kda/MatrixHeatmap.tsx  热力图 + VectorStrip
src/components/kda/StepControls.tsx   上一步/下一步/播放/滑块复用控制条（受控式）
src/components/kda/KdaDerivation.tsx  Tab1 步进讲解
src/components/kda/KdaLab.tsx         Tab2 四变体实验室
src/components/kda/KdaChunkwise.tsx   Tab3 分块并行对照
src/components/kda/KdaNetwork.tsx     Tab4 结构图 + sticky 详情
src/components/kda/KdaLayerFlow.tsx   KDA 单层 SVG 循环动画
```

**修改 3 处（最小改动）**：
- `src/nav.ts`：`{ to: '/kda', label: 'KDA 拆解' }` 插在 `/agent` 之后、`/interview` 之前；
- `src/App.tsx`：import + `<Route path="/kda" …/>` 各一行；
- `EXTENDING.md`：追加 kdaEngine 扩展点一行。
- （可选加分）`ArchitecturePage` 注意力演进表 KDA 行包 `<Link to="/kda">` 互链。

## 8. 实施步骤（每步门禁：`npm run typecheck && npm test`，UI 步加 `npm run build`）

| 步 | 内容 | 验收 |
|---|---|---|
| 0 | 把本计划存为项目 `PLAN-kda-demo.md`（新文件，不覆盖旧 PLAN） | ✅ 已完成 |
| 1 | 引擎 L0 原语 + fmt | 测试组 A |
| 2 | 四变体单步（独立实现）+ dplrTransition | B/C/D/E 单步级断言 |
| 3 | ScenarioSpec + DEFAULT_SCENARIO + validateScenario + runVariantTrace（含 probes） | 已知算例 + G 部分 |
| 4 | DeltaNet 经典 WY 分块 | F 组 DeltaNet 部分 |
| 5 | KDA 衰减折叠分块 + seeded 随机压力对拍 | F 组全部 |
| 6 | buildKdaTrace + LabOverrides + selectors | G 组全部 |
| 7 | 页面骨架接线：nav/App + KdaPage 占位（不建 kda.ts，占位内容内联，避免与引擎并行时的类型依赖） | typecheck+build |
| 8 | Formula + MatrixHeatmap + StepControls（纯 props 组件，不依赖引擎） | typecheck+build |
| 9 | kda.ts 全量讲解内容（import 引擎类型）+ 文案一致性测试（H 组） | H 组 |
| 10 | Tab1 KdaDerivation 接 trace | 三连 |
| 11 | Tab2 KdaLab（滑块重算/播放/曲线） | 三连 |
| 12 | Tab3 KdaChunkwise | 三连 |
| 13 | Tab4 KdaNetwork + KdaLayerFlow + EXTENDING.md 一行 | 三连 |
| 14 | E2E QA（见 §9）→ 修复循环至 0 P0/P1 → 本文档回填「E2E 交付记录」 | 0 P0/P1 |

依赖说明：步 7/8 不依赖引擎，与步 1–6 并行交付；步 9 起硬依赖引擎就绪。

## 9. 验证

**单元/编译**：回归三连 `npm run typecheck && npm test && npm run build`（现有 69 例 + 新增 ~30 例全绿）。

**E2E 浏览器走查**（`npm run dev` + claude-in-chrome + 真实页面，专职 QA agent 执行）：
1. 前置：`document.visibilityState === 'visible'` 确认后再断言动画（hidden tab rAF 挂起的既有教训）；
2. **数据一致性抽查（重点）**：Tab1 公式代入数值 = 热力图格值 = 文案数字，对照单测锚点（t3 后 DeltaNet `S₃e₁=(1,−1,√2,0)`≈(1,−1,1.41,0)、t4 覆盖写 `S₄e₁=(−2,0,0,0)`）；Tab2 拖 β=0 时 delta 系 S 全零、β/α 拖动后四图+曲线+代入公式同步刷新且 t 不跳；
3. Tab2：四变体共享色标（同数值同颜色）；播放到尾自停；切 tab 后 interval 清理（无泄漏告警）；
4. Tab3：恒等徽章绿色且显示 ~e-16 量级；chunk 步进跨块时 `sIn` 与上一块 `sOut` 显示一致；
5. Tab4：条带计数 69/24 与 models.ts 一致；「交错顺序为示意」标注在；SVG 四幕动画可见；
6. 响应式：~390px 窄窗逐 tab 无横向撑破（公式/矩阵在容器内滚动）；
7. 主题合规：无霓虹光晕、text-white 仅现于实心深色、导航高亮正常。

**已识别风险（QA 重点）**：热力图正负色与变体系列色同色相不同语义（图例常驻标注「格色=数值正负」）；serif 公式与中文正文基线对齐；AnimatePresence 与热力图色过渡叠加闪烁则退化为 opacity；朴素变体误差量级压扁其他曲线则加 Y 轴 log 切换。

## 10. 交付编排（按既有工作流约定）

- 实现由专职 subagent 按步交付（模型从 fable / opus5 / sonnet5 择优：引擎数学=fable，UI 骨架=sonnet5，内容与四 tab=opus5），每步过门禁再进下一步；
- E2E QA 由**专职 QA subagent（不可用 fable5）**经 claude-in-chrome + 真实页面执行，产出 P0/P1/P2 清单；
- 修复循环直至 **0 P0/P1**，P2 酌情处理并记录；QA 结论回填本文档。

## 交付日志（2026-08-06）

- [x] 步 0：本计划存为 `PLAN-kda-demo.md`
- [x] 步 1–6 引擎（Fable agent）：`kdaEngine.ts` + 37 条单测，全仓 106/106；分块 vs 递推恒等对拍 **2.22e-16**（两变体，机器精度）；锚点 `S₃e₁≈(1,−1,√2,0)`、`S₄e₁=(−2,0,0,0)` 命中；mulberry32 随机压力（5 seeds × chunkSize∈{4,1,3}，含非整除尾块）一次通过
- [x] 步 7–8 骨架（Sonnet 5 agent）：nav/App 接线、KdaPage 四 tab、Formula/MatrixHeatmap/StepControls，签名与计划一致
- [x] 步 9–13 内容与四 tab（Opus 5 agent）：`kda.ts` + `kda.test.ts`（H 组 17 例）+ 四 tab 组件 + KdaLayerFlow + EXTENDING.md 一行 + ArchitecturePage 互链；终态 **123/123** + build 绿
- [x] 步 14 E2E QA（Opus 5 QA agent）：首轮 0 P0 / 0 P1 / 5 P2 → 修复批（6 项）→ 定点复测 6/6 PASS，终态 0 P0/P1/P2

### 实施偏差记录（均已核准）

**引擎侧**：① `runVariantTrace(scenario, variant, overrides?)` 加显式 variant 参数（计划伪码未写明变体选择）；② `runChunkedTrace` 带 recurrent 一致性守卫（不匹配 throw）；③ `RetrievalProbe` 扩展为 `{srcT, retrieved, originalTarget, target, targetT, errorL2}`——覆盖写后 target 切换为最新写入值，「覆盖写成功 ⇒ 误差归零」的教学语义由单测锁定；④ `buildKdaTrace` 的 chunked 分支恒用 `scenario.defaults`（Tab3 固定参数，同时化解 Lab 滑块 α→0 与分块 α≥0.05 校验的冲突）；⑤ 增量：`ChunkedTrace.params`、`KdaTrace.overrides` 回显字段，L0 补导出 `identity/dot/hadamard/subMat`。

**UI 侧**：① Tab1 状态算式改用**残差恒等式** `sDecayed + writeOuter = sAfter`（计划原式 `sBefore×transition+writeOuter` 数值不成立——writeOuter=β·u·kᵀ 与 transition 中的 −βSDαkkᵀ 重复扣减；残差视角恰是文章主线，转移矩阵改为独立视图展示）；② H 组测试放 `src/data/kda.test.ts`（内容测试与引擎测试分离）；③ 误差曲线未加 log 轴（实测 naive 与 delta 系仅差 2–3×，四线清晰；改为图例点击隐藏曲线）；④ 差值热力图用共享色标+旁注实测值（放大 e-16 会把浮点舍入渲染成满色，与「恒等」结论矛盾）。

### 已知缺口（不阻塞）

- `TokenStep` 未导出原始写入项 `β·v·kᵀ`（rawWriteOuter），故「转移矩阵形式」无法拼成完整热力图算式（现用残差形式，教学等价）；如需补充：引擎加字段+恒等单测。
- ~~`Formula` substitute 与 `fmt` 的显示双轨~~ 已修：公式代入值走 `fmt`（与文案同形）；热力图格保留 `toFixed(2)` 定宽对齐（刻意分工，已写注释），并做 `-0` 归一。

## E2E 交付记录（2026-08-06，QA agent 经 claude-in-chrome + 真实页面）

### 环境说明（重要，非产品缺陷）

本机 claude-in-chrome 的 MCP tab 结构性隐藏（`visibilityState==='hidden'`、WAAPI 冻结），rAF 挂起导致 framer-motion 动画假死、`AnimatePresence mode="wait"` 步进卡片不换（计数照走）。QA 采用只读代理注入 rAF polyfill + 同源窄 iframe 完成走查，未改项目代码；细节已沉淀至项目记忆 `browser-qa-hidden-tab-raf`。内容 agent 冒烟时的「扩展超时」即此陷阱，Tab3 实测首帧 45ms，无性能问题。

### 首轮走查（PLAN §9 全清单，0 P0 / 0 P1 / 5 P2）

核心 PASS 项：四 tab 渲染无崩溃、console 0 error；**数据一致性三方核对命中全部锚点**（Tab1 步⑤ S₃ 第 1 列 = (1.00, −1.00, 1.41, 0.00)、步⑥ (−2,0,0,0)，公式/热力图/探针表/文案完全一致，跨 Tab2 同源）；β=0 三变体全零且 t 不跳；KDA 通道 α 滑块单调生效、无第二默认值；恒等徽章 2.2e-16 绿色、跨块 sIn≡sOut；播放到尾自停、切 tab 无残留计时器；四变体共享色标严格成立（13 个数值各对应唯一颜色）；93 层条带 = 69+24、K3 事实与 models.ts 一致、2.5× 综合收益红线表述正确；SVG 四幕动画循环 ≈6s；K̂ 已有公式消歧；主题合规（零霓虹光晕、text-white 全部落在实心深色）；ArchitecturePage 互链可跳转。

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| E1 | P2 | Formula 代入态残留下标（`βₜ` 代入后显示 `1.00ₜ`） | **已修**：showValue 跳过 sub/sup，且代入值改走 `fmt` |
| E2 | P2 | 格式化双轨（公式 `1.00` vs 正文 `1`）；Tab3 差值热力图出现 `-0.00` | **已修**：公式走 fmt；热力图 `-0` 归一，定宽 toFixed 保留（刻意） |
| E3 | P2 | 第①步定调公式 `S ∈ R^d` 记号不严谨 | **已修**：改 `R^{dᵥ×dₖ}`，尾注同步 |
| E4 | P2 | Tab3（23 张热力图）无「格色=数值正负」说明 | **已修**：顶栏加带色点常驻图例 |
| E5 | P2 | 390px 顶部主导航横向溢出 ~79px（站点级既有问题，新导航项加剧） | **已修**：nav overflow-x-auto + 链接 nowrap，382px 下四 tab overflow 0px |
| E6 | 建议 | 93 层条带占 93 个 Tab 键位 | **已修**：条带格 tabIndex=−1，可聚焦元素 90+→11，鼠标点击/重复单元聚焦不受影响 |

### 复测（修复批后，定点 6/6 PASS）

Formula 代入态全量扫描（7 个含代入公式的步骤，badSubscript/badTrailingZero 均空，步⑧ α 显示 `0.9`）；差值热力图 4 种组合 1376 格无 `-0.00`；Tab3 色标说明可见；382px 四 tab 溢出 0px、nav 可横滚单行；条带 93 格 tabIndex 全 −1 且计数 69/24 不变；锚点回归无破坏。console 全程 0 error/0 warning。**终态：0 P0 / 0 P1 / 0 P2。**

### 未能自动化覆盖（建议人工 30 秒抽查）

1. 真实可见窗口下的动画平滑度/闪烁（QA 的 rAF polyfill 只能证明动画推进与循环，证不了 60fps 观感）；
2. 真机窄屏（iOS Safari）nav 横滚与矩阵容器横滚的触摸手感；
3. serif 公式与中文正文的基线对齐（主观排版）。
4. 鲁棒性备忘：Tab1 `AnimatePresence mode="wait"` 在后台标签页会出现「计数走、卡片不换」（切回即自愈，真实环境 0.22s 完成）；若要根治可改交叉淡入，本次未动。
