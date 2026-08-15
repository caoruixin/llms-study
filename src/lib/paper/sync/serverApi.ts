import { APP_API_PREFIX } from '../../../../shared/apiRoutes'
import type {
  DeletePaperResponse,
  FilePutResponse,
  SyncChangesResponse,
  SyncPushChange,
  SyncPushResponse,
  SyncSnapshotResponse,
} from '../../../../shared/apiTypes'
import { ApiRequestError, apiFetch } from '../../auth/apiClient'

/**
 * 同步域类型化客户端。JSON 端点复用 auth/apiClient 的 apiFetch（cookie 同源、
 * 错误归一为 ApiRequestError——引擎只 switch code）；文件端点是 raw bytes，
 * 用原始 fetch（PUT 带 X-File-Sha256，GET 读 ETag）。
 */

export interface FetchedFile {
  bytes: ArrayBuffer
  mime: string
  /** 来自 ETag（内容寻址 = sha256），写回本地时可与 papers.sha256 对账 */
  sha256: string | null
}

export const syncApi = {
  push: (changes: SyncPushChange[]) => apiFetch<SyncPushResponse>('/sync/push', { body: { changes } }),

  changes: (since: number, opts: { limit?: number; paperId?: string } = {}) => {
    const params = new URLSearchParams({ since: String(since) })
    if (opts.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts.paperId !== undefined) params.set('paperId', opts.paperId)
    return apiFetch<SyncChangesResponse>(`/sync/changes?${params.toString()}`)
  },

  snapshot: () => apiFetch<SyncSnapshotResponse>('/sync/snapshot'),

  deletePaper: (paperId: string) =>
    apiFetch<DeletePaperResponse>(`/sync/papers/${encodeURIComponent(paperId)}`, { method: 'DELETE' }),

  async putFile(paperId: string, bytes: ArrayBuffer, mime: string, sha256: string): Promise<FilePutResponse> {
    let res: Response
    try {
      res = await fetch(`${APP_API_PREFIX}/files/${encodeURIComponent(paperId)}`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': mime || 'application/octet-stream', 'X-File-Sha256': sha256 },
        body: bytes,
      })
    } catch (e) {
      throw new ApiRequestError('network', `网络错误：${(e as Error).message}`)
    }
    if (!res.ok) throw await toApiError(res)
    return (await res.json()) as FilePutResponse
  },

  /** 404（另一端还没推文件）返回 null，其余错误照常抛——调用方好区分「没有」与「失败」 */
  async getFile(paperId: string): Promise<FetchedFile | null> {
    let res: Response
    try {
      res = await fetch(`${APP_API_PREFIX}/files/${encodeURIComponent(paperId)}`, {
        credentials: 'same-origin',
      })
    } catch (e) {
      throw new ApiRequestError('network', `网络错误：${(e as Error).message}`)
    }
    if (res.status === 404) return null
    if (!res.ok) throw await toApiError(res)
    const bytes = await res.arrayBuffer()
    const etag = res.headers.get('etag')
    return {
      bytes,
      mime: res.headers.get('content-type') ?? 'application/octet-stream',
      sha256: etag ? etag.replace(/^W\//, '').replace(/"/g, '') : null,
    }
  },

  /**
   * pagehide/隐藏时的进度兜底推送：keepalive 让请求在页面卸载后仍能送达。
   * 不等待响应也不删队列——服务端覆盖幂等，下次启动重推同一行只是无害重复。
   */
  pushKeepalive(changes: SyncPushChange[]): void {
    try {
      void fetch(`${APP_API_PREFIX}/sync/push`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
        keepalive: true,
      }).catch(() => undefined)
    } catch {
      /* 卸载路径上的任何异常都只能吞掉 */
    }
  },
}

async function toApiError(res: Response): Promise<ApiRequestError> {
  let payload: { error?: string; message?: string } | null = null
  try {
    payload = (await res.json()) as { error?: string; message?: string }
  } catch {
    payload = null
  }
  return new ApiRequestError(
    (payload?.error as ApiRequestError['code']) ?? 'internal',
    payload?.message ?? `请求失败（${res.status}）`,
    res.status,
  )
}
