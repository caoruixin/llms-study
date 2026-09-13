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
- Head Sharing / Latent KV：`/#/architecture?tab=attention&mechanism=gqa&compare=mla&frame=37`
- Recurrent State：`/#/architecture?tab=attention&mechanism=gdn&compare=kda&frame=38`
- Cross-layer sharing：`/#/architecture?tab=attention&mechanism=csa2&frame=37`
- 强制二维：追加 `&view=2d`

`tab`、`model`、`models`（最多 3 个）、`mechanism`、`compare`、`frame` 和 `view` 写入 hash 路由的 query，刷新和复制链接可恢复。搜索与厂商筛选属于当前浏览状态。播放中每次只推进一个计算阶段；回放从同一固定轨迹读取，不累计浮点误差。播放控件组聚焦后，Space 播放／暂停，左右箭头单步；滑块、原生 select、折叠卡片与二维选择器可通过键盘操作。

## 数据与渲染边界

| 文件 | 职责 |
| --- | --- |
| `src/data/architectureTypes.ts` | 八个观察维度、参数口径、证据、官方来源的类型 |
| `src/data/architectureModels.ts` | 模型快照、同族基线、来源与公开程度 |
| `src/data/architectureRevisions.ts` | 官方仓库 revision、核验日期及权重分片存在性 |
| `src/data/architectureTerms.ts` | 全站共用的英文术语与中文解释 |
| `src/lib/attention/engine.ts` | 确定性的投影、选择、Softmax、输出、缓存记账和 State 轨迹 |
| `src/lib/kdaEngine.ts` | 已有 GDN / KDA 数值核；实验室复用其中的状态更新函数 |
| `src/components/ModelEvolution.tsx` | 模型搜索、筛选、卡片、基线与多模型比较 |
| `src/components/architecture/AttentionLab.tsx` | 共享时间轴、数值解释、二维回退与状态增长图 |
| `src/components/architecture/TraceScene.tsx` | Three.js 场景、OrbitControls、raycast 选择和资源释放 |
| `src/data/attention.ts` | 13 种机制的速查表与实验室入口 |

数值内核不依赖 React 或 Three.js。`AttentionTrace → AttentionStep → HeadTrace` 同时供三维、二维、Inspector、Weights 与缓存统计使用。3D 中前景表示当前层的操作，半透明层板表示层深度，**不重复运行完整 LLM 的多层网络**。箭头和粒子展示当前选中路径，速度不表示吞吐；颜色／高度提供数值直觉，完整数值由 Inspector 提供。

Three.js 仅在 Attention tab 的 3D 视图首次加载；普通模型浏览与二维视图不加载 renderer。每次场景更新释放旧 geometry、material、CanvasTexture；卸载时清理 RAF、ResizeObserver、DOM listeners、OrbitControls、WebGLRenderer 与 context。浏览器切后台暂停播放。`prefers-reduced-motion`、初始化失败、context lost 均使用同一数值轨迹的二维界面。

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

## 数值约定与首版简化

统一使用 8 个固定、4-dimensional 教学 Embedding，4 Q Heads，4 层记账；第 1–5 个 token 属于 Prefill，第 6–8 个属于逐 token Decode。Prefill 逐行播放是对可并行计算的 causal rows 做教学观察，不声称实际 Runtime 逐行执行。

**MHA / MQA / GQA**：分别使用 4 / 1 / 2 个 KV Heads。`head_to_KV(h) = floor(h × Hkv / 4)`。`q = normalize(rotate(x,h))`，`k = normalize(rotate(x,kvHead))`，`v = rotate(x,kvHead) ⊙ [1,.5,1,.5]`。只将已选择的 causal positions 传给 stable Softmax，未来位置与稀疏未选中位置的权重为 0。

**MLA**：`c=[(x0+x2)/2,(x1+x3)/2]` 为 2D latent，另存 2D RoPE `[cos(t/2),sin(t/2)]`。每个 Head 用明确的 4×2 `Uk` / `Uv`；`qᵀUk c = (Ukᵀq)ᵀc`、`Σw Uv c = Uv Σw c` 均在测试中验证。Inspector 为便于手算重建 K/V；账本仅存 latent + RoPE。此处的 4 元素不是 DeepSeek 的实际 576 元素配置。

**Sparse variants（Teaching implementation）**：Indexer 用固定前两维投影，`max(0,q0*k0+q1*k1)`；这不是官方 learned indexer。DSA 选 Top-2 tokens。QSA 以 4 tokens 为 micro-block，MSA 以 2 tokens 为 block，选一个最高分完整块，未完成 tail 保留。Top-K 同分时按较早位置稳定排序。展示主 Attention 的 per-Q-head entry count 和独立 Indexer candidate count，不把前者当作整个机制的 FLOPs。

**SWA / CSA / HCA**：Window=3。CSA 对更早历史以 2:1 块均值压缩，选一个摘要；HCA 以 4:1 压缩并读取全部摘要。窗口和未完成压缩 tail 都保留，避免漏 token。压缩后的 Key / Value 是可计算的教学均值，非官方压缩算子。覆盖图把摘要权重等分回所属 token，明确标注为 `Summary contribution map`，不能解释为 token-level Attention Weights。压缩摘要数量仍随长度增长，与固定 State 不同。

**GDN / KDA**：矩阵方向为 `S[value][key]`，本教学取 `q=k`，归一化 k，β=.7。GDN 使用 scalar α=.8；KDA 使用 α=[1,.6,.9,.4]。沿 key channels 衰减，计算预测误差，再进行增量写入，最后读取：

```text
Sbar = Sprev diag(alpha)
prediction = Sbar k
residual = v - prediction
S = Sbar + beta * outer(residual, k)
output = S q
```

省略 learned gates、短卷积和 output normalization；只展示 Delta Rule 核心。既有 `/kda` 入口保留。Mamba-2 / SSM 在模型卡单独说明，只对其 GQA 分支提供 Attention 演示，不套用 KDA 方程。

**CED / CSA2（结构教学）**：固定 `Full → Reindex → Reuse → Reuse` 层模式，展示 Global KV、Indexer K 与 Top-K IDs 的共享关系，数值读取使用同一低秩 Attention 核心。它不模拟完整 20+20 层 CED、Hierarchical Sparse Indexer、FP4 rounding 或 SWA bounded replay；因此没有声称复现 DeepSeek Runtime 的 890 B/token 或真实吞吐。

## 缓存记账

场景账本展示**本 token 完成后的状态**；Inspector 保留该 token 的完整计算结果，阶段只切换当前操作高亮。每个新 token 仍需计算自身 Q/K/V。纯机制的教学估算为：

| 机制 | 元素／字节账本 |
| --- | --- |
| MHA / MQA / GQA | `L × layers × 2 × Hkv × d × batch` KV 元素 |
| MLA | `L × layers × (latent2 + RoPE2) × batch` |
| DSA | MLA + `L × layers × index_dim2 × batch` |
| QSA / MSA | 原有 GQA KV + 完整块 index keys + tail index keys |
| SWA | `min(L,W)` 个位置的 KV |
| CSA / HCA | 已完成的压缩摘要 + Window + Incomplete Tail；CSA 另计 Summary Indexer |
| GDN / KDA | `layers × heads × d × d × batch` 的固定 State |
| CSA2 | 一份 Global KV + 一份 Indexer K + Full/Reindex 的 Top-K IDs + 各层 SWA 工作状态 |

KV 按 FP16（2 bytes）记账，State FP32（4 bytes），Top-K IDs 为 int32。模型权重、卷积状态、临时激活、allocator、kernel workspace 均不含在该值中。纯 GDN/KDA 层的常量曲线不代表整个 Hybrid 模型的内存固定。真实模型总量需按其实际层编排逐项组合。

Lookup memory 为独立权重估算 `parameters × assumed_bits / 8`，不随请求数或长度增加。51B / 196B 是目录中已披露的表参数；精度选择为用户假设，不声称官方实际布局。图表显示二进制 KiB / MiB / GiB。

## 验证与发布

```bash
npm run typecheck
npx vitest run src/data/architectureModels.test.ts src/lib/attention/engine.test.ts
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

脚本覆盖筛选、0 结果、比较上限、卡片展开、场景跳转、前后单步、播放暂停、同步对照、URL 恢复、键盘、13 种机制、旋转缩放、强制二维、reduced motion、WebGL 初始化失败、390px 布局以及 renderer context 释放。报告和截图输出到被忽略的 `output/playwright/architecture/`。

发布沿用现有 `scripts/deploy.sh --web` 的 build → upload → 原子目录切换流程；无需后端迁移。脚本保留最近两个 `/var/www/llms-study.bak-*`，可按现有部署手册选择已验证备份回滚。发布内容以 Git commit 为准，使用独立 checkout 构建；工作区已有 Agent RL / Paper 等未提交改动保留。

### 本次验收记录（2026-09-12）

- 官方权重仓库：23 / 23 可读取官方 metadata，均存在 safetensors 权重文件，revision 已记录。
- 新增资料／数值测试：70 项；含既有模型、KDA 与 simulator 的相关回归共 128 项通过。
- 完整前端测试：104 个文件、1,758 项通过。既有 Paper 测试会打印预期的网络中止日志，测试状态通过。
- Chromium / WebKit 均实际创建 3D WebGL 场景；22 profiles、13 mechanisms、桌面与 390px 交互通过。
- 每个浏览器的离开页面检查均为 4 个 context 创建 / 4 个释放，0 页面错误；reduced motion 和显式 WebGL 失败回退通过。
- 类型检查及生产构建通过。实验室与 renderer 独立 lazy chunks；Three.js renderer 的 gzip 产物约 142 KiB。构建仍有现有大 chunk 提示，未提高阈值掩盖提示。
