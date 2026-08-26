import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getRepos } from '../repo/repos'
import type { PaperHighlight } from '../types'
import { mergeRanges, newHighlightId } from './highlightModel'
import type { CapturedRange } from './selectionOffsets'

/**
 * 划词高亮的状态编排（照 useTranslations 的外壳形状）：整表载入内存、
 * 添加（含重叠合并）与删除。写路径先同步更新内存态再落库，落库失败不回滚——
 * 本会话高亮仍可见可用，代价只是刷新后丢失（与译文落库同一取舍）。
 */

export interface UseHighlightsResult {
  /** 全量行（未排序）：工作台侧排好序再喂 OutlinePane 列表 */
  highlights: readonly PaperHighlight[]
  /** blockIndex → 该块全部高亮（不分 lang，渲染端按宿主语言过滤），直接喂 BlockReader */
  byBlock: ReadonlyMap<number, PaperHighlight[]>
  /** 返回实际新建/合并的条数（每条 captured 产出一行合并结果）；blockIdOf 解析真实块 uuid（沿 BlockTranslation.blockId 惯例） */
  addCaptured: (captured: readonly CapturedRange[], blockIdOf: (blockIndex: number) => string | undefined) => number
  remove: (id: string) => void
}

export function useHighlights(paperId: string | undefined): UseHighlightsResult {
  const [rows, setRows] = useState<readonly PaperHighlight[]>([])
  // 同 tick 连续写入要看到彼此的结果（跨块选区逐条合并），当前值走 ref 不等重渲染
  const rowsRef = useRef<readonly PaperHighlight[]>([])

  const commit = useCallback((next: readonly PaperHighlight[]) => {
    rowsRef.current = next
    setRows(next)
  }, [])

  useEffect(() => {
    rowsRef.current = []
    setRows([])
    if (!paperId) return
    let alive = true
    void getRepos()
      .highlight.getHighlights(paperId)
      .then((loaded) => {
        // stale 取消：换论文后旧载入结果作废
        if (alive) {
          rowsRef.current = loaded
          setRows(loaded)
        }
      })
      .catch(() => undefined) // 读库失败按空高亮处理，不阻断阅读
    return () => {
      alive = false
    }
  }, [paperId])

  const addCaptured = useCallback(
    (captured: readonly CapturedRange[], blockIdOf: (blockIndex: number) => string | undefined): number => {
      if (!paperId || !captured.length) return 0
      const toDelete: string[] = []
      const toPut: PaperHighlight[] = []
      let next = rowsRef.current
      for (const c of captured) {
        // 只跟同块同语言的既有行合并：不同语言各是独立的偏移空间
        const peers = next.filter((r) => r.blockIndex === c.blockIndex && r.lang === c.lang)
        const merged = mergeRanges(peers, c.start, c.end)
        const row: PaperHighlight = {
          id: newHighlightId(),
          paperId,
          blockIndex: c.blockIndex,
          blockId: blockIdOf(c.blockIndex) ?? '',
          lang: c.lang,
          start: merged.start,
          end: merged.end,
          // 合并可能扩出捕获区间：快照从宿主全文重切，保证与 [start, end) 一致
          text: c.sourceText.slice(merged.start, merged.end),
          createdAt: Date.now(),
        }
        const dead = new Set(merged.toDelete)
        next = [...next.filter((r) => !dead.has(r.id)), row]
        toDelete.push(...merged.toDelete)
        toPut.push(row)
      }
      commit(next)
      // 落库失败不回滚内存态：本会话仍可见，刷新后丢这一笔
      void getRepos().highlight.applyMerge(toDelete, toPut).catch(() => undefined)
      return toPut.length
    },
    [paperId, commit],
  )

  const remove = useCallback(
    (id: string) => {
      commit(rowsRef.current.filter((r) => r.id !== id))
      void getRepos().highlight.deleteHighlights([id]).catch(() => undefined)
    },
    [commit],
  )

  const byBlock = useMemo(() => {
    const map = new Map<number, PaperHighlight[]>()
    for (const r of rows) {
      const list = map.get(r.blockIndex)
      if (list) list.push(r)
      else map.set(r.blockIndex, [r])
    }
    return map
  }, [rows])

  return { highlights: rows, byBlock, addCaptured, remove }
}
