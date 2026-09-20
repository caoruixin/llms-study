import { APP_API_PREFIX } from '../../../../shared/apiRoutes'
import type { ApiError, RenderUrlBody, RenderUrlResponse } from '../../../../shared/apiTypes'
import { ApiRequestError, type ApiFailureCode } from '../../auth/apiClient'

/**
 * POST /api/app/render-url 客户端：网页原貌的 Tier 3（服务端无头浏览器渲染兜底）。
 *
 * 只在本地两层（浏览器内渲染捕获 + 静态捕获）都拿不到正文时才会被 buildSnapshot 调到——典型是
 * 正文全在 JS 包里、而模块脚本又被浏览器跨源策略拦掉的纯客户端渲染页面。它是部署上的**可选项**：
 * 没装渲染服务的部署回 503 `render-unavailable`，还没升级的老服务端回 404；两者对前端是一回事
 * ——「这里没有这项能力」，归一成同一个错误码，由 buildSnapshot 落回如实报错，而不是当成故障。
 */

export interface RenderUrlOptions {
  /** 取消信号：导入中途放弃时立刻断开请求；服务端据此中止这次渲染，把全站唯一的渲染名额让出来 */
  signal?: AbortSignal
}

/** 错误码 → 中文文案：这些会拼进「；服务器渲染：…」接在失败说明后面，所以都是短语，不带句号 */
const ERROR_MESSAGES: Partial<Record<ApiFailureCode, string>> = {
  'render-unavailable': '本部署未启用',
  'fetch-denied': '该地址不允许抓取（内网或受限目标）',
  'fetch-failed': '页面无法访问或渲染超时',
  'fetch-too-large': '渲染结果超过大小上限',
  'rate-limited': '渲染请求过于频繁或正被占用，请稍后重试',
  'invalid-input': '链接格式不合法',
  unauthenticated: '登录状态已失效，请重新登录后重试',
  forbidden: '没有权限执行该操作',
  'account-disabled': '账号已被禁用',
  network: '网络错误',
}

export async function renderUrl(url: string, opts: RenderUrlOptions = {}): Promise<RenderUrlResponse> {
  const body: RenderUrlBody = { url }
  let res: Response
  try {
    res = await fetch(APP_API_PREFIX + '/render-url', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    })
  } catch (e) {
    // 主动取消不是故障：原样抛出 AbortError，buildSnapshot 据此整体收尾而不是记一笔「服务器渲染失败」
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
    // 404 = 老服务端根本没有这条路由（nginx / Hono 的兜底 404 也未必是我们的 JSON 形状）
    const code: ApiFailureCode = res.status === 404 ? 'render-unavailable' : (payload?.error ?? 'internal')
    throw new ApiRequestError(code, ERROR_MESSAGES[code] ?? payload?.message ?? `渲染失败（${res.status}）`, res.status)
  }

  let data: RenderUrlResponse
  try {
    data = (await res.json()) as RenderUrlResponse
  } catch {
    throw new ApiRequestError('internal', '渲染结果不是合法的 JSON')
  }
  // 服务端已按 schema 校验过；这里只挡住「形状完全不对」，HTML 本身稍后照常过原貌净化
  if (!data || typeof data.html !== 'string' || typeof data.finalUrl !== 'string') {
    throw new ApiRequestError('internal', '渲染结果缺少必要字段')
  }
  return data
}
