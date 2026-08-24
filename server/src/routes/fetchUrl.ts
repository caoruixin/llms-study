/**
 * URL 瘦抓取代理:POST /api/app/fetch-url,取回目标页面的**原始字节**。
 *
 * 为什么服务端只做瘦代理、不抽正文:HTML 解析要么引一大坨依赖(单进程 512MB 扛不住),
 * 要么保真度不如浏览器。所以这里只解决浏览器做不到的两件事——跨域取字节 + SSRF 防线,
 * 正文抽取交给客户端的 DOMParser + Readability。
 *
 * 防滥用三层:令牌桶(频次)→ 并发闸 1(同时只许一个出网请求)→ 字节/超时上限。
 * 顺序是先桶后闸再解析 body:被限流的请求不该有机会让我们做任何解析工作。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import {
  FETCH_URL_HEADER_FINAL_URL,
  FETCH_URL_MAX_BYTES,
  FETCH_URL_MAX_CONCURRENT,
  FETCH_URL_MAX_LENGTH,
  FETCH_URL_RATE_CAPACITY,
  FETCH_URL_RATE_REFILL_MS,
  FETCH_URL_TIMEOUT_MS,
} from '../../../shared/apiRoutes.js'
import type { FetchUrlBody } from '../../../shared/apiTypes.js'
import { requireSession } from '../auth/middleware.js'
import {
  FetchDeniedError,
  FetchFailedError,
  FetchTooLargeError,
  safeFetchUrl,
} from '../lib/fetchRaw.js'
import { apiError } from '../lib/respond.js'
import { validateTargetUrl } from '../lib/ssrf.js'
import { createConcurrencyGate, createTokenBucket } from '../llm/rateLimit.js'
import type { AppDeps, AppEnv } from '../types.js'

/** 请求体只有一个 URL,4KB 足够宽松;更大的 body 只可能是探测 */
const BODY_MAX_BYTES = 4096

const fetchUrlSchema = z.object({
  url: z.string().min(1).max(FETCH_URL_MAX_LENGTH),
})

/** 内容类型白名单:陪读管线只认这四种;其余(图片/视频/压缩包)抓回来也没用 */
const ALLOWED_MEDIA_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/pdf',
])

/** 上游没给 content-type(或给了万能的 octet-stream)时才做嗅探 */
const SNIFF_MEDIA_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream'])

const PDF_MAGIC = Buffer.from('%PDF-')

/**
 * 首 512 字节是否像"文本":允许 TAB/CR/LF、可打印 ASCII 与所有 ≥0x80 的字节(UTF-8 多字节);
 * 出现其它控制字符即判定为二进制。只看头部是因为我们只需要一个廉价的排除性判据。
 */
function looksLikeText(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512)
  if (head.length === 0) return false
  for (const b of head) {
    if (b >= 0x20 && b !== 0x7f) continue
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue
    return false
  }
  return true
}

/** 解析 content-type:只取 media type 与 charset,其余参数(boundary 等)一律丢弃 */
function parseContentType(raw: string | null): { mediaType: string; charset: string | null } {
  if (!raw) return { mediaType: '', charset: null }
  const [first, ...params] = raw.split(';')
  let charset: string | null = null
  for (const p of params) {
    const m = /^\s*charset\s*=\s*"?([^";]+)"?\s*$/i.exec(p)
    // charset 会被原样写回响应头,必须限定字符集——上游头是不可信输入,防头注入
    if (m && /^[A-Za-z0-9._-]{1,40}$/.test(m[1].trim())) charset = m[1].trim().toLowerCase()
  }
  return { mediaType: first.trim().toLowerCase(), charset }
}

/**
 * 内容类型闸门:返回最终对外声明的 media type,或 null 表示拒绝(415)。
 * 嗅探只在上游没表态时启用——上游明确说了是 image/png 就不该被字节内容"翻案"。
 */
function resolveMediaType(declared: string, bytes: Buffer): string | null {
  if (ALLOWED_MEDIA_TYPES.has(declared)) return declared
  if (!SNIFF_MEDIA_TYPES.has(declared)) return null
  if (bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) return 'application/pdf'
  // 文本且含 '<':当 HTML 处理(纯文本无标签的场景走不到这里——上游会给 text/plain)
  if (looksLikeText(bytes) && bytes.subarray(0, 512).includes(0x3c)) return 'text/html'
  return null
}

export function fetchUrlRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>()
  r.use('*', requireSession(deps))

  const tuning = deps.fetchTuning ?? {}
  // 限流器随路由实例创建:测试里每个用例一套 app,桶互不串味
  const bucket = createTokenBucket(FETCH_URL_RATE_CAPACITY, FETCH_URL_RATE_REFILL_MS)
  const gate = createConcurrencyGate(FETCH_URL_MAX_CONCURRENT)

  r.post('/', async (c) => {
    const user = c.get('user')

    const taken = bucket.take(user.id)
    if (!taken.ok) {
      c.header('Retry-After', String(Math.ceil(taken.retryAfterMs / 1000)))
      return apiError(c, 429, 'rate-limited', '抓取请求过于频繁')
    }
    if (!gate.tryAcquire(user.id)) {
      c.header('Retry-After', '5')
      return apiError(c, 429, 'rate-limited', '已有抓取任务进行中')
    }

    try {
      const declared = Number(c.req.header('content-length') ?? Number.NaN)
      if (Number.isFinite(declared) && declared > BODY_MAX_BYTES) {
        return apiError(c, 413, 'invalid-input', '请求体过大')
      }
      const raw = await c.req.text()
      if (Buffer.byteLength(raw, 'utf8') > BODY_MAX_BYTES) {
        return apiError(c, 413, 'invalid-input', '请求体过大')
      }
      let parsedRaw: unknown
      try {
        parsedRaw = JSON.parse(raw)
      } catch {
        return apiError(c, 400, 'invalid-input', 'body 不是合法 JSON')
      }
      const parsed = fetchUrlSchema.safeParse(parsedRaw)
      if (!parsed.success) {
        const first = parsed.error.issues[0]
        return apiError(
          c,
          400,
          'invalid-input',
          first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'body 不合法',
        )
      }
      const body: FetchUrlBody = parsed.data

      const checked = validateTargetUrl(body.url)
      if (!checked.ok) {
        return apiError(c, checked.code === 'fetch-denied' ? 403 : 400, checked.code, checked.message)
      }

      let result
      try {
        result = await safeFetchUrl(checked.url.toString(), {
          maxBytes: tuning.maxBytes ?? FETCH_URL_MAX_BYTES,
          timeoutMs: tuning.timeoutMs ?? FETCH_URL_TIMEOUT_MS,
          transport: tuning.transport,
          lookup: tuning.lookup,
          allowForbiddenAddresses: deps.config.fetchUrlAllowForbiddenDev,
        })
      } catch (e) {
        if (e instanceof FetchDeniedError) return apiError(c, 403, 'fetch-denied', e.message)
        if (e instanceof FetchTooLargeError) return apiError(c, 413, 'fetch-too-large', e.message)
        if (e instanceof FetchFailedError) return apiError(c, 502, 'fetch-failed', e.message)
        throw e
      }

      const { mediaType, charset } = parseContentType(result.contentType)
      const finalType = resolveMediaType(mediaType, result.bytes)
      if (!finalType) {
        return apiError(
          c,
          415,
          'unsupported-content',
          `不支持的内容类型:${mediaType || '(未声明)'}`,
        )
      }

      // 上游响应头一律不透传(set-cookie/CSP/CORS 全都可能改变前端页面的行为),
      // 只回我们自己构造的这四个头。
      // 转一份 Uint8Array 而不是直接给 Buffer:小 body 的 Buffer 可能是共享内存池的切片,
      // 复制一次杜绝"底层实现忽略 byteOffset 导致回传到别的请求字节"这类隐患。
      return new Response(new Uint8Array(result.bytes), {
        status: 200,
        headers: {
          'Content-Type': charset ? `${finalType}; charset=${charset}` : finalType,
          'Content-Length': String(result.bytes.length),
          // encodeURI 顺带把 CR/LF 编成 %0D%0A,杜绝上游 Location 里的头注入
          [FETCH_URL_HEADER_FINAL_URL]: encodeURI(result.finalUrl),
          'Cache-Control': 'no-store',
        },
      })
    } finally {
      // 并发名额必须在所有出口归还——包括提前 return 的 400/415 与抛异常路径
      gate.release(user.id)
    }
  })

  return r
}
