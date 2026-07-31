// 顶部导航表：App 与 SelectionAsk 同源引用，避免 App ↔ SelectionAsk 循环导入
export const NAV = [
  { to: '/architecture', label: '架构演进' },
  { to: '/inference', label: '推理链路' },
  { to: '/agent', label: 'Agent 架构' },
  { to: '/interview', label: '面试陪练' },
  { to: '/settings', label: '设置' },
]
