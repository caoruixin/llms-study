/**
 * 服务端渲染兜底:POST /api/app/render-url(网页原貌导入的 Tier 3)。
 *
 * 纯客户端渲染的页面,正文全在 JS 里,而浏览器里的沙箱 iframe(Tier 2)结构上跑不了它的模块脚本;
 * 客户端两级都拿不到正文时才会调到这里,由**另一个进程**里的无头 Chromium 在页面真实源上渲染。
 *
 * 为什么是新路由而不是 fetch-url 的又一种 kind:KindLimits 描述的是"取回一段原始字节"
 * (字节上限、内容类型白名单、出站 accept),渲染的形状完全不同——几十秒、几百 MB、结果是 JSON,
 * 限额维度也不同(全站并发 1,而不是每用户并发)。硬塞进去只会让两边的分支互相污染。
 *
 * 本路由自己**不渲染**,只做三件事:鉴权 + 限流 + 把请求经 unix socket 转给渲染服务
 * (src/render/,独立 systemd unit、独立用户,见 deploy/llms-study-render.service)。
 * Chromium 不在 API 进程里,是因为 API 的 cgroup 只有 512MB、环境里还有 LLM 主密钥。
 *
 * 防滥用三层:每用户令牌桶(频次)→ **全站**并发闸(小机器同时只扛得住一个 Chromium,
 * 满了立刻 429、不排队——排队只会让请求在 nginx 的 60s 里白等)→ 总时长/响应字节上限。
 */
import http from 'node:http'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  FETCH_URL_MAX_LENGTH,
  RENDER_URL_MAX_CONCURRENT_GLOBAL,
  RENDER_URL_MAX_RESPONSE_BYTES,
  RENDER_URL_RATE_CAPACITY,
  RENDER_URL_RATE_REFILL_MS,
  RENDER_URL_TIMEOUT_MS,
} from '../../../shared/apiRoutes.js'
import type { ApiErrorCode, RenderUrlBody } from '../../../shared/apiTypes.js'
import { requireSession } from '../auth/middleware.js'
import { apiError } from '../lib/respond.js'
import { validateTargetUrl } from '../lib/ssrf.js'
import { createConcurrencyGate, createTokenBucket } from '../llm/rateLimit.js'
import type { AppDeps, AppEnv } from '../types.js'

/** 请求体只有一个 URL,4KB 足够宽松;更大的 body 只可能是探测 */
const BODY_MAX_BYTES = 4096

/**
 * API 侧等渲染服务的时长 = 渲染服务自己的墙钟 + 余量。
 * 余量覆盖它超时后关浏览器的那几秒(最多 5s):让**它的**超时先到、由它回一个干净的 502,
 * 我们这个只兜"它彻底不回话"。合计 36s,仍明显低于 nginx 的 60s。
 */
const TIMEOUT_HEADROOM_MS = 6_000

/** 全站闸只有一个名额池,键是常量 */
const GLOBAL_KEY = 'render'

/** 渲染服务回的错误体很小;超过这个数就不是我们认识的错误体,不解析 */
const ERROR_BODY_MAX_BYTES = 8 * 1024

const renderUrlSchema = z.object({
  url: z.string().min(1).max(FETCH_URL_MAX_LENGTH),
})

type BodyResult =
  | { ok: true; body: RenderUrlBody }
  | { ok: false; status: 400 | 413; message: string }

async function readBody(c: Context<AppEnv>): Promise<BodyResult> {
  // 声明超限先拒,绝不把超大 body 读进内存
  const declaredLength = Number(c.req.header('content-length') ?? Number.NaN)
  if (Number.isFinite(declaredLength) && declaredLength > BODY_MAX_BYTES) {
    return { ok: false, status: 413, message: '请求体过大' }
  }
  const raw = await c.req.text()
  if (Buffer.byteLength(raw, 'utf8') > BODY_MAX_BYTES) {
    return { ok: false, status: 413, message: '请求体过大' }
  }
  let parsedRaw: unknown
  try {
    parsedRaw = JSON.parse(raw)
  } catch {
    return { ok: false, status: 400, message: 'body 不是合法 JSON' }
  }
  const parsed = renderUrlSchema.safeParse(parsedRaw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      ok: false,
      status: 400,
      message: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'body 不合法',
    }
  }
  return { ok: true, body: parsed.data }
}

/** 渲染服务调用的结局;路由只负责把它翻译成对前端的响应 */
type ServiceOutcome =
  | { kind: 'response'; status: number; bytes: Buffer; retryAfter: string | null }
  /** socket 不存在/拒绝连接/无权限:渲染服务没在跑(或本进程不在 llmrender 组里) */
  | { kind: 'unreachable' }
  | { kind: 'timeout' }
  | { kind: 'too-large' }
  /** 连上之后断了:多半是渲染服务中途崩溃/被 OOM 杀掉 */
  | { kind: 'broken' }
  | { kind: 'aborted' }

/** 连接阶段的这几种错误 = "服务不在",其余一律算"渲染到一半坏了" */
const UNREACHABLE_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM', 'ENOTSOCK', 'ENOTDIR'])

/**
 * 经 unix socket 调渲染服务。用 node:http 而不是全局 fetch:undici 的 fetch 不支持 socketPath。
 * 响应整块缓冲(受 maxBytes 约束)而不是边收边转:全站并发 1,最坏多占 12MB;
 * 换来的是超限/半截断流都能回一个干净的错误码,而不是给前端一个截断的 200。
 */
function callRenderService(
  socketPath: string,
  body: RenderUrlBody,
  opts: { timeoutMs: number; maxBytes: number; signal: AbortSignal },
): Promise<ServiceOutcome> {
  return new Promise<ServiceOutcome>((resolve) => {
    if (opts.signal.aborted) {
      resolve({ kind: 'aborted' })
      return
    }
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const request = http.request({
      socketPath,
      path: '/render',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
      },
      // 不复用连接:一次一个请求,断开即是给渲染服务的"取消"信号
      agent: false,
    })

    let settled = false
    const finish = (outcome: ServiceOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      // 统一在这里掐连接:超时/超限/取消时,连接一断渲染服务就中止渲染、让出浏览器
      if (outcome.kind !== 'response') request.destroy()
      resolve(outcome)
    }
    const timer = setTimeout(() => finish({ kind: 'timeout' }), opts.timeoutMs)
    // 前端取消导入(或用户关页面)→ 立刻放掉渲染服务,别让一次没人要的渲染占着全站唯一的名额
    const onAbort = (): void => finish({ kind: 'aborted' })
    opts.signal.addEventListener('abort', onAbort, { once: true })

    request.on('error', (e: NodeJS.ErrnoException) => {
      finish({ kind: UNREACHABLE_CODES.has(e.code ?? '') ? 'unreachable' : 'broken' })
    })
    request.on('response', (res) => {
      const status = res.statusCode ?? 0
      const declared = Number(res.headers['content-length'] ?? Number.NaN)
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        res.destroy()
        finish({ kind: 'too-large' })
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        // Content-Length 可以缺失也可以说谎,实读再兜一道
        if (total > opts.maxBytes) {
          res.destroy()
          finish({ kind: 'too-large' })
          return
        }
        chunks.push(chunk)
      })
      res.on('error', () => finish({ kind: 'broken' }))
      // 'aborted'/'close' 而没有 'end' = 响应体没收完
      res.on('close', () => finish({ kind: 'broken' }))
      res.on('end', () => {
        const retryAfter = res.headers['retry-after']
        finish({
          kind: 'response',
          status,
          bytes: Buffer.concat(chunks),
          retryAfter: typeof retryAfter === 'string' && /^\d{1,4}$/.test(retryAfter) ? retryAfter : null,
        })
      })
    })
    request.end(payload)
  })
}

/**
 * 渲染服务的错误码里,允许**原样**转给前端的那几个(状态码也按我们自己的表重新给,不信对方的)。
 * 其余任何东西——500、它自己的 503、认不出的码、解析不了的 body——统一成 503 render-unavailable:
 * 对前端而言都是"这条兜底此刻用不了",回落到如实报错即可。
 */
const PASSTHROUGH: Partial<Record<ApiErrorCode, 400 | 403 | 413 | 502>> = {
  'invalid-input': 400,
  'fetch-denied': 403,
  'fetch-too-large': 413,
  'fetch-failed': 502,
}

function parseServiceError(bytes: Buffer): { error: string; message?: string } | null {
  if (bytes.length > ERROR_BODY_MAX_BYTES) return null
  try {
    const raw: unknown = JSON.parse(bytes.toString('utf8'))
    if (typeof raw !== 'object' || raw === null) return null
    const { error, message } = raw as { error?: unknown; message?: unknown }
    if (typeof error !== 'string') return null
    return { error, message: typeof message === 'string' ? message.slice(0, 300) : undefined }
  } catch {
    return null
  }
}

export function renderUrlRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>()
  r.use('*', requireSession(deps))

  const tuning = deps.renderTuning ?? {}
  const timeoutMs = tuning.timeoutMs ?? RENDER_URL_TIMEOUT_MS + TIMEOUT_HEADROOM_MS
  const maxBytes = tuning.maxResponseBytes ?? RENDER_URL_MAX_RESPONSE_BYTES
  // 限流器随路由实例创建:测试里每个用例一套 app,桶互不串味
  const bucket = createTokenBucket(
    tuning.rateCapacity ?? RENDER_URL_RATE_CAPACITY,
    tuning.rateRefillMs ?? RENDER_URL_RATE_REFILL_MS,
  )
  const gate = createConcurrencyGate(RENDER_URL_MAX_CONCURRENT_GLOBAL)

  r.post('/', async (c) => {
    const user = c.get('user')
    const socketPath = deps.config.renderServiceSocket

    // 功能没开:排在鉴权之后(不向未登录者透露部署形态)、限流之前(不为一个不存在的功能扣令牌)。
    // 前端把 503(以及老后端的 404)都当作"没有这条兜底",回落到如实报错
    if (!socketPath) return apiError(c, 503, 'render-unavailable', '本部署未启用服务端渲染')

    // 先读 body 再扣令牌:与 fetch-url 同一语义——畸形请求同样消耗令牌
    const parsed = await readBody(c)

    const taken = bucket.take(user.id)
    if (!taken.ok) {
      c.header('Retry-After', String(Math.ceil(taken.retryAfterMs / 1000)))
      return apiError(c, 429, 'rate-limited', '渲染请求过于频繁')
    }
    if (!gate.tryAcquire(GLOBAL_KEY)) {
      c.header('Retry-After', '10')
      return apiError(c, 429, 'rate-limited', '服务器正在渲染另一个页面,请稍后再试')
    }

    try {
      if (!parsed.ok) return apiError(c, parsed.status, 'invalid-input', parsed.message)

      // 渲染服务会再验一遍(它不该假设调用方可信);这里先验是为了不把明知会被拒的 URL 送过去
      const checked = validateTargetUrl(parsed.body.url)
      if (!checked.ok) {
        return apiError(c, checked.code === 'fetch-denied' ? 403 : 400, checked.code, checked.message)
      }

      const outcome = await callRenderService(
        socketPath,
        { url: checked.url.toString() },
        { timeoutMs, maxBytes, signal: c.req.raw.signal },
      )

      switch (outcome.kind) {
        case 'unreachable':
          return apiError(c, 503, 'render-unavailable', '渲染服务不可用')
        case 'timeout':
          return apiError(c, 502, 'fetch-failed', '渲染超时')
        case 'too-large':
          return apiError(c, 413, 'fetch-too-large', '渲染结果超过大小上限')
        case 'broken':
          return apiError(c, 502, 'fetch-failed', '渲染中断')
        case 'aborted':
          // 对端已经走了,这个响应没人收;给个语义正确的码,只为日志/测试可读
          return apiError(c, 502, 'fetch-failed', '请求已取消')
      }

      if (outcome.status === 200) {
        // 原样转字节、不重新解析:渲染服务已用 zod 逐字段校验并重新拼过这份 JSON,
        // 在这里再 parse 一遍 8MB 只是阻塞事件循环。上游响应头一个不带,只回我们自己的三个。
        // 转 Uint8Array 的理由同 fetch-url:不把可能是共享内存池切片的 Buffer 直接交出去
        return new Response(new Uint8Array(outcome.bytes), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': String(outcome.bytes.length),
            'Cache-Control': 'no-store',
          },
        })
      }

      const err = parseServiceError(outcome.bytes)
      if (outcome.status === 429) {
        // 渲染服务自己的单飞:正常情况下被上面的全站闸挡在前面,走到这里说明 socket 另有调用方
        c.header('Retry-After', outcome.retryAfter ?? '10')
        return apiError(c, 429, 'rate-limited', '服务器正在渲染另一个页面,请稍后再试')
      }
      const code = err?.error as ApiErrorCode | undefined
      const status = code ? PASSTHROUGH[code] : undefined
      if (code && status) return apiError(c, status, code, err?.message)
      return apiError(c, 503, 'render-unavailable', '渲染服务不可用')
    } finally {
      // 全站名额必须在所有出口归还——包括提前 return 的 400/403 与抛异常路径
      gate.release(GLOBAL_KEY)
    }
  })

  return r
}
