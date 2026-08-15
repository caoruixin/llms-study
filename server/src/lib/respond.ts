/**
 * 错误响应统一出口:所有非 2xx 都是 `{error, message?}`。
 * 集中在一处,保证前端拿到的错误形状永远可 switch。
 */
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiError, ApiErrorCode } from '../../../shared/apiTypes.js'

export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  error: ApiErrorCode,
  message?: string,
): Response {
  const body: ApiError = message ? { error, message } : { error }
  return c.json(body, status)
}
