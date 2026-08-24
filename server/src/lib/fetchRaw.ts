/**
 * 受控出网抓取:把"取回一个 URL 的字节"这件事收敛成一条带 SSRF 防线的窄通道。
 *
 * 为什么不用全局 fetch(undici):
 * 1. 无法在建连时钉住已校验的 IP —— 域名会被底层重新解析,留下 DNS-rebinding 窗口
 *    (校验时解析到公网 IP,建连时解析到 127.0.0.1);
 * 2. 重定向由内部处理,拿不到逐跳的 URL 去重跑校验。
 * 所以这里用 node:http/https.request + 自定义 lookup:**校验用的解析结果与建连用的
 * 是同一份**,中间不给第二次解析留缝;重定向手动跟随,每跳完整重验。
 *
 * 字节上限双闸(Content-Length 预检 + 实读累计)与总超时预算跨跳共享,
 * 保证"最坏情况占用的内存与时间"是常数,不随重定向次数放大。
 */
import type { LookupAddress } from 'node:dns'
import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import zlib from 'node:zlib'
import {
  FETCH_URL_MAX_BYTES,
  FETCH_URL_MAX_REDIRECTS,
  FETCH_URL_TIMEOUT_MS,
} from '../../../shared/apiRoutes.js'
import { isForbiddenAddress, parseIpLiteral, validateTargetUrl } from './ssrf.js'

/** 抓取被安全策略拒绝(内网地址、非法跳转目标…)→ 路由映射 403 */
export class FetchDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FetchDeniedError'
  }
}

/** 抓取内容超过字节上限(声明的或实读的)→ 路由映射 413 */
export class FetchTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FetchTooLargeError'
  }
}

/** 抓取失败(连接/超时/上游 4xx-5xx/重定向过多)→ 路由映射 502 */
export class FetchFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FetchFailedError'
  }
}

export interface ResolvedAddress {
  address: string
  family: number
}

/** DNS 注入口(测试用):语义等价 dns.promises.lookup(host, { all: true }) */
export type FetchLookup = (hostname: string) => Promise<ResolvedAddress[]>

export interface FetchTransportRequest {
  /** 目标 URL:决定协议、Host 头、path 与 TLS servername */
  url: URL
  /** 已通过禁区校验的目标 IP——建连只认它,不再解析域名 */
  address: string
  family: number
  port: number
  headers: Record<string, string>
  maxBytes: number
  timeoutMs: number
}

export interface FetchTransportResponse {
  status: number
  /** 小写键;多值头只取第一个(我们关心的 content-type/length/encoding 与 location 都是单值) */
  headers: Record<string, string | undefined>
  /** 原始字节,可能仍是压缩的(解压在上层做,便于统一计量) */
  bytes: Buffer
}

/** 建连收字节层注入口(测试用):替换它就能把请求打到本机 stub 而不必放宽禁区校验 */
export type FetchTransport = (req: FetchTransportRequest) => Promise<FetchTransportResponse>

export interface SafeFetchOptions {
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  transport?: FetchTransport
  lookup?: FetchLookup
  /**
   * 【仅本机开发】跳过"域名解析结果落禁区"检查(config.fetchUrlAllowForbiddenDev 透传)。
   * fake-IP DNS 环境里所有公网域名都解析进 198.18/15,不跳过则寸步难行;
   * 字面 IP 的 URL 仍在 validateTargetUrl 被拒,其余防线(端口/重定向/限额)全部保留。
   */
  allowForbiddenAddresses?: boolean
}

export interface SafeFetchResult {
  bytes: Buffer
  contentType: string | null
  /** 重定向后的最终 URL:客户端做相对链接绝对化的基准 */
  finalUrl: string
}

/**
 * 出站头:最小集。不带任何 cookie/authorization/referer——
 * 这条通道是"代用户读公开网页",绝不能替用户出示任何身份。
 * Accept-Encoding 显式 identity:压缩流会让"实读字节"与"解压后字节"脱钩,
 * 能不压就不压(仍压缩的上游由 zlib 兜底,解压后同受上限约束)。
 */
const OUTBOUND_HEADERS: Record<string, string> = {
  'user-agent': 'llm-pro.cn paper-copilot/1.0 (+https://llm-pro.cn)',
  accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.1',
  'accept-encoding': 'identity',
}

/** 303 语义上要改用 GET,而我们本来就只发 GET,所以四种跳转一视同仁 */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function flattenHeaders(h: http.IncomingHttpHeaders): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(h)) out[k] = Array.isArray(v) ? v[0] : v
  return out
}

/**
 * 默认建连层:node:http(s).request + 钉死 IP 的 lookup。
 * 导出是为了测试可以"包一层改写 address/port"复用真实的字节/超时闸门,
 * 而不是用假 transport 把这层逻辑整个测空。
 */
export function nodeTransport(req: FetchTransportRequest): Promise<FetchTransportResponse> {
  return new Promise<FetchTransportResponse>((resolve, reject) => {
    // node 的 autoSelectFamily 会以 all:true 调用 lookup,两种回调形状都要应答
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      const addr: LookupAddress = { address: req.address, family: req.family }
      if (options.all) callback(null, [addr])
      else callback(null, addr.address, addr.family)
    }

    const mod = req.url.protocol === 'https:' ? https : http
    const request = mod.request({
      protocol: req.url.protocol,
      hostname: req.url.hostname,
      port: req.port,
      path: `${req.url.pathname}${req.url.search}`,
      method: 'GET',
      headers: req.headers,
      lookup: pinnedLookup,
      // 不复用连接池:一次性抓取任意外部主机,socket 常驻只会攒着别人的连接
      agent: false,
      timeout: req.timeoutMs,
    })

    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (): void => {
      settled = true
      if (timer) clearTimeout(timer)
    }
    const fail = (e: Error): void => {
      if (settled) return
      finish()
      request.destroy()
      reject(e)
    }
    const succeed = (v: FetchTransportResponse): void => {
      if (settled) return
      finish()
      resolve(v)
    }
    // 手动总计时:socket timeout 只管"空闲",挡不住"每秒吐一个字节"的慢速拖延
    timer = setTimeout(() => fail(new FetchFailedError('抓取超时')), req.timeoutMs)

    request.on('timeout', () => fail(new FetchFailedError('抓取超时')))
    request.on('error', (e) => fail(new FetchFailedError(`连接失败:${errMsg(e)}`)))
    request.on('response', (res) => {
      const declared = Number(res.headers['content-length'])
      // 预检:能在读 body 之前拒掉的,绝不白读 20MB
      if (Number.isFinite(declared) && declared > req.maxBytes) {
        res.destroy()
        fail(new FetchTooLargeError(`目标内容声明 ${declared} 字节,超过上限`))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        // 实读累计兜底:Content-Length 可以缺失,也可以说谎
        if (total > req.maxBytes) {
          res.destroy()
          fail(new FetchTooLargeError('目标内容超过大小上限'))
          return
        }
        chunks.push(chunk)
      })
      res.on('error', (e) => fail(new FetchFailedError(`读取响应失败:${errMsg(e)}`)))
      res.on('end', () =>
        succeed({
          status: res.statusCode ?? 0,
          headers: flattenHeaders(res.headers),
          bytes: Buffer.concat(chunks),
        }),
      )
    })
    request.end()
  })
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  const all = await dnsLookup(hostname, { all: true })
  return all.map((a) => ({ address: a.address, family: a.family }))
}

const isTooLargeCode = (e: unknown): boolean =>
  (e as NodeJS.ErrnoException | null)?.code === 'ERR_BUFFER_TOO_LARGE'

/**
 * 兜底解压:我们要了 identity,但确实有上游无视 Accept-Encoding 照压不误。
 * maxOutputLength 让"解压炸弹"在超过上限的那一刻就抛错,而不是先撑爆内存再判。
 */
function decompress(bytes: Buffer, encoding: string | undefined, maxBytes: number): Buffer {
  const enc = (encoding ?? '').trim().toLowerCase()
  if (enc === '' || enc === 'identity') return bytes
  const limit = { maxOutputLength: maxBytes }
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(bytes, limit)
    if (enc === 'br') return zlib.brotliDecompressSync(bytes, limit)
    if (enc === 'deflate') {
      try {
        return zlib.inflateSync(bytes, limit)
      } catch (e) {
        // 部分上游发的是裸 deflate(无 zlib 头),换 raw 再试一次;超限错误不重试
        if (isTooLargeCode(e)) throw e
        return zlib.inflateRawSync(bytes, limit)
      }
    }
  } catch (e) {
    if (isTooLargeCode(e)) throw new FetchTooLargeError('解压后内容超过大小上限')
    throw new FetchFailedError(`响应解压失败:${errMsg(e)}`)
  }
  throw new FetchFailedError(`不支持的响应压缩方式:${enc}`)
}

/**
 * 安全抓取一个 URL:逐跳校验 + 钉死 IP 建连 + 双闸限量,返回原始字节。
 * 内容类型的放行判断留给调用方(路由)——这里只负责"安全地把字节取回来"。
 */
export async function safeFetchUrl(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? FETCH_URL_MAX_BYTES
  const timeoutMs = opts.timeoutMs ?? FETCH_URL_TIMEOUT_MS
  const maxRedirects = opts.maxRedirects ?? FETCH_URL_MAX_REDIRECTS
  const transport = opts.transport ?? nodeTransport
  const lookup = opts.lookup ?? defaultLookup
  // 总预算跨跳共享:否则 3 跳重定向能把 20s 变成 80s
  const deadline = Date.now() + timeoutMs

  let current = rawUrl
  for (let hop = 0; ; hop++) {
    // 每跳都重跑全套校验:重定向目标是上游说了算的,和用户最初输入的 URL 一样不可信。
    // 首跳的这次是纵深防御(路由已先校验过一遍,故这里统一按 denied 抛)
    const checked = validateTargetUrl(current)
    if (!checked.ok) throw new FetchDeniedError(checked.message)
    const url = checked.url

    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new FetchFailedError('抓取超时')

    // 解析出地址并逐个过禁区:任一结果落禁区就整体拒绝(不挑一个"看着安全的"用,
    // 那样等于让攻击者用一条 A 记录多值就能试探)
    let target: ResolvedAddress
    const literal = parseIpLiteral(url.hostname)
    if (literal) {
      target = { address: literal.address, family: literal.family }
    } else {
      let resolved: ResolvedAddress[]
      try {
        resolved = await lookup(url.hostname)
      } catch (e) {
        throw new FetchFailedError(`域名解析失败:${errMsg(e)}`)
      }
      if (resolved.length === 0) throw new FetchFailedError('域名无法解析')
      if (!opts.allowForbiddenAddresses) {
        for (const r of resolved) {
          if (isForbiddenAddress(r.address)) {
            throw new FetchDeniedError('目标地址指向内网或保留地址')
          }
        }
      }
      target = resolved[0]
    }

    const res = await transport({
      url,
      address: target.address,
      family: target.family,
      port: url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
      headers: OUTBOUND_HEADERS,
      maxBytes,
      timeoutMs: remaining,
    })

    if (REDIRECT_STATUS.has(res.status)) {
      const location = res.headers.location
      if (!location) throw new FetchFailedError(`上游返回 ${res.status} 但缺少 Location`)
      if (hop >= maxRedirects) throw new FetchFailedError(`重定向超过 ${maxRedirects} 跳`)
      try {
        // 相对 Location 必须以当前跳的 URL 为基准解析
        current = new URL(location, url).toString()
      } catch {
        throw new FetchFailedError('重定向目标不是合法 URL')
      }
      continue
    }
    if (res.status < 200 || res.status >= 300) {
      // 上游状态原样带进 message:用户排查"是不是要登录/被墙"时这是唯一有用的信息
      throw new FetchFailedError(`上游返回 ${res.status}`)
    }
    return {
      bytes: decompress(res.bytes, res.headers['content-encoding'], maxBytes),
      contentType: res.headers['content-type'] ?? null,
      finalUrl: url.toString(),
    }
  }
}
