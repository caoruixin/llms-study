# LLM Infra 面试备战可视化 App — 实施计划（v3，经 codex 两轮评审修订）

> **进度（2026-07-31）：Phase 0-7 全部完成。** `npm run dev` → http://localhost:5199。
> 已交付：四大模块 + 40 题 rubric 题库 + 掌握度仪表盘 + QKV/生命周期动画 + encoder-decoder 视图 + 2 个 ROI case + POC case。
> 验证：tsc/vite build 通过、vitest 28 单测全绿、浏览器逐页走查通过、评分链路 401 错误路径已验证。
> **待用户完成**：① 在设置页粘贴 API key（或复制 `.env.example` 为 `.env.local` 填 key 后重启 dev）实测评分；② Chrome 里实测语音输入（需麦克风授权）。

## Context

用户两天后面试「Token & 算力售前负责人」岗位（JD: `/Users/caoruixin/DocumentsRex/Rex/jd-ai-infra.md`），需要一个可视化模拟 Application 帮助系统学习 + 模拟面试。推理过程纯模拟（不调本地模型）；面试评测调用 LLM API 实时打分。项目落地在空目录 `/Users/caoruixin/projects/llms-study/`（全新 Vite + React + TS 项目）。**建设顺序 MVP 纵切优先以控风险，但 ⭐ 标记的增强项也全部要做**（用户已确认时间足够），排在 MVP 跑通之后的第二波。

已确认决策：① Vite+React 本地 Web App；② 评测调 LLM API（用户提供 key）；③ 模型范围 = 经典 Transformer + DeepSeek V3/V4 + Qwen3 + Kimi K3 + GLM-5/5.2。

## 事实基线（Phase 0 需逐条对官方来源核实后落库）

- **Kimi K3**：2.8T MoE、1M 上下文、原生视觉、Kimi Delta Attention（混合线性注意力）、Attention Residuals。效率提升等具体数字**以官方博客 kimi.com/blog/kimi-k3 措辞为准**（宣传口径为架构+训练配方综合收益，勿单独归因某组件）；"thinking 默认开启"是发布时产品行为，与架构分开表述。
- **GLM-5**：744B MoE（40B 激活）、DeepSeek Sparse Attention (DSA)、MIT 协议；**GLM-5.2**：IndexShare（每 4 层稀疏注意力共享 indexer，1M ctx 下 per-token FLOPs 降 2.9×）、MTP 改进使投机解码接受长度 +20%。
- **DeepSeek V4**：注意 **不是 DSA**（DSA 属 V3.2/GLM-5 一线）；V4 为 CSA/HCA 混合注意力 + mHC + Muon 优化器；区分 V4-Pro（~1.6T 总参/49B 激活）与 V4-Flash（284B/13B 激活）。以 HF 官方模型页核实。
- **GB300 NVL72 是机架级系统**（72× Blackwell Ultra GPU + 36× Grace CPU），不是"卡型"。硬件数据模型必须分层：GPU 芯片 / 服务器·模组 / 机架系统，只在同层比较。

## 技术栈与工程契约

- Vite + React 18 + TS + React Router + Tailwind v4 + zustand；图表 recharts（实施前加载 dataviz skill）；framer-motion 仅用于 stretch 动画
- **数据层**（`src/data/`，类型化，与组件解耦）：`models.ts`（含 totalParams/activeParams 分列、attentionType、来源）、`pricing.ts`、`hardware.ts`（分层实体）、`questions.ts`、`agent.ts`。易变事实（价格/参数/规格）字段必须带 `sourceUrl` + `asOf` + 单位/币种。
- **simulationEngine**（`src/lib/simEngine.ts`，纯函数、vitest 可测）：
  - 显存 = 权重（**总参数**×量化位宽）+ KV cache（**按注意力类型判别式 schema 分公式**：MHA/GQA 按 kv_heads×head_dim×layers×seq×batch×精度；MLA 按 latent 维度）+ 运行时开销；输入含 GPU 数量/并行度（TP×副本）字段
  - **无可靠公式参数的架构（DSA/KDA/CSA-HCA 等新型稀疏/线性注意力）不做数值估算**，UI 显式标"该架构不支持数值估算，仅展示官方相对指标"，防伪精确
  - 性能：prefill 算力瓶颈（用**激活参数**）估 TTFT，decode 带宽瓶颈估 TPOT/qps；公式写注释并标来源基线；UI 全局标注"**示意估算，非实测 benchmark**"
  - token 计数为估算值（中文 ~1.6 字/token 经验值），标"估算"并允许手动改数
- **LLM API 接入**：不做运行时任意 base URL。`vite.config.ts` 里**固定 allowlist 代理路由**（`/api/moonshot`、`/api/zhipu`、`/api/deepseek`、`/api/openai-compat`）。**key 传递协议**：优先从 `.env.local` 按 provider 读（`MOONSHOT_API_KEY`/`ZHIPU_API_KEY`/…，**无 `VITE_` 前缀**，proxy configure 钩子注入上游 Authorization，不进客户端 bundle）；UI 粘贴的 key 存内存/sessionStorage，请求时放同源自定义头 `X-User-Key`，**代理删除该头并改写为上游鉴权头**。轻量 provider adapter：每 preset 声明 auth 方式/模型名/是否支持 JSON mode（不支持则 prompt 内嵌 JSON 指令 + 解析容错），统一错误归一化（401/429/timeout）与 30s abort。

## 模块设计（⭐= 第二波增强项，全部要做，排在 MVP 跑通后）

### Module 1 — 架构演进 Explorer（`/architecture`）
- 经典 Transformer 交互图：decoder-only 主视图，SVG 静态组件分解（Embedding→RoPE→MHA→FFN→Residual+Norm→LM Head），点击出侧栏三段式讲解（是什么/为什么/面试一句话）。⭐QKV 流动动画、encoder-decoder 切换视图
- 模型演进卡片：Llama 时代改良（RoPE/GQA/SwiGLU/RMSNorm）→ DeepSeek V3（MLA、细粒度 MoE+共享专家、MTP、FP8）→ V4（CSA/HCA、mHC）→ Qwen3（dense+MoE 双线）→ Kimi K2→K3 → GLM-5→5.2。每卡：与经典 Transformer 的 **diff 高亮** + 总参/激活参/上下文 + 亮点 2-4 条（一句话解释+为什么重要）
- **注意力/MoE 演进对比表**：MHA→MQA→GQA→MLA→DSA/KDA；FFN→MoE；MTP/投机解码
- **模型 API 横评表**（JD 硬要求"脱口而出"）：**行主键 = provider + 精确模型 ID/版本（+区域/档位）**，不按"模型家族"聚合；开放权重模型（Llama/Qwen 等）标注具体托管商报价，自建部署单列不标价；列：输入/输出/缓存价、官方上下文、实用上下文（无可靠 benchmark 则 **N/A**）、模态、工具支持、适用场景；全部带 sourceUrl+asOf

### Module 2 — 推理全链路模拟器（`/inference`）
- 四层可视化（点击出讲解+面试考点）：
  1. **硬件层**（分层实体）：GPU 芯片 H100/H200/**H20**/B200/B300 + 机架系统 GB200/GB300-NVL72；**显存墙计算器**（simEngine 驱动，7B/70B/MoE × 卡型 × 量化）
  2. **集群层**：TP/PP/DP/EP、**NVLink scale-up vs IB/以太 scale-out 区分**、Prefill-Decode 分离
  3. **引擎层**：vLLM（PagedAttention、continuous batching）、SGLang（RadixAttention）、TRT-LLM、量化 FP8/INT4/AWQ
  4. **服务层**：Gateway→限流→路由→队列→KV cache 命中→batch 组装
- **Prompt 生命周期模拟**：输入 prompt → tokenize（估算 token 数）→ 路由 → 排队 → prefill(TTFT) → 逐 token decode(TPOT) → 返回；右侧面板实时显示计费/缓存节省/吞吐延迟，参数（模型/卡型/量化/batch/上下文/缓存命中率）联动。MVP 用 CSS 过渡的步进动画，⭐framer-motion 全链路流动画
- **Token 经济面板**：API 计费 + **API vs 自建盈亏平衡计算器**，公式：`自建成本/MTok = 集群每小时总成本 ÷ (集群 tokens/s × 3600 × 利用率) × 1e6`，与按输入/输出/缓存 token 占比加权的 API 价格比较（公式透明展示，利用率越低单位成本越高）+ **1 个 ROI 测算 worked case**（需求→负载→容量→TCO→ROI）+ **1 个静态 POC/Benchmark worked case**（需求澄清→测试矩阵→数据集与并发模型→TTFT/TPOT/p95/QPS/质量/成本指标→验收门槛→报告结论模板，对标 JD"POC 设计、Benchmark 报告"）⭐第 2 个 ROI case

### Module 3 — Agent 架构速览（`/agent`）【新增，JD 核心话题】
- 一张 Agent 架构蓝图（工具调用/记忆/编排/多模态/长链路推理五要素）+ **RAG+Agent 混合架构图** + 落地坑清单（各配面试一句话）
- 2 个典型编排流程图（LangGraph 式状态机、Function Calling 循环），静态 SVG 即可

### Module 4 — 面试 QA 陪练（`/interview`）
- 题库 `questions.ts`：MVP **20 题**（六板块：Token 经济/模型横评/Agent/算力栈/推理部署/售前场景），每题带 **`mustCover`/`niceToHave`/`redFlags`/参考要点** 字段；含 **5 道英文题**（每题带 `lang` 字段）⭐扩到 40 题+追问
- 答题：文本输入；语音输入 Web Speech API（按题目 `lang` 选 zh-CN/en-US，能力检测失败降级文本）
- 评测：调 LLM API，prompt 注入该题 rubric，要求返回结构化 JSON（四维度 1-10：技术准确性/结构化表达/业务成本视角/深度实战感 + 逐条点评）；**A/B/C/D 由客户端按固定权重从分数确定性映射**，不让模型直接给等级；JSON 校验失败有容错重试
- 复盘：localStorage 存答题+评分历史、低分重练 ⭐掌握度仪表盘

## 实施步骤（MVP 纵切优先）

- **Step 0 — 保存计划文档**：将本计划保存为 `/Users/caoruixin/projects/llms-study/PLAN.md`（随项目留档，实施中按进度勾选更新）
- **Phase 0 — 资料核实**（并行 firecrawl）：上面事实基线逐条对官方页核实；API 定价表；B300/GB300/H20 规格 → 落 `src/data/`
- **Phase 1 — 脚手架**：Vite+React+TS+Tailwind+Router、布局导航、代理路由与 key 注入、数据类型定义
- **Phase 2 — Module 4 陪练（MVP 核心先行）**：20 题题库 + adapter + rubric 评分链路 + 文本答题（语音其次）
- **Phase 3 — Module 1**：Transformer 图 + 模型卡片 + 两张对比表
- **Phase 4 — Module 2**：simEngine（先写公式+单测）→ 四层视图 → 生命周期步进模拟 → 经济面板
- **Phase 5 — Module 3 Agent 页**（静态图文，成本低）
- **Phase 6 — 第二波增强（全部要做）**：QKV 流动动画 + encoder-decoder 切换视图（M1）、framer-motion 全链路流动画（M2）、第 2 个 ROI worked case、题库扩到 40 题+追问、语音打磨、掌握度仪表盘（M4）
- **Phase 7 — 验证**（下节，MVP 跑通后即先做一轮，第二波完成后再全量过一遍）

## 验证方式

1. `tsc --noEmit` + `vite build` 通过；**vitest 单测**：simEngine 显存/TTFT/TPOT 公式对已知算例（如 70B FP8 于 H100 的权重显存 ≈70GB）、A-D 映射函数、评分 JSON 解析器 fixtures（合法/缺字段/非 JSON/401/429/timeout）
2. `npm run dev` + claude-in-chrome 逐模块走查：组件点击讲解、diff 高亮、模拟动画全流程、参数联动、横评表来源链接
3. 评分链路：**仅对用户实际提供 key 的 preset** 各实测 1 题验证结构化返回与等级映射，其余 preset 用 adapter fixture 测试覆盖；语音输入用户在 Chrome 实测
4. 内容抽查：定价/参数规模等关键数字与 sourceUrl 官方页一致

## 评审记录

- Round 1（codex gpt-5.6-sol, xhigh）：4×P0、13×P1、1×P2 → 已全部采纳（部分按 2 天窗口右尺寸化）：MVP 纵切重排、DeepSeek V4 事实纠错、Kimi K3 措辞按官方口径、硬件分层建模、新增 Agent 模块与 API 横评表、simEngine 契约化+单测、代理 allowlist+key 不落 localStorage、题目级 rubric+确定性等级映射、数据溯源字段、验证升级为 build+单测+故障注入。
- Round 2（同配置）：0×P0、5×P1 → 已全部采纳：simEngine 对无可靠参数的新型注意力（DSA/KDA/CSA-HCA）显式"不支持数值估算"并补集群参数字段；盈亏平衡公式方向纠正（利用率在分母）；key 转发协议明确（env 按 provider + UI key 走 `X-User-Key` 同源头由代理改写）；新增静态 POC/Benchmark worked case；横评表主键改为 provider+精确模型 ID，实用上下文无据则 N/A。两轮上限已到，评审循环结束。
