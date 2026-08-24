import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import BlockReader from '../../components/papers/BlockReader'
import ConsentDialog from '../../components/papers/ConsentDialog'
import OutlinePane, { buildOutline, type OutlineTab } from '../../components/papers/OutlinePane'
import PdfViewer from '../../components/papers/PdfViewer'
import SelectionActions from '../../components/papers/SelectionActions'
import { ReaderProvider, ReaderStyles, flashElement, type ReaderApi } from '../../components/papers/ReaderContext'
import Drawer from '../../components/ui/Drawer'
import SegmentedTabs from '../../components/ui/SegmentedTabs'
import { buildAnchorContext, readerScrollTop, resolveAnchor, type ReaderMode, type ScrollTarget } from '../../lib/paper/anchors'
import { describeFileFetchError } from '../../lib/paper/fetchErrors'
import { briefCacheKey, type BriefData } from '../../lib/paper/briefPipeline'
import { buildPaperIndex } from '../../lib/paper/ingest'
import { createRetrievalService, type SearchHit } from '../../lib/paper/retrieval'
import { getPaperDb } from '../../lib/paper/repo/db'
import { getRepos } from '../../lib/paper/repo/repos'
import { bootstrapSyncEngine, fetchRemoteFileToLocal, getSyncEngine } from '../../lib/paper/sync/syncEngine'
import { useAuthStore } from '../../lib/auth/authStore'
import { MQ, useMediaQuery } from '../../lib/useMediaQuery'
import { DEEPSEEK_V4_PRO } from '../../data/paperPolicy'
import { estimateTranslationCost } from '../../lib/paper/translate/translateBatch'
import { useTranslations } from '../../lib/paper/translate/useTranslations'
import { formatUsd } from '../../lib/paper/usage'
import type { LangMode, PaperBlock, PaperRecord, SourceAnchor } from '../../lib/paper/types'
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

/** 手机版短标签：390px 下工具行只有一行预算，「原版 PDF/文本视图」会把行挤爆 */
const MODE_TABS_SHORT = [
  { id: 'original', label: 'PDF' },
  { id: 'text', label: '文本' },
] as const satisfies readonly { readonly id: ReaderMode; readonly label: string }[]

/** 正文语言三态（全文翻译）：与 ReaderMode 正交，只作用于语义化视图 */
const LANG_TABS = [
  { id: 'orig', label: '原文' },
  { id: 'zh', label: '中文' },
  { id: 'both', label: '对照' },
] as const satisfies readonly { readonly id: LangMode; readonly label: string }[]

/** 短标签沿 MODE_TABS_SHORT 先例：<md 单字保工具行不爆 */
const LANG_TABS_SHORT = [
  { id: 'orig', label: '原' },
  { id: 'zh', label: '中' },
  { id: 'both', label: '双' },
] as const satisfies readonly { readonly id: LangMode; readonly label: string }[]

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

interface Position {
  blockIndex: number
  page?: number
  section?: string
}

export default function PaperWorkbenchPage() {
  const { paperId } = useParams<{ paperId: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  // 门面引用永不变（repos.ts 单例工厂）：方法体内按登录态路由到游客库/账号库
  const repo = getRepos().paper
  const copilotRepo = getRepos().copilot
  const retrieval = useMemo(() => createRetrievalService({ loadChunks: (id) => repo.getChunks(id) }), [repo])
  const authStatus = useAuthStore((s) => s.status)
  const userId = useAuthStore((s) => s.user?.id ?? null)

  const [paper, setPaper] = useState<PaperRecord | null>(null)
  const [blocks, setBlocks] = useState<PaperBlock[]>([])
  const [loading, setLoading] = useState(true)
  /** 换设备补拉进行中（papers 行或 blocks 从服务端拉取） */
  const [pullingRemote, setPullingRemote] = useState(false)
  const [mode, setMode] = useState<ReaderMode>('text')
  const [langMode, setLangMode] = useState<LangMode>('orig')
  /** 首次在本篇切非原文时的一次性成本提示：unseen → show → dismissed（按论文重置） */
  const [costNotice, setCostNotice] = useState<'unseen' | 'show' | 'dismissed'>('unseen')
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null)
  const [bytesError, setBytesError] = useState<string | null>(null)
  /** 「重试」计数：进懒拉 effect 依赖，递增即重跑同一条取字节路径 */
  const [bytesTick, setBytesTick] = useState(0)
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

  // 同步引擎 bootstrap 在页面挂载内（深链直达工作台时也要启动，不依赖先经过列表页）
  useEffect(() => {
    bootstrapSyncEngine()
  }, [])

  // 回前台补拉一轮增量：长时间挂后台期间另一设备的写入落进本地库
  // （不驱动本组件重读——进度有 max 合并保护，消息由 CopilotPanel 侧消费）
  useEffect(() => {
    if (authStatus !== 'authed') return
    const onVisible = () => {
      if (document.visibilityState === 'visible') void getSyncEngine()?.pullSince()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [authStatus])

  useEffect(() => {
    if (!paperId) return
    let alive = true
    void (async () => {
      try {
        if (authStatus === 'authed') {
          // 先收敛一轮远端增量再读本地：刷新/深链直达工作台时，另一设备的新消息与进度
          // 必须在首次渲染前落库（CopilotPanel 稍后才挂载，读的就是这一轮之后的库）。
          // changes?since=游标 通常为空集，代价一次轻量往返；失败静默按本地现状渲染
          try {
            await getSyncEngine()?.pullSince()
          } catch {
            /* 离线/失败不阻塞打开 */
          }
        }
        let [record, list] = await Promise.all([repo.getPaper(paperId), repo.getBlocks(paperId)])
        // 换设备补拉：papers 行或 blocks 本地缺失且已登录 → 按论文从服务端拉一轮，
        // 写回本地后既有「chunks 缺失补建」effect 会自动重建索引
        if (authStatus === 'authed' && (!record || (record.status === 'ready' && list.length === 0))) {
          const meta = await getPaperDb().syncMeta.get(paperId)
          if (!record || meta?.blocksPulled !== true) {
            if (alive) setPullingRemote(true)
            try {
              await getSyncEngine()?.pullPaper(paperId)
              ;[record, list] = await Promise.all([repo.getPaper(paperId), repo.getBlocks(paperId)])
            } catch {
              /* 拉取失败静默：按本地现状渲染（找不到/空正文提示自然出现） */
            } finally {
              if (alive) setPullingRemote(false)
            }
          }
        }
        // blocks 经批量 pullSince 到齐的设备上,pullPaper 没跑过、blocksPulled 一直是 false
        // ——到齐即补记,避免后续每次打开都白跑一轮按篇补拉
        if (record && list.length > 0 && list.length >= (record.blockCount ?? Number.POSITIVE_INFINITY)) {
          const meta = await getPaperDb().syncMeta.get(paperId)
          if (meta && meta.blocksPulled !== true) await getPaperDb().syncMeta.put({ ...meta, blocksPulled: true })
        }
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
          // 语言三态与视图正交：恢复上次的语言（只在文本视图生效）；成本提示按论文重置
          setLangMode(p?.lang ?? 'orig')
          setCostNotice(p?.lang && p.lang !== 'orig' ? 'dismissed' : 'unseen')
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [paperId, repo, authStatus, userId])

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

  // 原版模式按需取原始字节（列表页不会因此把文件读进内存）；
  // 本地 miss 且已登录 → 从服务端懒拉原始文件写回 files 表（下次纯本地）
  useEffect(() => {
    if (mode !== 'original' || !paperId || bytes) return
    // 每次进入取字节路径先清残留错误：切模式/重试都从「加载中」态开始
    setBytesError(null)
    let alive = true
    void (async () => {
      try {
        let file = await repo.getFileBytes(paperId)
        if (!file && useAuthStore.getState().status === 'authed') {
          // 不再 .catch(()=>null) 吞错：让 ApiRequestError 冒到下面按 code 分类——
          // 401 过期、断网、5xx 各有不同的正确出路，折叠成一句「不在本机」用户没法自救
          file = (await fetchRemoteFileToLocal(getPaperDb(), paperId)) ?? undefined
        }
        if (!alive) return
        if (file) setBytes(file.bytes)
        // 走到这里 = 服务端明确 404（getFile 对 404 返回 null）或未登录且本机没有：不是失败是「没有」
        else setBytesError('服务端没有这篇论文的原始文件，请用文本视图阅读或在原设备重新导入')
      } catch (e) {
        if (!alive) return
        console.error('[pdf] 原始文件拉取失败', e)
        setBytesError(describeFileFetchError(e))
      }
    })()
    return () => {
      alive = false
    }
    // bytesTick：错误框「重试」按钮递增，重跑同一条路径
  }, [mode, paperId, repo, bytes, bytesTick])

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

  /**
   * 容器化滚动：目标在阅读列（readerRef）内就只滚阅读列自己。
   * scrollIntoView 会把所有可滚祖先连文档一起滚——手机上壳层已改成 h-dvh 无文档滚动，
   * 但布局异常/桌面窄窗时文档仍可能可滚，届时它会把工作台 header 顶出屏幕（正是本次要修的症状）。
   * 目标不在容器内（防御：未来出现容器外锚点）时回退 scrollIntoView。
   */
  const scrollReaderTo = useCallback((el: HTMLElement, behavior: ScrollBehavior) => {
    const container = readerRef.current
    if (container && container.contains(el)) {
      // clientTop = 上边框宽度：容器的滚动视口从边框内侧开始（与 PdfViewer 的当前页判定同一套修正）
      const viewportTop = container.getBoundingClientRect().top + container.clientTop
      container.scrollTo({
        top: readerScrollTop(container.scrollTop, el.getBoundingClientRect().top, viewportTop),
        behavior,
      })
    } else {
      el.scrollIntoView({ block: 'start', behavior })
    }
  }, [])

  const scrollAndFlash = useCallback(
    (domId: string) => {
      const el = document.getElementById(domId)
      if (!el) return
      scrollReaderTo(el, 'smooth')
      flashElement(el)
    },
    [scrollReaderTo],
  )

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
  }, [scrollAndFlash, setReaderCollapsed])

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
      requestAnimationFrame(() => {
        const el = document.getElementById(domId)
        if (el) scrollReaderTo(el, 'auto')
      })
    })
  }, [scrollReaderTo])

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

  /** 语言切换（与视图正交）：PDF 原版视图下点中文/对照自动转文本视图——译文只在语义化视图渲染 */
  const changeLang = useCallback(
    (next: LangMode) => {
      setLangMode(next)
      if (next === 'orig') return
      setCostNotice((s) => (s === 'unseen' ? 'show' : s))
      if (modeRef.current === 'original') {
        changeMode('text')
        setToast('已切换到文本视图显示译文')
      }
    },
    [changeMode],
  )

  // 全文翻译：整表缓存 + 懒翻译窗口调度；deepseek 授权对话框由本页渲染（复用 ConsentDialog）
  const {
    texts: translations,
    failed: failedTranslations,
    retryBlock,
    consentAsk,
  } = useTranslations({ paper, blocks, langMode, currentBlockIndex: position.blockIndex })
  const translationEstimate = useMemo(() => estimateTranslationCost(blocks, DEEPSEEK_V4_PRO.pricing), [blocks])

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
          lang: langMode,
          updatedAt: Date.now(),
        })
        .catch(() => undefined)
    }, PROGRESS_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [paperId, repo, loading, totalBlocks, position.blockIndex, position.page, maxBlockIndex, ratio, mode, langMode])

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
    (action: PaperAskAction, text: string, anchor: SourceAnchor | null, opts: { translated: boolean }) => {
      if (!paperId) return
      const pos = positionRef.current
      addPendingAsk({
        paperId,
        action,
        label: PAPER_ASK_ACTIONS.find((a) => a.id === action)?.label ?? '加入提问',
        text: text.slice(0, MAX_ASK_TEXT),
        anchor: anchor ?? { kind: formatRef.current, blockIndex: pos.blockIndex, page: pos.page, section: pos.section },
        ...(opts.translated ? { translated: true } : {}),
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

  if (loading)
    return (
      <p className="text-sm text-dim">
        {pullingRemote ? '正在从账号同步这篇论文（首次在本设备打开）…' : '正在加载论文…'}
      </p>
    )

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
      {/* 工作台突破站点 max-w-7xl：以视口为基准全宽居中，减去 2rem 给滚动条留位（md+）。
          手机（<md）：满宽满高 flex 列（header 固定 + 阅读行吃剩余高度），文档级滚动为零。
          left-1/2 -translate-x-1/2 全断点保留——transform 让本元素成为 fixed 后代的包含块，
          Copilot sheet / 目录抽屉 / toast 的定位语义都依赖它，只在 md 段去掉会让手机上的
          fixed 元素改以视口为包含块，行为漂移。 */}
      <div className="relative left-1/2 -translate-x-1/2 flex h-full min-h-0 w-full flex-col gap-2 md:block md:h-auto md:w-[min(100vw-2rem,110rem)] md:space-y-3">
        <ReaderStyles />

        {/* 手机两行常驻结构：标题行（← + 截断标题）+ 工具行；md+ 逐字还原改前的横排布局 */}
        <header className="flex shrink-0 flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between md:gap-3">
          <div className="flex min-w-0 items-center gap-2 md:block">
            <button
              type="button"
              onClick={() => navigate('/papers')}
              className="min-h-11 shrink-0 text-sm text-dim transition-colors hover:text-fg md:mb-1 md:min-h-0"
            >
              {/* 手机只留箭头：390px 下「← 返回论文库」会吃掉近三分之一的标题行 */}
              <span className="md:hidden">←</span>
              <span className="hidden md:inline">← 返回论文库</span>
            </button>
            <h1 className="min-w-0 flex-1 truncate text-base font-bold md:flex-none md:text-xl">{paper.title}</h1>
            <p className="hidden text-xs text-dim md:block">
              {paper.format.toUpperCase()}
              {paper.pageCount ? ` · ${paper.pageCount} 页` : ''} · {totalBlocks} 段 · 已读 {Math.round(ratio * 100)}%
              {position.page !== undefined ? ` · 当前第 ${position.page} 页` : ''}
            </p>
          </div>

          <div className="flex w-full items-center gap-2 md:w-auto md:flex-wrap">
            {paper.format === 'pdf' && (
              <SegmentedTabs tabs={isTablet ? MODE_TABS : MODE_TABS_SHORT} value={mode} onChange={changeMode} />
            )}
            {/* 语言三态与视图正交；敏感论文禁用（灰化 + title，内层 pointer-events-none 让悬停落在外层出提示） */}
            <div
              title={paper.sensitive ? '敏感论文：远程翻译已禁用，仅可阅读原文' : '正文语言：原文 / 中文 / 中英对照'}
              className={paper.sensitive ? 'cursor-not-allowed opacity-40' : undefined}
            >
              <div className={paper.sensitive ? 'pointer-events-none' : undefined}>
                <SegmentedTabs tabs={isTablet ? LANG_TABS : LANG_TABS_SHORT} value={langMode} onChange={changeLang} />
              </div>
            </div>
            {!isDesktop && (
              <button
                type="button"
                onClick={() => setDrawerOpen(!drawerOpen)}
                className="min-h-11 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-fg transition-colors hover:bg-panel-2 md:min-h-0"
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
                className="min-h-11 rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 md:min-h-0"
              >
                <span className="md:hidden">Copilot</span>
                <span className="hidden md:inline">展开 Copilot</span>
              </button>
            )}
            {/* 手机 meta 精简版：完整 meta 段在 md- 隐藏，这里在工具行行尾补上最关键的两个数 */}
            <span className="ml-auto min-w-0 truncate text-xs text-dim md:hidden">
              {position.page !== undefined && paper.pageCount
                ? `第 ${position.page}/${paper.pageCount} 页 · ${Math.round(ratio * 100)}%`
                : `已读 ${Math.round(ratio * 100)}%`}
            </span>
          </div>
        </header>

        {/* 阅读行：手机吃掉 flex 列剩余高度（min-h-0 允许被压缩出内部滚动）；md+ 还原固定高度公式 */}
        <div className="flex min-h-0 flex-1 gap-3 md:flex-none md:h-[calc(100dvh-14rem)] md:min-h-[24rem]">
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
            className={`${readerHidden ? 'hidden' : 'min-w-0 flex-1'} overflow-y-auto rounded-xl border border-line bg-panel p-2 shadow-sm md:p-4`}
          >
            {mode === 'original' && paper.format === 'pdf' ? (
              // 分支顺序：成功（bytes）永远赢——旧顺序 error 优先，重试成功后 bytes 与残留
              // error 并存时页面仍卡在错误框（错误态粘滞 bug）
              bytes ? (
                <PdfViewer
                  bytes={bytes}
                  containerRef={readerRef}
                  onVisiblePage={handleVisiblePage}
                  onLoaded={handlePdfLoaded}
                />
              ) : bytesError ? (
                <div className="rounded-lg border border-bad/40 p-4 text-sm text-bad">
                  <p>{bytesError}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        // 立即清错切回加载态（effect 重跑前不闪旧错误），tick 触发重拉
                        setBytesError(null)
                        setBytesTick((t) => t + 1)
                      }}
                      className="min-h-11 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-fg transition-colors hover:bg-panel-2 md:min-h-0"
                    >
                      重试
                    </button>
                    <button
                      type="button"
                      onClick={() => changeMode('text')}
                      className="min-h-11 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-fg transition-colors hover:bg-panel-2 md:min-h-0"
                    >
                      用文本视图阅读
                    </button>
                  </div>
                </div>
              ) : (
                <div className="p-4 text-sm text-dim">
                  <div className="mb-3 h-4 w-40 animate-pulse rounded bg-panel-2" />
                  {/* 带上体积：大文件在慢网络下要拉几十秒，让用户知道在等什么、等多久合理 */}
                  <p>正在读取原始文件…（{(paper.byteSize / 1048576).toFixed(1)} MB）</p>
                </div>
              )
            ) : (
              <>
                {/* 首次切非原文的一次性成本提示（内联在阅读区顶部，不挡正文） */}
                {costNotice === 'show' && langMode !== 'orig' && (
                  <div className="mx-auto mb-2 flex max-w-3xl items-start gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-dim">
                    <span className="min-w-0 flex-1">
                      全文翻译按阅读位置逐段进行，整篇约 {formatUsd(translationEstimate.cost)}
                      （deepseek-v4-pro 估算）；已译段落本地缓存复用，不重复计费。
                    </span>
                    <button
                      type="button"
                      onClick={() => setCostNotice('dismissed')}
                      className="shrink-0 text-accent transition-colors hover:underline"
                    >
                      知道了
                    </button>
                  </div>
                )}
                <BlockReader
                  blocks={blocks}
                  containerRef={readerRef}
                  onVisibleBlock={handleVisibleBlock}
                  langMode={langMode}
                  translations={translations}
                  failedTranslations={failedTranslations}
                  onRetryTranslation={retryBlock}
                />
              </>
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

        {/* 手机：Copilot 底部面板（可切全屏）。
            bottom-0 的包含块是工作台根（transform 祖先）——依赖根在手机满高贴底
            （App main pb-0 + 根 h-full），恢复 main 的 padding 会让 sheet 悬空一截。 */}
        {showCopilotSheet && (
          <div
            className={`fixed inset-x-0 bottom-0 z-40 overflow-hidden border-t border-line bg-panel shadow-lg ${
              sheetFull
                ? 'top-0 rounded-none px-3 pt-3 pb-[env(safe-area-inset-bottom)] flex flex-col'
                : 'max-h-[70dvh] rounded-t-xl px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]'
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
            {/* 全屏改 flex 吃剩余高：固定公式 100dvh-3.5rem 没算 safe-area，刘海机上会溢出 */}
            <div className={sheetFull ? 'min-h-0 flex-1' : 'h-[min(60dvh,32rem)]'}>{copilotPane}</div>
          </div>
        )}

        {toast && (
          <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line bg-panel px-4 py-2 text-sm text-fg shadow-md">
            {toast}
          </div>
        )}

        {/* 翻译链路的 deepseek 授权（与 CopilotPanel 的 gate 同一对话框组件、同一 consents 表） */}
        {consentAsk && <ConsentDialog provider="deepseek" onDecide={consentAsk} />}

        <SelectionActions
          containerRef={readerRef}
          anchorFromElement={anchorFromElement}
          onAction={handleAskAction}
        />
      </div>
    </ReaderProvider>
  )
}
