import type { PaperDb } from './db'
import type { EvidenceRecord, LearnerConceptState, StoredEvidence } from '../types'
import {
  PAPER_LEVEL_CONCEPT,
  emptyProfile,
  levelOfMastery,
  type ConceptProfile,
  type EvidenceDir,
  type EvidenceSource,
  type LearnerLevel,
  type ProfileEvidence,
} from '../learnerProfile'

/**
 * 学习画像持久化（Phase 4）：conceptStates 存每概念状态 + 最近证据窗口，
 * evidence 表存 append-only 日志（每条证据按概念展开成多行，含整体行 '*'）。
 *
 * 纯函数画像引擎在 learnerProfile.ts；这里只做形状映射与 Dexie 读写，
 * 便于 fake-indexeddb 直测。
 */

const newId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const LEVELS: readonly string[] = ['入门', '进阶', '研究']
const asLevel = (v: string | undefined): LearnerLevel | null => (v && LEVELS.includes(v) ? (v as LearnerLevel) : null)
const asDir = (v: number): EvidenceDir => (v > 0 ? 1 : v < 0 ? -1 : 0)

export function rowToProfile(row: LearnerConceptState): ConceptProfile {
  const profile: ConceptProfile = {
    conceptId: row.conceptId,
    mastery: row.mastery,
    confidence: row.confidence,
    level: asLevel(row.level) ?? levelOfMastery(row.mastery),
    levelChangedAt: row.levelChangedAt ?? row.updatedAt,
    evidence: (row.recentEvidence ?? []).map((e) => ({
      conceptIds: [row.conceptId],
      dir: asDir(e.dir),
      weight: e.weight,
      ts: e.ts,
      source: e.source as EvidenceSource,
    })),
    updatedAt: row.updatedAt,
  }
  const pinned = asLevel(row.pinnedLevel)
  if (pinned) profile.pinnedLevel = pinned
  return profile
}

export function profileToRow(paperId: string, profile: ConceptProfile): LearnerConceptState {
  const recentEvidence: StoredEvidence[] = profile.evidence.map((e) => ({
    dir: e.dir,
    weight: e.weight,
    ts: e.ts,
    source: e.source,
  }))
  const row: LearnerConceptState = {
    // 复合主键手工拼接：一个 (paperId, conceptId) 只有一行，重复写入是幂等 put
    id: `${paperId}:${profile.conceptId}`,
    paperId,
    conceptId: profile.conceptId,
    mastery: profile.mastery,
    confidence: profile.confidence,
    updatedAt: profile.updatedAt,
    level: profile.level,
    levelChangedAt: profile.levelChangedAt,
    recentEvidence,
  }
  if (profile.pinnedLevel) row.pinnedLevel = profile.pinnedLevel
  return row
}

export interface LearnerRepository {
  load(paperId: string): Promise<ConceptProfile[]>
  save(paperId: string, profiles: readonly ConceptProfile[]): Promise<void>
  /** append-only 日志：每个受影响概念（含 '*'）一行 */
  logEvidence(paperId: string, ev: ProfileEvidence): Promise<void>
  listEvidence(paperId: string): Promise<EvidenceRecord[]>
  reset(paperId: string): Promise<void>
}

export function createLearnerRepository(db: PaperDb): LearnerRepository {
  return {
    async load(paperId) {
      const rows = await db.conceptStates.where('paperId').equals(paperId).toArray()
      const profiles = rows.map(rowToProfile)
      // 整体行缺失（旧数据/首次）时补一个，调用方永远拿得到层级
      if (!profiles.some((p) => p.conceptId === PAPER_LEVEL_CONCEPT)) {
        profiles.push(emptyProfile(PAPER_LEVEL_CONCEPT, Date.now()))
      }
      return profiles
    },

    async save(paperId, profiles) {
      await db.conceptStates.bulkPut(profiles.map((p) => profileToRow(paperId, p)))
    },

    async logEvidence(paperId, ev) {
      const ids = [...new Set([PAPER_LEVEL_CONCEPT, ...ev.conceptIds])]
      const rows: EvidenceRecord[] = ids.map((conceptId) => ({
        id: newId(),
        paperId,
        conceptId,
        dir: ev.dir,
        weight: ev.weight,
        source: ev.source,
        ts: ev.ts,
      }))
      await db.evidence.bulkAdd(rows)
    },

    listEvidence: (paperId) => db.evidence.where('paperId').equals(paperId).toArray(),

    async reset(paperId) {
      await db.transaction('rw', [db.conceptStates, db.evidence], async () => {
        await db.conceptStates.where('paperId').equals(paperId).delete()
        await db.evidence.where('paperId').equals(paperId).delete()
      })
    },
  }
}
