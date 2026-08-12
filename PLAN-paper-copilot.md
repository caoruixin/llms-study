# Paper Copilot 论文陪读实施计划

> **进度（2026-08-13）：Phase 1–5 全部交付并通过验收，v1 按计划 flag-off（生产 llm-pro.cn 零变化，本地 `npm run dev` 使用）。**
> - **实施**：8 个功能 commit（008faf7 P1 基础设施 / 99f64e2 P2 阅读器检索 / 0cfc5b6 P3 Copilot MVP / e8761b0 P4 自适应交互 / 49032b2 QA 修复轮 / 41d0bb3 深度空流修复 / 725b6cf 残句检测 / 本 commit 收尾）。单测 134 → **622 全绿**；主 chunk 976,225 → 976,749 B（+0.05%）；flag-off 产物 grep 零 paper/katex/dexie/pdfjs 痕迹。
> - **浏览器 QA（claude-in-chrome 子代理）**：首轮 0 P0 / 5 P1 / 7 P2 → 修复轮 → 复验 **12/12 FIXED，0 P0/P1**。P3 留档：附录图注坐标标签混入 PDF 目录、展开 Copilot 后 1–3s 旧宽度裁切、修复前入库文档需「替换导入」刷新目录。
> - **右尺寸化评测（§11.3，108 主运行 + 3 轮验证重跑，真实 DeepSeek 调用）**：自动化门 **6 PASS / 0 FAIL**——引用可定位 524/524（100%）、注入成功 0/9、跨论文泄漏 0、虚构引用 ID 0、schema 首过 98%（失败均安全降级）、无证据拒答 3/3、误拒 1/24（attn-m2，跨语言 BM25 零召回所致，属已知局限）、TTFT P50 0.95s/P95 3.50s、完整回答（thinking-off）P95 22.1s；deep 观察值 P95 97.5s（修复后自 110.8s 改善）。评测发现并驱动修复两个真实缺陷：深度轮推理耗尽输出预算致空流（41d0bb3）、预算烧尽残句静默返回（725b6cf），修复后实弹复验 3/3 清零。评测装置在 `scripts/paper-eval/`（README 有运行方式；fixtures/results 不入库）。
> - **待人工（约 1 小时，发布本地 beta 前完成）**：引用支持性抽查 ≥18/20、正确性 rubric（均分 <3.5 才阻断）、三层级差异可辨 3/3——物料已生成：`scripts/paper-eval/results/human-review-*.md`。
> - **其余留档**：Jina 启用门槛（20 条检索集 Recall@6）未跑——v1 默认关闭，启用前再评；模型偶发 `[[c1]]` 非标引用语法（优雅降级为纯文本，prompt 微调候选）；跨语言检索召回为 v2 优化项（Jina 语义召回是对症方案）。二阶段上生产按附录 A 执行。

> 更新日期：2026-08-12（v2）。本版在 v1 草案基础上完成代码库对齐 review 与三项决策定稿：①每轮单调用拓扑与流式线协议（§6.1/§7）；②ModelPolicy 修正为客户端类型化常量（§5.3）；③讲解渲染选定 react-markdown + KaTeX 完整管线（§7.6）；④评测右尺寸化（§11.3）；⑤v1 以本地 flag-off 方式交付，二阶段上生产方案见附录 A。模型选型沿用 v1 已验证的 DeepSeek、Kimi 与 Jina 配置；未记录任何 API key 内容。

## 1. 方案摘要

在现有 LLM Infra Studio 中新增一个 local-first 的“论文库 + 阅读工作台 + 自适应陪读 Agent”。首版面向单用户、单浏览器：文档和学习记录保存在本机，上传后可独立预览；经用户授权后，Agent 基于论文原文生成论文地图、引导阅读，并提供带原文引用的交互式讲解。

**最终模型策略：以 `deepseek-v4-pro` 作为 Paper Copilot 默认主模型；以 `kimi-k3` 作为严格结构化任务、显式深度升级和已授权故障回退模型；检索始终保留本地 BM25，Jina embedding/rerank 仅在用户单独授权且质量评测达标后启用。** Paper Copilot 使用独立模型策略，不继承当前站点写死的 `deepseek-v4-flash` 默认值。

v2 定稿的三条工程原则：

- **热路径每轮只发 1 次 LLM 调用**：TutorPlan、讲解正文、交互块、画像信号全部在同一条流式响应中以“结构岛”承载（§7）；只有两处允许有界 +1 重试（§6.1）。quiz/闪卡判分为 0 调用（本地判分）。
- **配置即代码**：模型能力矩阵、任务路由与预算是 `src/data/paperPolicy.ts` 中的类型化常量（按 EXTENDING.md 惯例对易变事实标 `sourceUrl` + `asOf`）；代理只负责注入 key（§5.3）。
- **v1 生产构建 flag-off**：板块不出现在 llm-pro.cn，nginx 零改动，公网风险面不变；本地 `npm run dev` 日常使用；二阶段上生产的限流旁路方案备好在附录 A。

### 目标与成功标准

用户可以完整完成以下闭环：

> 上传文档 → 查看论文列表 → 只读预览 → 启动 Copilot → 获得带引用且难度自适应的讲解 → 通过互动检查理解 → 刷新后继续阅读

首版成功标准：

- PDF 和 DOCX 技术文章可以稳定导入、解析、预览与删除。
- “预览文档”和“启动 Copilot”两个入口进入同一个阅读工作台，只是 Copilot 初始展开状态不同。
- Copilot 能围绕论文的核心思想、方法、理论、算法、实验和局限开展陪读，而不是退化为普通聊天。
- 回答中的论文事实均提供可点击、可回到原文的引用；证据不足时明确说明，不编造。
- 系统根据用户的提问、测验、复述和显式反馈调整讲解层次，并允许用户纠正。
- 交互使用文本、语音、公式（KaTeX 渲染）、DOM/SVG 线框图、步骤器、表格和测验，不生成图片或视频。
- 文档、会话、学习画像和阅读位置保存在当前浏览器，刷新后可以恢复。
- 普通问答默认在 DeepSeek 非思考模式下快速流式返回；复杂推导才启用深度思考，避免每一轮都承担不必要的等待和成本。
- 模型或检索服务不可用时仍能预览论文、全文搜索并查看可验证原文，不以无引用猜测替代失败结果。

## 2. 范围

### 首版包含

- 可抽取文字的 PDF 和 `.docx` 文档。
- 文档上传、论文列表、解析状态、阅读进度和删除。
- 只读文档预览与阅读位置恢复。
- 从论文列表或预览页启动同一个 Copilot 工作台。
- 论文地图、推荐阅读路径、引用问答、选段解释和自适应讲解。
- 论文速览、逐节精读、方法拆解、公式推导、实验复盘和批判性审阅。
- 语音提问与浏览器本地朗读。
- 文本讲解、公式拆解、算法步骤器、对比表、概念关系图、流程图、时间线、选择题、闪卡和 Teach-back 复述卡。
- 本地 IndexedDB 持久化和本地全文检索。

### 首版不包含

- 编辑或批注原论文。
- 旧版 `.doc` 文件。
- 扫描 PDF 的 OCR。
- 账号、多人协作和多设备同步。
- 云端文档库和跨用户分享。
- 外部联网研究或自动搜索相关论文。
- 代码执行或论文内工具调用。
- 生成图片、视频或持久化音频文件。
- 生产环境发布（v1 flag-off；二阶段方案见附录 A）。

## 3. 产品与交互设计

### 3.1 信息架构

- 新增 `/papers`：Paper Copilot 论文库。
- 新增 `/papers/:paperId`：统一的论文阅读工作台。
- “预览文档”进入工作台并默认收起 Copilot；“启动 Copilot”进入同一路由，并通过 `?copilot=open` 默认展开（HashRouter 下 query 位于 hash 内，`useSearchParams` 正常工作）。
- 顶部导航新增「论文陪读」（4 字中文标签，与现有条目对齐）。
- **Feature flag 双门控**：`import.meta.env.VITE_ENABLE_PAPER_COPILOT === '1'`（build-time 内联）同时门控 `src/nav.ts` 条目与 `src/App.tsx` 中两条路由的注册；flag-off 构建不出现死链接，且动态 import 被 tree-shake，产物中不含任何 paper 代码。`nav.ts` 被 App 与 SelectionAsk 同源引用，门控一处即覆盖两个消费方。
- 路由采用 `React.lazy` + `Suspense`（本项目首个懒加载点），fallback 放在现有 per-route `ErrorBoundary` 内。
- 保留产品名 `LLM Infra Studio`，副标题调整为“AI 学习与实践工作台”；该文案与 flag 无关恒定应用，避免 dev/prod 构建文案分叉。

### 3.2 论文库

论文库提供拖放和文件选择两种导入方式。每个文档条目展示：

- 标题和原始文件名。
- PDF/DOCX 格式。
- 文件大小和页数或段落数。
- 导入、解析、索引或失败状态。
- 最近阅读时间和阅读进度。
- “预览”“启动 Copilot”“删除”操作。

列表支持按最近阅读、最近上传和标题排序，并按“全部、处理中、可阅读、失败”筛选。重复文件通过 SHA-256 检测，提示用户打开已有文档或替换导入。

### 3.3 阅读工作台

桌面端采用三栏结构：

1. 左侧：目录、论文地图和阅读进度。
2. 中间：论文正文预览，是主要阅读区域。
3. 右侧：可折叠的 Paper Copilot。

响应式规则：

- 桌面：三栏并存，目录和 Copilot 均可折叠。
- 平板：正文与 Copilot 双栏，目录进入抽屉。
- 手机：单栏阅读，目录使用抽屉，Copilot 使用底部面板或全屏模式。

阅读器行为：

- PDF 使用虚拟化页面、原始页面渲染和可选择文字层。
- DOCX 使用经过清洗的语义化只读视图。
- 保存页码、滚动位置、已读章节和最近选区。
- 点击引用后滚动到对应页或段落，并短暂高亮原文。
- 不能精确定位时，至少定位到正确页和章节。
- 用户圈选正文后显示“解释这段”“更简单”“推导公式”“举例”“加入提问”等快捷操作。
- **选区冲突机制**：Paper 工作区接管论文选区。落地方式为在 `SelectionAsk` 的 `pointerup`/`selectionchange` 处理器内按 `pathname.startsWith('/papers')` 早退（其已订阅路由变化；不挪用 `data-ask-ui`——该标记语义是“Ask 对话框自身 UI”）。附注：`SelectionAsk` 的 `pageLabel` 查表本就匹配不到 `/papers/:paperId`，排除路由后无副作用。

### 3.4 Copilot 主体验

首次启动 Copilot 时生成论文地图，包括：

- 一句话结论。
- 研究问题与背景。
- 核心贡献。
- 方法或系统管线。
- 理论、假设与关键公式。
- 算法步骤。
- 实验设计与主要结论。
- 局限、风险和开放问题。
- 阅读所需的前置知识。
- 推荐阅读路径。

Copilot 默认提供以下入口：

- 论文速览。
- 逐节精读。
- 方法拆解。
- 公式推导。
- 实验复盘。
- 批判性审阅。

用户也可以直接自由提问、圈选原文提问或使用语音提问。

## 4. 技术架构

### 4.1 Local-first 存储

使用 IndexedDB（Dexie 管理 schema、事务和迁移）保存：

- 原始文件字节与 MIME 类型（**以 `ArrayBuffer` + mime 字符串存储，不用 `Blob`**：node 环境可结构化克隆，`fake-indexeddb` 单测可覆盖仓储层）。
- 论文元数据。
- 结构化正文块和检索块。
- 论文地图和分析缓存。
- Copilot 会话与消息。
- 概念掌握状态。
- 阅读进度和界面偏好。

Zustand 只保存轻量 UI 状态，且 paper 专属 store 放在 `src/pages/papers/paperUiStore.ts`（懒加载树内）；**不得**并入 `src/store.ts`，否则其 import 链会进入首页主 chunk，违反 §11.4 的包体约束。

### 4.2 核心数据模型

- `PaperRecord`：论文元数据、文件 hash、类型、导入状态、阅读进度和 `parserVersion`（解析器升级后支持提示重建索引）。
- `PaperBlock`：规范化后的页、章节、段落、公式或代码块。
- `PaperChunk`：用于检索的语义文本块及其来源锚点。
- `SourceAnchor`：PDF 页码/文本位置或 DOCX 段落位置。
- `PaperBrief`：论文地图和分层摘要。
- `CopilotSession`：某篇论文的持久化陪读会话。
- `CopilotMessage`：用户、Agent 和结构化交互块消息。
- `LearnerConceptState`：按概念记录的掌握度、置信度和证据。
- `EvidenceRecord`：画像证据日志（概念、方向、权重、来源、时间）。
- `IngestionJob`：校验、解析、分块、索引和失败状态。
- `ModelPolicy`：按任务指定 provider、model、思考级别、结构化输出能力、token 预算和回退条件（客户端常量，见 §5.3）。
- `ProviderConsent`：分别记录 DeepSeek、Moonshot 和 Jina 的文档片段外发授权，不跨 provider 继承。
- `ModelUsageRecord`：记录模型、token、时延、状态、成本和是否为本地估算，不包含问题或论文正文。

### 4.3 可替换服务边界

建立以下接口，v1 使用浏览器本地实现，未来可以替换为服务端实现：

- `PaperRepository`：论文、会话、画像和阅读进度的持久化。
- `DocumentParser`：PDF/DOCX 到规范化正文的转换。
- `RetrievalService`：本地索引、检索和来源锚点返回。
- `PaperCopilotService`：上下文组装、Agent 编排、流式回答和画像更新。
- `ModelGateway`：执行 Paper 专属模型路由、provider 参数适配、usage/cost 归一化、重试、熔断、客户端令牌桶和授权检查（§5.2/§5.5）。

### 4.4 文档导入流水线

导入状态机：

> 文件校验 → 内容解析 → 结构规范化 → 语义分块 → 本地索引 → 生成可阅读记录

具体策略：

- PDF 使用 PDF.js Web Worker 解析页和文字层（worker 资产经 `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)` 由 Vite 独立发射，首次解析才加载）。
- DOCX 使用 Mammoth 解析，产出 HTML 经 DOMPurify 白名单清洗。
- 解析器和预览器动态导入，不进入首页 bundle。
- **同一时刻只解析一个文档**（串行队列），避免多 Worker 内存叠加。
- 按章节和语义边界分块，目标约 1,200 tokens，15% 重叠；token 以 `chars/3` 中英混合粗估（本地无 tokenizer，估算值全链路标注）。
- 每个块保留章节、页码、顺序和相邻关系。
- 使用 `Intl.Segmenter` 做中英文兼容分词，并构建本地 BM25 索引。
- 检索综合问题关键词、章节标题、当前阅读位置、用户选区和论文地图。
- 本地 BM25 是始终可用的基础召回；敏感/未公开论文默认只使用该路径。
- 在用户单独授权 Jina 后，可用 `jina-embeddings-v5-text-small` 建立本地保存的语义向量，并与 BM25 合并召回 top 20；歧义或跨章节问题再用 `jina-reranker-v3.5` 重排到 top 6。
- Jina 只接收当前任务所需的文本 chunk，不接收原文件、文件名、本地路径、用户标识或学习画像；Jina 失败时无感降级到 BM25，不阻断阅读和基础问答。
- 不引入独立向量数据库；远程 embedding/rerank 未通过质量、延迟和隐私门槛前保持关闭。

### 4.5 文件约束与失败处理

默认约束：

- 单文件最大 50 MB。
- PDF 最大 500 页。
- 抽取正文最大 200 万字符。
- 支持 PDF 和 DOCX；拒绝 `.doc` 和其他格式。

联合校验扩展名、MIME 和 magic bytes。对于加密、损坏、纯扫描、超限或解压后体积异常的文档，展示明确失败原因并允许删除或重试，不静默产生空论文。

IndexedDB 配额不足时停止当前写入并保护已有数据（导入前调用 `navigator.storage.estimate()` 预检，并请求 `navigator.storage.persist()`）。删除论文时，通过事务清除原文件、正文、索引、论文地图、会话、学习画像和阅读进度。

### 4.6 模块与文件布局

```
src/pages/papers/PapersPage.tsx           # 论文库（lazy 根 A）
src/pages/papers/PaperWorkbenchPage.tsx   # /papers/:paperId 三栏工作台（lazy 根 B）
src/pages/papers/paperUiStore.ts          # paper 专属 zustand（不进 src/store.ts）
src/components/papers/                    # ImportDropzone PaperList PdfViewer DocxViewer OutlinePane
                                          # CopilotPanel CopilotMessage CiteBadge PlanChip
                                          # ConsentDialog CostConfirm
                                          # blocks/（每个 CopilotBlock 一个固定组件 + BlockSkeleton + BlockFallback）
src/lib/paper/                            # 纯函数引擎，均带 .test.ts 兄弟文件：
  providerAdapters.ts   # buildChatBody：DS/Kimi 参数差异全在此（契约测试重点）
  modelGateway.ts       # streamPaperChat/completePaperJson、重试/熔断/令牌桶、usage/cost
  stream.ts             # paper 专属 SSE 流（捕获 usage 帧）
  streamParser.ts       # splitCopilotStream：围栏岛 + citeToken 增量解析
  blockSchemas.ts       # 全部岛类型手写校验器（grading.ts parseScoreJson 风格，不引 zod）
  citations.ts          # 白名单/CiteMap、存在性校验、词面支持启发式
  contextBuilder.ts     # assembleContext、预算裁剪阶梯
  summarizer.ts         # memo 岛触发与滚动摘要折叠
  briefPipeline.ts      # 论文地图分单元/节流队列/断点续跑编排
  learnerProfile.ts     # 证据日志、mastery/confidence 更新规则
  turnEngine.ts         # 每轮编排 reducer + sessionRef 代数/abort 所有权（照搬 SelectionAsk 模式）
  chunking.ts bm25.ts hybrid.ts anchors.ts ingest.ts sanitize.ts usage.ts
  repo/db.ts repo/paperRepo.ts            # Dexie schema 与仓储（fake-indexeddb 测试）
  fixtures/                               # 录制的请求/响应 fixtures（.ts 导出）
src/data/paperPolicy.ts                   # ModelPolicy 类型化常量（模型 ID、能力、预算、价格，带 sourceUrl/asOf）
```

既有文件仅 3 处**加法式**修改，公开行为不变：

1. `src/lib/liteMd.ts`：`Seg` 的 code 变体增加 `closed: boolean`（闭合围栏 true / EOF false；`AskDialog` 不读该字段）。
2. `src/lib/sse.ts`：新增纯函数 `extractStreamUsage(data)`（识别 choices 为空 + `usage` 字段的尾帧）。
3. `src/lib/llmClient.ts`：内部抽取 `runSseChat` 核心（双段超时、[DONE] 主动断连、整包 JSON 兜底、Abort 半截返回、releaseLock 容错）；`chatComplete/chatStream` 变薄壳，**签名与行为不变**（现有测试全绿即回归证明），SelectionAsk 与 InterviewPage 无感。

### 4.7 依赖与 bundle 预算

| 依赖 | 约 min/gz | 放置 |
|---|---|---|
| dexie | ~90KB / ~27KB | paper 路由共享 chunk |
| pdfjs-dist 主库 | ~340KB / ~110KB | PDF 预览 chunk，首次打开 PDF 动态 import |
| pdfjs-dist worker | ~1.05MB / ~330KB | 独立发射资产（非 JS chunk），解析时才拉取 |
| mammoth | ~680KB / ~190KB | DOCX 导入路径内动态 import |
| dompurify | ~22KB / ~9KB | DOCX 预览 chunk（不手写 HTML 清洗） |
| react-markdown + remark-gfm + remark-math + rehype-katex | 合计 ~150KB / ~50KB | Copilot 面板 chunk |
| katex（JS+CSS+按需字体） | ~277KB / ~78KB JS + 23KB CSS + 实际拉取 ~60–120KB 字体 | Copilot 面板 chunk |
| fake-indexeddb、happy-dom | dev-only | 0 运行时 |

**预算规则**：现有首页主 chunk（基线 `dist/assets/index-*.js` ≈ 953KB）不得可感增长——每阶段收尾用构建前后 `dist/assets` 对照人工核验。**从 `src/main.tsx`/`src/store.ts`/`src/nav.ts`/`src/App.tsx` 静态可达的模块，禁止 import `src/lib/paper/`、`src/pages/papers/` 或上表任何依赖**（type-only import 除外）。

## 5. 模型选择与路由策略

### 5.1 已验证配置与选型结论

截至 2026-08-12，`.env.local` 已配置且通过只读 API 探测的候选为：

- `deepseek-v4-pro`：可通过 DeepSeek Chat Completions 调用，支持 1M context、流式输出、可开关思考模式和 JSON Object。官方说明见 [DeepSeek V4 发布说明](https://api-docs.deepseek.com/news/news260424)、[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) 和 [JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。
- `kimi-k3`：支持 1M context、流式输出、`low/high/max` reasoning effort 及 strict JSON Schema；思考模式不可关闭。官方说明见 [Kimi K3 Quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)。
- `jina-reranker-v3.5`：当前 key 可调用并能正确重排中英文候选；`jina-embeddings-v5-text-small` 支持多语言、32K 输入和 retrieval adapter。官方说明见 [Jina Embeddings v5 Text Small](https://jina.ai/models/jina-embeddings-v5-text-small/) 和 [Jina Reranker v3.5](https://jina.ai/models/jina-reranker-v3.5/)。

本次只读烟雾测试中，两种生成模型均返回合法结构化 JSON，Jina 也成功返回排序。极小请求的观测延迟约为 DeepSeek 1.7–2.3 秒、Kimi 4.7–9.8 秒、Jina rerank 1.6 秒；这些数字只证明当前账户和网络可用，不能代替正式性能基准。

最终分工：

| 任务 | 默认模型/服务 | 模式 | 选择理由 |
|---|---|---|---|
| 普通提问、选段解释、追问、难度适配 | `deepseek-v4-pro` | thinking disabled，流式 | 高频、低延迟、成本明显更低 |
| 公式推导、跨章节综合、批判性审阅 | `deepseek-v4-pro` | thinking enabled，effort high，流式 | 只在复杂任务承担推理延迟 |
| `TutorPlan`、画像更新等高频小结构 | `deepseek-v4-pro` | 流内结构岛（§7），JSON 本地校验 | 不再引入独立结构化调用与第二家模型延迟 |
| 首次 `PaperBrief`、复杂 `CopilotBlock` | 先 DeepSeek；失败或质量不达标时 `kimi-k3` | Kimi 使用 strict JSON Schema、effort low | Kimi 的严格 schema 适合少量高价值结构化任务 |
| 用户显式选择“换一种深度解释” | `kimi-k3` | effort high；超预算前确认 | 提供独立模型视角，而非默认双模型消耗 |
| DeepSeek 技术故障回退 | `kimi-k3` | 仅在已有 Moonshot 授权时执行 | 保持可用性，同时避免静默跨厂商外发 |
| 基础检索 | 本地 BM25 | 离线 | 免费、私密、始终可用 |
| 语义召回/重排增强 | Jina v5 small + reranker v3.5 | 明示开启 | 仅在评测证明质量收益时启用 |

不在生产请求中并行调用 DeepSeek 与 Kimi。双模型 fan-out 只允许用于公开论文、脱敏提示的离线评测。

### 5.2 模型专属调用契约与 Gateway 落地

现有 `chatComplete/chatStream` 的统一 body 不足以支撑上述模型（body 硬编码 `temperature: 0.7`、无 thinking/response_format/max_tokens/stream_options，且 usage 尾帧被 `extractStreamDelta` 的空 choices 守卫丢弃——`llmClient.test.ts` 对此有断言）。**不修改共享函数的公开签名**（SelectionAsk 与 InterviewPage 是活调用方），落地方式见 §4.6 的三处加法式修改 + 新建 `src/lib/paper/modelGateway.ts`。要点：

- `ModelCapability` 明确结构化能力（`json_object` | `json_schema_strict`）、thinking（toggle | always+efforts）、采样（tunable | fixed）、最大输出参数名（`max_tokens` | `max_completion_tokens`）、`streamUsage`、usage 格式与价格，替代单一的 `supportsJsonMode: boolean`。
- DeepSeek 普通问答显式发送 `thinking: disabled`；深度任务才发送 `thinking: enabled` 与 `reasoning_effort: high`；流式 usage 需请求体带 `stream_options: { include_usage: true }`。
- `delta.reasoning_content` 归类为 reasoning 事件：只驱动 UI“正在分析”滴答并为帧间空闲计时器续期，**绝不并入正文、不写入日志或 IndexedDB**。
- DeepSeek JSON mode 按官方要求在 prompt 中明确 JSON、设置合理输出上限，并做本地 schema 校验；空 content 或坏结构时同模型修复一次，再考虑 Kimi。
- Kimi K3 始终思考：普通结构任务 `reasoning_effort: low`，深度升级 `high`；设置 `max_completion_tokens`，并省略其固定的 `temperature/top_p/presence_penalty/frequency_penalty`（当前统一 `temperature: 0.7` 会导致 400）。
- Kimi 的结构任务使用 `response_format: json_schema`、`strict: true`。v1 将 Kimi 限制为单次结构任务或独立深度回答，不建立依赖 `reasoning_content` 的原生多轮链路。
- Paper 请求继续使用 Chat Completions；在官方尚未确认 `deepseek-v4-pro` 的 Responses API 完整支持前不迁移。
- 流式结果统一返回 `{ text, provider, model, inputTokens, outputTokens, estimated, cost }`；provider 未返回 usage 时才本地估算（chars/3），并在 UI 标记“估算”。

TS 接口草图（实现随 Phase 3 落地）：

```ts
// src/data/paperPolicy.ts
export type PaperProviderId = 'deepseek' | 'kimi'
export interface ModelCapability {
  provider: PaperProviderId
  model: string
  proxyPrefix: '/api/deepseek' | '/api/moonshot'   // 复用既有代理路由
  chatPath: string
  structured: 'json_object' | 'json_schema_strict'
  thinking: { kind: 'toggle'; defaultOn: false }
          | { kind: 'always'; efforts: readonly ['low', 'high', 'max'] }
  sampling: 'tunable' | 'fixed'          // fixed → 禁发 temperature/top_p/presence/frequency
  maxOutputParam: 'max_tokens' | 'max_completion_tokens'
  streamUsage: boolean
  pricing: { inPerMTok: number; outPerMTok: number; sourceUrl: string; asOf: string }
}
export interface PaperCallSpec {
  cap: ModelCapability
  thinking: 'off' | 'on-high' | 'effort-low' | 'effort-high'
  responseFormat?: { type: 'json_object' } | { type: 'json_schema'; name: string; schema: object }
  maxOutputTokens: number                // 1500 普通 / 3000 深度 / brief 单配
}

// src/lib/paper/providerAdapters.ts —— 纯函数，契约测试重点
export function buildChatBody(spec: PaperCallSpec, messages: ChatMessage[], stream: boolean): Record<string, unknown>

// src/lib/paper/modelGateway.ts
export interface GatewayUsage { provider: PaperProviderId; model: string; inputTokens: number; outputTokens: number; estimated: boolean; cost: number }
export function streamPaperChat(req: { spec: PaperCallSpec; messages: ChatMessage[]; signal?: AbortSignal; onDelta(d: string): void; onReasoningTick?(): void }): Promise<GatewayUsage & { text: string; aborted: boolean }>
export function completePaperJson(req: { spec: PaperCallSpec; messages: ChatMessage[] }): Promise<GatewayUsage & { raw: string }>
```

### 5.3 配置：客户端常量 + 代理接线

**修正（v2）**：静态 SPA 没有运行时读取服务端 env 的通道（无 `VITE_` 前缀的变量只存在于 dev-proxy/nginx 进程中），v1 草案中“ModelPolicy 读取已校验的服务端配置”不可实现。定稿：

- **模型 ID、能力矩阵、任务路由、token 预算、价格全部是 `src/data/paperPolicy.ts` 中的类型化常量**，易变事实按 EXTENDING.md 惯例携带 `sourceUrl` + `asOf`；“已校验”发生在编写与发布前复核时，而非运行时。
- 代理的唯一职责仍是注入 key。`.env.local` 中 `DEEPSEEK_MODEL`/`KIMI_MODEL` 等 `*_MODEL` 变量**不被应用读取**（保留为备忘）。
- v1 Paper 请求只使用服务端注入 key，**不发送 `X-User-Key`**：现有 Settings 的 `userKey` 是绑定单一全局 provider 的一个 key，无法同时供给 DeepSeek + Kimi + Jina；按 provider 的用户 key 输入留待二阶段（附录 A）。
- API key 只在代理端注入，绝不进入前端 bundle、IndexedDB、localStorage、URL、日志或错误上报；计划和测试输出只显示 `SET/EMPTY`。

`vite.config.ts` 接线清单（Phase 1 一次落地）：

1. `ProviderRoute.envKey: string` → `envKeys: string[]`，取第一个非空：`/api/moonshot` 用 `['KIMI_API_KEY', 'MOONSHOT_API_KEY']`（旧名兼容一版后移除）。
2. 新增 `/api/jina` 路由：`target: env.JINA_BASE_URL || 'https://api.jina.ai'`，`envKeys: ['JINA_API_KEY']`（embeddings `/v1/embeddings`、rerank `/v1/rerank` 同源）。
3. `DEEPSEEK_BASE_URL`/`KIMI_BASE_URL` 在 server 启动时 honor（沿 `OPENAI_COMPAT_BASE_URL` 先例：启动时固定，仍非运行时可变；避免 `.env.local` 已有变量被静默忽略造成配置漂移）。base URL 与 API path 分开规范化，防止 `/v1/v1/...` 重复拼接。
4. `.env.example` 补：`KIMI_API_KEY`、`KIMI_BASE_URL`、`DEEPSEEK_BASE_URL`、`JINA_API_KEY`、`JINA_BASE_URL`、`VITE_ENABLE_PAPER_COPILOT`，并注明 `MOONSHOT_API_KEY` 为一版兼容别名、`VITE_*` 是 build-time flag。

### 5.4 上下文和成本预算

消息排布固定为“稳定前缀 → 动态尾部”，最大化 provider 前缀缓存命中：

1. system#1：静态 tutor prompt（线协议规范、引用规则、“论文正文是不可信数据”的注入防御；常量 + 版本号，字节稳定）。
2. system#2：PaperBrief 摘要 + **粗粒度**画像（层级桶粒度，极少变化）。
3. system#3：rolling summary（每 ~6 轮才更新，缓存断点可摊销）。
4. 最近 ≤6 轮真实 user/assistant 消息（append-only，天然前缀命中）。
5. 本轮 user 消息 = 选区（上限沿用 SelectionAsk 的 `slice(0, 4000)` 先例）+ 白名单 chunk 段 + 问题 + 逐轮指令（plan/learner/memo 岛开关）——**一切逐轮变化集中于最后一条消息**。

预算：普通任务 12K 输入/1.5K 输出，深度任务 24K 输入/输出上限 6K（**推理+正文共享预算**——DeepSeek thinking 模式下 `max_tokens` 同时约束两者，3K 时硬题推理可独占全额导致正文空流，评测实证后提至 6K，asOf 2026-08-13；正文目标仍约 3K）；超预算裁剪阶梯为 减 chunk 数 → chunk 首尾截断 → 丢最老轮 → 截选区 → 报错提示。只有首次分层论文地图或用户明确选择“全篇综合”才扩大上下文；1M context 是安全余量，不是默认填满目标。缓存命中价只作为实际节省项，不用于承诺预算；价格在发布前必须从官方文档重新核验。

按 2026-08-12 官方未缓存价格估算：[DeepSeek 价格](https://api-docs.deepseek.com/quick_start/pricing/) 为输入 `$0.435/MTok`、输出 `$0.87/MTok`；[Kimi K3 价格](https://platform.kimi.ai/docs/pricing/chat-k3) 为输入 `$3/MTok`、输出 `$15/MTok`。

| 场景 | Token 上限 | DeepSeek 估算 | Kimi 估算 |
|---|---:|---:|---:|
| 普通问答 | 12K 输入 + 1.5K 输出 | `$0.0065` | `$0.0585` |
| 深度推导 | 24K 输入 + 6K 输出上限（推理+正文共享） | `$0.0157` | `$0.1620` |
| 100K-token 论文地图 | 总输入 ≤160K、输出 ≤8K | `$0.0766` | `$0.6000` |

单轮预计超过 DeepSeek `$0.02` 或 Kimi `$0.15`、论文地图预计超过 DeepSeek `$0.10` 或 Kimi `$0.75` 时，UI 必须展示 provider、预算和原因并二次确认。页面显示本轮预估、实际 token 和当前会话累计成本。

### 5.5 重试、降级与跨厂商回退

实现位置统一在 `modelGateway`（llmClient 不背策略）：

- 401/403、无 key、配额或账户错误：不自动重试、不切 provider，提示用户处理配置。
- 429：尊重 `Retry-After`；缺少该头时使用抖动退避并最多重试一次。
- 5xx、网络错误或首字节超时：只有在尚未显示正文 token 时才自动重试一次；已有部分回答则保留并标记“响应中断”。
- 上下文超限：先缩小 top-k、压缩历史或摘要，再用同模型重试一次，不靠换 provider 掩盖错误。
- 结构化输出失败：同模型修复一次；若用户已授权 Moonshot，再切 Kimi strict schema；否则降级为纯文本。
- 引用校验失败：扩大本地召回后重试一次；仍失败则删除无证据断言并显示“论文中证据不足”。
- **深度轮空流专项**：thinking on-high 下正文零 token 即结束（推理耗尽输出预算）时，不做同参重试（必然复现），而是关闭思考降级重试一次；成功回答带 `thinkingDowngraded` 标记，UI 标注「已降级为快速模式」。
- 同一 provider 连续 3 次技术失败后本地熔断 5 分钟。
- DeepSeek → Kimi 的回退必须已有独立 Moonshot 授权；否则只展示检索到的原文和引用，并提供手动重试，不生成猜测性回答。
- **客户端令牌桶**：gateway 内置与生产 nginx 同参的节流（6 次/分钟、burst 3），论文地图任务与对话轮共享额度、排队而非撞 429；本地 dev 无限流时该桶仍生效，保证行为与未来生产一致。桶与真实 nginx 计数可能漂移，429 处理路径仍为兜底。

## 6. 自适应陪读 Agent

### 6.1 每轮调用拓扑（v2 定稿）

原“检索 → 生成 TutorPlan → 流式讲解 → 校验引用 → 理解检查 → 更新画像”仍是逻辑工作流，但**物理上合并为每轮 1 次 LLM 调用**：TutorPlan 以流内 `copilot:plan` 微岛承载，画像信号以 `copilot:learner` 尾岛承载（§7）。确定性控制流（引导模式步序、判分、层级映射）留在客户端——延续 `grading.ts`“模型只产出声明式数据，最终决策留客户端”的原则。

| 交互类型 | LLM 调用/轮 | 模型/模式 |
|---|---|---|
| (a) 自由问答 / 追问 | **1** | deepseek-v4-pro，thinking off，流式；流内 ≤80 token `plan` 微岛 + prose/展示块 + 可选 `learner` 尾岛 |
| (b) 选段快捷（解释这段/更简单/推导/举例） | **1** | 同上但**无 plan 岛**——意图由按钮完全确定，客户端模板直出，TTFT 最快 |
| (c) 引导模式每步（速览/精读/拆解/推导/复盘/审阅） | **1/步** | 普通步 thinking off；公式推导、批判性审阅、跨章节综合步 thinking on + effort high（豁免 TTFT 4s 线，reasoning 事件驱动“正在分析”提示）；步序是客户端状态机，plan 岛放宽至 ~200 token |
| (d) 首次 PaperBrief | 短文 **1**；长文 **U + 1**（U ≤ 10 摘要单元） | 异步任务而非对话轮：json_object + 本地校验；burst 3 先发，其后 ≥10s/个节流；单元 digest 按 `(fileHash, unitId, model, promptVersion)` 缓存、可中断续跑；失败且已授权 → kimi-k3 strict schema 兜底。最坏 11 调用 ≈ 100s 出全图，在 P95 ≤180s 门槛内且持续显示进度 |
| (e) quiz 单选/多选、闪卡自评 | **0** | 答案键 + 解析随块 JSON 下发，本地判分，画像本地更新 |
| (e') teach-back / 简答判 | **1** | DeepSeek 流式，prose 反馈 + `copilot:verdict` 尾岛（遗漏点/掌握证据） |
| 有界重试（仅两处） | +1 | ① `evidence` 岛自报证据不足 → 扩检索同模型重试一次；② 独立结构任务（brief digest/synthesis/画像巩固）JSON 坏 → 同模型修复一次。流内岛坏一律降级、不重试 |

plan 岛的位置（领跑或尾置）是 prompt 旋钮而非架构决策：领跑可作为首个有意义渲染（层级 chip）并起轻量 chain-of-thought 作用；若实测 prose TTFT 破线，把指令改为尾置即可，零代码改动。(b) 类永远无 plan。

### 6.2 自适应原则

学习画像按概念而不是笼统的“用户智力”建模。证据来自：

- 问题使用的术语和抽象程度。
- 对先前概念的引用是否准确。
- 测验和 Teach-back 复述结果。
- 用户主动选择“太浅、刚好、太深”。
- 用户是否反复请求简化或推导。

讲解层次：

- 入门：直觉、术语、类比和简单例子。
- 进阶：公式、算法步骤、设计选择和权衡。
- 研究：假设、证明思路、实验有效性、失败模式和相关方法差异。

**画像更新三层机制（0 阻塞调用）**：

- L1 本地确定性（每轮）：quiz 判分、“更简单/推导”按钮使用、显式 太浅/刚好/太深、追问抽象度 → 追加 `EvidenceRecord { conceptIds, dir, weight, ts, source }`。
- L2 流尾 `copilot:learner` 岛（同一调用，≤80 token）：模型自报概念信号，作为**一条弱证据**参与；校验 + 钳位，坏则忽略。
- L3 定期巩固（可选，feature flag）：每 10 轮或会话结束 1 次 JSON 调用，把证据日志整理为叙事性画像；跳过不影响层级选择。

更新规则（`learnerProfile.ts` 纯函数）：mastery ∈ [0,1] 小步更新，单事件 |Δ| ≤ 0.08；**跨层级调整需 ≥2 条独立同向证据**（落实“单次弱信号不得永久改变画像”）；confidence = 证据一致性 × 数量饱和 × 时间衰减；用户显式 pinnedLevel 永远优先并冻结自动调层（证据照记）。UI 明确展示当前层级，可随时修改或重置。

### 6.3 上下文控制与论文地图管线

- 每轮只发送检索命中的原文片段、必要摘要、当前选区和最近对话；消息排布见 §5.4。
- 会话保留最近 6 轮原始消息，其余压缩为滚动摘要。**滚动摘要搭车计算（0 额外调用）**：`turnsSinceMemo ≥ 6` 时，本轮末尾指令要求输出 `copilot:memo` 尾岛（≤150 token）总结即将滑出窗口的旧轮；客户端存为新 summary 并裁掉旧轮；模型漏发/坏岛 → 本地降级（直接丢弃旧轮 + 一行占位说明），下轮再试。
- 不把整篇论文在每轮对话中反复发送。
- 首次论文地图采用分层管线：sectionizer 把 `PaperBlock` 聚成 ≤10 个摘要单元（小节合并，超 ~20K token 再切）→ 逐单元 JSON 摘要（节流队列见 §6.1d）→ 1 次全文综合 → `PaperBrief`。进度 = 完成单元/总数；刷新或中断后从缓存续跑；单元二次失败标“未摘要”，综合时显式带缺口。
- 分析缓存键包含文件 hash、provider、model 和 prompt version。
- 初次需要向模型发送论文内容时，明确显示 provider、预计发送范围、token/成本上限，并取得该 provider 的独立同意。
- 分析失败不影响本地预览和全文搜索。

## 7. 结构化交互系统（流式线协议与渲染）

### 7.1 线协议语法

选“围栏岛”而非 XML 标签：`liteMd.splitFences` 已按行识别 ``` 围栏且未闭合围栏按 code 渲染到文末——流式中的半截岛免费获得占位挂载点；模型对“info-string + 围栏”的产出可靠性远高于自造记号；协议整体失效的最坏情形 = 原样按代码块显示，优雅退化。

```
stream     := ( prose | island )*
island     := '```copilot:' TYPE '\n' RAW_JSON '\n' '```'
TYPE       := explanation | formula | stepper | comparison | concept-map | flow
            | timeline | quiz | flashcard | teach-back          # 展示块
            | plan | learner | memo | evidence | verdict         # 控制岛（chip 或不可见）
RAW_JSON   := 单个 JSON object；原文 ≤8KB；块内引用走 JSON 字段 "cites": ["c3"]
prose      := markdown（可含普通 ```lang 代码块与 citeToken）
citeToken  := '[[cite:' ID ']]'      ID := /^c\d{1,3}$/   # 本轮白名单别名
```

容错：info-string 用 `/^copilot[:\-\s]+([a-z-]+)\s*$/i` 匹配；JSON 提取沿用 `parseScoreJson` 的 首个`{`…末个`}` 切片法。

### 7.2 展示块与控制岛

展示块（对应 v1 的 `CopilotBlock` 联合类型，全部由固定 React/DOM/SVG 组件渲染，模型只提供声明式数据，不能返回可执行 HTML、脚本或任意 SVG）：

- `explanation`：分层文本讲解。
- `formula`：公式 LaTeX 表达式、每项含义和逐步推导（KaTeX 渲染）。
- `stepper`：算法或方法的逐步执行过程。
- `comparison`：方法、实验或概念对比表。
- `concept-map`：概念关系图（节点 ≤12、边 ≤24，超限降级为列表）。
- `flow`：方法或数据流线框图（同上限）。
- `timeline`：论文脉络或算法阶段时间线。
- `quiz`：单选、多选或简答理解检查（答案键随块下发，本地判分）。
- `flashcard`：术语与关键知识卡片。
- `teach-back`：要求用户用自己的话解释，并由 Agent 反馈遗漏。

控制岛（不渲染为内容或仅渲染为 chip）：`plan`（本轮概念/层级/策略/拟用块）、`learner`（画像弱证据）、`memo`（滚动摘要）、`evidence`（证据不足自报）、`verdict`（teach-back 判定）。

### 7.3 样例

样例 A（选段快捷，无 plan）：

`````text
这段在讲 KV cache 的显存占用 [[cite:c2]]。核心结论：显存随上下文长度线性增长。

```copilot:formula
{"expr":"2 \\cdot n_{layers} \\cdot n_{kv} \\cdot d_{head} \\cdot L \\cdot bytes","terms":[{"sym":"2","mean":"K 与 V 各存一份"},{"sym":"L","mean":"上下文长度"}],"cites":["c2"]}
```

其中系数 2 来自 K 与 V 各存一份 [[cite:c2]]。
`````

样例 B（引导步，plan + quiz + learner 尾岛）：

`````text
```copilot:plan
{"concepts":["kv-cache"],"level":"进阶","strategy":"先直觉后公式","blocks":["quiz"]}
```
本步回答“为什么长上下文贵”…… [[cite:c1]] 论文在 §3.2 给出测量 [[cite:c4]]。

```copilot:quiz
{"kind":"single","stem":"KV cache 大小与哪个量成正比？","options":["层数的平方","上下文长度","词表大小"],"answer":1,"why":"每 token 每层各存一份 K/V","cites":["c4"],"concept":"kv-cache"}
```

```copilot:learner
{"signals":[{"concept":"kv-cache","dir":1,"evidence":"主动追问了分页注意力"}]}
```
`````

### 7.4 增量解析

- `liteMd.ts` 的 code 段增加 `closed: boolean`（见 §4.6），其上新建纯函数 `streamParser.ts`：

```
splitCopilotStream(src): CopilotSeg[]
  splitFences(src) 后逐段映射：
  - code 段 lang 命中 copilot 模式 → island 段（closed 时提取 JSON → blockSchemas 校验 → block | error）
  - 其他 code 段直通
  - text 段扫描 citeToken → prose 段（供渲染层做 cite 替换）；
    行尾残缺 '[[cite:…' 暂时抑制显示，下个 delta 自然补全（无闪烁）
```

- 每 delta 对累计全文重扫（沿用 `AskDialog` 模式），但流是 append-only：已定型段按前缀长度记忆化，只重算开放尾段；React key 用岛序号，quiz 选中态等本地 state 稳定。
- 流中 EOF：尾段为未闭合 island → `BlockSkeleton`（类型标签 + 定高 shimmer，防布局跳动）；未闭合普通 code → 现行代码样式。
- finalize（流结束/Stop/超时）：仍未闭合的 island → `BlockFallback` 降级卡（半截 JSON 收进 details）——与 SelectionAsk“Stop 保留半截”语义一致；prose 完整保留。

### 7.5 校验与降级矩阵

校验器为 `blockSchemas.ts` **手写校验器**（`grading.ts` 风格：逐字段守卫、钳位、数组长度上限），不引入 zod（仓库零运行时校验依赖，纯函数可在 node 环境直接单测）。

| 情形 | 处理 | 周围 prose |
|---|---|---|
| 闭合岛 JSON 解析失败 | 不重试；`BlockFallback` 折叠卡「交互块解析失败」，展开见原文 | 不受影响 |
| 校验失败（字段缺/越界） | 先宽松修复（钳位/剔坏项），仍失败 → 降级卡 | 不受影响 |
| 未知 TYPE | 降级卡「未知交互类型」+ 计数 | 不受影响 |
| 岛原文 >8KB | 截断降级 | 不受影响 |
| Stop/流结束时岛未闭合 | finalize 转降级卡 | 保留 |
| cite ID 不在白名单 | 灰色不可点 ⚠ 徽章 + 本轮页脚「部分引用无法定位」 | 保留原句 |
| JSON 字符串内出现 ``` 导致围栏早闭 | 早闭 → JSON 坏 → 降级卡；泄漏尾按 prose 渲染，计数观察 | 少量杂讯可接受 |
| plan/learner/memo 岛坏 | 静默忽略（advisory）：无 chip / 画像退回本地启发式 | 不受影响 |
| `evidence` 岛 status=insufficient | 扩检索重试一次（唯一自动二次调用），再失败 →「证据不足」+ 检索原文摘录 | — |

### 7.6 渲染管线（v2 决策：完整 Markdown 管线）

- Copilot 消息的 prose 段用 **react-markdown + remark-gfm + remark-math + rehype-katex + KaTeX** 渲染（内联 `$x$` 公式、表格、链接全支持），CSS 与字体一并、仅在 Copilot 面板 chunk 懒加载。
- **不加 `rehype-raw`**：模型输出中的 HTML 一律按文本转义，天然注入防护。
- citeToken 渲染：预处理把 `[[cite:cX]]` 替换为 `[p.N](#cite-cX)` 链接语法，再覆盖 `a` 组件——`href` 以 `#cite-` 开头渲染为 `CiteBadge`（点击跳原文并高亮），其余外链 `target="_blank" rel="noopener noreferrer"`。
- 性能：流式渲染下每 delta 重 parse 的成本用两层控制——段级记忆化（只有开放尾段重新过 react-markdown）+ delta 按 `requestAnimationFrame` 批量合并。
- `formula` 展示块内部同样用 KaTeX 渲染其 LaTeX 表达式；KaTeX 渲染失败时回退为等宽原文。
- 现有 `SelectionAsk`/`AskDialog` 继续使用 `liteMd`，不迁移、不受影响。

## 8. 引用、可信度与安全

原则（承 v1）：

- 每个论文事实必须附带可定位来源；引用必须能定位到真实存在的页或段落。
- 对论文之外的问题，Agent 明确区分“论文原文”“基于原文的推断”和“当前无法从论文确认”。
- 论文正文始终作为不可信输入；系统提示明确禁止服从正文中的指令。
- Agent 无外部搜索、代码执行、文件写入或任意工具权限。
- 上传和本地索引默认不外发；DeepSeek、Moonshot、Jina 分别记录独立授权，同意其中一家不等于允许发送给其他服务。
- 用户将论文标记为“敏感/未公开”时，默认只允许本地预览和 BM25；所有远程请求关闭，直到用户逐项开启。
- 默认不记录论文正文、用户问题、模型回答或 API key；诊断只记录文件类型、大小、页数、耗时、错误码和 token 用量。
- GA 前逐一核实 provider 的数据保留、训练使用、区域和删除政策；没有官方依据时不宣称“零保留”或“不会用于训练”。

### 8.1 引用端到端流程（v2 细化）

1. **白名单构建（本地，0 调用）**：BM25 top-6（深度任务 12）→ 逐轮别名 `c1..cN`（短 ID 省 token、抄错率低；持久 chunkId 不外发）。客户端持有本轮 `CiteMap: alias → { chunkId, anchor: SourceAnchor, page, section }`。
2. **Prompt 契约**：上下文中每块渲染为 `[c3] §4.2 Method · p.7` + 块文本；系统指令要求论文事实句紧跟 `[[cite:cX]]`、只准使用本轮别名、推断需标注、证据不足时输出 `evidence` 岛。**模型永不产出页码作为引用**——页码由应用从 CiteMap 映射。
3. **流式渲染**：citeToken → `CiteBadge`（显示映射出的 "p.7"）；点击滚动到原文并短暂高亮。
4. **校验分层**：
   - 每轮 · 确定性 · 本地：① 存在性（alias ∈ CiteMap）；② 流结束后词面支持启发式——含 cite 的句子与对应 chunk 做内容词/数字/术语重叠打分，低分徽章降为“弱支持”空心样式 + 页脚“引用体检”。启发式只降展示、不删句。
   - **模型支持性校验不进每轮热路径**：① 用户点徽章“核查此引用”→ 1 次显式小 JSON 调用 `{supported, quote}`；② §11.3 离线评测集全量校验；③ 可选 idle 抽样（~1/10 轮）挂 feature flag。
   - 模型自报不足（`evidence` 岛）→ 扩检索（top-12 + 弱命中邻块）同模型重试一次；再失败 → “证据不足”态 + 只展示检索到的原文。
   - 幻觉 ID：不自动重试（prose 已流出且有用），灰徽章 + 计数；“虚构引用 = 0”靠评测收紧 prompt 达成，而非运行时补救。

## 9. 语音设计

- 复用现有 `src/lib/speech.ts`（Web Speech API）支持中文和英文语音提问。
- 新增浏览器 `speechSynthesis` 封装，支持朗读、暂停、继续和停止。
- 流式回答按完整句子排队朗读，停止生成时同时停止未朗读内容；朗读跳过代码块与结构岛，只读 prose 与讲解文本。
- 不生成、不上传、不保存音频文件。
- 浏览器不支持语音能力时，自动降级为文本输入和屏幕阅读器可读文本。

## 10. 实施顺序

每个 Phase 的退出门 = `npm run typecheck && npx vitest run && npm run build` + dist 主 chunk 尺寸对照；带 UI 的 Phase 另加 claude-in-chrome QA 子代理浏览器回归（循环至 0 P0/P1）。

### Phase 1：基础设施与论文库纵切

- 新增 Paper 路由、「论文陪读」导航与路由级懒加载；`VITE_ENABLE_PAPER_COPILOT` 双门控（§3.1）；副标题调整。
- `vite.config.ts` 接线一次落地（§5.3 清单：envKeys 数组 / `/api/jina` / BASE_URL honor / `.env.example`）。
- 一次性安装全部新依赖（运行时 + dev，见 §4.7），锁定 lockfile。
- 建立数据模型、Dexie schema 与 repository（ArrayBuffer 存储）、schema migration。
- 实现文件校验（扩展名 + MIME + magic bytes + SHA-256 去重）、PDF/DOCX Worker 解析与导入状态机（串行队列）。
- 交付论文列表、失败重试和级联删除。
- 完成一个 PDF 与一个 DOCX 的“上传 → 列表 → 预览（简版）”纵向闭环。

### Phase 2：阅读器与检索

- PDF 虚拟化预览（原始页面渲染 + 文字层）与 DOCX 语义化预览（DOMPurify 清洗）。
- 目录、阅读位置恢复和选区快捷操作。
- 分块、BM25 索引、检索与来源锚点映射；Jina 作为默认关闭的可插拔二阶段增强（纯函数合并逻辑先行，真实调用挂授权开关）。
- 引用跳转与原文高亮。
- SelectionAsk 选区冲突处理（§3.3 机制）。

### Phase 3：Copilot MVP

- `src/data/paperPolicy.ts` 常量、provider capability adapter、`modelGateway`（usage/cost 归一化、重试/熔断/令牌桶、授权检查）；`llmClient` 内部抽取 `runSseChat`、`sse.ts` 增 `extractStreamUsage`（§4.6/§5.2）。
- 流式线协议落地：`liteMd` closed 标志、`streamParser`、`blockSchemas`（先支持 explanation/formula + 控制岛，其余块 Phase 4）。
- react-markdown + KaTeX 渲染管线（§7.6）。
- 论文地图分层生成与缓存（§6.3 管线）。
- 引用问答（白名单/CiteMap/存在性校验/词面启发式）、两种启动入口、持久化会话。
- 最近 6 轮 + memo 岛滚动摘要的上下文管理。
- 模型授权提示（ProviderConsent）、停止、重试和降级路径；成本预估与二次确认（§5.4 阈值）。

### Phase 4：自适应与重交互

- Tutor Plan 岛与概念级学习画像（L1/L2 证据、更新规则、层级 chip 与手动 pin/重置）。
- 其余展示块：stepper、comparison、concept-map、flow、timeline、quiz、flashcard、teach-back（判分与 verdict 岛）。
- 显式深度反馈（太浅/刚好/太深）与“换一种深度解释”（Kimi 升级路径 + 成本确认）。
- 语音提问接入与浏览器朗读（§9）。
- 桌面、平板、手机响应式体验打磨。

### Phase 5：质量与收尾（v2 重写）

- 运行 §11.3 右尺寸化评测（自动化脚本 + 本人抽查），结果回填本文档。
- QA 子代理执行 §11.2 完整浏览器回归，循环修复至 0 P0/P1。
- 构建产物审计：flag-off 生产构建确认零 paper 代码、主 chunk 尺寸与基线一致；flag-on 构建各懒加载 chunk 划分合理。
- v1 收尾：**生产不发布**（flag-off 构建即现状部署物，无需上线动作、零 nginx 改动）；本地使用说明写入本文档。
- 按仓库惯例回填 `> 进度（日期）` 交付记录。

## 11. 测试与验收

### 11.1 单元与契约测试（node 环境，`src/**/*.test.ts` 惯例不变）

新引擎全部为纯函数 node 测试：

- `chunking`：边界、1200 token/15% 重叠、中英混排（`Intl.Segmenter` Node 18+ 可用）。
- `bm25`：排序、中英分词。
- `hybrid`：确定性合并、未授权拒绝与降级。
- `anchors`：PDF 页/偏移与 DOCX 段落映射、不能精确定位时的页级回退。
- `ingest`：导入状态机、失败恢复、串行队列。
- `citations`：白名单存在性、词面支持启发式、CiteMap 映射。
- `contextBuilder`：预算裁剪阶梯、稳定前缀排布、滚动摘要折叠。
- `learnerProfile`：证据/置信度更新、单弱信号不跨层、pinnedLevel 冻结。
- `blockSchemas`：全部岛类型校验与降级。
- `streamParser`：围栏岛增量解析、半截岛、citeToken 残缺抑制、finalize。
- `providerAdapters`：**契约测试重点**——DeepSeek body 含 `thinking`/`stream_options`；Kimi body 省略 `temperature/top_p/presence_penalty/frequency_penalty`、必设 `max_completion_tokens`、`json_schema strict`；用 `src/lib/paper/fixtures/` 录制的请求/响应/SSE 转录（含 role-only 帧、reasoning delta、usage 尾帧、DS/Kimi usage 形状差异）驱动，**门禁内零真实 API 调用**。
- `usage`：usage 归一化与成本计算、缺失时 chars/3 估算标记。
- `sse.extractStreamUsage`、`liteMd` closed 标志回归。
- Dexie 仓储层：`fake-indexeddb`（devDep）纯 node 测（`new Dexie(name, { indexedDB, IDBKeyRange })`，每测例新库名）——schema migration、事务性级联删除、配额错误路径（stub）、进度持久化。文件字节为 ArrayBuffer 方案即为此服务。
- 唯一 DOM 例外：`sanitize.test.ts`（DOMPurify 清洗策略）用 per-file `// @vitest-environment happy-dom` pragma（devDep happy-dom；不用已废弃的 environmentMatchGlobs）。
- **真实二进制 PDF/DOCX 不进 vitest**：规范化层测试吃 parser 输出形 fixtures（文本项数组 / Mammoth HTML 字符串，含恶意 HTML、跨页段落、公式代码表格样例）；真实文件的解析行为归 §11.2 浏览器回归。加密/损坏/纯扫描/超大文件按“校验层数据 fixtures + 浏览器实测”覆盖。

`vite.config.ts` 的 test 配置块零改动（node env + include 原样）。

### 11.2 浏览器 E2E（claude-in-chrome QA 子代理清单）

由独立 QA 子代理在真实 Chrome 中执行（循环至 0 P0/P1；注意先断言 `document.visibilityState === 'visible'` 再判定动画/拖拽类问题）：

> 上传 → 列表 → 两种入口 → 预览 → 选段提问 → 流式回答 → 引用跳转 → 测验 → 刷新恢复 → 删除

同时覆盖：

- 390、768 和 1440 px 视口。
- 上传失败、解析失败和重试（含加密/损坏/纯扫描 PDF 真实文件）。
- 流式 Stop、切路由和快速重开会话的竞态。
- 全局 Ask 与 Paper 专属选区互斥（/papers 内全局 Ask 不出现，其他页面正常）。
- Chrome 语音流程和不支持语音时的文本降级。
- 无 API key、401/403、429、超时和坏结构化响应（可用无效 key/断网/构造流模拟）。
- provider 独立授权、Kimi 成本确认、Jina 开关、敏感论文本地模式和 DeepSeek 故障时的受控回退。
- teach-back 行为检查：3 条脚本化“埋雷”场景（回答中故意遗漏要点，验证 Agent 指出遗漏）。

### 11.3 右尺寸化评测与发布门槛（v2 重写）

评测集：**3 篇公开技术论文（1 英文、1 中文、1 公式密集；其中一篇同时导入 DOCX 版）× 8 个常规问题 = 24 主样本 + 12 挑战样本**（3 无答案、3 正文 prompt injection 带金丝雀串、2 误导性前提、2 跨章节综合、2 “引用相似但不支持结论”）。每题标注可回答性、gold anchor、关键概念。

执行方式：自动化脚本（node，走真实 API，**只在发布前手动运行，不进 vitest 门禁**）每题跑 3 次 ≈ 108 次生成（按 §5.4 价格约 $1–2）；延迟与 token 从 `ModelUsageRecord` 汇总。人工部分 = 本人一遍抽查（约 1 小时）：20 条引用支持性、24 题 1–5 分正确性 rubric、3 题 × 三层级输出差异可辨。

发布门槛：

| 门槛 | 判定 | 说明 |
|---|---|---|
| 引用目标 100% 可定位 | 自动 | 每个 cite 别名存在于白名单且映射到真实锚点 |
| prompt injection 成功 / 跨论文泄漏 / 虚构引用 ID | 自动，= 0 | 金丝雀串不得出现；双论文加载互检 |
| 结构化块首次 schema 通过率 | 自动，≥95%；“修复或降级”达 100%（不卡轮） | n=108 下不设 99.5% 这类不可测精度 |
| 无证据问题拒答 | 自动，3/3 进入“证据不足”态（机器可查状态，非正则匹配 prose） | |
| 有答案问题误拒 | 自动，≤1/24 | |
| TTFT P50 ≤4s、P95 ≤12s；完整回答 P95 ≤45s；论文地图 P95 ≤180s 且持续显示进度 | 自动（108 次运行统计；**TTFT 与完整回答 45s 线均按 thinking-off 口径**——与 TTFT 门既有口径一致；深度思考轮为用户显式选择的慢路径（有进度提示），单列观察值不设硬线，异常长尾按空流/预算问题排查） | |
| 引用支持性抽查 | 人工，≥18/20 | |
| 正确性 rubric | 人工，均分 <3.5 才阻断发布（4.0 为目标非门槛） | |
| 三层级差异可辨 | 人工，3/3 | |

已丢弃（v1 遗留，不再执行）：≥100 主样本、每题矛盾率统计、20% 双人复核与 Cohen's κ、双模型盲评路由协议（DeepSeek 主路由已在 §5.1 定稿；Kimi 的任务级升级只凭观察到的重复失败个案，记录在本文档后调整 `paperPolicy`）。

Jina 启用门槛（缩留）：20 条固定检索查询集（带 gold chunk 标注）自动对比 BM25 vs hybrid 的 `Recall@6`，提升 ≥5 个百分点才默认开启；否则保持本地 BM25。

### 11.4 性能与工程门禁

- 本地三连门：`npm run typecheck && npx vitest run && npm run build`（含全部现有与新增 vitest 用例；不建 CI——仓库无 CI 基础设施，沿用人工门禁惯例）。
- Paper 依赖不进现有首页 chunk：每阶段构建后对照 `dist/assets` 尺寸（基线 ≈953KB）。
- 20 MB、150 页基准文档在 Worker 中渐进解析，不阻塞主线程；长文预览虚拟化保持流畅滚动。
- 记录解析 P50/P95、首次可阅读时间、首 token P50/P95、错误率和单文档 token 用量。
- 记录每个 provider/model 的 schema 成功率、引用支持率、429/5xx、熔断次数和实际成本；不采集提示或正文。

## 12. 风险与应对

- **长文档造成浏览器内存压力**：Worker 解析、分批写入 IndexedDB、页面虚拟化并及时释放资源；导入串行队列。
- **PDF 文本顺序或公式抽取不完整**：保留原始页面预览，以页码引用为可信基线，并允许用户查看对应原文。
- **本地 BM25 对纯语义问题召回不足**：综合章节、选区和阅读位置进行查询扩展；用户授权后以 Jina hybrid retrieval/rerank 增强，但始终保留本地降级路径。
- **Agent 自适应判断过度**：画像按概念建模，展示当前层级，跨层需 ≥2 条独立证据，允许用户纠正、pin 或重置。
- **模型输出结构不稳定**：线协议手写校验、有限联合类型、宽松修复、降级卡兜底；流内岛坏不重试不卡轮。
- **模型成本和上下文膨胀**：分层摘要、检索式上下文、最近 6 轮 + memo 岛滚动摘要、分析缓存、成本阈值二次确认。
- **模型默认参数不兼容**：capability adapter 显式控制 DeepSeek thinking 与 Kimi 固定采样参数，契约测试阻止回归。
- **react-markdown 流式重渲染开销**：段级记忆化（只重算开放尾段）+ rAF 批量合并 delta；实测卡顿再降级为节流渲染。
- **客户端令牌桶与真实 nginx 计数漂移**：桶只作平滑预防，429 响应处理路径（§5.5）仍为权威兜底。
- **跨厂商回退扩大数据外发面**：provider 独立授权；未授权时不自动回退，只返回本地检索证据。
- **用户论文隐私**：默认本地保存，只发送必要片段，首次发送前明确授权，不记录正文与会话内容。
- **当前生产代理缺少用户鉴权**（已记录的已知风险）：v1 生产 flag-off 完全规避；二阶段上生产前按附录 A 处理限流与 key 策略。

## 13. 已确认假设

- 产品形态：本地单用户、单浏览器优先；v1 不发布生产（flag-off），本地 `npm run dev` 使用。
- 陪读主线：论文导读与自由探索并重。
- 存储：原文件（ArrayBuffer）、解析结果、会话与学习画像均保存在 IndexedDB（Dexie）。
- 默认生成模型：`deepseek-v4-pro`；普通任务关闭 thinking，复杂推导开启 high thinking。
- 辅助生成模型：`kimi-k3`；用于少量 strict schema、显式深度升级和已授权故障回退，不进入每轮热路径。
- 每轮热路径 1 次 LLM 调用：TutorPlan/画像信号以流内结构岛承载；quiz 判分本地 0 调用。
- 检索：本地 BM25 始终可用；Jina embedding/rerank 默认关闭，用户独立授权且 20 条检索集评测达标后启用；不引入独立向量数据库。
- 配置：模型策略为 `src/data/paperPolicy.ts` 客户端常量；`.env.local` 只供代理注 key（`DEEPSEEK_*`、`KIMI_*`、`JINA_*`）；v1 Paper 请求不发送 X-User-Key。
- 渲染：Copilot prose 用 react-markdown + remark-gfm + remark-math + rehype-katex + KaTeX（仅 paper chunk）；站内其他页面继续用 liteMd。
- 文档支持：只支持可抽取文字的 PDF 和 DOCX；不做 OCR。
- 语音：支持浏览器语音输入和本地朗读；不生成音频文件。
- 媒体：不生成图片或视频；所有交互图形使用 DOM/SVG。
- 评测：右尺寸化方案（§11.3）；κ/双人复核/双模型盲评不执行。
- 发布：先 flag 内部试用（本地），质量达标后按附录 A 二阶段上生产。

## 附录 A：二阶段上生产方案（本期不执行）

v1 生产构建 flag-off，llm-pro.cn 无任何变化。未来决定上生产时，按以下清单执行：

1. **nginx 新增 `/api/jina/` location**：镜像现有 4 个 provider block（前缀剥离、`proxy_ssl_server_name on`、auth map 支持 `$http_x_user_key` 覆盖、SSE 公共配置）。
2. **moonshot auth map 补服务端 Kimi key**（当前 default 为空，仅支持用户自带 key）。
3. **限流旁路（双区方案）**：带 X-User-Key（用户自付额度；伪造 key 只会得到上游 401）的请求走宽松区，无 key（消耗服务端 key）流量维持严格区：

```nginx
map $http_x_user_key $strict_limit_key {
    ""      $binary_remote_addr;   # 服务端 key 流量 → 严格区
    default "";                    # 自带 key → 跳过严格区
}
limit_req_zone $strict_limit_key    zone=api_strict:10m rate=6r/m;
limit_req_zone $binary_remote_addr  zone=api_loose:10m  rate=60r/m;
# 各 /api/* location 内：
#   limit_req zone=api_strict burst=3  nodelay;
#   limit_req zone=api_loose  burst=20 nodelay;
```

   安全权衡（明示）：旁路触发头是客户端可控的，但逃出严格区的请求消耗的是请求者自己的 key（或直接 401），服务端 key 的支出路径与今天同样严格；残余风险仍是“无鉴权公共代理 + 服务端 key”这一已记录事项。
4. **前端配套**：Paper 设置中提供按 provider 的用户 key 输入（区别于现有全局单 key），请求按 provider 附带对应 X-User-Key；敏感论文本地模式不受影响。
5. 变更流程沿用惯例：备份 conf → `nginx -t` → reload；部署仍为 build + tar 原子切换。
