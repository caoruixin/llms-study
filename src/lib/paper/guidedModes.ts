/**
 * 引导模式脚本（§3.4 七入口 / §6.1c 每步 1 次调用）。
 *
 * 步序是**客户端状态机**：每一步的问题、检索查询、任务档位（普通/深度）与逐轮指令
 * 都在这里确定，模型不参与流程控制。用户点「继续下一步」才发起下一次调用——
 * 严格 1 调用/步，不会因为一次点击连发。
 *
 * 纯函数、无 React 依赖，node 环境直测。
 */

export type GuidedModeId = 'overview' | 'section' | 'method' | 'derive' | 'experiment' | 'review' | 'presales'

export interface GuidedContext {
  paperTitle: string
  /** 目录标题（逐节精读按它展开步骤） */
  sectionTitles: readonly string[]
  currentSection?: string
}

export interface GuidedStepSpec {
  /** 步骤名（UI 按钮与消息标签） */
  label: string
  question: string
  retrievalQuery: string
  /** 深度步走 PAPER_TASKS.deep（thinking on + effort high，§6.1c） */
  task: 'chat' | 'deep'
  planIsland: boolean
  extraDirectives: string[]
  /** 落库与气泡展示的用户消息文本 */
  displayText: string
}

export interface GuidedModeDef {
  id: GuidedModeId
  label: string
  hint: string
  buildSteps(ctx: GuidedContext): GuidedStepSpec[]
}

/** 引导步的 plan 岛放宽到 ~200 token（§6.1c） */
const PLAN_WIDE = '本步的 copilot:plan 岛可放宽到约 200 token：写清本步目标、讲解层级与将要使用的展示块。'

/** L2 画像弱信号（§6.2）：所有非选段快捷轮都带 */
export const LEARNER_DIRECTIVE =
  '若本轮能观察到读者对某概念的掌握信号，在回答最末尾追加一个 copilot:learner 岛（≤80 token）：{"signals":[{"concept":"概念","dir":1|0|-1,"evidence":"依据"}]}。观察不到就不要输出该岛，不要在正文提及它。'

/** teach-back 判定（§6.1e'）：verdict 尾岛 */
export const VERDICT_DIRECTIVE =
  '在回答最末尾追加一个 copilot:verdict 岛：{"verdict":"ok|partial|miss","missed":["读者遗漏或说错的点"],"evidence":["读者确实讲清楚的点"]}。正文里给出鼓励性的具体反馈，不要提及该岛。'

const blockHint = (types: readonly string[]): string =>
  `本步优先用这些展示块承载结构化内容（确有内容才用，不要硬凑）：${types.map((t) => `copilot:${t}`).join('、')}。`

const step = (
  label: string,
  question: string,
  retrievalQuery: string,
  opts: { task?: 'chat' | 'deep'; blocks?: readonly string[]; extra?: readonly string[] } = {},
): GuidedStepSpec => ({
  label,
  question,
  retrievalQuery,
  task: opts.task ?? 'chat',
  planIsland: true,
  extraDirectives: [PLAN_WIDE, ...(opts.blocks ? [blockHint(opts.blocks)] : []), ...(opts.extra ?? []), LEARNER_DIRECTIVE],
  displayText: `【${label}】`,
})

/** 逐节精读的步数上限：更长的论文由用户在目录里挑章节继续 */
export const MAX_SECTION_STEPS = 8

export const GUIDED_MODE_DEFS: readonly GuidedModeDef[] = [
  {
    id: 'overview',
    label: '论文速览',
    hint: '一次调用过一遍全文脉络',
    buildSteps: (ctx) => [
      step(
        '论文速览',
        '请给出这篇论文的速览：一句话结论、研究问题、方法要点、主要实验结果与局限，最后给出建议的阅读顺序。',
        `${ctx.paperTitle} 结论 方法 贡献 实验 局限`,
        { blocks: ['explanation', 'timeline'] },
      ),
    ],
  },
  {
    id: 'section',
    label: '逐节精读',
    hint: '按目录逐节推进，每节一次调用',
    buildSteps: (ctx) => {
      const titles = ctx.sectionTitles.filter((t) => t.trim() !== '').slice(0, MAX_SECTION_STEPS)
      if (titles.length === 0) {
        return [
          step(
            '精读全文',
            '这篇论文没有可用的章节目录，请按逻辑顺序精读：先讲主线，再逐段讲清关键定义、论证与结论。',
            `${ctx.paperTitle} 主要内容 定义 论证`,
            { blocks: ['explanation', 'quiz'] },
          ),
        ]
      }
      return titles.map((title, i) =>
        step(
          `精读 ${title}`,
          `请精读「${title}」这一节：讲清它要解决什么、关键定义与符号、论证或推导链条，以及它与全文主线的关系。最后出一道理解检查题。`,
          `${title} ${ctx.paperTitle}`,
          { blocks: i === 0 ? ['explanation', 'quiz'] : ['explanation', 'quiz', 'flashcard'] },
        ),
      )
    },
  },
  {
    id: 'method',
    label: '方法拆解',
    hint: '总览 → 组件 → 权衡 → 对比，四步',
    buildSteps: (ctx) => [
      step('方法总览', '请给出这篇论文方法/系统的总览：输入、输出、整体管线和各阶段职责。', `${ctx.paperTitle} 方法 管线 架构 概览`, {
        blocks: ['flow', 'explanation'],
      }),
      step('组件拆解', '请逐个拆解方法的核心组件：每个组件做什么、怎么做、为什么需要它。', `${ctx.paperTitle} 模块 组件 算法 步骤`, {
        blocks: ['stepper', 'explanation'],
      }),
      step('关键设计选择', '请讲清这套方法的关键设计选择与权衡：作者为什么这样选，替代方案会差在哪。', `${ctx.paperTitle} 设计选择 权衡 超参 消融`, {
        blocks: ['comparison', 'explanation'],
      }),
      step('与相关方法的差异', '请把这套方法与论文提到的基线/相关工作做对比：差异点、优势与代价。', `${ctx.paperTitle} 相关工作 基线 对比 差异`, {
        blocks: ['comparison', 'concept-map'],
      }),
    ],
  },
  {
    id: 'derive',
    label: '公式推导',
    hint: '符号 → 推导 → 边界，深度模式',
    buildSteps: (ctx) => [
      step('符号与假设', '请先建立符号表与前提假设：每个符号的含义、量纲/取值范围，以及推导所依赖的假设。', `${ctx.paperTitle} 符号 定义 假设 记号`, {
        task: 'deep',
        blocks: ['formula', 'explanation'],
      }),
      step('主要公式推导', '请逐步推导论文的主要公式：每一步写清依据（定义/假设/前一步），不要跳步。', `${ctx.paperTitle} 公式 推导 定理 证明`, {
        task: 'deep',
        blocks: ['formula', 'stepper'],
      }),
      step('适用范围与边界', '请说明该结论的适用范围与边界条件：什么情况下会失效，近似在哪里引入误差。', `${ctx.paperTitle} 假设 限制 近似 误差 边界`, {
        task: 'deep',
        blocks: ['explanation', 'teach-back'],
      }),
    ],
  },
  {
    id: 'experiment',
    label: '实验复盘',
    hint: '设置 → 主结果 → 消融 → 有效性，四步',
    buildSteps: (ctx) => [
      step('实验设置', '请复盘实验设置：数据集、基线、评价指标、硬件与超参，以及它们是否足以支撑论文主张。', `${ctx.paperTitle} 数据集 基线 指标 实验设置`, {
        blocks: ['comparison', 'explanation'],
      }),
      step('主结果解读', '请解读主结果表/图：哪些提升是显著的，哪些在噪声范围内，作者的解释是否成立。', `${ctx.paperTitle} 结果 提升 对比 表 图`, {
        blocks: ['comparison', 'explanation'],
      }),
      step('消融与敏感性', '请梳理消融实验与敏感性分析：每个部件贡献多少，哪些超参敏感。', `${ctx.paperTitle} 消融 ablation 敏感性 超参`, {
        blocks: ['comparison', 'stepper'],
      }),
      step('结论有效性', '请评估结论的有效性威胁：实验覆盖不到的场景、可能的混杂因素与过度声称的地方。', `${ctx.paperTitle} 局限 威胁 泛化 未验证`, {
        task: 'deep',
        blocks: ['explanation', 'quiz'],
      }),
    ],
  },
  {
    id: 'review',
    label: '批判性审阅',
    hint: '主张证据 → 有效性 → 可复现，深度模式',
    buildSteps: (ctx) => [
      step('主张与证据对照', '请把论文的主要主张逐条列出，并对照原文证据评估每条主张的证据强度（强/中/弱），证据不足要直说。', `${ctx.paperTitle} 主张 贡献 证据 结论`, {
        task: 'deep',
        blocks: ['comparison', 'explanation'],
      }),
      step('方法与实验有效性', '请审阅方法与实验的有效性威胁：基线是否公平、指标是否合适、结论是否被实验覆盖。', `${ctx.paperTitle} 基线 公平 指标 有效性 混杂`, {
        task: 'deep',
        blocks: ['explanation', 'concept-map'],
      }),
      step('可复现性与开放问题', '请评估可复现性（代码/数据/超参/算力披露）并列出最值得追问的开放问题。', `${ctx.paperTitle} 复现 代码 数据 开放问题 未来工作`, {
        task: 'deep',
        blocks: ['explanation', 'teach-back'],
      }),
    ],
  },
  {
    // Track 3：售前新人视角的第 7 个入口。与 persona 开关正交——persona 走 system#2
    // 自动叠加到所有模式的回答上，这里的 5 步只负责固定「售前该问的顺序」，不重复写视角约束。
    id: 'presales',
    label: '售前导读',
    hint: '定位 → 术语 → 卖点 → 话术 → 追问，五步为讲给客户听而读',
    buildSteps: (ctx) => [
      step(
        '文档定位',
        '请先帮我定位这份文档：它面向什么类型的客户/场景，主要解决什么业务问题，用一句话概括它最核心的信息，方便我判断值不值得往下细读、怎么跟客户介绍它。',
        `${ctx.paperTitle} 背景 场景 客户 业务问题 概述`,
        { blocks: ['explanation', 'timeline'] },
      ),
      step(
        '关键概念与术语表',
        '请梳理这份文档里的关键概念和专业术语，逐个给通俗解释，并配一个客户语境下的类比或例子；重点标出哪些术语客户大概率听不懂、需要我提前准备通俗说法。',
        `${ctx.paperTitle} 术语 概念 定义 缩写`,
        { blocks: ['flashcard', 'explanation'] },
      ),
      step(
        '方案架构与卖点拆解',
        '请拆解这份文档描述的方案/架构：整理出可以对客户讲的核心卖点，每个卖点对应给出客户能感知的价值，并标注支撑这个卖点的文档证据；证据不够充分的地方请直说，不要替我夸大。',
        `${ctx.paperTitle} 架构 方案 优势 卖点 价值`,
        { blocks: ['flow', 'comparison'] },
      ),
      step(
        '怎么讲给客户听',
        '请帮我准备怎么把这份文档讲给客户听：先给一个 30 秒电梯演讲版本，再分别给业务决策者版（讲价值和收益）和技术评估者版（讲架构和实现）两套话术。',
        `${ctx.paperTitle} 价值主张 电梯演讲 汇报话术`,
        { blocks: ['stepper', 'explanation'] },
      ),
      step(
        '客户追问与应对',
        '请列出客户最可能追问的问题（价格、竞品对比、落地难度、风险等），逐条给出应对角度；文档里确实没有答案的问题请直说需要另外确认，不要编造。最后出一道模拟客户追问，让我练习怎么回应。',
        `${ctx.paperTitle} 价格 竞品 风险 落地 常见问题`,
        { blocks: ['comparison', 'quiz'] },
      ),
    ],
  },
]

export const GUIDED_MODE_IDS: readonly GuidedModeId[] = GUIDED_MODE_DEFS.map((m) => m.id)

export const findGuidedMode = (id: string): GuidedModeDef | null =>
  GUIDED_MODE_DEFS.find((m) => m.id === id) ?? null

// ---------------------------------------------------------------------------
// 步序状态机
// ---------------------------------------------------------------------------

export interface GuidedRun {
  modeId: GuidedModeId
  stepIndex: number
  total: number
}

export function startGuided(modeId: string, ctx: GuidedContext): GuidedRun | null {
  const mode = findGuidedMode(modeId)
  if (!mode) return null
  const steps = mode.buildSteps(ctx)
  if (steps.length === 0) return null
  return { modeId: mode.id, stepIndex: 0, total: steps.length }
}

/** 推进一步；已是最后一步返回 null（= 引导结束） */
export function advanceGuided(run: GuidedRun, ctx: GuidedContext): GuidedRun | null {
  const mode = findGuidedMode(run.modeId)
  if (!mode) return null
  const total = mode.buildSteps(ctx).length
  const next = run.stepIndex + 1
  return next >= total ? null : { modeId: run.modeId, stepIndex: next, total }
}

export function guidedStepAt(run: GuidedRun, ctx: GuidedContext): GuidedStepSpec | null {
  const mode = findGuidedMode(run.modeId)
  if (!mode) return null
  const steps = mode.buildSteps(ctx)
  const spec = steps[run.stepIndex]
  if (!spec) return null
  // 多步模式在标签上带进度，单步模式保持原样
  if (steps.length === 1) return spec
  return { ...spec, displayText: `【${mode.label} ${run.stepIndex + 1}/${steps.length}】${spec.label}` }
}
