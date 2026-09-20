/**
 * 真浏览器端到端(**默认跳过**,`npm test` 保持零外部依赖):
 *
 *   RENDER_E2E_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     npx vitest run test/renderE2e.test.ts
 *
 * 不碰真实网络:站点是本机 http stub,经 hop.lookup/hop.transport 注入(与 fetchUrl.test.ts 同一手法——
 * DNS 结果照常过禁区校验,transport 只改写"连哪个 IP/端口")。验证的是单测测不到的那一层:
 * Chromium/playwright 对"主文档 30x 重新导航""子资源 30x 逐跳跟随""合成 CORS 头""占位图""死代理"的真实反应。
 *
 * 这个文件存在的直接原因:最初的设计是"30x 原样 fulfill、让浏览器自己发下一跳",跑到这里才发现
 * playwright 对重定向出来的请求一律自动放行、不叫 route 处理器——那一跳直接撞在死代理上。
 */
import { execFile } from 'node:child_process'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  FetchDeniedError,
  nodeTransport,
  type FetchLookup,
  type FetchTransport,
} from '../src/lib/fetchRaw.js'
import { RENDER_USER_AGENT, createRenderer } from '../src/render/browser.js'

const CHROME = process.env.RENDER_E2E_CHROME ?? ''
const PUBLIC_ADDR = '93.184.216.34'
const MARKER = 'Recursive Self-Improvement'
const ARTICLE = `${MARKER} — ` + '客户端渲染出来的正文。'.repeat(40)

interface Seen {
  host: string
  url: string
  headers: IncomingHttpHeaders
}

let server: Server
let port = 0
const seen: Seen[] = []
let chromeCommandLines: string[] = []

/**
 * 只看**我们自己起的**那一窝 Chromium。机器上可能同时跑着别的 playwright 浏览器(回归扫描)和用户自己的
 * Chrome,它们带不带 --no-sandbox 与本测试无关。认领方式:浏览器主进程的命令行里有那个死代理,
 * 从它身上取 --user-data-dir,再按这个目录圈出全部子进程。
 */
function psCommandLines(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'command'], { maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => {
      resolve(String(stdout).split('\n'))
    })
  })
}

let profileDir = ''
const logs: string[] = []

async function listChromeCommandLines(): Promise<string[]> {
  const lines = await psCommandLines()
  if (!profileDir) {
    const main = lines.find((l) => l.includes('--proxy-server=http://127.0.0.1:9'))
    profileDir = /--user-data-dir=(\S+)/.exec(main ?? '')?.[1] ?? ''
  }
  return profileDir ? lines.filter((l) => l.includes(profileDir)) : []
}

beforeAll(async () => {
  if (!CHROME) return
  server = createServer((req, res) => {
    // transport 把端口改写到了 stub 上,node 因此会发 `Host: origin.test:<port>`——路由只看主机名
    const host = String(req.headers.host ?? '').split(':')[0]
    const url = req.url ?? ''
    seen.push({ host, url, headers: req.headers })
    res.on('error', () => {})
    const send = (status: number, headers: Record<string, string>, body = ''): void => {
      res.writeHead(status, headers)
      res.end(body)
    }

    if (host === 'origin.test' && url === '/') return send(302, { location: '/app/' })
    if (host === 'origin.test' && url === '/to-private') return send(302, { location: 'http://10.0.0.5/admin' })
    if (host === 'origin.test' && url === '/app/') {
      return send(
        200,
        {
          'content-type': 'text/html; charset=utf-8',
          // 这两个头要是被透传:cookie 会出现在 document.cookie 里,CSP 会让模块脚本根本不执行
          'set-cookie': 'sid=leaked; Path=/',
          'content-security-policy': "script-src 'none'",
        },
        `<!doctype html><html><head><title>E2E 页面</title>
<link rel="stylesheet" href="/app/style.css">
<script type="module" crossorigin src="http://cdn.test/assets/entry.js"></script>
</head><body><div id="root"></div>
<img id="pic" src="/pic.png" onerror="document.documentElement.setAttribute('data-img-error','1')">
<video src="/movie.mp4"></video>
<iframe src="http://frames.test/widget"></iframe>
</body></html>`,
      )
    }
    if (host === 'origin.test' && url === '/app/style.css') {
      return send(200, { 'content-type': 'text/css' }, '#root{color:#123}')
    }
    // 子资源的 30x:由渲染服务逐跳跟随,最终字节兑现在 entry.js 名下
    if (host === 'cdn.test' && url === '/assets/entry.js') return send(302, { location: '/assets/main.js' })
    if (host === 'cdn.test' && url === '/to-meta') {
      return send(302, { location: 'http://100.100.100.200/latest/meta-data/' })
    }
    // 刻意**不带**任何 access-control-* 头:这正是 z.ai 那类资源站的形态
    if (host === 'cdn.test' && url === '/assets/main.js') {
      void listChromeCommandLines().then((lines) => {
        chromeCommandLines = lines
      })
      return send(
        200,
        { 'content-type': 'text/javascript' },
        `import { text } from './chunk.js'
const root = document.getElementById('root')
const p = document.createElement('p'); p.id = 'content'; p.textContent = text; root.appendChild(p)
const probes = {}
const tries = [
  ['loopback', 'http://127.0.0.1:${port}/probe-loopback'],
  ['metadata', 'http://100.100.100.200/latest/meta-data/'],
  ['privateDns', 'http://internal.test/secret'],
  ['oddPort', 'http://origin.test:${port}/probe-port'],
  ['redirectToMeta', 'http://cdn.test/to-meta'],
]
fetch('/app/beacon', { method: 'POST', body: 'x' }).catch(() => {})
try { new WebSocket('ws://127.0.0.1:${port}/probe-ws') } catch (e) {}
Promise.all(tries.map(([k, u]) => fetch(u, { mode: 'no-cors' }).then(() => { probes[k] = 'reached' }, () => { probes[k] = 'blocked' })))
  .then(() => {
    probes.cookie = document.cookie
    const pre = document.createElement('pre'); pre.id = 'probes'; pre.textContent = JSON.stringify(probes)
    root.appendChild(pre)
  })
`,
      )
    }
    if (host === 'cdn.test' && url === '/assets/chunk.js') {
      return send(200, { 'content-type': 'text/javascript' }, `export const text = ${JSON.stringify(ARTICLE)}`)
    }
    return send(404, { 'content-type': 'text/plain' }, 'not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  if (!CHROME) return
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
})

const lookup: FetchLookup = async (host) =>
  host === 'internal.test' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: PUBLIC_ADDR, family: 4 }]
const transport: FetchTransport = (req) => nodeTransport({ ...req, address: '127.0.0.1', family: 4, port })

const makeRenderer = () =>
  createRenderer(
    { socketPath: '/unused', chromePath: CHROME, allowForbiddenDev: false },
    {
      hop: { lookup, transport },
      // 渲染器的日志只在失败时才有用:攒起来,用例失败时一并打出
      log: (line) => logs.push(line),
      onCloseTimeout: () => {
        throw new Error('browser.close() 超时')
      },
    },
  )

describe.skipIf(!CHROME)('真浏览器渲染(RENDER_E2E_CHROME)', () => {
  afterEach((ctx) => {
    if (ctx.task.result?.state === 'fail') console.error(logs.join('\n'))
    logs.length = 0
  })

  it(
    '跨源模块脚本跑得起来、主文档与子资源的 30x 都走得通、图片占位、内网探测全灭、沙箱开着',
    async () => {
      seen.length = 0
      profileDir = ''
      const result = await makeRenderer()('http://origin.test/', new AbortController().signal)

      // 主文档的 30x 是一次重新导航:最终地址是跳转后的真实 URL(而不是"内容换了、地址没换")
      expect(result.finalUrl).toBe('http://origin.test/app/')
      expect(result.title).toBe('E2E 页面')
      expect(result.agentVersion).toBe(2)
      expect(result.blockedScripts).toBe(0)
      expect(result.viewportWidth).toBe(1280)
      expect(result.html).toContain(MARKER)
      expect(result.html.length).toBeGreaterThan(ARTICLE.length)

      // 占位图兑现:onerror 没触发,<img> 还在;真图片没出网
      expect(result.html).not.toContain('data-img-error')
      expect(result.html).toContain('id="pic"')

      const probes = JSON.parse(/<pre id="probes"[^>]*>([^<]+)<\/pre>/.exec(result.html)?.[1].replace(/&quot;/g, '"') ?? '{}')
      expect(probes).toEqual({
        loopback: 'blocked',
        metadata: 'blocked',
        privateDns: 'blocked',
        oddPort: 'blocked',
        redirectToMeta: 'blocked',
        // set-cookie 没被透传
        cookie: '',
      })

      const hit = (host: string, url: string): boolean => seen.some((s) => s.host === host && s.url === url)
      expect(hit('origin.test', '/')).toBe(true)
      expect(hit('origin.test', '/app/')).toBe(true)
      expect(hit('origin.test', '/app/style.css')).toBe(true)
      expect(hit('cdn.test', '/assets/entry.js')).toBe(true)
      expect(hit('cdn.test', '/assets/main.js')).toBe(true)
      expect(hit('cdn.test', '/to-meta')).toBe(true)
      expect(hit('cdn.test', '/assets/chunk.js')).toBe(true)
      // 这些一个都不该到达"网络":图片(占位)、媒体/子框架(策略拒)、POST、以及所有探测
      for (const s of seen) {
        expect(s.url, `${s.host}${s.url}`).not.toMatch(/pic\.png|movie\.mp4|widget|beacon|probe-|secret/)
        expect(s.headers.cookie).toBeUndefined()
        expect(s.headers.referer).toBeUndefined()
        expect(s.headers['user-agent']).toBe(RENDER_USER_AGENT)
      }

      // 渲染进行中抓到的 Chromium 命令行:沙箱开着、死代理在、loopback 不许绕过
      expect(chromeCommandLines.length).toBeGreaterThan(0)
      for (const line of chromeCommandLines) expect(line).not.toContain('--no-sandbox')
      const browserProcess = chromeCommandLines.find((l) => l.includes('--proxy-server='))
      expect(browserProcess).toContain('--proxy-server=http://127.0.0.1:9')
      expect(browserProcess).toContain('--proxy-bypass-list=<-loopback>')
      expect(browserProcess).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp')

      // 用完即关:这个 profile 名下不留任何进程
      expect(profileDir).not.toBe('')
      await new Promise((r) => setTimeout(r, 300))
      expect(await listChromeCommandLines()).toEqual([])
    },
    40_000,
  )

  it(
    '公网 URL 302 到内网 IP → 整次渲染以 FetchDeniedError 失败,内网那一跳从未发出',
    async () => {
      seen.length = 0
      await expect(makeRenderer()('http://origin.test/to-private', new AbortController().signal)).rejects.toBeInstanceOf(
        FetchDeniedError,
      )
      expect(seen.map((s) => `${s.host}${s.url}`)).toEqual(['origin.test/to-private'])
    },
    40_000,
  )
})
