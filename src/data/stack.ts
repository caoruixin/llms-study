// 推理全链路四层：自底向上，每个组件带讲解与客户常问要点
export interface StackComponent {
  id: string
  name: string
  what: string
  interview: string
}

export interface StackLayer {
  id: string
  name: string
  color: string // Tailwind 色类
  summary: string
  components: StackComponent[]
}

export const STACK_LAYERS: StackLayer[] = [
  {
    id: 'serving',
    name: '服务与路由层',
    color: 'text-accent',
    summary: '用户请求进入系统的第一站：鉴权、路由、排队、组 batch',
    components: [
      {
        id: 'gateway',
        name: 'API Gateway（鉴权/限流）',
        what: '统一入口：API key 鉴权、按租户限流（RPM/TPM/并发）、计量计费埋点。',
        interview: '限流维度就是商务条款的技术映射——谈 SLA 时要能说清 RPM/TPM/并发三种限法的差异。',
      },
      {
        id: 'router',
        name: '模型路由',
        what: '按请求特征选模型/集群：模型分级（简单问题走小模型）、按 SLA 分池（交互 vs 批处理）、多地域容灾。',
        interview: '模型分级路由是最大的降本抓手之一：客服场景 70% 流量走便宜模型可省一半以上账单。',
      },
      {
        id: 'queue',
        name: '队列与调度器',
        what: '请求排队等待进入推理实例；调度器按优先级/公平性分配，控制排队时延与拒绝策略。',
        interview: '排队时延是 TTFT 的隐藏成分——压测时要区分「引擎 TTFT」和「端到端 TTFT」。',
      },
      {
        id: 'cache-check',
        name: 'KV cache 命中判断',
        what: '检查请求前缀是否命中已有 KV cache（系统 prompt/历史轮次），命中部分跳过 prefill。',
        interview: '命中率是成本模型的关键参数：高频固定前缀场景命中价可低至输入价 1/10。',
      },
      {
        id: 'batching',
        name: 'Batch 组装',
        what: '把并发请求动态组进同一次前向计算（continuous batching），完成即出、随到随进。',
        interview: 'batch 变大 → 吞吐升、单 token 成本降、TPOT 略升——这是吞吐与延迟的核心权衡旋钮。',
      },
    ],
  },
  {
    id: 'engine',
    name: '推理引擎层',
    color: 'text-accent-2',
    summary: '单实例内把 GPU 榨干的软件：vLLM / SGLang / TRT-LLM',
    components: [
      {
        id: 'vllm',
        name: 'vLLM（PagedAttention）',
        what: 'KV cache 按固定 block 分页管理（类 OS 虚拟内存），消除预分配碎片；配合 continuous batching。开源 serving 事实标准，v1 引擎原生支持 PD 分离。',
        interview: '「为什么快」两句话：PagedAttention 省显存→并发翻倍；continuous batching 消空泡→利用率恒定高位。',
      },
      {
        id: 'sglang',
        name: 'SGLang（RadixAttention）',
        what: '用基数树自动管理可复用前缀 KV，多轮对话/Agent 分支场景命中率高；大规模 EP 与结构化输出（约束解码）口碑最强，是 DeepSeek 类 MoE 官方推荐部署路径之一。',
        interview: 'Agent 工作负载前缀重复率极高，RadixAttention 是 Agent 成本可控的关键组件。',
      },
      {
        id: 'trtllm',
        name: 'TensorRT-LLM',
        what: 'NVIDIA 官方推理库：深度 kernel 优化、FP8/FP4 量化路径最全，对新硬件（Blackwell）跟进最快；通常作为 Dynamo/NIM 底层。',
        interview: '选型口诀：通用开源生态选 vLLM，MoE 多机/结构化输出选 SGLang，N 卡极限性能（FP4）选 TRT-LLM。',
      },
      {
        id: 'quant',
        name: '量化（FP8/INT4/AWQ）',
        what: '权重（及 KV/激活）降精度存储与计算：FP16→FP8→INT4 每档显存减半；FP8 在 Hopper+ 近无损，INT4（AWQ/GPTQ）需评测把关。',
        interview: '量化是自建降本第一杠杆（卡数 2~4×↓），但必须带「客户数据评测门槛」一起卖，不然就是暗坑。',
      },
    ],
  },
  {
    id: 'cluster',
    name: '集群与并行层',
    color: 'text-ok',
    summary: '模型放不进一张卡时的拆分方案，以及两阶段分池部署',
    components: [
      {
        id: 'tp',
        name: 'TP 张量并行',
        what: '把每层的权重矩阵横切到多卡，每步都要 all-reduce 通信——必须留在 NVLink 域内。',
        interview: '「70B 放两张卡」说的就是 TP；跨机架 TP 是性能事故的常见根因。',
      },
      {
        id: 'pp-dp',
        name: 'PP 流水线 / DP 数据并行',
        what: 'PP 按层切段接力（通信少、有气泡）；DP 整模型复制多份扩吞吐（推理即多副本）。',
        interview: '推理容量规划：显存决定 TP 下限，qps 目标决定 DP 副本数——两个独立变量别混着算。',
      },
      {
        id: 'ep',
        name: 'EP 专家并行',
        what: 'MoE 专家分布到多卡，token 按路由跨卡投递（all-to-all 通信），大 NVLink 域收益显著。',
        interview: 'DeepSeek/Kimi 级大 MoE 的标准部署形态；NVL72 卖点之一就是 72 卡域内 EP 高效。',
      },
      {
        id: 'pd',
        name: 'Prefill-Decode 分离',
        what: 'prefill（算力密集）与 decode（带宽密集）分池部署，KV 经高速互联传输；避免长 prompt 卡住别人的出字。',
        interview: 'TTFT 与 TPOT 双优的架构解法；长输入短输出的文档场景收益最大。',
      },
    ],
  },
  {
    id: 'hardware',
    name: '硬件层',
    color: 'text-warn',
    summary: 'GPU 芯片 → 服务器 → 机架系统三个层级 + 两种互联',
    components: [
      {
        id: 'gpu-tiers',
        name: 'GPU 卡型谱系',
        what: 'Hopper（H100/H200/H20）→ Blackwell（B200/B300）：容量决定「放不放得下」，带宽决定「出字快不快」，算力决定「prefill 扛不扛得住」。',
        interview: 'H20 是中国市场关键角色：算力阉割但带宽保留——「能推理、难训练」一句话讲清合规现状。',
      },
      {
        id: 'rack',
        name: '机架系统（NVL72）',
        what: 'GB200/GB300 NVL72 = 72 GPU + 36 Grace CPU 组成一个统一 NVLink 域的机架级产品，不是一张卡。',
        interview: '报价时层级别搞错：客户问「GB300 多少钱一张」要先纠正实体层级，按机架/每 GPU 折算两种口径报。',
      },
      {
        id: 'scaleup',
        name: 'NVLink scale-up',
        what: '机架内 GPU 全互联：NVLink 5 每卡 1.8TB/s、域内聚合 130TB/s，TP/EP 的高速公路。',
        interview: 'NVLink 域大小决定了「多大的模型能高效并行」，这是 NVL72 相对 8 卡机的本质优势。',
      },
      {
        id: 'scaleout',
        name: 'IB/以太 scale-out',
        what: '跨机架网络：InfiniBand XDR / Spectrum-X 每端口 800Gb/s ≈ NVLink 的 1/18，只承载 DP/PP 级通信。',
        interview: '「为什么不把 TP 跨机架」——带宽差 18 倍，一句话终结讨论。',
      },
      {
        id: 'memwall',
        name: '显存墙',
        what: '权重 + KV cache + 开销 > 单卡显存 → 必须并行拆分或量化；decode 本质带宽受限，显存带宽即出字速度。',
        interview: '用右侧计算器现场算给客户看：模型尺寸×量化×上下文×并发 → 卡数，这是售前最硬的基本功。',
      },
    ],
  },
]
