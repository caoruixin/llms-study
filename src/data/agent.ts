// Agent 架构学习内容（JD 核心话题：工具调用/记忆/编排/多模态/长链路推理）
export interface AgentElement {
  id: string
  name: string
  what: string
  interview: string
}

export const AGENT_ELEMENTS: AgentElement[] = [
  {
    id: 'tools',
    name: '工具调用',
    what: '把工具的 JSON Schema 注入上下文，模型输出结构化调用意图（函数名+参数），运行时执行后把结果回填，循环直到产出答案。模型只「提议」，执行、鉴权、超时都在应用侧。',
    interview: '可靠性是工程问题不是模型问题：参数校验、重试上限、危险操作人工确认、全链路 tracing——一句话把客户的「工具调用靠谱吗」接住。',
  },
  {
    id: 'memory',
    name: '记忆',
    what: '短期 = 上下文窗口内的历史与工作状态（受窗口与成本约束，需摘要压缩）；长期 = 外部存储（向量库/DB/文件）按需检索注入。写入要有门槛，读取要有排序，维护要能改错。',
    interview: '记忆设计的本质：在有限上下文预算下，让对的信息在对的时刻出现——写入门槛防污染是最容易被忽略的一环。',
  },
  {
    id: 'orchestration',
    name: '编排',
    what: '多步/多角色任务的控制流：状态机（LangGraph 式，节点+条件边+checkpoint）、管线、主从子 Agent 分解。确定性控制流用代码写死，开放性决策留给模型。',
    interview: '选型口诀：流程可枚举 → workflow 写死；探索性任务 → agent 循环；两者混合是常态，全部丢给模型「自由发挥」是事故预定。',
  },
  {
    id: 'multimodal',
    name: '多模态',
    what: '原生多模态模型（图/文/视频同一模型理解，如 Kimi K3）vs 管线式（OCR/ASR 前置转文本）。原生路线上下文成本高但信息保真；管线路线便宜可控但丢失版面/语气信息。',
    interview: '售前判断：单据审核类（版面关键）用原生视觉，语音客服（文本足够）用 ASR 管线——按信息损耗与成本折中，不是越原生越好。',
  },
  {
    id: 'reasoning',
    name: '长链路推理',
    what: '30+ 步任务的失败模式：错误累积漂移、上下文膨胀、工具失败死循环。治理：外置状态（计划文件/任务队列）、边界校验、compaction 压缩历史、重试预算与熔断、不可逆操作人工闸门。',
    interview: '成熟范式一句话：状态外置 + 每个上下文窗口保持小而专注 + 全程可观测 + 危险动作设闸——这也是评估 Agent 框架成熟度的清单。',
  },
]

export interface AgentPitfall {
  name: string
  detail: string
}

export const AGENT_PITFALLS: AgentPitfall[] = [
  { name: '检索质量差 → 幻觉', detail: '切块策略与文档结构不匹配、缺重排；端到端质量的上限在检索不在模型。评估要把「检索命中率」和「回答质量」分开测。' },
  { name: 'Token 放大效应', detail: 'Agent 一次任务 = 多轮循环 × 工具结果回填，消耗可达单轮问答的 10~50 倍；不配前缀缓存和上下文裁剪，成本会失控。' },
  { name: '工具幻觉与死循环', detail: '编造参数枚举值、对失败工具无限重试。解法：schema 收紧 + 失败注入上下文 + 重试预算。' },
  { name: '权限与数据隔离', detail: '多租户下 Agent 检索/工具必须带租户过滤；「模型能看到什么」要在检索层控制，不能靠 prompt 叮嘱。' },
  { name: '没有评估闭环', detail: '上线后无 tracing、无任务级成功率指标，迭代全靠感觉。tracing 是调试与信任的前置条件，不是锦上添花。' },
  { name: '范围蔓延', detail: '「顺便把 XX 也自动化」是 Agent 项目最大杀手；POC 阶段书面锁定任务边界与验收口径。' },
]

// Function Calling 循环步骤（流程图 1）
export const FC_LOOP = [
  { step: '① 注入', desc: '把工具 JSON Schema 放进系统上下文', actor: 'app' },
  { step: '② 提议', desc: '模型输出 tool_call：函数名 + 参数（不执行）', actor: 'model' },
  { step: '③ 执行', desc: '运行时校验参数 → 鉴权 → 真正调用（超时/重试在这层）', actor: 'app' },
  { step: '④ 回填', desc: '工具结果作为 tool 消息追加进上下文', actor: 'app' },
  { step: '⑤ 继续', desc: '模型读结果：继续调工具（回到②）或产出最终回答', actor: 'model' },
] as const

// LangGraph 式状态机（流程图 2）
export const GRAPH_NODES = [
  { id: 'plan', name: 'Plan 规划', desc: '拆解任务、更新计划（状态外置到 State）' },
  { id: 'route', name: 'Router 条件边', desc: '按状态决定下一节点：继续执行 / 需要人工 / 完成' },
  { id: 'act', name: 'Act 执行', desc: '调用工具或子 Agent（每个子任务独立上下文）' },
  { id: 'observe', name: 'Observe 观察', desc: '校验结果、写 checkpoint（可回滚/断点续跑）' },
  { id: 'human', name: 'Human Gate', desc: '不可逆操作暂停等人工批准' },
  { id: 'done', name: 'End', desc: '产出结果 + 全程 trace 落盘' },
] as const
