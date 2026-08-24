import type { PaperDb } from './db'
import type { BlockTranslation } from '../types'

/**
 * 全文翻译的持久化（schema v3 translations 表）。
 * 与 paperRepo 分离：阅读/导入链路的仓储不因翻译功能膨胀；级联删除仍由
 * paperRepo.deletePaper 统一负责。云同步 V1 不做（译文是约 $0.05 可再生派生物），
 * 因此没有 synced 装饰器——repos.ts 直接挂裸实现。
 */

export interface TranslationRepository {
  getTranslations(paperId: string): Promise<BlockTranslation[]>
  /** bulkPut：id 是确定性拼接键，重译/并发写都是幂等覆盖 */
  putTranslations(rows: BlockTranslation[]): Promise<void>
  deleteByPaper(paperId: string): Promise<void>
}

export function createTranslationRepository(db: PaperDb): TranslationRepository {
  return {
    getTranslations: (paperId) => db.translations.where('paperId').equals(paperId).toArray(),

    async putTranslations(rows) {
      if (rows.length) await db.translations.bulkPut(rows)
    },

    async deleteByPaper(paperId) {
      await db.translations.where('paperId').equals(paperId).delete()
    },
  }
}
