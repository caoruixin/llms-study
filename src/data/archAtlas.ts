// 「架构图谱」数据层:7 张推理架构图的注册表 + 放置声明(PLAN-arch-atlas.md)。
//
// 写作规范(内容红线,配套守卫见 src/data/archAtlas.test.ts):
// - 同 ID = 同概念:所有组件只在 ARCH_COMPONENTS 定义一次,7 张图只声明「放置哪些 ID」,
//   跨图 diff 的语义由此构造保证。
// - variantNote 仅在职责/形态有**实质差别**时写(≤40 字),它是唯一参与琥珀 diff 判定的字段,
//   措辞漂移会造成误报——不确定就不写。
// - 数量/规格差异写 badge('×N 实例' 'EP32' '可选'),不写 variantNote。
// - 图内风味补充写 detail(不参与 diff,可以长)。
// - 布局上限:每泳道 ≤6 节点、每 group ≤4 节点。
// - 含数字的 benefit 必须给 sourceIdx 指向 sources(裸数字禁入,沿用 kda.test.ts 红线);
//   组件 what/why/interview 尽量不写具体实测数字,数字集中放决策卡以便溯源。
// - dims 单格 ≤20 字;asOf 统一 'YYYY-MM'。
import type { Sourced } from './types'
import type { QuantId } from '../store'

// ─────────── 泳道:固定 6 层,自上而下即请求流向(空泳道渲染为置灰细条,不隐藏) ───────────

export type LaneId = 'client' | 'access' | 'orchestration' | 'engine' | 'kv' | 'infra'

export const ARCH_LANES: readonly { id: LaneId; name: string; desc: string }[] = [
  { id: 'client', name: '客户端与调用方', desc: '业务应用、Agent、批处理作业——流量从这里进来' },
  { id: 'access', name: '接入与路由', desc: 'API 端点、负载均衡、网关——请求的第一跳' },
  { id: 'orchestration', name: '调度与编排', desc: '把请求派给谁、开多少实例——集群的大脑' },
  { id: 'engine', name: '推理引擎池', desc: 'vLLM/SGLang 等真正跑前向计算的地方' },
  { id: 'kv', name: 'KV 与数据存储', desc: 'KV cache 的存放、复用与搬运' },
  { id: 'infra', name: '硬件与网络', desc: 'GPU、NVLink 域、跨机网络——一切之下的底座' },
]

// ─────────── 组件注册表:每个概念全局定义一次,跨图复用 ───────────

export interface ArchComponentDef {
  name: string
  enName?: string
  lane: LaneId
  what: string // 一句话机制,教学正文
  why?: string // 为什么重要 / 在架构演进中的位置
  interview?: string // 售前一句话(可选)
}

export const ARCH_COMPONENTS = {
  // —— client ——
  'app-client': {
    name: '业务应用/调用方',
    lane: 'client',
    what: '调用推理服务的上游:业务后端、Agent 框架、批处理作业,统一走 OpenAI 兼容 HTTP/SSE 接口。',
    why: '所有架构图的流量起点;上游是交互流量还是离线批处理、输入输出长度比例如何,直接决定下游该选哪张架构图。',
    interview: '先问客户「调用方是谁、流量长什么样」——架构选型的一半答案在这一格。',
  },
  // —— access ——
  lb: {
    name: '简单负载均衡',
    lane: 'access',
    what: '轮询/最少连接等通用策略把请求摊到多个实例;不感知 KV 缓存命中,也不感知引擎队列深度。',
    why: '单实例可以没有;而它的「无脑」正是后续架构的伏笔——不看前缀、不看负载,先进的调度都从替换它开始。',
    interview: '客户拿 Nginx 轮询也能跑,但要点出:轮询会把同前缀请求随机打散,白白丢掉缓存命中。',
  },
  'openai-api': {
    name: 'OpenAI 兼容 API 端点',
    lane: 'access',
    what: '对外暴露 /v1/chat/completions 等标准接口:请求解析、参数校验、SSE 流式返回。',
    why: 'OpenAI API 已是事实标准:上游代码零改动即可在不同引擎与架构形态间迁移,是「调用方」与「后端形态」解耦的关键一层。',
    interview: '「兼容 OpenAI API」= 客户切换成本近零,替换闭源 API 方案时最有力的一句话。',
  },
  'tenant-gateway': {
    name: '租户网关(限流/配额)',
    lane: 'access',
    what: '按租户/API Key 实施 RPM/TPM/并发配额、优先级与计量计费:超额请求被限流、排队或降级,而不是挤进引擎。',
    why: '多租户共享 GPU 池时,没有配额就没有公平性:一个失控脚本能吃光整池吞吐,把所有租户一起拖垮。',
    interview: '内部平台第一天就要配额:先到先得的 GPU 池,最终一定演变成「谁嗓门大谁先跑」。',
  },
  'kv-router': {
    name: 'KV-cache 感知路由',
    lane: 'access',
    what: '路由器维护各副本前缀缓存的近似视图(基数树等),把请求派给缓存命中最高的副本,并以负载做兜底。',
    why: '轮询会把同前缀请求随机打散,缓存命中全凭运气;缓存感知路由让「集群命中率」逼近「单机命中率」。',
    interview: 'SGLang router、Dynamo KV routing 做的是同一件事:别让负载均衡毁掉前缀缓存。',
  },
  'model-router': {
    name: '模型分级路由',
    lane: 'access',
    what: '按请求意图/复杂度把流量分到不同档位模型:简单问题走小模型,复杂任务走旗舰,失败再升级重试。',
    why: '推理成本的数量级差在「用哪个模型」而非「怎么部署」:分级路由是成本曲线上最陡的一段优化。',
    interview: '给客户算账先分流量:FAQ 类请求烧旗舰卡,省下的钱够再买一套检索链路。',
  },
  'rag-pipeline': {
    name: 'RAG 检索编排',
    lane: 'access',
    what: '把一次问答编排成多跳调用:问题向量化 → 向量检索 → 候选重排 → 拼上下文 → LLM 生成,必要时再走 VLM。',
    why: '它把「一个请求」放大成对多个池的一串调用——各池的容量规划必须按这个放大系数来做。',
    interview: 'RAG 方案报价前先画这条链:每一跳都是独立的容量与延迟预算。',
  },
  // —— orchestration ——
  'pd-scheduler': {
    name: 'PD 协调调度器',
    lane: 'orchestration',
    what: '把一次请求拆成 prefill、decode 两段分别派往对应池;跟踪 KV 位置,协调传输时机与两池负载。',
    why: 'PD 分离的大脑:没有它两池只是两堆机器。Mooncake 的 Conductor、Dynamo 的 router/planner 都是这一角色的实现。',
    interview: '一句话:调度器让「一次请求」变成「两段作业」——TTFT 归 prefill 池管、TPOT 归 decode 池管,SLO 才能分而治之。',
  },
  'sla-planner': {
    name: 'SLA 规划器(池配比)',
    lane: 'orchestration',
    what: '按实时负载与 SLO 达标情况动态调整 prefill/decode 池的实例配比(如 NVIDIA Dynamo 的 Planner)。',
    why: '两池配比是 PD 分离最敏感的旋钮:输入/输出长度分布一变,最优配比就变,静态配比很快过时。',
    interview: 'PD 分离不是「一次搭好」:配比要随负载调,配错时吞吐不升反降(见决策卡反面数字)。',
  },
  eplb: {
    name: 'EPLB 专家负载均衡',
    lane: 'orchestration',
    what: '统计各专家的实际热度,动态复制热门专家、重排专家放置,让 EP 各 GPU 的计算量尽量拉平(DeepSeek EPLB)。',
    why: 'EP 的阿喀琉斯之踵是专家冷热不均:最热的卡决定整体步速,负载均衡直接决定大 EP 能不能兑现吞吐。',
    interview: '被问大 EP 的风险先说负载不均:一个热点专家能拖慢一百多张卡——EPLB 这类机制不是可选项。',
  },
  'k8s-operator': {
    name: 'K8s Operator + CRD',
    lane: 'orchestration',
    what: '把「一次模型部署」抽象成自定义资源(CRD),Operator 对账式地创建/升级/自愈引擎副本(llm-d/AIBrix/production-stack 均此形态)。',
    why: '声明式管理是多模型多副本规模化的前提:配置即代码,故障自愈与灰度升级都从这里长出来。',
    interview: '客户问「和自己写脚本部署差在哪」——Operator 会持续对账:副本挂了自动拉起,改配置只改 YAML。',
  },
  'keda-autoscaler': {
    name: 'KEDA 指标扩缩容',
    lane: 'orchestration',
    what: '基于自定义指标(排队深度、KV 显存水位、TTFT 分位数)驱动副本数增减;KEDA 把任意指标源接进 K8s 扩缩容体系。',
    why: '原生 HPA 看 CPU/内存,对 LLM 完全失灵;按引擎真实压力信号扩缩,才能既扛峰又省卡。',
    interview: '「GPU 利用率高要不要扩容」——decode 天生跑满,看排队深度才知道是真忙还是假忙。',
  },
  'gpu-scheduler': {
    name: 'GPU 感知调度',
    lane: 'orchestration',
    what: '按 GPU 类型/数量/NVLink 拓扑为副本选节点,配合装箱、抢占与队列配额(Kueue、KAI-Scheduler 属此类)。',
    why: '通用调度器把 GPU 当普通数字资源,不懂拓扑与碎片:多卡副本被碎片挡住、TP 被拆到跨机,都靠它来避免。',
    interview: '客户集群「有卡却调度不上」多半是碎片问题——GPU 感知调度是 K8s 上跑推理的隐性前提。',
  },
  'warm-start': {
    name: '冷启动优化',
    lane: 'orchestration',
    what: '镜像预拉取、权重预热/流式加载、常驻暖池等手段,把新副本从「被调度」到「能服务」的数分钟尽量压短。',
    why: '大模型副本冷启动动辄几分钟(拉镜像+载权重),不优化它,自动扩缩容永远追不上突发流量。',
    interview: '报自动扩缩容方案必须带冷启动时长,否则 SLA 兜不住突发——这是最常被漏掉的一页。',
  },
  'gw-inference-ext': {
    name: 'Gateway API Inference Extension',
    lane: 'orchestration',
    what: 'K8s Gateway API 的推理扩展:EPP(Endpoint Picker)按引擎实时状态(队列/缓存/LoRA)为每条请求挑选后端端点,替代 Service 盲轮询。',
    why: '把「懂推理的路由」标准化进 K8s 生态:网关问 EPP「这条请求去哪个副本」,路由智能与网关实现从此解耦。',
    interview: '一句话定位:它是推理路由的「标准插座」,llm-d 等各家调度算法都往这里插。',
  },
  // —— engine ——
  'continuous-batching': {
    name: 'Continuous Batching',
    lane: 'engine',
    what: '迭代级动态组批:每个解码步都可插入新请求、移出完成请求,不等整批结束,GPU 前向始终满载。',
    why: '相对「静态 batch 等齐进齐出」消除了等待空泡,是单实例吞吐最大的一级杠杆。',
    interview: '客户问「为什么 vLLM 快」,第一句就是 continuous batching:随到随进、完成即出,GPU 不空转。',
  },
  'paged-attention': {
    name: 'PagedAttention',
    lane: 'engine',
    what: 'KV cache 按固定大小 block 分页管理,类操作系统虚拟内存:按需分配、用完回收,消除预分配碎片。',
    why: '省下来的显存直接换成并发:同一张卡能同时服务的请求数上去了,吞吐随之上去。',
    interview: '三步因果链一口气讲完:PagedAttention 省显存 → 并发上去 → 吞吐上去。',
  },
  'radix-attention': {
    name: 'RadixAttention 前缀复用',
    lane: 'engine',
    what: 'SGLang 用基数树管理历史 KV,自动检测并复用请求间的公共前缀(系统 prompt/多轮历史/Agent 分支)。',
    why: '前缀重复率高的负载里大段 prefill 直接跳过,吞吐与 TTFT 同时受益,结构化生成场景收益最大。',
    interview: 'Agent 负载前缀重复率极高,RadixAttention 是「Agent 成本可控」的关键组件。',
  },
  quantization: {
    name: '量化(FP8/INT4)',
    lane: 'engine',
    what: '权重(及 KV/激活)降精度存算:FP16→FP8→INT4 每档显存约减半;FP8 在 Hopper+ 近无损,INT4 需评测把关。',
    why: '同一张卡放下更大模型或更多并发,是自建降本第一杠杆。',
    interview: '量化必须带「客户数据评测门槛」一起卖,否则就是暗坑。',
  },
  'chunked-prefill': {
    name: 'Chunked Prefill',
    lane: 'engine',
    what: '把长 prompt 的 prefill 切成小块,与 decode 步混合调度,避免一个长请求独占 GPU 数百毫秒。',
    why: '单体架构内缓解 P/D 干扰的「软手段」:干扰变小但没消失——这正是通往 PD 物理分池的铺垫。',
    interview: '被问「不上 PD 分离怎么办」:先开 chunked prefill,TPOT 毛刺立减;不够用了再谈分池。',
  },
  'prefill-worker': {
    name: 'Prefill Worker(算力型)',
    lane: 'engine',
    what: '专职处理输入 prompt 的全量前向,一次算完产出该请求全部 KV;算力密集,长输入下越发吃紧。',
    why: '专职后可独立选卡、独立并行策略、独立扩缩:长 prompt 再也不会卡住别人的出字。',
    interview: '「prefill 吃算力」——文档问答类客户输入长,prefill 池就要配算力强的卡,配置建议由此出。',
  },
  'decode-worker': {
    name: 'Decode Worker(带宽型)',
    lane: 'engine',
    what: '接收 KV 后逐 token 自回归出字;每步都要读全量权重与 KV,显存带宽即出字速度。',
    why: '专职后 batch 可以组得很大:decode 是带宽受限,大 batch 几乎不伤 TPOT,吞吐直接翻上去。',
    interview: '「decode 吃带宽」——客户在意出字速度时,看 decode 池卡的显存带宽而不是算力。',
  },
  'mla-attention': {
    name: 'MLA 注意力部(DP)',
    enName: 'Multi-head Latent Attention',
    lane: 'engine',
    what: 'DeepSeek 的低秩压缩注意力:KV 压成 latent 向量大幅省显存;注意力部分按数据并行(DP)整份复制,每 GPU 各自服务一批请求。',
    why: '注意力与专家的并行方式解耦是大 EP 架构的关键一步:注意力吃带宽用 DP 摊,专家吃容量用 EP 切。',
    interview: '被问「EP144 是不是把注意力也切了」——不是:注意力 DP、专家 EP,两套并行各走各的。',
  },
  'routed-experts': {
    name: '路由专家分片(EP)',
    lane: 'engine',
    what: 'MoE 的数百个路由专家按专家维度切到大量 GPU(专家并行),每个 token 经门控网络只激活其中少数几个。',
    why: 'EP 把「总参数巨大、激活稀疏」的 MoE 摊到集群:每卡只驻留少量专家,显存骤降,大 batch 下每卡专家仍能吃饱。',
    interview: 'EP 的卖点一句话:总参数千亿级但每卡只放几个专家——MoE 的部署账要按激活参数算。',
  },
  'shared-expert': {
    name: '共享专家',
    lane: 'engine',
    what: '每个 token 都会经过的常驻专家(DeepSeek 结构),不参与路由;与注意力部一样按 DP 复制在各 GPU 上。',
    why: '共享专家承接通用知识、路由专家做专精分工;部署上它不产生 all-to-all 流量,是结构里稳定的底座。',
  },
  'engine-replica': {
    name: '推理引擎副本',
    lane: 'engine',
    what: '完整打包的 vLLM/SGLang 实例(内含 ① 的全部内核机制),作为无状态副本水平复制;K8s 里对应一个 Pod。',
    why: '把引擎「原子化」成副本是一切编排/路由架构的前提:上层只管副本的数量与派发,不再关心引擎内部。',
    interview: '和客户对齐抽象层级:① 讲引擎内部,之后的图里引擎只是「一个可复制的格子」。',
  },
  'engine-metrics': {
    name: '引擎指标暴露(/metrics)',
    lane: 'engine',
    what: '引擎以 /metrics 端点暴露排队深度、KV 显存水位、吞吐、TTFT 等实时指标,供扩缩容与智能路由消费。',
    why: 'LLM 扩缩容不能看 CPU/GPU 利用率(decode 常年跑满):排队深度与 KV 水位才是有效信号,这里是信号源。',
    interview: '客户拿 CPU 利用率做 HPA 必翻车——先把引擎指标接进监控,再谈自动扩缩。',
  },
  'embed-worker': {
    name: 'Embedding Worker(TEI)',
    lane: 'engine',
    what: 'encoder-only 向量化模型的专用推理服务(如 HF TEI):短序列、单次前向、无自回归解码,动态组批即可跑满小卡。',
    why: '资源画像与 LLM 完全不同——无 KV cache、延迟毫秒级、请求量常比生成高一个数量级,合池部署必然互相拖累。',
    interview: '「检索也要用旗舰卡吗」——不用:embed/rerank 上小卡,把大卡留给生成,这是 RAG 方案省钱的第一刀。',
  },
  'rerank-worker': {
    name: 'Reranker Worker',
    lane: 'engine',
    what: 'cross-encoder 重排模型:对「查询 × 候选文档」逐对打分,比向量检索准,但计算量随候选数线性增长。',
    why: '检索质量的关键一跳,也是链路里典型的突发型负载:top-k 一到就是一批前向,独立成池才能单独限流与扩缩。',
  },
  'vlm-worker': {
    name: 'VLM Worker(多模态)',
    lane: 'engine',
    what: '视觉-语言模型推理服务:图像经 vision encoder 转成 token 后进入语言模型,单请求算力/显存开销显著高于纯文本。',
    why: '多模态请求少而重,与高频轻量的检索流量天然互斥;分池后 VLM 的长尾延迟不会传染整条链路。',
  },
  // —— kv ——
  'kv-hbm': {
    name: 'GPU 显存内 KV(paged blocks)',
    lane: 'kv',
    what: '推理进行中的 KV cache 驻留 GPU HBM,按 block 分页管理;体积与模型结构、上下文长度、并发数联动。',
    why: 'KV 是 LLM 推理的第一等公民:显存里权重之外的大头,并发上限往往卡在它。',
    interview: '和客户算容量:上下文 × 并发 → KV 体积 → 卡数,用显存墙计算器现场演示。',
  },
  'kv-transfer': {
    name: 'KV 传输通道(NIXL/RDMA)',
    lane: 'kv',
    what: 'prefill 产出的 KV 经 NIXL/RDMA 等传输层跨节点搬到 decode 池,并尽量与计算重叠以藏住延迟。',
    why: 'PD 分离的命脉:传得快,分离几乎白赚;传得慢,收益全被搬运吃掉。',
    interview: '客户问 PD 分离的前提,先答网络:没有 RDMA 级互联,KV 搬运延迟会吃光分池收益。',
  },
  'prefix-cache': {
    name: '跨请求前缀缓存',
    lane: 'kv',
    what: '把系统 prompt、多轮历史等公共前缀的 KV 留在缓存里,后续请求命中即跳过对应那段 prefill。',
    why: '生产流量的前缀重复率远比想象高(系统 prompt 人人相同),它是 TTFT 与算力成本的双杠杆。',
    interview: '给客户看账单前先问:你们的系统 prompt 有多长?——那就是每条请求都在重复烧的钱。',
  },
  'kv-dram': {
    name: 'CPU 内存 KV 池(DRAM)',
    lane: 'kv',
    what: 'HBM 放不下的 KV 逐出到主机 DRAM:容量大一个数量级,命中时经 PCIe 回填 GPU,远快于重新 prefill。',
    why: '「回填比重算快」是分层缓存成立的根基,DRAM 是性价比最高的第一级下沉。',
    interview: '多轮对话场景先把这层立起来:跨轮命中省下的 prefill 是最容易兑现的收益。',
  },
  'kv-ssd': {
    name: '本地 SSD KV 缓存',
    lane: 'kv',
    what: '把历史上下文的 KV 落到 NVMe SSD:容量再上一个数量级、成本更低,命中的前缀从盘上读回,免去重算。',
    why: '「读盘比重算便宜」在长前缀上几乎恒成立:对话隔天续聊、文档反复问答,盘上命中就是纯赚。',
    interview: 'DeepSeek 把上下文放磁盘还能保住可观命中率——「KV 只能住显存」是过时观念。',
  },
  'kv-pooled': {
    name: '远端池化 KV 存储',
    lane: 'kv',
    what: '跨节点共享的分布式 KV 池(Mooncake Store/LMCache):任何副本产出的 KV,其他副本都能取用。',
    why: '把 KV 从「实例私产」升格为「集群资产」:副本重启不丢、跨副本复用,「以存换算」在这一层完成闭环。',
    interview: '一句话讲池化:集群里任何一张卡算过的前缀,全集群都不用再算第二遍。',
  },
  'vector-db': {
    name: '向量数据库',
    lane: 'kv',
    what: '存储文档 embedding 与索引(HNSW 等),按相似度毫秒级召回 top-k 候选,是 RAG 链路的检索底座。',
    why: '它决定「喂给 LLM 的上下文质量」:检索不准,后面的模型再强也是在认真回答错的材料。',
    interview: '客户抱怨 RAG 答非所问,先查检索层命中质量,再谈换大模型。',
  },
  // —— infra ——
  gpu: {
    name: 'GPU 服务器/卡',
    lane: 'infra',
    what: '承载权重与 KV 的算力底座:容量决定「放不放得下」,带宽决定「出字快不快」,算力决定「prefill 扛不扛得住」。',
    why: '三个指标对应三类瓶颈,不同架构对卡型的诉求不同——这正是对比模式里它常亮琥珀的原因。',
    interview: '报卡型前先问负载画像:prefill 重看算力,decode 重看带宽,别一句 H100 打天下。',
  },
  nvlink: {
    name: 'NVLink scale-up 域',
    lane: 'infra',
    what: '机内/机架内 GPU 全互联高速域;TP/EP 这类每步都要通信的并行方式必须留在域内。',
    why: 'NVLink 域大小 = 「多大的模型能高效并行」;单机 8 卡 NVLink 就是单体架构的容量天花板。',
    interview: '「为什么不把 TP 跨机」——scale-out 带宽差一个数量级,一句话终结讨论。',
  },
  'rdma-net': {
    name: 'RDMA/IB scale-out 网络',
    lane: 'infra',
    what: '跨节点高速网络(InfiniBand/RoCE):承载 PD 分离的 KV 流量与多机部署的次级并行通信。',
    why: '架构一旦跨出单机,网络就从「布线问题」升级为「性能预算」:KV 搬运走这里,快慢直接进 SLO。',
    interview: '方案里网络别只写「万兆」:PD 分离/多机部署要按 RDMA 规格报,这是单子里容易漏的成本项。',
  },
  'ep-alltoall': {
    name: 'All-to-All 专家通信(DeepEP)',
    lane: 'infra',
    what: '每层 MoE 前向都要把 token 按路由结果散发到专家所在 GPU、算完再收回:高频 all-to-all 集合通信,DeepEP 为此做了专用内核。',
    why: '大 EP 的通信税:dispatch/combine 每层各来一次,通信藏不进计算,EP 就白切了——通信库的质量直接进吞吐。',
    interview: '客户问「EP 为什么难」:TP 的通信是规律的 all-reduce,EP 是随路由变化的 all-to-all,难一个档位。',
  },
} as const satisfies Record<string, ArchComponentDef>

export type ArchComponentId = keyof typeof ARCH_COMPONENTS

// ─────────── 图内放置声明 ───────────

export interface ArchNode {
  id: ArchComponentId
  /** 本图角色变体 ≤40 字,唯一参与琥珀 diff 判定的字段;数量差异写 badge 不写这里 */
  variantNote?: string
  /** 本图专属长讲解,不参与 diff */
  detail?: string
  /** 'EP32' '×N 实例' '可选' 这类数量/规格角标 */
  badge?: string
  group?: string
}

export interface ArchGroup {
  id: string
  label: string
  lane: LaneId
  tone?: 'accent' | 'accent-2' | 'ok' | 'warn'
}

// from/to 仅用于测试校验与语义,不用于定位(定位由泳道/group 相邻关系隐含)
export interface ArchEdge {
  from: ArchComponentId
  to: ArchComponentId
  label: string
  kind: 'kv' | 'control' | 'data'
}

export interface ArchSource extends Sourced {
  kind: 'paper' | 'blog' | 'docs' | 'video' | 'github'
  title: string
}

export interface DecisionCard {
  problem: string
  /** 带数字的条目必须给 sourceIdx 指向本图 sources */
  benefits: { text: string; sourceIdx?: number }[]
  metrics: string[]
  costs: string[]
  avoidWhen: string[]
  /** 如「每实例 1~8 卡(单机 NVLink 域内 TP)」 */
  gpuScale: string
  /** 「用显存墙计算器验证」预填参数;仅显式点击时写入 useInferenceParams */
  memoryPreset?: { modelId?: string; gpuId?: string; quantId?: QuantId; batch?: number }
}

// ─────────── 10 维度对比总表 ───────────

export type DimensionId =
  | 'mono-vs-pd'
  | 'runtime'
  | 'parallelism'
  | 'batching'
  | 'prefix-kv'
  | 'model-routing'
  | 'autoscale'
  | 'replicas'
  | 'tenancy'
  | 'pooling'

export const DIMENSIONS: readonly { id: DimensionId; name: string }[] = [
  { id: 'mono-vs-pd', name: '单体 vs PD 分离' },
  { id: 'runtime', name: '运行时/引擎' },
  { id: 'parallelism', name: '并行策略' },
  { id: 'batching', name: '批处理方式' },
  { id: 'prefix-kv', name: '前缀/KV 复用' },
  { id: 'model-routing', name: '模型路由' },
  { id: 'autoscale', name: '自动扩缩容' },
  { id: 'replicas', name: '副本与容量' },
  { id: 'tenancy', name: '多租户隔离' },
  { id: 'pooling', name: '资源分池' },
]

// ─────────── 架构图 ───────────

export type ArchId =
  | 'baseline'
  | 'pd-disagg'
  | 'large-ep'
  | 'k8s-autoscale'
  | 'router-tenant'
  | 'kv-tier'
  | 'rag-pools'

export interface ArchDiagram {
  id: ArchId
  name: string
  tagline: string
  exemplars: string
  /** 数组顺序 = 泳道内顺序 */
  nodes: ArchNode[]
  groups?: ArchGroup[]
  edges?: ArchEdge[]
  /** 相对①基线的差异解读 3~5 条;非 baseline 必写 */
  vsBaseline?: string[]
  decision: DecisionCard
  /** 每图 ≥3 条 */
  sources: ArchSource[]
  /** Record 联合键,缺一维编译不过;单格 ≤20 字 */
  dims: Record<DimensionId, string>
  meta: {
    minDeploy: string
    qpsThreshold: string
    network: string
    opsComplexity: 1 | 2 | 3 | 4 | 5
    avoidWhen: string
  }
}

export const ARCH_DIAGRAMS: readonly ArchDiagram[] = [
  // ─────── ① 单体推理基线 ───────
  {
    id: 'baseline',
    name: '① 单体推理基线',
    tagline: '一个引擎实例吃下全部请求——把单实例吞吐榨干是一切架构的起点',
    exemplars: 'vLLM · SGLang · TensorRT-LLM(LinkedIn 50+ 场景、Meta/Mistral/Cohere/IBM 生产使用)',
    nodes: [
      { id: 'app-client' },
      {
        id: 'lb',
        badge: '可选',
        detail: '单实例可直连引擎自带的 HTTP 端口;扩到几个副本时加一层轮询即可——这也是本图与 ④/⑤ 的分水岭。',
      },
      {
        id: 'openai-api',
        detail: '单体形态下由引擎进程自带(vllm serve 一条命令即起),不是独立服务。',
      },
      {
        id: 'continuous-batching',
        group: 'engine-inst',
        detail: '引擎调度器每个解码步重排 running/waiting 队列,批内成员动态进出。',
      },
      {
        id: 'paged-attention',
        group: 'engine-inst',
        detail: 'vLLM 的成名机制;SGLang 等主流引擎均已采用同类分页 KV 管理。',
      },
      {
        id: 'radix-attention',
        group: 'engine-inst',
        detail: 'SGLang 侧的对位能力;vLLM 对应 Automatic Prefix Caching,粒度与自动化程度不同。',
      },
      {
        id: 'quantization',
        group: 'engine-inst',
        detail: '单实例降本第一杠杆:FP8 权重 + FP8 KV 是 Hopper 及之后卡型的常见起手式。',
      },
      {
        id: 'chunked-prefill',
        badge: '可选',
        detail: '单体内缓解 P/D 干扰的软手段:长 prompt 切块与 decode 混跑,TPOT 毛刺立减但干扰仍在——正是 ② 的动机。',
      },
      {
        id: 'kv-hbm',
        detail: '单体形态下 KV 只活在本实例 HBM 里:实例重启即全丢,跨实例不共享。',
      },
      {
        id: 'gpu',
        badge: '×1~8',
        detail: '单机内按显存墙决定 TP 度:70B FP16 两卡起步,量化后可再压。',
      },
      {
        id: 'nvlink',
        detail: '单机 8 卡 NVLink 域就是这张图的容量天花板,再大就要换架构。',
      },
    ],
    groups: [{ id: 'engine-inst', label: 'vLLM / SGLang 实例', lane: 'engine', tone: 'accent' }],
    decision: {
      problem:
        '一张卡/一台机起步,把单实例吞吐榨干:prefill 受算力限制、decode 受带宽限制,请求随到随进、完成即出。',
      benefits: [
        { text: 'continuous batching 相比静态 batch 吞吐至 23x(Anyscale 实测)', sourceIdx: 2 },
        { text: "PagedAttention 消除 KV 碎片,吞吐较此前系统提升 2–4x(SOSP'23)", sourceIdx: 0 },
        { text: "RadixAttention 前缀复用,结构化/多轮场景吞吐至 6.4x(NeurIPS'24)", sourceIdx: 1 },
      ],
      metrics: ['TTFT(首 token 延迟)', 'TPOT/ITL(出字间隔)', '单实例吞吐 tok/s', 'GPU 利用率与显存水位'],
      costs: [
        'prefill 与 decode 同实例混跑互相干扰:长 prompt 会卡住别人的出字',
        '单点无 HA:升级、故障即停服',
        '容量天花板 = 单机 NVLink 域,竖着长(换大卡)有限,横着长要换架构',
      ],
      avoidWhen: [
        '长输入与交互流量混合且 SLO 严格(P/D 干扰无解)',
        '需要多副本容灾或弹性扩缩容',
        '多租户需要隔离与公平性保障',
      ],
      gpuScale: '每实例 1~8 卡(单机 NVLink 域内 TP)',
      memoryPreset: { modelId: 'llama3-70b', gpuId: 'h100', quantId: 'fp16' },
    },
    sources: [
      {
        kind: 'paper',
        title: 'vLLM: Efficient Memory Management for LLM Serving with PagedAttention(SOSP\'23)',
        sourceUrl: 'https://arxiv.org/abs/2309.06180',
        asOf: '2026-08',
      },
      {
        kind: 'paper',
        title: 'SGLang: Efficient Execution of Structured LM Programs(NeurIPS\'24)',
        sourceUrl: 'https://arxiv.org/abs/2312.07104',
        asOf: '2026-08',
      },
      {
        kind: 'blog',
        title: 'Anyscale:How continuous batching enables 23x throughput',
        sourceUrl: 'https://www.anyscale.com/blog/continuous-batching-llm-inference',
        asOf: '2026-08',
      },
      {
        kind: 'blog',
        title: 'Inside vLLM:Anatomy of a High-Throughput LLM Inference System',
        sourceUrl: 'https://vllm.ai/blog/2025-09-05-anatomy-of-vllm',
        asOf: '2026-08',
      },
      {
        kind: 'video',
        title: 'vLLM Office Hours 播放列表(双周引擎内幕讲解)',
        sourceUrl: 'https://www.youtube.com/playlist?list=PLbMP1JcGBmSHxp4-lubU5WYmJ9YgAQcf3',
        asOf: '2026-08',
      },
    ],
    dims: {
      'mono-vs-pd': '单体:P/D 同实例混跑',
      runtime: 'vLLM / SGLang 单实例',
      parallelism: '单机 TP(1~8 卡)',
      batching: 'continuous batching',
      'prefix-kv': '实例内前缀缓存',
      'model-routing': '无(单模型)',
      autoscale: '无,手动扩容',
      replicas: '单副本,无 HA',
      tenancy: '无隔离,共享队列',
      pooling: '不分池',
    },
    meta: {
      minDeploy: '1 台 GPU 服务器(1~8 卡)',
      qpsThreshold: '原型验证 ~ 中小流量',
      network: '单机 NVLink,无跨机要求',
      opsComplexity: 1,
      avoidWhen: '长 prompt 高并发混合负载',
    },
  },
  // ─────── ② PD 分离 ───────
  {
    id: 'pd-disagg',
    name: '② PD 分离',
    tagline: 'prefill 与 decode 分池专职:TTFT 与 TPOT 分而治之,KV 跨池搬运',
    exemplars: 'DistServe · Mooncake(Kimi)· NVIDIA Dynamo · DeepSeek/Meta/Perplexity/Fireworks/Baseten',
    nodes: [
      { id: 'app-client' },
      {
        id: 'openai-api',
        detail: 'Dynamo/Mooncake 形态下是独立 Frontend 进程,与引擎解耦,可多副本。',
      },
      {
        id: 'pd-scheduler',
        detail: '决定「这条请求的 prefill 去哪台、KV 传给哪台 decode」;Mooncake Conductor 还会做 KV 感知的早期拒绝。',
      },
      {
        id: 'sla-planner',
        badge: '可选',
        detail: 'Dynamo Planner 角色:盯 TTFT/TPOT 达标率,动态挪动两池实例配比。',
      },
      {
        id: 'prefill-worker',
        group: 'prefill-pool',
        badge: '×N 实例',
        detail: '长 prompt 独占也无妨——本池只对 TTFT 负责;TP 并行度可以配得比 decode 池高。',
      },
      {
        id: 'decode-worker',
        group: 'decode-pool',
        badge: '×M 实例',
        detail: '收到 KV 后加入本地 continuous batch;大 batch 摊薄权重读取,吞吐显著上行。',
      },
      {
        id: 'kv-hbm',
        detail: '两池各自仍是 paged KV;prefill 产出的 KV 是要跨池搬运的「货物」。',
      },
      {
        id: 'kv-transfer',
        detail: 'NIXL(Dynamo)/Transfer Engine(Mooncake)按层流水传输,与计算重叠隐藏延迟。',
      },
      {
        id: 'gpu',
        variantNote: '异构选卡:prefill 重算力 / decode 重带宽',
        detail: '两池可用不同卡型:算力强的卡进 prefill 池,带宽大的卡进 decode 池,成本效率再上一档。',
      },
      {
        id: 'nvlink',
        detail: '各池实例内部的 TP 仍留在机内 NVLink 域,与 ① 无异。',
      },
      {
        id: 'rdma-net',
        detail: '跨池 KV 流量的承载者:带宽与拓扑决定 KV 搬运能不能藏进计算里。',
      },
    ],
    groups: [
      { id: 'prefill-pool', label: 'Prefill 池(算力型)', lane: 'engine', tone: 'accent' },
      { id: 'decode-pool', label: 'Decode 池(带宽型)', lane: 'engine', tone: 'accent-2' },
    ],
    edges: [
      { from: 'pd-scheduler', to: 'prefill-worker', label: '⇣ 请求拆两段派发(先 P 后 D)', kind: 'control' },
      { from: 'prefill-worker', to: 'decode-worker', label: '⇄ KV 传输(NIXL/RDMA)', kind: 'kv' },
    ],
    vsBaseline: [
      '简单负载均衡被 PD 感知调度器取代:请求先拆成 prefill/decode 两段,再分别派往专职池。',
      '① 的单实例引擎拆成 Prefill/Decode 两池;continuous batching、PagedAttention 等内核能力仍在各池 worker 内部运行,不再单列。',
      'KV 泳道新增传输通道:prefill 产出的 KV 经 NIXL/RDMA 推给 decode 池——这是本架构的命脉,也是主要新增开销。',
      '硬件从同构变可异构:prefill 池选算力强的卡、decode 池选带宽大的卡(GPU 节点亮琥珀的原因)。',
      'chunked prefill 的「软缓解」被物理分池取代:P/D 干扰从调度技巧问题升级为架构问题。',
    ],
    decision: {
      problem:
        'prefill(算力密集)与 decode(带宽密集)混跑互相干扰,TTFT 与 TPOT 无法同时达标;分池后各自专职优化、独立扩缩。',
      benefits: [
        { text: "DistServe:同等资源下 goodput 至 7.4x,或承受 12.6x 更严的 SLO(OSDI'24)", sourceIdx: 0 },
        {
          text: "Mooncake 支撑 Kimi 线上:A800 集群请求处理量 +115%、H800 集群 +107%(FAST'25 最佳论文)",
          sourceIdx: 1,
        },
        { text: '反面参照:P/D 配比与负载不匹配时,吞吐反降 20~30%(BentoML 实测)', sourceIdx: 6 },
      ],
      metrics: ['goodput(SLO 内有效吞吐)', 'TTFT/TPOT 双达标率', 'KV 传输耗时占比', '两池利用率是否均衡'],
      costs: [
        'KV 要跨节点搬运:吃 RDMA 带宽,传输层(NIXL 等)带来新工程复杂度',
        '两池配比成为新调参维度,配错反而不如单体',
        '运维面翻倍:两类实例、两套容量规划、两条扩缩路径',
      ],
      avoidWhen: [
        '流量小,单实例已能同时满足 TTFT/TPOT',
        '输入输出长度比例稳定且干扰不明显(chunked prefill 已够用)',
        '没有 RDMA/高速互联的环境',
      ],
      gpuScale: '两池各 ≥1 实例;实例内 TP 同 ①,池间需 RDMA 级互联',
      memoryPreset: { modelId: 'deepseek-v3', gpuId: 'h200', quantId: 'fp8' },
    },
    sources: [
      {
        kind: 'paper',
        title: "DistServe: Disaggregating Prefill and Decoding for Goodput-optimized LLM Serving(OSDI'24)",
        sourceUrl: 'https://arxiv.org/abs/2401.09670',
        asOf: '2026-08',
      },
      {
        kind: 'paper',
        title: "Mooncake: A KVCache-centric Disaggregated Architecture for LLM Serving(FAST'25 Best Paper)",
        sourceUrl: 'https://arxiv.org/abs/2407.00079',
        asOf: '2026-08',
      },
      {
        kind: 'video',
        title: 'DistServe 作者演讲:Prefill-Decode Disaggregation',
        sourceUrl: 'https://www.youtube.com/watch?v=WwJvecXOeUA',
        asOf: '2026-08',
      },
      {
        kind: 'video',
        title: 'Mooncake 作者演讲(FAST\'25)',
        sourceUrl: 'https://www.youtube.com/watch?v=-Lpx9QuCEsw',
        asOf: '2026-08',
      },
      {
        kind: 'docs',
        title: 'vLLM 官方文档:Disaggregated Prefilling',
        sourceUrl: 'https://docs.vllm.ai/en/stable/features/disagg_prefill/',
        asOf: '2026-08',
      },
      {
        kind: 'docs',
        title: 'SGLang 官方文档:PD Disaggregation',
        sourceUrl: 'https://docs.sglang.ai/advanced_features/pd_disaggregation.html',
        asOf: '2026-08',
      },
      {
        kind: 'blog',
        title: 'BentoML LLM Inference Handbook:Prefill-Decode Disaggregation(含反面数字)',
        sourceUrl: 'https://bentoml.com/llm/inference-optimization/prefill-decode-disaggregation',
        asOf: '2026-08',
      },
      {
        kind: 'blog',
        title: 'Hao AI Lab:Disaggregated Inference, 18 Months Later(全行业采用回顾)',
        sourceUrl: 'https://haoailab.com/blogs/distserve-retro/',
        asOf: '2026-08',
      },
      {
        kind: 'github',
        title: 'kvcache-ai/Mooncake(开源实现)',
        sourceUrl: 'https://github.com/kvcache-ai/Mooncake',
        asOf: '2026-08',
      },
    ],
    dims: {
      'mono-vs-pd': 'PD 分离:两池专职',
      runtime: 'vLLM/SGLang + Dynamo',
      parallelism: '池内 TP,池间异构',
      batching: '两池各自组 batch',
      'prefix-kv': '实例内 + KV 可搬运',
      'model-routing': '无(单模型两池)',
      autoscale: '池配比可调非自动',
      replicas: '池内多 worker',
      tenancy: '无隔离',
      pooling: 'Prefill/Decode 两池',
    },
    meta: {
      minDeploy: '两池各 ≥1 实例 + RDMA 互联',
      qpsThreshold: '高并发且 SLO 严格',
      network: '池间 RDMA/IB(KV 传输)',
      opsComplexity: 4,
      avoidWhen: '流量小或 P/D 干扰不明显',
    },
  },
  // ─────── ③ 大规模专家并行 ───────
  {
    id: 'large-ep',
    name: '③ 大规模专家并行',
    tagline: '把 MoE 的专家摊到上百 GPU:以粗粒度部署单元换极致吞吐与成本',
    exemplars: 'DeepSeek V3/R1 线上系统 · SGLang 大规模 EP 复现 · Meta(TP/CP/EP 组合)',
    nodes: [
      {
        id: 'app-client',
        detail: '线上负载昼夜差极大:白天全量服务,夜间空闲节点转做研究训练——错峰本身就是这套架构成本账的一部分。',
      },
      {
        id: 'openai-api',
        detail: '面向公网的 chat/API 服务入口;本图的全部戏份在它身后的超大规模引擎层。',
      },
      {
        id: 'pd-scheduler',
        variantNote: '调度原子从实例升格为多节点部署单元',
        detail: '请求先到 prefill 单元算 KV,再交 decode 单元出字;扩缩容与故障处理都以单元为粒度。',
      },
      {
        id: 'eplb',
        detail: '按专家实际热度动态复制/重排专家副本;prefill 与 decode 阶段采用不同的均衡策略。',
      },
      {
        id: 'prefill-worker',
        group: 'prefill-unit',
        badge: 'EP32 · 32 GPU',
        variantNote: '不再是单机实例:多节点 EP 分片构成一个单元',
        detail: '一个 prefill 单元 = 4 节点 32 GPU:注意力 DP32、路由专家 EP32;长输入的算力洪峰由整单元分摊。',
      },
      {
        id: 'mla-attention',
        group: 'decode-unit',
        badge: 'DP144',
        detail: '每 GPU 复制一份注意力部,各自服务本卡的请求批;MLA 的 latent KV 让单卡能挂更多并发。',
      },
      {
        id: 'routed-experts',
        group: 'decode-unit',
        badge: 'EP144',
        detail: '一个 decode 单元 = 18 节点 144 GPU,路由专家摊薄到全单元,每卡只驻留少数专家;热点专家由 EPLB 增设副本。',
      },
      {
        id: 'shared-expert',
        group: 'decode-unit',
        badge: 'DP144',
        detail: '与注意力部同址复制,每 token 必经;不产生跨卡路由流量。',
      },
      {
        id: 'kv-hbm',
        detail: 'MLA 把 KV 压成 latent 向量,单请求 KV 远小于同级稠密模型——这是 decode 大 batch 的前提之一。',
      },
      {
        id: 'kv-transfer',
        detail: 'prefill 单元产出的 KV 传给 decode 单元,与 ② 同型;传输粒度同样是「单元对单元」。',
      },
      {
        id: 'kv-ssd',
        detail: '3FS 风格的分布式盘上缓存:历史上下文命中即免重算——超大流量下磁盘命中率相当可观(数字见决策卡)。',
      },
      {
        id: 'ep-alltoall',
        detail: 'DeepEP 的 dispatch/combine 内核:节点内走 NVLink、跨节点走 RDMA,用双 microbatch 重叠把通信藏进计算。',
      },
      {
        id: 'gpu',
        variantNote: '同构大集群:数百节点同卡型整建制部署',
        badge: 'H800 集群',
        detail: '与 ② 的「两池异构选卡」相反:EP 要求单元内完全同构,规模效应压倒卡型精挑。',
      },
      {
        id: 'nvlink',
        detail: '单元内每节点 8 卡 NVLink;all-to-all 的节点内部分尽量走这里。',
      },
      {
        id: 'rdma-net',
        detail: '跨节点 all-to-all 与单元间 KV 传输的承载:IB 集群网络在这张图里是一等公民。',
      },
    ],
    groups: [
      { id: 'prefill-unit', label: 'Prefill 单元 ×4 节点', lane: 'engine', tone: 'accent' },
      { id: 'decode-unit', label: 'Decode 单元 ×18 节点', lane: 'engine', tone: 'accent-2' },
    ],
    edges: [
      { from: 'pd-scheduler', to: 'prefill-worker', label: '⇣ 按单元派发:先 P 单元后 D 单元', kind: 'control' },
      { from: 'eplb', to: 'routed-experts', label: '⇣ 热点专家增设副本/重排放置', kind: 'control' },
      { from: 'prefill-worker', to: 'mla-attention', label: '⇄ KV 单元间传输(RDMA)', kind: 'kv' },
      { from: 'routed-experts', to: 'ep-alltoall', label: '每层 MoE:token 散发/聚合走 all-to-all', kind: 'data' },
    ],
    vsBaseline: [
      '引擎从「单机实例」变成「多节点部署单元」:prefill 四节点一组、decode 十八节点一组,单元才是扩缩容与故障的基本粒度。',
      '并行策略换轴:① 是单机 TP;这里注意力/共享专家走 DP 复制、路由专家走 EP 切分,两套并行解耦运转。',
      '编排层新增 EPLB:EP 下专家冷热不均会让最热的卡拖慢全单元,负载均衡从优化项变成生存项。',
      '基础设施新增 all-to-all 通信(DeepEP):每层 MoE 都要跨卡散发/聚合 token,网络从「部署条件」变成「每步前向的参与者」。',
      'KV 泳道加了磁盘缓存:超大流量下历史上下文命中率可观,盘上 KV 直接抵掉一大块 prefill 算力。',
    ],
    decision: {
      problem:
        '总参数巨大、激活稀疏的 MoE(DeepSeek V3/R1 级)单机放不下也跑不起:用专家并行把数百个专家摊到上百 GPU,以粗粒度部署单元换极致吞吐与成本。',
      benefits: [
        { text: '官方披露:H800 单节点 prefill ~73.7k 输入 tok/s、decode ~14.8k 输出 tok/s', sourceIdx: 0 },
        {
          text: '峰值 278 节点、日成本 $87,072,理论成本利润率 545%(理论值:官方声明实际收入远低于此)',
          sourceIdx: 0,
        },
        { text: '磁盘 KV 缓存命中率 56.3%,命中的前缀直接免算', sourceIdx: 0 },
        { text: 'SGLang 96×H100 复现:每节点 52.3k 输入 / 22.3k 输出 tok/s,相比朴素 TP 输出吞吐至 5x', sourceIdx: 1 },
      ],
      metrics: [
        '单节点输入/输出吞吐 tok/s',
        '专家负载均衡度(最热卡 vs 平均)',
        'all-to-all 通信耗时占比',
        '单元故障率与重建时长',
      ],
      costs: [
        '部署单元粒度极粗:decode 单元一开就是 18 节点 144 GPU,弹性几乎为零',
        '故障域大:单元内任一节点出问题,整单元受影响',
        '仅对 MoE 架构成立:稠密模型没有「专家」可切',
        '专家负载不均与 all-to-all 通信是常驻工程战场,需要 EPLB/DeepEP 级的持续投入',
      ],
      avoidWhen: [
        '模型是稠密架构,无专家可并行',
        '流量撑不满一个部署单元(大 batch 是本架构的前提)',
        '没有整建制 GPU 集群与 IB 网络的团队',
      ],
      gpuScale: '部署单元为原子:P 单元 32 GPU + D 单元 144 GPU 起',
      memoryPreset: { modelId: 'deepseek-v3', gpuId: 'h100', quantId: 'fp8' },
    },
    sources: [
      {
        kind: 'github',
        title: 'DeepSeek V3/R1 推理系统概览(官方,Open Source Week Day 6)',
        sourceUrl:
          'https://github.com/deepseek-ai/open-infra-index/blob/main/202502OpenSourceWeek/day_6_one_more_thing_deepseekV3R1_inference_system_overview.md',
        asOf: '2026-08',
      },
      {
        kind: 'blog',
        title: 'SGLang:Deploying DeepSeek with Large-scale Expert Parallelism(96×H100 复现)',
        sourceUrl: 'https://www.lmsys.org/blog/2025-05-05-large-scale-ep/',
        asOf: '2026-08',
      },
      {
        kind: 'github',
        title: 'deepseek-ai/DeepEP(专家并行 all-to-all 通信库)',
        sourceUrl: 'https://github.com/deepseek-ai/DeepEP',
        asOf: '2026-08',
      },
      {
        kind: 'blog',
        title: 'Meta 工程博客:Scaling LLM Inference(TP/CP/EP 并行实践)',
        sourceUrl:
          'https://engineering.fb.com/2025/10/17/ai-research/scaling-llm-inference-innovations-tensor-parallelism-context-parallelism-expert-parallelism/',
        asOf: '2026-08',
      },
    ],
    dims: {
      'mono-vs-pd': 'PD 分离(单元粒度)',
      runtime: '自研引擎/SGLang 复现',
      parallelism: '注意力 DP + 专家 EP',
      batching: '单元内超大 batch',
      'prefix-kv': '磁盘 KV 命中免算',
      'model-routing': '无(单模型)',
      autoscale: '单元粒度,近乎无弹性',
      replicas: '单元 ×N,数百节点级',
      tenancy: '无隔离',
      pooling: 'P/D 单元 + 专家分片',
    },
    meta: {
      minDeploy: '≥22 节点(P4 + D18,176 GPU)',
      qpsThreshold: '超大规模(日千亿 token 级)',
      network: '整建制 IB + 节点内 NVLink',
      opsComplexity: 5,
      avoidWhen: '稠密模型或流量喂不饱单元',
    },
  },
  // ─────── ④ K8s 多副本编排 + 自动扩缩容 ───────
  {
    id: 'k8s-autoscale',
    name: '④ K8s 编排与自动扩缩容',
    tagline: '把「几个副本、放在哪、何时增减」交给控制面:常态省卡,峰值扛住',
    exemplars: 'llm-d · AIBrix(字节跳动)· vLLM production-stack · Perplexity(20+ 模型)',
    nodes: [
      {
        id: 'app-client',
        detail: '流量随业务潮汐波动:白天峰值与凌晨低谷可差数倍——弹性正是本图要解决的问题。',
      },
      {
        id: 'lb',
        detail: 'K8s Service/Ingress 形态的入口;智能路由不是本图重点(见 ⑤),这里先解决「副本数量对不对」。',
      },
      {
        id: 'openai-api',
        detail: '每个引擎副本自带端点,由 Service 统一暴露;也可由网关聚合(与 ⑤ 组合)。',
      },
      {
        id: 'k8s-operator',
        detail: 'llm-d/AIBrix/production-stack 三大开源栈同一形态:CRD 声明「要什么」,Operator 负责「变成这样」。',
      },
      {
        id: 'keda-autoscaler',
        detail: '常用信号:等待队列长度、KV 显存水位、TTFT 分位数;信号驱动副本数 N 增减。',
      },
      {
        id: 'gpu-scheduler',
        detail: '为新副本挑节点:凑齐同机多卡、避开碎片、按队列配额排队(Kueue、KAI-Scheduler 属此类)。',
      },
      {
        id: 'warm-start',
        detail: '权重预热、镜像预拉、暖池待命;冷启动每短一分钟,扩容就敢晚一分钟触发,常备水位就能低一档。',
      },
      {
        id: 'engine-replica',
        group: 'replica-set',
        badge: '×N(弹性)',
        detail: '无状态副本,由 Deployment/CR 管理:进出集群不带 KV 迁移;每个副本内部就是完整的 ①。',
      },
      {
        id: 'engine-metrics',
        group: 'replica-set',
        detail: 'vLLM/SGLang 原生暴露 Prometheus 指标;它是 KEDA 与智能路由共同的数据源。',
      },
      {
        id: 'kv-hbm',
        detail: '各副本私有 KV,互不共享;副本缩容时缓存随之蒸发——这是与 ⑥ 组合的动机。',
      },
      {
        id: 'gpu',
        badge: '×N 节点',
        detail: 'GPU 节点池可多卡型混布,由调度器按副本诉求匹配。',
      },
      {
        id: 'nvlink',
        detail: '副本内 TP 仍需机内 NVLink;调度器要保证副本不被拆到跨机。',
      },
    ],
    groups: [{ id: 'replica-set', label: 'vLLM 引擎副本 ×N', lane: 'engine', tone: 'accent' }],
    edges: [
      { from: 'k8s-operator', to: 'engine-replica', label: '⇣ 声明式对账:创建/升级/自愈副本', kind: 'control' },
      { from: 'keda-autoscaler', to: 'engine-replica', label: '⇣ watch/scale:按指标增减副本数 N', kind: 'control' },
      { from: 'engine-metrics', to: 'keda-autoscaler', label: '排队深度/KV 水位/TTFT 指标上报', kind: 'data' },
    ],
    vsBaseline: [
      '编排泳道从空白变主角:Operator 声明式管理副本生命周期,①「手动起一个进程」升级为「集群自动维持 N 个副本」。',
      '扩缩容有了自动闭环:引擎暴露排队深度/KV 水位等指标,KEDA 据此增减副本——CPU 利用率式 HPA 对 LLM 无效,自定义指标是成败关键。',
      '引擎内部机制不再单列:整套 ① 被打包成「引擎副本」原子,上层只关心副本数量与放置。',
      '新增 GPU 感知调度与冷启动优化:副本能不能及时调度上卡、几分钟能就绪,决定弹性是真是假。',
      '代价换位:① 担心单点故障,这里担心控制面自身复杂度与「扩容追不上突发」。',
    ],
    decision: {
      problem:
        '流量有潮汐、模型有多套,人肉扩缩既慢又浪费:把副本数量与放置交给指标驱动的控制面,常态省卡、峰值扛住、故障自愈。',
      benefits: [
        { text: 'llm-d 8 pods/16×H100:相比 round-robin 基线 TTFT 优 57x、吞吐 ~2x', sourceIdx: 1 },
        { text: 'llm-d 智能调度下高负载 ITL ~30ms,基线约 160ms', sourceIdx: 0 },
        { text: 'AIBrix(字节跳动生产)分布式 KV 复用:吞吐 +50%、延迟 -70%', sourceIdx: 2 },
        { text: 'Perplexity 以 K8s 编排支撑 20+ 模型、月 4 亿请求', sourceIdx: 6 },
      ],
      metrics: [
        '扩容触发到副本可服务的端到端时长(含冷启动)',
        '常态 GPU 空置率 vs 峰值排队深度',
        'TTFT/ITL 分位数(扩缩前后对比)',
        '每千 token 成本',
      ],
      costs: [
        '控制面本身成为工程负担:Operator/CRD/指标管道都要有人维护',
        '原生 HPA 对 LLM 失效,必须自建自定义指标链路',
        '副本冷启动数分钟(拉镜像 + 载权重),突发流量仍可能击穿',
        '缩容会蒸发副本内 KV 缓存,忽冷忽热的流量下反复冷启动',
      ],
      avoidWhen: [
        '流量平稳,固定副本数就够',
        '规模只有一两台机器,K8s 是杀鸡用牛刀',
        '团队没有 K8s 运维经验(控制面故障比引擎故障更难排)',
      ],
      gpuScale: '副本内 1~8 卡;节点池按峰值容量规划',
      memoryPreset: { modelId: 'llama3-70b', gpuId: 'h100', quantId: 'fp8' },
    },
    sources: [
      {
        kind: 'blog',
        title: 'llm-d:Intelligent Inference Scheduling(智能调度基准)',
        sourceUrl: 'https://llm-d.ai/blog/intelligent-inference-scheduling-with-llm-d',
        asOf: '2026-08',
      },
      {
        kind: 'blog',
        title: 'llm-d v0.2:Our First Well-lit Paths(8 pods/16×H100 基准)',
        sourceUrl: 'https://llm-d.ai/blog/llm-d-v0.2-our-first-well-lit-paths',
        asOf: '2026-08',
      },
      {
        kind: 'paper',
        title: 'AIBrix: Towards Scalable, Cost-Effective LLM Inference Infrastructure',
        sourceUrl: 'https://arxiv.org/abs/2504.03648',
        asOf: '2026-08',
      },
      {
        kind: 'github',
        title: 'vllm-project/aibrix(字节跳动开源控制面)',
        sourceUrl: 'https://github.com/vllm-project/aibrix',
        asOf: '2026-08',
      },
      {
        kind: 'github',
        title: 'vllm-project/production-stack(K8s 参考部署栈)',
        sourceUrl: 'https://github.com/vllm-project/production-stack',
        asOf: '2026-08',
      },
      {
        kind: 'docs',
        title: 'vLLM production-stack 文档:KEDA 自动扩缩容',
        sourceUrl: 'https://docs.vllm.ai/projects/production-stack/en/latest/use_cases/autoscaling-keda.html',
        asOf: '2026-08',
      },
      {
        kind: 'blog',
        title: 'NVIDIA 案例研究:Perplexity AI',
        sourceUrl: 'https://www.nvidia.com/en-us/case-studies/perplexity',
        asOf: '2026-08',
      },
    ],
    dims: {
      'mono-vs-pd': '副本单体(可组合 PD)',
      runtime: 'vLLM + Operator 栈',
      parallelism: '副本内 TP × 副本 DP',
      batching: '副本内 continuous',
      'prefix-kv': '副本私有,缩容即失',
      'model-routing': '每模型一组 CR/副本',
      autoscale: 'KEDA 自定义指标驱动',
      replicas: '×N 自动增减 + 自愈',
      tenancy: 'namespace/配额级',
      pooling: '按模型分组,不分池',
    },
    meta: {
      minDeploy: 'K8s 集群 + ≥2 GPU 节点',
      qpsThreshold: '流量潮汐明显的中大规模',
      network: '机房内网;副本间无 KV 流量',
      opsComplexity: 4,
      avoidWhen: '流量平稳或无 K8s 运维能力',
    },
  },
  // ─────── ⑤ 智能路由与多租户网关 ───────
  {
    id: 'router-tenant',
    name: '⑤ 智能路由与多租户网关',
    tagline: '请求进引擎前先做对三件事:配额公平、模型分级、缓存感知派发',
    exemplars: 'SGLang router · NVIDIA Dynamo(Baseten)· Gateway API Inference Extension · vLLM cache_salt',
    nodes: [
      {
        id: 'app-client',
        variantNote: '多租户:多业务方共享同一服务入口',
        detail: '内部平台典型形态:搜索、客服、Agent 等多个业务共用一个 GPU 池,各有各的 SLO 与预算。',
      },
      {
        id: 'openai-api',
        detail: '对所有租户暴露同一套标准接口;租户身份靠 API Key/Header 区分,进入网关判定。',
      },
      {
        id: 'tenant-gateway',
        detail:
          '如实标注:多租户限流配额(RPM/TPM/并发)的业界一手公开资料非常稀缺,各家线上实现细节鲜有披露——本节点为业界通识性描述,数字化收益以缓存感知路由为主。',
      },
      {
        id: 'model-router',
        detail: '常见分法:FAQ/改写走小模型,推理/代码走旗舰;也可按租户等级绑定模型档位。',
      },
      {
        id: 'kv-router',
        detail: 'SGLang router 用近似基数树跟踪各副本前缀;Dynamo 用 KV 事件 + 重叠度打分,同时看命中与负载。',
      },
      {
        id: 'gw-inference-ext',
        detail: 'K8s 官方给「懂推理的路由」定的标准接口:网关收请求后问 EPP 选端点,EPP 背后就是各家调度算法。',
      },
      {
        id: 'engine-replica',
        group: 'replica-pool',
        badge: '×N',
        detail: '同池副本可同模型多份,也可大小模型混布(配合模型分级路由);副本内部仍是完整的 ①。',
      },
      {
        id: 'prefix-cache',
        variantNote: '按 cache_salt 分租户命名空间',
        detail:
          'vLLM 的 cache_salt 把租户标识拌进前缀哈希:租户间互不命中,防止跨租户前缀探测;代价是集群整体命中率下降。',
      },
      {
        id: 'kv-hbm',
        detail: '副本内 KV 与 ① 无异;路由层的目标就是让请求落在「已有它前缀 KV」的副本上。',
      },
      {
        id: 'gpu',
        detail: '整池 GPU 被多租户共享;配额与路由共同决定「谁在什么时候用到卡」。',
      },
      {
        id: 'nvlink',
        detail: '副本内并行需求同 ①;本图的重点在卡之上的流量治理。',
      },
    ],
    groups: [{ id: 'replica-pool', label: '推理副本池 ×N', lane: 'engine', tone: 'accent' }],
    edges: [
      { from: 'tenant-gateway', to: 'model-router', label: '配额放行后按意图/等级选模型档位', kind: 'data' },
      { from: 'kv-router', to: 'engine-replica', label: '⇣ 按前缀命中 + 负载兜底挑选副本', kind: 'control' },
      { from: 'gw-inference-ext', to: 'engine-replica', label: '⇣ EPP 端点挑选(标准化路由接口)', kind: 'control' },
    ],
    vsBaseline: [
      '接入泳道从「一个可选的轮询 LB」长成三级流量治理:配额网关 → 模型分级路由 → KV 感知路由,请求进引擎前先过三道决策。',
      '「负载均衡毁掉前缀缓存」被正面解决:路由器维护各副本前缀视图,同前缀请求定向聚拢,集群命中率逼近单机。',
      '多租户成为一等公民:RPM/TPM/并发配额保证公平,cache_salt 把前缀缓存按租户隔离——公平与隔离都要花性能买。',
      '编排层出现标准化接口(Gateway API Inference Extension):路由智能与网关实现解耦,自研调度算法可插拔。',
      '引擎层反而最平静:副本内部与 ① 无异,本图的全部增量都发生在「卡之前」的流量层。',
    ],
    decision: {
      problem:
        '多业务方共享 GPU 池:没有配额会互相踩踏,盲轮询会毁掉前缀缓存,单一模型档位会把简单流量也烧在旗舰卡上——在请求进引擎之前把这三件事做对。',
      benefits: [
        { text: 'SGLang cache-aware router:吞吐 +1.9x、前缀命中率 +3.8x', sourceIdx: 0 },
        { text: 'llm-d 智能调度:高负载下 SLO 内成功率 100%,轮询基线仅 ~55%', sourceIdx: 4 },
        { text: 'Baseten 接入 Dynamo(含 KV 感知路由):推理速度 2x', sourceIdx: 2 },
        { text: '模型分级路由把简单请求从旗舰模型剥离,是成本曲线上最陡的一段优化(收益随流量构成而异)' },
      ],
      metrics: [
        '集群前缀命中率 vs 单机命中率',
        '各租户配额使用率与被限流次数',
        '路由决策耗时(含 tokenize 前置开销)',
        '大小模型流量占比与每请求成本',
      ],
      costs: [
        '路由器要先 tokenize 才能查前缀树:每条请求新增一次前置开销',
        '路由器的近似前缀树与副本真实 KV 会漂移:命中判断只是猜测,需要持续校准',
        '缓存感知会把热前缀聚到少数副本:必须留负载兜底策略,否则热点副本被打爆',
        'cache_salt 租户隔离直接损失跨租户命中率:安全与效率在此明码标价',
      ],
      avoidWhen: [
        '单租户单模型:一层简单 LB 足矣',
        '前缀重复率低,缓存感知路由无米下锅',
        '流量极小,路由层开销占比反而显眼',
      ],
      gpuScale: '副本池 ≥2 实例起;router 本身不占 GPU',
      memoryPreset: { modelId: 'qwen3-235b', gpuId: 'h100', quantId: 'fp8' },
    },
    sources: [
      {
        kind: 'blog',
        title: 'SGLang v0.4:Cache-Aware Load Balancer(router 实测数字)',
        sourceUrl: 'https://www.lmsys.org/blog/2024-12-04-sglang-v0-4/',
        asOf: '2026-08',
      },
      {
        kind: 'docs',
        title: 'NVIDIA Dynamo:KV Cache-Aware Routing',
        sourceUrl: 'https://docs.nvidia.com/dynamo/user-guides/kv-cache-aware-routing',
        asOf: '2026-08',
      },
      {
        kind: 'blog',
        title: 'Baseten:How we achieved 2x faster inference with NVIDIA Dynamo',
        sourceUrl: 'https://www.baseten.co/blog/how-baseten-achieved-2x-faster-inference-with-nvidia-dynamo/',
        asOf: '2026-08',
      },
      {
        kind: 'blog',
        title: 'Kubernetes 官方博客:Introducing Gateway API Inference Extension',
        sourceUrl: 'https://kubernetes.io/blog/2025/06/05/introducing-gateway-api-inference-extension/',
        asOf: '2026-08',
      },
      {
        kind: 'blog',
        title: 'llm-d:Intelligent Inference Scheduling(SLO 成功率对比)',
        sourceUrl: 'https://llm-d.ai/blog/intelligent-inference-scheduling-with-llm-d',
        asOf: '2026-08',
      },
      {
        kind: 'docs',
        title: 'vLLM 设计文档:Automatic Prefix Caching(含 cache_salt 租户隔离)',
        sourceUrl: 'https://docs.vllm.ai/en/stable/design/prefix_caching/',
        asOf: '2026-08',
      },
    ],
    dims: {
      'mono-vs-pd': '正交:副本形态不限',
      runtime: '引擎 + 独立 router',
      parallelism: '副本内不变',
      batching: '副本内 continuous',
      'prefix-kv': '路由级前缀树感知',
      'model-routing': '意图/等级分级路由',
      autoscale: '可与 ④ 叠加',
      replicas: '×N + 智能派发',
      tenancy: '配额 + cache_salt',
      pooling: '按模型档位分组',
    },
    meta: {
      minDeploy: 'router + ≥2 副本',
      qpsThreshold: '多业务方共享 GPU 池时',
      network: '机房内网即可',
      opsComplexity: 3,
      avoidWhen: '单租户单模型小流量',
    },
  },
  // ─────── ⑥ KV Cache 分层 ───────
  {
    id: 'kv-tier',
    name: '⑥ KV Cache 分层',
    tagline: '算过的 KV 层层留住:HBM → DRAM → SSD → 远端池,用存储换算力',
    exemplars: 'Mooncake Store · LMCache · Character.AI · DeepSeek 磁盘缓存',
    nodes: [
      {
        id: 'app-client',
        detail: '多轮对话、文档反复问答、Agent 循环——这类「旧前缀不断回来」的负载是分层缓存的主场。',
      },
      {
        id: 'openai-api',
        detail: '接口形态不变;会话是否复用历史前缀,对调用方完全透明。',
      },
      {
        id: 'kv-router',
        detail: '这里的路由不只看「哪个副本有缓存」,还看「缓存躺在哪一层」:HBM 命中最优,DRAM/SSD 次之,都强于重算。',
      },
      {
        id: 'engine-replica',
        badge: '×N',
        detail: '副本本身与 ① 无异;差别在它的 KV 有了「显存之外的去处」。',
      },
      {
        id: 'kv-hbm',
        badge: 'L1 · 最快最小',
        detail: '活跃请求的 KV 留在这里;空间紧张时冷前缀按 LRU 等策略逐出到下一层,而不是直接丢弃。',
      },
      {
        id: 'kv-dram',
        badge: 'L2 · PCIe 可达',
        detail: 'Character.AI 的跨轮缓存、LMCache 的 CPU offload 都落在这层:容量比 HBM 大一个量级,回填走 PCIe。',
      },
      {
        id: 'kv-ssd',
        badge: 'L3 · 温数据',
        detail: '隔小时、隔天回来的会话在这层接住;DeepSeek 的磁盘上下文缓存证明了盘级命中的规模价值。',
      },
      {
        id: 'kv-pooled',
        badge: 'L4 · 集群共享',
        detail: 'Mooncake Store/LMCache 远端池:任何副本算过的 KV 全集群可取,「以存换算」的完整形态。',
      },
      {
        id: 'gpu',
        detail: '引擎侧卡数不因分层而变;变的是每张卡「重复算旧前缀」的时间占比。',
      },
      {
        id: 'rdma-net',
        detail: 'L4 远端池的搬运通道:没有高速网络,「取回」就会慢到不如重算。',
      },
    ],
    edges: [
      { from: 'kv-hbm', to: 'kv-dram', label: '满则下沉:冷前缀逐出到 DRAM,命中经 PCIe 回填', kind: 'data' },
      { from: 'kv-dram', to: 'kv-ssd', label: '温数据继续下沉:隔天会话从盘上读回', kind: 'data' },
      { from: 'kv-ssd', to: 'kv-pooled', label: '池化共享:跨副本取用、副本重启不丢', kind: 'data' },
      { from: 'kv-router', to: 'engine-replica', label: '⇣ 把请求派往它的缓存所在的副本', kind: 'control' },
    ],
    vsBaseline: [
      'KV 从「一格」长成「四级」:① 的 KV 只活在 HBM、实例重启即灰飞烟灭;这里 HBM 只是塔尖,身后站着 DRAM/SSD/远端池。',
      '缓存语义升级:逐出不再等于丢弃——冷前缀逐级下沉,旧会话回来时逐级查找、按需回填,「读缓存比重算便宜」贯穿每一层。',
      '接入层加了缓存感知调度:请求要被送到「它的 KV 躺着的地方」,否则分层白建。',
      'KV 从实例私产变集群资产(L4):跨副本复用、重启不丢,这是 ① 完全没有的能力。',
      '新代价随之而来:miss 时逐级查找延迟放大;模型/量化一变,全体缓存作废重建。',
    ],
    decision: {
      problem:
        '前缀重复率高的负载里,同样的 prefill 被一算再算:把算过的 KV 层层留住,用便宜的存储容量换昂贵的 GPU 算力。',
      benefits: [
        {
          text: 'Character.AI:跨轮 host memory 缓存命中率 95%,叠加注意力结构优化 KV 总量减 20x 以上,服务成本自 2022 底降 33x',
          sourceIdx: 0,
        },
        { text: 'DeepSeek 线上:磁盘 KV 缓存命中率 56.3%', sourceIdx: 1 },
        {
          text: "Mooncake「以存换算」:KV 池化支撑 Kimi 线上集群处理量 +115%(A800)/+107%(H800)(FAST'25 最佳论文)",
          sourceIdx: 2,
        },
      ],
      metrics: [
        '各级命中率(HBM/DRAM/SSD/远端)',
        '回填耗时 vs 重算耗时(回填必须更快)',
        'TTFT 分布(命中与 miss 两条曲线)',
        '缓存存储成本 vs 省下的 GPU 成本',
      ],
      costs: [
        'DRAM/SSD 容量与 PCIe/网络带宽被 KV 挤占,与其他负载争资源',
        'miss 时逐级查找,延迟被放大:最坏路径比无缓存还慢',
        '模型版本、量化方式、tokenizer 一变,全体缓存整体失效',
        '共享缓存池存在跨租户侧信道风险(命中时序可被探测),多租户需配合 cache_salt 类隔离',
      ],
      avoidWhen: [
        '一次性负载,前缀几乎不重复(批量翻译、离线抽取)',
        '存储与网络成本高于省下的算力(小规模常见)',
        '合规要求会话数据即用即焚',
      ],
      gpuScale: '不改变引擎侧卡数;新增 DRAM/SSD/存储节点预算',
      memoryPreset: { modelId: 'kimi-k2', gpuId: 'h200', quantId: 'fp8' },
    },
    sources: [
      {
        kind: 'blog',
        title: 'Character.AI:Optimizing AI Inference(95% 命中率与成本曲线)',
        sourceUrl: 'https://blog.character.ai/optimizing-ai-inference-at-character-ai-2/',
        asOf: '2026-08',
      },
      {
        kind: 'github',
        title: 'DeepSeek V3/R1 推理系统概览(磁盘 KV 命中率)',
        sourceUrl:
          'https://github.com/deepseek-ai/open-infra-index/blob/main/202502OpenSourceWeek/day_6_one_more_thing_deepseekV3R1_inference_system_overview.md',
        asOf: '2026-08',
      },
      {
        kind: 'paper',
        title: "Mooncake: A KVCache-centric Disaggregated Architecture(FAST'25 Best Paper)",
        sourceUrl: 'https://arxiv.org/abs/2407.00079',
        asOf: '2026-08',
      },
      {
        kind: 'paper',
        title: 'LMCache: An Efficient KV Cache Layer for Enterprise-Scale LLM Inference',
        sourceUrl: 'https://arxiv.org/pdf/2510.09665',
        asOf: '2026-08',
      },
      {
        kind: 'blog',
        title: 'LMCache 官方博客',
        sourceUrl: 'https://blog.lmcache.ai',
        asOf: '2026-08',
      },
      {
        kind: 'blog',
        title: 'llm-d:KV Cache Wins You Can See',
        sourceUrl: 'https://llm-d.ai/blog/kvcache-wins-you-can-see',
        asOf: '2026-08',
      },
      {
        kind: 'blog',
        title: 'BentoML Handbook:Prefix Caching(显存挤占的代价面)',
        sourceUrl: 'https://bentoml.com/llm/inference-optimization/prefix-caching',
        asOf: '2026-08',
      },
      {
        kind: 'video',
        title: "Mooncake 作者演讲(FAST'25)",
        sourceUrl: 'https://www.youtube.com/watch?v=-Lpx9QuCEsw',
        asOf: '2026-08',
      },
    ],
    dims: {
      'mono-vs-pd': '正交:各形态可叠加',
      runtime: '引擎 + LMCache 类',
      parallelism: '同 ①,不受影响',
      batching: 'continuous batching',
      'prefix-kv': '4 级分层 + 集群共享',
      'model-routing': '无',
      autoscale: '存储层独立扩容',
      replicas: '×N,缓存跨副本共享',
      tenancy: '共享池需防侧信道',
      pooling: 'KV 独立成池(L4)',
    },
    meta: {
      minDeploy: '副本 + 大内存节点即可起步',
      qpsThreshold: '重复前缀占比高的流量',
      network: 'L4 远端池需 RDMA 级',
      opsComplexity: 3,
      avoidWhen: '前缀不重复的一次性负载',
    },
  },
  // ─────── ⑦ RAG 分池 ───────
  {
    id: 'rag-pools',
    name: '⑦ RAG 分池',
    tagline: '按资源画像分池:小卡喂检索、大卡喂生成,四条弹性曲线各走各的',
    exemplars: 'HF TEI(embedding/rerank)· vLLM(生成)· Harmonia(RAG 分池调度研究)',
    nodes: [
      {
        id: 'app-client',
        detail: 'RAG 产品形态:知识库问答、企业搜索、带引用的写作助手;一次用户提问在后端展开成一串模型调用。',
      },
      {
        id: 'openai-api',
        detail: '对外仍是一个问答接口;内部的多跳编排对调用方透明。',
      },
      {
        id: 'rag-pipeline',
        detail: '放大系数在这里定型:一次提问展开为向量化、检索、候选重排、生成等多跳调用——各池容量按这条链路的调用配比规划。',
      },
      {
        id: 'keda-autoscaler',
        variantNote: '按池独立扩缩:各池弹性曲线互不相同',
        detail: 'embed 随检索量走、rerank 随候选数走、LLM 随会话长度走——一条扩缩策略喂不饱四个池。',
      },
      {
        id: 'embed-worker',
        group: 'pool-embed',
        badge: '小卡 ×N',
        detail: '短文本单次前向、毫秒级返回;TEI 用动态组批把高并发揉成大 batch,一张小卡吞吐就相当可观。',
      },
      {
        id: 'rerank-worker',
        group: 'pool-rerank',
        badge: '小卡 ×N',
        detail: 'top-k 候选逐对打分,负载随候选数波动大;与 embed 同为 encoder 型,但计算量高一档。',
      },
      {
        id: 'engine-replica',
        group: 'pool-llm',
        badge: '大卡 ×N',
        detail: '生成主力:decoder-only 长序列 + KV cache,资源画像与左边两池完全不同——这正是分池的根本原因。',
      },
      {
        id: 'vlm-worker',
        group: 'pool-vlm',
        badge: '大卡 ×少量',
        detail: '图文混合问答才走这里:请求少而重,独立成池避免长尾拖累主链路。',
      },
      {
        id: 'vector-db',
        detail: '通常由 CPU 集群承载;容量要与 embed 池联动规划——索引重建时 embed 流量会暴增。',
      },
      {
        id: 'kv-hbm',
        detail: '只有 LLM/VLM 池才有 KV cache;encoder 池无自回归、无 KV——这条不对称就是资源画像差异的核心。',
      },
      {
        id: 'gpu',
        variantNote: '异构:小卡跑 embed/rerank,大卡跑 LLM',
        detail: '推理小卡(A10/L4 级)跑 encoder 池绰绰有余;H 系大卡集中给生成——异构选卡是 RAG 成本优化的主战场。',
      },
      {
        id: 'nvlink',
        detail: '仅 LLM/VLM 池的多卡 TP 需要;encoder 池单卡即跑,谈不上互联。',
      },
    ],
    groups: [
      { id: 'pool-embed', label: 'Embedding 池(TEI)', lane: 'engine', tone: 'accent' },
      { id: 'pool-rerank', label: 'Reranker 池', lane: 'engine', tone: 'accent-2' },
      { id: 'pool-llm', label: 'LLM 生成池', lane: 'engine', tone: 'ok' },
      { id: 'pool-vlm', label: 'VLM 多模态池', lane: 'engine', tone: 'warn' },
    ],
    edges: [
      { from: 'rag-pipeline', to: 'embed-worker', label: '链路第一跳:问题向量化', kind: 'data' },
      { from: 'embed-worker', to: 'vector-db', label: '相似度检索,召回 top-k 候选', kind: 'data' },
      { from: 'rerank-worker', to: 'engine-replica', label: '重排后的上下文交给生成池', kind: 'data' },
      { from: 'keda-autoscaler', to: 'embed-worker', label: '⇣ 各池独立扩缩(信号各不相同)', kind: 'control' },
    ],
    vsBaseline: [
      '引擎泳道从一个实例裂成四个池:embed/rerank/LLM/VLM 各配 runtime、各自组批、各自扩缩——按资源画像分池,而不是按模型名。',
      '分池的根本理由是画像不对称:encoder 池短序列、单次前向、无 KV cache;LLM 池长序列自回归、KV 是第一等公民——合池必然一方迁就另一方。',
      '流量形状也不对称:检索类调用高频轻量、生成类低频重载,请求量可差数十倍,弹性曲线完全不同。',
      '硬件随之异构:小卡喂 encoder 池、大卡喂生成池,① 的「一种卡打天下」变成按池选卡。',
      'KV 泳道出现非 KV 成员:向量库是检索链路的状态底座,与 KV cache 分属两个世界但同为「数据层」。',
    ],
    decision: {
      problem:
        'RAG 链路里 encoder 与 decoder 的负载画像天差地别:合池部署互相拖累、被迫按最贵的卡配所有服务;按画像分池后,各池自选卡型、组批与扩缩节奏。',
      benefits: [
        { text: 'encoder 池无 KV cache、短序列单次前向:小卡即可高吞吐,把大卡完整让给生成' },
        { text: 'TEI 等专用 runtime 为 embedding/rerank 做动态组批与紧凑部署,免去通用 LLM 引擎的重量级开销' },
        { text: '各池独立扩缩:检索高峰只扩 encoder 池,长会话高峰只扩生成池,弹性预算花在刀刃上' },
        { text: '故障与长尾隔离:VLM 的重请求、rerank 的突发打分不再传染整条问答链路' },
      ],
      metrics: [
        '各池 QPS 与利用率(是否都吃饱)',
        '端到端延迟拆解(检索/重排/生成各占多少)',
        '每池每请求成本',
        '检索质量(召回率/重排后命中率)',
      ],
      costs: [
        '服务数量翻倍:四个池各有部署、监控、告警与升级路径',
        '链路多跳:每跳的网络与序列化开销累加进端到端延迟',
        '小规模两头吃亏:每个池都跑不满,合池混跑反而更省',
        '容量规划变成联动题:embed 与向量库、rerank 与 top-k 参数互相牵制',
      ],
      avoidWhen: [
        '流量小:单池混跑或直接用托管 embedding API 更划算',
        '纯生成场景,没有检索链路',
        '团队撑不起多服务的运维面',
      ],
      gpuScale: 'encoder 池小卡 ×N + 生成池大卡 ×M,两池起步',
      memoryPreset: { modelId: 'llama3-70b', gpuId: 'h20', quantId: 'fp8' },
    },
    sources: [
      {
        kind: 'github',
        title: 'huggingface/text-embeddings-inference(TEI)',
        sourceUrl: 'https://github.com/huggingface/text-embeddings-inference',
        asOf: '2026-08',
      },
      {
        kind: 'docs',
        title: 'Text Embeddings Inference 官方文档',
        sourceUrl: 'https://huggingface.co/docs/text-embeddings-inference/index',
        asOf: '2026-08',
      },
      {
        kind: 'blog',
        title: 'Fireworks:Understanding Embeddings and Reranking at Scale',
        sourceUrl: 'https://fireworks.ai/blog/Understanding-Embeddings-and-Reranking-at-Scale',
        asOf: '2026-08',
      },
      {
        kind: 'paper',
        title: 'Harmonia:RAG 服务的异构资源分池调度',
        sourceUrl: 'https://arxiv.org/pdf/2505.07833',
        asOf: '2026-08',
      },
    ],
    dims: {
      'mono-vs-pd': '正交:生成池内自选',
      runtime: 'TEI + vLLM 混编',
      parallelism: '各池独立选择',
      batching: '各池独立组批',
      'prefix-kv': '仅生成池有 KV',
      'model-routing': '按任务类型分池',
      autoscale: '各池独立扩缩',
      replicas: '各池 ×N 互不影响',
      tenancy: '无(可叠加 ⑤)',
      pooling: '四池:E/R/LLM/VLM',
    },
    meta: {
      minDeploy: 'embed 池 + 生成池两池起步',
      qpsThreshold: '检索调用量数倍于生成时',
      network: '机房内网即可',
      opsComplexity: 3,
      avoidWhen: '小流量——合池混跑更省',
    },
  },
]

// 高价值架构对的人工差异解读(L3 层,顺序无关查找)。
// 注意:archDiff.test.ts 以「临时注入 baseline↔pd-disagg 再弹出」的方式验证顺序无关性,
// 且断言 baseline↔large-ep 查无——这两对不要预写(①↔② 的解读由 ② 的 vsBaseline L2 层承担)。
export const ARCH_PAIR_NOTES: { pair: [ArchId, ArchId]; note: string }[] = [
  {
    pair: ['baseline', 'k8s-autoscale'],
    note: '为什么改:单实例是单点——升级即停服、故障即事故,而且流量一波动就在「白白烧卡」与「排队超时」之间反复横跳。收益:副本化 + 指标驱动扩缩后,容量跟着负载走,故障副本自动重建,多模型也能统一管理(数字见 ④ 决策卡)。代价:引擎之外多出一整个控制面要养,冷启动数分钟让弹性存在「反应迟钝」的下限。怎么衡量:对比固定容量方案的常态空置率与峰值排队深度;盯「扩容触发到副本可服务」的端到端时长。',
  },
  {
    pair: ['pd-disagg', 'large-ep'],
    note: '为什么改:模型换成超大 MoE 后「实例」这个粒度失效——专家总量一台机器根本放不下,必须按专家维度切到集群。收益:EP 让每卡只驻留少数专家,超大模型也能以大 batch 高吞吐地跑(数字见 ③ 决策卡)。代价:部署原子从单实例膨胀为十几个节点的单元,弹性与故障域同时恶化一个量级,还新增 all-to-all 通信与专家负载均衡两个常驻战场。怎么衡量:看专家负载均衡度(最热卡 vs 平均)与 all-to-all 耗时占比;流量必须常年喂得饱单元,否则退回 ② 更划算。',
  },
  {
    pair: ['k8s-autoscale', 'router-tenant'],
    note: '这不是演进关系,而是互补的两半:④ 管「副本数量对不对」(容量问题),⑤ 管「每条请求去哪个副本」(派发问题)。只上 ④ 会得到「数量正确但派发盲目」的集群:轮询打散前缀,缓存命中全凭运气;只上 ⑤ 则路由再聪明也救不了容量不足。生产形态通常是两者叠加:KEDA 决定 N、EPP/KV 感知路由决定流向,llm-d 就是这套组合的开源标杆。怎么衡量:④ 看扩容及时率与常态空置率,⑤ 看集群前缀命中率与各租户 SLO 达标率。',
  },
  {
    pair: ['pd-disagg', 'kv-tier'],
    note: '两者动的是同一个东西(KV)的不同维度:② 解决「KV 在一次请求内怎么搬」(prefill 池到 decode 池),⑥ 解决「KV 在请求之间怎么留」(跨轮、跨天、跨副本)。⑥ 的收益随前缀重复率单调上升,与 ② 正交可叠加——Mooncake 正是两者的合体:PD 分离 + 池化 KV Store。代价结构不同:② 花的是网络带宽与调度复杂度,⑥ 花的是存储容量与一致性管理(模型一换全体失效)。怎么衡量:② 看 goodput 与传输耗时占比,⑥ 看各级命中率与「回填 vs 重算」的耗时比。',
  },
  {
    pair: ['baseline', 'rag-pools'],
    note: '为什么改:RAG 把「一次问答」变成一串异构调用,encoder 与 decoder 的资源画像天差地别,塞进同一个池必然一方迁就另一方。收益:按画像分池后各自选卡、各自组批、各自扩缩——小卡喂检索、大卡喂生成,互不拖累且成本立减。代价:服务数翻倍、链路多跳,小规模时每个池都吃不饱,反而比合池更贵。怎么衡量:先量检索类与生成类的请求量比值和端到端延迟拆解;两类流量差距越大,分池收益越确定。',
  },
]
