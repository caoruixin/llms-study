import {
  INITIAL_INGEST_STATE,
  ingestPrepared,
  ingestReducer,
  importPaper,
  type ImportOutcome,
  type IngestDeps,
  type IngestEvent,
  type IngestState,
} from '../ingest'
import type { PaperRepository } from '../repo/paperRepo'
import type { IngestFailure, PaperSource, UrlSourceEntry } from '../types'
import { URL_BUNDLE_MIME, URL_BUNDLE_VERSION, serializeUrlBundle, type UrlBundle } from './urlBundle'

/**
 * URL 批量导入编排：与 ingest.ts 同一套依赖注入风格（deps 注入 repo/hash/parse，
 * 外加这里特有的 fetchUrl/extract），测试用假 deps 跑全链路、生产用真实实现。
 *
 * 抓取+抽取阶段刻意不新增 ingest stage：状态机全程停在 'validating'
 * （见 dispatch 时序），逐 URL 的细粒度进度改走 onUrlProgress 回调——
 * PapersPage 的 jobs 面板只需要「校验中/解析中/…」这种粗粒度，
 * 弹窗内的逐链接进度才需要 fetching/extracting 这一级细节，两者服务的 UI 不同。
 */

export type UrlProgressPhase = 'pending' | 'fetching' | 'extracting' | 'done' | 'failed'

export interface UrlProgressEvent {
  index: number
  total: number
  url: string
  phase: UrlProgressPhase
  error?: string
}

export type OnUrlProgress = (ev: UrlProgressEvent) => void

export interface FetchedUrlResult {
  bytes: ArrayBuffer
  contentType: string
  finalUrl: string
}

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

interface ExtractedSection {
  url: string
  finalUrl: string
  title: string
  html: string
}

export async function importFromUrls(
  urls: readonly string[],
  deps: UrlImportDeps,
  onUrlProgress?: OnUrlProgress,
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

  for (let i = 0; i < total; i++) onUrlProgress?.({ index: i, total, url: urls[i], phase: 'pending' })

  const sections: ExtractedSection[] = []
  const entries: UrlSourceEntry[] = []

  for (let i = 0; i < total; i++) {
    const url = urls[i]
    onUrlProgress?.({ index: i, total, url, phase: 'fetching' })

    let fetched: FetchedUrlResult
    try {
      fetched = await deps.fetchUrl(url)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      entries.push({ url, ok: false, error: message, fetchedAt: now() })
      onUrlProgress?.({ index: i, total, url, phase: 'failed', error: message })
      continue
    }

    if (looksLikePdf(fetched.bytes, fetched.contentType)) {
      if (total === 1) {
        // 单 URL 直链 PDF：转投现有 importPaper，享 original 视图与既有 PDF 校验管线
        onUrlProgress?.({ index: i, total, url, phase: 'extracting' })
        const pdfDeps: IngestDeps = { repo: deps.repo, hash: deps.hash, parse: deps.parse, now: deps.now, onState: deps.onState }
        const outcome = await importPaper(
          {
            name: pdfNameFromUrl(fetched.finalUrl || url),
            size: fetched.bytes.byteLength,
            type: 'application/pdf',
            bytes: fetched.bytes,
          },
          pdfDeps,
        )
        if (outcome.kind === 'ready' && outcome.paper) {
          // 导入成功后补写 source：PDF 直链也留一条抓取记录，便于溯源「这篇论文是从哪个 URL 来的」
          const source: PaperSource = {
            type: 'url',
            entries: [{ url, finalUrl: fetched.finalUrl, ok: true, fetchedAt: now() }],
          }
          await deps.repo.setStage(outcome.paper.id, 'ready', { source })
          const updated = await deps.repo.getPaper(outcome.paper.id)
          onUrlProgress?.({ index: i, total, url, phase: 'done' })
          return { kind: 'ready', paper: updated ?? outcome.paper }
        }
        onUrlProgress?.({
          index: i,
          total,
          url,
          phase: outcome.kind === 'failed' ? 'failed' : 'done',
          error: outcome.kind === 'failed' ? outcome.failure.message : undefined,
        })
        return outcome
      }
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
      const message = e instanceof Error ? e.message : String(e)
      entries.push({ url, finalUrl: fetched.finalUrl, ok: false, error: message, fetchedAt: now() })
      onUrlProgress?.({ index: i, total, url, phase: 'failed', error: message })
    }
  }

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

  return ingestPrepared(
    {
      title: sections[0]?.title || summarizeHostnames(sections.map((s) => s.finalUrl || s.url)),
      fileName: summarizeHostnames(sections.map((s) => s.finalUrl || s.url)),
      format: 'html',
      mime: URL_BUNDLE_MIME,
      byteSize: bytes.byteLength,
      bytes,
      source,
    },
    { repo: deps.repo, hash: deps.hash, parse: deps.parse, now: deps.now, onState: deps.onState },
  )
}
