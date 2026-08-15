import type { PaperDb } from './db'
import type { CopilotMessage, CopilotSession, ModelUsageRecord, PaperBrief, ProviderConsent } from '../types'
import type { UsageDraft } from '../modelGateway'
import type { UnitDigest } from '../briefPipeline'

/**
 * Copilot 会话/授权/usage/论文地图的持久化（Phase 3）。
 * 与 paperRepo 分离：导入/阅读链路的仓储不因陪读功能膨胀；
 * 级联删除仍由 paperRepo.deletePaper 统一负责（表在 schema v1 已建齐）。
 */

const newId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export interface SessionUsageTotal {
  cost: number
  inputTokens: number
  outputTokens: number
  anyEstimated: boolean
}

export interface CopilotRepository {
  /** 每论文一个活跃会话：取最近更新的一个，没有则建 */
  getOrCreateSession(paperId: string, title: string): Promise<CopilotSession>
  updateSession(id: string, patch: Partial<CopilotSession>): Promise<void>
  /** 清空重开：删消息 + 重置会话（保留同一 session 行，id 稳定） */
  resetSession(sessionId: string): Promise<void>
  listMessages(sessionId: string): Promise<CopilotMessage[]>
  addMessage(msg: Omit<CopilotMessage, 'id'>): Promise<CopilotMessage>
  /** 局部更新（Phase 4：深度反馈 太浅/刚好/太深 的已选态） */
  updateMessage(id: string, patch: Partial<CopilotMessage>): Promise<void>

  getConsent(provider: string): Promise<ProviderConsent | undefined>
  setConsent(provider: string, granted: boolean): Promise<void>

  /** 返回落库行（含生成的 id）：P4 同步装饰器要把同一行镜像进 outbox，调用方可忽略返回值 */
  addUsage(draft: UsageDraft): Promise<ModelUsageRecord>
  usageTotal(paperId: string): Promise<SessionUsageTotal>

  getBrief(paperId: string, cacheKey: string): Promise<PaperBrief | undefined>
  saveBrief(paperId: string, cacheKey: string, data: unknown): Promise<void>
  getUnitDigest(paperId: string, cacheKey: string): Promise<UnitDigest | null>
  saveUnitDigest(paperId: string, cacheKey: string, digest: UnitDigest): Promise<void>

  setSensitive(paperId: string, sensitive: boolean): Promise<void>
}

export function createCopilotRepository(db: PaperDb): CopilotRepository {
  return {
    async getOrCreateSession(paperId, title) {
      const existing = await db.sessions.where('paperId').equals(paperId).toArray()
      if (existing.length) {
        existing.sort((a, b) => b.updatedAt - a.updatedAt)
        return existing[0]
      }
      const now = Date.now()
      const session: CopilotSession = { id: newId(), paperId, title, createdAt: now, updatedAt: now, turnsSinceMemo: 0 }
      await db.sessions.add(session)
      return session
    },

    async updateSession(id, patch) {
      await db.sessions.update(id, { ...patch, updatedAt: Date.now() })
    },

    async resetSession(sessionId) {
      await db.transaction('rw', [db.sessions, db.messages], async () => {
        await db.messages.where('sessionId').equals(sessionId).delete()
        await db.sessions.update(sessionId, {
          rollingSummary: undefined,
          turnsSinceMemo: 0,
          costTotal: 0,
          updatedAt: Date.now(),
        })
      })
    },

    async listMessages(sessionId) {
      return db.messages
        .where('[sessionId+createdAt]')
        .between([sessionId, -Infinity], [sessionId, Infinity])
        .toArray()
    },

    async addMessage(msg) {
      const row: CopilotMessage = { ...msg, id: newId() }
      await db.messages.add(row)
      return row
    },

    async updateMessage(id, patch) {
      await db.messages.update(id, patch)
    },

    getConsent: (provider) => db.consents.get(provider),

    async setConsent(provider, granted) {
      const row: ProviderConsent = { provider, granted, grantedAt: Date.now() }
      await db.consents.put(row)
    },

    async addUsage(draft) {
      const row: ModelUsageRecord = {
        id: newId(),
        paperId: draft.paperId,
        provider: draft.provider,
        model: draft.model,
        inputTokens: draft.inputTokens,
        outputTokens: draft.outputTokens,
        estimated: draft.estimated,
        cost: draft.cost,
        ts: draft.ts,
        status: draft.status,
        latencyMs: draft.latencyMs,
        task: draft.task,
      }
      await db.usage.add(row)
      return row
    },

    async usageTotal(paperId) {
      const rows = await db.usage.where('paperId').equals(paperId).toArray()
      return rows.reduce<SessionUsageTotal>(
        (acc, r) => ({
          cost: acc.cost + r.cost,
          inputTokens: acc.inputTokens + r.inputTokens,
          outputTokens: acc.outputTokens + r.outputTokens,
          anyEstimated: acc.anyEstimated || r.estimated,
        }),
        { cost: 0, inputTokens: 0, outputTokens: 0, anyEstimated: false },
      )
    },

    async getBrief(paperId, cacheKey) {
      const rows = await db.briefs.where('cacheKey').equals(cacheKey).toArray()
      return rows.find((r) => r.paperId === paperId)
    },

    async saveBrief(paperId, cacheKey, data) {
      const existing = await this.getBrief(paperId, cacheKey)
      if (existing) {
        await db.briefs.update(existing.id, { data, createdAt: Date.now() })
      } else {
        await db.briefs.add({ id: newId(), paperId, cacheKey, createdAt: Date.now(), data })
      }
    },

    async getUnitDigest(paperId, cacheKey) {
      const row = await this.getBrief(paperId, cacheKey)
      return row ? (row.data as UnitDigest) : null
    },

    async saveUnitDigest(paperId, cacheKey, digest) {
      await this.saveBrief(paperId, cacheKey, digest)
    },

    async setSensitive(paperId, sensitive) {
      await db.papers.update(paperId, { sensitive, updatedAt: Date.now() })
    },
  }
}
