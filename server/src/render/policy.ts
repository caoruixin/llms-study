/**
 * 渲染期间"页面发出的每一个请求怎么处置"的**纯逻辑**:放行去抓 / 直接拒 / 用占位图兑现,外加预算记账。
 *
 * 为什么单独成文件且不碰 playwright:这是渲染服务的安全边界之一,必须能用真值表把每条规则钉死;
 * 而 browser.ts 里的路由处理器只做"问这里 → 照办"。
 *
 * 这里**不**判 URL 的主机/端口/内网归属——那是 safeFetchHop / validateTargetUrl 的职责,
 * 逐跳、连同 DNS 结果一起判;在这里再抄一份只会得到两份会漂移的规则。本文件只管
 * "这类请求值不值得、该不该发出去":方法、协议、资源类型、预算。
 */
import {
  FETCH_ASSET_MAX_BYTES,
  RENDER_URL_MAX_SUBREQUESTS,
  RENDER_URL_MAX_TOTAL_BYTES,
  RENDER_URL_SUBREQUEST_CONCURRENCY,
  RENDER_URL_SUBREQUEST_TIMEOUT_MS,
} from '../../../shared/apiRoutes.js'

export interface RenderLimits {
  /** 一次渲染最多放行多少个真实出网的请求(含主文档与每一跳重定向;占位图不出网,不计) */
  maxSubrequests: number
  /** 一次渲染全部响应字节之和的上限 */
  maxTotalBytes: number
  /** 单个响应的字节上限 */
  maxResourceBytes: number
  /** 单个请求(单跳)的超时 */
  subrequestTimeoutMs: number
  /** 同时在途的出网请求数 */
  concurrency: number
}

export const DEFAULT_RENDER_LIMITS: RenderLimits = {
  maxSubrequests: RENDER_URL_MAX_SUBREQUESTS,
  maxTotalBytes: RENDER_URL_MAX_TOTAL_BYTES,
  maxResourceBytes: FETCH_ASSET_MAX_BYTES,
  subrequestTimeoutMs: RENDER_URL_SUBREQUEST_TIMEOUT_MS,
  concurrency: RENDER_URL_SUBREQUEST_CONCURRENCY,
}

/** 一次渲染的预算账本:每次渲染新建一份,渲染结束即弃 */
export interface RenderBudget {
  readonly limits: RenderLimits
  /** 已放行出网的请求数 */
  requests: number
  /** 已收到的响应字节累计 */
  bytes: number
}

export function createBudget(limits: RenderLimits = DEFAULT_RENDER_LIMITS): RenderBudget {
  return { limits, requests: 0, bytes: 0 }
}

export type AbortReason =
  | 'method' // 非 GET
  | 'bad-url' // 解析不出来的 URL
  | 'scheme' // 非 http(s)
  | 'resource-type' // 渲染正文用不着的资源类型
  | 'subframe' // 子框架文档
  | 'budget-requests' // 请求数预算耗尽
  | 'budget-bytes' // 字节预算耗尽

export type RequestDecision =
  | { action: 'fetch' }
  | { action: 'abort'; reason: AbortReason }
  | { action: 'placeholder-image' }

export interface RenderRequestInfo {
  method: string
  url: string
  /** playwright 的 request.resourceType():document/stylesheet/image/media/font/script/xhr/fetch/... */
  resourceType: string
  /** 是否是一次导航(主框架或子框架的文档请求) */
  isNavigationRequest: boolean
  /**
   * 发起请求的是否是主框架。只有**明确为 false** 才触发子框架规则;拿不到(undefined)就不触发——
   * 它只是一条省内存的规则,不是安全边界(子框架的请求放行了也照样逐个过 safeFetchHop)
   */
  isMainFrame?: boolean
  budget: RenderBudget
}

/**
 * 直接拒绝的资源类型:对"把正文渲染出来"没有贡献,却各有各的代价——
 * - media:体积无上限的流;
 * - font:捕获只要 DOM 与计算样式,字体由客户端快照管线自己抓;
 * - ping / eventsource / websocket:上报与长连接,后两者还会让页面永远不静默;
 * - manifest / texttrack:用不着。
 * websocket 实际不会进 context.route(它不走 Fetch 拦截),列在这里是"万一哪个版本开始送进来"的兜底;
 * 真正挡住它的是 browser.ts 里那个指向死端口的代理。
 */
const ABORT_RESOURCE_TYPES = new Set([
  'media',
  'font',
  'ping',
  'manifest',
  'eventsource',
  'texttrack',
  'websocket',
])

/**
 * 处置一个请求。**纯函数**:只读预算、不记账——记账由调用方在真正出网时调 chargeRequest/chargeBytes,
 * 这样"判定"与"副作用"分开,真值表测试不必关心调用顺序。
 */
export function decideRequest(info: RenderRequestInfo): RequestDecision {
  // 只读通道:POST/PUT 要么是上报要么是表单提交,渲染一篇公开文章不需要替页面往外写任何东西。
  // (CORS 预检的 OPTIONS 走不到这里:拦截开启时 playwright 自己用 204 + 宽松的 CORS 头应答预检,
  //  随后的真实请求才会进来;万一哪个版本开始把预检也送进来,它同样落在这条规则上)
  if (info.method.toUpperCase() !== 'GET') return { action: 'abort', reason: 'method' }

  let protocol: string
  try {
    protocol = new URL(info.url).protocol
  } catch {
    return { action: 'abort', reason: 'bad-url' }
  }
  // data:/blob: 由浏览器内部兑现,根本不会走到路由;真走到这里的非 http(s) 只可能是
  // file:/chrome:/ftp:/ws(s): 这类——一律拒,不给"读本机文件/浏览器内部页"留任何口子
  if (protocol !== 'http:' && protocol !== 'https:') return { action: 'abort', reason: 'scheme' }

  if (ABORT_RESOURCE_TYPES.has(info.resourceType)) return { action: 'abort', reason: 'resource-type' }

  // 图片用占位图**兑现**而不是拒绝:拒绝会触发 <img onerror>,很多站点在那里把图片隐藏/换成
  // 兜底图,捕获到的 DOM 就和读者看到的不一样了。真图片由客户端事后经自己的资源通道抓,
  // 这里出网抓一遍纯属浪费预算。不出网,所以排在预算检查之前、也不记账
  if (info.resourceType === 'image') return { action: 'placeholder-image' }

  // 子框架文档:捕获代理序列化时本来就整个丢掉 iframe(DROP_SELECTOR),加载它只有成本——
  // 跨站 iframe 在站点隔离下是**又一个渲染进程**,小机器的内存经不起广告/评论框这么花
  if (info.isNavigationRequest && info.isMainFrame === false) {
    return { action: 'abort', reason: 'subframe' }
  }

  const { budget } = info
  if (budget.requests >= budget.limits.maxSubrequests) {
    return { action: 'abort', reason: 'budget-requests' }
  }
  if (budget.bytes >= budget.limits.maxTotalBytes) return { action: 'abort', reason: 'budget-bytes' }

  return { action: 'fetch' }
}

/** 记一次出网请求(在真正调用 safeFetchHop 之前调) */
export function chargeRequest(budget: RenderBudget): void {
  budget.requests += 1
}

/**
 * 这一个响应最多还能收多少字节:单资源上限与"总预算剩余"取小。
 *
 * 并发在途的请求各自按**发起当时**的剩余量领上限,所以总字节最坏会超出预算
 * `(并发数 - 1) × 单资源上限`。不做预留式精确记账:预留会让头几个并发请求各占 8MB 名额、
 * 把后面的小文件饿死。这个上界是常数,足以当内存峰值的保证用。
 */
export function grantBytes(budget: RenderBudget): number {
  return Math.max(0, Math.min(budget.limits.maxResourceBytes, budget.limits.maxTotalBytes - budget.bytes))
}

/** 记一个响应的实收字节 */
export function chargeBytes(budget: RenderBudget, n: number): void {
  budget.bytes += Math.max(0, n)
}

/**
 * 出站 Accept:按资源类型表态。不转发页面自己设的 accept——那是不可信输入,
 * 这条通道除了 accept 之外的出站头本来就恒定。返回 undefined = 用 safeFetchHop 的正文默认值。
 */
export function acceptFor(resourceType: string): string | undefined {
  switch (resourceType) {
    case 'document':
      return undefined
    case 'stylesheet':
      return 'text/css,*/*;q=0.1'
    case 'xhr':
    case 'fetch':
      return 'application/json,text/plain,*/*'
    default:
      // script 与其它:浏览器对脚本发的就是 */*
      return '*/*'
  }
}

/** media type 与 charset 的字符集白名单:上游头是不可信输入,原样写回响应头前必须收口(防头注入) */
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/
const CHARSET_RE = /^[A-Za-z0-9._-]{1,40}$/

/**
 * 上游 content-type → 可以安全写回浏览器的值;解析不出合法 media type 就返回 null(不发这个头,
 * 让浏览器按它对真实网络同样的规则处置——例如模块脚本没有 JS MIME 就是不执行,我们不替上游"猜一个")。
 * 只保留 media type 与 charset,boundary 等其余参数一律丢弃。
 */
export function sanitizeContentType(raw: string | null | undefined): string | null {
  if (!raw) return null
  const [first, ...params] = raw.split(';')
  const mediaType = first.trim().toLowerCase()
  if (!MEDIA_TYPE_RE.test(mediaType)) return null
  let charset: string | null = null
  for (const p of params) {
    const m = /^\s*charset\s*=\s*"?([^";]+)"?\s*$/i.exec(p)
    if (m && CHARSET_RE.test(m[1].trim())) charset = m[1].trim().toLowerCase()
  }
  return charset ? `${mediaType}; charset=${charset}` : mediaType
}

/** 主文档必须是 HTML:PDF/zip 之类在无头浏览器里只会变成一次下载,渲染不出任何东西 */
export function isHtmlContentType(sanitized: string | null): boolean {
  if (!sanitized) return false
  const mediaType = sanitized.split(';')[0]
  return mediaType === 'text/html' || mediaType === 'application/xhtml+xml'
}

/**
 * 给兑现的响应合成 CORS 头:回显请求的 Origin(没有就 `*`)。
 *
 * 为什么可以这么大方:这个浏览器上下文是一次性的,不带任何 cookie/凭据,跨源读到的只是
 * "任何人匿名 GET 都能拿到的字节"。而不合成不行——纯客户端渲染的页面,入口
 * `<script type="module" crossorigin>` 永远按 CORS 取,资源站不回 access-control-* 头,
 * 模块就整个不执行(这正是 Tier 2 渲染不出来的原因;我们兑现时又丢掉了上游全部响应头)。
 * allow-credentials:true 是因为 `crossorigin="use-credentials"` 的请求要求它;vary 防缓存串味。
 */
export function corsHeaders(requestOrigin: string | undefined): Record<string, string> {
  // Origin 头由浏览器生成,形状固定;仍收口字符集,不合规就退回 `*`
  const origin =
    requestOrigin && /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9.\-[\]:]{1,255}$/.test(requestOrigin)
      ? requestOrigin
      : requestOrigin === 'null'
        ? 'null'
        : '*'
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    vary: 'origin',
  }
}
