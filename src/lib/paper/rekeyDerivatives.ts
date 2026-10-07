import type { Repos } from './repo/repos'
import type { BlockTranslation, NormalizedBlock, PaperBlock, PaperHighlight } from './types'

/**
 * 重新解析后的派生物重打键：译文（id 含 blockIndex）与高亮（blockIndex + 文本切片校验）都锚在块序号上，
 * 解析器升级后序号漂移会让它们整批失效。这里按「文本精确相等」把旧序号映射到新序号，
 * 文本未变的段落即使序号漂移，译文与高亮都保留；吞过页眉 / 脚注的段落文本变了 → 自然失效、懒重译。
 *
 * 纯函数（mapBlockIndices / planRekey）+ 一个 IO 入口（rekeyBlockDerivatives）。
 */

export interface RekeyInput {
  paperId: string
  oldBlocks: readonly PaperBlock[]
  newBlocks: readonly NormalizedBlock[]
}

export interface RekeyPlan {
  translations: { put: BlockTranslation[]; delete: string[] }
  highlights: { put: PaperHighlight[] }
  stats: { mapped: number; movedTranslations: number; movedHighlights: number }
}

type IndexedText = Pick<NormalizedBlock, 'index' | 'text'>

/**
 * 旧序号 → 新序号：按 `text.trim()` 精确相等做单调贪心（两指针 + 前瞻窗口）。
 * 单调：匹配只向前走，同一新块不会被两个旧块命中；前瞻窗口限制了重复文本（如多处「Proof.」）的误配——
 * 只在旧块附近找，命中最近的那个。空文本块不参与。
 */
export function mapBlockIndices(
  oldBlocks: readonly IndexedText[],
  newBlocks: readonly IndexedText[],
  lookahead = 64,
): Map<number, number> {
  const map = new Map<number, number>()
  const news = newBlocks.map((b) => b.text.trim())
  let j = 0
  for (const old of oldBlocks) {
    const text = old.text.trim()
    if (!text) continue
    const end = Math.min(news.length, j + lookahead)
    for (let k = j; k < end; k++) {
      if (news[k] === text) {
        map.set(old.index, newBlocks[k].index)
        j = k + 1
        break
      }
    }
  }
  return map
}

/**
 * 只对「命中且序号变化」的行产出改写：
 * - 译文行 id 含序号，必须删旧 id + 写新 id；`delete = 搬走的旧 id − 新写的 id`，
 *   防 5→6、6→7 这种链式搬迁把刚写的新行又删掉（执行方先 delete 再 put）；
 * - 高亮行 id 是 uuid，原地改 blockIndex / blockId 即可。
 * 未命中的行不动：srcHash / 文本切片校验让它们自然失效。
 */
export function planRekey(
  paperId: string,
  map: ReadonlyMap<number, number>,
  translations: readonly BlockTranslation[],
  highlights: readonly PaperHighlight[],
): RekeyPlan {
  const trPut: BlockTranslation[] = []
  const movedOldIds: string[] = []
  for (const row of translations) {
    const next = map.get(row.blockIndex)
    if (next === undefined || next === row.blockIndex) continue
    movedOldIds.push(row.id)
    trPut.push({ ...row, id: `${paperId}:${next}:${row.targetLang}`, blockIndex: next, blockId: `${paperId}:${next}` })
  }
  const putIds = new Set(trPut.map((r) => r.id))
  const trDelete = movedOldIds.filter((id) => !putIds.has(id))

  const hlPut: PaperHighlight[] = []
  for (const row of highlights) {
    const next = map.get(row.blockIndex)
    if (next === undefined || next === row.blockIndex) continue
    hlPut.push({ ...row, blockIndex: next, blockId: `${paperId}:${next}` })
  }

  return {
    translations: { put: trPut, delete: trDelete },
    highlights: { put: hlPut },
    stats: { mapped: map.size, movedTranslations: trPut.length, movedHighlights: hlPut.length },
  }
}

/**
 * IO 入口：读本篇译文 / 高亮 → 计划 → 先 deleteTranslations 再 putTranslations（同步包装层据此先推墓碑再推新行）
 * → 高亮 applyMerge([], put)。返回计划供日志 / 验收（stats）。
 */
export async function rekeyBlockDerivatives(
  input: RekeyInput,
  repos: Pick<Repos, 'translation' | 'highlight'>,
): Promise<RekeyPlan> {
  const map = mapBlockIndices(input.oldBlocks, input.newBlocks)
  const empty: RekeyPlan = {
    translations: { put: [], delete: [] },
    highlights: { put: [] },
    stats: { mapped: map.size, movedTranslations: 0, movedHighlights: 0 },
  }
  if (!map.size) return empty

  const [translations, highlights] = await Promise.all([
    repos.translation.getTranslations(input.paperId),
    repos.highlight.getHighlights(input.paperId),
  ])
  const plan = planRekey(input.paperId, map, translations, highlights)

  if (plan.translations.delete.length) await repos.translation.deleteTranslations(plan.translations.delete)
  if (plan.translations.put.length) await repos.translation.putTranslations(plan.translations.put)
  if (plan.highlights.put.length) await repos.highlight.applyMerge([], plan.highlights.put)
  return plan
}
