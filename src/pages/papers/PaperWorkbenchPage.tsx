import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import BlockReader from '../../components/papers/BlockReader'
import ConsentDialog from '../../components/papers/ConsentDialog'
import HighlightActions from '../../components/papers/HighlightActions'
import OutlinePane, { buildOutline, type HighlightListItem, type OutlineTab } from '../../components/papers/OutlinePane'
import PdfViewer, { type PdfViewerApi } from '../../components/papers/PdfViewer'
import SelectionActions, { type SelectionSource } from '../../components/papers/SelectionActions'
import VoiceMicBall from '../../components/papers/VoiceMicBall'
import WebSnapshotView, { type WebSnapshotApi } from '../../components/papers/WebSnapshotView'
import { ReaderProvider, ReaderStyles, flashElement, type ReaderApi } from '../../components/papers/ReaderContext'
import Drawer from '../../components/ui/Drawer'
import SegmentedTabs from '../../components/ui/SegmentedTabs'
import {
  buildAnchorContext,
  hasNativeScrollAnchoring,
  pageDomId,
  readerScrollTop,
  resolveAnchor,
  type ReaderMode,
  type ScrollTarget,
} from '../../lib/paper/anchors'
import { describeFileFetchError } from '../../lib/paper/fetchErrors'
// 导出：页面只静态引轻模块（版本判定 / 错误类型），对话框与导出内核都按需懒加载
import { exportFlavorFor, FLAVOR_LABEL } from '../../lib/paper/export/exportFlavor'
import { ExportError, type ExportFlavor } from '../../lib/paper/export/exportTypes'
import { briefCacheKey, type BriefData } from '../../lib/paper/briefPipeline'
import { buildPaperIndex, reingestPaper } from '../../lib/paper/ingest'
import { createIngestDeps } from '../../lib/paper/ingestDeps'
import { ingestQueue } from '../../lib/paper/ingestQueue'
import { reparseStateOf, startReparse, subscribeReparse, type ReparseTaskState } from '../../lib/paper/reparseTasks'
import { hasPdfLayout, needsLayoutReparse } from '../../lib/paper/pdfLayout'
import { createRetrievalService, type SearchHit } from '../../lib/paper/retrieval'
import { getPaperDb } from '../../lib/paper/repo/db'
import { getRepos } from '../../lib/paper/repo/repos'
import { bootstrapSyncEngine, fetchRemoteFileToLocal, getSyncEngine } from '../../lib/paper/sync/syncEngine'
import { useAuthStore } from '../../lib/auth/authStore'
import { MQ, useMediaQuery } from '../../lib/useMediaQuery'
import { DEEPSEEK_V4_PRO } from '../../data/paperPolicy'
import { captureHighlightRanges } from '../../lib/paper/highlight/selectionOffsets'
import { useHighlights } from '../../lib/paper/highlight/useHighlights'
import { estimateTranslationCost } from '../../lib/paper/translate/translateBatch'
import { useTranslations } from '../../lib/paper/translate/useTranslations'
import { WEB_SNAPSHOT_MIME } from '../../lib/paper/url/webSnapshotMime'
import { getVoiceConfig, type VoiceConfigResp } from '../../lib/paper/voice/voiceApi'
import {
  buildViewportContext,
  pageBlockRange,
  windowAroundBlock,
  type BlockRange,
} from '../../lib/paper/voice/viewportContext'
import { formatUsd } from '../../lib/paper/usage'
import type { IngestStage, LangMode, PaperBlock, PaperFormat, PaperRecord, SourceAnchor } from '../../lib/paper/types'
import {
  MAX_ASK_TEXT,
  MAX_COMPOSER_QUOTES,
  PAPER_ASK_ACTIONS,
  allowedCopilotWidths,
  effectiveCopilotWidth,
  nextCopilotWidth,
  usePaperUi,
  type CopilotWidth,
  type PaperAskAction,
} from './paperUiStore'
import { isHollow, needsRemotePull } from './workbenchLoad'

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
/** 导出 PDF 对话框懒加载：只有点「导出 PDF」才拉；导出内核（pdf-lib / 字体）再由对话框按需动态 import */
const ExportDialog = lazy(() => import('../../components/papers/ExportDialog'))

const MODE_TABS = [
  { id: 'original', label: '原版 PDF' },
  { id: 'text', label: '文本视图' },
] as const satisfies readonly { readonly id: ReaderMode; readonly label: string }[]

/** 手机版短标签：390px 下工具行只有一行预算，「原版 PDF/文本视图」会把行挤爆 */
const MODE_TABS_SHORT = [
  { id: 'original', label: 'PDF' },
  { id: 'text', label: '文本' },
] as const satisfies readonly { readonly id: ReaderMode; readonly label: string }[]

/** 网页原貌快照（mime = WEB_SNAPSHOT_MIME 的 html 论文）：original = 整页 iframe，text = 语义化块视图 */
const SNAPSHOT_MODE_TABS = [
  { id: 'original', label: '网页原貌' },
  { id: 'text', label: '文本视图' },
] as const satisfies readonly { readonly id: ReaderMode; readonly label: string }[]

const SNAPSHOT_MODE_TABS_SHORT = [
  { id: 'original', label: '原貌' },
  { id: 'text', label: '文本' },
] as const satisfies readonly { readonly id: ReaderMode; readonly label: string }[]

/** 有「原版」视图的论文：PDF 或网页原貌快照 */
const hasOriginalView = (record: PaperRecord | null | undefined): boolean =>
  record?.format === 'pdf' || record?.mime === WEB_SNAPSHOT_MIME

/** 正文语言三态（全文翻译）：与 ReaderMode 正交，只作用于语义化视图 */
const LANG_TABS = [
  { id: 'orig', label: '原文' },
  { id: 'zh', label: '中文' },
  { id: 'both', label: '对照' },
] as const satisfies readonly { readonly id: LangMode; readonly label: string }[]

/** 头部 meta 行的格式展示名：html = URL 导入产出的净化 HTML 合集，用户看到的应是「网页」而不是内部格式名 */
const FORMAT_LABEL: Record<PaperFormat, string> = { pdf: 'PDF', docx: 'DOCX', html: '网页' }

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

/** 打开的论文还在导入 / 解析中（列表页任务在跑）：「还不能阅读」面板按这个间隔重读状态，转为可读即换上正文 */
const IN_FLIGHT_POLL_MS = 1000

interface Position {
  blockIndex: number
  page?: number
  section?: string
}

/** 「重新解析」（旧版解析的 PDF 补出版面几何）：空闲 / 进行中（ingest 阶段；waiting = 队列里还有别的任务在跑）/ 失败 */
type ReparseState =
  | { kind: 'idle' }
  | { kind: 'busy'; stage: IngestStage; waiting: boolean }
  | { kind: 'error'; message: string }

/** 重新解析的阶段文案（同论文库导入进度的口径） */
const REPARSE_STAGE_LABEL: Record<IngestStage, string> = {
  queued: '准备中',
  validating: '校验中',
  parsing: '解析中',
  normalizing: '整理段落',
  indexing: '建索引',
  ready: '完成',
  failed: '失败',
}

/**
 * 阅读区顶部的叠层提示（成本提示 / 旧版解析横幅）：零高度 sticky 宿主 + 绝对定位。
 * **不占流内高度**——main 里正文上方不能有会变高变矮的流内元素：提示一出现 / 一关掉，正文整体位移，
 * WebKit 没有原生滚动锚定兜底，续读对齐完又被推走一截（沿 WebSnapshotView 加载提示的同一理由）。
 * sticky 让它始终停在窗格顶部：用户在第 5 页点「中文」也看得见，而不是挂在文档开头滚出视野。
 */
function ReaderNotices({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none sticky top-0 z-20 h-0">
      <div className="absolute inset-x-0 top-0 flex flex-col gap-2">{children}</div>
    </div>
  )
}

/** 首次在本篇切非原文的一次性成本提示（文本视图、原版 PDF、网页原貌都叠在窗格顶部） */
function CostNotice({ estimate, onDismiss }: { estimate: number; onDismiss: () => void }) {
  return (
    <div className="pointer-events-auto mx-auto flex w-full max-w-3xl items-start gap-2 rounded-lg border border-accent/30 bg-panel px-3 py-2 text-xs text-dim shadow-sm">
      <span className="min-w-0 flex-1">
        全文翻译按阅读位置逐段进行，整篇约 {formatUsd(estimate)}
        （deepseek-v4-pro 估算）；已译段落本地缓存复用，不重复计费。
      </span>
      <button type="button" onClick={onDismiss} className="shrink-0 text-accent transition-colors hover:underline">
        知道了
      </button>
    </div>
  )
}

/**
 * 旧版解析 PDF 的横幅（原版视图 + 中文 / 对照）：块没有版面几何，原版 PDF 里画不出译文。
 * 两条出路：「重新解析」（一次性升级，译文与高亮按文本保留）/「先用文本视图看译文」。
 */
function LegacyPdfBanner({
  state,
  onReparse,
  onUseText,
}: {
  state: ReparseState
  onReparse: () => void
  onUseText: () => void
}) {
  const busy = state.kind === 'busy'
  const btn =
    'min-h-9 shrink-0 rounded-lg border border-line bg-panel px-3 py-1 text-xs transition-colors hover:bg-panel-2 disabled:cursor-wait disabled:opacity-70 md:min-h-0'
  return (
    <div
      role="status"
      className="pointer-events-auto mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-lg border border-amber/40 bg-panel px-3 py-2 text-xs text-dim shadow-sm"
    >
      <span className="min-w-0 flex-1 basis-56">
        {state.kind === 'error' ? (
          <span className="text-bad">重新解析失败：{state.message}</span>
        ) : busy ? (
          state.waiting ? (
            '排队中：论文库里还有导入任务在解析，完成后自动开始…'
          ) : (
            `正在重新解析（${REPARSE_STAGE_LABEL[state.stage]}）…可以继续阅读原文`
          )
        ) : (
          '这篇 PDF 是旧版解析，原版 PDF 里暂时显示不了译文。重新解析后即可就地显示（已译段落与高亮保留）。'
        )}
      </span>
      <button type="button" disabled={busy} onClick={onReparse} className={`${btn} text-accent`}>
        {busy ? '重新解析中…' : state.kind === 'error' ? '重试' : '重新解析'}
      </button>
      <button type="button" onClick={onUseText} className={`${btn} text-fg`}>
        先用文本视图看译文
      </button>
    </div>
  )
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
  /** 「重新拉取」计数：进装载 effect 依赖，递增即重跑一轮按篇补拉（空心论文可反复重试） */
  const [pullTick, setPullTick] = useState(0)
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
  const [reparse, setReparse] = useState<ReparseState>({ kind: 'idle' })

  const readerRef = useRef<HTMLElement | null>(null)
  const restoredFor = useRef<string | null>(null)
  const alignedKey = useRef('')
  /** 网页原貌视图的命令式 API（iframe 文档载入后回传；切走视图后调用返回 false，无副作用） */
  const snapshotApiRef = useRef<WebSnapshotApi | null>(null)
  /** 快照 iframe 文档作为选区源（SelectionActions / HighlightActions 逐文档挂监听） */
  const [snapshotSource, setSnapshotSource] = useState<SelectionSource | null>(null)
  /** 全视口可见块区间（BlockReader 第二观察器上报）：只被语音提问的快照读取，不驱动渲染 */
  const visibleRangeRef = useRef<BlockRange | null>(null)
  /** 服务端语音配置：null = 尚未取到（球不渲染），{enabled:false} = 未开启 */
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfigResp | null>(null)
  /** Copilot 列实测宽度：悬浮球桌面锚位要让出整列（QA R1 V13），宽度档/钳位太多，测比算稳 */
  const copilotAsideRef = useRef<HTMLElement | null>(null)
  const [copilotColWidth, setCopilotColWidth] = useState(0)
  // 抽屉与桌面左栏是两件事：桌面左栏默认展开，小屏抽屉默认收起（否则一进页面就被目录盖住）
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 手机：Copilot 底部面板可切全屏（长回答 + 交互块在 390px 下需要整屏）
  const [sheetFull, setSheetFull] = useState(false)
  /** 导出 PDF 对话框：打开时冻结论文与版本；null = 关闭（换论文后 paperId 对不上即卸载、中止） */
  const [exportOpen, setExportOpen] = useState<{ paperId: string; flavor: ExportFlavor } | null>(null)

  const isDesktop = useMediaQuery(MQ.xl)
  const isTablet = useMediaQuery(MQ.md)

  const {
    copilotOpen,
    outlineOpen,
    copilotWidth,
    readerCollapsed,
    briefUi,
    briefData,
    voiceBallHidden,
    requestVoiceAsk,
    setCopilotOpen,
    setOutlineOpen,
    setCopilotWidth,
    setReaderCollapsed,
    addPendingAsk,
    dropPendingAsks,
    attachQuote,
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
    // 登录态未定（冷启动深链）：getPaperDb() 此刻还指向游客库，读了只会闪一下「找不到这篇论文」。
    // refresh() 必定收敛到 authed|anon（authStore.ts:54-68），停在加载态等它，authed 后本 effect 重跑。
    if (authStatus === 'unknown') {
      setLoading(true)
      return
    }
    let alive = true
    // 每次重跑都从加载态起步：换论文/登录态变化/「重新拉取」都要看到「正在加载/正在同步」，
    // 而不是把上一轮的正文与「0 段」空态挂在屏幕上
    setLoading(true)
    setPullingRemote(false)
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
        // 换设备补拉：papers 行缺失或正文块不齐且已登录 → 按论文从服务端拉一轮，
        // 写回本地后既有「chunks 缺失补建」effect 会自动重建索引。
        // 判定走 workbenchLoad.needsRemotePull（纯函数 + 表驱动单测），且**不再锁存**：
        // 旧的 `meta?.blocksPulled !== true` 门槛会把「拉到 0 块」永久化（pullPaper 拉空也置 true），
        // 原设备补推 blocks 之后接收端永远不会再试。
        if (needsRemotePull({ authStatus, record, localBlocks: list.length })) {
          if (alive) setPullingRemote(true)
          try {
            await getSyncEngine()?.pullPaper(paperId)
            ;[record, list] = await Promise.all([repo.getPaper(paperId), repo.getBlocks(paperId)])
          } catch {
            /* 拉取失败静默：按本地现状渲染（找不到/空心面板自然出现） */
          } finally {
            if (alive) setPullingRemote(false)
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
          // DOCX / 阅读模式 html 只有语义化视图；PDF 与网页原貌快照恢复上次用的视图，默认原版
          setMode(hasOriginalView(record) ? (p?.mode ?? 'original') : 'text')
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
    // pullTick：空心面板的「重新拉取」递增即重跑本 effect（restoredFor 不复位，位置恢复不重复做）
  }, [paperId, repo, authStatus, userId, pullTick])

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

  /**
   * 论文在库里是中间态（queued / parsing / …：列表页的导入或失败重试正在跑）时打开了工作台：「还不能阅读」面板
   * 自己不会刷新，用户只能退回论文库。每秒重读一次，转为 ready / failed 就换上新记录与正文（审查 P1-2）。
   * 升级重解析（旧版解析补版面几何）本身不再写中间态（ingest.reingestPaper），这里兜的是导入 / 重试路径。
   */
  const paperStatus = paper?.status
  useEffect(() => {
    if (!paperId || !paperStatus || paperStatus === 'ready' || paperStatus === 'failed') return
    const forPaper = paperId
    let alive = true
    const timer = setInterval(() => {
      void (async () => {
        const record = await repo.getPaper(forPaper)
        if (!alive || !record || record.status === paperStatus) return
        const list = record.status === 'ready' ? await repo.getBlocks(forPaper) : null
        if (!alive || paperIdRef.current !== forPaper) return
        setPaper(record)
        if (list) setBlocks(list)
      })().catch(() => undefined)
    }, IN_FLIGHT_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [paperId, paperStatus, repo])

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
  // mime 随 papers 行同步：只拉到 blocks 的设备也能立刻判定是快照（原貌视图再懒拉文件）
  const isSnapshot = paper?.mime === WEB_SNAPSHOT_MIME
  const isSnapshotRef = useRef(isSnapshot)
  isSnapshotRef.current = isSnapshot
  /**
   * 原版 PDF 就地译文（PLAN-pdf-inline-translation §6）：块带版面几何（v3 解析）且语言不是「原文」时，
   * 原版视图里直接显示译文（中文 = 原位覆盖，对照 = 段落对照流），位置跟踪 / 跳转都升到块精度。
   * 与 PdfViewer 内部的 inPlace 同一判定——「原文」下 viewer 与工作台都走改动前的页级老路，逐像素不变。
   */
  const hasLayout = useMemo(() => hasPdfLayout(blocks), [blocks])
  const isPlainPdf = paper?.format === 'pdf' && !isSnapshot
  const pdfInPlace = isPlainPdf && hasLayout && langMode !== 'orig'
  const pdfInPlaceRef = useRef(pdfInPlace)
  pdfInPlaceRef.current = pdfInPlace
  /** 旧版解析（块没有 layout）的 PDF：原版视图切中文 / 对照时提示「重新解析」 */
  const legacyPdf = isPlainPdf && paper !== null && needsLayoutReparse(paper, blocks)
  /** 实际驱动翻译的语言：旧版解析 PDF 的原版视图里画不出译文 → 按「原文」处理（横幅期间不发请求、不弹授权与成本提示） */
  const translateLang: LangMode = mode === 'original' && legacyPdf ? 'orig' : langMode
  /** 原版 PDF 的命令式 API（文档就绪后回传；viewer 卸载后调用返回 false，调用方回退页级） */
  const pdfApiRef = useRef<PdfViewerApi | null>(null)
  const readerHiddenRef = useRef(readerHidden)
  readerHiddenRef.current = readerHidden
  const paperIdRef = useRef(paperId)
  paperIdRef.current = paperId
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
    // 网页原貌：块精度（快照的块与文本视图同一套），滚动交给 iframe 视图的 API；mode 仍报 original
    const snapshotOriginal = modeRef.current === 'original' && isSnapshotRef.current
    // 原版 PDF 就地译文：块有几何，同样升到块精度（以 'text' 解析、报 original），滚动交给 PdfViewer 的 API
    const pdfBlockOriginal = modeRef.current === 'original' && pdfInPlaceRef.current
    const target =
      snapshotOriginal || pdfBlockOriginal
        ? { ...resolveAnchor(anchor, anchorCtxRef.current, 'text'), mode: 'original' as const }
        : resolveAnchor(anchor, anchorCtxRef.current, modeRef.current)
    const domId = target.domId
    // 专注陪读下正文是 display:none：目标元素没有布局，必须先展开、等两帧排版完成再滚
    const expanding = readerHiddenRef.current
    if (expanding) {
      jumpExpandRef.current = true
      setReaderCollapsed(false)
    }
    if (snapshotOriginal) {
      const idx = target.blockIndex
      if (idx !== undefined) {
        const go = () => snapshotApiRef.current?.scrollToBlock(idx, { flash: true, behavior: 'smooth' })
        if (expanding) requestAnimationFrame(() => requestAnimationFrame(go))
        else go()
      }
    } else if (pdfBlockOriginal) {
      const idx = target.blockIndex
      const page = target.page
      const go = () => {
        if (idx !== undefined && pdfApiRef.current?.scrollToBlock(idx, { flash: true, behavior: 'smooth' })) return
        // 该块没有几何 / viewer 未就绪：回退页级（与改动前的原版视图同一精度）
        if (page !== undefined) scrollAndFlash(pageDomId(page))
      }
      if (expanding) requestAnimationFrame(() => requestAnimationFrame(go))
      else go()
    } else if (domId) {
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
    const snapshotOriginal = modeRef.current === 'original' && isSnapshotRef.current
    const pdfBlockOriginal = modeRef.current === 'original' && pdfInPlaceRef.current
    const target = resolveAnchor(
      { kind: formatRef.current, blockIndex: pos.blockIndex, page: pos.page, section: pos.section },
      anchorCtxRef.current,
      snapshotOriginal || pdfBlockOriginal ? 'text' : modeRef.current,
    )
    if (pdfBlockOriginal) {
      const idx = target.blockIndex
      const page = target.page ?? pos.page
      // 两帧后再滚：等占位页完成首次布局；块对齐失败（无几何）回退页顶
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (idx !== undefined && pdfApiRef.current?.scrollToBlock(idx, { behavior: 'auto' })) return
          const el = page !== undefined ? document.getElementById(pageDomId(page)) : null
          if (el) scrollReaderTo(el, 'auto')
        })
      })
      return
    }
    if (snapshotOriginal) {
      const idx = target.blockIndex
      if (idx === undefined) return
      // 两帧后再滚：等 iframe 文档完成首次布局与高度同步
      requestAnimationFrame(() => {
        requestAnimationFrame(() => snapshotApiRef.current?.scrollToBlock(idx, { behavior: 'auto' }))
      })
      return
    }
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

  /**
   * 语言切换（与视图正交），**不切视图**：网页原貌就地挂译文（WebSnapshotView 的 applyLangState）；
   * 原版 PDF 有版面几何时就地渲染（中文覆盖 / 段落对照流），旧版解析没有几何时仍停在原版视图显示原文 +
   * 「重新解析」横幅——用户看着原文自己选（重新解析 / 先用文本视图），比被动切走更清楚。
   */
  const changeLang = useCallback((next: LangMode) => {
    setLangMode(next)
    if (next === 'orig') return
    setCostNotice((s) => (s === 'unseen' ? 'show' : s))
  }, [])

  // 全文翻译：整表缓存 + 懒翻译窗口调度；deepseek 授权对话框由本页渲染（复用 ConsentDialog）
  const {
    texts: translations,
    failed: failedTranslations,
    authIssue: translationAuthIssue,
    retryBlock,
    consentAsk,
    translateAll,
  } = useTranslations({
    paper,
    blocks,
    // 旧版解析 PDF 停在原版视图时只显示原文 + 横幅：译文没有地方显示，翻译窗口不该启动（授权框、计费请求都白费，
    // 审查 P1-1）；「先用文本视图看译文」切到文本视图后按真实语言激活
    langMode: translateLang,
    currentBlockIndex: position.blockIndex,
    // 「当前块起往后在前、回看在后」只在有锚定兜底时用：网页原貌视图有跨 iframe 锚定（PLAN 2.1），
    // 原版 PDF 中文覆盖页高恒定、对照流在 WebKit 由 PdfViewer 自己补偿（compensateScroll），
    // 文本视图靠浏览器原生 overflow-anchor；其余场合（WebKit 的文本视图）保持文档顺序，别让位移挪到读一半才跳
    aheadFirst: (mode === 'original' && (isSnapshot || pdfInPlace)) || hasNativeScrollAnchoring,
  })
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

  /** 原版 PDF 文档就绪：记下 API，再把阅读位置接上（就地译文时按块对齐，否则按页） */
  const handlePdfReady = useCallback(
    (api: PdfViewerApi) => {
      pdfApiRef.current = api
      if (paperId) alignOnce(`${paperId}:original`)
    },
    [alignOnce, paperId],
  )

  /** 快照 iframe 文档就绪：记下 API，再把阅读位置接上（与 PDF 的 onLoaded 同一 aligned 键） */
  const handleSnapshotReady = useCallback(
    (api: WebSnapshotApi) => {
      snapshotApiRef.current = api
      if (paperId) alignOnce(`${paperId}:original`)
    },
    [alignOnce, paperId],
  )

  /**
   * 选区源：父文档的阅读列永远在；快照 iframe 文档载入后追加（SelectionActions / HighlightActions
   * 按本函数的引用变化重挂监听——只随 snapshotSource 变）。
   */
  const getSelectionSources = useCallback((): SelectionSource[] => {
    const out: SelectionSource[] = []
    const main = readerRef.current
    if (main) out.push({ doc: document, container: main, offset: () => ({ x: 0, y: 0 }) })
    if (snapshotSource) out.push(snapshotSource)
    return out
  }, [snapshotSource])

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

  /** 第二观察器的可见区间只进 ref：语音发送瞬间才读，滚动不触发任何重渲染 */
  const handleVisibleRange = useCallback((range: { min: number; max: number }) => {
    visibleRangeRef.current = range
  }, [])

  const handleVisiblePage = useCallback((page: number) => {
    // 就地译文：块级位置由 handlePdfVisibleBlock 维护，这里只跟页码——别把 blockIndex 冲回页首块
    if (pdfInPlaceRef.current) {
      setPosition((prev) => (prev.page === page ? prev : { ...prev, page }))
      return
    }
    const blockIndex = anchorCtxRef.current.firstBlockOfPage[page]
    setPosition((prev) => {
      if (prev.page === page) return prev
      const idx = blockIndex ?? prev.blockIndex
      return { blockIndex: idx, page, section: blockByIndexRef.current[idx]?.anchor.section }
    })
    if (blockIndex !== undefined) setMaxBlockIndex((m) => (blockIndex > m ? blockIndex : m))
  }, [])

  /** 原版 PDF 就地译文的当前块（PdfViewer 按观察带几何判定）：块精度的位置 → 翻译窗口跟着段落走 */
  const handlePdfVisibleBlock = useCallback((blockIndex: number, page: number) => {
    const section = blockByIndexRef.current[blockIndex]?.anchor.section
    setPosition((prev) =>
      prev.blockIndex === blockIndex && prev.page === page && prev.section === section
        ? prev
        : { blockIndex, page, section },
    )
    setMaxBlockIndex((m) => (blockIndex > m ? blockIndex : m))
  }, [])

  /**
   * 原版 PDF 的渲染形态：原文页（含旧版解析）/ 中文覆盖 / 段落对照流。覆盖与原文页高相同，滚动位置天然接得上；
   * 对照流整页换成另一套 DOM（页变高），浏览器的原生锚点随旧节点一起被删——进出对照流都按阅读位置重新对齐。
   * 用 layout effect **同步**对齐（新 DOM 提交后、绘制与 scroll 事件之前）：若等两帧，scrollTop 先停在新文档里
   * 毫不相干的位置，当前块 / 当前页测量会把那里报上来，「已读」进度被冲高（对照流 → 原文时页变矮，尤其明显）。
   */
  const pdfRenderMode = !pdfInPlace ? 'pages' : langMode === 'both' ? 'flow' : 'overlay'
  const prevRenderModeRef = useRef(pdfRenderMode)
  useLayoutEffect(() => {
    const prev = prevRenderModeRef.current
    prevRenderModeRef.current = pdfRenderMode
    if (prev === pdfRenderMode || mode !== 'original' || isSnapshot || !bytes) return
    if (prev !== 'flow' && pdfRenderMode !== 'flow') return
    // 块有几何时按块（原文页也行）；viewer 未就绪 / 无几何 → 两帧后按阅读位置对齐
    if (!pdfApiRef.current?.scrollToBlock(positionRef.current.blockIndex, { behavior: 'auto' })) alignToPosition()
  }, [pdfRenderMode, mode, isSnapshot, bytes, alignToPosition])

  // 视图 / 渲染形态一换，上一种形态上报的可见区间就不再成立：清掉，等新形态重新上报（期间语音按阅读位置兜底）
  useEffect(() => {
    visibleRangeRef.current = null
  }, [mode, pdfRenderMode])

  /**
   * 旧版解析的 PDF 一次性升级（PLAN §4 / §6）：任务登记在模块级 reparseTasks（按论文 id 去重、跨挂载可订阅），
   * 走全局导入队列（列表页正在导入时只排队，不会两个 pdf.js 解析并行），reingestPaper 重跑解析并按文本把
   * 译文 / 高亮重打键到新块序号。升级重解析期间论文在库里始终是 ready（中途刷新 / 离开都不会卡在「解析中」），
   * 内存里的 paper / bytes 不变 → PdfViewer 不卸载，用户可以继续读原文。
   * 完成（本挂载订阅到 done）：重读 paper / blocks → 位置按「当前页首块」重设（块序号已漂移）→ 检索缓存失效 →
   * 派发 paper-sync-pulled 让译文 / 高亮两个 hook 重读重打键后的行（复用同步引擎的失效契约）。
   * 解析中离开再回来：新挂载订阅到的是同一个在途任务（横幅继续显示阶段、按钮禁用），完成时由它刷新。
   */
  useEffect(() => {
    if (!paperId) return
    const forPaper = paperId
    const toBanner = (s: ReparseTaskState): ReparseState =>
      s.kind === 'busy' ? s : s.kind === 'error' ? { kind: 'error', message: s.message } : { kind: 'idle' }
    setReparse(toBanner(reparseStateOf(forPaper)))
    let alive = true
    const onDone = async () => {
      const [record, list] = await Promise.all([repo.getPaper(forPaper), repo.getBlocks(forPaper)])
      if (!alive || paperIdRef.current !== forPaper) return
      if (record) setPaper(record)
      setBlocks(list)
      // 块序号随解析规则漂移：位置按当前页的首块重设，越界的已读进度钳回去
      const ctx = buildAnchorContext(list, record?.pageCount)
      const prev = positionRef.current
      const fromPage = prev.page !== undefined ? ctx.firstBlockOfPage[prev.page] : undefined
      const blockIndex = fromPage ?? Math.max(0, Math.min(prev.blockIndex, list.length - 1))
      const nextBlock = list.find((b) => b.index === blockIndex)
      setPosition({ blockIndex, page: prev.page ?? nextBlock?.anchor.page, section: nextBlock?.anchor.section })
      setMaxBlockIndex((m) => Math.max(0, Math.min(m, list.length - 1)))
      retrieval.invalidate(forPaper)
      window.dispatchEvent(
        new CustomEvent('paper-sync-pulled', { detail: { paperIds: [forPaper], tables: ['translations', 'highlights'] } }),
      )
      setToast('已重新解析，原版 PDF 可显示译文')
    }
    const off = subscribeReparse(forPaper, (s) => {
      if (!alive) return
      setReparse(toBanner(s))
      if (s.kind === 'error') console.error('[pdf] 重新解析失败', s.message)
      if (s.kind === 'done') void onDone().catch((e: unknown) => console.error('[pdf] 重新解析后重读失败', e))
    })
    return () => {
      alive = false
      off()
    }
  }, [paperId, repo, retrieval])

  const runReparse = useCallback(() => {
    if (!paperId) return
    const forPaper = paperId
    // 已有在途任务（含别的挂载发起的）→ startReparse 返回 false，不重复排队；横幅状态由上面的订阅驱动
    startReparse(forPaper, ingestQueue, (onState) => reingestPaper(forPaper, createIngestDeps({ onState })))
  }, [paperId])

  const totalBlocks = blocks.length
  const ratio = totalBlocks ? Math.min(1, (maxBlockIndex + 1) / totalBlocks) : 0

  // 视图/语言切换立刻落库（不等 600ms 防抖）：切完就刷新页面也要恢复到刚选的视图；
  // 阅读位置仍按防抖写，滚动时不会每帧写库
  const persistedViewKey = useRef('')
  useEffect(() => {
    if (!paperId || !totalBlocks || loading) return
    const viewKey = `${paperId}:${mode}:${langMode}`
    const delay = persistedViewKey.current === viewKey ? PROGRESS_DEBOUNCE_MS : 0
    const timer = setTimeout(() => {
      persistedViewKey.current = viewKey
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
    }, delay)
    return () => clearTimeout(timer)
  }, [paperId, repo, loading, totalBlocks, position.blockIndex, position.page, maxBlockIndex, ratio, mode, langMode])

  // ---------------------------------------------------------------------
  // 选区快捷操作 / 搜索
  // ---------------------------------------------------------------------

  const anchorFromElement = useCallback((el: Element): SourceAnchor | null => {
    // 不用 instanceof HTMLElement：快照 iframe 的元素属于另一个 realm，父窗口的构造器认不出
    const holder = el.closest('[data-block-index], [data-page]')
    if (!holder) return null
    const kind = formatRef.current
    const rawBlock = holder.getAttribute('data-block-index')
    if (rawBlock !== null) {
      const blockIndex = Number(rawBlock)
      const block = blockByIndexRef.current[blockIndex]
      return { kind, blockIndex, page: block?.anchor.page, section: block?.anchor.section }
    }
    // 原版 PDF：文字层 span 的最近祖先是页容器，锚点精度只到页
    const page = Number(holder.getAttribute('data-page'))
    const blockIndex = anchorCtxRef.current.firstBlockOfPage[page]
    return {
      kind,
      blockIndex: blockIndex ?? -1,
      page,
      section: blockIndex === undefined ? undefined : blockByIndexRef.current[blockIndex]?.anchor.section,
    }
  }, [])

  // 划词高亮：Dexie 持久化 + 内存态（localStorage 一律不存高亮数据）
  const { highlights: highlightRows, byBlock: highlightsByBlock, addCaptured, remove: removeHighlight } = useHighlights(paperId)

  /** 左栏「高亮」tab 的列表：按出现顺序（blockIndex, start）排好并补上 section */
  const highlightItems = useMemo<HighlightListItem[]>(
    () =>
      [...highlightRows]
        .sort((a, b) => a.blockIndex - b.blockIndex || a.start - b.start)
        .map((h) => {
          const section = blockByIndex[h.blockIndex]?.anchor.section
          return { id: h.id, blockIndex: h.blockIndex, lang: h.lang, text: h.text, ...(section ? { section } : {}) }
        }),
    [highlightRows, blockByIndex],
  )

  const handleHighlight = useCallback(
    (range: Range) => {
      // 网页原貌：选区在 iframe 文档里，容器取 iframe body（Range 与容器必须同文档）
      const container =
        modeRef.current === 'original' && isSnapshotRef.current
          ? snapshotApiRef.current?.container()
          : readerRef.current
      if (!container) return
      const captured = captureHighlightRanges(range, container)
      if (captured.length && addCaptured(captured, (i) => blockByIndexRef.current[i]?.id) > 0) {
        setToast('已高亮，可在左栏『高亮』里回查')
      } else {
        // 起点不在高亮宿主内（表格等），或选中的全是空白
        setToast('这段内容暂不支持高亮')
      }
      // 无论成败都清选区（选区所在文档的 selection，iframe 的选区不在父 window 上）：
      // 快捷条已关闭，残留选区只会挡住刚生效的 mark
      ;(range.startContainer.ownerDocument?.getSelection() ?? window.getSelection())?.removeAllRanges()
    },
    [addCaptured],
  )

  /**
   * 选区快捷操作：「加入提问」进输入框引用 chip（同论文最多 MAX_COMPOSER_QUOTES 条，满了拒绝并提示）；
   * 解释类动作进动作队列，CopilotPanel 空闲立即发起、忙时排队——对话里的气泡 / 排队 chip 就是反馈，不再 toast。
   */
  const handleAskAction = useCallback(
    (action: PaperAskAction, text: string, anchor: SourceAnchor | null, opts: { translated: boolean }) => {
      if (!paperId) return
      const pos = positionRef.current
      const quote = {
        paperId,
        text: text.slice(0, MAX_ASK_TEXT),
        anchor: anchor ?? { kind: formatRef.current, blockIndex: pos.blockIndex, page: pos.page, section: pos.section },
        ...(opts.translated ? { translated: true } : {}),
      }
      if (action === 'queue') {
        if (!attachQuote(quote)) {
          setToast(`最多引用 ${MAX_COMPOSER_QUOTES} 段，请先发送或移除后再添加`)
          return
        }
        setCopilotOpen(true)
        setToast('已引用到 Copilot 输入框')
        return
      }
      addPendingAsk({ ...quote, action, label: PAPER_ASK_ACTIONS.find((a) => a.id === action)?.label ?? '解释这段' })
      setCopilotOpen(true)
    },
    [addPendingAsk, attachQuote, paperId, setCopilotOpen],
  )

  // 离开论文清掉它的动作队列（未发起的「解释这段」不该在下次打开时突然冒出来）；引用 chip 是草稿，有意保留
  useEffect(
    () => () => {
      if (paperId) dropPendingAsks(paperId)
    },
    [paperId, dropPendingAsks],
  )

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  // ---------------------------------------------------------------------
  // 语音陪读：服务端配置 + 提问快照
  // ---------------------------------------------------------------------

  // /voice/config 需要登录态；未登录/未开启一律安静落到 enabled:false（球不渲染）
  useEffect(() => {
    if (authStatus !== 'authed') {
      setVoiceConfig(null)
      return
    }
    let alive = true
    void getVoiceConfig()
      .then((c) => {
        if (alive) setVoiceConfig(c)
      })
      .catch(() => {
        if (alive) setVoiceConfig({ enabled: false })
      })
    return () => {
      alive = false
    }
  }, [authStatus])

  // Copilot 列宽跟踪：档位切换/专注陪读/收起都会改宽度，ResizeObserver 一网打尽；
  // 列收起时带 hidden 类 → offsetWidth 0 → 球回到默认右下角
  useEffect(() => {
    const el = copilotAsideRef.current
    if (!el) {
      setCopilotColWidth(0)
      return
    }
    const ro = new ResizeObserver(() => setCopilotColWidth(el.offsetWidth))
    ro.observe(el)
    setCopilotColWidth(el.offsetWidth)
    return () => ro.disconnect()
  }, [copilotEverOpened, isTablet])

  /**
   * 语音转写完成 → 发送瞬间快照上下文（不是录音瞬间：说话期间用户可能还在滚动）：
   * 划词选区（若有）+ 屏幕可见正文区间 → requestVoiceAsk 交给 CopilotPanel 消费。
   * PDF 原版视图：就地译文时 viewer 按几何上报可见块区间（同文本视图走 visibleRangeRef）；
   * 原文 / 旧版解析没有块级测量，用当前页反查块区间；再兜底为阅读位置附近的窗口。
   */
  const handleVoiceTranscript = useCallback(
    (text: string) => {
      if (!paperId) return
      const pos = positionRef.current
      const blockList = blockByIndexRef.current
      let range: BlockRange | null =
        modeRef.current === 'original' && formatRef.current === 'pdf' && !pdfInPlaceRef.current
          ? pos.page !== undefined
            ? pageBlockRange(anchorCtxRef.current.firstBlockOfPage, pos.page, blockList.length)
            : null
          : visibleRangeRef.current
      if (!range || range.max < range.min) range = windowAroundBlock(pos.blockIndex, blockList.length)

      const sel = window.getSelection()
      const container = readerRef.current
      const anchorNode = sel?.anchorNode ?? null
      // 网页原貌：选区活在 iframe 窗口里，父 window 的 selection 看不到它
      const selection =
        modeRef.current === 'original' && isSnapshotRef.current
          ? (snapshotApiRef.current?.selectionText() ?? '').slice(0, MAX_ASK_TEXT)
          : sel && !sel.isCollapsed && container && anchorNode && container.contains(anchorNode)
            ? sel.toString().trim().slice(0, MAX_ASK_TEXT)
            : ''

      const viewport = buildViewportContext(blockList, range, {
        selection: selection || null,
        centerIndex: pos.blockIndex,
      })
      requestVoiceAsk({
        paperId,
        text,
        selection: selection || null,
        viewportContext: viewport.text || null,
        speak: usePaperUi.getState().voiceSpeakAloud,
      })
    },
    [paperId, requestVoiceAsk],
  )

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

  /**
   * 导出 PDF（PLAN A.7）：版本随当前视图 + 实际翻译语言（旧版解析 PDF 的原版视图按原文处理 → 不给导出）；
   * 敏感 / 空壳 / 无块不给入口（status 在上面已收口为 ready）
   */
  const exportFlavor = exportFlavorFor({ mode, pdfInPlace, langMode: translateLang })
  const canExport =
    exportFlavor !== null && !paper.sensitive && blocks.length > 0 && !isHollow(paper, blocks.length)
  const openExport = () => {
    if (canExport) setExportOpen({ paperId: paper.id, flavor: exportFlavor })
  }
  /** 原版两种版本要原始字节：已加载 → 本机 files 表 → 已登录从服务端懒拉（沿原版视图取字节的同一条路） */
  const getExportBytes = async (): Promise<ArrayBuffer> => {
    if (bytes) return bytes
    try {
      let file = await repo.getFileBytes(paper.id)
      if (!file && useAuthStore.getState().status === 'authed') {
        file = (await fetchRemoteFileToLocal(getPaperDb(), paper.id)) ?? undefined
      }
      if (file) return file.bytes
    } catch (e) {
      throw new ExportError('bytes', describeFileFetchError(e), { cause: e })
    }
    throw new ExportError('bytes', '原始文件不在本机且无法从服务端拉取')
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
      highlights={highlightItems}
      onRemoveHighlight={removeHighlight}
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
              {isSnapshot ? '网页原貌' : FORMAT_LABEL[paper.format]}
              {paper.pageCount ? ` · ${paper.pageCount} 页` : ''} · {totalBlocks} 段 · 已读 {Math.round(ratio * 100)}%
              {position.page !== undefined ? ` · 当前第 ${position.page} 页` : ''}
            </p>
          </div>

          <div className="flex w-full items-center gap-2 md:w-auto md:flex-wrap">
            {paper.format === 'pdf' && (
              <SegmentedTabs tabs={isTablet ? MODE_TABS : MODE_TABS_SHORT} value={mode} onChange={changeMode} />
            )}
            {isSnapshot && (
              <SegmentedTabs
                tabs={isTablet ? SNAPSHOT_MODE_TABS : SNAPSHOT_MODE_TABS_SHORT}
                value={mode}
                onChange={changeMode}
              />
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
            {/* 导出 PDF：md+ 工具行；手机工具行无预算，入口在目录抽屉顶部 */}
            {canExport && (
              <button
                type="button"
                onClick={openExport}
                title={`导出${FLAVOR_LABEL[exportFlavor]} PDF`}
                className="hidden rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-dim transition-colors hover:bg-panel-2 md:block"
              >
                导出 PDF
              </button>
            )}
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
            {/* 单链接 URL 论文可原地重导成网页原貌快照（多链接合集会丢页，不给入口；论文库 ?reimport 弹窗接手；手机工具行无预算，md+ 才显示） */}
            {paper.format === 'html' && paper.source?.type === 'url' && paper.source.entries.length === 1 && (
              <button
                type="button"
                onClick={() => navigate(`/papers?reimport=${encodeURIComponent(paper.id)}`)}
                title="用原网址重新抓取整页样式与图片，替换这篇的正文（保留 Copilot 会话与阅读进度）"
                className="hidden rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-dim transition-colors hover:bg-panel-2 md:block"
              >
                重新导入（网页原貌）
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
            {/* 麦克风球被隐藏后的恢复入口（设置浮层里的「隐藏」提示指向这里） */}
            {!paper.sensitive && voiceConfig?.enabled === true && voiceBallHidden && (
              <button
                type="button"
                onClick={() => usePaperUi.getState().setVoicePrefs({ voiceBallHidden: false })}
                title="恢复语音麦克风球"
                className="min-h-11 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-dim transition-colors hover:bg-panel-2 hover:text-fg md:min-h-0"
              >
                🎙
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
            className={`${readerHidden ? 'hidden' : 'min-w-0 flex-1'} overflow-y-auto rounded-xl border border-line bg-panel shadow-sm ${
              // 网页原貌：iframe 通栏、站点自己的横向溢出裁掉（宽布局站点在窄列里不该把 main 撑出横向滚动条）
              mode === 'original' && isSnapshot && bytes ? 'p-0 overflow-x-hidden' : 'p-2 md:p-4'
            }`}
          >
            {/* 叠层提示：首次切非原文的成本提示、旧版解析 PDF 的「重新解析」横幅（零流内高度，见 ReaderNotices） */}
            <ReaderNotices>
              {costNotice === 'show' && translateLang !== 'orig' && (
                <CostNotice estimate={translationEstimate.cost} onDismiss={() => setCostNotice('dismissed')} />
              )}
              {mode === 'original' && langMode !== 'orig' && legacyPdf && (
                <LegacyPdfBanner state={reparse} onReparse={runReparse} onUseText={() => changeMode('text')} />
              )}
            </ReaderNotices>
            {/*
              空心论文（papers 行说「可读」、本地一个正文块都没有）：原设备还没把 blocks 推上服务端。
              渲染解释面板而不是空白阅读器/「0 段」——「重新拉取」每次打开都能再试（判定已不锁存），
              URL 导入的还能原地重导一份正文。补拉进行中（pullingRemote）不抢在加载态之前显示。
            */}
            {isHollow(paper, blocks.length) && !pullingRemote ? (
              <div className="mx-auto mt-6 max-w-xl rounded-xl border border-line bg-panel-2/40 p-6 text-center">
                <p className="mb-2 font-medium text-fg">正文尚未从原设备同步</p>
                <p className="mb-4 text-sm text-dim">原设备打开论文库即可自动补传；也可以在这里重新拉取。</p>
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPullTick((t) => t + 1)}
                    className="min-h-11 rounded-lg border border-line bg-panel px-4 py-2 text-sm text-fg transition-colors hover:bg-panel-2 md:min-h-0"
                  >
                    重新拉取
                  </button>
                  {paper.source?.type === 'url' && paper.source.entries.length === 1 && (
                    <button
                      type="button"
                      onClick={() => navigate(`/papers?reimport=${encodeURIComponent(paper.id)}`)}
                      className="min-h-11 rounded-lg border border-line bg-panel px-4 py-2 text-sm text-fg transition-colors hover:bg-panel-2 md:min-h-0"
                    >
                      从原网址重新导入
                    </button>
                  )}
                </div>
              </div>
            ) : mode === 'original' && (paper.format === 'pdf' || isSnapshot) ? (
              // 分支顺序：成功（bytes）永远赢——旧顺序 error 优先，重试成功后 bytes 与残留
              // error 并存时页面仍卡在错误框（错误态粘滞 bug）
              bytes ? (
                isSnapshot ? (
                  <WebSnapshotView
                    bytes={bytes}
                    blocks={blocks}
                    containerRef={readerRef}
                    langMode={langMode}
                    translations={translations}
                    failedTranslations={failedTranslations}
                    translationAuthIssue={translationAuthIssue}
                    onRetryTranslation={retryBlock}
                    highlights={highlightsByBlock}
                    onVisibleBlock={handleVisibleBlock}
                    onVisibleRange={handleVisibleRange}
                    onReady={handleSnapshotReady}
                    onSelectionSource={setSnapshotSource}
                    onNavigate={navigate}
                  />
                ) : (
                  <PdfViewer
                    bytes={bytes}
                    containerRef={readerRef}
                    onVisiblePage={handleVisiblePage}
                    blocks={blocks}
                    langMode={langMode}
                    translations={translations}
                    failedTranslations={failedTranslations}
                    translationAuthIssue={translationAuthIssue}
                    onRetryTranslation={retryBlock}
                    highlights={highlightsByBlock}
                    onVisibleBlock={handlePdfVisibleBlock}
                    onVisibleRange={handleVisibleRange}
                    onReady={handlePdfReady}
                    compensateScroll={!hasNativeScrollAnchoring}
                  />
                )
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
                <BlockReader
                  blocks={blocks}
                  containerRef={readerRef}
                  onVisibleBlock={handleVisibleBlock}
                  onVisibleRange={handleVisibleRange}
                  langMode={langMode}
                  translations={translations}
                  failedTranslations={failedTranslations}
                  translationAuthIssue={translationAuthIssue}
                  onRetryTranslation={retryBlock}
                  highlights={highlightsByBlock}
                />
              </>
            )}
          </main>

          {showCopilotColumn && (
            <aside
              ref={copilotAsideRef}
              className={`${copilotColumnClass} overflow-hidden rounded-xl border border-line bg-panel p-4 shadow-sm`}
            >
              {copilotPane}
            </aside>
          )}
        </div>

        {/* 平板 / 手机：目录抽屉（z-50 必须高于 Copilot 底部面板的 z-40——
            同层且 DOM 靠后时，手机上抽屉会被面板整片盖住） */}
        {showOutlineDrawer && (
          <Drawer open={showOutlineDrawer} onClose={() => setDrawerOpen(false)} title="目录与搜索">
            {canExport ? (
              // 手机导出入口：抽屉顶部整行（md+ 走工具行按钮，这里隐藏）；先关抽屉再开对话框
              <div className="flex h-full flex-col gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setDrawerOpen(false)
                    openExport()
                  }}
                  title={`导出${FLAVOR_LABEL[exportFlavor]} PDF`}
                  className="min-h-11 w-full shrink-0 rounded-lg border border-line bg-panel px-3 py-2 text-sm text-fg transition-colors hover:bg-panel-2 md:hidden"
                >
                  导出 PDF <span className="text-dim">· {FLAVOR_LABEL[exportFlavor]}</span>
                </button>
                <div className="min-h-0 flex-1">{outlinePane}</div>
              </div>
            ) : (
              outlinePane
            )}
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

        {/* 导出 PDF：须在 ConsentDialog 之前（同为 fixed inset-0 z-50，补译中弹出的授权框靠 DOM 序压在上面）；
            也在 toast 之前，完成提示不被遮罩盖住 */}
        {exportOpen && exportOpen.paperId === paper.id && (
          <Suspense fallback={null}>
            <ExportDialog
              paper={paper}
              blocks={blocks}
              flavor={exportOpen.flavor}
              texts={translations}
              translateAll={translateAll}
              getBytes={getExportBytes}
              onClose={() => setExportOpen(null)}
              onDone={(r) => setToast(`已导出 ${r.fileName}`)}
            />
          </Suspense>
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
          // 文本视图、网页原貌、原版 PDF 就地译文支持高亮（块级宿主 + 字符偏移：译文块 / 对照流译文 div 带 data-hl-host）；
          // 原文模式的 PDF 文字层没有宿主（锚点只到页），捕获不出块内偏移
          onHighlight={mode === 'text' || isSnapshot || pdfInPlace ? handleHighlight : undefined}
          getSources={getSelectionSources}
        />
        <HighlightActions onRemove={removeHighlight} getSources={getSelectionSources} />

        {/* 语音陪读悬浮球：敏感论文一票否决（不采音），服务端未开启/未登录不渲染 */}
        {!paper.sensitive && voiceConfig?.enabled === true && !voiceBallHidden && (
          <VoiceMicBall
            paperId={paper.id}
            enabled
            onTranscript={handleVoiceTranscript}
            {...(voiceConfig.maxUtteranceMs !== undefined ? { maxUtteranceMs: voiceConfig.maxUtteranceMs } : {})}
            {...(voiceConfig.providerLabel ? { providerLabel: voiceConfig.providerLabel } : {})}
            voices={voiceConfig.voices ?? []}
            {...(voiceConfig.defaultVoice ? { defaultVoiceId: voiceConfig.defaultVoice } : {})}
            mobileLayout={!isTablet && copilotOpen ? (sheetFull ? 'sheetFull' : 'sheet') : 'free'}
            desktopPos={
              // 让出 Copilot 列（列宽 + gap-3 + 右缘距）；专注陪读整行都是面板，改为抬到输入行上方
              readerHidden
                ? { right: 24, bottom: 112 }
                : copilotOpen && copilotColWidth > 0
                  ? { right: copilotColWidth + 12 + 24, bottom: 32 }
                  : { right: 24, bottom: 32 }
            }
          />
        )}
      </div>
    </ReaderProvider>
  )
}
