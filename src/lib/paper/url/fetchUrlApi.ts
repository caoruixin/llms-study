import { APP_API_PREFIX, FETCH_URL_HEADER_FINAL_URL } from '../../../../shared/apiRoutes'
import type { ApiError } from '../../../../shared/apiTypes'
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

/** 错误码 → 中文文案：只在这里维护一份，其余调用方（urlImport.ts / UrlImportDialog）只管 catch 取 message */
const ERROR_MESSAGES: Partial<Record<ApiFailureCode, string>> = {
  'fetch-denied': '该地址不允许抓取（内网或受限目标）',
  'fetch-failed': '抓取失败（目标站点无法访问或超时）',
  'fetch-too-large': '目标内容超过大小上限',
  'unsupported-content': '不支持的内容类型（仅支持网页与 PDF）',
  'rate-limited': '抓取请求过于频繁，请稍后重试',
  'invalid-input': '链接格式不合法',
  unauthenticated: '登录状态已失效，请重新登录后重试',
  forbidden: '没有权限执行该操作',
  'account-disabled': '账号已被禁用',
  network: '网络错误，请检查网络连接后重试',
}

export async function fetchUrl(url: string): Promise<FetchedUrl> {
  let res: Response
  try {
    res = await fetch(APP_API_PREFIX + '/fetch-url', {
      method: 'POST',
      // 同源默认即携带 cookie，显式写出以表意图（session cookie 是唯一鉴权凭据）
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
  } catch (e) {
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
    throw new ApiRequestError(code, ERROR_MESSAGES[code] ?? payload?.message ?? `抓取失败（${res.status}）`, res.status)
  }

  const bytes = await res.arrayBuffer()
  const contentType = res.headers.get('content-type') ?? ''
  const finalUrlHeader = res.headers.get(FETCH_URL_HEADER_FINAL_URL)
  // 服务端用 encodeURI 编码回传（见 fetchUrl.ts 路由注释），对称地 decodeURI 还原
  const finalUrl = finalUrlHeader ? decodeURI(finalUrlHeader) : url
  return { bytes, contentType, finalUrl }
}
