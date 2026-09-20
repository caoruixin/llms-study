/**
 * 渲染服务的 http 层:只听一个 unix socket,`POST /render` + `GET /health`。
 *
 * 为什么是 unix socket 而不是 127.0.0.1 上的端口:本机端口谁都能连(包括被渲染的页面里那些
 * 想方设法打 localhost 的脚本,以及机器上任何其它进程);socket 文件则由文件权限把门——
 * 0660 + 专属用户组,只有被加进 llmrender 组的 API 进程打得开。
 *
 * 渲染器是注入的依赖(types.ts 的 Renderer):这一层的全部分支——入参校验、错误映射、单飞、
 * 断连取消——都用假渲染器测,不起浏览器;本文件因此**不 import browser.ts**。
 */
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs'
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { FETCH_URL_MAX_LENGTH } from '../../../shared/apiRoutes.js'
import type { ApiError, ApiErrorCode, RenderUrlBody } from '../../../shared/apiTypes.js'
import { FetchDeniedError, FetchFailedError, FetchTooLargeError } from '../lib/fetchRaw.js'
import { validateTargetUrl } from '../lib/ssrf.js'
import { RenderLaunchError, type Renderer } from './types.js'

/** 请求体只有一个 URL,4KB 足够宽松(与 API 侧同值) */
const BODY_MAX_BYTES = 4096

const renderSchema = z.object({
  url: z.string().min(1).max(FETCH_URL_MAX_LENGTH),
})

export interface RenderServerDeps {
  renderer: Renderer
  log?: (line: string) => void
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  // 客户端已断开:没有人在听,写了也是白写(还可能在已销毁的 socket 上抛 EPIPE)
  if (res.destroyed || res.writableEnded) return
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(payload)
}

function sendError(
  res: ServerResponse,
  status: number,
  error: ApiErrorCode,
  message?: string,
  extra: Record<string, string> = {},
): void {
  const body: ApiError = message ? { error, message } : { error }
  sendJson(res, status, body, extra)
}

type BodyResult = { ok: true; body: RenderUrlBody } | { ok: false; status: 400 | 413; message: string }

/** 读 + 解析请求体:声明超限先拒,实读再兜底——绝不把超大 body 读进内存 */
function readBody(req: IncomingMessage): Promise<BodyResult> {
  return new Promise<BodyResult>((resolve) => {
    const declared = Number(req.headers['content-length'] ?? Number.NaN)
    if (Number.isFinite(declared) && declared > BODY_MAX_BYTES) {
      req.resume()
      resolve({ ok: false, status: 413, message: '请求体过大' })
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    let over = false
    req.on('data', (chunk: Buffer) => {
      if (over) return
      total += chunk.length
      if (total > BODY_MAX_BYTES) {
        // 不 destroy:还要把 413 写回去。后续字节照收照丢,不再累积
        over = true
        chunks.length = 0
        resolve({ ok: false, status: 413, message: '请求体过大' })
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => resolve({ ok: false, status: 400, message: '读取请求体失败' }))
    req.on('end', () => {
      if (over) return
      let raw: unknown
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        resolve({ ok: false, status: 400, message: 'body 不是合法 JSON' })
        return
      }
      const parsed = renderSchema.safeParse(raw)
      if (!parsed.success) {
        const first = parsed.error.issues[0]
        resolve({
          ok: false,
          status: 400,
          message: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'body 不合法',
        })
        return
      }
      resolve({ ok: true, body: parsed.data })
    })
  })
}

/**
 * 渲染器的错误 → 状态码 + 错误码。与 /api/app/fetch-url 同一套映射,API 侧可以原样转给前端。
 * 错误类的 message 全是我们自己写的固定文案(最多带一个上游状态码),可以回给调用方;
 * 认不出的异常只回 internal,细节不出进程。
 */
function mapError(e: unknown): { status: number; error: ApiErrorCode; message?: string } {
  if (e instanceof FetchDeniedError) return { status: 403, error: 'fetch-denied', message: e.message }
  if (e instanceof FetchTooLargeError) return { status: 413, error: 'fetch-too-large', message: e.message }
  if (e instanceof FetchFailedError) return { status: 502, error: 'fetch-failed', message: e.message }
  if (e instanceof RenderLaunchError) return { status: 503, error: 'render-unavailable', message: e.message }
  return { status: 500, error: 'internal' }
}

export function createRenderServer(deps: RenderServerDeps): Server {
  const log = deps.log ?? ((line: string) => console.log(line))
  /**
   * 单飞:同一时刻只渲染一个页面。API 侧已有全站并发闸,这里再守一道——
   * 这个 socket 的调用方不止 API(运维手工 curl、将来的第二个 API 实例),而内存只有一份。
   * 名额在渲染器 settle 之后才归还(此时浏览器已关干净,见 Renderer 的约定),不是在响应写完时。
   */
  let busy = false

  async function handleRender(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = await readBody(req)
    if (!parsed.ok) return sendError(res, parsed.status, 'invalid-input', parsed.message)

    // 纵深防御:API 已经验过一遍;这里再验是因为本服务不该假设调用方一定是 API。
    // 字面 IP、非 http(s)、非常规端口在**起浏览器之前**就拒掉——快,而且不为一个注定被拒的 URL 付启动成本
    const checked = validateTargetUrl(parsed.body.url)
    if (!checked.ok) {
      return sendError(res, checked.code === 'fetch-denied' ? 403 : 400, checked.code, checked.message)
    }

    if (busy) return sendError(res, 429, 'rate-limited', '已有渲染任务进行中', { 'retry-after': '5' })
    busy = true

    const controller = new AbortController()
    // 调用方断开(用户取消导入、API 侧超时)→ 立刻中止渲染,把浏览器和单飞名额让出来。
    // 'close' 在正常写完响应后也会触发,所以用 writableFinished 区分
    res.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })

    try {
      const result = await deps.renderer(checked.url.toString(), controller.signal)
      sendJson(res, 200, result)
    } catch (e) {
      // 取消:对端已经走了,无处可回
      if (controller.signal.aborted) return
      const mapped = mapError(e)
      if (mapped.status === 500) log(`[render] unexpected error: ${e instanceof Error ? e.name : typeof e}`)
      sendError(res, mapped.status, mapped.error, mapped.message)
    } finally {
      busy = false
    }
  }

  const server = http.createServer((req, res) => {
    // 已发出的响应在对端断开时会 EPIPE:无监听的 'error' 会变成未捕获异常把整个服务带走
    res.on('error', () => {})
    const path = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && path === '/health') return sendJson(res, 200, { ok: true })
    if (req.method === 'POST' && path === '/render') {
      void handleRender(req, res).catch((e: unknown) => {
        log(`[render] handler crashed: ${e instanceof Error ? e.name : typeof e}`)
        sendError(res, 500, 'internal')
      })
      return
    }
    req.resume()
    sendError(res, 404, 'not-found')
  })
  return server
}

/**
 * 在 unix socket 上开始监听。
 * - 先清掉残留的 socket 文件:上次进程被 SIGKILL/OOM 杀掉时不会自己 unlink,留着就 EADDRINUSE。
 *   只删**确实是 socket** 的路径——配置写错指到了普通文件/目录上,宁可启动失败也别删错东西。
 * - 0660:同组(API 进程通过 SupplementaryGroups=llmrender 入组)可连,其余用户不可连。
 *   listen 到 chmod 之间有一个极短的窗口权限取决于 umask,所以目录本身也要收紧
 *   (生产由 RuntimeDirectoryMode=0750 保证,见 deploy/llms-study-render.service)。
 */
export function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket()) {
      throw new Error(`RENDER_SOCKET_PATH 已存在且不是 socket 文件,拒绝覆盖:${socketPath}`)
    }
    unlinkSync(socketPath)
  }
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      try {
        chmodSync(socketPath, 0o660)
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }
      resolve()
    })
  })
}
