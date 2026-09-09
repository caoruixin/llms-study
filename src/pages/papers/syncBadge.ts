import type { SyncMetaRow } from '../../lib/paper/repo/db'
import type { PaperRecord } from '../../lib/paper/types'

/**
 * 论文库列表的同步徽标（纯函数，无 IO / 无 React）。
 *
 * 抽出来单测的理由同 workbenchLoad.ts：页面自身依赖 React/路由/懒加载弹窗，
 * 而这里的判定分支多（推送侧失败、接收侧空心、老数据缺字段），值得表驱动覆盖。
 *
 * `tone` 只描述语义，具体 class 由页面映射——helper 不关心配色。
 */
export type SyncBadge = {
  label: '已同步' | '同步中' | '同步失败' | '正文未同步' | '仅本地'
  tone: 'ok' | 'pending' | 'bad' | 'warn' | 'dim'
  /** 鼠标悬停解释（失败原因 / 空心论文怎么办） */
  title?: string
} | null

/** 接收端空心论文的解释：正文要靠原设备补推，本机点什么都拉不出来 */
export const HOLLOW_TITLE = '服务端还没有这篇的正文，原设备打开论文库即可自动补传'

/**
 * 徽标判定，按优先级短路：
 *
 * 1. 处理中/失败的论文不显示——状态列（解析中/失败）已经说明了一切，再挂个同步徽标只会干扰。
 * 2. 未登录：数据只在本浏览器，标「仅本地」。
 * 3. 推送侧失败：`lastError` 且制品尚未推齐 → 「同步失败」，`title` 带上是哪一步失败的
 *    （制品已推齐还残留 lastError 属于陈旧记录，引擎下一轮成功就会清，不必吓用户）。
 * 4. 接收侧空心（§1.4）：`applyOne` 首见远端论文时写的是 `artifactsPushed:true`
 *    （远端确实有这行），所以「有没有正文」只能看 `pullPaper` 记的 `pulledBlockCount`——
 *    拉过一轮却 0 块、而 papers 行声明有正文 → 「正文未同步」。`blocksPulled` 为真表示
 *    这轮已经拉齐，属于正常论文。老库没有 `pulledBlockCount` 字段（undefined）时不判空心，
 *    避免把存量论文全标成未同步。
 * 5. 制品推齐 → 「已同步」；其余（含没有 syncMeta 行的新论文）→ 「同步中」。
 */
export function syncBadgeFor(paper: PaperRecord, meta: SyncMetaRow | undefined, authed: boolean): SyncBadge {
  if (paper.status !== 'ready') return null
  if (!authed) return { label: '仅本地', tone: 'dim' }
  if (meta?.lastError && !meta.artifactsPushed) {
    return {
      label: '同步失败',
      tone: 'bad',
      title: `${meta.lastError.step}: ${meta.lastError.message}`,
    }
  }
  if (meta && meta.pulledBlockCount === 0 && (paper.blockCount ?? 0) > 0 && !meta.blocksPulled) {
    return { label: '正文未同步', tone: 'warn', title: HOLLOW_TITLE }
  }
  if (meta?.artifactsPushed) return { label: '已同步', tone: 'ok' }
  return { label: '同步中', tone: 'pending' }
}
