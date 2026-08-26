# 扩展指南（EXTENDING）

本应用的扩展性来自一个核心设计：**所有内容都是 `src/data/` 下的类型化数据，组件只负责渲染**。
新增一个模型/硬件/引擎/题目，绝大多数情况只是往数组里加一个对象，不用碰任何组件代码。

## 扩展点速查表

| 想扩展什么 | 改哪个文件 | 类型约束 | 要碰组件吗 |
|---|---|---|---|
| 新增开源模型 | `src/data/models.ts` | `ModelSpec` | 否（卡片/diff/计算器自动出现） |
| 新增注意力机制 | `src/data/types.ts` 的 `AttentionType` + `src/data/attention.ts` | union 字面量 + `AttentionStage` | 否 |
| 新增 GPU / 机架 | `src/data/hardware.ts` | `GpuChip` / `RackSystem`（分层实体，禁跨层对比） | 否 |
| 新增推理引擎/算子/组件 | `src/data/stack.ts` 对应层的 `components` | `StackComponent`（what + interview 两段） | 否 |
| 新增推理架构图/组件 | `src/data/archAtlas.ts` | `ArchDiagram` / `ArchComponentDef`（组件全局注册一次，图内只声明放置；含数字的 benefit 必带 `sourceIdx`） | 否 |
| 新增推理 KPI / 诊断规则 | `src/data/inferenceKpis.ts` + `src/lib/kpiEngine.ts` | `KpiDefinition` / 纯函数；必须区分 target / estimated / measured | 否 |
| 新增生命周期阶段 | `src/components/LifecycleSim.tsx` 的 `STAGES` | — | 是（该数组就在组件内） |
| 新增模拟公式 | `src/lib/simEngine.ts` + `simEngine.test.ts` | 纯函数 + 必配已知算例单测 | 否 |
| 新增 KDA 推导步骤 / 演示场景 | `src/data/kda.ts` 的 `KDA_DERIV_STEPS`（场景数值改 `src/lib/kdaEngine.ts` 的 `DEFAULT_SCENARIO`） | `DerivStep`（`body` 必须是 `(step, fmt) => string` 取数函数，**禁写死数字**）+ `ScenarioSpec` | 否（四个 tab 组件全部按 `views` 声明渲染） |
| 新增面试题 | `src/data/questions.ts` | `Question`（mustCover/redFlags 必填） | 否 |
| 新增 ROI/POC 案例 | `src/data/cases.ts` | `WorkedCase` | 否 |
| 新增 API 价格行 | `src/data/pricing.ts` | `PriceRow`（sourceUrl+asOf 必填） | 否 |
| 新增评分 Provider | `src/store.ts` 的 `PROVIDERS` + `vite.config.ts` 的 `routes` + `.env.example` | `ProviderPreset` + 代理 allowlist | 否 |

> 架构图谱的 `variantNote` 琥珀语义：它是对比模式里**唯一**参与「调整（琥珀）」判定的字段——
> 两图同一组件的 `norm(variantNote)`（trim、缺省归空串）不相等即亮琥珀。因此只在组件**职责/形态有实质差异**时写（≤40 字），
> 数量/规格差异写 `badge`（不参与 diff），图内风味补充写 `detail`（不参与 diff）。措辞漂移会造成琥珀误报，不确定就不写。

> AIPerf 导入的口径约束：`unit` 以 artifact 内容为准；系统输出 TPS、单用户 tok/s、RPS 与 Goodput 是四个不同指标。
> Goodput 只接受 AIPerf 已按逐请求 SLO 计算的值，禁止用多个 p95 汇总值二次伪造。分析层只转换明确识别的时间/速率/比例单位，
> 未知单位与官方 collated 中未携带 unit 的统计都显示 N/A；缺 unit 的 Server/Telemetry series 仅保留原始审计值，不能进入诊断。
> 多维 Sweep 不会被静默混成单轴曲线，不同 `sweep_id`（或无 ID 时不同来源文件）也必须分组选择，绝不跨实验连线。
> 实测 Goodput 进入 Sizing 前还必须显式填写客户体验 SLO 与最低逐请求达标率，并核对模型、量化、ISL/OSL、引擎版本、
> 负载、GPU 拓扑、原始 SLO 与容量单元完全一致；两类 SLO 都没有通用默认值。

> `/inference` 成本状态口径：`systemTps` 是“每容量单元的系统输出 TPS”，`hourlyCost` 是当前 `gpuCount` 对应的整集群时成本。
> 场景的模型/GPU/量化/batch/ISL/OSL/容量单元变化会使旧 TPS 指纹失效；API 与自建比较统一使用“每百万输出 token”。

## 演练 ①：新增一个模型（例：Qwen4 发布了）

`src/data/models.ts` 追加一个 `ModelSpec`：

```ts
{
  id: 'qwen4-500b',
  name: 'Qwen4-500B-A20B',
  vendor: '阿里 Qwen',
  year: 2026,
  totalParamsB: 500,
  activeParamsB: 20,
  moe: { experts: 512, activePerToken: 8 },
  attentionType: 'GDN',            // 已有类型直接用
  kvSpec: { kind: 'unsupported', note: '官方未公布维度' },  // ← 关键：三选一
  contextK: 1000,
  license: 'Apache 2.0',
  multimodal: true,
  sourceUrl: 'https://...',        // 溯源必填
  asOf: '2026-08',
  diffVsTransformer: ['...'],
  highlights: [{ title: '...', what: '一句话机制', why: '为什么重要' }],
}
```

加完即自动获得：演进卡片（含 diff 高亮）、对比表行、显存计算器条目。
- `kvSpec.kind` 是**判别式联合**：`mha-gqa` / `mla` 给维度就能算显存；查不到维度就用
  `unsupported`——计算器会显示「该架构不支持数值估算」而不是编造数字。**宁可不算，不给伪精确**。
- 如果它带来了全新注意力机制：在 `types.ts` 的 `AttentionType` 加一个字面量，
  在 `attention.ts` 演进表加一行。TypeScript 会在所有 switch 分支处报错提示你补全。

## 演练 ②：新增推理算子/框架（例：chunked prefill、LMDeploy）

**只加讲解**（大多数情况）：`src/data/stack.ts` 找到对应层（服务/引擎/集群/硬件），加一条：

```ts
{
  id: 'chunked-prefill',
  name: 'Chunked Prefill',
  what: '把长 prompt 的 prefill 切成小块与 decode 混排，避免长 prefill 阻塞出字。',
  interview: 'PD 分离之外的另一条路：单池内缓解 prefill/decode 干扰，vLLM 已默认开启。',
}
```

**要参与数值模拟**（少数情况）：在 `src/lib/simEngine.ts` 加纯函数（写清公式假设与来源），
并在 `simEngine.test.ts` 加至少一个已知算例（如"70B FP8 权重 ≈ 70GB"这类可手算验证的数字）。
引擎全部是无副作用纯函数，UI 只是调用者——公式改错会被单测拦住。

## 演练 ③：新增评分 Provider（例：接入 Qwen DashScope）

三处各加一行，key 永不进前端 bundle：

1. `vite.config.ts` → `routes` 加 `{ prefix: '/api/dashscope', target: 'https://dashscope.aliyuncs.com', envKey: 'DASHSCOPE_API_KEY' }`
2. `src/store.ts` → `PROVIDERS` 加 preset（chatPath、defaultModel、supportsJsonMode）
3. `.env.example` / `.env.local` 加 `DASHSCOPE_API_KEY=`，重启 `npm run dev`

代理是**固定 allowlist**：不支持运行时任意 base URL，这是有意的安全设计（key 由 dev 代理注入
Authorization，UI 粘贴的 key 走 `X-User-Key` 头被代理改写，两条路都不落前端代码）。

## 扩展性靠什么保证

1. **数据驱动**：内容=数据文件，新增内容的 code review 就是一个对象的 diff。
2. **判别式联合类型**：`KVSpec`/`AttentionType` 等 union 让"新架构"成为编译器强制处理的分支——
   漏写分支编译不过；没有可靠参数就走 `unsupported` 优雅降级，杜绝伪精确。
3. **纯函数引擎 + 单测回归**：`simEngine` 28 个已知算例单测，改公式跑 `npm test` 即知有没有算错。
   `kdaEngine` 更进一步：`/kda` 页面所有数字（公式代入值、热力图、曲线、讲解文案）都由 `buildKdaTrace()`
   单一 trace 派生，讲解文案是取数函数而非字符串常量——`src/data/kda.test.ts` 会在真实 trace 上求值，
   文案与引擎一旦脱钩立即失败。想新增变体：加一个 `stepXxx` 单步函数 + `VariantId` 字面量，
   TypeScript 会在 `Record<VariantId, ·>` 处报错提示补全所有分支。
4. **溯源约定**：所有易变事实（价格/参数/规格）必带 `sourceUrl` + `asOf`，更新时知道对谁核对。
5. **验证脚手架现成**：`npm run typecheck` + `npm test` + `npm run build` 三连即完成回归。
