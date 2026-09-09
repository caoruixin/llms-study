import { IngestError, type ParseResult } from '../ingest'
import type { NormalizedBlock, SourceAnchor } from '../types'
import { WEB_SNAPSHOT_MAGIC, WEB_SNAPSHOT_MIME } from './webSnapshotMime'

/**
 * 「网页原貌」导入的源文件形态：单文件二进制容器，**自包含**整页快照。
 *
 * 字节布局（PLAN-web-snapshot-sync.md §2.1）：
 *
 *   'PCS1'（4B 魔数） | u32 LE 头长 | UTF-8 JSON 头 | 资源字节拼接（按 assets[] 顺序）
 *
 * 与 urlBundle.ts 的分工：urlBundle 存「抽取后的净化正文 HTML」（阅读模式），本容器存
 * 「整页 sanitize 后的 documentElement.outerHTML + 样式表/图片/字体字节 + 已推导的块」。
 * 一份字节即可在任何设备离线复现原貌，不需要重新联网抓取。
 *
 * 为什么块（blocks）直接放进头里、而不是解析时由 DOM 重推：
 * 打标（stampBlocks）依赖浏览器 DOM 与站点 CSS，换设备/换解析器都会漂移；把块随字节固化，
 * 「字节相同 ⇒ 块相同」这条不变式才成立——高亮偏移、译文缓存、引用锚点都挂在块序号上。
 * 于是 parseWebSnapshotBytes 只是解 JSON，PARSER_VERSION 也不必因快照升级而 bump
 * （快照自身由 header.version 版本化）。
 *
 * 序列化必须字节确定性（同输入同字节）：sha256 既是导入去重键，也是 files.ts 的
 * X-File-Sha256 完整性校验值。因此这里固定键序、资源按 id 排序去重、且**不含任何时间戳**
 * （fetchedAt 之类只存在 PaperRecord.source.entries 里）。
 */
export const WEB_SNAPSHOT_VERSION = 1 as const

/** 头里 html 字段的字节上限；超限由 buildSnapshot 判 IngestError('too-large')，本模块只提供常量 */
export const MAX_SNAPSHOT_HTML_BYTES = 8 * 1024 * 1024

/** stats.skipped 只保留前 50 条：报告用途，超出部分对用户没有增量信息，却会撑大头 JSON */
const MAX_SKIPPED = 50

export interface SnapshotAsset {
  /** 资源字节的 sha256 十六进制（由调用方算好）：既是去重键，也是 CSS 占位 `url("pc-asset:<id>")` 的引用键 */
  id: string
  /** 资源的原始绝对 URL（https），水合失败时可作远程兜底 */
  url: string
  mime: string
  /** 相对**资源区起点**（= 头结束处）的偏移，不是相对文件起点 */
  offset: number
  length: number
}

export interface SnapshotSkipped {
  url: string
  reason: 'cap' | 'too-large' | 'fetch' | 'type'
}

export interface WebSnapshotCapture {
  /** rendered = iframe 渲染捕获（Tier 2）；static = DOMParser 静态捕获（Tier 1 回退） */
  mode: 'rendered' | 'static'
  /** 是否跑过 KaTeX auto-render（阅读器据此决定要不要注入 katex.min.css） */
  katex: boolean
  viewportWidth: number
  agentVersion: number
}

export interface WebSnapshotHeader {
  kind: 'web-snapshot'
  version: typeof WEB_SNAPSHOT_VERSION
  url: string
  finalUrl: string
  title: string
  capture: WebSnapshotCapture
  /** 已 sanitize + 已打标的 documentElement.outerHTML（不含 doctype，水合时补） */
  html: string
  assets: SnapshotAsset[]
  /** 唯一的块来源：parse 只解 JSON，永不碰 DOM */
  blocks: NormalizedBlock[]
  stats: { assetBytes: number; skipped: SnapshotSkipped[] }
}

export interface WebSnapshotInput {
  /** assets / kind / version 由 encode 计算与写死，调用方不提供 */
  header: Omit<WebSnapshotHeader, 'assets' | 'kind' | 'version'>
  /** id = 调用方算好的字节 sha256 十六进制；顺序无所谓，encode 按 id 排序去重 */
  assets: { id: string; url: string; mime: string; bytes: Uint8Array }[]
}

export { WEB_SNAPSHOT_MIME }

const MAGIC_BYTES = 4
const HEADER_LEN_BYTES = 4
const ASSET_REGION_START = MAGIC_BYTES + HEADER_LEN_BYTES

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------

/**
 * 固定字段顺序手动重建每一层对象再 JSON.stringify：不透传调用方对象本身。
 * 同样的逻辑内容，不管调用方用什么属性插入顺序构造字面量，都产出同一份字节
 * （沿用 urlBundle.ts:38-47 的做法，块与资源这两层嵌套结构同样处理）。
 */
function orderAnchor(a: SourceAnchor): SourceAnchor {
  const out: SourceAnchor = { kind: a.kind, blockIndex: a.blockIndex }
  if (a.page !== undefined) out.page = a.page
  if (a.charStart !== undefined) out.charStart = a.charStart
  if (a.charEnd !== undefined) out.charEnd = a.charEnd
  if (a.section !== undefined) out.section = a.section
  return out
}

/**
 * 逐字段显式重列（index → kind → level? → text → html? → src? → anchor）。
 * 用 `!== undefined` 而非真值判断：charStart:0 这类合法零值不能被悄悄丢掉。
 */
function orderBlock(b: NormalizedBlock): NormalizedBlock {
  const out: Record<string, unknown> = { index: b.index, kind: b.kind }
  if (b.level !== undefined) out.level = b.level
  out.text = b.text
  if (b.html !== undefined) out.html = b.html
  if (b.src !== undefined) out.src = b.src
  out.anchor = orderAnchor(b.anchor)
  return out as unknown as NormalizedBlock
}

/** 按 id 去重（先到先得）再按 id 升序：调用方给的资源顺序不影响字节 */
function orderAssets<T extends { id: string }>(assets: T[]): T[] {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const a of assets) {
    if (seen.has(a.id)) continue
    seen.add(a.id)
    unique.push(a)
  }
  return unique.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
}

export function encodeWebSnapshot(input: WebSnapshotInput): { bytes: ArrayBuffer; header: WebSnapshotHeader } {
  const ordered = orderAssets(input.assets)

  const assets: SnapshotAsset[] = []
  let offset = 0
  for (const a of ordered) {
    assets.push({ id: a.id, url: a.url, mime: a.mime, offset, length: a.bytes.byteLength })
    offset += a.bytes.byteLength
  }
  const assetBytesTotal = offset

  const h = input.header
  const header: WebSnapshotHeader = {
    kind: 'web-snapshot',
    version: WEB_SNAPSHOT_VERSION,
    url: h.url,
    finalUrl: h.finalUrl,
    title: h.title,
    capture: {
      mode: h.capture.mode,
      katex: h.capture.katex,
      viewportWidth: h.capture.viewportWidth,
      agentVersion: h.capture.agentVersion,
    },
    html: h.html,
    assets,
    blocks: h.blocks.map(orderBlock),
    stats: {
      // assetBytes 由实际写入的资源重算（而非透传调用方值）：去重之后才知道真实字节数，
      // 头与资源区必须自洽——否则「跳过 N 个资源」之类的报告会与文件内容对不上
      assetBytes: assetBytesTotal,
      skipped: h.stats.skipped.slice(0, MAX_SKIPPED).map((s) => ({ url: s.url, reason: s.reason })),
    },
  }

  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  const out = new Uint8Array(ASSET_REGION_START + headerBytes.byteLength + assetBytesTotal)
  out.set(WEB_SNAPSHOT_MAGIC, 0)
  new DataView(out.buffer).setUint32(MAGIC_BYTES, headerBytes.byteLength, true)
  out.set(headerBytes, ASSET_REGION_START)

  let cursor = ASSET_REGION_START + headerBytes.byteLength
  for (const a of ordered) {
    out.set(a.bytes, cursor)
    cursor += a.bytes.byteLength
  }

  return { bytes: out.buffer as ArrayBuffer, header }
}

// ---------------------------------------------------------------------------
// 解码
// ---------------------------------------------------------------------------

function corrupt(message: string): never {
  throw new IngestError('corrupt', `web-snapshot 文件已损坏（${message}）`)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

const SKIP_REASONS: SnapshotSkipped['reason'][] = ['cap', 'too-large', 'fetch', 'type']

/** 形状校验：只信任恰好符合 WebSnapshotHeader 的 JSON，其余一律判损坏（服务端/同步都不可信） */
function parseHeaderShape(json: unknown, assetRegionLength: number): WebSnapshotHeader {
  if (!isObject(json)) corrupt('头不是对象')
  if (json.kind !== 'web-snapshot') corrupt('kind 字段不匹配')
  if (json.version !== WEB_SNAPSHOT_VERSION) corrupt('version 字段不匹配')
  for (const key of ['url', 'finalUrl', 'title', 'html'] as const) {
    if (typeof json[key] !== 'string') corrupt(`${key} 字段缺失或不是字符串`)
  }

  const cap = json.capture
  if (!isObject(cap)) corrupt('capture 字段不是对象')
  if (cap.mode !== 'rendered' && cap.mode !== 'static') corrupt('capture.mode 取值非法')
  if (typeof cap.katex !== 'boolean') corrupt('capture.katex 不是布尔值')
  if (typeof cap.viewportWidth !== 'number' || typeof cap.agentVersion !== 'number') corrupt('capture 数值字段非法')

  if (!Array.isArray(json.assets)) corrupt('assets 不是数组')
  const assets: SnapshotAsset[] = json.assets.map((raw, i) => {
    if (!isObject(raw)) corrupt(`第 ${i + 1} 个资源不是对象`)
    if (typeof raw.id !== 'string' || !raw.id) corrupt(`第 ${i + 1} 个资源缺少 id`)
    if (typeof raw.url !== 'string') corrupt(`第 ${i + 1} 个资源缺少 url`)
    if (typeof raw.mime !== 'string') corrupt(`第 ${i + 1} 个资源缺少 mime`)
    if (!isNonNegInt(raw.offset) || !isNonNegInt(raw.length)) corrupt(`第 ${i + 1} 个资源的 offset/length 非法`)
    // 越界的偏移必须在这里拦掉：后面 assetBytes(id) 会直接以它开视图，越界会抛 RangeError
    if (raw.offset + raw.length > assetRegionLength) corrupt(`第 ${i + 1} 个资源越界`)
    return { id: raw.id, url: raw.url, mime: raw.mime, offset: raw.offset, length: raw.length }
  })

  if (!Array.isArray(json.blocks)) corrupt('blocks 不是数组')
  for (let i = 0; i < json.blocks.length; i++) {
    const b: unknown = json.blocks[i]
    if (!isObject(b)) corrupt(`第 ${i + 1} 个块不是对象`)
    if (typeof b.index !== 'number') corrupt(`第 ${i + 1} 个块缺少 index`)
    if (typeof b.kind !== 'string') corrupt(`第 ${i + 1} 个块缺少 kind`)
    if (typeof b.text !== 'string') corrupt(`第 ${i + 1} 个块缺少 text`)
    if (!isObject(b.anchor)) corrupt(`第 ${i + 1} 个块缺少 anchor`)
  }

  const stats = json.stats
  if (!isObject(stats)) corrupt('stats 不是对象')
  if (typeof stats.assetBytes !== 'number') corrupt('stats.assetBytes 非法')
  if (!Array.isArray(stats.skipped)) corrupt('stats.skipped 不是数组')
  const skipped: SnapshotSkipped[] = stats.skipped.map((raw, i) => {
    if (!isObject(raw)) corrupt(`第 ${i + 1} 条跳过记录不是对象`)
    if (typeof raw.url !== 'string') corrupt(`第 ${i + 1} 条跳过记录缺少 url`)
    if (!SKIP_REASONS.includes(raw.reason as SnapshotSkipped['reason'])) corrupt(`第 ${i + 1} 条跳过记录 reason 非法`)
    return { url: raw.url, reason: raw.reason as SnapshotSkipped['reason'] }
  })

  return {
    kind: 'web-snapshot',
    version: WEB_SNAPSHOT_VERSION,
    url: json.url as string,
    finalUrl: json.finalUrl as string,
    title: json.title as string,
    capture: {
      mode: cap.mode,
      katex: cap.katex,
      viewportWidth: cap.viewportWidth,
      agentVersion: cap.agentVersion,
    },
    html: json.html as string,
    assets,
    // 块原样透传（不逐字段重建）：blocks 是快照的唯一块来源，重建会悄悄吞掉未来新增字段
    blocks: json.blocks as NormalizedBlock[],
    stats: { assetBytes: stats.assetBytes, skipped },
  }
}

export function decodeWebSnapshot(bytes: ArrayBuffer): {
  header: WebSnapshotHeader
  assetBytes(id: string): Uint8Array | null
} {
  if (bytes.byteLength < ASSET_REGION_START) corrupt('文件长度不足')
  const head = new Uint8Array(bytes, 0, MAGIC_BYTES)
  for (let i = 0; i < MAGIC_BYTES; i++) {
    if (head[i] !== WEB_SNAPSHOT_MAGIC[i]) corrupt('魔数不匹配')
  }

  const headerLength = new DataView(bytes).getUint32(MAGIC_BYTES, true)
  const headerEnd = ASSET_REGION_START + headerLength
  if (headerEnd > bytes.byteLength) corrupt('头长度越界')

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes, ASSET_REGION_START, headerLength))
  } catch {
    corrupt('头无法解码为文本')
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    corrupt('头不是合法 JSON')
  }

  const assetRegionLength = bytes.byteLength - headerEnd
  const header = parseHeaderShape(json, assetRegionLength)

  const byId = new Map(header.assets.map((a) => [a.id, a]))
  return {
    header,
    /** 返回的是**视图**（不拷贝）：30MB 级资源集不该在每次取用时再复制一份 */
    assetBytes(id: string): Uint8Array | null {
      const a = byId.get(id)
      if (!a) return null
      return new Uint8Array(bytes, headerEnd + a.offset, a.length)
    },
  }
}

/**
 * 字节 → ParseResult。返回形状与 ingest.ts 的 IngestDeps.parse 契约一致（{blocks, title}），
 * 与 parsePdfBytes / parseDocxBytes / parseUrlBundleBytes 同层级；由 parseHtmlBytes.ts 按魔数分流。
 *
 * 「解析」在快照这里就是解 JSON：块在导入时已随字节固化，重放不依赖 DOM 与站点 CSS。
 */
export function parseWebSnapshotBytes(bytes: ArrayBuffer): ParseResult {
  const { header } = decodeWebSnapshot(bytes)
  return { blocks: header.blocks, title: header.title }
}
