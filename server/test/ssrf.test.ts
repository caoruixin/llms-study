/**
 * SSRF 纯逻辑:禁区矩阵(v4/v6/v4-mapped 逐段)与目标 URL 白名单校验。
 * 这是安全边界的回归网——每条禁区规则至少一个正例 + 相邻公网反例,
 * 防止后人"顺手放宽一个网段"时无声通过。
 */
import { describe, expect, it } from 'vitest'
import { FETCH_URL_MAX_LENGTH } from '../../shared/apiRoutes.js'
import { isForbiddenAddress, parseIpv6, validateTargetUrl } from '../src/lib/ssrf.js'

describe('isForbiddenAddress:IPv4 禁区', () => {
  const forbidden = [
    ['0.0.0.0/8', '0.0.0.0'],
    ['0/8 非零主机位', '0.1.2.3'],
    ['10/8', '10.0.0.1'],
    ['10/8 高段', '10.255.255.254'],
    ['100.64/10 CGNAT', '100.64.0.1'],
    ['100.64/10 上界', '100.127.255.255'],
    ['127/8 环回', '127.0.0.1'],
    ['127/8 别名', '127.1.2.3'],
    ['169.254/16 链路本地', '169.254.0.1'],
    ['云元数据', '169.254.169.254'],
    ['172.16/12 下界', '172.16.0.1'],
    ['172.16/12 上界', '172.31.255.255'],
    ['192.0.0/24', '192.0.0.8'],
    ['192.168/16', '192.168.1.1'],
    ['198.18/15 下界', '198.18.0.1'],
    ['198.18/15 上界', '198.19.255.255'],
    ['224/4 组播', '224.0.0.1'],
    ['224/4 上界', '239.255.255.255'],
    ['240/4 保留', '240.0.0.1'],
    ['受限广播', '255.255.255.255'],
  ] as const
  it.each(forbidden)('%s → 禁止(%s)', (_name, ip) => {
    expect(isForbiddenAddress(ip)).toBe(true)
  })

  const allowed = [
    ['公网 A 段', '8.8.8.8'],
    ['9/8 紧邻 10/8', '9.255.255.255'],
    ['11/8 紧邻 10/8', '11.0.0.1'],
    ['100.63 紧邻 CGNAT', '100.63.255.255'],
    ['100.128 紧邻 CGNAT', '100.128.0.1'],
    ['126 紧邻环回', '126.255.255.255'],
    ['128 紧邻环回', '128.0.0.1'],
    ['169.253 紧邻链路本地', '169.253.0.1'],
    ['172.15 紧邻私网', '172.15.255.255'],
    ['172.32 紧邻私网', '172.32.0.1'],
    ['192.0.1 紧邻协议段', '192.0.1.1'],
    ['192.167 紧邻私网', '192.167.255.255'],
    ['192.169 紧邻私网', '192.169.0.1'],
    ['198.17 紧邻基准段', '198.17.255.255'],
    ['198.20 紧邻基准段', '198.20.0.1'],
    ['223 紧邻组播', '223.255.255.255'],
  ] as const
  it.each(allowed)('%s → 放行(%s)', (_name, ip) => {
    expect(isForbiddenAddress(ip)).toBe(false)
  })
})

describe('isForbiddenAddress:IPv6 禁区', () => {
  const forbidden = [
    ['未指定地址 ::', '::'],
    ['环回 ::1', '::1'],
    ['环回完整写法', '0:0:0:0:0:0:0:1'],
    ['fc00::/7 下半', 'fc00::1'],
    ['fc00::/7 上半 fd', 'fd12:3456::1'],
    ['fe80::/10 链路本地', 'fe80::1'],
    ['fe80::/10 带 zone', 'fe80::1%en0'],
    ['fe80::/10 上界', 'febf::1'],
    ['ff00::/8 组播', 'ff02::1'],
    ['ff00::/8 上界', 'ffff::1'],
  ] as const
  it.each(forbidden)('%s → 禁止(%s)', (_name, ip) => {
    expect(isForbiddenAddress(ip)).toBe(true)
  })

  const allowed = [
    ['Google 公共 DNS', '2001:4860:4860::8888'],
    ['文档段(公网可路由形状)', '2606:4700:4700::1111'],
    ['fbff 紧邻 fc00::/7', 'fbff::1'],
    ['fec0 紧邻 fe80::/10', 'fec0::1'],
  ] as const
  it.each(allowed)('%s → 放行(%s)', (_name, ip) => {
    expect(isForbiddenAddress(ip)).toBe(false)
  })
})

describe('isForbiddenAddress:v4-mapped 与异常输入', () => {
  it.each([
    ['::ffff:127.0.0.1'],
    ['::ffff:10.0.0.1'],
    ['::ffff:169.254.169.254'],
    ['::ffff:192.168.0.1'],
    // 十六进制写法的 v4-mapped:同一地址的另一种字面形式,必须同样解出内嵌 v4
    ['::ffff:7f00:1'],
    // 已废弃的 v4-compatible 写法同样会落到 v4 栈上
    ['::10.0.0.1'],
  ])('%s → 禁止(解出内嵌 v4 再判)', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true)
  })

  it('::ffff:8.8.8.8 是公网映射 → 放行', () => {
    expect(isForbiddenAddress('::ffff:8.8.8.8')).toBe(false)
    expect(isForbiddenAddress('[::ffff:8.8.8.8]')).toBe(false)
  })

  it('解析不出来的形状一律禁止(fail-closed)', () => {
    for (const bad of ['', 'not-an-ip', 'example.com', '1.2.3', '1.2.3.4.5', '999.1.1.1', '0x7f.0.0.1', '::gggg', '1::2::3', '10.0.0.01x']) {
      expect(isForbiddenAddress(bad)).toBe(true)
    }
  })

  it('parseIpv6 完整展开压缩写法', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(parseIpv6('fe80::1')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1])
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304])
    // 九段与重复 '::' 都不合法
    expect(parseIpv6('1:2:3:4:5:6:7:8:9')).toBeNull()
    expect(parseIpv6('1::2::3')).toBeNull()
  })
})

describe('validateTargetUrl', () => {
  const ok = (raw: string): string => {
    const r = validateTargetUrl(raw)
    if (!r.ok) throw new Error(`预期放行,实际拒绝:${r.code} ${r.message}`)
    return r.url.toString()
  }
  const deny = (raw: string): { code: string; message: string } => {
    const r = validateTargetUrl(raw)
    if (r.ok) throw new Error(`预期拒绝,实际放行:${raw}`)
    return { code: r.code, message: r.message }
  }

  it('放行普通 http/https,含显式默认端口与前后空白', () => {
    expect(ok('https://example.com/a/b?c=1')).toBe('https://example.com/a/b?c=1')
    expect(ok('http://example.com:80/x')).toBe('http://example.com/x')
    expect(ok('https://example.com:443/x')).toBe('https://example.com/x')
    expect(ok('  https://example.com/  ')).toBe('https://example.com/')
    // 公网 IP 字面量本身不违规
    expect(ok('http://8.8.8.8/')).toBe('http://8.8.8.8/')
  })

  it('非 http(s) scheme → invalid-input', () => {
    for (const raw of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/', 'data:text/html,<b>x</b>']) {
      expect(deny(raw).code).toBe('invalid-input')
    }
  })

  it('畸形 URL / 空串 → invalid-input', () => {
    for (const raw of ['', '   ', 'not a url', 'http://', '://example.com']) {
      expect(deny(raw).code).toBe('invalid-input')
    }
  })

  it('超长 URL → invalid-input', () => {
    const long = `https://example.com/${'a'.repeat(FETCH_URL_MAX_LENGTH)}`
    expect(deny(long).code).toBe('invalid-input')
    // 恰好卡在上限之内应放行
    const exact = `https://example.com/${'a'.repeat(FETCH_URL_MAX_LENGTH - 'https://example.com/'.length)}`
    expect(exact.length).toBe(FETCH_URL_MAX_LENGTH)
    expect(ok(exact)).toBe(exact)
  })

  it('携带 userinfo → fetch-denied', () => {
    expect(deny('https://user:pass@example.com/').code).toBe('fetch-denied')
    expect(deny('https://user@example.com/').code).toBe('fetch-denied')
    // 视觉欺骗写法:真实主机是 10.0.0.1
    expect(deny('https://example.com@10.0.0.1/').code).toBe('fetch-denied')
  })

  it('非 80/443 端口 → fetch-denied', () => {
    for (const raw of ['http://example.com:8080/', 'https://example.com:22/', 'http://example.com:9200/']) {
      expect(deny(raw).code).toBe('fetch-denied')
    }
  })

  it('字面内网/保留 IP → fetch-denied(v4 与 v6 两种写法)', () => {
    for (const raw of [
      'http://127.0.0.1/',
      'http://127.0.0.1:80/x',
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://[::ffff:127.0.0.1]/',
    ]) {
      expect(deny(raw)).toMatchObject({ code: 'fetch-denied' })
    }
  })

  it('localhost 这类域名不在这一层拒绝(留给 DNS 解析后的禁区判定)', () => {
    expect(ok('http://localhost/')).toBe('http://localhost/')
  })
})
