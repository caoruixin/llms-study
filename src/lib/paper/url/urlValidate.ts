import { FETCH_URL_MAX_LENGTH, MAX_URLS_PER_IMPORT } from '../../../../shared/apiRoutes'

/**
 * URL 批量导入的输入解析（纯函数，UI 与测试共用）。
 *
 * 校验分两层：这里做的是「前端早退」——省一趟往返、给出即时反馈；权威判定仍在服务端
 * （server/src/lib/ssrf.ts 的 v4/v6/v4-mapped 全禁区矩阵），这里的内网识别只挡最明显的
 * 几类（localhost/.local/字面私网 IP），不做 DNS 解析、不追代理链，也不需要追。
 */

export interface ParsedUrlEntry {
  /** 用户粘贴的原始行（trim 后） */
  raw: string
  /** 规范化后的 URL（补 https 前缀、URL 类解析后再 toString） */
  url: string
  hostname: string
}

export interface InvalidUrlEntry {
  raw: string
  reason: string
}

export interface ParseUrlInputResult {
  valid: ParsedUrlEntry[]
  invalid: InvalidUrlEntry[]
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
const LOCALHOST_HOSTS = new Set(['localhost', '0.0.0.0'])

/** IPv4 字面量私网/保留段：10/8、127/8（回环）、169.254/16（链路本地）、172.16-31/12、192.168/16 */
function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const parts = [m[1], m[2], m[3], m[4]].map(Number)
  if (parts.some((n) => n > 255)) return false
  const [a, b] = parts
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

/** IPv6 字面量：只挡最常见的回环 / 链路本地 / 唯一本地地址；URL.hostname 对 IPv6 会带方括号 */
function isPrivateIPv6(hostname: string): boolean {
  if (!hostname.startsWith('[') || !hostname.endsWith(']')) return false
  const inner = hostname.slice(1, -1).toLowerCase()
  return inner === '::1' || inner.startsWith('fe80:') || inner.startsWith('fc') || inner.startsWith('fd')
}

function isObviouslyPrivate(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (LOCALHOST_HOSTS.has(h)) return true
  if (h.endsWith('.local')) return true
  if (isPrivateIPv4(h)) return true
  if (isPrivateIPv6(h)) return true
  return false
}

/**
 * 按行解析：trim + 去空行 → 长度上限 → 无 scheme 补 https → 合法性/协议 → 明显内网拦截
 * → 保序去重 → 超过 MAX_URLS_PER_IMPORT 的多余条目移入 invalid（不静默截断，用户能看到原因）。
 */
export function parseUrlInput(text: string): ParseUrlInputResult {
  const valid: ParsedUrlEntry[] = []
  const invalid: InvalidUrlEntry[] = []
  const seen = new Set<string>()

  for (const line of text.split(/\r\n|\r|\n/)) {
    const raw = line.trim()
    if (!raw) continue

    if (raw.length > FETCH_URL_MAX_LENGTH) {
      invalid.push({ raw, reason: `链接过长（超过 ${FETCH_URL_MAX_LENGTH} 字符）` })
      continue
    }

    const candidate = SCHEME_RE.test(raw) ? raw : `https://${raw}`
    let parsed: URL
    try {
      parsed = new URL(candidate)
    } catch {
      invalid.push({ raw, reason: '不是合法链接' })
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      invalid.push({ raw, reason: '仅支持 http/https 链接' })
      continue
    }
    if (isObviouslyPrivate(parsed.hostname)) {
      invalid.push({ raw, reason: '疑似内网或本机地址，出于安全考虑已拦截' })
      continue
    }

    const url = parsed.toString()
    if (seen.has(url)) continue // 保序去重：静默丢弃后续重复项，不计入 invalid
    seen.add(url)
    valid.push({ raw, url, hostname: parsed.hostname })
  }

  if (valid.length > MAX_URLS_PER_IMPORT) {
    const overflow = valid.splice(MAX_URLS_PER_IMPORT)
    for (const e of overflow) invalid.push({ raw: e.raw, reason: `超过单次导入 ${MAX_URLS_PER_IMPORT} 条链接上限` })
  }

  return { valid, invalid }
}
