/**
 * 渲染服务的请求处置策略(src/render/policy.ts)与并发信号量:纯逻辑,真值表 + 预算记账。
 * 这是渲染服务的安全边界之一——每条规则都要有一个会因为"被改松"而变红的用例。
 */
import { describe, expect, it } from 'vitest'
import {
  FETCH_ASSET_MAX_BYTES,
  RENDER_URL_MAX_SUBREQUESTS,
  RENDER_URL_MAX_TOTAL_BYTES,
  RENDER_URL_SUBREQUEST_CONCURRENCY,
  RENDER_URL_SUBREQUEST_TIMEOUT_MS,
} from '../../shared/apiRoutes.js'
import {
  DEFAULT_RENDER_LIMITS,
  acceptFor,
  chargeBytes,
  chargeRequest,
  corsHeaders,
  createBudget,
  decideRequest,
  grantBytes,
  isHtmlContentType,
  sanitizeContentType,
  type RenderLimits,
  type RenderRequestInfo,
} from '../src/render/policy.js'
import { createSemaphore } from '../src/render/semaphore.js'

const info = (over: Partial<RenderRequestInfo> = {}): RenderRequestInfo => ({
  method: 'GET',
  url: 'https://example.com/app.js',
  resourceType: 'script',
  isNavigationRequest: false,
  isMainFrame: true,
  budget: createBudget(),
  ...over,
})

const SMALL: RenderLimits = {
  maxSubrequests: 3,
  maxTotalBytes: 1000,
  maxResourceBytes: 400,
  subrequestTimeoutMs: 1000,
  concurrency: 2,
}

describe('默认限额取自 shared 常量', () => {
  it('两端一份数,不在这里另抄', () => {
    expect(DEFAULT_RENDER_LIMITS).toEqual({
      maxSubrequests: RENDER_URL_MAX_SUBREQUESTS,
      maxTotalBytes: RENDER_URL_MAX_TOTAL_BYTES,
      maxResourceBytes: FETCH_ASSET_MAX_BYTES,
      subrequestTimeoutMs: RENDER_URL_SUBREQUEST_TIMEOUT_MS,
      concurrency: RENDER_URL_SUBREQUEST_CONCURRENCY,
    })
  })
})

describe('decideRequest 真值表', () => {
  it('放行:主文档、脚本、样式表、xhr、fetch、other', () => {
    expect(decideRequest(info({ resourceType: 'document', isNavigationRequest: true }))).toEqual({
      action: 'fetch',
    })
    for (const resourceType of ['script', 'stylesheet', 'xhr', 'fetch', 'other']) {
      expect(decideRequest(info({ resourceType }))).toEqual({ action: 'fetch' })
    }
  })

  it('非 GET 一律拒(含 CORS 预检的 OPTIONS),大小写不敏感', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'post']) {
      expect(decideRequest(info({ method }))).toEqual({ action: 'abort', reason: 'method' })
    }
    expect(decideRequest(info({ method: 'get' }))).toEqual({ action: 'fetch' })
  })

  it('非 http(s) 协议一律拒:file / chrome / ftp / ws / wss / data / blob / javascript', () => {
    for (const url of [
      'file:///etc/passwd',
      'chrome://settings/',
      'chrome-extension://abc/x.js',
      'ftp://example.com/a',
      'ws://example.com/socket',
      'wss://example.com/socket',
      'data:text/html,<p>x</p>',
      'blob:https://example.com/550e8400',
      'javascript:alert(1)',
      'about:blank',
    ]) {
      expect(decideRequest(info({ url }))).toEqual({ action: 'abort', reason: 'scheme' })
    }
  })

  it('解析不出来的 URL → bad-url', () => {
    for (const url of ['', 'not a url', '//no-scheme.example/x']) {
      expect(decideRequest(info({ url }))).toEqual({ action: 'abort', reason: 'bad-url' })
    }
  })

  it('用不着的资源类型一律拒', () => {
    for (const resourceType of ['media', 'font', 'ping', 'manifest', 'eventsource', 'texttrack', 'websocket']) {
      expect(decideRequest(info({ resourceType }))).toEqual({ action: 'abort', reason: 'resource-type' })
    }
  })

  it('图片 → 占位图兑现(不拒绝:拒绝会触发 onerror 改写页面)', () => {
    expect(decideRequest(info({ resourceType: 'image', url: 'https://cdn.example.com/a.png' }))).toEqual({
      action: 'placeholder-image',
    })
  })

  it('图片也逃不过方法与协议检查', () => {
    expect(decideRequest(info({ resourceType: 'image', method: 'POST' }))).toEqual({
      action: 'abort',
      reason: 'method',
    })
    expect(decideRequest(info({ resourceType: 'image', url: 'file:///etc/hosts' }))).toEqual({
      action: 'abort',
      reason: 'scheme',
    })
  })

  it('子框架文档拒;主框架导航放行;拿不到框架归属时不触发这条规则', () => {
    const nav = { resourceType: 'document', isNavigationRequest: true }
    expect(decideRequest(info({ ...nav, isMainFrame: false }))).toEqual({ action: 'abort', reason: 'subframe' })
    expect(decideRequest(info({ ...nav, isMainFrame: true }))).toEqual({ action: 'fetch' })
    expect(decideRequest(info({ ...nav, isMainFrame: undefined }))).toEqual({ action: 'fetch' })
    // 子框架里的脚本/xhr 不是导航,不受这条规则影响(它们照样逐个过 safeFetchHop)
    expect(decideRequest(info({ isMainFrame: false }))).toEqual({ action: 'fetch' })
  })

  it('策略不判主机/端口/内网:那是 safeFetchHop 的职责,这里照样放行去让它拒', () => {
    for (const url of ['http://127.0.0.1:8787/api/app/health', 'http://100.100.100.200/latest/meta-data/']) {
      expect(decideRequest(info({ url }))).toEqual({ action: 'fetch' })
    }
  })

  it('是纯函数:不改预算', () => {
    const budget = createBudget(SMALL)
    decideRequest(info({ budget }))
    decideRequest(info({ budget, resourceType: 'image' }))
    expect(budget).toMatchObject({ requests: 0, bytes: 0 })
  })
})

describe('预算', () => {
  it('请求数用完 → budget-requests', () => {
    const budget = createBudget(SMALL)
    for (let i = 0; i < SMALL.maxSubrequests; i++) {
      expect(decideRequest(info({ budget }))).toEqual({ action: 'fetch' })
      chargeRequest(budget)
    }
    expect(decideRequest(info({ budget }))).toEqual({ action: 'abort', reason: 'budget-requests' })
  })

  it('总字节用完 → budget-bytes', () => {
    const budget = createBudget(SMALL)
    chargeBytes(budget, 999)
    expect(decideRequest(info({ budget }))).toEqual({ action: 'fetch' })
    chargeBytes(budget, 1)
    expect(decideRequest(info({ budget }))).toEqual({ action: 'abort', reason: 'budget-bytes' })
  })

  it('占位图不出网:预算耗尽后图片照样兑现,也不记账', () => {
    const budget = createBudget(SMALL)
    for (let i = 0; i < SMALL.maxSubrequests; i++) chargeRequest(budget)
    chargeBytes(budget, SMALL.maxTotalBytes)
    expect(decideRequest(info({ budget, resourceType: 'image' }))).toEqual({ action: 'placeholder-image' })
  })

  it('grantBytes = min(单资源上限, 总预算剩余),见底为 0 不为负', () => {
    const budget = createBudget(SMALL)
    expect(grantBytes(budget)).toBe(400)
    chargeBytes(budget, 700)
    expect(grantBytes(budget)).toBe(300)
    chargeBytes(budget, 500)
    expect(grantBytes(budget)).toBe(0)
  })

  it('chargeBytes 不接受负数(不能靠它"退款")', () => {
    const budget = createBudget(SMALL)
    chargeBytes(budget, 100)
    chargeBytes(budget, -50)
    expect(budget.bytes).toBe(100)
  })
})

describe('acceptFor', () => {
  it('文档用 safeFetchHop 的默认值,其余按类型表态', () => {
    expect(acceptFor('document')).toBeUndefined()
    expect(acceptFor('stylesheet')).toContain('text/css')
    expect(acceptFor('script')).toBe('*/*')
    expect(acceptFor('fetch')).toContain('application/json')
    expect(acceptFor('xhr')).toContain('application/json')
    expect(acceptFor('other')).toBe('*/*')
  })
})

describe('sanitizeContentType', () => {
  it('只留 media type + charset,其余参数丢弃', () => {
    expect(sanitizeContentType('text/html; charset=UTF-8')).toBe('text/html; charset=utf-8')
    expect(sanitizeContentType('Text/JavaScript')).toBe('text/javascript')
    expect(sanitizeContentType('multipart/form-data; boundary=xyz')).toBe('multipart/form-data')
    expect(sanitizeContentType('application/json;charset="utf-8";foo=bar')).toBe(
      'application/json; charset=utf-8',
    )
    expect(sanitizeContentType('image/svg+xml')).toBe('image/svg+xml')
  })

  it('缺失/不合法 → null(不替上游猜)', () => {
    for (const raw of [null, undefined, '', 'garbage', 'text/', '/html', 'text/html\r\nset-cookie: a=b', 'a b/c']) {
      expect(sanitizeContentType(raw)).toBeNull()
    }
  })

  it('charset 里的头注入被丢弃,media type 保留', () => {
    expect(sanitizeContentType('text/html; charset=utf-8\r\nx-evil: 1')).toBe('text/html')
  })

  it('isHtmlContentType', () => {
    expect(isHtmlContentType('text/html; charset=utf-8')).toBe(true)
    expect(isHtmlContentType('application/xhtml+xml')).toBe(true)
    expect(isHtmlContentType('application/pdf')).toBe(false)
    expect(isHtmlContentType('text/plain')).toBe(false)
    expect(isHtmlContentType(null)).toBe(false)
  })
})

describe('corsHeaders', () => {
  it('回显请求 Origin,带 credentials 与 vary', () => {
    expect(corsHeaders('https://z.ai')).toEqual({
      'access-control-allow-origin': 'https://z.ai',
      'access-control-allow-credentials': 'true',
      vary: 'origin',
    })
    expect(corsHeaders('http://localhost:3000')['access-control-allow-origin']).toBe('http://localhost:3000')
  })

  it('没有 Origin → *;不透明源的 null 原样回', () => {
    expect(corsHeaders(undefined)['access-control-allow-origin']).toBe('*')
    expect(corsHeaders('null')['access-control-allow-origin']).toBe('null')
  })

  it('形状不对的 Origin 不回显(防头注入)', () => {
    for (const bad of ['https://a.com\r\nx-evil: 1', 'https://a.com/path', 'javascript:alert(1)', ' https://a.com']) {
      expect(corsHeaders(bad)['access-control-allow-origin']).toBe('*')
    }
  })
})

describe('createSemaphore', () => {
  it('同时在途不超过上限;归还后按先来后到放行', async () => {
    const sem = createSemaphore(2)
    const r1 = await sem.acquire()
    const r2 = await sem.acquire()
    expect(sem.active).toBe(2)

    const order: number[] = []
    const p3 = sem.acquire().then((r) => {
      order.push(3)
      return r
    })
    const p4 = sem.acquire().then((r) => {
      order.push(4)
      return r
    })
    await Promise.resolve()
    expect(order).toEqual([])

    r1()
    const r3 = await p3
    expect(order).toEqual([3])
    expect(sem.active).toBe(2)

    r2()
    const r4 = await p4
    expect(order).toEqual([3, 4])

    r3()
    r4()
    expect(sem.active).toBe(0)
  })

  it('重复归还无害(不会把名额还成负数)', async () => {
    const sem = createSemaphore(1)
    const release = await sem.acquire()
    release()
    release()
    expect(sem.active).toBe(0)
    const again = await sem.acquire()
    expect(sem.active).toBe(1)
    again()
  })
})
