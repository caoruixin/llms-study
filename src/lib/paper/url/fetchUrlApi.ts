import { APP_API_PREFIX, FETCH_URL_HEADER_FINAL_URL } from '../../../../shared/apiRoutes'
import type { ApiError, FetchUrlBody } from '../../../../shared/apiTypes'
import { ApiRequestError, type ApiFailureCode } from '../../auth/apiClient'

/**
 * POST /api/app/fetch-url 客户端：与 authApi 的其它端点不同，这个响应不是 JSON——
 * 成功时是原始字节 + X-Fetch-Final-Url 头，所以不能复用 apiClient.ts 的 apiFetch
 * （它固定 res.json()），这里手写一份同构的错误归一逻辑。
 */

export interface FetchedUrl {
  bytes: ArrayBuffer
  contentType: string
  finalUrl: string
}

export interface FetchUrlOptions {
  /**
   * `'asset'` = 网页原貌导入的样式表/图片/字体：服务端走独立的令牌桶与并发闸
   * （抓资源不挤占正文导入额度），并放行 css/字体/svg 类型。默认 `'page'`。
   */
  kind?: 'page' | 'asset'
  /** 取消信号：导入中途放弃时立刻断开请求（AbortError 原样抛出，不伪装成网络错误） */
  signal?: AbortSignal
}

/** 错误码 → 中文文案：只在这里维护一份，其余调用方（urlImport.ts / UrlImportDialog）只管 catch 取 message */
const ERROR_MESSAGES: Partial<Record<ApiFailureCode, string>> = {
  'fetch-denied': '该地址不允许抓取（内网或受限目标）',
  'fetch-failed': '抓取失败（目标站点无法访问或超时）',
  'fetch-too-large': '目标内容超过大小上限',
  'unsupported-content': '不支持的内容类型（仅支持网页、PDF、图片，以及原貌导入的样式表与字体）',
  'rate-limited': '抓取请求过于频繁，请稍后重试',
  'invalid-input': '链接格式不合法',
  unauthenticated: '登录状态已失效，请重新登录后重试',
  forbidden: '没有权限执行该操作',
  'account-disabled': '账号已被禁用',
  network: '网络错误，请检查网络连接后重试',
}

/** `Retry-After`（秒）→ 毫秒；缺失/非法一律返回 undefined，由调用方用自己的默认退避 */
function parseRetryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('Retry-After')
  if (!raw) return undefined
  const seconds = Number(raw.trim())
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return Math.round(seconds * 1000)
}

export async function fetchUrl(url: string, opts: FetchUrlOptions = {}): Promise<FetchedUrl> {
  // page 时不带 kind 字段：老服务端的 zod schema 没有这个键，少发一个键就少一处兼容面
  const body: FetchUrlBody = opts.kind === 'asset' ? { url, kind: 'asset' } : { url }
  let res: Response
  try {
    res = await fetch(APP_API_PREFIX + '/fetch-url', {
      method: 'POST',
      // 同源默认即携带 cookie，显式写出以表意图（session cookie 是唯一鉴权凭据）
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    })
  } catch (e) {
    // 主动取消不是故障：原样抛出 AbortError，调用方（资源批量抓取）据此静默收尾
    if ((e as Error | undefined)?.name === 'AbortError') throw e
    throw new ApiRequestError('network', `${ERROR_MESSAGES.network}：${(e as Error).message}`)
  }

  if (!res.ok) {
    let payload: ApiError | null = null
    try {
      payload = (await res.json()) as ApiError
    } catch {
      payload = null
    }
    const code: ApiFailureCode = payload?.error ?? 'internal'
    const err = new ApiRequestError(
      code,
      ERROR_MESSAGES[code] ?? payload?.message ?? `抓取失败（${res.status}）`,
      res.status,
    )
    // 429 才有退避语义：资源批量抓取按它排队重试，其余状态没有 Retry-After 可言
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res)
      if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs
    }
    throw err
  }

  const bytes = await res.arrayBuffer()
  const contentType = res.headers.get('content-type') ?? ''
  const finalUrlHeader = res.headers.get(FETCH_URL_HEADER_FINAL_URL)
  // 服务端用 encodeURI 编码回传（见 fetchUrl.ts 路由注释），对称地 decodeURI 还原
  const finalUrl = finalUrlHeader ? decodeURI(finalUrlHeader) : url
  return { bytes, contentType, finalUrl }
}
