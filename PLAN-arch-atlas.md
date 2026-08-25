# PLAN: 推理架构图谱 — 可切换、可对比的推理逻辑架构图

> 状态:已批准(2026-08-25)。交付方式:专属子代理分阶段实施(A 数据骨架 fable → B 渲染 opus5 ∥ C 内容 fable → D 核验 sonnet5 → E 浏览器走查)。

## Context

「推理链路」页(llm-pro.cn/#/inference)的「全链路四层」目前只有文字 chip 分层讲解,不直观,且单一分层视角无法回答「不同推理架构之间为什么有差异、差异带来什么收益/代价」。本功能新增「架构图谱」tab:
1. **7 张基于业界真实实践的架构图**,可切换学习;
2. **对比模式**:任选两架构并排,自动高亮组件的增/删/调整(绿/红/琥珀),配差异解读;
3. **选型取舍**:每图一张决策卡(问题/收益带实测数字/衡量指标/代价/何时不该用/每实例 GPU 数量级,联动显存墙计算器),外加 10 维度 × 7 架构对比总表;
4. **每图带参考资料区块**(论文/官方博客/文档/视频/GitHub 外链)。

7 张图:① 单体推理基线(vLLM/SGLang 单实例)② PD 分离(DistServe/Dynamo/Mooncake)③ 大规模专家并行(DeepSeek V3/R1)④ K8s 多副本编排+自动扩缩容(llm-d/AIBrix/production-stack)⑤ 智能路由与多租户网关(KV-aware routing/cache_salt)⑥ KV Cache 分层(Mooncake Store/LMCache/Character.AI)⑦ RAG 分池(Embedding/Reranker/LLM/VLM,HF TEI)

## 既定约束(代码库已探明)

- **不引任何图形库**(仓库既定决策,`graphLayout.ts` 注释明示;跨境带宽 ~17KB/s,入口已 490KB)。沿用 HTML 盒子范式(`TransformerDiagram.tsx` 的 node()/arrow/dashed 分组 + `AgentPage.tsx` 的 Box/V)。
- 数据驱动:内容全在 `src/data/` typed 常量,组件只渲染(`EXTENDING.md` 约定);易变事实必带 `sourceUrl + asOf`(`Sourced`,`src/data/types.ts:2`)。
- vitest 只收 `src/**/*.test.ts`;build = `tsc --noEmit && vite build && precompress`,TS strict + noUnusedLocals。
- 新组件**不得**放 `src/components/papers/` 子树(vite flag-off 虚模块化会白屏,`App.tsx:12-14` 有同类教训)。
- 不动 `vite.config.ts` / `nav.ts`。

## 核心设计

### 数据模型 — `src/data/archAtlas.ts`(新)

**注册表 + 放置声明**:所有概念只在全局 `ARCH_COMPONENTS` 定义一次,7 张图只声明「放置哪些 ID」。同 ID = 同概念由构造保证(diff 根基),讲解文字每概念写一次跨图复用(内容量从 7×10 段降到 ~40 段)。

```ts
export type LaneId = 'client' | 'access' | 'orchestration' | 'engine' | 'kv' | 'infra'
export const ARCH_LANES = [客户端与调用方/接入与路由/调度与编排/推理引擎池/KV 与数据存储/硬件与网络]

export interface ArchComponentDef { name; enName?; lane: LaneId; what; why?; interview? }
export const ARCH_COMPONENTS = { gateway: {...}, 'kv-router': {...}, ... } as const
  satisfies Record<string, ArchComponentDef>   // 必须 satisfies,类型注解会把 keyof 拓宽成 string
export type ArchComponentId = keyof typeof ARCH_COMPONENTS   // 引错 ID 编译期报错

export interface ArchNode {
  id: ArchComponentId
  variantNote?: string  // 本图角色变体 ≤40 字,唯一参与琥珀判定的字段
  detail?: string       // 本图专属长讲解,不参与 diff
  badge?: string        // 'EP32' '×N 副本' '×18 节点'——数量差异写 badge 不写 variantNote
  group?: string
}
export interface ArchGroup { id; label; lane: LaneId; tone?: 'accent'|'accent-2'|'ok'|'warn' }
export interface ArchEdge { from; to: ArchComponentId; label; kind: 'kv'|'control'|'data' }
  // from/to 仅用于测试校验与语义,不用于定位(定位由泳道/group 相邻关系隐含)

export interface ArchSource extends Sourced { kind: 'paper'|'blog'|'docs'|'video'|'github'; title }
export interface DecisionCard {
  problem; benefits: { text; sourceIdx? }[]   // 带数字的条目必须给 sourceIdx 指向 sources
  metrics: string[]; costs: string[]; avoidWhen: string[]
  gpuScale: string      // '每实例 8~16 卡(TP8 起步)'
  memoryPreset?: { modelId?; gpuId?; quantId?: QuantId; batch? }  // QuantId 从 ../store 导入
}
export type DimensionId = 'mono-vs-pd'|'runtime'|'parallelism'|'batching'|'prefix-kv'
  |'model-routing'|'autoscale'|'replicas'|'tenancy'|'pooling'
export interface ArchDiagram {
  id: ArchId; name; tagline; exemplars
  nodes: ArchNode[]     // 数组顺序 = 泳道内顺序
  groups?; edges?
  vsBaseline?: string[] // 相对①基线的差异解读 3~5 条,非 baseline 必写
  decision: DecisionCard; sources: ArchSource[]   // 每图 ≥3 条
  dims: Record<DimensionId, string>   // Record 联合键,缺一项编译不过;单格 ≤20 字
  meta: { minDeploy; qpsThreshold; network; opsComplexity: 1|2|3|4|5; avoidWhen }
}
export const ARCH_DIAGRAMS: readonly ArchDiagram[]   // 7 张
export const ARCH_PAIR_NOTES: { pair: [ArchId, ArchId]; note }[]  // 仅 4~6 个高价值对,顺序无关
```

**差异解读分层**(不写 21 对):L1 结构 diff 自动算 → L2 每图 `vsBaseline`(必写)→ L3 `ARCH_PAIR_NOTES` 稀疏预写(baseline↔pd、pd↔large-ep、k8s↔router、pd↔kv-tier 等 4~6 对)→ L4 两张决策卡并排兜底。

### 泳道渲染 — 固定 6 泳道,不用自动布局

diff 对比的前提是两图同概念同行同序,所以**否定自动布局**(不拷 `graphLayout.ts`),用固定泳道:`client → access → orchestration → engine → kv → infra`,自上而下即请求流向。空泳道渲染为置灰细条(不隐藏)——对比模式两侧行天然对齐,单图模式传达「架构演进 = 在固定分层上做加法」(①基线的 orchestration 置灰 → ④K8s 图点亮,视觉叙事就是教学主线)。

渲染器规则(`ArchDiagramCanvas`):按泳道行渲染;行内节点 `flex flex-wrap`,多池用 `border-2 border-dashed` group 框 + 绝对定位角标(照抄 TransformerDiagram 形制),多 group `grid sm:grid-cols-2`;相邻非空泳道间插 `↓`;edges 三种受限表达——`kv`→同泳道 group 间居中 label chip(`⇄ KV RDMA 传输`,amber 底)、`control`→泳道间注解行(`⇣ watch/scale 控制指令`,dim 色)、`data`→节点下小字。节点 = 可点击按钮(选中 `border-accent bg-accent/10`)+ badge + diff 态 ring(绿 `ring-ok` 新增/红 `ring-bad` 移除/琥珀 `ring-amber` 调整)。

内容侧硬约束(写进数据文件头注释 + 测试卡上限):每泳道 ≤6 节点、每 group ≤4 节点、variantNote ≤40 字。移动端泳道纵向堆叠天然适配,页面级禁止横滚。

7 图落位要点:③大 EP 用 group label 承载「Prefill 单元 ×4 节点(EP32)/Decode 单元 ×18 节点(EP144)」,不画 144 个格子,组内粗粒度 3 节点(MLA 注意力部 DP/路由专家分片 EP/共享专家);④控制面用 `control` 注解行不做真实连线;⑥kv 泳道纵深 4 级(HBM→DRAM→SSD→远端池);⑦engine 四池并排 `lg:grid-cols-4`。

### 组件树 — `src/components/arch/`(新目录)

```
ArchAtlas.tsx          主组件:二级 SegmentedTabs(图谱/对比/总表)
ArchDiagramCanvas.tsx  泳道渲染器(单图/对比共用,props 含 diffStates?: Map)
ArchNodeDetail.tsx     右侧 sticky 详情(what/why/variantNote/detail/interview)
ArchDecisionCard.tsx   决策卡 + 「用显存墙计算器验证 →」
ArchCompare.tsx        两个 <select> + 并排 dense canvas + 差异解读区
ArchDimensionTable.tsx 总表(桌面 <table> 卡内 overflow-x-auto;移动端转维度卡片列表)
ArchSources.tsx        参考资料分类块(外链统一 `来源({asOf})↗` 写法)
```

- 图谱视图复用 StackExplorer 双栏形制:顶部 7 枚架构 chips;左列 canvas + 决策卡 + 参考资料;右列 `lg:w-96 lg:sticky lg:top-20` 详情。
- 对比视图:diff 方向定义为「从 A 演进到 B」,色例说明;移动端先渲染文字化 diff 摘要再纵向堆叠两图;点节点显示该组件在 A/B 中 variantNote 对照。

### diff 算法 — `src/lib/archDiff.ts`(新,纯函数)

并集遍历两图 node id:都在且 `norm(variantNote)`(trim,undefined 归空串)相等→same,不等→changed;仅 B→added;仅 A→removed。`findPairNote(x,y)` 顺序无关。配 `src/lib/archDiff.test.ts`(fixture 四态 + 真数据断言 + 自比对全 same + 方向反转互换)。

### InferencePage 接线(改 ~6 行)

`TABS` 加 `{ id: 'atlas', label: '架构图谱' }`(排在 stack 之后);`const ArchAtlas = lazy(() => import('../components/arch/ArchAtlas'))` + Suspense 骨架 fallback——数据+组件独立 chunk,入口零增长;`<ArchAtlas onJumpToMemory={() => setTab('memory')} />`。

### GPU 数联动

决策卡 `gpuScale` 旁按钮,点击时对 `memoryPreset` 中存在的键调 `useInferenceParams` setter(`src/store.ts:96`,setModelId/setGpuId/setQuantId/setBatch 全现成)再 `onJumpToMemory()`。仅显式点击时写入。测试守卫 preset 的 modelId/gpuId 存在于 `models.ts`/`hardware.ts` 数据。

## 实施步骤与代理编排

0. **主循环**:本文件即 step 0 产物。
1. **阶段 A — 数据骨架与 diff(fable 代理)**:类型 + LANES + DIMENSIONS + 注册表(先收①②所需 ~20 组件)+ 图①②完整数据 — `src/data/archAtlas.ts`;diff 纯函数 + 单测 — `src/lib/archDiff.ts`、`src/lib/archDiff.test.ts`;数据完整性测试 — `src/data/archAtlas.test.ts`。
2. **阶段 B — 渲染组件(opus5 代理,依赖 A 产出的类型)**:Canvas + NodeDetail + ArchAtlas 图谱视图 + InferencePage 接 tab(lazy);决策卡(含显存墙联动)+ 参考资料块;对比视图(含移动端降级);总表视图 — `src/components/arch/*`、`src/pages/InferencePage.tsx`。用 ①② 数据迭代。
3. **阶段 C — 内容大头(fable 代理,可与 B 并行,独占 `archAtlas.ts`)**:补齐③~⑦(注册表扩到 ~40 组件)+ 决策卡/sources/dims/vsBaseline;`ARCH_PAIR_NOTES` 4~6 条 + 测试;`EXTENDING.md` 登记。(文件所有权:A 完成后 `archAtlas.ts`/`archAtlas.test.ts` 归 C 独占,B 只读类型)
4. **阶段 D — 链接核验与全量验证(sonnet5 代理)**:URL 连通性一次性脚本(scratchpad,不入库;跨境网络会误报,失败项报告人工复核而非直接删);`npm run test` + `npm run build`;三条 ⚠️ 推断地址逐条确认(Kueue 官网、NVIDIA KAI-Scheduler 仓库、DeepSeek EPLB 仓库)。
5. **阶段 E — 浏览器走查(主循环,Chrome MCP)**:7 图逐张走查、对比模式三色抽查、总表两形态、375px 无横滚、决策卡跳转+预填;P0/P1 派回修复直至归零。

## 验证

- `npm run test`:图 id 唯一且=7;node id 图内唯一;group/edge 引用有效且 lane 一致;每图 sources≥3、`sourceUrl` https、`asOf` 匹配 `YYYY-MM`;含数字 benefit 必带合法 sourceIdx(裸数字禁入,沿用 `kda.test.ts` 红线);非 baseline 必有 vsBaseline;dims 非空 ≤20 字;memoryPreset id 有效;泳道/group 节点数与 variantNote 长度上限。
- `npm run build`:tsc strict 全过;确认 ArchAtlas 为独立 lazy chunk、入口体积不涨。
- 浏览器走查(见阶段 E)。
- 部署一律 `scripts/deploy.sh`(本计划不含部署,待用户确认后执行)。

## 内容素材(调研 2026-08-25 完成,实施时直接填入;asOf 统一 '2026-08')

已验证(✅ 实际抓取):DeepSeek V3/R1 推理系统官方披露(EP32/EP144、4/18 节点单元、峰值 278 H800 节点、磁盘 KV 命中率 56.3%、理论成本利润率 545%)https://github.com/deepseek-ai/open-infra-index/blob/main/202502OpenSourceWeek/day_6_one_more_thing_deepseekV3R1_inference_system_overview.md;Hao AI Lab《Disaggregated Inference: 18 Months Later》https://haoailab.com/blogs/distserve-retro/(全行业采用名单+横向数字);llm-d 智能调度博客 https://llm-d.ai/blog/intelligent-inference-scheduling-with-llm-d(ITL 30ms vs 160ms、TTFT 57x);NVIDIA Dynamo KV-aware routing 文档 https://docs.nvidia.com/dynamo/user-guides/kv-cache-aware-routing;Dynamo disaggregated serving 视频 https://www.youtube.com/watch?v=_UDJy_5_Czw。

各图核心来源(🔍 搜索引擎返回,阶段 D 复核):
- ①:vLLM SOSP'23 论文 https://arxiv.org/abs/2309.06180(2–4x 吞吐);SGLang NeurIPS'24 https://arxiv.org/abs/2312.07104(结构化场景至 6.4x);Anyscale continuous batching 23x https://www.anyscale.com/blog/continuous-batching-llm-inference;《Inside vLLM》https://vllm.ai/blog/2025-09-05-anatomy-of-vllm;vLLM Office Hours 播放列表 https://www.youtube.com/playlist?list=PLbMP1JcGBmSHxp4-lubU5WYmJ9YgAQcf3;案例:LinkedIn 50+ 场景、Meta/Mistral/Cohere/IBM 生产使用
- ②:DistServe OSDI'24 https://arxiv.org/abs/2401.09670 + 演讲 https://www.youtube.com/watch?v=WwJvecXOeUA(7.4x goodput / 12.6x 更严 SLO);Mooncake FAST'25 Best Paper https://arxiv.org/abs/2407.00079 + 演讲 https://www.youtube.com/watch?v=-Lpx9QuCEsw + https://github.com/kvcache-ai/Mooncake(Kimi 线上 A800 +115%/H800 +107%,长上下文模拟至 +525%);vLLM disagg prefill https://docs.vllm.ai/en/stable/features/disagg_prefill/;SGLang PD https://docs.sglang.ai/advanced_features/pd_disaggregation.html;BentoML handbook(反面:不匹配负载 -20~30%)https://bentoml.com/llm/inference-optimization/prefill-decode-disaggregation;泼冷水论文 https://arxiv.org/pdf/2506.05508;案例:Kimi、DeepSeek、Meta、Perplexity、Fireworks、Baseten(Dynamo 2x)
- ③:DeepSeek Day6(✅ 见上);SGLang 96×H100 复现 https://www.lmsys.org/blog/2025-05-05-large-scale-ep/(52.3k in / 22.3k out tok/s per node,相比朴素 TP 输出吞吐至 5x);DeepEP https://github.com/deepseek-ai/DeepEP;Meta 工程博客 https://engineering.fb.com/2025/10/17/ai-research/scaling-llm-inference-innovations-tensor-parallelism-context-parallelism-expert-parallelism/
- ④:llm-d(✅ 见上 + https://llm-d.ai/blog/llm-d-v0.2-our-first-well-lit-paths,8 pods/16×H100 相比 round-robin TTFT 57x/吞吐 2x);AIBrix 论文 https://arxiv.org/abs/2504.03648 + https://github.com/vllm-project/aibrix(分布式 KV +50% 吞吐/-70% 延迟,字节跳动生产);production-stack https://github.com/vllm-project/production-stack + KEDA 文档 https://docs.vllm.ai/projects/production-stack/en/latest/use_cases/autoscaling-keda.html;Perplexity 案例(20+ 模型/月 4 亿请求)https://www.nvidia.com/en-us/case-studies/perplexity
- ⑤:SGLang v0.4 router(吞吐 +1.9x/命中 +3.8x)https://www.lmsys.org/blog/2024-12-04-sglang-v0-4/;Dynamo KV routing 文档(✅);Baseten 2x 案例 https://www.baseten.co/blog/how-baseten-achieved-2x-faster-inference-with-nvidia-dynamo/;Gateway API Inference Extension https://kubernetes.io/blog/2025/06/05/introducing-gateway-api-inference-extension/;vLLM cache_salt 租户隔离 https://docs.vllm.ai/en/stable/design/prefix_caching/;多租户一手资料业界最稀缺,页面如实标注
- ⑥:Character.AI(95% KV 命中/成本 33x↓)https://blog.character.ai/optimizing-ai-inference-at-character-ai-2/;Mooncake Store(同②);LMCache https://arxiv.org/pdf/2510.09665 + https://blog.lmcache.ai;llm-d KV wins https://llm-d.ai/blog/kvcache-wins-you-can-see;BentoML prefix-caching(显存挤占代价)https://bentoml.com/llm/inference-optimization/prefix-caching;DeepSeek 磁盘 KV 命中 56.3%(✅ Day6)
- ⑦:HF TEI https://github.com/huggingface/text-embeddings-inference + https://huggingface.co/docs/text-embeddings-inference/index;Fireworks embeddings 博客 https://fireworks.ai/blog/Understanding-Embeddings-and-Reranking-at-Scale;Harmonia RAG 分池调度论文 https://arxiv.org/pdf/2505.07833

## 风险

- variantNote 措辞漂移致琥珀误报:数据文件头写作规范 + 每图完成后人工过对比视图。
- 唯一允许 `overflow-x-auto` 的位置是总表卡片内部;移动端默认维度卡形态。
- 不过度类型化(noUnusedLocals 下不预留未用导出);内容事实一律溯源,禁止裸数字。
