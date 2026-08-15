/**
 * 本地 HTTP stub 上游:网关测试用。真实起端口(127.0.0.1:0)而非 mock fetch——
 * 网关的转发/流式/重试走的是真 undici 网络路径,mock 会把最容易出错的一层测空。
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface StubRequest {
  path: string
  /** 入站 Authorization 头(网关注入的 Bearer key) */
  auth: string | null
  /** 入站 X-User-Key(网关必须 strip,断言应恒为 null) */
  userKey: string | null
  contentType: string | null
  body: string
}

export type StubResponder = (req: StubRequest, res: ServerResponse) => void

export interface UpstreamStub {
  url: string
  requests: StubRequest[]
  /** 替换响应逻辑;默认 200 {"ok":true} */
  respond(fn: StubResponder): void
  /** 挂起中的响应(SSE 并发测试用):调用 endHeld 统一收尾 */
  hold(res: ServerResponse): void
  endHeld(): void
  close(): Promise<void>
}

export async function startUpstreamStub(): Promise<UpstreamStub> {
  const requests: StubRequest[] = []
  const held: ServerResponse[] = []
  let responder: StubResponder = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const sr: StubRequest = {
        path: req.url ?? '',
        auth: req.headers.authorization ?? null,
        userKey: (req.headers['x-user-key'] as string | undefined) ?? null,
        contentType: req.headers['content-type'] ?? null,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(sr)
      responder(sr, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    url,
    requests,
    respond(fn) {
      responder = fn
    },
    hold(res) {
      held.push(res)
    },
    endHeld() {
      for (const res of held.splice(0)) res.end()
    },
    close() {
      for (const res of held.splice(0)) res.destroy()
      return new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
  }
}
