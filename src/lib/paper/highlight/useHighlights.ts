import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getRepos } from '../repo/repos'
// 事件过滤只此一份定义（paper-sync-pulled 的 detail 契约对译文/高亮完全相同），
// 免得两处守卫各自漂移；useTranslations 无模块级副作用（网关是懒单例）
import { isPulledFor } from '../translate/useTranslations'
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

  /**
   * 本地写入的在途链：同步补拉后的重读排在它之后，才不会读到「还没落库的本机新行」。
   * （同步装饰器的 applyMerge 会先 await 一次 bulkGet 查归属，写事务不是同步开的——
   * 单靠 IndexedDB 的事务排队保证不了顺序。）失败也要让链继续，故 catch 成 resolved。
   */
  const localWrites = useRef<Promise<void>>(Promise.resolve())
  const trackWrite = useCallback((p: Promise<unknown>) => {
    // 立刻吞掉 p 的失败（等入链再挂 handler 会漏出 unhandledrejection），链本身永不 reject
    const settled = p.then(
      () => undefined,
      () => undefined,
    )
    localWrites.current = localWrites.current.then(
      () => settled,
      () => settled,
    )
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

  // 跨设备同步：另一台设备的高亮被补拉进本地库后重读整表（PLAN 1.6 的客户端失效通知）。
  // Dexie 是真相，直接覆盖内存态即可——重读排在本地在途写入之后，刚在本机划的行不会被吞掉。
  useEffect(() => {
    if (!paperId) return
    let alive = true
    const onPulled = (e: Event) => {
      if (!isPulledFor((e as CustomEvent).detail, paperId, 'highlights')) return
      void localWrites.current
        .then(() => getRepos().highlight.getHighlights(paperId))
        .then((loaded) => {
          if (alive) commit(loaded)
        })
        .catch(() => undefined) // 读库失败保留现有内存态：下次补拉/重开还有机会
    }
    window.addEventListener('paper-sync-pulled', onPulled)
    return () => {
      alive = false
      window.removeEventListener('paper-sync-pulled', onPulled)
    }
  }, [paperId, commit])

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
      trackWrite(getRepos().highlight.applyMerge(toDelete, toPut))
      return toPut.length
    },
    [paperId, commit, trackWrite],
  )

  const remove = useCallback(
    (id: string) => {
      commit(rowsRef.current.filter((r) => r.id !== id))
      trackWrite(getRepos().highlight.deleteHighlights([id]))
    },
    [commit, trackWrite],
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
