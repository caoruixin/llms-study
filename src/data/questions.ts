import type { QCategory, Question } from './types'

export const CATEGORY_LABELS: Record<QCategory, string> = {
  'token-econ': 'Token 经济模型',
  'model-compare': '模型横评与选型',
  agent: 'Agent 架构',
  compute: '算力栈与成本测算',
  'inference-deploy': '推理部署',
  presales: '售前场景',
}

export const QUESTIONS: Question[] = [
  // ───────────────────────── Token 经济模型 ─────────────────────────
  {
    id: 'te-1',
    category: 'token-econ',
    lang: 'zh',
    prompt:
      '请讲清楚大模型 API 的计费模型：为什么输入 token 和输出 token 价格不同？「缓存命中」定价又是怎么回事，什么场景能吃到这个红利？',
    followUp: '如果客户的系统 prompt 有 3000 token、每天调用 50 万次，缓存能省多少？口算一个量级。',
    mustCover: [
      '输入（prefill）可高度并行、输出（decode）逐 token 生成占用更长 GPU 时间，所以输出单价通常是输入的 3~5 倍',
      '缓存命中指重复前缀的 KV cache 复用，跳过这部分 prefill 计算，命中价可低至输入价的 1/10 量级',
      '缓存只对「前缀完全一致」的部分生效（系统 prompt、few-shot、文档头部），不是结果缓存',
      '计费单位是每百万 token（$/MTok 或 元/MTok），能报出主流模型的量级',
    ],
    niceToHave: [
      '各家实现差异：显式开启（Anthropic cache write/read 两档价）vs 自动隐式命中（DeepSeek/Kimi）',
      '长上下文分档计价（超过某阈值输入涨价）',
      'Batch API 折扣（约五折、异步 SLA）与缓存可叠加',
    ],
    redFlags: ['把输入/输出价格关系说反', '把 prompt 缓存理解成"相同问题返回相同答案"的结果缓存'],
    referenceNotes:
      'prefill 阶段一次矩阵乘并行处理全部输入 token（算力瓶颈），decode 阶段每个 token 都要完整过一遍模型并读全部权重与 KV cache（带宽瓶颈），GPU 占用时间长得多——这是输出贵的根本原因。缓存命中省的是重复前缀的 prefill 算力：3000 token 系统 prompt × 50 万次/天，若命中率 90%+，输入侧这部分成本近似打 1 折，对高频固定 prompt 的客服/工具类场景是最大的成本杠杆之一。',
  },
  {
    id: 'te-2',
    category: 'token-econ',
    lang: 'zh',
    prompt:
      '客户想把 500 页合同直接塞进上下文让模型问答。从成本和延迟两个角度，长上下文会发生什么？你会怎么给客户设计优化方案？',
    mustCover: [
      '成本：输入 token 数量线性增加计费；多数厂商长上下文还分档涨价',
      '延迟：prefill 时间随上下文变长显著增加（注意力计算量随长度超线性），TTFT 恶化',
      '显存：KV cache 随上下文线性增长，挤占并发，间接推高单位成本',
      '优化路径：RAG 检索只送相关段落 / 前缀缓存复用（多轮问答同一文档）/ 分段摘要压缩',
    ],
    niceToHave: [
      '「标称上下文 ≠ 实用上下文」：长文档中间信息召回下降（lost in the middle），要用大海捞针类评测验证',
      '新架构（稀疏注意力/线性注意力）正在把长上下文的算力成本降下来，可作为选型考量',
      '按业务估算给出两方案成本对比数字',
    ],
    redFlags: ['认为长上下文只是"能不能放下"的问题，不谈成本与质量衰减', '方案只有"换更大上下文的模型"'],
    referenceNotes:
      '关键是把「一股脑塞上下文」转化为架构选择题：同一份文档反复问 → 前缀缓存后增量成本低，可以接受长上下文；文档库很大且每次只涉及局部 → RAG 明显更省。给客户展示三档方案（全量上下文/RAG/混合）+ 每千次问答成本估算，是售前的标准打法。',
  },
  {
    id: 'te-3',
    category: 'token-econ',
    lang: 'zh',
    prompt:
      '算账题：客服场景日均 100 万次对话，平均每次输入 2000 token（其中 1500 是固定系统 prompt）、输出 300 token。你怎么现场估算月成本，并给出降本抓手？',
    mustCover: [
      '拆解计费结构：输入分「可缓存的固定前缀」和「动态部分」，输出单独计价',
      '给出计算框架：月 token 量 = 日调用 × token 数 × 30，套用单价（可用任一主流模型价格演示，量级正确即可）',
      '缓存抓手：1500/2000 的输入可命中缓存，输入成本大头直接降一个量级',
      '其他抓手：压缩输出（限制字数/结构化）、小模型路由分流简单问题、错峰 batch',
    ],
    niceToHave: [
      '提到输出往往占总成本大头（单价高），压输出长度收益直接',
      '模型分级路由（简单问题走便宜模型）可再省 50%+',
      '给出敏感性：命中率从 60% 到 95% 的成本差',
    ],
    redFlags: ['不做拆解直接给拍脑袋总数', '忽略输出与输入单价差异'],
    referenceNotes:
      '示范口径：月输入 2000×100万×30 = 600 亿 token，其中 450 亿可缓存；月输出 90 亿 token。假设输入 ¥2/MTok、缓存 ¥0.2/MTok、输出 ¥8/MTok：输入 = 150亿×2 + 450亿×0.2（按命中）≈ ¥3.9 万，输出 = 90亿×8 ≈ ¥7.2 万——输出占大头。结论先行：优先压输出、保命中，其次分级路由。面试时框架和量级感比精确数字重要。',
  },
  {
    id: 'te-4',
    category: 'token-econ',
    lang: 'en',
    prompt:
      'Explain the difference between a Batch API discount and serving-side continuous batching. They both say "batch" — when would you bring up each one in a customer conversation?',
    mustCover: [
      'Batch API: asynchronous offline processing with a relaxed SLA (typically ~24h), priced at roughly 50% off — relevant for offline workloads like document processing, evals, data labeling',
      'Continuous batching: an inference-engine technique that packs many concurrent requests into shared GPU passes to raise utilization and throughput — it lowers per-token serving cost but is invisible to the API user',
      'Map to customer needs by latency SLA: interactive traffic cannot use Batch API; self-hosting customers care about continuous batching because it drives their unit economics',
    ],
    niceToHave: [
      'Throughput vs latency trade-off: bigger batches raise TPOT slightly but improve tokens/s per GPU',
      'Combining levers: batch + cache + off-peak pricing for maximum discount on offline pipelines',
    ],
    redFlags: ['Confusing the two concepts as the same thing', 'Claiming batch API is suitable for chat UX'],
    referenceNotes:
      'One is a pricing/product lever (Batch API), the other is an infrastructure efficiency lever (continuous batching in vLLM/SGLang/TRT-LLM). A pre-sales engineer should diagnose the workload first: offline & delay-tolerant → Batch API; high-QPS self-hosted serving → engine choice and batching policy determine cost per token.',
  },

  // ───────────────────────── 模型横评与选型 ─────────────────────────
  {
    id: 'mc-1',
    category: 'model-compare',
    lang: 'zh',
    prompt:
      'JD 要求「脱口而出」：请横向对比国内外至少 5 款主流模型的价格量级、上下文长度和长上下文实际表现，并说说你会按什么框架帮客户做选型。',
    mustCover: [
      '至少 5 款具体型号（如 GPT / Claude / Gemini / DeepSeek / Kimi / GLM / Qwen 中任五），价格与上下文量级正确',
      '指出「标称上下文 vs 实用表现」的差异，举例说明如何验证（大海捞针/长文档任务实测）',
      '选型框架：任务类型（代码/推理/多模态/长文档）× 成本约束 × 部署形态（API/私有化）× 合规',
      '国产开源模型价格通常比国际旗舰低一个量级，是成本敏感场景的核心选项',
    ],
    niceToHave: [
      '提到缓存价、batch 折扣等对真实账单的影响',
      '提到开源权重可自建带来的议价权',
      '有实测经验的细节（如某模型长上下文中段召回衰减）',
    ],
    redFlags: ['报不出任何具体价格/上下文量级', '只会背参数不会给选型结论'],
    referenceNotes:
      '示范结构：先一句总括（国际旗舰强在复杂推理与生态，国产开源强在性价比与可私有化），再逐个报数（每个模型一句话：定位+价格量级+上下文），最后给选型矩阵。价格数字以应用内「模型 API 横评表」为准——面试前把表里数字背熟。',
  },
  {
    id: 'mc-2',
    category: 'model-compare',
    lang: 'zh',
    prompt:
      '金融客户要私有化部署国产开源大模型，在 DeepSeek、Qwen、GLM、Kimi 之间怎么选？给出你的分析框架和倾向。',
    mustCover: [
      '许可证与合规：确认商用许可（MIT/Apache 类最友好）、备案与数据安全要求',
      '尺寸谱系与算力匹配：总参数决定显存占用、激活参数决定算力需求；客户有多少卡反推能跑什么',
      '能力与场景匹配：代码/Agent/长文档/中文理解各家强项不同，用客户自己的数据做 POC 实测',
      '生态与工具链：推理引擎支持度（vLLM/SGLang 适配）、微调工具、社区活跃度',
    ],
    niceToHave: [
      '给出具体倾向并说理由（如超大 MoE 效果最强但对集群要求高；中尺寸 dense 部署最省心）',
      '提到蒸馏/小模型版本作为边缘场景补充',
      '金融行业特有考量：模型可解释性要求、监管报备、灾备',
    ],
    redFlags: ['只比 benchmark 分数不考虑部署成本', '不问客户算力现状就推荐超大模型'],
    referenceNotes:
      '框架：①合规过滤（许可证+备案）→ ②算力约束（客户卡型数量 → 可行模型尺寸档）→ ③场景实测（客户数据 POC，2-3 款对比）→ ④TCO 与运维能力。关键售前动作是把「哪家模型好」转化为「在客户的卡和场景上哪家最优」，避免陷入纯 benchmark 之争。',
  },
  {
    id: 'mc-3',
    category: 'model-compare',
    lang: 'en',
    prompt:
      'An overseas client asks: "Why should we consider an open-weights Chinese model instead of just using GPT or Claude?" Make the case — including the honest risks.',
    mustCover: [
      'Cost: open-weights flagship models are typically an order of magnitude cheaper per token, and self-hosting gives pricing control at scale',
      'Control & data sovereignty: weights on your own infra, fine-tuning freedom, no vendor lock-in',
      'Capability: top open models are now competitive on coding/reasoning benchmarks — cite at least one concrete example',
      'Honest risks: frontier-capability gap on some tasks, support/SLA differences, compliance and procurement perception in some jurisdictions',
    ],
    niceToHave: [
      'Hybrid architecture: route sensitive/high-volume traffic to self-hosted open model, hard cases to a frontier API',
      'USD-settled hosted endpoints (e.g. via international providers) as a middle path without self-hosting',
      'Licensing check as a first-step qualifier (MIT/Apache vs custom licenses)',
    ],
    redFlags: ['Overselling with no risks mentioned', 'No concrete model names or numbers'],
    referenceNotes:
      'Structure the pitch: TCO story (10x cheaper per token, plus caching), control story (fine-tune, deploy in-region for data residency), then de-risk (hybrid routing, benchmark on the client\'s own workload before committing). Close with a POC proposal — that is what a pre-sales engineer is paid to do.',
  },

  // ───────────────────────── Agent 架构 ─────────────────────────
  {
    id: 'ag-1',
    category: 'agent',
    lang: 'zh',
    prompt:
      '请描述（或画出）一个 RAG + Agent 混合架构：每个组件是什么、数据怎么流动、Agent 和 RAG 到底是什么关系？在客户场景落地时最常见的坑是什么？',
    mustCover: [
      '组件齐全：入口/路由 → Agent 循环（规划-工具调用-观察）→ 工具层（检索、API、代码执行）→ 记忆层 → 生成与引用',
      'RAG 作为 Agent 的一个工具（agentic RAG：模型自主决定何时检索、检索什么、是否追加检索），对比固定管线式 RAG',
      '检索链路细节：切块 → embedding → 向量库召回 → 重排（rerank）→ 注入上下文',
      '落地坑至少两个：检索质量差导致幻觉、多轮检索成本失控、切块策略与文档结构不匹配、权限与数据隔离',
    ],
    niceToHave: [
      '评估体系：检索命中率与端到端回答质量分开评',
      '引用溯源（citations）在 toB 场景几乎是硬需求',
      '缓存与成本：Agent 多轮循环的 token 放大效应（一次任务消耗可能是单轮问答的 10-50 倍）',
    ],
    redFlags: ['把 RAG 和 Agent 说成互斥的两种方案', '架构里没有评估与兜底环节'],
    referenceNotes:
      '一句话定位：RAG 解决「知识从哪来」，Agent 解决「任务怎么完成」，混合架构 = Agent 循环中把检索当工具按需调用。落地成败通常不在模型而在检索工程（切块、重排、元数据过滤）和评估闭环。给客户讲时先画数据流，再指着每条边讲失败模式，最能建立专业信任。',
  },
  {
    id: 'ag-2',
    category: 'agent',
    lang: 'zh',
    prompt: 'Function calling / 工具调用的底层机制是什么？在生产环境落地时你见过（或预见）哪些坑？',
    mustCover: [
      '机制：把工具的 JSON Schema 注入上下文 → 模型输出结构化调用意图（函数名+参数）→ 运行时真正执行 → 结果回填上下文 → 模型继续，循环直到产出最终答案',
      '模型并不执行工具，只是生成调用请求；执行、鉴权、超时都在应用运行时',
      '坑至少三个：参数幻觉（编造不存在的枚举值）、工具太多导致选择准确率下降、错误处理缺失（工具失败后模型死循环重试）、副作用工具的权限边界',
    ],
    niceToHave: [
      'Schema 设计是准确率杠杆：描述写清楚、参数少而精、枚举约束',
      '并行工具调用与串行依赖的编排差异',
      '各家 API 的 function calling 兼容性差异（OpenAI 格式已成事实标准）',
    ],
    redFlags: ['认为模型直接执行了函数', '不谈失败路径与安全边界'],
    referenceNotes:
      '生产级清单：工具数量控制（>20 个考虑分层/检索式工具选择）、每个工具幂等或有回滚、超时与重试上限、危险操作人工确认、全链路 tracing 记录每次调用的输入输出。售前场景常被问「工具调用可靠吗」——答案是机制上模型只提议、系统来把关，可靠性是工程问题。',
  },
  {
    id: 'ag-3',
    category: 'agent',
    lang: 'zh',
    prompt: 'Agent 的「记忆」怎么设计？短期记忆和长期记忆分别用什么实现，写入策略上有什么讲究？',
    mustCover: [
      '短期记忆 = 上下文窗口内的对话历史与工作状态；受窗口与成本约束，需要裁剪/摘要压缩',
      '长期记忆 = 外部存储（向量库/数据库/文件），通过检索按需注入上下文',
      '写入策略：什么值得记（用户偏好、任务结论、纠错反馈）、何时写（任务结束总结 vs 实时）、怎么防止错误记忆污染',
      '上下文管理：长任务中历史压缩（summarization/compaction）是维持长链路能力的关键',
    ],
    niceToHave: [
      '分层记忆架构：会话内 scratchpad / 用户级画像 / 组织级知识库',
      '记忆的检索也要重排与时效衰减，避免旧记忆压过新事实',
      '实际产品例子（如 Claude Code 的 memory 文件、ChatGPT memory）',
    ],
    redFlags: ['把记忆等同于"把所有历史都塞进上下文"', '不考虑错误信息被固化的风险'],
    referenceNotes:
      '面试一句话：记忆设计的本质是「在有限上下文预算下，让对的信息在对的时刻出现」。写入侧要有门槛（显式确认或高置信度才落库），读取侧要有检索与排序，维护侧要能改错删除——三者缺一就会出现记忆污染或记忆失效。',
  },
  {
    id: 'ag-4',
    category: 'agent',
    lang: 'en',
    prompt:
      'Long-horizon agent tasks (30+ steps) tend to fall apart in production. What are the main failure modes, and how would you architect around them?',
    mustCover: [
      'Error accumulation & drift: one wrong step compounds; mitigate with checkpoints, verification steps, and re-planning',
      'Context bloat: history grows past the window; mitigate with compaction/summarization and externalized state (files, task lists)',
      'Tool failures & loops: agents retrying the same failing action; mitigate with retry budgets, circuit breakers, and failure-aware prompts',
      'Observability: full tracing of every step/tool call is a precondition for debugging and trust',
    ],
    niceToHave: [
      'Human-in-the-loop gates for irreversible actions',
      'Sub-agent decomposition: fresh context per subtask beats one giant context',
      'Evaluation: task-level success metrics, not per-response vibes',
    ],
    redFlags: ['Only "use a better model" as the answer', 'No mention of observability or state management'],
    referenceNotes:
      'The mature pattern: externalize state (plan file / task queue), keep each context window small and focused, verify at boundaries, trace everything, and gate destructive actions on human approval. This is exactly what agent frameworks (LangGraph-style state machines) formalize — worth name-dropping with a concrete orchestration example.',
  },

  // ───────────────────────── 算力栈与成本测算 ─────────────────────────
  {
    id: 'cp-1',
    category: 'compute',
    lang: 'zh',
    prompt: '客户当场问：跑一个 70B 的模型要几张卡？你怎么现场估算显存需求并给出部署建议？MoE 模型的估算有什么不同？',
    mustCover: [
      '权重显存 = 参数量 × 每参数字节数（FP16=2、FP8=1、INT4=0.5）：70B FP16≈140GB、FP8≈70GB',
      '总显存 = 权重 + KV cache（随并发×上下文线性增长）+ 激活/运行时开销，要留余量',
      '给出结论：70B FP8 在 80GB 卡上单卡放不下服务余量 → 2 卡 TP，或 INT4 量化后单卡可跑',
      'MoE 区别：显存看总参数（所有专家都要驻留）、算力/速度看激活参数——客户常在这里被误导',
    ],
    niceToHave: [
      'KV cache 具体公式与 GQA/MLA 对 KV 的压缩效果',
      'qps 需求决定副本数：显存只是入场券，吞吐才决定卡数',
      '举例某大 MoE：总参数上 T 需多机，但激活参数几十 B，单 token 算力成本接近中型 dense',
    ],
    redFlags: ['MoE 按激活参数估显存', '完全不提 KV cache 和并发的关系'],
    referenceNotes:
      '现场心算模板：权重 GB ≈ 参数 B 数 ×（FP16:2 / FP8:1 / INT4:0.5）；KV cache 每并发每 K token 约几十 MB（GQA 后），高并发长上下文时可能反超权重。先算权重定卡数下限，再按目标并发×上下文算 KV，最后按 qps 定副本。带着这个模板去客户现场，比背具体数字更抗追问。',
  },
  {
    id: 'cp-2',
    category: 'compute',
    lang: 'zh',
    prompt: '英伟达 B300 / GB300 NVL72 这一代产品，对大模型推理的核心卖点是什么？「显存墙」到底指什么，新硬件怎么缓解它？',
    mustCover: [
      '显存墙：模型权重 + KV cache 超出单卡显存，必须并行拆分或量化；decode 阶段本质是带宽受限，显存带宽决定出 token 速度',
      'B300（Blackwell Ultra）关键提升：更大 HBM 容量与带宽、FP4 低精度算力大幅提升，直接利好推理',
      'GB300 NVL72 是机架级系统（72 GPU + Grace CPU、统一 NVLink 域），不是一张卡——大 MoE 的专家并行/张量并行在大 NVLink 域内通信效率高',
      '卖点落到业务指标：同等 SLA 下单 token 成本下降、可服务更大模型与更长上下文',
    ],
    niceToHave: [
      'NVLink scale-up（域内高带宽互联）与 InfiniBand/以太 scale-out（跨机架扩展）的分工',
      'FP4/FP8 推理量化与硬件代际配合',
      '提到国内可得性（H20 等中国特供卡）与合规约束对方案的影响',
    ],
    redFlags: ['把 GB300 NVL72 当成一张卡与 H100 直接对比', '说不清显存容量和显存带宽各自影响什么'],
    referenceNotes:
      '记忆锚点：容量决定「放不放得下」（模型大小、上下文、并发），带宽决定「出字快不快」（decode tokens/s），NVLink 域决定「多卡协作亏损多大」。新一代硬件三者同时抬升，售前话术是把硬件参数翻译成客户的 qps/延迟/单 token 成本。具体规格数字见应用内硬件层数据（带官方来源）。',
  },
  {
    id: 'cp-3',
    category: 'compute',
    lang: 'en',
    prompt:
      'FP8 / INT4 quantization for LLM serving: what do you actually gain, what can silently break, and how do you de-risk it before a customer deployment?',
    mustCover: [
      'Gains: memory footprint halves per step down (FP16→FP8→INT4), enabling fewer GPUs; bandwidth-bound decode speeds up roughly proportionally',
      'Risks: quality regression is task-dependent and often invisible on generic benchmarks — long-tail reasoning, code, and non-English text degrade first',
      'De-risking: evaluate on the customer\'s own workload with a fixed eval set, compare against the FP16/FP8 baseline, set acceptance gates before rollout',
      'Different targets: weight-only quantization vs KV-cache quantization vs activation quantization have different risk profiles',
    ],
    niceToHave: [
      'Method names: AWQ/GPTQ for weight-only INT4, FP8 with per-tensor scaling as the near-lossless default on Hopper/Blackwell',
      'Hardware coupling: FP8/FP4 gains need hardware support (H100 onwards / Blackwell for FP4)',
      'Serving-engine support differences (vLLM/TRT-LLM quantization paths)',
    ],
    redFlags: ['"Quantization is free" with no eval plan', 'Confusing training quantization with inference quantization'],
    referenceNotes:
      'The pre-sales framing: quantization is the single biggest cost lever in self-hosted serving (2-4x fewer GPUs), but it must be sold with an eval gate — "we quantize, we measure on your data, we only ship if quality passes your threshold." That one sentence builds more trust than any benchmark table.',
  },

  // ───────────────────────── 推理部署 ─────────────────────────
  {
    id: 'id-1',
    category: 'inference-deploy',
    lang: 'zh',
    prompt: 'vLLM 为什么比朴素的 HuggingFace 推理快一个量级？讲清楚它的两个核心机制，以及它们分别提升了什么指标。',
    mustCover: [
      'PagedAttention：把 KV cache 按页管理（类操作系统虚拟内存），消除预分配造成的显存碎片浪费，同显存下可承载的并发数大幅提升',
      'Continuous batching：请求随到随进、完成即出，不等整批结束，消除批内等待空泡，GPU 利用率恒定高位',
      '指标映射：并发上限↑ → 吞吐 tokens/s↑ → 单 token 成本↓；对单请求延迟影响很小',
      '对比基线：朴素推理静态 batch + 整段预分配 KV，显存浪费可达 60-80%',
    ],
    niceToHave: [
      '前缀共享：同系统 prompt 的请求 KV 可共享（与 SGLang RadixAttention 思路同源）',
      'vLLM 已成开源 serving 事实标准，生态适配新模型最快',
      '提到 chunked prefill、投机解码等进一步优化',
    ],
    redFlags: ['说不出 PagedAttention 解决的是显存碎片问题', '认为 batching 会显著恶化单请求延迟而不敢用'],
    referenceNotes:
      '讲解顺序：先说朴素推理浪费在哪（KV 预分配碎片 + 静态批空泡），再对症下药讲两个机制，最后落到商业指标（同样的卡服务 2-4 倍并发 = 单 token 成本直接减半以上）。这是 JD「摸过 vLLM」的标准送分题，必须讲得像用过。',
  },
  {
    id: 'id-2',
    category: 'inference-deploy',
    lang: 'zh',
    prompt: 'Prefill-Decode 分离（PD 分离）和前缀缓存（如 SGLang 的 RadixAttention）分别解决什么问题？什么样的客户场景应该重点用哪个？',
    mustCover: [
      'PD 分离：prefill 是算力密集、decode 是带宽密集，混跑互相干扰（长 prompt 的 prefill 卡住别人的 decode 造成卡顿）；分池部署后 TTFT 与 TPOT 可独立优化',
      '前缀缓存：请求间共享的前缀（系统 prompt/few-shot/文档）KV 只算一次，RadixAttention 用基数树管理可复用前缀',
      '场景匹配：长输入短输出（文档分析）PD 分离收益大；高频共享前缀（客服/Agent 工具描述）前缀缓存收益大',
      '两者正交可叠加，成熟推理集群通常都上',
    ],
    niceToHave: [
      'PD 分离需要在两池间传输 KV cache，对互联带宽有要求（NVLink/RDMA）',
      'Agent 场景多轮循环共享大量前缀，前缀缓存是 Agent 成本可控的关键',
      '各引擎支持现状：vLLM/SGLang/TRT-LLM 及各大厂自研栈都在推进 PD 分离',
    ],
    redFlags: ['两个概念混为一谈', '说不清 prefill 和 decode 的资源特性差异'],
    referenceNotes:
      '记忆锚点：PD 分离解决「两种阶段打架」，前缀缓存解决「重复计算浪费」。售前判断题：看客户流量画像——输入/输出长度比、前缀重复率、并发峰谷，就能判断哪个优化优先级高，这比背概念高一个层次。',
  },
  {
    id: 'id-3',
    category: 'inference-deploy',
    lang: 'en',
    prompt:
      'A customer wants to know the real QPS and per-token cost of serving a 70B-class model on their GPUs. How would you design a benchmark that produces numbers you can defend?',
    mustCover: [
      'Define the workload first: input/output length distributions, concurrency pattern, prefix-sharing ratio — synthetic uniform loads produce misleading numbers',
      'Metrics: TTFT, TPOT, p50/p95/p99 latency, and goodput (throughput that meets the SLA), not just raw max tokens/s',
      'Method: sweep concurrency until SLA breaks; the max QPS under SLA is the honest capacity number',
      'Cost: per-token cost = (GPU hourly cost × cluster size) / effective token throughput; state utilization assumptions explicitly',
    ],
    niceToHave: [
      'Reproducibility: pin engine version, model precision, and config; publish the harness',
      'Compare configs (TP degree, quantization, batching policy) as a matrix, not one-off runs',
      'Include warm vs cold cache scenarios if prefix caching is enabled',
    ],
    redFlags: ['Quoting vendor peak numbers as expected production capacity', 'No SLA definition before measuring'],
    referenceNotes:
      'The one-liner that wins trust: "Max throughput without an SLA is a marketing number; capacity under your latency budget is an engineering number — we measure the second one." Then show the sweep chart: QPS on x-axis, p95 latency on y-axis, SLA line horizontal, capacity = intersection.',
  },

  // ───────────────────────── 售前场景 ─────────────────────────
  {
    id: 'ps-1',
    category: 'presales',
    lang: 'zh',
    prompt: '给一个金融客户做大模型 POC，从第一次见面到交付报告，你的完整流程是什么？每一步的产出物是什么？',
    mustCover: [
      '需求澄清：业务场景、成功标准、数据可得性、合规约束（金融：数据不出域、审计要求）→ 产出 POC 目标文档',
      '方案设计：候选模型×部署形态的测试矩阵、评测数据集（客户真实数据脱敏）、指标与验收门槛 → 产出测试方案',
      '执行：搭环境、跑评测、记录全部配置保证可复现 → 产出原始数据',
      '报告：结果对比 + 成本测算 + 上线路径建议 + 风险清单 → 产出 POC 报告与 ROI 测算表',
    ],
    niceToHave: [
      '时间盒管理（2-4 周典型），范围蔓延是 POC 最大风险',
      '验收门槛提前书面确认，避免"再试试别的"无限循环',
      '把 POC 设计成可直接转生产的最小架构',
    ],
    redFlags: ['没有量化验收标准就开跑', '报告只有 benchmark 分数没有成本与落地路径'],
    referenceNotes:
      'POC 的售前本质：用最小成本把「能不能用、多少钱、怎么上线」三个问题回答成书面结论。金融行业加三件事：数据脱敏方案、私有化/专有云部署选项、审计与合规条款。报告结构建议：结论先行一页纸 → 测试矩阵与数据 → 成本与 ROI → 风险与路线图。',
  },
  {
    id: 'ps-2',
    category: 'presales',
    lang: 'zh',
    prompt: 'ROI 测算表怎么搭？成本侧和收益侧分别有哪些科目，哪些假设最容易被客户挑战，你怎么守住？',
    mustCover: [
      '成本侧：API 费用或自建 TCO（GPU 折旧/租金、电力与机房、运维人力、软件栈）、集成开发、持续评测运营',
      '收益侧：人力效率提升（明确口径：处理量×单位时间价值）、错误率下降、收入增量，逐项给测算口径',
      '易被挑战的假设：利用率（自建）、缓存命中率、人力替代率——用区间+敏感性分析而非单点数字',
      'API vs 自建盈亏平衡：日均 token 量到某阈值后自建更省，给出平衡点算法',
    ],
    niceToHave: [
      '三档情景（保守/基准/乐观）呈现',
      '把 ROI 表做成客户可自己改参数的活表格（这正是本应用 Token 经济面板的形态）',
      '提到隐性成本：模型迭代带来的重复评测、prompt 维护',
    ],
    redFlags: ['收益侧只有拍脑袋的"效率提升 50%"', '自建成本只算卡价不算利用率与运维'],
    referenceNotes:
      '守住假设的方法论：每个关键假设标注来源（客户访谈数据/行业报告/POC 实测），能实测的绝不估。自建单位成本公式：成本/MTok = 集群每小时总成本 ÷（有效吞吐 tokens/s × 3600 × 利用率）× 10⁶ ——利用率在分母，这是自建方案最脆弱的假设，诚实呈现反而建立信任。',
  },
  {
    id: 'ps-3',
    category: 'presales',
    lang: 'zh',
    prompt: '客户采购负责人说：「你们的方案比竞品贵 30%。」你现场怎么应对？',
    mustCover: [
      '先探询再应对：确认对比口径（单价 vs 总成本？同等模型档位？是否算上缓存/batch 优化后的真实账单？）',
      '换算到业务单位成本：每次会话/每份文档/每张工单的成本对比，而非 token 单价',
      '量化差异化价值：质量差距导致的返工率、SLA 与稳定性、合规与安全能力，翻译成钱',
      '给出让步阶梯：优化方案降本（模型分级路由/缓存/量化）优先于直接降价',
    ],
    niceToHave: [
      '识别这是采购谈判动作还是真实预算约束，应对策略不同',
      '用 POC 数据说话：同任务两家实测质量与真实成本',
      '提出分期/按量爬坡的商务结构降低客户决策门槛',
    ],
    redFlags: ['立刻降价', '只讲"我们质量好"却给不出量化证据'],
    referenceNotes:
      '标准应对链：对齐口径 → 重构比较维度（业务单位成本+质量+风险）→ 用数据支撑 → 技术降本方案先行 → 商务让步兜底。售前的价值就在第二步：把「token 单价贵 30%」重构成「每张工单便宜 15% 且返工率低一半」，这需要平时积累各场景的实测数据。',
  },
  // ───────────────────────── Token 经济模型（扩充）─────────────────────────
  {
    id: 'te-5',
    category: 'token-econ',
    lang: 'zh',
    prompt:
      '推理模型时代的新账单问题：客户说「输出才 200 个字，为什么按几千 token 收费？」——讲清 reasoning/thinking token 的计费逻辑和控制手段。',
    followUp: 'Kimi K3 的 reasoning_effort 有 low/high/max 三档，你会怎么帮客户选？',
    mustCover: [
      '思考过程也是模型逐 token 生成的，消耗同样的算力，主流厂商都计入输出计费（如 Gemini 明示"输出含思考 token"）',
      'thinking 长度与任务难度相关，可通过 effort 档位/预算参数控制（Kimi K3 low/high/max、GLM-5.2 High/Max）',
      '给客户的控制手段：按任务类型设 effort 档位、简单任务路由到非思考模型、监控 reasoning token 占比',
      '报价测算时必须把 thinking token 计入输出量预估，否则成本预测系统性偏低',
    ],
    niceToHave: [
      '各家披露口径差异：有的返回思考内容、有的只计费不返回',
      'K3 等常开思考模型的多轮场景要回传 reasoning_content，上下文成本连带增加',
      '实测数据：推理模型的输出 token 常是可见答案的 3~10 倍',
    ],
    redFlags: ['认为 thinking token 是厂商乱收费', '不知道 effort 档位这类控制旋钮的存在'],
    referenceNotes:
      '售前话术模板：先解释「思考也是生成」，再给三层控制方案（档位控制/任务路由/监控告警），最后把它转化为选型考量——同样任务下比较各模型「达到目标质量所需的总 token 成本」而非单价，这才是对客户诚实的比较口径。',
  },
  {
    id: 'te-6',
    category: 'token-econ',
    lang: 'zh',
    prompt:
      '上下文缓存的两种实现模式（显式 vs 隐式/自动）分别怎么工作？什么情况下开缓存反而更贵？',
    mustCover: [
      '显式模式（Anthropic/Qwen 显式缓存）：调用方标记缓存断点，写入收费（1.25×~2×），读取约 0.1×，可控 TTL',
      '隐式/自动模式（DeepSeek/Kimi/OpenAI）：服务端自动检测重复前缀，无写入费，直接享命中价',
      '反而更贵的场景：显式模式下前缀复用率低（写入 1.25×~2× 的成本 > 命中节省）；Gemini 还有按小时的缓存存储费，长挂短用会亏',
      '成本判断公式：命中次数 × 节省 > 写入溢价 + 存储费才划算',
    ],
    niceToHave: [
      '缓存生效条件：前缀完全一致（一个字符不同即失效），prompt 工程要把稳定部分前置',
      'Anthropic 最短可缓存前缀限制（新模型 512 token）',
      'Agent 多轮循环天然高复用，几乎总是该开缓存的场景',
    ],
    redFlags: ['不知道显式模式有写入溢价', '认为缓存永远省钱'],
    referenceNotes:
      '面试展示深度的点：把「要不要开缓存」量化成一道不等式，并指出 prompt 结构设计（稳定前缀前置、动态内容后置）是缓存命中率的决定因素——这说明你不只懂计费表，还懂怎么帮客户改造应用来吃到红利。',
  },
  {
    id: 'te-7',
    category: 'token-econ',
    lang: 'en',
    prompt:
      "A CFO says: 'Our LLM bill doubled last month but traffic only grew 20%.' Walk me through your diagnostic checklist.",
    mustCover: [
      'Decompose the bill: cost = requests × tokens/request × price — isolate which factor moved',
      'Tokens-per-request drift: prompt bloat, conversation history accumulation, RAG stuffing more chunks, agent loops taking more steps',
      'Cache hit rate drop: a prompt template change can silently invalidate the cached prefix',
      'Mix shift: traffic moving to a pricier model, longer-context tier pricing kicking in, or reasoning-token growth',
    ],
    niceToHave: [
      'Monitoring you would put in place: per-feature token metrics, cache hit rate dashboards, cost per business transaction',
      'Output length creep from a prompt change ("be thorough") — output tokens carry 3-5x the price',
      'Concrete fix priorities ranked by effort vs saving',
    ],
    redFlags: ['Jumping to "negotiate a discount" without diagnosis', 'No decomposition framework'],
    referenceNotes:
      "The winning structure is an equation, not a story: bill = Σ (requests × tokens × unit price) per model per feature. Show you would instrument each factor, then name the three most common culprits in practice: history accumulation without compaction, cache invalidation from template edits, and reasoning-token growth after a model upgrade. CFO-friendly close: report cost per business unit (per ticket, per document), not per token.",
  },

  // ───────────────────────── 模型横评与选型（扩充）─────────────────────────
  {
    id: 'mc-4',
    category: 'model-compare',
    lang: 'zh',
    prompt: '厂商都说自己支持 1M 上下文。你怎么设计实测来验证「标称上下文」的实用性？',
    mustCover: [
      '大海捞针（NIAH）及其局限：单针太简单，要用多针/多跳推理版本',
      '真实任务评测：长文档 QA、跨章节汇总、代码库级理解——用客户自己的文档构造',
      '性能与成本曲线：TTFT 和费用随上下文长度的增长曲线，找「能用但不划算」的拐点',
      '中段信息召回（lost in the middle）：关键信息放不同位置测召回差异',
    ],
    niceToHave: [
      '对比「长上下文塞满」vs「RAG 检索」两种方案在同一任务上的质量与成本',
      '各家长上下文分档计价对测试成本的影响',
      '注意力架构差异（稀疏/线性注意力）对长上下文质量的潜在影响，实测优先于理论',
    ],
    redFlags: ['只引用厂商 benchmark 数字', '不区分"能接受 1M 输入"和"能有效利用 1M 信息"'],
    referenceNotes:
      '核心观点一句话：标称上下文是「能塞多少」，实用上下文是「塞了还能答对多少、花多少钱」。评测矩阵 = 长度梯度（64K/256K/1M）× 信息位置（头/中/尾）× 任务类型（检索/推理/汇总），三条曲线（质量/TTFT/成本）一起看。这正是应用内横评表「实用上下文 N/A」的原因——没实测就不填数。',
  },
  {
    id: 'mc-5',
    category: 'model-compare',
    lang: 'zh',
    prompt: '开源模型许可证怎么看？MIT、Apache 2.0 和各家自定义许可证（Llama Community License、Kimi K3 License）对企业客户分别意味着什么？',
    mustCover: [
      'MIT/Apache 2.0（DeepSeek V4、GLM-5.2、Qwen3.5）：商用/修改/分发基本无限制，合规审查最快通过',
      'Apache 2.0 比 MIT 多专利授权条款，大企业法务通常更喜欢',
      '自定义许可证要逐条读：Llama 有月活门槛与命名要求，Kimi K3 License 需核对具体条款再承诺',
      '许可证只管模型权重，数据合规（训练数据、生成内容责任）与行业监管是另一层',
    ],
    niceToHave: [
      '智谱 GLM-5.2 明确「MIT 无地域限制」是对出海/国际客户的信号',
      '许可证变更风险：拿到手的版本许可不可撤销，但后续版本可能改条款',
      '售前动作：把候选模型许可证做成一页对比表随方案附上，法务提前介入',
    ],
    redFlags: ['把"开源"当成一个同质概念', '在不确定条款时替客户拍胸脯'],
    referenceNotes:
      '实操顺序：先许可证过滤（能不能用）→ 再能力/成本比选（好不好用）。金融政企客户对「自定义许可证」天然谨慎，MIT/Apache 是省沟通成本的默认答案；确需用自定义许可证的模型时，标准动作是引导客户法务直接审原文，售前只陈述事实不做法律判断。',
  },
  {
    id: 'mc-6',
    category: 'model-compare',
    lang: 'zh',
    prompt:
      '从 DeepSeek V4、Kimi K3、GLM-5.2 这三个 2026 年开源旗舰身上，你看到哪些共同的技术主线？为什么大家不约而同往这些方向走？',
    followUp: '这些趋势对推理集群的采购和部署方案意味着什么？',
    mustCover: [
      '注意力革命：DSA 稀疏（GLM-5.2 +IndexShare）、KDA 线性混合（K3）、CSA-HCA（V4）——共同目标是把 1M 上下文的 KV cache/FLOPs 账单打下来',
      '残差/深度信息流改造：K3 的 Attention Residuals 与 V4 的 mHC 呼应，超深网络的信号传播成新战场',
      '极稀疏 MoE：总参数狂奔（1.6T/2.8T）而激活参数克制（49B/104B）——显存换算力的经济学',
      'MTP/投机解码普及：GLM-5.2 接受长度 +20%，decode 吞吐的"免费午餐"',
    ],
    niceToHave: [
      'FP4 原生化：K3 的 MXFP4 QAT、V4 的 FP4 专家——发布即低精度可用',
      'Muon 系优化器取代 AdamW 成为超大模型预训练新默认',
      '架构跨厂商扩散（GLM 用 DeepSeek 的 DSA）说明好设计正变成公共基础设施',
    ],
    redFlags: ['只罗列参数不提共同动机', '说不出任何一个具体机制名'],
    referenceNotes:
      '统一动机一句话：上下文 ×并发的 KV cache 与算力账单是推理成本的主项，三家都在从「注意力读什么、存什么」下刀。对部署的推论：①显存容量需求由总参数驱动继续上涨（利好大 HBM 卡与 NVL72）；②激活参数克制意味着单 token 算力成本可控；③投机解码和 FP4 让同样的卡吞吐翻倍——采购方案要按「架构代际」而非「参数量」评估算力需求。',
  },

  // ───────────────────────── Agent 架构（扩充）─────────────────────────
  {
    id: 'ag-5',
    category: 'agent',
    lang: 'zh',
    prompt: '什么时候值得上多 Agent（主从/子 Agent）架构？它解决什么问题、又带来什么代价？',
    mustCover: [
      '解决的问题：上下文隔离（每个子任务独立干净的窗口，避免单一上下文膨胀漂移）、并行加速、职责分工（检索/编码/审校各司其职）',
      '代价：token 成本放大（每个子 Agent 都要背景注入）、协调复杂度、子 Agent 间信息传递损耗',
      '判断标准：任务可分解且子任务相对独立时才值得；线性流程用单 Agent + 状态外置就够',
      '主从模式细节：主 Agent 只拿子 Agent 的结论摘要而非全过程，控制上下文回流',
    ],
    niceToHave: [
      '典型场景：深度研究（并行检索多路汇总）、代码库大规模改造（按目录分片）、评审流水线（生成者与批判者分离）',
      '失败模式：子 Agent 结论冲突无仲裁机制、并行写同一资源',
      '成本量化：多 Agent 方案报价时按「预计总 token = 单任务 × 子 Agent 数 × 轮次」估算',
    ],
    redFlags: ['为了"高级"而多 Agent', '不谈成本放大'],
    referenceNotes:
      '决策一句话：多 Agent 的本质收益是「多个干净的小上下文打败一个臃肿的大上下文」，收益随任务可分解度上升、随协调需求下降。给客户方案时先画单 Agent 版本，指出哪个环节的上下文会爆，再引出多 Agent——论证顺序比结论更能建立信任。',
  },
  {
    id: 'ag-6',
    category: 'agent',
    lang: 'zh',
    prompt: 'Agent 系统上线前后，评估体系怎么建？和普通 chatbot 评估有什么本质不同？',
    mustCover: [
      '本质不同：评单轮回答质量 → 评任务级成功率（多步、有副作用、路径不唯一）',
      '离线评估：构造带标准答案/验收条件的任务回归集，每次改 prompt/换模型跑回归',
      '在线评估：全链路 tracing（每步工具调用的输入输出）、任务成功率/步数/成本三指标监控',
      'LLM judge 的坑：判官偏好长回答、对自家模型有偏、要用人工标注校准判官',
    ],
    niceToHave: [
      '分层指标：组件级（检索命中率、工具调用成功率）与端到端（任务完成率）分开，方便归因',
      '回归集要包含失败样本（工具报错、检索为空）测兜底行为',
      '成本也是评估维度：同样成功率下每任务 token 消耗',
    ],
    redFlags: ['只用"感觉变好了"迭代', '没有 tracing 就谈优化'],
    referenceNotes:
      '售前场景常被问「怎么保证上线后不翻车」——标准答案是三件套：上线前回归集（含失败注入）、上线后全链路 tracing、按业务口径的任务成功率看板。能主动提到「LLM judge 需要人工校准」会显著提升可信度，因为这是踩过坑的人才知道的细节。',
  },
  {
    id: 'ag-7',
    category: 'agent',
    lang: 'zh',
    prompt: 'MCP（Model Context Protocol）是什么？它解决了什么问题，对企业客户的 Agent 集成意味着什么？',
    mustCover: [
      '定位：模型/Agent 连接外部工具与数据源的开放标准协议（"AI 的 USB-C"），Anthropic 发起、主流厂商跟进',
      '解决的问题：此前每个应用×每个工具都要定制集成（M×N 问题），MCP 把它变成 M+N——工具方实现一次 MCP server，所有支持 MCP 的客户端都能用',
      '企业意义：内部系统（数据库/工单/知识库）包一层 MCP server，即可被多个 Agent 产品复用，避免绑定单一供应商',
      '安全边界：MCP server 的鉴权、权限收敛、审计仍是企业自己的责任，协议不自动解决',
    ],
    niceToHave: [
      '与 function calling 的关系：FC 是模型输出调用意图的机制，MCP 是工具如何被发现/描述/托管的协议，两层互补',
      '生态现状：主流 IDE/Agent 框架已支持，企业软件厂商陆续官方出 MCP server',
      '售前话术：客户已有系统"MCP 化"的工作量评估（通常一个系统几天级）',
    ],
    redFlags: ['把 MCP 和 function calling 混为一谈', '完全没听说过 MCP'],
    referenceNotes:
      'JD 里「跟踪 Agent 框架演进」的当代必答项。给客户讲的价值排序：①集成复用（一次包装到处使用）②供应商中立（换模型/换 Agent 产品不重做集成）③生态借力（现成 server 直接用）。同时诚实提示：权限与审计要企业自建，这恰是售前方案里的增值服务空间。',
  },
  {
    id: 'ag-8',
    category: 'agent',
    lang: 'en',
    prompt:
      "Design an agent architecture for a bank's customer-service copilot (agents assisting human reps). Cover tools, memory, guardrails, and how you would measure success.",
    mustCover: [
      'Tools: customer profile lookup, transaction query, knowledge-base retrieval (RAG), ticket creation — each with tenant-scoped auth and audit logging',
      'Memory: session scratchpad for the current case; long-term customer context fetched from CRM, not accumulated in the model; strict PII handling',
      'Guardrails: read-only by default, human approval for any account mutation, response citations from KB, refusal + escalation paths for out-of-scope requests',
      'Metrics: suggestion adoption rate by reps, average handle time reduction, escalation accuracy, cost per assisted case',
    ],
    niceToHave: [
      'Copilot-first (human in the loop) as the right maturity step before full automation — and how to phase toward autonomy',
      'Compliance specifics: data residency, audit trail retention, model output logging for regulators',
      'Latency budget: suggestions must land within seconds to be adopted by reps',
    ],
    redFlags: ['Full automation of account actions on day one', 'No measurement plan beyond "accuracy"'],
    referenceNotes:
      'A strong answer is structured as: data flow diagram → permission model (the bank cares most) → phased rollout (copilot → partial automation with gates) → metrics tied to business KPIs (handle time, adoption, cost per case). Naming "suggestion adoption rate" as the north-star metric shows real-world copilot experience — quality that reps ignore is worthless.',
  },

  // ───────────────────────── 算力栈与成本测算（扩充）─────────────────────────
  {
    id: 'cp-4',
    category: 'compute',
    lang: 'zh',
    prompt: 'KV cache 显存怎么算？写出公式，并对比 GQA 和 MLA 在同等上下文下的每 token 显存差多少。',
    followUp: 'MLA 为什么能把 KV 压这么小而质量不掉？',
    mustCover: [
      'GQA 公式：每 token KV 字节 = 2(K和V) × kv_heads × head_dim × 层数 × 精度字节',
      '实例量级：Qwen3-235B（94 层、4 KV head、dim128、FP16）≈ 0.19 MB/token；DeepSeek MLA（61 层、latent 576）≈ 0.07 MB/token——差约 3 倍',
      '总量 = 每 token × 上下文长度 × 并发数，长上下文高并发时 KV 会反超权重成为显存大头',
      'MLA 原理：K/V 低秩压缩成共享 latent 向量，推理只缓存 latent（512+64 维），用时再投影展开',
    ],
    niceToHave: [
      '32K 上下文 × 32 并发的具体口算演示',
      'KV 也可量化（FP8 KV 再省一半，GLM-5.2 的 1M 服务就靠它）',
      '新型线性注意力（KDA/GDN）状态恒定不随长度增长——KV 公式直接失效，这是架构级的解法',
    ],
    redFlags: ['公式里漏乘层数或并发', '认为 KV cache 是固定开销'],
    referenceNotes:
      '这是显存墙计算器的核心公式，面试时能白板推导 + 报出两个实例量级就是满分表现。MLA 质量不掉的直觉：注意力的 K/V 信息高度冗余，低秩压缩近似无损，而 RoPE 部分单独留 64 维保位置信息——「压缩共性、保留位置」两句话讲清。',
  },
  {
    id: 'cp-5',
    category: 'compute',
    lang: 'zh',
    prompt: '出口管制背景下，H20 这类中国特供卡怎么定位？给国内客户做算力方案时你的决策框架是什么？',
    mustCover: [
      'H20 定位：算力大幅阉割但显存 96GB/带宽 4.0TB/s 保留——decode（带宽受限）尚可、prefill/训练（算力受限）弱，是"推理特化卡"',
      '方案框架：先分负载类型（训练/微调 vs 推理；推理再分长 prompt 重 prefill vs 对话重 decode），再匹配可得卡型',
      '合规现实：政策随时间变化，方案要写明依据的时点与备选路径（合规卡型/国产芯片/云上合规算力）',
      '国产芯片选项：客观陈述生态成熟度（算子/框架适配工作量），按客户自研能力判断',
    ],
    niceToHave: [
      'H20 跑 MoE 推理的经济性：激活参数小的 MoE 对算力要求低，与 H20 特性契合',
      '混合架构：训练/微调用境外云或合规集群，推理国内 H20/国产卡',
      '价格现实：受限卡型溢价与二手市场风险提示',
    ],
    redFlags: ['对管制现状信口开河', '方案不留政策变化的余地'],
    referenceNotes:
      '这是国内售前的现实必答题。安全的回答姿势：技术层面把 H20 的「带宽保留、算力受限」特性讲精确（对应 decode/prefill 的资源画像），政策层面只陈述"以当前时点合规清单为准、方案含备选路径"，不做政策预测。把敏感问题转化为负载分析问题，是专业性的体现。',
  },
  {
    id: 'cp-6',
    category: 'compute',
    lang: 'zh',
    prompt: '客户给出目标：峰值 200 qps、平均输入 1.5K/输出 500 token、p95 TTFT<2s。你怎么从这个 SLA 反推集群规模和预算？',
    mustCover: [
      '第一步显存：选定模型+量化 → 权重+目标并发的 KV → 单实例 TP 卡数',
      '第二步吞吐：估算单实例 SLA 内产能（tokens/s → 折算 qps），注意用 SLA 约束下的产能而非峰值吞吐',
      '第三步副本：峰值 qps ÷ 单实例 qps，上取整后加冗余系数（N+1 容灾、20~30% 余量）',
      '第四步预算：卡数 × 时租/折旧 → 月成本，同时给出单请求成本供 ROI 用',
    ],
    niceToHave: [
      '峰谷比处理：弹性伸缩或错峰混部（白天在线、夜间批处理）提高利用率',
      '输出 500 token × TPOT 决定单请求占用时长，进而影响并发计算',
      '给出敏感性：SLA 放宽到 3s 可省多少（batch 加大、量化激进）',
    ],
    redFlags: ['用厂商峰值吞吐直接除', '不留冗余不谈峰谷'],
    referenceNotes:
      '完整链条：SLA → 单实例配置（显存定 TP）→ SLA 内单实例产能（实测或保守估算）→ 副本数（峰值/产能 × 冗余）→ 成本（含利用率假设）。面试亮点是主动指出「SLA 内产能 vs 峰值吞吐」的差异和实测校准环节——纸面估算给方向，POC 压测定合同数字。',
  },

  // ───────────────────────── 推理部署（扩充）─────────────────────────
  {
    id: 'id-4',
    category: 'inference-deploy',
    lang: 'zh',
    prompt: '投机解码（speculative decoding）的原理是什么？MTP 在里面扮演什么角色？加速比由什么决定？',
    mustCover: [
      '原理：小草稿模型（或模型自带 MTP 头）快速猜 k 个 token，大模型一次并行验证，接受的部分等于一步出多 token',
      '正确性无损：验证机制保证输出分布与大模型逐 token 生成一致，是免费加速不是近似',
      '加速比 ≈ 平均接受长度 × (1 − 验证开销)，接受率是核心变量',
      'MTP 的角色：训练时就带多 token 预测头，推理时充当自带草稿，省去独立草稿模型（DeepSeek V3 首创、GLM-5.2 改进后接受长度 +20%）',
    ],
    niceToHave: [
      '为什么有效：decode 是带宽受限，验证 k 个 token 和生成 1 个 token 的权重读取成本接近',
      '接受率与任务相关：代码/结构化文本高、开放创作低',
      '与 batch 的权衡：高并发大 batch 下投机解码收益下降（算力不再空闲）',
    ],
    redFlags: ['认为投机解码会损失质量', '说不清加速的来源'],
    referenceNotes:
      '直觉链条：decode 每步都要读全部权重（带宽瓶颈）→ 顺便多验证几个候选几乎不额外花时间 → 只要草稿猜得准就白赚。GLM-5.2 的消融数字（4.56→5.47 接受长度）是现成的面试案例——能引用具体数字并解释「接受长度直接乘在吞吐上」，就把这道题答透了。',
  },
  {
    id: 'id-5',
    category: 'inference-deploy',
    lang: 'zh',
    prompt: '推理服务的 SLA 指标体系怎么定义？TTFT、TPOT、p95、goodput 各是什么，交互场景和批处理场景的 SLA 设计有何不同？',
    mustCover: [
      'TTFT=首 token 延迟（prefill+排队），决定"开始响应"体感；TPOT=后续每 token 间隔，决定"打字速度"体感',
      'p95/p99：延迟用分位数不用平均值——长尾才是用户投诉来源',
      'goodput：满足 SLA 约束的有效吞吐，是容量规划的正确口径（区别于裸吞吐）',
      '场景差异：交互场景卡 TTFT（<1~2s）和 TPOT（>10~20 tok/s）；批处理只关心总吞吐与成本，延迟可放到小时级',
    ],
    niceToHave: [
      '不同 SLA 分池部署（交互池小 batch 低延迟、批处理池大 batch 高吞吐）与 Batch API 半价的对应关系',
      '排队时延要计入端到端 TTFT，压测时区分引擎指标与用户体感指标',
      'Agent 场景的特殊性：多步循环放大延迟，单步 SLA 要更紧',
    ],
    redFlags: ['只谈平均延迟', '交互和批处理用同一套 SLA'],
    referenceNotes:
      '把指标翻译成商务语言是售前价值所在：TTFT=客户体感的"响应快不快"，TPOT=「读得顺不顺」，goodput=「这套集群实际能卖多少量」。合同里写 SLA 时用 p95 口径 + 明确测量点（网关侧），这两个细节能避免上线后的扯皮。',
  },
  {
    id: 'id-6',
    category: 'inference-deploy',
    lang: 'zh',
    prompt: 'DeepSeek V4 / Kimi K3 这类超大 MoE 的多机部署，和 70B dense 有什么本质不同？关键工程要点是什么？',
    mustCover: [
      '本质不同：dense 主要 TP 切权重；大 MoE 总参数超单机（1.6T/2.8T），核心是 EP 专家并行——专家分布多卡，token 按路由 all-to-all 投递',
      '通信画像：EP 的 all-to-all 对互联极敏感 → 尽量留在 NVLink 域内（NVL72 的核心卖点场景）',
      '负载均衡：专家热点导致卡间负载不均，需要专家副本/动态重分布',
      '引擎选择：SGLang 是 DeepSeek 官方推荐路径，vLLM 也在快速跟进（K3 的 KDA cache 支持已进 vLLM）',
    ],
    niceToHave: [
      'PD 分离与 EP 叠加：prefill 池与 decode 池各自做 EP',
      '显存账：总参数定驻留显存（FP4 减半），激活参数定算力——K3 原生 MXFP4 就是为部署友好',
      '跨机 EP 时 IB 带宽成为瓶颈的量化直觉（NVLink 的 1/18）',
    ],
    redFlags: ['用 dense 的 TP 思路套 MoE', '不知道 all-to-all 通信模式'],
    referenceNotes:
      '一句话抓本质：dense 的并行是「切一块大权重」，MoE 的并行是「摆一群小专家 + 快递 token」——前者考验单机内带宽，后者考验域内互联和调度。给客户方案时由此推出硬件建议：大 MoE 优先大 NVLink 域（NVL72/多卡单机），跨机架只做副本扩容。',
  },

  // ───────────────────────── 售前场景（扩充）─────────────────────────
  {
    id: 'ps-4',
    category: 'presales',
    lang: 'zh',
    prompt: '标书的技术附件你会怎么写？哪些数字敢承诺、哪些必须留口径？',
    mustCover: [
      '结构：需求响应对照表（逐条应答）、方案架构图、性能与容量承诺、实施计划、SLA 与运维',
      '敢承诺的：架构能力（支持的模型/并发架构/扩展性）、经实测的性能区间、交付里程碑',
      '必须留口径的：依赖客户数据的质量指标（写"以 POC 实测为准"）、依赖客户流量画像的容量数字（写明假设条件）',
      '免责与边界：模型迭代、第三方 API 价格变动、超出假设的流量——变更机制写进商务条款',
    ],
    niceToHave: [
      '竞争差异化写法：用评测方法论（可复现 benchmark）压制对手的峰值数字',
      '每个承诺数字标注测试条件（模型版本/量化/负载画像），既专业又自保',
      '附 ROI 测算表模板作为增值项',
    ],
    redFlags: ['把厂商峰值数字直接写成承诺', '无条件承诺质量指标'],
    referenceNotes:
      '标书的博弈本质：承诺太少丢分、承诺太满埋雷。解法是「数字+条件」绑定书写（例：在输入 2K/输出 500、FP8、H100×8 条件下 p95 TTFT ≤ 1.5s），让评标专家看到专业性、让法务看到边界。对手写裸数字时，附一页"测试条件说明"反而是攻击点。',
  },
  {
    id: 'ps-5',
    category: 'presales',
    lang: 'zh',
    prompt: 'POC 跑完，客户说「效果不达标，不买了」。复盘和挽救的动作是什么？',
    mustCover: [
      '先归因再应对：拆解失败在哪层——数据质量/检索链路/prompt 设计/模型本身，逐层排查而非笼统换模型',
      '对照验收标准：当初书面门槛是什么、差多少、哪些子任务达标——把"不达标"从情绪变成数字',
      '快速迭代提案：针对归因结果给 2 周内的改进计划（如重建切块策略/加重排/换尺寸档），申请二轮验证',
      '期望管理复盘：如果是验收标准当初就定得不合理，坦诚重谈口径而不是硬凹',
    ],
    niceToHave: [
      '数据说话：展示 bad case 的归因证据（检索命中了错误段落 vs 模型理解错误）',
      '降级方案：全场景不达标但子场景达标时，提议缩小范围先上线',
      '即使丢单也留下专业印象与返场钩子（模型迭代后再测）',
    ],
    redFlags: ['归因直接甩锅模型或客户数据', '没有二轮验证的具体计划'],
    referenceNotes:
      '售前老兵的共识：POC 失败一半以上出在检索与数据预处理，不在模型。标准复盘链：验收差距量化 → bad case 分层归因（数据/检索/prompt/模型）→ 最小改动的二轮计划。能把「不达标」拆成层级化数字的人，客户反而会加深信任——这是把坏局面变成能力展示的机会。',
  },
  {
    id: 'ps-6',
    category: 'presales',
    lang: 'en',
    prompt:
      "You have 2 minutes in an elevator with a prospect's CTO. Pitch your 'model + compute matching' service. Go.",
    mustCover: [
      'Hook with the pain: most teams overpay 3-10x by defaulting to a frontier API for everything, or underestimate self-hosting complexity',
      'What we do in one sentence: match each workload to the right model × right serving stack × right hardware, backed by benchmarks on your data',
      'Proof point: one concrete number (e.g., routed 70% of traffic to an open-weights model, cut cost 60% with no quality loss)',
      'Clear ask: a 2-week POC on one workload with agreed acceptance gates',
    ],
    niceToHave: [
      'Tailor to the listener: CTO cares about risk and lock-in — mention vendor-neutral, open-weights options and exit paths',
      'One-line differentiation: we publish reproducible benchmark methodology, not marketing numbers',
      'Timeboxing the pitch itself: 30s pain, 30s what, 30s proof, 30s ask',
    ],
    redFlags: ['Feature-dumping with no structure', 'No ask at the end'],
    referenceNotes:
      "The JD explicitly requires English as a working language — this drills the classic pain → solution → proof → ask structure in 4×30s. Practice until the proof point rolls off naturally with a real number; a pitch without one number is forgettable, a pitch with three is a lecture.",
  },
  {
    id: 'ps-7',
    category: 'presales',
    lang: 'zh',
    prompt: '客户拿着 DeepSeek API 的超低价（输出 $0.87/MTok）来压价：「人家比你们便宜 10 倍」。你怎么应对？',
    mustCover: [
      '先承认事实再重构口径：DeepSeek 的价格是真实的架构效率红利（稀疏注意力/MoE），不贬低对手',
      '对齐比较维度：同任务质量下的总成本（可能需要更多轮次/更长 prompt）、SLA 与限流、数据合规与私有化需求',
      '需求匹配：客户场景真适合 DeepSeek 就纳入方案（混合路由把它变成我方方案的一部分，而非对立面）',
      '我方价值重定位：模型中立的选型/路由/运维/评测服务，模型价格战反而凸显"帮客户永远用到最优组合"的价值',
    ],
    niceToHave: [
      '指出单价≠账单：缓存命中率、思考 token、生态工具链成熟度都影响真实成本',
      '风险提示要克制、有据：限流政策、峰值稳定性以实测为准，不散播 FUD',
      '把压价对话转化为 POC 邀约：「我们把 DeepSeek 也放进评测矩阵一起测」',
    ],
    redFlags: ['贬低竞品或散播无据风险', '被单价框架带着走'],
    referenceNotes:
      '高段位应对是「收编而非对抗」：把对手 API 纳入自家路由方案，客户省钱的诉求被满足，我方的位置从"卖某个模型"上移到"管理模型组合"——这正是 Token & 算力售前这个岗位的本质定位。压价话术的终结句：单价是入口，账单和 SLA 才是终点，我们对账单负责。',
  },
]

export const QUESTIONS_BY_CATEGORY = (Object.keys(CATEGORY_LABELS) as QCategory[]).map((c) => ({
  category: c,
  label: CATEGORY_LABELS[c],
  questions: QUESTIONS.filter((q) => q.category === c),
}))
