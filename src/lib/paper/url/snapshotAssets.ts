import {
  FETCH_ASSET_CSS_MEDIA_TYPES,
  FETCH_ASSET_FONT_MEDIA_TYPES,
  FETCH_ASSET_IMAGE_MEDIA_TYPES,
} from '../../../../shared/apiRoutes'
import { abortError, isAbortError } from './abort'
import type { SnapshotSkipped } from './webSnapshot'

/**
 * 网页原貌快照的资源抓取层（PLAN-web-snapshot-sync.md §2.2 第 4 条）：纯编排，抓取函数由调用方注入
 * （生产 = fetchUrlApi.ts 的 `fetchUrl(url, {kind:'asset'})`，测试 = 假实现），node 可测。
 *
 * 职责：按 URL 去重、保持文档序、并发上限、四类配额（总数 / 总字节 / 单个字节 / 字体数与字节）、
 * MIME 白名单、429 退避重试。每一条被跳过的资源都带原因（`SnapshotSkipped`），进快照头的 stats
 * 与论文记录的 capture 摘要——用户能看到「跳过 N 个资源」而不是悄悄少图。
 */

export interface AssetCaps {
  /** 最多尝试抓取的资源数（去重后按文档序取前 N 个，其余 `cap`） */
  maxCount: number
  /** 已固化资源的总字节上限（累计超过的那一个起 `cap`） */
  maxTotalBytes: number
  /** 单个资源的字节上限（超过 → `too-large`，不计入总量） */
  maxAssetBytes: number
  /** 字体数上限（按文档序取前 N 个） */
  maxFonts: number
  /** 字体总字节上限 */
  maxFontBytes: number
  /** 同时进行的抓取数 */
  concurrency: number
}

export const DEFAULT_ASSET_CAPS: AssetCaps = {
  maxCount: 80,
  maxTotalBytes: 30 * 1024 * 1024,
  maxAssetBytes: 8 * 1024 * 1024,
  maxFonts: 12,
  maxFontBytes: 6 * 1024 * 1024,
  concurrency: 3,
}

export interface AssetPlanItem {
  /** 绝对 http(s) URL */
  url: string
  /** css = 样式表（buildSnapshot 内联进 `<style>`，不进资源区）；image / font 进资源区 */
  kind: 'image' | 'font' | 'css'
}

export interface FetchedAsset {
  url: string
  /** 已去参数的小写 MIME（`image/png; charset=binary` → `image/png`） */
  mime: string
  bytes: Uint8Array
  /** 字节 sha256 十六进制：既是去重键，也是 CSS 占位 `url("pc-asset:<id>")` 的引用键 */
  id: string
}

export interface FetchAssetsDeps {
  fetchAsset: (url: string, signal?: AbortSignal) => Promise<{ bytes: ArrayBuffer; contentType: string }>
  hash: (bytes: ArrayBuffer) => Promise<string>
  caps?: Partial<AssetCaps>
  /** done 从 0 计到 total（total = 通过前置配额、真正发起抓取的条数） */
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
  /** 429 退避的等待实现（测试注入假 sleep 以免真等） */
  sleep?: (ms: number) => Promise<void>
}

/** 429 最多重试次数（不含首次） */
const MAX_RETRIES = 3
/** Retry-After 再长也只等这么久：导入是前台交互，不能为一张图挂半分钟 */
const MAX_RETRY_DELAY_MS = 5000
/** 429 却没带 Retry-After 时的默认退避 */
const DEFAULT_RETRY_DELAY_MS = 1000

/** 与服务端 fetch-url asset 通道同一份清单（shared/apiRoutes.ts）：代理只会放行这些，客户端再按类别核对 */
const CSS_MIMES = new Set(FETCH_ASSET_CSS_MEDIA_TYPES)
const IMAGE_MIMES = new Set(FETCH_ASSET_IMAGE_MEDIA_TYPES)
const FONT_MIMES = new Set(FETCH_ASSET_FONT_MEDIA_TYPES)

/** `Content-Type` → 去参数、小写的 MIME 主体 */
export function normalizeMime(contentType: string): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase()
}

export function isAllowedAssetMime(mime: string, kind: AssetPlanItem['kind']): boolean {
  const m = normalizeMime(mime)
  if (kind === 'css') return CSS_MIMES.has(m)
  if (kind === 'font') return FONT_MIMES.has(m)
  return IMAGE_MIMES.has(m)
}

/** IP 字面量（v4 / v6）只做精确比较：`1.2.3.4` 与 `9.9.3.4` 的「后两段」相同毫无意义 */
const isIpLiteral = (host: string): boolean => /^[\d.]+$/.test(host) || host.includes(':')

/** 可注册域的粗略近似：主机名最后两段（`cdn.example.com` → `example.com`） */
function registrableDomain(host: string): string {
  const labels = host.split('.').filter(Boolean)
  return labels.length >= 2 ? labels.slice(-2).join('.') : host
}

/**
 * 只代理与页面同站的字体：第三方字体 CDN（Google Fonts 的 fonts.gstatic.com 等）本就带 `ACAO:*`，
 * 阅读器 iframe 直接远程加载即可；把它们也固化进快照只会白白撑大文件、消耗代理配额。
 */
export function shouldProxyFont(fontUrl: string, pageUrl: string): boolean {
  let font: URL
  let page: URL
  try {
    font = new URL(fontUrl)
    page = new URL(pageUrl)
  } catch {
    return false
  }
  if (font.protocol !== 'https:' && font.protocol !== 'http:') return false
  const f = font.hostname.toLowerCase()
  const p = page.hostname.toLowerCase()
  if (f === p) return true
  if (isIpLiteral(f) || isIpLiteral(p)) return false
  return registrableDomain(f) === registrableDomain(p)
}

// ---------------------------------------------------------------------------
// 抓取
// ---------------------------------------------------------------------------

const ABORT_MESSAGE = '资源抓取已取消'

/** 可退避重试的错误：带 retryAfterMs（fetchUrlApi 只在 429 时挂）或 status 429；其余 null = 不重试 */
function retryDelayMs(e: unknown): number | null {
  const err = e as { retryAfterMs?: unknown; status?: unknown } | null
  if (typeof err?.retryAfterMs === 'number' && err.retryAfterMs >= 0) return Math.min(err.retryAfterMs, MAX_RETRY_DELAY_MS)
  if (err?.status === 429) return DEFAULT_RETRY_DELAY_MS
  return null
}

type Slot = { ok: true; asset: FetchedAsset } | { ok: false; skipped: SnapshotSkipped }

type FetchOne = { ok: true; bytes: ArrayBuffer; mime: string } | { ok: false; reason: SnapshotSkipped['reason'] }

export async function fetchAssets(
  items: AssetPlanItem[],
  deps: FetchAssetsDeps,
): Promise<{ fetched: FetchedAsset[]; skipped: SnapshotSkipped[] }> {
  const caps: AssetCaps = { ...DEFAULT_ASSET_CAPS, ...deps.caps }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const signal = deps.signal

  // 去重（先到先得）保序
  const seen = new Set<string>()
  const unique: AssetPlanItem[] = []
  for (const it of items) {
    if (seen.has(it.url)) continue
    seen.add(it.url)
    unique.push(it)
  }

  // 前置配额（总数 / 字体数）按文档序决定，不受并发完成顺序影响
  const slots: (Slot | undefined)[] = new Array(unique.length)
  const attempts: number[] = []
  let fontCount = 0
  unique.forEach((it, i) => {
    if (attempts.length >= caps.maxCount) {
      slots[i] = { ok: false, skipped: { url: it.url, reason: 'cap' } }
      return
    }
    if (it.kind === 'font') {
      if (fontCount >= caps.maxFonts) {
        slots[i] = { ok: false, skipped: { url: it.url, reason: 'cap' } }
        return
      }
      fontCount++
    }
    attempts.push(i)
  })

  const total = attempts.length
  let done = 0
  let totalBytes = 0
  let fontBytes = 0
  deps.onProgress?.(0, total)

  async function fetchOne(it: AssetPlanItem): Promise<FetchOne> {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw abortError(ABORT_MESSAGE, signal)
      try {
        const res = await deps.fetchAsset(it.url, signal)
        const mime = normalizeMime(res.contentType)
        if (!isAllowedAssetMime(mime, it.kind)) return { ok: false, reason: 'type' }
        return { ok: true, bytes: res.bytes, mime }
      } catch (e) {
        // 主动取消不是「这条资源抓不到」：整个抓取作废，原样上抛
        if (isAbortError(e) || signal?.aborted) throw e
        const delay = retryDelayMs(e)
        if (delay === null || attempt >= MAX_RETRIES) return { ok: false, reason: 'fetch' }
        await sleep(delay)
      }
    }
  }

  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < attempts.length) {
      const i = attempts[cursor++]
      const it = unique[i]
      const r = await fetchOne(it)
      if (!r.ok) {
        slots[i] = { ok: false, skipped: { url: it.url, reason: r.reason } }
      } else {
        const len = r.bytes.byteLength
        const isFont = it.kind === 'font'
        // 配额记账在同步段完成（await hash 之前），并发 worker 之间不会读到过期的累计值
        if (len > caps.maxAssetBytes) {
          slots[i] = { ok: false, skipped: { url: it.url, reason: 'too-large' } }
        } else if (totalBytes + len > caps.maxTotalBytes || (isFont && fontBytes + len > caps.maxFontBytes)) {
          slots[i] = { ok: false, skipped: { url: it.url, reason: 'cap' } }
        } else {
          totalBytes += len
          if (isFont) fontBytes += len
          const id = await deps.hash(r.bytes)
          slots[i] = { ok: true, asset: { url: it.url, mime: r.mime, bytes: new Uint8Array(r.bytes), id } }
        }
      }
      done++
      deps.onProgress?.(done, total)
    }
  }

  const workers = Math.max(1, Math.min(caps.concurrency, total))
  await Promise.all(Array.from({ length: workers }, () => worker()))

  const fetched: FetchedAsset[] = []
  const skipped: SnapshotSkipped[] = []
  for (const slot of slots) {
    if (!slot) continue
    if (slot.ok) fetched.push(slot.asset)
    else skipped.push(slot.skipped)
  }
  return { fetched, skipped }
}
