import { ApiRequestError } from '../auth/apiClient'

/**
 * 原始文件懒拉失败 → 用户可读文案。
 *
 * 为什么单独成模块：这条链路（IndexedDB miss → 服务端 GET /files/:id）此前用
 * `.catch(() => null)` 把所有失败折叠成「不在本机」一句话，401 过期、断网、服务端 500
 * 在用户眼里毫无区别，也没法给出正确的下一步动作。这里按 ApiRequestError.code 分类，
 * 让「重新登录」「检查网络」「换文本视图」各归各的场景。
 *
 * 404（服务端确实没有这份文件）不走这里——serverApi.getFile 对 404 返回 null，
 * 调用方用 file==null 分支单独给文案，与「失败」严格区分。
 */
export function describeFileFetchError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    // session 过期/被吊销：重试没用，必须重新登录
    if (e.code === 'unauthenticated') return '登录已过期，请重新登录后重试'
    // fetch 本身没送达（断网/DNS）：与 HTTP 错误互斥，见 apiClient 的归一约定
    if (e.code === 'network') return '网络异常，请检查网络后重试'
  }
  // 其余（服务端 5xx、本地 IndexedDB 读失败等）：兜底文案带上原始信息，方便反馈排查
  const message = e instanceof Error ? e.message : String(e)
  return `读取原始文件失败（${message}）`
}
