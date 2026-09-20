import {
  INITIAL_INGEST_STATE,
  ingestPrepared,
  ingestReducer,
  importPaper,
  reingestPaper,
  IngestError,
  type ImportOutcome,
  type IngestDeps,
  type IngestEvent,
  type IngestState,
} from '../ingest'
import type { PaperRepository, ReplaceFileInput } from '../repo/paperRepo'
import type { IngestFailure, PaperRecord, PaperSource, UrlSourceEntry } from '../types'
import { abortError, isAbortError, throwIfAborted } from './abort'
import type { BuildSnapshotDeps, BuildSnapshotResult, SnapshotPhase } from './buildSnapshot'
import { decodeHtmlBytes } from './extractArticle'
import { URL_BUNDLE_MIME, URL_BUNDLE_VERSION, serializeUrlBundle, type UrlBundle } from './urlBundle'
import { WEB_SNAPSHOT_MIME } from './webSnapshotMime'
import { isWeixinArticleUrl } from './weixin'

/**
 * URL 批量导入编排：与 ingest.ts 同一套依赖注入风格（deps 注入 repo/hash/parse，
 * 外加这里特有的 fetchUrl/extract），测试用假 deps 跑全链路、生产用真实实现。
 *
 * 两种呈现（presentation）：
 *   reader   = 阅读模式：逐 URL 抽取净化正文 → URL 合集（urlBundle.ts），多 URL 合并为一篇；
 *   snapshot = 网页原貌：整页快照容器（webSnapshot.ts），**只支持单 URL**——多 URL 一律回落阅读模式
 *              （合集语义与单页原貌不相容），微信文章也强制阅读模式（正文靠 JS 显示，不透明源 iframe 下
 *              不可靠，extractArticle 有专门的直取路径）。
 *
 * 抓取+抽取阶段刻意不新增 ingest stage：状态机全程停在 'validating'
 * （见 dispatch 时序），逐 URL 的细粒度进度改走 onUrlProgress 回调——
 * PapersPage 的 jobs 面板只需要「校验中/解析中/…」这种粗粒度，
 * 弹窗内的逐链接进度才需要 fetching/extracting/rendering/assets 这一级细节，两者服务的 UI 不同。
 */

export type UrlProgressPhase =
  | 'pending'
  | 'fetching'
  | 'extracting'
  | 'rendering'
  | 'remote'
  | 'assets'
  | 'packing'
  | 'done'
  | 'failed'

export interface UrlProgressEvent {
  index: number
  total: number
  url: string
  phase: UrlProgressPhase
  error?: string
  /** assets 阶段的 done/total（弹窗显示「抓取资源 3/12」） */
  detail?: { done: number; total: number }
  /** 呈现方式被自动调整时的说明（多 URL / 微信文章 → 阅读模式） */
  note?: string
}

export type OnUrlProgress = (ev: UrlProgressEvent) => void

export type UrlPresentation = 'reader' | 'snapshot'

export interface UrlImportOptions {
  /** 缺省 reader（与旧调用方兼容） */
  presentation?: UrlPresentation
}

export interface FetchedUrlResult {
  bytes: ArrayBuffer
  contentType: string
  finalUrl: string
}

/** 原地替换论文源文件的仓储能力：契约定义在 paperRepo.ts（仓储不反向依赖导入管线），这里只转出 */
export type { ReplaceFileInput }

export interface UrlImportDeps {
  repo: PaperRepository
  hash: (bytes: ArrayBuffer) => Promise<string>
  /** 与 IngestDeps['parse'] 同一个函数：parseByFormat 按 format 分发到 pdf/docx/html 各自的解析器 */
  parse: IngestDeps['parse']
  now?: () => number
  onState?: (s: IngestState) => void
  fetchUrl: (url: string) => Promise<FetchedUrlResult>
  extract: (input: { bytes: ArrayBuffer; contentType: string; finalUrl: string; url: string }) => Promise<{
    title: string
    html: string
  }>
  /** 网页原貌：整页快照构建（buildSnapshot.ts）。缺省 = 不支持原貌，snapshot 请求回落阅读模式 */
  buildSnapshot?: (
    input: { url: string; html: string; finalUrl: string },
    opts: { onPhase?: BuildSnapshotDeps['onPhase'] },
  ) => Promise<BuildSnapshotResult>
  /** 原貌去重：渲染捕获的字节不稳定，sha 去重不可靠，改按 finalUrl 查已有论文 */
  findByFinalUrl?: (finalUrl: string) => Promise<PaperRecord | undefined>
  /** 落库前的存储配额检查（快照可达 30MB+） */
  ensureStorage?: (bytes: number) => Promise<{ ok: boolean; message?: string }>
  /** 原地重导入用：替换源文件（步骤 4 接 paperRepo.replaceFile）；缺省时 reimportUrlPaperInPlace 直接失败 */
  replaceFile?: (paperId: string, input: ReplaceFileInput) => Promise<void>
  /**
   * 用户主动取消（弹窗的「取消导入」→ 串行队列的 AbortSignal）。注入方负责把它同时接到
   * fetchUrl / buildSnapshot 上——本模块只在阶段之间补查一次，确保「取消 = 什么都没发生」：
   * 已建出的论文行会被删掉，AbortError 原样抛出而**不**落成 IngestFailure。
   */
  signal?: AbortSignal
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // '%PDF-'

function looksLikePdf(bytes: ArrayBuffer, contentType: string): boolean {
  if (/pdf/i.test(contentType)) return true
  const head = new Uint8Array(bytes.slice(0, PDF_MAGIC.length))
  if (head.length < PDF_MAGIC.length) return false
  return PDF_MAGIC.every((b, i) => head[i] === b)
}

function pdfNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname
    const base = path.split('/').filter(Boolean).pop()
    if (!base) return 'download.pdf'
    const decoded = decodeURIComponent(base)
    return /\.pdf$/i.test(decoded) ? decoded : `${decoded}.pdf`
  } catch {
    return 'download.pdf'
  }
}

/** 「docs.nvidia.com 等 3 页」式摘要文件名：域名去重按首次出现顺序 + 总页数 */
function summarizeHostnames(urls: readonly string[]): string {
  const hosts: string[] = []
  for (const u of urls) {
    try {
      const h = new URL(u).hostname
      if (!hosts.includes(h)) hosts.push(h)
    } catch {
      /* 走到这里的 URL 已在更早阶段抓取成功过，理论上总能解析 */
    }
  }
  if (hosts.length === 0) return 'URL 导入'
  if (urls.length === 1) return hosts[0]
  return hosts.length === 1 ? `${hosts[0]} 等 ${urls.length} 页` : `${hosts[0]} 等 ${hosts.length} 个站点 · ${urls.length} 页`
}

/** buildSnapshot 的阶段 → 弹窗进度阶段（sanitizing 对用户就是「打包」的一部分） */
const SNAPSHOT_PHASE: Record<SnapshotPhase, UrlProgressPhase> = {
  rendering: 'rendering',
  remote: 'remote',
  assets: 'assets',
  sanitizing: 'packing',
  packing: 'packing',
}

/** 未知异常 → IngestFailure：只有 IngestError 携带确定 kind（与可选 hint），其余一律 unknown */
function toFailure(e: unknown, at: number): IngestFailure {
  if (e instanceof IngestError) return { kind: e.kind, message: e.message, at, ...(e.hint ? { hint: e.hint } : {}) }
  const message = e instanceof Error ? e.message : String(e)
  return { kind: 'unknown', message: message || '导入失败（未知错误）', at }
}

const ABORT_MESSAGE = 'URL 导入已取消'

/**
 * 取消不是失败：AbortError 必须原样冒到队列外，让调用方静默收尾。
 * 一旦被 toFailure 归一成 IngestFailure，弹窗就会弹出「导入失败」——用户明明是自己按的取消。
 */
function rethrowIfAborted(e: unknown): void {
  if (isAbortError(e)) throw e
}

/**
 * ingestPrepared 跑完之后才收到取消：论文行已经建出来了，删掉再抛 AbortError。
 * 否则「取消」会在库里留下一篇用户以为根本没导入的论文（duplicate 命中的是既有论文，不能碰）。
 */
async function discardIfAborted(outcome: ImportOutcome, deps: UrlImportDeps): Promise<void> {
  if (!deps.signal?.aborted) return
  const created = outcome.kind === 'duplicate' ? undefined : outcome.paper
  if (created) await deps.repo.deletePaper(created.id).catch(() => undefined)
  throw abortError(ABORT_MESSAGE, deps.signal)
}

const ingestDepsOf = (deps: UrlImportDeps): IngestDeps => ({
  repo: deps.repo,
  hash: deps.hash,
  parse: deps.parse,
  now: deps.now,
  onState: deps.onState,
})

interface ExtractedSection {
  url: string
  finalUrl: string
  title: string
  html: string
}

// ---------------------------------------------------------------------------
// 网页原貌（单 URL）
// ---------------------------------------------------------------------------

interface SnapshotBuilt {
  result: BuildSnapshotResult
  fetched: FetchedUrlResult
}

/**
 * 抓取 → 解码 → 构建快照，进度按 buildSnapshot 的阶段映射到 onUrlProgress。
 * 抛出的错误由调用方分类（IngestError 保留 kind）。
 */
async function fetchAndBuildSnapshot(
  url: string,
  deps: UrlImportDeps,
  build: NonNullable<UrlImportDeps['buildSnapshot']>,
  report: (phase: UrlProgressPhase, detail?: { done: number; total: number }) => void,
  fetched: FetchedUrlResult,
): Promise<SnapshotBuilt> {
  const html = decodeHtmlBytes(fetched.bytes, fetched.contentType)
  // 不在这里报 'rendering'：buildWebSnapshot 入口第一件事就是 onPhase('rendering')，重复报会让进度阶梯抖一下
  const result = await build(
    { url, html, finalUrl: fetched.finalUrl || url },
    { onPhase: (phase, detail) => report(SNAPSHOT_PHASE[phase], detail) },
  )
  const verdict = await deps.ensureStorage?.(result.bytes.byteLength)
  if (verdict && !verdict.ok) {
    throw new IngestError('storage', verdict.message ?? '本地存储空间不足，无法保存网页原貌')
  }
  return { result, fetched }
}

function snapshotSource(url: string, built: SnapshotBuilt, at: number): PaperSource {
  const entry: UrlSourceEntry = { url, finalUrl: built.fetched.finalUrl, title: built.result.header.title, ok: true, fetchedAt: at }
  return { type: 'url', entries: [entry], capture: built.result.capture }
}

async function importSnapshot(
  url: string,
  deps: UrlImportDeps,
  build: NonNullable<UrlImportDeps['buildSnapshot']>,
  onUrlProgress: OnUrlProgress | undefined,
  dispatch: (ev: IngestEvent) => void,
): Promise<ImportOutcome> {
  const now = deps.now ?? Date.now
  const report = (phase: UrlProgressPhase, extra?: { detail?: { done: number; total: number }; error?: string }) =>
    onUrlProgress?.({ index: 0, total: 1, url, phase, ...(extra?.detail ? { detail: extra.detail } : {}), ...(extra?.error ? { error: extra.error } : {}) })

  const fail = (e: unknown): ImportOutcome => {
    const failure = toFailure(e, now())
    report('failed', { error: failure.message })
    dispatch({ type: 'fail', ...failure })
    return { kind: 'failed', failure }
  }

  throwIfAborted(deps.signal, ABORT_MESSAGE)
  report('fetching')
  let fetched: FetchedUrlResult
  try {
    fetched = await deps.fetchUrl(url)
  } catch (e) {
    rethrowIfAborted(e)
    return fail(e)
  }

  if (looksLikePdf(fetched.bytes, fetched.contentType)) {
    // 直链 PDF 与呈现方式无关：与阅读模式同一条路（原版 PDF 导入）
    return importPdfFromUrl(url, fetched, deps, onUrlProgress)
  }

  const existing = await deps.findByFinalUrl?.(fetched.finalUrl || url)
  if (existing) {
    report('done')
    return { kind: 'duplicate', existing }
  }

  let built: SnapshotBuilt
  try {
    built = await fetchAndBuildSnapshot(url, deps, build, (phase, detail) => report(phase, { detail }), fetched)
  } catch (e) {
    rethrowIfAborted(e)
    return fail(e)
  }

  // 快照构建是全程最慢的一段（10–30s），取消多半落在这里：落库前再查一次，别白建一条论文行
  throwIfAborted(deps.signal, ABORT_MESSAGE)

  const { bytes, header } = built.result
  const outcome = await ingestPrepared(
    {
      title: header.title,
      fileName: summarizeHostnames([fetched.finalUrl || url]),
      format: 'html',
      mime: WEB_SNAPSHOT_MIME,
      byteSize: bytes.byteLength,
      bytes,
      source: snapshotSource(url, built, now()),
    },
    ingestDepsOf(deps),
  )
  await discardIfAborted(outcome, deps)
  if (outcome.kind === 'failed') report('failed', { error: outcome.failure.message })
  else report('done')
  return outcome
}

/** 单 URL 直链 PDF：转投现有 importPaper，享 original 视图与既有 PDF 校验管线 */
async function importPdfFromUrl(
  url: string,
  fetched: FetchedUrlResult,
  deps: UrlImportDeps,
  onUrlProgress: OnUrlProgress | undefined,
  index = 0,
  total = 1,
): Promise<ImportOutcome> {
  const now = deps.now ?? Date.now
  onUrlProgress?.({ index, total, url, phase: 'extracting' })
  const outcome = await importPaper(
    {
      name: pdfNameFromUrl(fetched.finalUrl || url),
      size: fetched.bytes.byteLength,
      type: 'application/pdf',
      bytes: fetched.bytes,
    },
    ingestDepsOf(deps),
  )
  await discardIfAborted(outcome, deps)
  if (outcome.kind === 'ready' && outcome.paper) {
    // 导入成功后补写 source：PDF 直链也留一条抓取记录，便于溯源「这篇论文是从哪个 URL 来的」
    const source: PaperSource = {
      type: 'url',
      entries: [{ url, finalUrl: fetched.finalUrl, ok: true, fetchedAt: now() }],
    }
    await deps.repo.setStage(outcome.paper.id, 'ready', { source })
    const updated = await deps.repo.getPaper(outcome.paper.id)
    onUrlProgress?.({ index, total, url, phase: 'done' })
    return { kind: 'ready', paper: updated ?? outcome.paper }
  }
  onUrlProgress?.({
    index,
    total,
    url,
    phase: outcome.kind === 'failed' ? 'failed' : 'done',
    error: outcome.kind === 'failed' ? outcome.failure.message : undefined,
  })
  return outcome
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function importFromUrls(
  urls: readonly string[],
  deps: UrlImportDeps,
  onUrlProgress?: OnUrlProgress,
  opts: UrlImportOptions = {},
): Promise<ImportOutcome> {
  const now = deps.now ?? Date.now
  let state = INITIAL_INGEST_STATE
  const dispatch = (ev: IngestEvent) => {
    state = ingestReducer(state, ev)
    deps.onState?.(state)
  }

  const total = urls.length
  if (total === 0) {
    const failure: IngestFailure = { kind: 'unknown', message: '没有可导入的链接', at: now() }
    return { kind: 'failed', failure }
  }

  dispatch({ type: 'validate:start' }) // -> validating：抓取+抽取全程都算在这一粗粒度阶段里

  // 呈现方式裁决：snapshot 只在「单 URL + 非微信 + 已注入 buildSnapshot」时成立，否则回落阅读模式并说明
  let note: string | undefined
  let snapshot = opts.presentation === 'snapshot'
  if (snapshot && total > 1) {
    note = '多个链接仅支持阅读模式，已自动切换'
    snapshot = false
  } else if (snapshot && isWeixinArticleUrl(urls[0])) {
    note = '微信文章仅支持阅读模式，已自动切换'
    snapshot = false
  } else if (snapshot && !deps.buildSnapshot) {
    note = '当前版本不支持网页原貌，已按阅读模式导入'
    snapshot = false
  }
  if (note) console.warn(`[url-import] ${note}`)

  for (let i = 0; i < total; i++) onUrlProgress?.({ index: i, total, url: urls[i], phase: 'pending', ...(note ? { note } : {}) })

  if (snapshot && deps.buildSnapshot) return importSnapshot(urls[0], deps, deps.buildSnapshot, onUrlProgress, dispatch)

  const sections: ExtractedSection[] = []
  const entries: UrlSourceEntry[] = []

  for (let i = 0; i < total; i++) {
    const url = urls[i]
    throwIfAborted(deps.signal, ABORT_MESSAGE)
    onUrlProgress?.({ index: i, total, url, phase: 'fetching' })

    let fetched: FetchedUrlResult
    try {
      fetched = await deps.fetchUrl(url)
    } catch (e) {
      rethrowIfAborted(e)
      const message = e instanceof Error ? e.message : String(e)
      entries.push({ url, ok: false, error: message, fetchedAt: now() })
      onUrlProgress?.({ index: i, total, url, phase: 'failed', error: message })
      continue
    }

    if (looksLikePdf(fetched.bytes, fetched.contentType)) {
      if (total === 1) return importPdfFromUrl(url, fetched, deps, onUrlProgress, i, total)
      const message = 'PDF 直链请单独导入'
      entries.push({ url, finalUrl: fetched.finalUrl, ok: false, error: message, fetchedAt: now() })
      onUrlProgress?.({ index: i, total, url, phase: 'failed', error: message })
      continue
    }

    onUrlProgress?.({ index: i, total, url, phase: 'extracting' })
    try {
      const { title, html } = await deps.extract({
        bytes: fetched.bytes,
        contentType: fetched.contentType,
        finalUrl: fetched.finalUrl,
        url,
      })
      sections.push({ url, finalUrl: fetched.finalUrl, title, html })
      entries.push({ url, finalUrl: fetched.finalUrl, title, ok: true, fetchedAt: now() })
      onUrlProgress?.({ index: i, total, url, phase: 'done' })
    } catch (e) {
      rethrowIfAborted(e)
      const message = e instanceof Error ? e.message : String(e)
      entries.push({ url, finalUrl: fetched.finalUrl, ok: false, error: message, fetchedAt: now() })
      onUrlProgress?.({ index: i, total, url, phase: 'failed', error: message })
    }
  }

  throwIfAborted(deps.signal, ABORT_MESSAGE)

  if (sections.length === 0) {
    // 全失败不落库：不留一条「标题都没有」的空论文
    const failure: IngestFailure = { kind: 'unknown', message: '全部链接都未能抓取到正文', at: now() }
    dispatch({ type: 'fail', ...failure })
    return { kind: 'failed', failure }
  }

  // 不在这里 dispatch 'validate:ok'：ingestPrepared 内部的第一个动作就是 dispatch('parse:start')，
  // 报告同一次 validating→parsing 迁移（与 importPaper 委托 ingestPrepared 的方式完全对称，
  // 见 ingest.ts 的注释）——两段拼起来对 onState 而言仍是无缝的一条序列，不会重复报告 'parsing'
  const bundle: UrlBundle = {
    kind: 'url-bundle',
    version: URL_BUNDLE_VERSION,
    sources: sections.map((s) => ({ url: s.url, title: s.title, html: s.html })),
  }
  const bytes = serializeUrlBundle(bundle)
  const source: PaperSource = { type: 'url', entries }

  const outcome = await ingestPrepared(
    {
      title: sections[0]?.title || summarizeHostnames(sections.map((s) => s.finalUrl || s.url)),
      fileName: summarizeHostnames(sections.map((s) => s.finalUrl || s.url)),
      format: 'html',
      mime: URL_BUNDLE_MIME,
      byteSize: bytes.byteLength,
      bytes,
      source,
    },
    ingestDepsOf(deps),
  )
  await discardIfAborted(outcome, deps)
  return outcome
}

// ---------------------------------------------------------------------------
// 原地重导入（网页原貌）
// ---------------------------------------------------------------------------

/**
 * 把一篇 URL 论文的源文件原地换成新抓的网页原貌快照：paperId 不变（Copilot 会话、阅读进度、
 * 画像都挂在 id 上），随后 reingestPaper 重解析出新块。高亮与译文缓存挂在块序号上，
 * 重打标后必然失效，由 replaceFile（步骤 4 的 paperRepo.replaceFile）负责清除。
 *
 * 流程：读论文 → 取 `source.entries[0].finalUrl ?? url` → 抓取 → 构建快照 → replaceFile → reingestPaper。
 * 只接受单链接论文（多链接合集会丢页，见函数体）；replaceFile 由 deps 注入，缺省时直接返回 failed。
 */
export async function reimportUrlPaperInPlace(
  paperId: string,
  deps: UrlImportDeps,
  onUrlProgress?: OnUrlProgress,
): Promise<ImportOutcome> {
  const now = deps.now ?? Date.now
  const failed = (message: string, paper?: PaperRecord): ImportOutcome => ({
    kind: 'failed',
    paper,
    failure: { kind: 'unknown', message, at: now() },
  })

  const paper = await deps.repo.getPaper(paperId)
  if (!paper) return failed('论文记录不存在（可能已被删除）')
  if (!deps.replaceFile) return failed('当前版本不支持原地重导入', paper)
  if (!deps.buildSnapshot) return failed('当前版本不支持网页原貌导入', paper)

  const entries = paper.source?.entries ?? []
  // 多链接合集只有一份合并后的源文件：原地换成其中一页的快照会静默丢掉其余几页（连同它们的
  // URL、高亮与译文）。拒绝，让用户对想要原貌的那一页单独新导入。入口按钮同样按 entries.length 隐藏。
  if (entries.length > 1) return failed('多链接合并的文档不支持网页原貌重导入，请对单个链接重新导入', paper)
  const entry = entries.find((e) => e.ok) ?? entries[0]
  const url = entry?.finalUrl ?? entry?.url
  if (!url) return failed('该论文没有可重新抓取的链接', paper)
  if (isWeixinArticleUrl(url)) return failed('微信文章不支持网页原貌', paper)

  const report = (phase: UrlProgressPhase, detail?: { done: number; total: number }, error?: string) =>
    onUrlProgress?.({ index: 0, total: 1, url, phase, ...(detail ? { detail } : {}), ...(error ? { error } : {}) })

  throwIfAborted(deps.signal, ABORT_MESSAGE)
  report('fetching')
  let fetched: FetchedUrlResult
  try {
    fetched = await deps.fetchUrl(url)
  } catch (e) {
    rethrowIfAborted(e)
    const failure = toFailure(e, now())
    report('failed', undefined, failure.message)
    return { kind: 'failed', paper, failure }
  }
  if (looksLikePdf(fetched.bytes, fetched.contentType)) {
    const message = '链接指向 PDF，无法作为网页原貌重新导入'
    report('failed', undefined, message)
    return failed(message, paper)
  }

  let built: SnapshotBuilt
  try {
    built = await fetchAndBuildSnapshot(url, deps, deps.buildSnapshot, report, fetched)
  } catch (e) {
    rethrowIfAborted(e)
    const failure = toFailure(e, now())
    report('failed', undefined, failure.message)
    return { kind: 'failed', paper, failure }
  }

  // replaceFile 之前的最后一道关：取消发生在这条线之前，原论文一个字节都不会被动过
  throwIfAborted(deps.signal, ABORT_MESSAGE)

  const { bytes, header } = built.result
  try {
    const sha256 = await deps.hash(bytes)
    await deps.replaceFile(paperId, {
      bytes,
      mime: WEB_SNAPSHOT_MIME,
      sha256,
      byteSize: bytes.byteLength,
      format: 'html',
      source: snapshotSource(url, built, now()),
      title: header.title,
      fileName: summarizeHostnames([fetched.finalUrl || url]),
    })
  } catch (e) {
    rethrowIfAborted(e)
    const failure = toFailure(e, now())
    report('failed', undefined, failure.message)
    return { kind: 'failed', paper, failure }
  }

  const outcome = await reingestPaper(paperId, ingestDepsOf(deps))
  if (outcome.kind === 'failed') report('failed', undefined, outcome.failure.message)
  else report('done')
  return outcome
}
