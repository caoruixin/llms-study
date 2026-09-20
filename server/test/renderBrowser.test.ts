/**
 * 渲染服务里"不起浏览器也能钉住"的那部分:启动/上下文参数、占位图、注入表达式的自包含性、
 * 捕获结果校验、env 解析。
 *
 * 启动参数那组是**安全回归测试**:chromiumSandbox 不严格为 true,playwright 就会塞 --no-sandbox;
 * proxy 被拿掉或加了 bypass,页面里的 WebSocket 就能直连 localhost。谁改松了,这里先红。
 */
import vm from 'node:vm'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { CAPTURE_AGENT_VERSION, DEFAULT_CAPTURE_CONFIG } from '../../src/lib/paper/url/captureAgent.js'
import { FetchDeniedError, FetchFailedError, FetchTooLargeError } from '../src/lib/fetchRaw.js'
import {
  DEAD_PROXY,
  PLACEHOLDER_PNG,
  RENDER_USER_AGENT,
  buildAgentExpression,
  buildContextOptions,
  buildLaunchOptions,
} from '../src/render/browser.js'
import { loadRenderConfig } from '../src/render/config.js'
import { createFakeIpTolerantLookup, isFakeIpAddress } from '../src/render/devLookup.js'
import { RENDER_MAX_HTML_BYTES, RENDER_MAX_TITLE_CHARS, parseCapturePayload } from '../src/render/payload.js'
import { logUrl } from '../src/render/types.js'

const CHROME = '/opt/google/chrome/chrome'

describe('buildLaunchOptions', () => {
  it('沙箱严格为 true,且任何平台的 args 里都没有 --no-sandbox', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const opts = buildLaunchOptions({ chromePath: CHROME }, platform)
      expect(opts.chromiumSandbox).toBe(true)
      expect(opts.args ?? []).not.toContain('--no-sandbox')
      expect((opts.args ?? []).some((a) => a.includes('no-sandbox'))).toBe(false)
      expect((opts.args ?? []).some((a) => a.includes('disable-setuid-sandbox'))).toBe(false)
    }
  })

  it('显式二进制 + headless,不让 playwright 自己挑浏览器', () => {
    const opts = buildLaunchOptions({ chromePath: CHROME }, 'linux')
    expect(opts.executablePath).toBe(CHROME)
    expect(opts.headless).toBe(true)
    expect(opts.channel).toBeUndefined()
  })

  it('代理走 playwright 的 proxy 选项、指向死端口、没有 bypass', () => {
    const opts = buildLaunchOptions({ chromePath: CHROME }, 'linux')
    expect(opts.proxy).toEqual({ server: DEAD_PROXY })
    expect(DEAD_PROXY).toBe('http://127.0.0.1:9')
    // bypass 一旦出现 localhost/127.0.0.1,playwright 就不再追加 <-loopback>
    expect(opts.proxy?.bypass).toBeUndefined()
    // 不允许用 args 另起一个 --proxy-server 把选项顶掉;显式的 bypass 只能是 <-loopback>
    expect((opts.args ?? []).some((a) => a.startsWith('--proxy-server'))).toBe(false)
    expect((opts.args ?? []).filter((a) => a.startsWith('--proxy-bypass-list'))).toEqual([
      '--proxy-bypass-list=<-loopback>',
    ])
  })

  it('WebRTC 不许走非代理 UDP;mock keychain 只在 darwin 上加', () => {
    const linux = buildLaunchOptions({ chromePath: CHROME }, 'linux')
    const darwin = buildLaunchOptions({ chromePath: CHROME }, 'darwin')
    expect(linux.args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp')
    expect(darwin.args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp')
    expect(darwin.args).toContain('--use-mock-keychain')
    expect(linux.args).not.toContain('--use-mock-keychain')
  })

  it('信号处理交给入口,启动有超时', () => {
    const opts = buildLaunchOptions({ chromePath: CHROME }, 'linux')
    expect(opts).toMatchObject({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false })
    expect(opts.timeout).toBeGreaterThan(0)
    expect(opts.timeout).toBeLessThanOrEqual(15_000)
  })
})

describe('buildContextOptions', () => {
  it('禁 service worker / 下载 / 权限,不带存储状态,UA 与 Tier 1 一致', () => {
    const opts = buildContextOptions()
    expect(opts.serviceWorkers).toBe('block')
    expect(opts.acceptDownloads).toBe(false)
    expect(opts.permissions).toEqual([])
    expect(opts.viewport).toEqual({ width: 1280, height: 800 })
    expect(opts.userAgent).toBe(RENDER_USER_AGENT)
    expect(opts.storageState).toBeUndefined()
    expect(opts.httpCredentials).toBeUndefined()
    expect(opts.ignoreHTTPSErrors).toBeUndefined()
    expect(opts.bypassCSP).toBeUndefined()
  })

  it('UA 字面量与 fetchRaw.ts 逐字一致(那边没导出,只能读源码比对)', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(new URL('../src/lib/fetchRaw.ts', import.meta.url), 'utf8')
    expect(src).toContain(`'${RENDER_USER_AGENT}'`)
  })
})

describe('PLACEHOLDER_PNG', () => {
  it('是一张合法的 1×1 RGBA 全透明 PNG', () => {
    expect(PLACEHOLDER_PNG.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    // IHDR:偏移 16 起 width(4) height(4) bitDepth(1) colorType(1)
    expect(PLACEHOLDER_PNG.readUInt32BE(16)).toBe(1)
    expect(PLACEHOLDER_PNG.readUInt32BE(20)).toBe(1)
    expect(PLACEHOLDER_PNG[24]).toBe(8)
    expect(PLACEHOLDER_PNG[25]).toBe(6) // RGBA
    // IDAT:紧跟 IHDR(8 签名 + 25 IHDR 块)之后
    const idatLength = PLACEHOLDER_PNG.readUInt32BE(33)
    expect(PLACEHOLDER_PNG.subarray(37, 41).toString('latin1')).toBe('IDAT')
    const pixels = zlib.inflateSync(PLACEHOLDER_PNG.subarray(41, 41 + idatLength))
    // 一行:filter 字节 + R G B A;alpha 必须是 0
    expect(pixels.length).toBe(5)
    expect(pixels[4]).toBe(0)
  })

  it('每个块的 CRC 都对(解码器严格的浏览器会拒掉 CRC 错的 PNG → 触发 onerror,占位图就白做了)', () => {
    let at = 8
    const types: string[] = []
    while (at < PLACEHOLDER_PNG.length) {
      const length = PLACEHOLDER_PNG.readUInt32BE(at)
      const typeAndData = PLACEHOLDER_PNG.subarray(at + 4, at + 8 + length)
      types.push(typeAndData.subarray(0, 4).toString('latin1'))
      expect(PLACEHOLDER_PNG.readUInt32BE(at + 8 + length)).toBe(zlib.crc32(typeAndData) >>> 0)
      at += 12 + length
    }
    expect(types).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(at).toBe(PLACEHOLDER_PNG.length)
  })
})

describe('buildAgentExpression', () => {
  const cfg = {
    ...DEFAULT_CAPTURE_CONFIG,
    parentOrigin: '*',
    quietMs: 1,
    maxAfterLoadMs: 5,
    emptyWaitCapMs: 0,
    afterParsedMs: 1,
    hardTimeoutMs: 2000,
    sweep: false,
  }

  it('本构建下捕获代理的函数体不含打包器 helper(生产是 tsc 产物,同样不含)', () => {
    const expr = buildAgentExpression(cfg)
    // 垫片本身是表达式里唯一一处 __name;函数体里再出现就说明构建链在往里塞 helper
    expect(expr.match(/__name/g)?.length).toBe(1)
    expect(expr).not.toMatch(/__vite|__vi_|import_meta|__publicField|__async/)
    expect(expr.endsWith('.collect()})()')).toBe(true)
  })

  it('脱离模块作用域照样能跑:在一个只有假 window 的 vm 上下文里 resolve 出一条协议消息', async () => {
    // 假页面极简:没有 documentElement,序列化必然失败——要验的不是序列化,而是
    // "整条流程没有因为引用了模块作用域的标识符而 ReferenceError"
    const sandbox: Record<string, unknown> = {
      document: { readyState: 'complete', documentElement: null, body: null, title: '', baseURI: 'https://example.com/' },
      addEventListener: () => {},
      setTimeout,
      clearTimeout,
      innerWidth: 1280,
      innerHeight: 800,
      scrollTo: () => {},
      Promise,
      Date,
      String,
      Number,
    }
    const msg = (await vm.runInNewContext(buildAgentExpression(cfg), sandbox)) as Record<string, unknown>
    expect(msg.type).toBe('pc-capture')
    expect(msg.agentVersion).toBe(CAPTURE_AGENT_VERSION)
    expect(typeof msg.blockedScripts).toBe('number')
    if (msg.ok === false) expect(String(msg.reason)).not.toMatch(/is not defined/)
  })

  it('垫片让带 __name 包装的产物(tsx/esbuild keepNames)也能跑', async () => {
    const wrapped =
      '(function(){var __name=function(f){return f};return (' +
      'function agent(cfg){var inner=__name(function(){return Promise.resolve(cfg.v)},"inner");return {collect:inner}}' +
      ')(' +
      JSON.stringify({ v: 42 }) +
      ').collect()})()'
    expect(await vm.runInNewContext(wrapped, { Promise })).toBe(42)
  })
})

describe('parseCapturePayload', () => {
  const ok = {
    type: 'pc-capture',
    ok: true,
    html: '<html><body><p>hello</p></body></html>',
    title: 'Title',
    finalUrl: 'https://example.com/post',
    viewportWidth: 1280,
    hidden: 3,
    fixed: 1,
    blockedScripts: 0,
    agentVersion: 2,
  }

  it('合法消息 → 恰好是 RenderUrlResponse 的八个字段,多余字段不带出', () => {
    const out = parseCapturePayload({ ...ok, extra: 'x', __proto__: { polluted: true } })
    expect(out).toEqual({
      html: ok.html,
      title: 'Title',
      finalUrl: 'https://example.com/post',
      viewportWidth: 1280,
      hidden: 3,
      fixed: 1,
      blockedScripts: 0,
      agentVersion: 2,
    })
    expect(Object.keys(out).sort()).toEqual(
      ['agentVersion', 'blockedScripts', 'finalUrl', 'fixed', 'hidden', 'html', 'title', 'viewportWidth'].sort(),
    )
  })

  it('形状不对 → FetchFailedError', () => {
    for (const bad of [
      null,
      undefined,
      'string',
      42,
      [],
      {},
      { ...ok, type: 'other' },
      { ...ok, html: 123 },
      { ...ok, title: null },
      { ...ok, hidden: -1 },
      { ...ok, hidden: 1.5 },
      { ...ok, fixed: Number.NaN },
      { ...ok, blockedScripts: Number.POSITIVE_INFINITY },
      { ...ok, viewportWidth: '1280' },
      { ...ok, agentVersion: 0 },
      { ...ok, finalUrl: '' },
    ]) {
      expect(() => parseCapturePayload(bad)).toThrow(FetchFailedError)
    }
  })

  it('html 超 8MB → FetchTooLargeError(按字节算,多字节字符不能蒙混)', () => {
    expect(() => parseCapturePayload({ ...ok, html: 'a'.repeat(RENDER_MAX_HTML_BYTES + 1) })).toThrow(
      FetchTooLargeError,
    )
    // 字符数没超、字节数超了
    const multibyte = '字'.repeat(Math.floor(RENDER_MAX_HTML_BYTES / 3) + 10)
    expect(multibyte.length).toBeLessThan(RENDER_MAX_HTML_BYTES)
    expect(() => parseCapturePayload({ ...ok, html: multibyte })).toThrow(FetchTooLargeError)
    // 恰好 8MB 放行
    expect(parseCapturePayload({ ...ok, html: 'a'.repeat(RENDER_MAX_HTML_BYTES) }).html.length).toBe(
      RENDER_MAX_HTML_BYTES,
    )
  })

  it('title 截断到上限', () => {
    expect(parseCapturePayload({ ...ok, title: 't'.repeat(5000) }).title.length).toBe(RENDER_MAX_TITLE_CHARS)
  })

  it('finalUrl 走 validateTargetUrl:内网/字面 IP/非常规端口/带凭据 → denied;非 http(s) → failed', () => {
    for (const finalUrl of [
      'http://127.0.0.1/',
      'http://100.100.100.200/latest/meta-data/',
      'http://[::1]/',
      'https://example.com:8443/',
      'https://user:pw@example.com/',
    ]) {
      expect(() => parseCapturePayload({ ...ok, finalUrl })).toThrow(FetchDeniedError)
    }
    for (const finalUrl of ['about:blank', 'file:///etc/passwd', 'chrome-error://chromewebdata/', 'not a url']) {
      expect(() => parseCapturePayload({ ...ok, finalUrl })).toThrow(FetchFailedError)
    }
  })

  it('finalUrl 规范化后回传', () => {
    expect(parseCapturePayload({ ...ok, finalUrl: '  HTTPS://Example.com/a/../b  ' }).finalUrl).toBe(
      'https://example.com/b',
    )
  })

  it('代理报失败:too-large → FetchTooLargeError,其余 → FetchFailedError;页面可控的 reason 绝不进文案', () => {
    const base = { type: 'pc-capture', ok: false, blockedScripts: 0, agentVersion: 2 }
    expect(() => parseCapturePayload({ ...base, reason: 'too-large' })).toThrow(FetchTooLargeError)
    const evil = 'pwned\n[render] ok url="https://fake"'
    try {
      parseCapturePayload({ ...base, reason: evil })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(FetchFailedError)
      expect((e as Error).message).not.toContain('pwned')
    }
  })
})

describe('loadRenderConfig', () => {
  const base = { RENDER_SOCKET_PATH: '/run/llms-study-render/render.sock', RENDER_CHROME_PATH: CHROME }

  it('最小配置;开发逃生口默认关', () => {
    expect(loadRenderConfig(base)).toEqual({
      socketPath: '/run/llms-study-render/render.sock',
      chromePath: CHROME,
      allowForbiddenDev: false,
    })
  })

  it('两个路径必填且必须是绝对路径', () => {
    expect(() => loadRenderConfig({ ...base, RENDER_SOCKET_PATH: undefined })).toThrow(/RENDER_SOCKET_PATH/)
    expect(() => loadRenderConfig({ ...base, RENDER_CHROME_PATH: '' })).toThrow(/RENDER_CHROME_PATH/)
    expect(() => loadRenderConfig({ ...base, RENDER_SOCKET_PATH: 'render.sock' })).toThrow(/绝对路径/)
    expect(() => loadRenderConfig({ ...base, RENDER_CHROME_PATH: 'google-chrome' })).toThrow(/绝对路径/)
  })

  it('开发逃生口:只接受 true/false/1/0', () => {
    expect(loadRenderConfig({ ...base, RENDER_ALLOW_FORBIDDEN_DEV: '1' }).allowForbiddenDev).toBe(true)
    expect(loadRenderConfig({ ...base, RENDER_ALLOW_FORBIDDEN_DEV: 'true' }).allowForbiddenDev).toBe(true)
    expect(loadRenderConfig({ ...base, RENDER_ALLOW_FORBIDDEN_DEV: '0' }).allowForbiddenDev).toBe(false)
    expect(() => loadRenderConfig({ ...base, RENDER_ALLOW_FORBIDDEN_DEV: 'yes' })).toThrow()
  })

  it('systemd 环境下开着逃生口 → 拒绝启动(生产手滑的最后一道闸)', () => {
    expect(() =>
      loadRenderConfig({ ...base, RENDER_ALLOW_FORBIDDEN_DEV: '1', INVOCATION_ID: 'abc123' }),
    ).toThrow(/RENDER_ALLOW_FORBIDDEN_DEV/)
    // 逃生口关着时 systemd 环境当然能起
    expect(loadRenderConfig({ ...base, INVOCATION_ID: 'abc123' }).allowForbiddenDev).toBe(false)
  })

  it('不读、不要求 API 的机密:没有 LLM_KEY_MASTER 照样能起', () => {
    expect(() => loadRenderConfig(base)).not.toThrow()
  })
})

describe('开发逃生口的 DNS(devLookup)', () => {
  const lookupOf = (table: Record<string, { address: string; family: number }[]>) =>
    createFakeIpTolerantLookup(async (host) => table[host] ?? [])

  it('isFakeIpAddress 只认 198.18.0.0/15', () => {
    for (const a of ['198.18.0.1', '198.18.2.199', '198.19.255.254']) expect(isFakeIpAddress(a)).toBe(true)
    for (const a of ['198.17.0.1', '198.20.0.1', '127.0.0.1', '10.0.0.1', '93.184.216.34', '::1', 'fd12::1', 'x']) {
      expect(isFakeIpAddress(a)).toBe(false)
    }
  })

  it('fake-IP 结果:只返回 198.18/15 的地址,伴生的 v6 ULA 丢弃', async () => {
    const lookup = lookupOf({
      'z.ai': [
        { address: 'fd12:1:1:1:898:0:2a9:f', family: 6 },
        { address: '198.18.2.199', family: 4 },
      ],
    })
    expect(await lookup('z.ai')).toEqual([{ address: '198.18.2.199', family: 4 }])
  })

  it('localhost / 解析到内网、元数据、CGNAT 的域名 → 照拒(逃生口不是整体关掉禁区检查)', async () => {
    const lookup = lookupOf({
      localhost: [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 },
      ],
      'router.lan': [{ address: '192.168.1.1', family: 4 }],
      'meta.evil.test': [{ address: '100.100.100.200', family: 4 }],
      'aws-meta.evil.test': [{ address: '169.254.169.254', family: 4 }],
      // 一条公网 A + 一条内网 A:任一落禁区即整体拒
      'mixed.evil.test': [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    })
    for (const host of ['localhost', 'router.lan', 'meta.evil.test', 'aws-meta.evil.test', 'mixed.evil.test']) {
      await expect(lookup(host)).rejects.toThrow(/内网或保留地址/)
    }
  })

  it('真实公网地址(代理里配了直连的域名)原样放行', async () => {
    const lookup = lookupOf({ 'example.com': [{ address: '93.184.216.34', family: 4 }] })
    expect(await lookup('example.com')).toEqual([{ address: '93.184.216.34', family: 4 }])
  })
})

describe('logUrl', () => {
  it('转义换行(防日志注入)并截到 200 字符', () => {
    const line = logUrl('https://a.com/\n[render] ok url="https://fake"')
    expect(line).not.toContain('\n')
    expect(line.startsWith('"https://a.com/\\n')).toBe(true)
    expect(logUrl('https://a.com/' + 'x'.repeat(5000)).length).toBe(200)
  })
})
