/**
 * 请求体校验:JSON 解析失败与 schema 不符统一回 400 invalid-input。
 * 返回 discriminated union 而非抛异常——路由里一行 early return,类型自然收窄。
 */
import type { Context } from 'hono'
import type { ZodType } from 'zod'
import { apiError } from './respond.js'

export type ParsedBody<T> = { ok: true; data: T } | { ok: false; res: Response }

export async function readJson<T>(c: Context, schema: ZodType<T>): Promise<ParsedBody<T>> {
  const raw: unknown = await c.req.json().catch(() => undefined)
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const detail = first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'invalid body'
    return { ok: false, res: apiError(c, 400, 'invalid-input', detail) }
  }
  return { ok: true, data: parsed.data }
}
