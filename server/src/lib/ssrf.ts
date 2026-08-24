/**
 * SSRF 防线的纯逻辑层:地址禁区判定 + 目标 URL 白名单校验。
 *
 * 为什么自己解析而不引第三方库:server 是 512MB 单进程、依赖越少越好,
 * 而这段判定是安全边界——依赖一个会随版本漂移的第三方实现,不如把规则写死在这里、
 * 用测试把禁区矩阵钉住。判定只需"前缀归属",不需要完整的地址运算能力。
 *
 * 设计原则:**fail-closed**。任何解析不出来的形状一律当作禁区,
 * 宁可拒掉一个能访问的公网地址,也不能放过一个内网地址。
 */
import { FETCH_URL_MAX_LENGTH } from '../../../shared/apiRoutes.js'

/** 点分十进制 → 4 个字节;非严格四段/超范围/带前导非法字符一律返回 null */
export function parseIpv4(raw: string): number[] | null {
  const parts = raw.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const p of parts) {
    // 只收纯十进制:'0x7f'/'017'/'1e2' 这类别名写法在这里就不认(它们是绕过判定的经典手法)
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

/**
 * IPv6 → 8 个 hextet(完整展开)。支持 `::` 压缩、末尾内嵌 IPv4、`%zone` 后缀。
 * 展开而非只看首段:`::ffff:10.0.0.1` 这类地址必须解出内嵌 v4 才能正确判禁。
 */
export function parseIpv6(raw: string): number[] | null {
  // 链路本地地址常带 zone(fe80::1%en0),zone 不参与判定
  const noZone = raw.split('%')[0].toLowerCase()
  if (noZone.length === 0 || !/^[0-9a-f:.]+$/.test(noZone)) return null

  let head = noZone
  const tail: number[] = []
  // 末段可能是内嵌 IPv4(::ffff:1.2.3.4),先摘出来折成两个 hextet
  const lastColon = noZone.lastIndexOf(':')
  if (noZone.includes('.')) {
    if (lastColon < 0) return null
    const v4 = parseIpv4(noZone.slice(lastColon + 1))
    if (!v4) return null
    tail.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
    head = noZone.slice(0, lastColon + 1) // 保留末尾冒号,便于下面按 '::' 切分
  }

  const dbl = head.indexOf('::')
  let groups: number[]
  const toHextets = (s: string): number[] | null => {
    if (s.length === 0) return []
    const out: number[] = []
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  if (dbl >= 0) {
    if (head.indexOf('::', dbl + 1) >= 0) return null // '::' 只能出现一次
    const left = toHextets(head.slice(0, dbl).replace(/:$/, ''))
    const right = toHextets(head.slice(dbl + 2).replace(/:$/, '').replace(/^:/, ''))
    if (!left || !right) return null
    const fill = 8 - (left.length + right.length + tail.length)
    if (fill < 0) return null
    groups = [...left, ...new Array<number>(fill).fill(0), ...right, ...tail]
  } else {
    const all = toHextets(head.replace(/:$/, ''))
    if (!all) return null
    groups = [...all, ...tail]
  }
  return groups.length === 8 ? groups : null
}

/** IPv4 禁区:RFC1918 私网 + 环回 + 链路本地 + CGNAT + 组播/保留等 */
function isForbiddenIpv4(b: number[]): boolean {
  const [a, x, y] = b
  if (a === 0) return true // 0.0.0.0/8 “本网络”
  if (a === 10) return true // 10/8 私网
  if (a === 100 && x >= 64 && x <= 127) return true // 100.64/10 运营商 CGNAT
  if (a === 127) return true // 127/8 环回
  if (a === 169 && x === 254) return true // 169.254/16 链路本地(含云元数据 169.254.169.254)
  if (a === 172 && x >= 16 && x <= 31) return true // 172.16/12 私网
  if (a === 192 && x === 0 && y === 0) return true // 192.0.0/24 IETF 协议分配
  if (a === 192 && x === 168) return true // 192.168/16 私网
  if (a === 198 && (x === 18 || x === 19)) return true // 198.18/15 基准测试
  if (a >= 224 && a <= 239) return true // 224/4 组播
  if (a >= 240) return true // 240/4 保留(含 255.255.255.255 广播)
  return false
}

/** IPv6 禁区:只做前缀归属判定;v4-mapped/v4-compatible 折回 v4 规则 */
function isForbiddenIpv6(h: number[]): boolean {
  const allZeroPrefix = h.slice(0, 5).every((g) => g === 0)
  // ::ffff:a.b.c.d(v4-mapped)与已废弃的 ::a.b.c.d(v4-compatible)都会落到 v4 栈上,
  // 必须解出内嵌 v4 再判——否则 ::ffff:127.0.0.1 就是一条绕过通道。
  // 注意 :: 与 ::1 也落进这里(→ 0.0.0.0 / 0.0.0.1),同样被 0/8 规则拒掉,语义一致。
  if (allZeroPrefix && (h[5] === 0xffff || h[5] === 0)) {
    return isForbiddenIpv4([h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff])
  }
  if ((h[0] & 0xfe00) === 0xfc00) return true // fc00::/7 唯一本地地址
  if ((h[0] & 0xffc0) === 0xfe80) return true // fe80::/10 链路本地
  if ((h[0] & 0xff00) === 0xff00) return true // ff00::/8 组播
  return false
}

/**
 * 地址是否落在禁区(内网/环回/链路本地/组播/保留)。
 * 传入的必须是字面地址(DNS 解析结果或 URL 里的 IP 字面量);
 * 解析不出来的一律返回 true(fail-closed)。
 */
export function isForbiddenAddress(ip: string): boolean {
  const trimmed = ip.trim().replace(/^\[|\]$/g, '')
  const v4 = parseIpv4(trimmed)
  if (v4) return isForbiddenIpv4(v4)
  const v6 = parseIpv6(trimmed)
  if (v6) return isForbiddenIpv6(v6)
  return true
}

/** hostname 是否是 IP 字面量(URL 的 v6 hostname 带方括号,这里已剥掉) */
export function parseIpLiteral(hostname: string): { address: string; family: 4 | 6 } | null {
  const bare = hostname.replace(/^\[|\]$/g, '')
  if (parseIpv4(bare)) return { address: bare, family: 4 }
  if (parseIpv6(bare)) return { address: bare, family: 6 }
  return null
}

export type TargetUrlResult =
  | { ok: true; url: URL }
  | { ok: false; code: 'invalid-input' | 'fetch-denied'; message: string }

/** 显式端口白名单:URL 会把"协议默认端口"归一成空串,所以这里只剩显式写的两种 */
const ALLOWED_PORTS = new Set(['', '80', '443'])

/**
 * 目标 URL 白名单校验(第一道闸,DNS 之前)。
 *
 * 错误码分工:形状问题(不是 URL、非 http(s)、超长)→ invalid-input(400,用户改输入);
 * 策略拒绝(带凭据、非常规端口、直指内网 IP)→ fetch-denied(403,改输入也不会放行)。
 */
export function validateTargetUrl(
  raw: string,
  maxLength: number = FETCH_URL_MAX_LENGTH,
): TargetUrlResult {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, code: 'invalid-input', message: 'URL 为空' }
  if (trimmed.length > maxLength) {
    return { ok: false, code: 'invalid-input', message: `URL 超过 ${maxLength} 字符上限` }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, code: 'invalid-input', message: 'URL 格式不合法' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'invalid-input', message: '只支持 http/https 链接' }
  }
  // userinfo 一律拒:一是防 `https://evil.com@intranet/` 这类视觉欺骗,
  // 二是我们绝不代用户向第三方出示凭据
  if (url.username !== '' || url.password !== '') {
    return { ok: false, code: 'fetch-denied', message: 'URL 不允许携带用户名/密码' }
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    return { ok: false, code: 'fetch-denied', message: '只允许访问 80/443 端口' }
  }
  if (url.hostname.length === 0) {
    return { ok: false, code: 'invalid-input', message: 'URL 缺少主机名' }
  }
  // 字面 IP 在这里就判掉,不必等 DNS(dns.lookup 对字面量只是原样回显)
  const literal = parseIpLiteral(url.hostname)
  if (literal && isForbiddenAddress(literal.address)) {
    return { ok: false, code: 'fetch-denied', message: '目标地址指向内网或保留地址' }
  }
  return { ok: true, url }
}
