import { APP_API_PREFIX } from '../../../shared/apiRoutes'
import type {
  AdminUpdateUserBody,
  AdminUser,
  ApiError,
  ApiErrorCode,
  ChangePasswordBody,
  CreateInviteBody,
  InviteCode,
  LlmProvider,
  LoginBody,
  MeResponse,
  OkResponse,
  PutLlmKeyResponse,
  RegisterBody,
} from '../../../shared/apiTypes'

/**
 * 账号域 API 客户端：同源 fetch 薄封装。
 * - cookie 鉴权：credentials 同源自动携带，前端永远不接触 session id；
 * - 错误归一：非 2xx 一律抛 ApiRequestError（code 来自服务端 {error,message}），
 *   fetch 本身失败（断网/DNS）归一为 code='network'——调用方只 switch code，
 *   不需要区分「HTTP 错误」与「网络错误」两套异常形态。
 */

/** 服务端错误码 ∪ 'network'（请求未送达，与任何 HTTP 状态互斥） */
export type ApiFailureCode = ApiErrorCode | 'network'

export class ApiRequestError extends Error {
  code: ApiFailureCode
  /** 仅 HTTP 错误携带；network 错误没有状态码 */
  status?: number
  constructor(code: ApiFailureCode, message: string, status?: number) {
    super(message)
    this.code = code
    if (status !== undefined) this.status = status
  }
}

interface ApiFetchInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** 传了就 JSON.stringify 并带 Content-Type；method 缺省时有 body = POST、无 body = GET */
  body?: unknown
}

export async function apiFetch<T>(path: string, init: ApiFetchInit = {}): Promise<T> {
  const hasBody = init.body !== undefined
  let res: Response
  try {
    res = await fetch(APP_API_PREFIX + path, {
      method: init.method ?? (hasBody ? 'POST' : 'GET'),
      // 同源默认即携带 cookie，显式写出以表意图（session cookie 是唯一鉴权凭据）
      credentials: 'same-origin',
      ...(hasBody
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }
        : {}),
    })
  } catch (e) {
    throw new ApiRequestError('network', `网络错误：${(e as Error).message}`)
  }
  if (!res.ok) {
    // 服务端约定所有非 2xx 都是 {error, message?}；解析失败（网关 502 纯文本等）兜底 internal
    let payload: ApiError | null = null
    try {
      payload = (await res.json()) as ApiError
    } catch {
      payload = null
    }
    throw new ApiRequestError(
      payload?.error ?? 'internal',
      payload?.message ?? `请求失败（${res.status}）`,
      res.status,
    )
  }
  return (await res.json()) as T
}

/** 账号域各端点：路径与 server/src/routes 一一对应（前缀出自 shared/apiRoutes） */
export const authApi = {
  me: () => apiFetch<MeResponse>('/auth/me'),
  login: (body: LoginBody) => apiFetch<MeResponse>('/auth/login', { body }),
  register: (body: RegisterBody) => apiFetch<MeResponse>('/auth/register', { body }),
  logout: () => apiFetch<OkResponse>('/auth/logout', { method: 'POST' }),
  changePassword: (body: ChangePasswordBody) => apiFetch<OkResponse>('/auth/change-password', { body }),
  putLlmKey: (provider: LlmProvider, key: string) =>
    apiFetch<PutLlmKeyResponse>(`/me/llm-keys/${provider}`, { method: 'PUT', body: { key } }),
  deleteLlmKey: (provider: LlmProvider) =>
    apiFetch<OkResponse>(`/me/llm-keys/${provider}`, { method: 'DELETE' }),
  adminCreateInvite: (body: CreateInviteBody) => apiFetch<InviteCode>('/admin/invites', { body }),
  adminInvites: () => apiFetch<InviteCode[]>('/admin/invites'),
  adminUsers: () => apiFetch<AdminUser[]>('/admin/users'),
  adminUpdateUser: (id: number, body: AdminUpdateUserBody) =>
    apiFetch<AdminUser>(`/admin/users/${id}`, { method: 'PATCH', body }),
}
