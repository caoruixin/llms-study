# Architecture Atlas & Attention Lab

本次目录快照为 **2026-09-12.1**，覆盖 22 个 Architecture profiles（合并同架构 Pro / Flash 规格），核验了 23 个官方权重仓库。这是按需更新的版本化快照，不是自动抓取的模型排行榜。网站使用标准英文术语；中文解释位于副标题、说明与术语表。

## 本地验收

```bash
npm ci
npm run dev -- --host 127.0.0.1
```

- 模型目录：`/#/architecture?tab=evolution`
- 阶段参数示例：`/#/architecture?tab=evolution&model=deepseek-v41-flash`
- 模型对比：`/#/architecture?tab=evolution&models=deepseek-v41-flash,qwen38-flash-next`
- Head Sharing / Latent KV：`/#/architecture?tab=attention&mechanism=gqa&compare=mla&trace=2&frame=45`
- Recurrent State：`/#/architecture?tab=attention&mechanism=gdn&compare=kda&trace=2&frame=46`
- Cross-layer sharing：`/#/architecture?tab=attention&mechanism=csa2&trace=2&frame=44`
- 强制二维：追加 `&view=2d`

`tab`、`model`、`models`（最多 3 个）、`mechanism`、`compare`、`trace`、`frame`、`head`、`head2` 和 `view` 写入 hash 路由的 query，刷新和复制链接可恢复。搜索与厂商筛选属于当前浏览状态。Trace v2 使用 8 × 6 = 48 帧；不含 `trace=2` 的旧链接按原 token 与操作语义迁移（例如原 MHA frame=37 → v2 frame=45）。`head` / `head2` 缺省为 All Heads；指定 0–3 只改变强调。播放中每次只推进一个计算阶段；回放从同一固定轨迹读取，不累计浮点误差。播放控件组聚焦后，Space 播放／暂停，左右箭头单步；滑块、原生 select、折叠卡片与二维选择器可通过键盘操作。

## 数据与渲染边界

| 文件 | 职责 |
| --- | --- |
| `src/data/architectureTypes.ts` | 八个观察维度、参数口径、证据、官方来源的类型 |
| `src/data/architectureModels.ts` | 模型快照、同族基线、来源与公开程度 |
| `src/data/architectureRevisions.ts` | 官方仓库 revision、核验日期及权重分片存在性 |
| `src/data/architectureTerms.ts` | 全站共用的英文术语与中文解释 |
| `src/lib/attention/engine.ts` | 确定性的投影、选择、Softmax、输出、缓存记账和 State 轨迹 |
| `src/lib/attention/sceneGraph.ts` | 将本阶段轨迹转换为带对象 ID 的语义节点和有效路径，不重新计算 Attention |
| `src/data/attentionTheory.ts` | 13 种机制的官方章节、已实现过程、省略项和教学公式 |
| `src/lib/kdaEngine.ts` | 已有 GDN / KDA 数值核；实验室复用其中的状态更新函数 |
| `src/components/ModelEvolution.tsx` | 模型搜索、筛选、卡片、基线与多模型比较 |
| `src/components/architecture/AttentionLab.tsx` | 共享时间轴、数值解释、二维回退与状态增长图 |
| `src/components/architecture/TraceScene.tsx` | Three.js 场景、OrbitControls、raycast 选择和资源释放 |
| `src/data/attention.ts` | 13 种机制的速查表与实验室入口 |

数值内核不依赖 React 或 Three.js。`AttentionTrace v2 → AttentionStep → HeadTrace / MergeTrace / IndexTrace / stageStorage` 记录所有 Heads、输出合并、选择归属与逐阶段存储快照。`buildSceneFrame` 生成语义节点与本阶段允许的边；3D、2D、Inspector、Weights 与账本读取同一轨迹。普通机制只显示一个实际计算层；CED / CSA2 使用独立的跨层结构轨迹，不借用 MLA 输出。全 Heads 总览为默认，焦点不会隐藏其他 Heads 的计算。

粒子沿可见连线的同一条 QuadraticBezierCurve 运动；所有面板使用共享阶段时钟。暂停冻结运动，回放不累计数值误差；合并路径按 Head Output → Concat → Wᴼ 的依赖顺序运动。动画速度不是吞吐量。节点 ID 含存储对象与所属 Head / Group，点击其他缓存行能读取该行真实张量。

Three.js 仅在 Attention tab 的 3D 视图首次加载。每次更新释放旧 geometry、material；卸载清理 RAF、ResizeObserver、DOM listeners、OrbitControls、WebGLRenderer 与 context。浏览器后台暂停播放。`prefers-reduced-motion`、初始化失败、context lost 使用同一语义图的二维界面。标签为屏幕空间 DOM，默认相机适配场景，手机纵向对照。

旧 `ModelSpec` / `KVSpec` API 保持兼容。目录用 `legacyModelId` 引用旧条目；V4.1、Qwen3.8 等复杂架构不会自动进入旧显存计算器。修正原始 Llama 3 的 8K context 和 DeepSeek V3 的权重许可证，不改变旧计算器公式。

## 证据维护

1. 添加官方权重仓库、精确模型版本与许可证名称。`license: other` 必须打开官方 LICENSE；不能按同族上一代猜测。官方开放权重不代表所有许可证都是 MIT / Apache。
2. 查询 HF 官方 model API，记录 commit SHA 与是否存在权重分片。**创建时间、修改时间都不是发布日期**。模型卡与配置链接固定到本次核验 revision，权重入口保留官方仓库主页。
3. 为八个维度分别填写 `ArchitectureChange`，每个已披露维度必须有 `sourceIds`；缺失项使用 `disclosed: false`，显示未披露。不得从同族名称推断专家数、Layer layout、Optimizer 或解码实现。
4. `backboneB`、`activeB`、`prefillActiveB`、`decodeActiveB`、`lookupB`、`predictionHeadB` 分列。未知用 `null`／省略。GLM-5.2 / 5.3 的 checkpoint 总量与 backbone/active 拆分不清楚，所以不把旧 40B 推断当成已披露数字。
5. 每条 `BenchmarkEvidence` 保留 metric、value、unit、baseline、kind、conditions、sourceId 和 locator。单卡最多三项。用条件文字记录 Benchmark version、harness、context、reasoning effort、precision、hardware 等已披露信息；缺少的条件说明未披露。
6. 只在官方模块消融能支持因果归因时使用 `kind: ablation`。整模型、Runtime 与架构测量分别展示。不同 harness 和 thinking 模式的得分不能合并排名。
7. 更新 `CATALOG_VERSION`、条目／来源／revision 的核验日期，并运行资料一致性测试。

资料修正示例：V4 初次开放发布为 2026-04-24；V3.2-Exp 与正式 V3.2 不混用；Kimi K3 的发布与完整权重开放有不同日期；GLM-5.3 使用 GLM-5.2 base，提升来自 post-training；GLM-5.3-Flash 是另一个新基座。Mistral Medium 3.5 使用官方 model-version date，另说明 Vibe 文章日期。仅能确认月份时保留月份。

官方入口与逐项出处在模型卡中；扩展时优先查看固定 revision 的 README / config / LICENSE，不使用二手汇总覆盖官方事实。

## Trace v2 数值约定与教学边界

统一使用 8 个固定、4-dimensional 输入，4 Q Heads。主场景计算一个层；增长图按 4 个同类层估算，CSA2 为 4 层共享结构。前 5 个 token 为 Prefill，后 3 个逐 token Decode。逐行播放 Prefill 只是观察可并行的 causal rows，不声称 Runtime 必须串行处理。

六阶段：`Project → Prepare Memory → Route / Decay → Score / Predict → Aggregate / Write → Output`。Project 产生所有当前 Q/K/V；普通 Attention 在 Prepare Memory 接入当前 K/V，然后才能读。Recurrent State 在 Write 更新后才 Query Readout。最终输出不含 Residual、FFN、LM Head。

投影采用列向量约定，`y = W x`，矩阵 `[output, input]`。`engine.ts` 的 `INPUTS` / `fixtureMatrix` 固定且公开，Q、K、V 使用不同 seed；完整系数在 Equations 面板可查看。MHA 不做通用 L2 normalization，不使用 Q=K，不让各 Head 退化为相同 Attention Weights。每个 Head 输出 4 维，Concat 16 维，经 4×16 Wᴼ 得到 4 维 Attention Output；这是扩张的教学投影，不是模型规格。

| 机制 | 已实现过程与具体简化 |
| --- | --- |
| MHA / MQA / GQA | 4 / 1 / 2 KV Heads；`g=floor(h×Hkv/4)`；各自投影、因果 Softmax、Weighted V，所有 Heads 进入 Concat / Wᴼ。共享存储不共享权重。 |
| MLA | 2D latent + 2D RoPE Key；内容 Query 4D、位置 Query 2D；吸收路径用于主计算，显式重建 K/V 作为独立等价基准。重建张量不进入持久缓存。 |
| DSA | 2 个独立 Indexer Heads，固定权重 `[1,.7]` 汇总 ReLU → Top-2 token；所有 Main Heads 共享选择，分别执行 MLA。省略 learned routing、Hadamard、量化。 |
| QSA | 4 个 Indexer Heads；micro-block=4，Indexer K 先 AvgPool → RMSNorm → block-start RoPE；Top-1 完整因果块 + incomplete tail。主缓存仍是原始 GQA token KV。省略主分支 gates / norm / RoPE。 |
| MSA | block=2，每 GQA Group 一个 Indexer Q；块内 token score 取 max；Top-2 预算强制纳入当前 Local Block（包括完整块边界）。组内共享选择。 |
| SWA | Window=3；当前 KV 写入、窗口内读取、窗口外淘汰保持一致。 |
| CSA | Shared KV MQA（同一 entry 作 K 和 V）；ratio=2，当前块与前一块双分支逐 channel 加权压缩；独立压缩 Indexer，共享 Top-1 历史摘要 + Window=3。摘要与窗口允许覆盖重叠。 |
| HCA | Shared KV MQA；ratio=4、无重叠加权压缩；所有合格历史摘要 + Window=3。CSA/HCA 均使用 RMSNorm、Partial RoPE、inverse output RoPE、Attention Sink、Grouped Output Projection；固定小规模系数，不是 checkpoint 复现。 |
| GDN / KDA | 每 Head 独立 4×4 State，独立 q/k 投影并归一化；GDN scalar α=.8，KDA key-channel α=[1,.6,.9,.4]，β=.7。复用既有更新内核，省略 learned gates、短卷积、Output Norm / Gate。 |
| CED / CSA2 | 独立结构轨迹，Full → Reindex → Reuse → Reuse 为静态层模式；最后 Encoder states 生成 Decoder Global KV；Reindex 在共享候选池内重新索引，Reuse 引用最新 Top-K；每层仍生成 Main Q / SWA KV。没有虚构输出向量或 Attention Weights。 |

GDN/KDA 使用转置后的 `S[value][key]` 约定：

```text
Sbar = Sprev diag(alpha)
prediction = Sbar k
residual = v - prediction
S = Sbar + beta * outer(residual, k)
Head Output = S q
y = Wᴼ Concat(all Head Outputs)
```

普通 Softmax 权重和为 1；CSA/HCA 的 entry weights 加 sink weight 为 1（sink Value=0）。压缩来源覆盖图按平均 channel 权重回溯，不是 token-level Attention Weights。主读取量按 Head、KV Group 去重与总计算范围分开；Indexer 候选数不是主 Attention FLOPs。

逐机制章节、问题修正与算例见 [Attention theory audit](attention-theory-audit.md)。`/kda` 推导入口保留。SSM 不套用 KDA 方程。

## 缓存记账

`stageStorage` / `stageMemory` 是本阶段的实际对象快照。Project 显示之前的存储；Prepare 后显示已接入的新 KV；Recurrent State 在 Decay / Write 显示对应矩阵；CSA2 的新 Top-K / Candidate Pool 在 Route 才产生。多个引用按对象 ID 去重，不增加副本。

| 机制 | 单层教学账本（除 CSA2 外） |
| --- | --- |
| MHA / MQA / GQA | `L × 2 × Hkv × d` KV 元素 |
| MLA | `L × (latent2 + RoPE2)` |
| DSA | MLA + `L × index_dim2` |
| QSA | GQA KV + 已完成 micro-block Indexer K + 未完成 tail Indexer K |
| MSA | GQA KV + 每 token Indexer K；Block Max 不代表只缓存块均值 |
| SWA | `min(L,W) × 2 × Hkv × d` |
| CSA / HCA | 已完成 Shared KV 摘要 + Window Shared KV；另计压缩输入工作缓冲，CSA 保留前一完整块以支持重叠，并另计 Summary Indexer K |
| GDN / KDA | `heads × d × d` 的固定 State，自初始帧即分配 |
| CSA2 | 一份 Global KV、一份 Indexer K、候选池、Full/Reindex Top-K IDs，以及每层独立的 SWA KV；共享引用去重 |

主场景中的本层对象值与元素数一一对应；增长图使用等价的紧凑 storage regions，避免分配百万 token 对象，测试逐 token 验证两者一致。多层与并发另乘 layers / batch，CSA2 只对层内独有状态乘层数。

KV / Indexer / compression working inputs 按 FP16、State FP32、IDs int32。CSA2 用 ratio=1、KV dim=4、Top-2 / pool≤4 的结构预算，不复现 FP4、890 B/token 或 bounded replay。排除模型权重、卷积状态、临时激活、allocator 与未实现的 Kernel workspace。纯 Recurrent 层的恒定状态不等于整个 Hybrid 模型的请求内存恒定。

Lookup memory 为独立权重估算 `parameters × assumed_bits / 8`，不随请求数或长度增长。51B / 196B 是目录中的表参数；精度为用户假设。图表使用 KiB / MiB / GiB。

## 验证与发布

```bash
npm run typecheck
npx vitest run src/data/architectureModels.test.ts src/lib/attention/engine.test.ts src/lib/attention/sceneGraph.test.ts
npm test
npm run build
```

UI 验收使用 Python Playwright 1.52（与仓库既有浏览器版本一致）：

```bash
python3 -m venv /tmp/architecture-qa
/tmp/architecture-qa/bin/pip install playwright==1.52.0
/tmp/architecture-qa/bin/python -m playwright install chromium webkit
# 先运行 npm run dev
/tmp/architecture-qa/bin/python scripts/architecture-repro.py
```

脚本覆盖筛选、0 结果、比较上限、卡片展开、场景跳转、前后单步、播放暂停、同步对照、URL 恢复、键盘、13 种机制、旋转缩放、强制二维、reduced motion、WebGL 初始化失败、390px 布局以及 renderer context 释放。报告和截图输出到被忽略的 `output/playwright/attention-v2/`。

发布沿用现有 `scripts/deploy.sh --web` 的 build → upload → 原子目录切换流程；无需后端迁移。脚本保留最近两个 `/var/www/llms-study.bak-*`，可按现有部署手册选择已验证备份回滚。发布内容以 Git commit 为准，使用独立 checkout 构建；工作区已有 Agent RL / Paper 等未提交改动保留。

### 原始目录版本验收记录（2026-09-12）

- 官方权重仓库：23 / 23 可读取官方 metadata，均存在 safetensors 权重文件，revision 已记录。
- 新增资料／数值测试：70 项；含既有模型、KDA 与 simulator 的相关回归共 128 项通过。
- 完整前端测试：104 个文件、1,758 项通过。既有 Paper 测试会打印预期的网络中止日志，测试状态通过。
- Chromium / WebKit 均实际创建 3D WebGL 场景；22 profiles、13 mechanisms、桌面与 390px 交互通过。
- 每个浏览器的离开页面检查均为 4 个 context 创建 / 4 个释放，0 页面错误；reduced motion 和显式 WebGL 失败回退通过。
- 类型检查及生产构建通过。实验室与 renderer 独立 lazy chunks；Three.js renderer 的 gzip 产物约 142 KiB。构建仍有现有大 chunk 提示，未提高阈值掩盖提示。

### Attention Trace v2 验收（2026-09-13）

详见 [逐机制核验与验收记录](attention-theory-audit.md)。生产构建来自仅包含本次 Attention 修正的独立 checkout。浏览器脚本支持 `--base https://llm-pro.cn --output output/playwright/attention-v2-production`，可用同一套检查核验生产页面。

连续拖动／快速单步先更新本地画面，停止变化 400 ms 后合并保存 frame 到 URL；机制、视图与 Head 切换同时保存当前位置。这样避免 WebKit 的 history 写入频率限制。浏览器验收包含 20 次连续快速 seek、最终 URL 和刷新恢复。
