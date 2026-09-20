import type { Algorithm, ExperimentConfig, Partnership, View } from '../lib/agentRl/types'

export const RL_TABS: { id: View; label: string }[] = [
  { id: 'map', label: '全流程地图' },
  { id: 'train', label: '跟着训练一次' },
  { id: 'lab', label: '算法与奖励' },
  { id: 'evaluate', label: '评估与升级' },
  { id: 'provider', label: '服务与成本' },
]
export interface RlStage {
  id: string
  group: string
  title: string
  why: string
  input: string
  output: string
  resources: string
  customer: string
  service: string
  form: string
  meter: string
  acceptance: string
}
export const RL_STAGES: RlStage[] = [
  {
    id: 'goal',
    group: '准备',
    title: '定义任务与成功',
    why: '先定义“好”是什么。客服目标是正确解决问题，系统标记关闭只是一个代理指标。',
    input: '业务目标、退款政策、典型失败',
    output: '任务边界、验收规则、成本与时延目标',
    resources: '业务专家、产品、评测工程师',
    customer: '决定业务目标与不可接受的错误',
    service: '任务诊断与 Eval 方案',
    form: '专家共建 / 评测平台',
    meter: '项目费 / 专家工时',
    acceptance: '能区分正确解决、虚假结单与合理转人工',
  },
  {
    id: 'data',
    group: '准备',
    title: '整理数据与分区',
    why: '把聊天日志变成可重放的任务。训练、验证、测试按工单家族隔离，不能把同一问题换个说法后放进测试集。',
    input: '工单、上下文、工具日志、人工修改、最终结果',
    output: '训练任务、验证集、冻结测试集；按需生成示范和偏好对',
    resources: '数据工程、去重与脱敏、标注、对象存储',
    customer: '提供合法可用的数据和领域判断',
    service: '数据管线、合成数据、标注与版本管理',
    form: '批处理 API / 数据平台 / 项目交付',
    meter: '生成 Token / 标注条数 / 存储 / 人工工时',
    acceptance: '无跨分区泄漏；包含成功、失败与边界案例',
  },
  {
    id: 'baseline',
    group: '准备',
    title: '基线与失败诊断',
    why: '先运行当前 Agent。缺事实、工具故障和模型策略错误需要不同干预，不能都归因到模型能力。',
    input: '现有模型 + Prompt + Harness + Eval',
    output: '成功率、失败分类、每成功任务成本',
    resources: '基线推理、Tracing、独立评测',
    customer: '确认可比的任务、工具、版本与负载',
    service: '模型选型、批量推理、评测与 Trace',
    form: 'Inference API / Eval SDK',
    meter: '输入/输出 Token + 评分资源',
    acceptance: '结果可重复；比较口径一致',
  },
  {
    id: 'environment',
    group: '准备',
    title: '环境与奖励验收',
    why: 'Agent 要反复探索，所以环境必须可重置。业务规则由工具执行，Reward 负责评价；二者不能互相替代。',
    input: '工具 Schema、任务初态、业务规则、成功条件',
    output: '可重置环境、Verifier、奖励与反例测试',
    resources: 'CPU / 沙箱、工具模拟器、环境工程师；可选 Judge GPU',
    customer: '定义权限、业务真值与评分标准',
    service: '沙箱、远程环境接入、评分托管',
    form: 'Environment API / Grader 函数 / 容器',
    meter: '沙箱秒 / 工具调用 / Judge Token',
    acceptance: '满分、零分、部分得分、越权、超时都能正确判断',
  },
  {
    id: 'recipe',
    group: '准备',
    title: '选择方法与资源',
    why: '基础模型是被优化的策略；RL 算法是如何更新它。PPO 的 Critic 与 Reward Model 作用不同。',
    input: '失败类型、模型能力、环境、数据和预算',
    output: '基座、算法、超参数、LoRA/全参数方案及资源计划',
    resources: 'ML 工程师、Trainer GPU、Rollout 容量；按需 Reference/Critic/RM',
    customer: '选定业务取舍与实验目标',
    service: '托管训练 / Training API / 自带 Trainer 接入',
    form: '作业配置 / Python SDK / 专家共建',
    meter: '训练 Token / GPU-hour / 项目费',
    acceptance: '每项模型与资源都有明确作用，不把所有角色都当必需',
  },
  {
    id: 'rollout',
    group: '训练循环',
    title: '采样轨迹 Rollout',
    why: '同一任务可以尝试多条路径。模型提出动作，Harness 执行工具，再把观察送回上下文。此时不更新权重。',
    input: '任务初态、采样策略版本、工具与采样参数',
    output: '观察、动作、工具结果、旧策略 logprob、最终状态',
    resources: '高吞吐推理、环境 CPU、并发与超时管理',
    customer: '任务分布、Harness、探索配置',
    service: 'Rollout 推理与专用容量',
    form: 'Sampling API / Dedicated Endpoint / BYOT',
    meter: 'Prefill、Cached Prefill、Sample Token / GPU 时间',
    acceptance: '轨迹完整、版本可追溯、环境正确重置',
  },
  {
    id: 'reward',
    group: '训练循环',
    title: '计算 Reward',
    why: '奖励把业务目标转换成数字。结束工单不是解决工单；漂亮回复也不能代替退款回执。',
    input: '轨迹、最终环境状态、评分规则',
    output: '奖励总分、分项和评分版本',
    resources: '规则 CPU / 人工 / 可选 LLM Judge 或 Reward Model',
    customer: '定义标准、校准评分与处理分歧',
    service: '评分执行、评测集管理与可选 RM 训练',
    form: '函数 / API / 托管评分任务',
    meter: '执行次数 / Judge Token / 模型训练与推理资源',
    acceptance: '奖励能区分好坏，对刷分反例有检测',
  },
  {
    id: 'advantage',
    group: '训练循环',
    title: '估计 Advantage',
    why: '同样一分在不同背景下含义不同。Advantage 表示这次行为比基准好多少，用来决定更新方向。',
    input: '奖励、旧策略、历史基线或 Critic / 组内样本',
    output: '各动作对应的优势与训练目标',
    resources: '算法逻辑；PPO 需学习价值函数',
    customer: '选择优势估计方法与归一化口径',
    service: '训练配方与计算 API',
    form: 'SDK / 托管 Trainer',
    meter: '包含在训练资源中；不重复单列 Token 费',
    acceptance: '组内比较不混入不同任务；零方差数值稳定',
  },
  {
    id: 'update',
    group: '训练循环',
    title: '更新策略参数',
    why: '优化器沿梯度改变参数。PPO/GRPO 还限制更新幅度；训练并不保证每轮成功率都上升。',
    input: '轨迹、logprob、优势、训练 mask、超参数',
    output: '新 Policy；PPO 同时更新 Critic',
    resources: 'Forward / Backward / Optimizer、显存和分布式训练',
    customer: '目标函数、超参数与实验控制',
    service: '托管训练 / Training API / GPU 集群',
    form: 'forward_backward + optim_step / 托管作业',
    meter: '训练处理 Token / GPU-hour',
    acceptance: '梯度有效、数值稳定、参数确实发生变化',
  },
  {
    id: 'checkpoint',
    group: '训练循环',
    title: '保存 Checkpoint',
    why: '训练中的参数与可发布版本不是同一概念。保存模型和相关版本，才能复现、继续训练与回滚。',
    input: '新参数、训练配置和版本信息',
    output: '模型快照、Adapter；按需保存优化器状态',
    resources: '存储、注册表、版本管理',
    customer: '决定保留、恢复与发布策略',
    service: 'Checkpoint 存储与 Model Registry',
    form: 'Artifact / 对象存储 / 管理 API',
    meter: '存储、传输或套餐包含；依实际合同',
    acceptance: '版本可恢复，模型与配套配置可追踪',
  },
  {
    id: 'sync',
    group: '训练循环',
    title: '同步采样权重',
    why: 'Trainer 已更新不代表 Rollout 已更新。下一批采样必须知道自己使用哪个策略版本。',
    input: 'Checkpoint、采样实例或 Sampling Client',
    output: '绑定新版本的采样器',
    resources: '网络传输、模型加载、版本路由',
    customer: '同步频率与版本一致性策略',
    service: '权重热更新 / 快照绑定 / 采样服务',
    form: 'Dedicated 权重同步或 Serverless 快照采样',
    meter: '传输与容量成本；是否单独收费依服务',
    acceptance: '旧/新策略清晰；本实验不混用过期轨迹继续 on-policy 更新',
  },
  {
    id: 'evaluate',
    group: '验收与发布',
    title: '独立评估与选版',
    why: '验证集帮助选版本，测试集做最终检查。训练奖励不能自己证明业务成功。',
    input: '候选 Checkpoint、固定 Harness、验证/测试任务',
    output: '质量、失败分布、成本和上线建议',
    resources: '评测推理、环境与评分资源',
    customer: '验收门槛、样本范围及业务风险',
    service: '批量 Eval、回归对比、模型选版',
    form: 'Eval API / 报告 / 工作流',
    meter: '推理 Token + 环境/评分调用',
    acceptance: '不将评测样本送回梯度；记录样本数与版本',
  },
  {
    id: 'serve',
    group: '验收与发布',
    title: 'Serving 与 Harness 联调',
    why: 'Checkpoint 不是完整 Agent。Tokenizer、Chat Template、工具 Schema、采样参数和量化都可能影响生产效果。',
    input: '候选模型 + Prompt/Context + Harness + Serving 配置',
    output: '可运行的 Agent 发布候选',
    resources: '推理部署、工具接入、回归与观测',
    customer: '负责业务工具和生产一致性验收',
    service: '模型部署、量化与 Serving 优化',
    form: 'Endpoint / Adapter Deployment / BYOC',
    meter: 'Token / 专用 GPU 时间 / 工程服务',
    acceptance: 'Golden Tasks 通过；训练与 Serving 行为核对',
  },
  {
    id: 'deploy',
    group: '验收与发布',
    title: '灰度、A/B 与回滚',
    why: '在相同业务分布下比较当前版与候选版，观察成功率和失败成本，再决定是否切换。',
    input: '当前版、候选版、发布门槛和流量',
    output: '对照结果、发布记录、可回滚版本',
    resources: '双版本容量、路由、监控与发布系统',
    customer: '承担业务发布决策',
    service: '多版本 Serving、路由、SLA 与预留容量',
    form: 'Endpoint / Deployment API / 合同容量',
    meter: '实际消耗或承诺 GPU 容量',
    acceptance: '版本可追踪、退化可回滚；小样本结果不当统计显著性',
  },
  {
    id: 'feedback',
    group: '持续改进',
    title: '反馈与下一轮',
    why: '用户反馈先变成可解释的失败。更新知识、修工具、改 Reward 或再训练，选择与根因对应的方法。',
    input: '生产 Trace、结果、用户修改、漂移与告警',
    output: '新 Eval、数据修订、环境/Reward/Harness/模型升级任务',
    resources: 'Tracing、数据管线、评测、工程团队',
    customer: '业务判断、数据授权与迭代优先级',
    service: '监控、持续评测、再训练流水线',
    form: '平台 / API / 专家持续服务',
    meter: '平台与存储 + 每轮实际消耗',
    acceptance: '新问题进入回归，改进在生产中复现',
  },
]
export const ALGORITHM_INFO: Record<
  Algorithm,
  { name: string; plain: string; formula: string; resources: string; limits: string; url: string }
> = {
  reinforce: {
    name: 'REINFORCE',
    plain: '回报高于历史平均，就提高这条路径上动作的概率；低于平均则反向调整。历史基线不使用本批样本重新拟合。',
    formula:
      '\\Delta\\theta = \\eta \\frac{1}{N}\\sum_{i,t}(G_{i,t}-b)\\nabla_\\theta\\log\\pi_\\theta(a_{i,t}|s_{i,t})',
    resources: 'Policy + 历史标量基线；不训练 Critic。',
    limits: '方差较大，长路径中的动作共享结果信用；采样后只更新一次。',
    url: 'https://link.springer.com/article/10.1007/BF00992696',
  },
  ppo: {
    name: 'PPO',
    plain: 'Critic 预测从当前状态出发能得到多少回报，GAE 衡量实际表现与预测的差异。裁剪限制有利方向的过大概率变化。',
    formula: 'L=\\mathbb{E}[\\min(r_t A_t,\\operatorname{clip}(r_t,1-\\epsilon,1+\\epsilon)A_t)]',
    resources: 'Policy + 旧策略概率 + 学习中的 Critic。Reward 可来自规则；独立 RM 并非 PPO 的前提。',
    limits: '本实验使用表格价值函数、GAE 和完整批次多次更新；未实现生产 LLM 的分布式训练或 RLHF Reference KL 奖励。',
    url: 'https://arxiv.org/abs/1707.06347',
  },
  grpo: {
    name: 'GRPO',
    plain:
      '同一个工单生成一组路径，把各自奖励减去组平均、除以组标准差，再用裁剪目标更新策略。Reference KL 用来限制偏离初始策略。',
    formula:
      '\\hat A_i=\\frac{R_i-\\operatorname{mean}(R)}{\\operatorname{std}(R)},\\quad L=L_{clip}-\\beta D_{KL}(\\pi_\\theta\\|\\pi_{ref})',
    resources: 'Policy + 旧策略概率 + 冻结 Reference；没有 Critic，增加组采样。',
    limits:
      '使用终局奖励与每条轨迹长度归一化；小动作空间精确计算 KL，区别于 LLM 的采样估计。组内同分时优势为零，但非零 KL 仍可能产生正则更新。',
    url: 'https://arxiv.org/html/2402.03300v3',
  },
}
export const PRESETS: {
  id: string
  title: string
  lesson: string
  config: Partial<ExperimentConfig>
  productionFailure?: number
}[] = [
  {
    id: 'healthy',
    title: '01 · 合理奖励',
    lesson: '从具备弱工具顺序偏好的初始策略出发，观察正确解决率与动作概率如何变化。',
    config: {},
  },
  {
    id: 'hacking',
    title: '02 · 虚假结单',
    lesson: '只奖励关闭按钮。比较训练奖励与独立验收，找出被模型利用的评分漏洞。',
    config: { rewardMode: 'closed' },
  },
  {
    id: 'flat',
    title: '03 · 奖励没有区分度',
    lesson: 'GRPO 同组全部得 1 分，优势为 0；这里关闭 KL，以隔离奖励学习信号。',
    config: { algorithm: 'grpo', rewardMode: 'flat', kl: 0 },
  },
  {
    id: 'rollouts',
    title: '04 · 更多探索',
    lesson: '组大小从 4 增至 12。先运行合理奖励作为参照，再看真实调用量、奖励与结果；更多采样不保证更好。',
    config: { groupSize: 12 },
  },
  {
    id: 'shift',
    title: '05 · 生产工具退化',
    lesson: '训练环境保持正常，生产订单 API 故障率设为 65%。在发布视图对比评测与生产表现。',
    config: {},
    productionFailure: 0.65,
  },
  {
    id: 'stale',
    title: '06 · 权重没有同步',
    lesson: '完成一轮后保留旧采样器与旧生产版。观察版本差异，再手动同步和发布。',
    config: { autoSync: false, rounds: 1 },
  },
]
export const PARTNERSHIPS: Record<Partnership, { title: string; provider: string; customer: string }> = {
  rollout: {
    title: '只采购 Rollout',
    provider: '承接训练轨迹的推理采样。',
    customer: '自带 Trainer、环境、评分、数据与生产 Serving；其余费用留在客户侧。',
  },
  api: {
    title: '自定义训练 API',
    provider: '承接 Rollout、参数更新、评测推理与生产 Serving。',
    customer: '实现训练循环、环境、数据与评分业务逻辑。',
  },
  managed: {
    title: '托管 RL',
    provider: '在 API 方案上增加环境与评分执行托管。',
    customer: '提供数据、业务规则、环境实现与验收标准；托管不替客户定义成功。',
  },
  expert: {
    title: '专家共建',
    provider: '承接上述计算服务，以及数据/Eval 建设和专家项目服务。',
    customer: '保留业务定义、数据权属、验收与发布决策。',
  },
}
export const METHODS = [
  ['事实缺失或过期', 'RAG / Context', '提供当下事实，不改权重'],
  ['指令含糊、工具接线错误', 'Prompt / Harness', '先修系统流程与上下文'],
  ['有理想示范但行为不稳定', 'SFT', '学习输入到目标回答/动作的示范'],
  ['同一输入有好坏偏好对', 'DPO', '直接优化偏好；标准离线 DPO 不需要独立 RM 或在线 PPO 循环'],
  ['多步策略不足，结果可评价', 'Agent RL', '在可重置环境里探索并利用奖励更新策略'],
  ['效果足够但太慢或贵', '蒸馏 / Serving 优化', '教师生成数据、小模型学习；还要计算教师、训练和维护成本'],
]
export const DATA_EXAMPLES = [
  {
    title: '原始 Trace',
    purpose: '保留任务、上下文、动作、观察、最终结果与人工修改；聊天文本只是其中一部分。',
    example: {
      ticket_id: 'train-1',
      task: '订单退款',
      turns: ['查订单 → 在售后期', '查规则 → 可退', '申请退款 → 成功', '结束工单'],
      outcome: { closed: true, resolved: true },
      human_correction: null,
    },
  },
  {
    title: 'RL 任务',
    purpose: '准备起点和可重置环境，不要求预先知道每一步正确答案。运行时采样出训练轨迹。',
    example: {
      task_id: 'train-1',
      prompt: '请帮我办理订单退款',
      environment: 'refund-sandbox-v1',
      initial_state: { order_id: 'synthetic-001' },
      verifier: 'outcome-v1',
      split: 'train',
    },
  },
  {
    title: 'SFT 示范',
    purpose: '同一个任务给出优秀操作示范。可选的 SFT 热身有助于获得基础工具能力，但不是所有 RL 的必经阶段。',
    example: {
      messages: [
        { role: 'user', content: '请查询退款条件' },
        { role: 'assistant', tool_calls: [{ name: 'lookup_order', arguments: { order_id: 'synthetic-001' } }] },
      ],
      source: '人工审核通过的示范',
    },
  },
  {
    title: 'DPO 偏好对',
    purpose: '同一上下文中比较两个回答或操作路径。偏好不等于最终事实真值，需要清洗和校准。',
    example: {
      prompt: '订单不符合退款条件',
      chosen: '查询规则、解释原因并给出申诉方式',
      rejected: '承诺无条件退款',
      label_source: '业务专家复核',
    },
  },
  {
    title: '冻结 Eval',
    purpose: '按客户/工单家族/时间去重分区。验证集用于选版，测试集最后验收；反复依赖测试结果调参会削弱其独立性。',
    example: {
      task_id: 'test-1',
      family: 'test-family-1',
      expected: '满足条件且核验后退款，或正确说明拒绝原因',
      checks: ['不越权', '不重复退款', '回执真实'],
      use_for_gradient: false,
    },
  },
]
export const ROLES = [
  ['基础模型', '起点', '真实项目先选有工具能力且允许训练/部署的基座。此处用带弱工具顺序偏好的初始概率表代替。'],
  ['Policy / Actor', '训练', '决定下一个动作。RL 优化其参数；真实 LLM 则改变生成 Token 的概率。'],
  [
    '旧策略 / 采样器',
    '一批内冻结',
    '生成当前轨迹并保存 logprob；更新时作为概率比率分母。Checkpoint 同步后才使用新版本。',
  ],
  ['Reference', 'GRPO 中冻结', '固定初始策略，衡量 KL 偏离。它与每批改变的旧策略不是同一个概念。'],
  ['Critic', 'PPO 中训练', '预测状态的未来回报，帮助估计优势。它不负责判定工单是否真实解决。'],
  ['Reward Model', '按需', '学习得到的评分模型。规则 Verifier 已能验证此案例，所以不额外训练 RM。'],
]
export const REWARD_SOURCES = [
  ['规则 / Verifier', '代码测试、交易回执、环境状态', 'CPU 与环境工程；本模拟器实际使用'],
  ['人工反馈', '偏好标签、专家 Rubric、失败复核', '标注成本与一致性校准；可训练 RM 或构造偏好对'],
  ['LLM Judge', '按 Rubric 调用已有模型评分', '额外推理 Token、延迟、偏见与校准；不等于训练一个新 RM'],
  ['学习得到的 Reward Model', '用评分或偏好数据训练评分器', '另需训练数据、训练资源与评分推理；需独立验证其泛化'],
]
export const ENGINEERING = [
  {
    title: '从动作到 Token',
    text: '这里一步选择一个离散动作。真实 LLM 会自回归生成一串 Token（包括 tool_call 参数），Harness 解析并执行，再把工具结果放回下一轮上下文。真实工具调用的参数质量也是策略能力的一部分。',
  },
  {
    title: 'Context、logprob 与训练 mask',
    text: '模型读 Prompt、历史回复和工具结果；RL 保存采样策略生成 Token 的 logprob。常见训练 mask 只让模型生成的 Token 参与策略损失，环境返回的文本不作为被奖励的模型动作。无损失 Token 仍可能消耗前向计算并被计费。',
  },
  {
    title: '梯度不需要穿过业务工具',
    text: 'Verifier 可以是一段程序、一次人工评价或一个黑盒服务。策略梯度利用 logprob 与奖励形成更新，不要求对查订单、退款 API 或奖励函数本身求导。',
  },
  {
    title: 'LoRA 与全参数',
    text: 'LoRA 更新一小组 Adapter 参数；全参数更新基座权重。两者都可以承载 RL，选择影响显存、优化器状态、部署与模型支持范围。本模拟器更新概率表，不把它当作 LoRA 性能实测。',
  },
  {
    title: '三个循环与信用分配',
    text: '一次 Agent 执行包含多次观察→动作→工具；一次 RL 迭代包含多条执行轨迹和一次/多次优化；一次产品升级包含多轮训练、评测和发布。终局奖励把结果信用传回早期动作，不能证明每个中间动作都正确。',
  },
  {
    title: '现实资源如何搭起来',
    text: '业务与数据团队准备任务和真值；环境 CPU/沙箱执行工具；Rollout GPU 生成轨迹；Trainer GPU 跑前向、反向和优化器；可选 Reference/Critic/RM 增加计算；存储与网络管理快照。角色可以共享物理硬件，不代表必须各买一套集群。',
  },
  {
    title: '复现、停止与恢复',
    text: '固定数据、种子、模型、Reward 和环境版本；跟踪 KL、奖励、独立 Eval、耗时与费用。生产训练要保存优化器状态以恢复，处理超时、抢占与过期采样。本实验只在同步后进入下一轮，方便看清 on-policy 语义。',
  },
]
export const SOURCE_CHECKED_AT = '2026-09-07'
export const SOURCES = [
  {
    title: 'Fireworks RFT：评分与环境',
    url: 'https://docs.fireworks.ai/fine-tuning/reinforcement-fine-tuning-models',
    detail: '托管 RFT 的任务、评分与环境说明。',
  },
  {
    title: 'Training API：平台与客户分工',
    url: 'https://docs.fireworks.ai/fine-tuning/training-api/introduction',
    detail:
      'Serverless 绑定快照采样；Dedicated 使用部署权重同步。文档仍含 private preview 字样，与官网 GA 横幅不一致，采购时核对具体功能状态。',
  },
  {
    title: '只采购 RL Rollout',
    url: 'https://fireworks.ai/training/rl-rollouts',
    detail: '自带训练器、让平台承接推理采样的交付方式。',
  },
  {
    title: '官方定价',
    url: 'https://fireworks.ai/pricing',
    detail:
      '核验示例：≤16B LoRA SFT $0.50/1M training tokens；Managed RFT 按 GPU 时间。Training API 分 Prefill/Cached Prefill/Sample/Train，不能把 SFT 单价用于 RL。此处价格不进入教学计算器。',
  },
].map((source) => ({ ...source, asOf: SOURCE_CHECKED_AT }))
export const QUIZ = [
  {
    question: 'Agent RL 一定需要独立 Reward Model 吗？',
    options: ['需要，否则无法训练', '不需要，可靠的规则也可以提供奖励'],
    answer: 1,
    explanation: '奖励信号必要；本例用真实环境状态评分。',
    stage: 'reward',
  },
  {
    question: '训练奖励升高就能直接发布吗？',
    options: ['可以，训练已经优化了目标', '还要独立 Eval、Serving 联调和灰度'],
    answer: 1,
    explanation: '奖励可能被钻空子，生产环境也可能不同。',
    stage: 'evaluate',
  },
  {
    question: 'GRPO 与 PPO 主要在这里怎样区别？',
    options: ['GRPO 用同任务组内比较替代 Critic 基线', 'GRPO 不需要任何奖励'],
    answer: 0,
    explanation: 'GRPO 仍然评分，并用组内相对优势更新策略。',
    stage: 'advantage',
  },
  {
    question: 'Checkpoint 保存完成后生产 Agent 会立即升级吗？',
    options: ['会，训练即上线', '不会，还要选版、部署并更新路由'],
    answer: 1,
    explanation: '训练、采样和生产是三个可分别持有旧版本的角色。',
    stage: 'sync',
  },
  {
    question: '模型调用了一个退款工具，谁真正执行退款？',
    options: ['Harness/工具执行，模型负责提议', '模型权重直接操作数据库'],
    answer: 0,
    explanation: '权限和幂等性由应用工具层执行。',
    stage: 'environment',
  },
  {
    question: '任务失败时，Provider 的资源成本如何变化？',
    options: ['自动归零', '已发生的推理、训练与工具消耗仍需计量'],
    answer: 1,
    explanation: '消费计费与按任务成功收费是不同商业模式。',
    stage: 'rollout',
  },
]
