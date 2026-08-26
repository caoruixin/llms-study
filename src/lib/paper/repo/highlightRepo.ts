import type { PaperDb } from './db'
import type { PaperHighlight } from '../types'

/**
 * 划词高亮的持久化（schema v4 highlights 表）。
 * 与 paperRepo 分离照 translationRepo 先例：阅读链路仓储不因高亮功能膨胀；
 * 级联删除仍由 paperRepo.deletePaper 统一负责。云同步 V1 不做（本地阅读标记，
 * 以后要同步再加 outbox 白名单），因此没有 synced 装饰器——repos.ts 直接挂裸实现。
 */

export interface HighlightRepository {
  getHighlights(paperId: string): Promise<PaperHighlight[]>
  /** 合并写入：删被吞并旧行 + 写合并行，单事务——中途失败不留「旧行没了新行没进」的半截态 */
  applyMerge(toDelete: readonly string[], toPut: readonly PaperHighlight[]): Promise<void>
  deleteHighlights(ids: readonly string[]): Promise<void>
  deleteByPaper(paperId: string): Promise<void>
}

export function createHighlightRepository(db: PaperDb): HighlightRepository {
  return {
    getHighlights: (paperId) => db.highlights.where('paperId').equals(paperId).toArray(),

    async applyMerge(toDelete, toPut) {
      if (!toDelete.length && !toPut.length) return
      await db.transaction('rw', [db.highlights], async () => {
        if (toDelete.length) await db.highlights.bulkDelete([...toDelete])
        if (toPut.length) await db.highlights.bulkPut([...toPut])
      })
    },

    async deleteHighlights(ids) {
      if (ids.length) await db.highlights.bulkDelete([...ids])
    },

    async deleteByPaper(paperId) {
      await db.highlights.where('paperId').equals(paperId).delete()
    },
  }
}
