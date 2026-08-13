/**
 * §4.5 配额预检：导入前估算本地存储余量，不足则拒绝而不是写到一半炸掉。
 * StorageManager API 不存在（老浏览器 / 隐私模式）时一律放行——降级为 no-op，
 * 真正的配额问题仍会在写入时以 QuotaExceededError 形式被仓储层捕获并分类为 storage 失败。
 */
export async function ensureStorageFor(bytes: number): Promise<{ ok: boolean; message?: string }> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return { ok: true }

  try {
    // 首次导入时申请持久化存储，降低浏览器在磁盘紧张时清空 IndexedDB 的概率
    if (navigator.storage.persist) {
      const persisted = await navigator.storage.persisted?.()
      if (persisted === false) await navigator.storage.persist()
    }

    const { quota, usage } = await navigator.storage.estimate()
    if (typeof quota !== 'number' || typeof usage !== 'number') return { ok: true }

    // 留 2 倍余量：原始字节 + 解析出的正文块大致同量级，且浏览器配额本身是估算值
    const free = quota - usage
    if (free < bytes * 2) {
      const freeMb = (free / 1024 / 1024).toFixed(0)
      const needMb = ((bytes * 2) / 1024 / 1024).toFixed(0)
      return { ok: false, message: `本地存储余量约 ${freeMb} MB，导入这个文件约需 ${needMb} MB，请先删除一些论文` }
    }
    return { ok: true }
  } catch {
    return { ok: true }
  }
}
