import type { AuthStatus } from '../../lib/auth/authStore'
import type { PaperRecord } from '../../lib/paper/types'

/**
 * 工作台装载判定（纯函数，无 IO / 无 React）。
 *
 * 页面本身静态 import pdfjs，做不了 happy-dom 页面测试，所以把这两条判定抽出来在 node 下表驱动单测。
 *
 * 关键设计：**判定非锁存**。旧实现拿 `syncMeta.blocksPulled` 当门槛（`pullPaper` 拉到 0 块
 * 也会置 true），一旦原设备还没把 blocks 推上去，接收设备就永久停在「0 段」不再重试。
 * 这里只看「本地块数 vs 记录声明的块数」——每次打开都会重算，原设备补推后自然收敛。
 */

export interface LoadDecisionInput {
  authStatus: AuthStatus
  /** 本地 papers 行（undefined = 本地库里根本没有这篇） */
  record: PaperRecord | undefined
  /** 本地 blocks 表里这篇的行数 */
  localBlocks: number
}

/**
 * 是否要向服务端按篇补拉一轮。
 *
 * - 未登录（含 `unknown`，登录态未定时调用方压根不该读库）：没有远端可拉。
 * - 本地没有 papers 行：必拉（换设备打开深链的主路径）。
 * - 有行且已 ready：本地块数不足记录声明的块数就补拉；`blockCount` 缺省按「至少 1 块」算，
 *   于是 0 块的空心论文总会重试，块数已足的正常论文一次都不会白跑。
 * - 解析中/失败的论文不拉：正文本来就不该存在，拉了也是空。
 */
export function needsRemotePull(i: LoadDecisionInput): boolean {
  if (i.authStatus !== 'authed') return false
  if (!i.record) return true
  return i.record.status === 'ready' && i.localBlocks < (i.record.blockCount ?? 1)
}

/**
 * 空心论文：papers 行说「可读」，本地却一个正文块都没有。
 * 补拉跑完仍然空心 = 原设备还没推 blocks，渲染「正文尚未从原设备同步」面板而不是空白阅读器。
 */
export function isHollow(record: PaperRecord | undefined, localBlocks: number): boolean {
  return record?.status === 'ready' && localBlocks === 0
}
