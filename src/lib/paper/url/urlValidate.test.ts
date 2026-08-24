import { describe, expect, it } from 'vitest'
import { FETCH_URL_MAX_LENGTH, MAX_URLS_PER_IMPORT } from '../../../../shared/apiRoutes'
import { parseUrlInput } from './urlValidate'

describe('parseUrlInput', () => {
  it('按行解析，trim 并丢弃空行', () => {
    const { valid, invalid } = parseUrlInput('  https://a.com/x  \n\n\nhttps://b.com/y\n   \n')
    expect(invalid).toEqual([])
    expect(valid.map((v) => v.url)).toEqual(['https://a.com/x', 'https://b.com/y'])
  })

  it('无 scheme 的行自动补 https', () => {
    const { valid } = parseUrlInput('example.com/page')
    expect(valid).toHaveLength(1)
    expect(valid[0].url).toBe('https://example.com/page')
    expect(valid[0].hostname).toBe('example.com')
  })

  it('已带 http/https scheme 的不重复加前缀', () => {
    const { valid } = parseUrlInput('http://a.com\nhttps://b.com')
    expect(valid.map((v) => v.url)).toEqual(['http://a.com/', 'https://b.com/'])
  })

  it('拒绝非 http(s) 协议', () => {
    // 无 // 的 scheme（如裸 javascript:xxx）不会被 SCHEME_RE 识别为「已带 scheme」，
    // 会被当成裸域名补上 https:// 前缀——多数情况下解析失败归为「不是合法链接」，
    // 效果同样是被拒绝；这里单独覆盖「带 //」的非法协议，走的是协议白名单分支
    const { valid, invalid } = parseUrlInput('ftp://a.com/x\njavascript://alert(1)')
    expect(valid).toEqual([])
    expect(invalid.map((e) => e.reason)).toEqual(['仅支持 http/https 链接', '仅支持 http/https 链接'])
  })

  it('不是合法链接（补 https 后仍无法解析）时归类为不合法', () => {
    const { valid, invalid } = parseUrlInput('https://')
    expect(valid).toEqual([])
    expect(invalid[0].reason).toBe('不是合法链接')
  })

  it('超过 FETCH_URL_MAX_LENGTH 的行判为过长', () => {
    const long = `https://a.com/${'x'.repeat(FETCH_URL_MAX_LENGTH)}`
    const { valid, invalid } = parseUrlInput(long)
    expect(valid).toEqual([])
    expect(invalid[0].reason).toContain('过长')
  })

  it('保序去重：重复链接（含 scheme 补全后等价）只保留第一次出现', () => {
    const { valid } = parseUrlInput('https://a.com/x\nhttp://b.com\na.com/x\nhttps://b.com/y')
    expect(valid.map((v) => v.url)).toEqual(['https://a.com/x', 'http://b.com/', 'https://b.com/y'])
  })

  it.each(['localhost', 'localhost:8080', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.1.1', 'foo.local', '0.0.0.0'])(
    '拦截明显内网/本机地址：%s',
    (host) => {
      const { valid, invalid } = parseUrlInput(`http://${host}/secret`)
      expect(valid).toEqual([])
      expect(invalid[0].reason).toContain('内网')
    },
  )

  it('172.32.x.x（超出 172.16-31 私网段）不被拦截', () => {
    const { valid } = parseUrlInput('http://172.32.0.1/x')
    expect(valid).toHaveLength(1)
  })

  it('IPv6 回环地址被拦截', () => {
    const { valid, invalid } = parseUrlInput('http://[::1]:3000/x')
    expect(valid).toEqual([])
    expect(invalid[0].reason).toContain('内网')
  })

  it('正常公网 IPv6 地址放行', () => {
    const { valid } = parseUrlInput('http://[2001:4860:4860::8888]/x')
    expect(valid).toHaveLength(1)
  })

  it(`超过 MAX_URLS_PER_IMPORT（${MAX_URLS_PER_IMPORT}）条时，多余的移入 invalid 而不是静默截断`, () => {
    const n = MAX_URLS_PER_IMPORT + 3
    const lines = Array.from({ length: n }, (_, i) => `https://a.com/${i}`).join('\n')
    const { valid, invalid } = parseUrlInput(lines)
    expect(valid).toHaveLength(MAX_URLS_PER_IMPORT)
    expect(invalid).toHaveLength(3)
    expect(invalid.every((e) => e.reason.includes('上限'))).toBe(true)
    // 保留的是前 N 条，不是任意子集
    expect(valid.map((v) => v.url)).toEqual(
      Array.from({ length: MAX_URLS_PER_IMPORT }, (_, i) => `https://a.com/${i}`),
    )
  })

  it('混合有效/无效/重复/超限的综合场景', () => {
    const { valid, invalid } = parseUrlInput(
      ['https://docs.nvidia.com/a', 'not a url with spaces and no dot', 'https://docs.nvidia.com/a', 'localhost/x', 'docs.nvidia.com/b'].join(
        '\n',
      ),
    )
    expect(valid.map((v) => v.url)).toEqual(['https://docs.nvidia.com/a', 'https://docs.nvidia.com/b'])
    expect(invalid).toHaveLength(2)
  })
})
