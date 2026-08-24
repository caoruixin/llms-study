/**
 * 售前新人视角（PLAN-papers-url-translate-presales.md Track 3）。
 *
 * persona 是 per-paper 的读者视角开关，落在 CopilotSession.persona 上，跨设备随 sessions 表
 * 免费同步（updateSession 已被 synced 装饰）。它只影响 contextBuilder 第 2 层（system#2）
 * 追加的一段 directive 文本——**不碰 system#1 静态 tutor prompt，也不改
 * PAPER_TUTOR_PROMPT_VERSION**，字节稳定性与前缀缓存命中不受影响。
 *
 * 纯常量 + 纯函数，无 React / IO 依赖，node 环境直测。
 */

export type PersonaId = 'none' | 'presales'

export interface PersonaDef {
  id: PersonaId
  /** chip 上显示的短标签 */
  label: string
  /** popover 里的一句话说明，帮用户判断要不要开 */
  description: string
  /** 注入 system#2 层的 directive 文本；'none' 无 directive（该层可整段省略） */
  directive: string | null
}

/**
 * 【读者视角】售前新人 SA directive（PLAN Track 3 草稿）：五条硬约束——
 * 术语通俗化、技术点映射客户价值、给话术示例、主动点竞品与追问、要求纯技术讲解时立即切换。
 */
const PRESALES_DIRECTIVE = `【读者视角】读者是刚入行的售前解决方案架构师（SA），读这篇论文是为了讲给客户听、支撑方案沟通与项目汇报，不是做研究。请始终按这个视角组织回答，直到读者要求切换：
1. 术语与缩写第一次出现时，用一两句通俗解释说明它是什么、解决什么问题，不要假设读者已经懂行话。
2. 把技术点主动映射到客户能听懂的业务价值：这一点对客户意味着什么痛点被解决，能拿到什么可量化的收益（性能、成本、效率、风险等）。
3. 讲清关键结论后，给一句「可以这样向客户讲」的话术示例，贴近真实汇报场景，不是逐字复述论文原文。
4. 主动点出客户可能追问的竞品差异、局限或风险，并给出应对角度；论文本身没讲到的地方要直说"论文没有覆盖，需要另外确认"，不要编造。
5. 如果读者明确要求纯技术讲解、不要售前视角，立即切换回正常讲解模式，不要反复确认或坚持售前框架。
6. 术语、缩写或行业背景类问题即使论文片段未覆盖，也不要只回答「无法解释」：先声明论文未直接覆盖，再给出标注为【通用行业知识，非本文内容】的简短解释与客户价值，不加 [[cite]]；涉及论文事实与数据的判断仍以片段为准。`

export const PERSONA_DEFS: readonly PersonaDef[] = [
  {
    id: 'none',
    label: '默认',
    description: '按常规讲解层次作答，不额外套用售前视角。',
    directive: null,
  },
  {
    id: 'presales',
    label: '售前新人 SA',
    description: '面向刚入行的售前解决方案架构师：术语通俗化、映射客户价值、给话术示例、主动点竞品与追问。',
    directive: PRESALES_DIRECTIVE,
  },
]

/** 未知/缺省 id 一律回退到 PERSONA_DEFS[0]（'none'），保证调用方永远拿到一个合法档位 */
export function findPersona(id: string | null | undefined): PersonaDef {
  return PERSONA_DEFS.find((p) => p.id === id) ?? PERSONA_DEFS[0]
}

/** contextBuilder 第 2 层注入用：'none' 或未知 id → null（整层可省略，不留空字符串占位） */
export function personaHintText(id: string | null | undefined): string | null {
  return findPersona(id).directive
}
