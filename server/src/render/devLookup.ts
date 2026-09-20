/**
 * 【仅本机开发】RENDER_ALLOW_FORBIDDEN_DEV 打开时用的 DNS 解析:只对 fake-IP 网段网开一面。
 *
 * 背景:开发机上的 fake-IP 代理(Surge/Clash 等)把**所有**公网域名解析进 198.18.0.0/15
 * (外加一个 fc00::/7 的 v6 伴生地址),而 198.18/15 在 SSRF 禁区里,不放宽就什么都渲染不出来。
 *
 * 为什么不像 API 的 fetch-url 那样只给 `allowForbiddenAddresses: true` 了事:那是整个关掉
 * "解析结果落禁区"的检查,于是 `http://localhost/`、任何解析到 127.0.0.1 / 192.168.x 的域名
 * 都会被放行。fetch-url 抓的是用户自己填的 URL,这点放宽尚可接受;渲染服务执行的却是**不可信页面
 * 里的任意脚本**,它们会主动去试 localhost——开发机上同样不该让它们够得着本机服务。
 *
 * 所以这里配合 `allowForbiddenAddresses: true`(让 safeFetchHop 别再整体拒)自己把关:
 * - 解析结果里有 198.18/15 的地址 → 只返回这些地址(建连也只用它们),伴生的 v6 丢弃;
 * - 没有 → 按生产规则逐个过禁区,任一落禁区即拒。
 * 字面 IP 的 URL 不经过这里,仍由 validateTargetUrl 拒绝。
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import type { FetchLookup, ResolvedAddress } from '../lib/fetchRaw.js'
import { isForbiddenAddress, parseIpv4 } from '../lib/ssrf.js'

/** 198.18.0.0/15(RFC 2544 基准测试网段):fake-IP 代理的默认地址池,公网上不可路由 */
export function isFakeIpAddress(address: string): boolean {
  const v4 = parseIpv4(address)
  return v4 !== null && v4[0] === 198 && (v4[1] === 18 || v4[1] === 19)
}

async function systemLookup(hostname: string): Promise<ResolvedAddress[]> {
  const all = await dnsLookup(hostname, { all: true })
  return all.map((a) => ({ address: a.address, family: a.family }))
}

/** resolve 可注入,单测不碰真实 DNS */
export function createFakeIpTolerantLookup(resolve: FetchLookup = systemLookup): FetchLookup {
  return async (hostname) => {
    const all = await resolve(hostname)
    const fake = all.filter((a) => isFakeIpAddress(a.address))
    if (fake.length > 0) return fake
    for (const a of all) {
      // safeFetchHop 会把 lookup 抛出的错误包成 FetchFailedError('域名解析失败:…'):
      // 开发模式下这类拒绝因此是 502 而不是 403——只影响错误码,不影响"拒了"这个事实
      if (isForbiddenAddress(a.address)) throw new Error('目标地址指向内网或保留地址')
    }
    return all
  }
}
