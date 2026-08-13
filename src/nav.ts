// 顶部导航表：App 与 SelectionAsk 同源引用，避免 App ↔ SelectionAsk 循环导入
// 论文陪读为 build-time flag 门控：一处门控同时覆盖 App 路由与 SelectionAsk 的 pageLabel 查表
const PAPER_ENABLED = import.meta.env.VITE_ENABLE_PAPER_COPILOT === '1'

export const NAV = [
  { to: '/architecture', label: '架构演进' },
  { to: '/inference', label: '推理链路' },
  { to: '/agent', label: 'Agent 架构' },
  // /kda 不在顶部导航：入口收纳在 架构演进 → 注意力演进 → KDA/GDN 行的「交互式拆解」链接
  { to: '/interview', label: '面试陪练' },
  ...(PAPER_ENABLED ? [{ to: '/papers', label: '论文陪读' }] : []),
  { to: '/settings', label: '设置' },
]
