import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import BlockReader from '../../components/papers/BlockReader'
import OutlinePane, { buildOutline, type OutlineTab } from '../../components/papers/OutlinePane'
import PdfViewer from '../../components/papers/PdfViewer'
import SelectionActions from '../../components/papers/SelectionActions'
import { ReaderProvider, ReaderStyles, flashElement, type ReaderApi } from '../../components/papers/ReaderContext'
import SegmentedTabs from '../../components/ui/SegmentedTabs'
import { buildAnchorContext, resolveAnchor, type ReaderMode, type ScrollTarget } from '../../lib/paper/anchors'
import { briefCacheKey, type BriefData } from '../../lib/paper/briefPipeline'
import { buildPaperIndex } from '../../lib/paper/ingest'
import { createRetrievalService, type SearchHit } from '../../lib/paper/retrieval'
import { createCopilotRepository } from '../../lib/paper/repo/copilotRepo'
import { createPaperRepository } from '../../lib/paper/repo/paperRepo'
import { getPaperDb } from '../../lib/paper/repo/db'
import { DEEPSEEK_V4_PRO } from '../../data/paperPolicy'
import type { PaperBlock, PaperRecord, SourceAnchor } from '../../lib/paper/types'
import { MAX_ASK_TEXT, PAPER_ASK_ACTIONS, usePaperUi, type PaperAskAction } from './paperUiStore'

/**
 * 阅读工作台（§3.3）：左栏目录/进度/搜索 · 中栏正文阅读器 · 右栏 Copilot（Phase 3 接入）。
 *
 * 响应式：桌面三栏（两侧可折叠）· 平板双栏 + 目录抽屉 · 手机单栏 + 目录抽屉 + Copilot 底部面板。
 * PDF 提供「原版 PDF / 文本视图」双模式，DOCX 只有语义化视图；引用跳转与选区在两种视图都可用。
 */

/** 阅读进度写库节流 */
const PROGRESS_DEBOUNCE_MS = 600
const TOAST_MS = 2600

/** Copilot 面板懒加载（§4.7）：react-markdown + KaTeX（JS/CSS/字体）只在首次展开面板时拉取 */
const CopilotPanel = lazy(() => import('../../components/papers/CopilotPanel'))

const MODE_TABS = [
  { id: 'original', label: '原版 PDF' },
  { id: 'text', label: '文本视图' },
] as const satisfies readonly { readonly id: ReaderMode; readonly label: string }[]

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const sync = () => setMatches(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [query])
  return matches
}

interface Position {
  blockIndex: number
  page?: number
  section?: string
}

export default function PaperWorkbenchPage() {
  const { paperId } = useParams<{ paperId: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const repo = useMemo(() => createPaperRepository(getPaperDb()), [])
  const copilotRepo = useMemo(() => createCopilotRepository(getPaperDb()), [])
  const retrieval = useMemo(() => createRetrievalService({ loadChunks: (id) => repo.getChunks(id) }), [repo])

  const [paper, setPaper] = useState<PaperRecord | null>(null)
  const [blocks, setBlocks] = useState<PaperBlock[]>([])
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<ReaderMode>('text')
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null)
  const [bytesError, setBytesError] = useState('')
  const [position, setPosition] = useState<Position>({ blockIndex: 0 })
  const [maxBlockIndex, setMaxBlockIndex] = useState(0)
  const [toast, setToast] = useState('')
  const [outlineTab, setOutlineTab] = useState<OutlineTab>('outline')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchRan, setSearchRan] = useState(false)

  const readerRef = useRef<HTMLElement | null>(null)
  const restoredFor = useRef<string | null>(null)
  const alignedKey = useRef('')
  // 抽屉与桌面左栏是两件事：桌面左栏默认展开，小屏抽屉默认收起（否则一进页面就被目录盖住）
  const [drawerOpen, setDrawerOpen] = useState(false)

  const isDesktop = useMediaQuery('(min-width: 1280px)')
  const isTablet = useMediaQuery('(min-width: 768px)')

  const {
    copilotOpen,
    outlineOpen,
    pendingAsks,
    briefUi,
    briefData,
    setCopilotOpen,
    setOutlineOpen,
    addPendingAsk,
    removePendingAsk,
    clearPendingAsks,
    setBriefData,
    setBriefUi,
    requestBrief,
  } = usePaperUi()

  // ---------------------------------------------------------------------
  // 数据装载
  // ---------------------------------------------------------------------

  useEffect(() => {
    if (!paperId) return
    let alive = true
    void (async () => {
      try {
        const [record, list] = await Promise.all([repo.getPaper(paperId), repo.getBlocks(paperId)])
        if (!alive) return
        setPaper(record ?? null)
        setBlocks(list)
        if (record && restoredFor.current !== paperId) {
          restoredFor.current = paperId
          const p = record.progress
          setPosition({ blockIndex: p?.blockIndex ?? 0, page: p?.page })
          setMaxBlockIndex(Math.max(p?.maxBlockIndex ?? 0, p?.blockIndex ?? 0))
          // DOCX 只有语义化视图；PDF 恢复上次用的视图，默认原版
          setMode(record.format === 'docx' ? 'text' : (p?.mode ?? 'original'))
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [paperId, repo])

  // 「启动 Copilot」入口带 ?copilot=open（HashRouter 下 query 在 hash 内，useSearchParams 正常工作）
  useEffect(() => {
    if (searchParams.get('copilot') === 'open') setCopilotOpen(true)
  }, [searchParams, setCopilotOpen])

  // 切论文时清掉上一篇的论文地图状态，再从 Dexie 载入本篇缓存
  useEffect(() => {
    if (!paperId) return
    setBriefData(null)
    setBriefUi(null)
  }, [paperId, setBriefData, setBriefUi])

  useEffect(() => {
    if (!paper || paper.id !== paperId) return
    let alive = true
    void copilotRepo
      .getBrief(paper.id, briefCacheKey(paper.sha256, DEEPSEEK_V4_PRO.provider, DEEPSEEK_V4_PRO.model))
      .then((row) => {
        if (alive && row) setBriefData({ paperId: paper.id, data: row.data as BriefData })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [paper, paperId, copilotRepo, setBriefData])

  const handleToggleSensitive = useCallback(
    (sensitive: boolean) => {
      if (!paperId) return
      void copilotRepo
        .setSensitive(paperId, sensitive)
        .then(() => setPaper((p) => (p && p.id === paperId ? { ...p, sensitive } : p)))
        .catch(() => undefined)
    },
    [copilotRepo, paperId],
  )

  // 原版模式按需取原始字节（列表页不会因此把文件读进内存）
  useEffect(() => {
    if (mode !== 'original' || !paperId || bytes) return
    let alive = true
    void repo
      .getFileBytes(paperId)
      .then((file) => {
        if (!alive) return
        if (file) setBytes(file.bytes)
        else setBytesError('原始文件字节已丢失，请用文本视图阅读或重新导入')
      })
      .catch(() => alive && setBytesError('读取原始文件失败，请改用文本视图'))
    return () => {
      alive = false
    }
  }, [mode, paperId, repo, bytes])

  /**
   * Phase 1 导入的论文没有 chunk（当时索引阶段是占位步）：首次打开时在后台补建，
   * 用户不必重新导入就能用全文搜索。
   */
  useEffect(() => {
    if (!paperId || !blocks.length) return
    let alive = true
    void (async () => {
      const existing = await repo.getChunks(paperId)
      if (!alive || existing.length) return
      await buildPaperIndex(paperId, blocks, repo)
      if (alive) retrieval.invalidate(paperId)
    })().catch(() => undefined)
    return () => {
      alive = false
    }
  }, [paperId, blocks, repo, retrieval])

  // ---------------------------------------------------------------------
  // 锚点解析与滚动
  // ---------------------------------------------------------------------

  const anchorCtx = useMemo(() => buildAnchorContext(blocks, paper?.pageCount), [blocks, paper?.pageCount])
  const blockByIndex = useMemo(() => {
    const map: PaperBlock[] = []
    for (const b of blocks) map[b.index] = b
    return map
  }, [blocks])
  const outline = useMemo(() => buildOutline(blocks), [blocks])

  // 事件回调要保持稳定引用（否则会不断重挂 IntersectionObserver），当前值走 ref
  const anchorCtxRef = useRef(anchorCtx)
  anchorCtxRef.current = anchorCtx
  const blockByIndexRef = useRef(blockByIndex)
  blockByIndexRef.current = blockByIndex
  const modeRef = useRef(mode)
  modeRef.current = mode
  const positionRef = useRef(position)
  positionRef.current = position
  const formatRef = useRef(paper?.format ?? 'pdf')
  formatRef.current = paper?.format ?? 'pdf'

  const scrollToAnchor = useCallback((anchor: Partial<SourceAnchor> | null | undefined): ScrollTarget => {
    const target = resolveAnchor(anchor, anchorCtxRef.current, modeRef.current)
    if (target.domId) {
      const el = document.getElementById(target.domId)
      if (el) {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' })
        flashElement(el)
      }
    }
    return target
  }, [])

  /** 内容就绪 / 切换视图后，把滚动位置对齐到当前阅读位置（不高亮，避免每次进页面都闪一下） */
  const alignToPosition = useCallback(() => {
    const pos = positionRef.current
    const target = resolveAnchor(
      { kind: formatRef.current, blockIndex: pos.blockIndex, page: pos.page, section: pos.section },
      anchorCtxRef.current,
      modeRef.current,
    )
    if (!target.domId) return
    const domId = target.domId
    // 两帧后再滚：等占位页 / content-visibility 块完成首次布局
    requestAnimationFrame(() => {
      requestAnimationFrame(() => document.getElementById(domId)?.scrollIntoView({ block: 'start' }))
    })
  }, [])

  const alignOnce = useCallback(
    (key: string) => {
      if (alignedKey.current === key) return
      alignedKey.current = key
      alignToPosition()
    },
    [alignToPosition],
  )

  /** 切视图要重新对齐位置：清掉 aligned 标记，让新视图挂载后把阅读位置接上 */
  const changeMode = useCallback((next: ReaderMode) => {
    alignedKey.current = ''
    setMode(next)
  }, [])

  useEffect(() => {
    if (mode !== 'text' || !blocks.length || !paperId) return
    alignOnce(`${paperId}:text`)
  }, [mode, blocks.length, paperId, alignOnce])

  const handlePdfLoaded = useCallback(() => {
    if (paperId) alignOnce(`${paperId}:original`)
  }, [alignOnce, paperId])

  // ---------------------------------------------------------------------
  // 阅读位置跟踪与持久化
  // ---------------------------------------------------------------------

  const handleVisibleBlock = useCallback((blockIndex: number) => {
    const block = blockByIndexRef.current[blockIndex]
    setPosition((prev) =>
      prev.blockIndex === blockIndex ? prev : { blockIndex, page: block?.anchor.page, section: block?.anchor.section },
    )
    setMaxBlockIndex((m) => (blockIndex > m ? blockIndex : m))
  }, [])

  const handleVisiblePage = useCallback((page: number) => {
    const blockIndex = anchorCtxRef.current.firstBlockOfPage[page]
    setPosition((prev) => {
      if (prev.page === page) return prev
      const idx = blockIndex ?? prev.blockIndex
      return { blockIndex: idx, page, section: blockByIndexRef.current[idx]?.anchor.section }
    })
    if (blockIndex !== undefined) setMaxBlockIndex((m) => (blockIndex > m ? blockIndex : m))
  }, [])

  const totalBlocks = blocks.length
  const ratio = totalBlocks ? Math.min(1, (maxBlockIndex + 1) / totalBlocks) : 0

  useEffect(() => {
    if (!paperId || !totalBlocks || loading) return
    const timer = setTimeout(() => {
      void repo
        .updateProgress(paperId, {
          blockIndex: position.blockIndex,
          ratio,
          page: position.page,
          maxBlockIndex,
          mode,
          updatedAt: Date.now(),
        })
        .catch(() => undefined)
    }, PROGRESS_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [paperId, repo, loading, totalBlocks, position.blockIndex, position.page, maxBlockIndex, ratio, mode])

  // ---------------------------------------------------------------------
  // 选区快捷操作 / 搜索
  // ---------------------------------------------------------------------

  const anchorFromElement = useCallback((el: Element): SourceAnchor | null => {
    const holder = el.closest('[data-block-index], [data-page]')
    if (!(holder instanceof HTMLElement)) return null
    const kind = formatRef.current
    const rawBlock = holder.dataset.blockIndex
    if (rawBlock !== undefined) {
      const blockIndex = Number(rawBlock)
      const block = blockByIndexRef.current[blockIndex]
      return { kind, blockIndex, page: block?.anchor.page, section: block?.anchor.section }
    }
    // 原版 PDF：文字层 span 的最近祖先是页容器，锚点精度只到页
    const page = Number(holder.dataset.page)
    const blockIndex = anchorCtxRef.current.firstBlockOfPage[page]
    return {
      kind,
      blockIndex: blockIndex ?? -1,
      page,
      section: blockIndex === undefined ? undefined : blockByIndexRef.current[blockIndex]?.anchor.section,
    }
  }, [])

  const handleAskAction = useCallback(
    (action: PaperAskAction, text: string, anchor: SourceAnchor | null) => {
      if (!paperId) return
      const pos = positionRef.current
      addPendingAsk({
        paperId,
        action,
        label: PAPER_ASK_ACTIONS.find((a) => a.id === action)?.label ?? '加入提问',
        text: text.slice(0, MAX_ASK_TEXT),
        anchor: anchor ?? { kind: formatRef.current, blockIndex: pos.blockIndex, page: pos.page, section: pos.section },
      })
      setCopilotOpen(true)
      setToast('已加入 Copilot 待提问，在右栏点击即可发起')
    },
    [addPendingAsk, paperId, setCopilotOpen],
  )

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  const runSearch = useCallback(() => {
    if (!paperId || !searchQuery.trim()) return
    setSearchBusy(true)
    void retrieval
      .search(paperId, searchQuery, { limit: 20 })
      .then((hits) => setSearchHits(hits))
      .catch(() => setSearchHits([]))
      .finally(() => {
        setSearchBusy(false)
        setSearchRan(true)
      })
  }, [paperId, retrieval, searchQuery])

  const jumpToBlock = useCallback(
    (blockIndex: number) => {
      const block = blockByIndexRef.current[blockIndex]
      scrollToAnchor(block?.anchor ?? { kind: formatRef.current, blockIndex })
      setDrawerOpen(false)
    },
    [scrollToAnchor],
  )

  const jumpToAnchor = useCallback(
    (anchor: SourceAnchor) => {
      const target = scrollToAnchor(anchor)
      setDrawerOpen(false)
      return target
    },
    [scrollToAnchor],
  )

  const readerApi: ReaderApi = useMemo(
    () => ({ mode, setMode: changeMode, scrollToAnchor, position }),
    [mode, changeMode, scrollToAnchor, position],
  )

  // ---------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------

  if (loading) return <p className="text-sm text-dim">正在加载论文…</p>

  if (!paper) {
    return (
      <div className="rounded-xl border border-line bg-panel p-6 shadow-sm">
        <p className="mb-3 font-medium text-fg">找不到这篇论文</p>
        <p className="mb-4 text-sm text-dim">它可能已经被删除，或者这个链接来自另一个浏览器的本地论文库。</p>
        <button
          type="button"
          onClick={() => navigate('/papers')}
          className="rounded-lg border border-line bg-panel px-4 py-2 text-sm text-fg transition-colors hover:bg-panel-2"
        >
          返回论文库
        </button>
      </div>
    )
  }

  if (paper.status !== 'ready') {
    return (
      <div className="rounded-xl border border-line bg-panel p-6 shadow-sm">
        <p className="mb-3 font-medium text-fg">「{paper.title}」还不能阅读</p>
        <p className="mb-4 text-sm text-dim">
          {paper.status === 'failed' ? (paper.failure?.message ?? '解析失败') : '正在解析中，请稍后回到论文库查看进度。'}
        </p>
        <button
          type="button"
          onClick={() => navigate('/papers')}
          className="rounded-lg border border-line bg-panel px-4 py-2 text-sm text-fg transition-colors hover:bg-panel-2"
        >
          返回论文库
        </button>
      </div>
    )
  }

  const outlinePane = (
    <OutlinePane
      outline={outline}
      currentBlockIndex={position.blockIndex}
      maxBlockIndex={maxBlockIndex}
      ratio={ratio}
      tab={outlineTab}
      onTabChange={setOutlineTab}
      onJumpBlock={jumpToBlock}
      onJumpAnchor={jumpToAnchor}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      onSearch={runSearch}
      searchHits={searchHits}
      searchBusy={searchBusy}
      searchRan={searchRan}
      brief={briefData && briefData.paperId === paperId ? briefData.data : null}
      briefUi={briefUi && briefUi.paperId === paperId ? briefUi : null}
      onGenerateBrief={requestBrief}
    />
  )

  const copilotPane = (
    <Suspense fallback={<p className="text-sm text-dim">正在加载 Copilot…</p>}>
      <CopilotPanel
        paper={paper}
        blocks={blocks}
        retrieval={retrieval}
        position={position}
        sectionTitles={outline.map((o) => o.text)}
        asks={pendingAsks.filter((a) => a.paperId === paperId)}
        onRemoveAsk={removePendingAsk}
        onClearAsks={clearPendingAsks}
        onJumpAnchor={jumpToAnchor}
        onClose={() => setCopilotOpen(false)}
        onToggleSensitive={handleToggleSensitive}
      />
    </Suspense>
  )

  const showOutlineColumn = isDesktop && outlineOpen
  const showCopilotColumn = isTablet && copilotOpen
  const showOutlineDrawer = !isDesktop && drawerOpen
  const showCopilotSheet = !isTablet && copilotOpen

  return (
    <ReaderProvider value={readerApi}>
      {/* 工作台突破站点 max-w-7xl：以视口为基准全宽居中，减去 2rem 给滚动条留位 */}
      <div className="relative left-1/2 w-[min(100vw-2rem,110rem)] -translate-x-1/2 space-y-3">
        <ReaderStyles />

        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => navigate('/papers')}
              className="mb-1 text-sm text-dim transition-colors hover:text-fg"
            >
              ← 返回论文库
            </button>
            <h1 className="truncate text-xl font-bold">{paper.title}</h1>
            <p className="text-xs text-dim">
              {paper.format.toUpperCase()}
              {paper.pageCount ? ` · ${paper.pageCount} 页` : ''} · {totalBlocks} 段 · 已读 {Math.round(ratio * 100)}%
              {position.page !== undefined ? ` · 当前第 ${position.page} 页` : ''}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {paper.format === 'pdf' && <SegmentedTabs tabs={MODE_TABS} value={mode} onChange={changeMode} />}
            {!isDesktop && (
              <button
                type="button"
                onClick={() => setDrawerOpen(!drawerOpen)}
                className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-fg transition-colors hover:bg-panel-2"
              >
                目录
              </button>
            )}
            {isDesktop && (
              <button
                type="button"
                onClick={() => setOutlineOpen(!outlineOpen)}
                className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-dim transition-colors hover:bg-panel-2"
              >
                {outlineOpen ? '收起目录' : '展开目录'}
              </button>
            )}
            {!copilotOpen && (
              <button
                type="button"
                onClick={() => setCopilotOpen(true)}
                className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
              >
                展开 Copilot
              </button>
            )}
          </div>
        </header>

        <div className="flex h-[calc(100dvh-14rem)] min-h-[24rem] gap-3">
          {showOutlineColumn && (
            <aside className="w-64 shrink-0 overflow-hidden rounded-xl border border-line bg-panel p-4 shadow-sm">
              {outlinePane}
            </aside>
          )}

          <main
            ref={readerRef}
            className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-line bg-panel p-4 shadow-sm"
          >
            {mode === 'original' && paper.format === 'pdf' ? (
              bytesError ? (
                <div className="rounded-lg border border-bad/40 p-4 text-sm text-bad">{bytesError}</div>
              ) : bytes ? (
                <PdfViewer
                  bytes={bytes}
                  containerRef={readerRef}
                  onVisiblePage={handleVisiblePage}
                  onLoaded={handlePdfLoaded}
                />
              ) : (
                <p className="text-sm text-dim">正在读取原始文件…</p>
              )
            ) : (
              <BlockReader blocks={blocks} containerRef={readerRef} onVisibleBlock={handleVisibleBlock} />
            )}
          </main>

          {showCopilotColumn && (
            <aside className="w-80 shrink-0 overflow-hidden rounded-xl border border-line bg-panel p-4 shadow-sm xl:w-88">
              {copilotPane}
            </aside>
          )}
        </div>

        {/* 平板 / 手机：目录抽屉 */}
        {showOutlineDrawer && (
          <div className="fixed inset-0 z-40 flex">
            <div
              className="flex-1 bg-ink/60 backdrop-blur-[1px]"
              role="presentation"
              onClick={() => setDrawerOpen(false)}
            />
            <div className="h-full w-[min(20rem,85vw)] overflow-hidden border-l border-line bg-panel p-4 shadow-lg">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-fg">目录与搜索</span>
                <button type="button" onClick={() => setDrawerOpen(false)} className="text-sm text-dim hover:text-fg">
                  关闭
                </button>
              </div>
              <div className="h-[calc(100%-2rem)]">{outlinePane}</div>
            </div>
          </div>
        )}

        {/* 手机：Copilot 底部面板 */}
        {showCopilotSheet && (
          <div className="fixed inset-x-0 bottom-0 z-40 max-h-[70dvh] overflow-hidden rounded-t-xl border-t border-line bg-panel p-4 shadow-lg">
            <div className="h-[min(60dvh,32rem)]">{copilotPane}</div>
          </div>
        )}

        {toast && (
          <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line bg-panel px-4 py-2 text-sm text-fg shadow-md">
            {toast}
          </div>
        )}

        <SelectionActions
          containerRef={readerRef}
          anchorFromElement={anchorFromElement}
          onAction={handleAskAction}
        />
      </div>
    </ReaderProvider>
  )
}
