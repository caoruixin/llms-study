import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import BlockReader from '../../components/papers/BlockReader'
import OutlinePane, { buildOutline, type OutlineTab } from '../../components/papers/OutlinePane'
import PdfViewer from '../../components/papers/PdfViewer'
import SelectionActions from '../../components/papers/SelectionActions'
import { ReaderProvider, ReaderStyles, flashElement, type ReaderApi } from '../../components/papers/ReaderContext'
import Drawer from '../../components/ui/Drawer'
import SegmentedTabs from '../../components/ui/SegmentedTabs'
import { buildAnchorContext, resolveAnchor, type ReaderMode, type ScrollTarget } from '../../lib/paper/anchors'
import { briefCacheKey, type BriefData } from '../../lib/paper/briefPipeline'
import { buildPaperIndex } from '../../lib/paper/ingest'
import { createRetrievalService, type SearchHit } from '../../lib/paper/retrieval'
import { createCopilotRepository } from '../../lib/paper/repo/copilotRepo'
import { createPaperRepository } from '../../lib/paper/repo/paperRepo'
import { getPaperDb } from '../../lib/paper/repo/db'
import { MQ, useMediaQuery } from '../../lib/useMediaQuery'
import { DEEPSEEK_V4_PRO } from '../../data/paperPolicy'
import type { PaperBlock, PaperRecord, SourceAnchor } from '../../lib/paper/types'
import {
  MAX_ASK_TEXT,
  PAPER_ASK_ACTIONS,
  allowedCopilotWidths,
  effectiveCopilotWidth,
  nextCopilotWidth,
  usePaperUi,
  type CopilotWidth,
  type PaperAskAction,
} from './paperUiStore'

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

/**
 * Copilot 宽度档位 → 类名。必须是完整字面量（Tailwind 只扫描源码里出现的完整类名，
 * 拼接出来的 `w-${x}` 不会被生成），沿 TransformerDiagram.tsx:41 的映射表先例。
 */
const COPILOT_WIDTH_CLASS: Record<CopilotWidth, string> = {
  standard: 'w-80 xl:w-88',
  wide: 'w-[30rem]',
  max: 'w-[40rem]',
}

const COPILOT_WIDTH_LABEL: Record<CopilotWidth, string> = {
  standard: '标准',
  wide: '加宽',
  max: '超宽',
}

/**
 * 正文最小宽度兜底：窗口再窄也给正文留 ≥360px 的**内容区**（clientWidth，已扣掉 1px×2 边框
 * 与 8px 滚动条，见 index.css 的 `::-webkit-scrollbar`）——即边框盒 ≥ 370px ≈ 23.125rem。
 * 纯 CSS 连续钳位（无 JS 测量）——工作台宽度是 100vw-2rem，减掉目录列/列间距/正文下限即上限：
 * - 有目录：100vw-2rem-16rem(w-64)-0.75rem×2(gap-3)-23.25rem = 100vw-42.75rem → 正文 372px，内容区 362px
 * - 无目录：100vw-2rem-0.75rem(gap-3)-23.5rem = 100vw-26.25rem → 正文 376px，内容区 366px
 */
const COPILOT_CLAMP_WITH_OUTLINE = 'max-w-[calc(100vw-42.75rem)]'
const COPILOT_CLAMP_NO_OUTLINE = 'max-w-[calc(100vw-26.25rem)]'

function scrollAndFlash(domId: string): void {
  const el = document.getElementById(domId)
  if (!el) return
  el.scrollIntoView({ block: 'start', behavior: 'smooth' })
  flashElement(el)
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
  // 手机：Copilot 底部面板可切全屏（长回答 + 交互块在 390px 下需要整屏）
  const [sheetFull, setSheetFull] = useState(false)

  const isDesktop = useMediaQuery(MQ.xl)
  const isTablet = useMediaQuery(MQ.md)

  const {
    copilotOpen,
    outlineOpen,
    copilotWidth,
    readerCollapsed,
    pendingAsks,
    briefUi,
    briefData,
    setCopilotOpen,
    setOutlineOpen,
    setCopilotWidth,
    setReaderCollapsed,
    addPendingAsk,
    removePendingAsk,
    clearPendingAsks,
    setBriefData,
    setBriefUi,
    requestBrief,
  } = usePaperUi()

  // 平板没有超宽档：偏好留在 store 不动，只在渲染层钳位（回到桌面仍是超宽）
  const allowedWidths = useMemo(() => allowedCopilotWidths(isDesktop), [isDesktop])
  const widthTier = effectiveCopilotWidth(copilotWidth, allowedWidths)
  /** 专注陪读只在双栏及以上成立：手机是底部面板，正文永远在 */
  const readerHidden = isTablet && copilotOpen && readerCollapsed
  /** 首次展开才挂载 Copilot（保 §4.7 懒加载）；此后收起只是 display:none——输入/选区/流式全部留着 */
  const [copilotEverOpened, setCopilotEverOpened] = useState(false)
  useEffect(() => {
    if (copilotOpen) setCopilotEverOpened(true)
  }, [copilotOpen])

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

  // 「启动 Copilot」入口带 ?copilot=open（HashRouter 下 query 在 hash 内，useSearchParams 正常工作）。
  // 只在首次挂载生效一次：否则用户手动收起后，任何一次 searchParams 变化都会把面板重新弹开。
  const copilotParamRef = useRef(false)
  useEffect(() => {
    if (copilotParamRef.current) return
    copilotParamRef.current = true
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
  const readerHiddenRef = useRef(readerHidden)
  readerHiddenRef.current = readerHidden
  /** 跳转触发的展开由 scrollToAnchor 自己接管滚动，别让「手动恢复正文」的重对齐再抢一次 */
  const jumpExpandRef = useRef(false)

  const scrollToAnchor = useCallback((anchor: Partial<SourceAnchor> | null | undefined): ScrollTarget => {
    const target = resolveAnchor(anchor, anchorCtxRef.current, modeRef.current)
    const domId = target.domId
    // 专注陪读下正文是 display:none：目标元素没有布局，必须先展开、等两帧排版完成再滚
    const expanding = readerHiddenRef.current
    if (expanding) {
      jumpExpandRef.current = true
      setReaderCollapsed(false)
    }
    if (domId) {
      if (expanding) requestAnimationFrame(() => requestAnimationFrame(() => scrollAndFlash(domId)))
      else scrollAndFlash(domId)
    }
    // 程序化跳转（引用回跳 / 目录）立刻把「当前第 N 页」推到目标位置：
    // 平滑滚动期间 IntersectionObserver 要几百毫秒才结算，等它会让指示器长时间停在旧页
    if (target.blockIndex !== undefined || target.page !== undefined) {
      setPosition((prev) => {
        const blockIndex = target.blockIndex ?? prev.blockIndex
        const block = blockByIndexRef.current[blockIndex]
        const page = target.page ?? block?.anchor.page
        const section = target.section ?? block?.anchor.section
        return prev.blockIndex === blockIndex && prev.page === page && prev.section === section
          ? prev
          : { blockIndex, page, section }
      })
      if (target.blockIndex !== undefined) {
        const idx = target.blockIndex
        setMaxBlockIndex((m) => (idx > m ? idx : m))
      }
    }
    return target
  }, [setReaderCollapsed])

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

  /**
   * 退出专注陪读要重对齐：display:none 期间滚动容器的 scrollTop 被清空，
   * 而阅读位置活在 React state 里，按它滚回去即可。
   * 跳转触发的展开除外——那条路径自己会滚到目标，两股滚动会打架。
   */
  const wasReaderHidden = useRef(false)
  useEffect(() => {
    if (wasReaderHidden.current && !readerHidden) {
      if (jumpExpandRef.current) jumpExpandRef.current = false
      else alignToPosition()
    }
    wasReaderHidden.current = readerHidden
  }, [readerHidden, alignToPosition])

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
        onClose={() => {
          setCopilotOpen(false)
          setSheetFull(false)
        }}
        onToggleSensitive={handleToggleSensitive}
      />
    </Suspense>
  )

  const showOutlineColumn = isDesktop && outlineOpen
  const showOutlineDrawer = !isDesktop && drawerOpen
  /**
   * copilotPane 只会被挂载一次：列（isTablet）与手机底部面板（!isTablet）互斥，
   * 同一时刻只有一个分支进树，复用这个变量不会出现两份 CopilotPanel 抢同一个会话。
   * 列一旦首开就常驻（收起=hidden），底部面板沿用收起即卸载（手机内存优先，且无多列可占）。
   */
  const showCopilotColumn = isTablet && copilotEverOpened
  const showCopilotSheet = !isTablet && copilotOpen
  // 专注陪读下宽度档失效：Copilot 直接吃掉正文让出的整列
  const copilotColumnClass = !copilotOpen
    ? 'hidden'
    : readerHidden
      ? 'min-w-0 flex-1'
      : `shrink-0 ${COPILOT_WIDTH_CLASS[widthTier]} ${showOutlineColumn ? COPILOT_CLAMP_WITH_OUTLINE : COPILOT_CLAMP_NO_OUTLINE}`

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
            {/* 布局控件放 header：与「收起目录」同列，不动 CopilotPanel 内部，也不污染手机端 */}
            {isTablet && copilotOpen && (
              <>
                <button
                  type="button"
                  disabled={readerCollapsed}
                  onClick={() => setCopilotWidth(nextCopilotWidth(widthTier, allowedWidths))}
                  title="切换 Copilot 面板宽度"
                  className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-dim transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-panel"
                >
                  宽度：{COPILOT_WIDTH_LABEL[widthTier]}
                </button>
                <button
                  type="button"
                  aria-pressed={readerCollapsed}
                  onClick={() => setReaderCollapsed(!readerCollapsed)}
                  className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-dim transition-colors hover:bg-panel-2 aria-pressed:border-accent/60 aria-pressed:text-accent"
                >
                  {readerCollapsed ? '恢复正文' : '专注陪读'}
                </button>
              </>
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

          {/* 专注陪读：正文隐藏但不卸载（PDF 位图/文本视图布局都留着），留一条竖排细条随时回来 */}
          {readerHidden && (
            <button
              type="button"
              onClick={() => setReaderCollapsed(false)}
              className="w-10 shrink-0 rounded-xl border border-line bg-panel py-3 text-xs text-dim shadow-sm transition-colors hover:bg-panel-2 hover:text-fg"
            >
              <span className="[writing-mode:vertical-rl] whitespace-nowrap">
                展开正文{position.page !== undefined ? ` · 第 ${position.page} 页` : ''}
              </span>
            </button>
          )}

          <main
            ref={readerRef}
            className={`${readerHidden ? 'hidden' : 'min-w-0 flex-1'} overflow-y-auto rounded-xl border border-line bg-panel p-4 shadow-sm`}
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
            <aside className={`${copilotColumnClass} overflow-hidden rounded-xl border border-line bg-panel p-4 shadow-sm`}>
              {copilotPane}
            </aside>
          )}
        </div>

        {/* 平板 / 手机：目录抽屉（z-50 必须高于 Copilot 底部面板的 z-40——
            同层且 DOM 靠后时，手机上抽屉会被面板整片盖住） */}
        {showOutlineDrawer && (
          <Drawer open={showOutlineDrawer} onClose={() => setDrawerOpen(false)} title="目录与搜索">
            {outlinePane}
          </Drawer>
        )}

        {/* 手机：Copilot 底部面板（可切全屏） */}
        {showCopilotSheet && (
          <div
            className={`fixed inset-x-0 bottom-0 z-40 overflow-hidden border-t border-line bg-panel shadow-lg ${
              sheetFull ? 'top-0 rounded-none p-3' : 'max-h-[70dvh] rounded-t-xl p-4'
            }`}
          >
            <div className="mb-1 flex justify-end">
              <button
                type="button"
                onClick={() => setSheetFull((f) => !f)}
                className="min-h-10 rounded border border-line px-3 py-0.5 text-[0.7rem] text-dim transition-colors hover:text-fg md:min-h-0"
              >
                {sheetFull ? '退出全屏' : '全屏'}
              </button>
            </div>
            <div className={sheetFull ? 'h-[calc(100dvh-3.5rem)]' : 'h-[min(60dvh,32rem)]'}>{copilotPane}</div>
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
