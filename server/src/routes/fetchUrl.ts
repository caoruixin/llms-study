/**
 * URL 瘦抓取代理:POST /api/app/fetch-url,取回目标页面的**原始字节**。
 *
 * 为什么服务端只做瘦代理、不抽正文:HTML 解析要么引一大坨依赖(单进程 512MB 扛不住),
 * 要么保真度不如浏览器。所以这里只解决浏览器做不到的两件事——跨域取字节 + SSRF 防线,
 * 正文抽取交给客户端的 DOMParser + Readability。
 *
 * 两种 kind 共用这一条通道,SSRF 防线(端口/字面 IP/DNS 禁区/重定向逐跳重验)完全一致,
 * 只在**限额与内容类型白名单**上分家:
 * - `page`(默认):正文/PDF/位图,FETCH_URL_* 限额;
 * - `asset`:网页原貌导入的样式表/图片/字体,FETCH_ASSET_* 的独立桶与并发闸——
 *   一篇快照要顺序抓几十个小文件,共用正文那套 5 枚/10s + 并发 1 会把用户自己的导入饿死。
 *
 * 防滥用三层:令牌桶(频次)→ 并发闸(同时只许 n 个出网请求)→ 字节/超时上限。
 * 顺序上先读 4KB 上限的 body(要它才知道 kind、才知道扣哪个桶),再桶、再闸、再出网;
 * 解析不出 kind 的畸形请求一律记在 page 账上,"畸形请求同样消耗令牌"的语义不变。
 */
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  FETCH_ASSET_CSS_MEDIA_TYPES,
  FETCH_ASSET_FONT_MEDIA_TYPES,
  FETCH_ASSET_IMAGE_MEDIA_TYPES,
  FETCH_ASSET_MAX_BYTES,
  FETCH_ASSET_MAX_CONCURRENT,
  FETCH_ASSET_RATE_CAPACITY,
  FETCH_ASSET_RATE_REFILL_MS,
  FETCH_ASSET_TIMEOUT_MS,
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
import {
  createConcurrencyGate,
  createTokenBucket,
  type ConcurrencyGate,
  type TokenBucketLimiter,
} from '../llm/rateLimit.js'
import type { AppDeps, AppEnv } from '../types.js'

/** 请求体只有一个 URL 加一个短枚举,4KB 足够宽松;更大的 body 只可能是探测 */
const BODY_MAX_BYTES = 4096

type FetchKind = 'page' | 'asset'

const fetchUrlSchema = z.object({
  url: z.string().min(1).max(FETCH_URL_MAX_LENGTH),
  // 老客户端不传 kind → 按 page 处理,行为与本改动之前完全一致
  kind: z.enum(['page', 'asset']).default('page'),
})

/**
 * 内容类型白名单:正文四种 + 位图四种(阅读视图断图时的「通过代理加载」兜底)。
 * 不放行 image/svg+xml——svg 是可执行文档(script/foreignObject),与 sanitize 侧 FORBID svg 对齐。
 * 图片与正文共用同一套令牌桶/并发闸/字节上限,不做类型专属限额。
 */
const ALLOWED_MEDIA_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

/**
 * 资源白名单:样式表 + 图片 + 字体(清单本体在 shared/apiRoutes.ts,与客户端 fetchAssets 共用一份)。
 * 刻意**不含** HTML/PDF——asset 通道只服务
 * 「一篇网页原貌的附属资源」,拿它抓文档没有正当用途,收窄面即少一类滥用。
 *
 * image/svg+xml 只在这里放行(page 仍拒):快照里的 svg 资源只会被客户端喂给
 * `<img src=blob:>` 与 CSS `url()` 两种图像上下文,而它们渲染在**无脚本沙箱 iframe**
 * (`sandbox="allow-same-origin"`,无 allow-scripts)内,且 `<img>` 语境下 svg 的脚本
 * 本就不执行——绝不会被当成文档打开。page 通道的字节则会流进 DOMParser/正文管线,
 * 那里放行 svg 等于开一个可执行文档的口子,所以维持拒绝。
 */
const ALLOWED_ASSET_MEDIA_TYPES = new Set<string>([
  ...FETCH_ASSET_CSS_MEDIA_TYPES,
  ...FETCH_ASSET_IMAGE_MEDIA_TYPES,
  ...FETCH_ASSET_FONT_MEDIA_TYPES,
])

/** 上游没给 content-type(或给了万能的 octet-stream)时才做嗅探 */
const SNIFF_MEDIA_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream'])

const PDF_MAGIC = Buffer.from('%PDF-')

/**
 * 资源魔数表:字体服务器(尤其自建的)常把 woff2/ttf 发成 octet-stream,
 * 上游不表态时按字节判定。顺序无所谓——魔数互不前缀。
 * 对外声明的 media type 一律取白名单里的规范写法,不回上游的模糊值。
 */
const ASSET_MAGICS: { magic: Buffer; mediaType: string }[] = [
  { magic: Buffer.from('wOFF', 'latin1'), mediaType: 'font/woff' },
  { magic: Buffer.from('wOF2', 'latin1'), mediaType: 'font/woff2' },
  { magic: Buffer.from('OTTO', 'latin1'), mediaType: 'font/otf' },
  { magic: Buffer.from([0x00, 0x01, 0x00, 0x00]), mediaType: 'font/ttf' },
  { magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mediaType: 'image/png' },
  { magic: Buffer.from([0xff, 0xd8, 0xff]), mediaType: 'image/jpeg' },
  { magic: Buffer.from('GIF87a', 'latin1'), mediaType: 'image/gif' },
  { magic: Buffer.from('GIF89a', 'latin1'), mediaType: 'image/gif' },
]

const RIFF_MAGIC = Buffer.from('RIFF', 'latin1')
const WEBP_MAGIC = Buffer.from('WEBP', 'latin1')

/** RIFF 容器:`RIFF` + u32 长度 + 四字符类型,只认 WEBP(其余是 wav/avi 等,非资源) */
function sniffAsset(bytes: Buffer): string | null {
  for (const { magic, mediaType } of ASSET_MAGICS) {
    if (bytes.subarray(0, magic.length).equals(magic)) return mediaType
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).equals(RIFF_MAGIC) &&
    bytes.subarray(8, 12).equals(WEBP_MAGIC)
  ) {
    return 'image/webp'
  }
  return null
}

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
 * 白名单类型(含 image/*)原样放行;嗅探只在上游没表态时启用——上游明确说了是
 * video/mp4 就不该被字节内容"翻案"(page 的嗅探也只认 PDF 魔数与 HTML 文本,不嗅图片)。
 */
function resolveMediaType(kind: FetchKind, declared: string, bytes: Buffer): string | null {
  if (kind === 'asset') {
    if (ALLOWED_ASSET_MEDIA_TYPES.has(declared)) return declared
    if (!SNIFF_MEDIA_TYPES.has(declared)) return null
    // 资源不嗅文本:text/css 的上游几乎总会声明,而"可打印字节"当 css 放行等于给
    // octet-stream 的任意文本开口子(它随后会被当样式表内联进快照)。
    return sniffAsset(bytes)
  }
  if (ALLOWED_MEDIA_TYPES.has(declared)) return declared
  if (!SNIFF_MEDIA_TYPES.has(declared)) return null
  if (bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) return 'application/pdf'
  // 文本且含 '<':当 HTML 处理(纯文本无标签的场景走不到这里——上游会给 text/plain)
  if (looksLikeText(bytes) && bytes.subarray(0, 512).includes(0x3c)) return 'text/html'
  return null
}

/** 出站 Accept:资源按 css/图片/字体表态,避免 CDN 按正文那套 accept 做内容协商回错东西 */
const ASSET_ACCEPT = 'text/css,image/*,font/*,*/*;q=0.5'

type BodyResult =
  | { ok: true; body: FetchUrlBody & { kind: FetchKind } }
  | { ok: false; status: 400 | 413; message: string }

/** 读 + 解析请求体。失败也要把 kind 定下来(按 page)才能决定去哪个桶扣费,见调用处注释 */
async function readBody(c: Context<AppEnv>): Promise<BodyResult> {
  // 声明超限先拒,绝不把超大 body 读进内存
  const declaredLength = Number(c.req.header('content-length') ?? Number.NaN)
  if (Number.isFinite(declaredLength) && declaredLength > BODY_MAX_BYTES) {
    return { ok: false, status: 413, message: '请求体过大' }
  }
  const raw = await c.req.text()
  if (Buffer.byteLength(raw, 'utf8') > BODY_MAX_BYTES) {
    return { ok: false, status: 413, message: '请求体过大' }
  }
  let parsedRaw: unknown
  try {
    parsedRaw = JSON.parse(raw)
  } catch {
    return { ok: false, status: 400, message: 'body 不是合法 JSON' }
  }
  const parsed = fetchUrlSchema.safeParse(parsedRaw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      ok: false,
      status: 400,
      message: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'body 不合法',
    }
  }
  return { ok: true, body: parsed.data }
}

/** 一种 kind 的全套限额:桶、并发闸、字节/超时上限、出站 accept 与并发满时的文案 */
interface KindLimits {
  bucket: TokenBucketLimiter
  gate: ConcurrencyGate
  maxBytes: number
  timeoutMs: number
  accept?: string
  busy: string
}

export function fetchUrlRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>()
  r.use('*', requireSession(deps))

  const tuning = deps.fetchTuning ?? {}
  // 限流器随路由实例创建:测试里每个用例一套 app,桶互不串味。
  // page 与 asset 各一套且**互不影响**:抓快照资源不消耗正文额度,反之亦然。
  const limits: Record<FetchKind, KindLimits> = {
    page: {
      bucket: createTokenBucket(FETCH_URL_RATE_CAPACITY, FETCH_URL_RATE_REFILL_MS),
      gate: createConcurrencyGate(FETCH_URL_MAX_CONCURRENT),
      // fetchTuning 是测试专用注入口,对两种 kind 一视同仁地覆盖——
      // 否则 stub transport 那套(超时 5s、小 maxBytes)在 asset 用例里就失效了
      maxBytes: tuning.maxBytes ?? FETCH_URL_MAX_BYTES,
      timeoutMs: tuning.timeoutMs ?? FETCH_URL_TIMEOUT_MS,
      busy: '已有抓取任务进行中',
    },
    asset: {
      bucket: createTokenBucket(FETCH_ASSET_RATE_CAPACITY, FETCH_ASSET_RATE_REFILL_MS),
      gate: createConcurrencyGate(FETCH_ASSET_MAX_CONCURRENT),
      maxBytes: tuning.maxBytes ?? FETCH_ASSET_MAX_BYTES,
      timeoutMs: tuning.timeoutMs ?? FETCH_ASSET_TIMEOUT_MS,
      accept: ASSET_ACCEPT,
      busy: '资源抓取并发已满',
    },
  }

  r.post('/', async (c) => {
    const user = c.get('user')

    // 先读 body 才知道该扣哪个桶。这不违反"被限流的请求不做解析工作":body 上限 4KB、
    // 且已过 requireSession,解析成本恒定;而**解析不出 kind 的请求一律记在 page 账上**,
    // 保证"畸形请求同样消耗令牌"的原有语义不变(限流用例依赖它)。
    const parsed = await readBody(c)
    const kind: FetchKind = parsed.ok ? parsed.body.kind : 'page'
    const limit = limits[kind]

    const taken = limit.bucket.take(user.id)
    if (!taken.ok) {
      c.header('Retry-After', String(Math.ceil(taken.retryAfterMs / 1000)))
      return apiError(c, 429, 'rate-limited', '抓取请求过于频繁')
    }
    if (!limit.gate.tryAcquire(user.id)) {
      c.header('Retry-After', '5')
      return apiError(c, 429, 'rate-limited', limit.busy)
    }

    try {
      if (!parsed.ok) {
        return apiError(c, parsed.status, 'invalid-input', parsed.message)
      }
      const body: FetchUrlBody = parsed.body

      const checked = validateTargetUrl(body.url)
      if (!checked.ok) {
        return apiError(c, checked.code === 'fetch-denied' ? 403 : 400, checked.code, checked.message)
      }

      let result
      try {
        result = await safeFetchUrl(checked.url.toString(), {
          maxBytes: limit.maxBytes,
          timeoutMs: limit.timeoutMs,
          accept: limit.accept,
          transport: tuning.transport,
          lookup: tuning.lookup,
          allowForbiddenAddresses: deps.config.fetchUrlAllowForbiddenDev,
          // 客户端断开(前端取消导入/关页)即中止上游抓取,并发名额随下面的 finally 立刻归还;
          // 否则用户取消后马上再导一篇会撞上自己上一次还没抓完的请求,被 429 拒掉
          signal: c.req.raw.signal,
        })
      } catch (e) {
        if (e instanceof FetchDeniedError) return apiError(c, 403, 'fetch-denied', e.message)
        if (e instanceof FetchTooLargeError) return apiError(c, 413, 'fetch-too-large', e.message)
        if (e instanceof FetchFailedError) return apiError(c, 502, 'fetch-failed', e.message)
        throw e
      }

      const { mediaType, charset } = parseContentType(result.contentType)
      const finalType = resolveMediaType(kind, mediaType, result.bytes)
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
      limit.gate.release(user.id)
    }
  })

  return r
}
