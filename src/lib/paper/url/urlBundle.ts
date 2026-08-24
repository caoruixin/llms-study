import { IngestError, type ParseResult } from '../ingest'
import { normalizeHtmlSections } from '../normalizeHtml'
import { URL_BUNDLE_MIME } from './urlBundleMime'

/**
 * URL 导入的「源文件」云存形态：抽取净化后的确定性 JSON（不是原始网页字节）。
 *
 * 为什么不存原始抓取字节：正文抽取（Readability + 启发式后备）依赖浏览器 DOM，
 * 换设备/服务端没法重放；存「已抽取的净化 HTML」则 sha256 既是去重键，也满足
 * files.ts 的 X-File-Sha256 完整性校验，换设备 reingest 时用本地这份 JSON 直接
 * 重新走 normalizeHtmlSections 即可，不需要重新联网抓取。
 *
 * 序列化必须字节确定性（同输入同字节）：sha256 才能稳定命中去重，字节里也
 * 故意不含 fetchedAt 这类易变字段（那些字段只存在 PaperRecord.source.entries 里）。
 */
export const URL_BUNDLE_VERSION = 1 as const

export interface UrlBundleSource {
  url: string
  /** 页面标题；单节时不参与规范化，仅多节合并时用于合成节标题 */
  title?: string
  /** 已净化的正文 HTML（extractArticle.ts 在抓取时用 sanitizeDocxHtml 处理过） */
  html: string
}

export interface UrlBundle {
  kind: 'url-bundle'
  version: typeof URL_BUNDLE_VERSION
  sources: UrlBundleSource[]
}

export { URL_BUNDLE_MIME }

/**
 * 固定字段顺序手动重建对象再 JSON.stringify：不直接信任调用方传入对象的属性插入顺序，
 * 保证「同样的 sources 内容，不管调用方怎么构造对象字面量」都产出同一份字节。
 */
export function serializeUrlBundle(bundle: Pick<UrlBundle, 'sources'>): ArrayBuffer {
  const ordered = {
    kind: 'url-bundle' as const,
    version: URL_BUNDLE_VERSION,
    // 逐字段显式重列（url → title? → html），不透传调用方对象本身：
    // 即便调用方传来的对象属性顺序不同，这里也总是产出同一顺序的字节
    sources: bundle.sources.map((s) => ({ url: s.url, ...(s.title ? { title: s.title } : {}), html: s.html })),
  }
  return new TextEncoder().encode(JSON.stringify(ordered)).buffer as ArrayBuffer
}

function corrupt(message: string): never {
  throw new IngestError('corrupt', `URL 合集文件已损坏（${message}）`)
}

/** 形状校验：只信任恰好符合 UrlBundle 结构的 JSON，其余一律判损坏（服务端/同步都不可信） */
function parseBundleShape(json: unknown): UrlBundle {
  if (typeof json !== 'object' || json === null) corrupt('不是对象')
  const o = json as Record<string, unknown>
  if (o.kind !== 'url-bundle') corrupt('kind 字段不匹配')
  if (o.version !== URL_BUNDLE_VERSION) corrupt('version 字段不匹配')
  if (!Array.isArray(o.sources) || o.sources.length === 0) corrupt('缺少正文来源')

  const sources: UrlBundleSource[] = o.sources.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) corrupt(`第 ${i + 1} 节不是对象`)
    const r = raw as Record<string, unknown>
    if (typeof r.url !== 'string' || !r.url) corrupt(`第 ${i + 1} 节缺少 url`)
    if (typeof r.html !== 'string') corrupt(`第 ${i + 1} 节缺少 html`)
    const source: UrlBundleSource = { url: r.url, html: r.html }
    if (typeof r.title === 'string' && r.title) source.title = r.title
    return source
  })

  return { kind: 'url-bundle', version: URL_BUNDLE_VERSION, sources }
}

/**
 * 字节 → UrlBundle → ParseResult。返回形状与 ingest.ts 的 IngestDeps.parse 契约完全一致
 * （{blocks, title}），可直接供 parseByFormat 的 'html' 分支与 ingestPrepared 编排复用——
 * 与 parsePdfBytes / parseDocxBytes 是同一层级的「按格式解析」实现。
 */
export function parseUrlBundleBytes(bytes: ArrayBuffer): ParseResult {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    corrupt('无法解码为文本')
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    corrupt('不是合法 JSON')
  }
  const bundle = parseBundleShape(json)
  const blocks = normalizeHtmlSections(bundle.sources.map((s) => ({ title: s.title, html: s.html })))
  return { blocks, title: bundle.sources[0]?.title }
}
