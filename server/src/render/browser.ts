/**
 * 无头 Chromium 渲染:在页面的**真实源**上打开它,等客户端渲染完,用捕获代理把活树变成静态 HTML。
 * **全仓唯一 import playwright-core 的文件**——其余模块(策略/校验/http 层)都能脱离浏览器测试。
 *
 * 跑的是不可信网页,所以这里的每个决定都围绕两件事:
 *
 * 1. **Chromium 永远碰不到网络。** `context.route('**\/*')` 拦下请求,由 safeFetchHop 代为兑现
 *    (钉死已校验的 IP、逐跳重验、字节/时间双闸——与 /api/app/fetch-url 是同一条防线)。
 *
 *    但 **route 拦不到全部请求**,这是实测出来的、不是文档里读来的:playwright 对一切"重定向出来的
 *    请求"(`redirectedFrom` 非空)**自动 continueRequest,根本不叫我们的处理器**——包括我们自己
 *    fulfill 一个 30x 之后浏览器发的下一跳;没有 networkId / 没有归属框架的请求同样被它自动放行,
 *    WebSocket 则压根不走 Fetch 拦截。所以**真正兜底的是那个指向死端口的代理**:playwright 的 proxy
 *    选项会追加 `--proxy-bypass-list=<-loopback>`(连 localhost 都不许绕过代理),凡是没被我们兑现的
 *    流量一律撞死在 127.0.0.1:9 上;被兑现的请求根本不出网,死代理对它们无害。
 *    **这个代理不是纵深防御里可有可无的一层,拿掉它 = 重定向一跳就能绕过全部 SSRF 校验。**
 *
 *    由此,重定向不能"30x 原样交还浏览器"(那一跳会绕过我们、然后死在代理上):
 *    - **主文档**:中止本次导航,校验 Location 后由我们显式 `page.goto(下一跳)`——那是一次全新的、
 *      会被拦截的导航,URL 身份逐跳精确(`location`、`<base>`、相对链接、CORS 的 Origin 都以真实地址为准);
 *    - **子资源**:在处理器里逐跳跟随(每一跳仍是一次完整校验的 safeFetchHop),把最终字节兑现在
 *      **原 URL** 名下。代价是被重定向的模块脚本,其相对 import 会按跳转前的 URL 解析——
 *      带 hash 的构建产物几乎不会被重定向,这是可接受的取舍。
 *
 * 2. **沙箱必须开着。** playwright 只要 `chromiumSandbox` 不严格等于 true 就塞 `--no-sandbox`;
 *    渲染不可信页面却关沙箱 = 一个渲染进程漏洞直通本机用户。这一项由单测钉住。
 *
 * 一次渲染一个浏览器、用完即关:不复用进程 = 没有跨请求的缓存/存储/内存泄漏可言。
 * 关不掉(5s)就 `process.exit(1)`——crash-only:systemd `Restart=always` + `KillMode=control-group`
 * 会把整个 cgroup 里的 Chromium 子进程一并收走,比在进程内追杀僵尸可靠。
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type LaunchOptions,
  type Page,
  type Route,
} from 'playwright-core'
import { FETCH_URL_MAX_REDIRECTS, RENDER_URL_TIMEOUT_MS } from '../../../shared/apiRoutes.js'
import type { RenderUrlResponse } from '../../../shared/apiTypes.js'
import {
  DEFAULT_CAPTURE_CONFIG,
  captureAgentMain,
  type CaptureAgentConfig,
} from '../../../src/lib/paper/url/captureAgent.js'
import {
  FetchDeniedError,
  FetchFailedError,
  FetchTooLargeError,
  safeFetchHop,
  type SafeFetchHopOptions,
  type SafeFetchHopResult,
} from '../lib/fetchRaw.js'
import { validateTargetUrl } from '../lib/ssrf.js'
import type { RenderConfig } from './config.js'
import { createFakeIpTolerantLookup } from './devLookup.js'
import { parseCapturePayload } from './payload.js'
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
  type RenderBudget,
  type RenderLimits,
  type RenderRequestInfo,
} from './policy.js'
import { createSemaphore, type Semaphore } from './semaphore.js'
import { RenderLaunchError, logUrl, type Renderer } from './types.js'

/**
 * 与 ../lib/fetchRaw.ts 的 OUTBOUND_HEADERS['user-agent'] **逐字一致**(那边没导出,且本任务不改它,
 * 故复制字面量;改一处必须同改另一处)。必须一致的原因:页面里 `navigator.userAgent` 与我们替它
 * 发出去的请求头对不上,是反爬最容易抓的破绽;而 Tier 1 用这个 UA 抓到过这个页面,同一个 UA 不会被区别对待。
 */
export const RENDER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 永远连不上的代理:discard 端口(9)在本机没有监听者。见文件头第 1 条 */
export const DEAD_PROXY = 'http://127.0.0.1:9'

/**
 * 浏览器启动上限:热启动 1~2s,但**冷启动**(开机后第一次、二进制不在页缓存里)实测能超过 10s——
 * 10s 的上限在开发机上真的误杀过一次。到点 playwright 会自己杀掉没起来的进程
 */
const LAUNCH_TIMEOUT_MS = 15_000
/** 导航到 domcontentloaded 的上限 */
const NAV_TIMEOUT_MS = 12_000
/** browser.close() 的宽限;超过即 exit(1),见文件头 */
const CLOSE_TIMEOUT_MS = 5_000
/** 给代理的硬超时留出的收尾余量:序列化 + 结果过 CDP 回传 + 校验 */
const AGENT_TAIL_MS = 2_500
/** 代理硬超时的下限:再短连一次静默判定都跑不完 */
const AGENT_MIN_HARD_TIMEOUT_MS = 3_000

/**
 * 1×1 全透明 PNG(68 字节,RGBA 一个像素 00 00 00 00;结构与 CRC 由单测逐块校验——
 * 网上流传的那几串"透明像素" base64 有的解出来根本不是合法扫描行)。
 * 图片请求一律用它兑现、不出网——见 policy.ts 的 placeholder-image。
 * 透明而非纯色:万一占位图真被画出来(背景图等),也不会在页面上盖一个色块影响可见性判定。
 */
export const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
  'base64',
)

/**
 * 启动参数。纯函数,单测直接断言——这里任何一项被改松都是安全事故,不能等到线上才发现。
 * platform 作参数是为了在 darwin 上也能测到 linux 分支。
 */
export function buildLaunchOptions(
  cfg: Pick<RenderConfig, 'chromePath'>,
  platform: NodeJS.Platform = process.platform,
): LaunchOptions {
  const args = [
    // WebRTC 的 UDP 不走 http 代理:不关掉,页面能用 STUN 探测到本机的内网/公网 IP
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    // 与 proxy 选项追加的那条同值(Chromium 对重复开关取最后一个)。显式再写一遍是不把
    // "localhost 也必须走代理"这条防线赌在 playwright 某个版本的内部实现上
    '--proxy-bypass-list=<-loopback>',
  ]
  // macOS:不加就会向**当前登录用户**弹钥匙串密码框(开发机上的骚扰,不是安全问题)
  if (platform === 'darwin') args.push('--use-mock-keychain')
  return {
    executablePath: cfg.chromePath,
    headless: true,
    // 必须**严格等于 true**:playwright 的判断是 `!== true` 就加 --no-sandbox
    chromiumSandbox: true,
    proxy: { server: DEAD_PROXY },
    args,
    timeout: LAUNCH_TIMEOUT_MS,
    // 信号由 index.ts 统一处理(先 abort 渲染、关浏览器,再退出);playwright 自带的处理器
    // 会和它抢着关、SIGINT 时还会直接 process.exit
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  }
}

/** 上下文参数:每次渲染全新一份,不带任何存储状态 */
export function buildContextOptions(): BrowserContextOptions {
  return {
    // service worker 的请求不经过 context.route——它能替页面绕开整条拦截链
    serviceWorkers: 'block',
    acceptDownloads: false,
    permissions: [],
    viewport: { width: 1280, height: 800 },
    userAgent: RENDER_USER_AGENT,
  }
}

/**
 * 拼出交给 page.evaluate 的表达式:与客户端 srcdoc 注入同一个形态,只是调 `collect()` 而不是 `run()`
 * (顶层页面里 parent 就是自己,postMessage 等于把整份 HTML 广播给站点脚本)。
 *
 * `__name` 垫片:生产构建(tsc)产出的函数体完全自包含,用不到它;但本地用 tsx 起服时,esbuild 的
 * keepNames 会给每个内层函数包一层 `__name(fn, "…")`,那个 helper 在模块作用域、toString() 带不走,
 * 到页面里就是 ReferenceError。垫一个同名恒等函数让两种产物都能跑。
 */
export function buildAgentExpression(cfg: CaptureAgentConfig): string {
  return (
    '(function(){var __name=function(f){return f};return (' +
    captureAgentMain.toString() +
    ')(' +
    JSON.stringify(cfg) +
    ').collect()})()'
  )
}

export interface RendererDeps {
  limits?: RenderLimits
  /** 整次渲染(启动 → 拿到捕获结果)的总时长上限 */
  timeoutMs?: number
  /**
   * safeFetchHop 的注入口(测试专用,语义同 AppDeps.fetchTuning):transport 把请求打到本机 stub,
   * lookup 构造"域名解析到内网"这类必须走真实校验路径的场景
   */
  hop?: Pick<SafeFetchHopOptions, 'transport' | 'lookup'>
  /** 浏览器 5s 关不掉时的动作;默认 process.exit(1) */
  onCloseTimeout?: () => void
  log?: (line: string) => void
}

function abortError(): Error {
  const e = new Error('渲染已取消')
  e.name = 'AbortError'
  return e
}

const errName = (e: unknown): string => (e instanceof Error ? e.name : typeof e)

/** 执行上下文在 evaluate 途中被销毁 = 页面做了客户端跳转,新文档里再跑一遍即可 */
const isContextDestroyed = (e: unknown): boolean =>
  e instanceof Error && /context was destroyed|because of a navigation/i.test(e.message)

/** 单次渲染的可变状态:路由处理器与主流程共享 */
interface RenderRun {
  page: Page
  budget: RenderBudget
  gate: Semaphore
  allowForbiddenDev: boolean
  hop: RendererDeps['hop']
  deadline: number
  finished: boolean
  /**
   * 主文档那一跳回了 30x 时,处理器把(尚未校验的)下一跳放在这里并中止导航,
   * 由 capture() 的导航循环校验后显式 goto。null = 没有待处理的跳转
   */
  pendingRedirect: string | null
  failWith: (e: Error) => void
  log: (line: string) => void
}

/**
 * 给单跳加自己的计时器:safeFetchHop 的 timeoutMs 只管到建连之后,**DNS 解析不在它的预算里**,
 * 一个慢/黑洞 DNS 能把这个名额占到天荒地老。到点我们先放手(底层那次解析无法取消,
 * 但它最多再拖一个传输超时,且结果无人接收)。
 */
function hopWithTimer(url: string, opts: SafeFetchHopOptions): Promise<SafeFetchHopResult> {
  const timeoutMs = opts.timeoutMs ?? 0
  return new Promise<SafeFetchHopResult>((resolve, reject) => {
    const timer = setTimeout(() => reject(new FetchFailedError('抓取超时')), timeoutMs + 500)
    safeFetchHop(url, opts).then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** route 的收尾动作都可能因为"页面/浏览器已经关了"而抛错:那不是错误,吞掉 */
async function settle(action: Promise<void>): Promise<void> {
  try {
    await action
  } catch {
    // 渲染已结束或请求已被页面自己取消
  }
}

async function handleRoute(run: RenderRun, route: Route): Promise<void> {
  if (run.finished) return settle(route.abort())

  const req = route.request()
  let isMainFrame: boolean | undefined
  try {
    isMainFrame = req.frame() === run.page.mainFrame()
  } catch {
    // 没有所属框架的请求(理论上只有 service worker,而它已被禁用)
    isMainFrame = undefined
  }
  const resourceType = req.resourceType()
  const isNavigation = req.isNavigationRequest()
  // 主文档出任何岔子 = 整次渲染失败(带着对应的错误类);子资源出岔子只是这一个资源没有
  const isMainDocument = isNavigation && isMainFrame === true

  const info: RenderRequestInfo = {
    method: req.method(),
    url: req.url(),
    resourceType,
    isNavigationRequest: isNavigation,
    isMainFrame,
    budget: run.budget,
  }
  const decision = decideRequest(info)

  if (decision.action === 'abort') {
    if (isMainDocument) {
      run.failWith(
        decision.reason === 'scheme' || decision.reason === 'bad-url'
          ? new FetchDeniedError('页面跳转到了不允许的地址')
          : new FetchFailedError('页面加载被渲染策略中止'),
      )
    }
    return settle(route.abort('blockedbyclient'))
  }

  const cors = corsHeaders(req.headers()['origin'])

  if (decision.action === 'placeholder-image') {
    return settle(
      route.fulfill({
        status: 200,
        headers: { ...cors, 'content-type': 'image/png' },
        body: PLACEHOLDER_PNG,
      }),
    )
  }

  const release = await run.gate.acquire()
  try {
    // 排队期间渲染可能已经结束,预算也可能已被先到的请求花完——领到名额后用同一份规则重判一次
    if (run.finished) return await settle(route.abort())
    const timeoutMs = Math.min(run.budget.limits.subrequestTimeoutMs, run.deadline - Date.now())
    if (decideRequest(info).action !== 'fetch' || timeoutMs <= 0) {
      if (isMainDocument) run.failWith(new FetchFailedError('页面加载被渲染策略中止'))
      return await settle(route.abort('blockedbyclient'))
    }
    // 同一个资源的全部重定向跳共用一个时间预算:否则 3 跳能把 10s 变成 40s
    const resourceDeadline = Date.now() + timeoutMs
    let target = req.url()
    let res: SafeFetchHopResult
    for (let hopIndex = 0; ; hopIndex++) {
      // 每一跳都按同一份规则重判(协议、预算)并单独记账;URL 的主机/端口/内网归属由 safeFetchHop 判
      const hopInfo: RenderRequestInfo = { ...info, url: target }
      const remaining = resourceDeadline - Date.now()
      if (hopIndex > 0 && (decideRequest(hopInfo).action !== 'fetch' || remaining <= 0)) {
        return await settle(route.abort('blockedbyclient'))
      }
      chargeRequest(run.budget)
      try {
        res = await hopWithTimer(target, {
          maxBytes: grantBytes(run.budget),
          timeoutMs: remaining,
          accept: acceptFor(resourceType),
          allowForbiddenAddresses: run.allowForbiddenDev,
          transport: run.hop?.transport,
          lookup: run.hop?.lookup,
        })
      } catch (e) {
        if (isMainDocument) {
          run.failWith(
            e instanceof FetchDeniedError || e instanceof FetchFailedError || e instanceof FetchTooLargeError
              ? e
              : new FetchFailedError('页面抓取失败'),
          )
        }
        return await settle(route.abort())
      }
      if (res.kind !== 'redirect') break

      if (isMainDocument) {
        // 不能 fulfill 这个 30x:浏览器跟出去的下一跳不会再进到这个处理器(见文件头)。
        // 'aborted' 而不是默认的 'failed':ERR_ABORTED 不会让 Chromium 提交一张错误页,
        // 主框架不会因此落到 chrome-error:// 上误触导航守卫
        run.pendingRedirect = res.location
        return await settle(route.abort('aborted'))
      }
      if (hopIndex >= FETCH_URL_MAX_REDIRECTS) return await settle(route.abort())
      target = res.location
    }

    chargeBytes(run.budget, res.bytes.length)
    const contentType = sanitizeContentType(res.contentType)

    if (isMainDocument) {
      // 与 Tier 1(safeFetchUrl)同一语义:非 2xx 即失败。错误页渲染得再完整也不是用户要的那篇文章
      if (res.status < 200 || res.status >= 300) {
        run.failWith(new FetchFailedError(`上游返回 ${res.status}`))
        return await settle(route.abort())
      }
      if (!isHtmlContentType(contentType)) {
        run.failWith(new FetchFailedError('目标不是 HTML 页面,无法渲染'))
        return await settle(route.abort())
      }
    }

    // 上游响应头**一个都不透传**:set-cookie 会往上下文里种状态,CSP 会挡掉我们注入的捕获代理,
    // 其余的(HSTS、link 预加载、refresh…)各有各的副作用。只给 content-type 与合成的 CORS
    const headers: Record<string, string> = { ...cors }
    if (contentType) headers['content-type'] = contentType
    return await settle(route.fulfill({ status: res.status, headers, body: res.bytes }))
  } finally {
    release()
  }
}

/**
 * goto 之前的最后一道闸。**file: / chrome: / data: 这类地址根本不产生网络请求,context.route 拦不到**——
 * 把它们交给 page.goto,Chromium 会直接打开。http 层已经验过首个 URL,但重定向的 Location 是上游给的;
 * 而且渲染器不该假设调用方一定验过。
 */
function checkedTarget(raw: string): string {
  const checked = validateTargetUrl(raw)
  if (checked.ok) return checked.url.toString()
  if (checked.code === 'fetch-denied') throw new FetchDeniedError(checked.message)
  throw new FetchFailedError('页面跳转到了不合法的地址')
}

async function capture(run: RenderRun, url: string, isCommitted: () => boolean): Promise<RenderUrlResponse> {
  const { page } = run
  let target = checkedTarget(url)
  for (let hopIndex = 0; ; hopIndex++) {
    run.pendingRedirect = null
    try {
      // 只等到 domcontentloaded,**绝不等 load / networkidle**:实测这类页面 DOM 毫秒级就齐了,
      // 进程却能再挂两分钟等一个永远不结束的子资源。渲染是否"完了"由捕获代理的内容感知静默来判
      await page.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: Math.max(1, Math.min(NAV_TIMEOUT_MS, run.deadline - Date.now())),
      })
    } catch (e) {
      // 已提交的导航容忍超时/被后续跳转打断——文档已经在了,能抓多少抓多少;
      // 没提交就是没打开。(主文档层面的具体原因由 failWith 先一步带出,走不到这里的文案)
      if (run.pendingRedirect === null && !isCommitted()) {
        // goto 的错误文本来自 playwright/Chromium(net::ERR_* + 我们自己传进去的 URL),不含页面内容;
        // 排查"为什么打不开"全靠它,转义 + 截断后进日志
        run.log(`[render] goto failed: ${JSON.stringify(e instanceof Error ? e.message : String(e)).slice(0, 400)}`)
        throw new FetchFailedError('页面导航失败')
      }
    }
    const next: string | null = run.pendingRedirect
    if (next === null) break
    // 主文档的 30x:上面那次导航已被处理器中止,这里校验下一跳后重新发起一次**会被拦截**的导航
    if (hopIndex >= FETCH_URL_MAX_REDIRECTS) throw new FetchFailedError(`重定向超过 ${FETCH_URL_MAX_REDIRECTS} 跳`)
    target = checkedTarget(next)
  }

  const evaluate = (): Promise<unknown> => {
    const remaining = run.deadline - Date.now()
    const cfg: CaptureAgentConfig = {
      ...DEFAULT_CAPTURE_CONFIG,
      // collect() 模式不 postMessage,这个值用不上;给 '*' 只是满足形状
      parentOrigin: '*',
      // 代理的硬超时必须早于我们的总时长:到点它会"有什么序列化什么",总比被墙钟一刀切掉、
      // 什么都拿不到强
      hardTimeoutMs: Math.max(
        AGENT_MIN_HARD_TIMEOUT_MS,
        Math.min(DEFAULT_CAPTURE_CONFIG.hardTimeoutMs, remaining - AGENT_TAIL_MS),
      ),
    }
    return page.evaluate(buildAgentExpression(cfg))
  }

  let raw: unknown
  try {
    raw = await evaluate()
  } catch (e) {
    if (!isContextDestroyed(e)) throw new FetchFailedError('页面捕获失败')
    // 客户端跳转:等新文档解析完再跑一遍,只重试这一次
    try {
      await page.waitForLoadState('domcontentloaded', {
        timeout: Math.max(1, Math.min(NAV_TIMEOUT_MS, run.deadline - Date.now())),
      })
      raw = await evaluate()
    } catch {
      throw new FetchFailedError('页面捕获失败')
    }
  }
  return parseCapturePayload(raw)
}

/** 渲染过程中逐步建起来的句柄:收尾时有什么关什么(启动到一半被取消时后两个还是 null) */
interface RenderHandles {
  browser: Browser | null
  context: BrowserContext | null
  page: Page | null
  run: RenderRun | null
}

/** 关浏览器,最多等 CLOSE_TIMEOUT_MS。返回 false = 没关掉 */
async function closeWithin(h: RenderHandles): Promise<boolean> {
  const browser = h.browser
  if (!browser) return true
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS)
  })
  const closing = (async (): Promise<boolean> => {
    // 逐层关、每层各自吞错:上一层关失败不能挡住 browser.close()——真正回收进程的是它。
    // close 抛错 = 浏览器已经不在了,同样算关掉
    if (h.page) await h.page.close().catch(() => {})
    if (h.context) await h.context.close().catch(() => {})
    await browser.close().catch(() => {})
    return true
  })()
  try {
    return await Promise.race([closing, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

export function createRenderer(cfg: RenderConfig, deps: RendererDeps = {}): Renderer {
  const limits = deps.limits ?? DEFAULT_RENDER_LIMITS
  const totalTimeoutMs = deps.timeoutMs ?? RENDER_URL_TIMEOUT_MS
  const log = deps.log ?? ((line: string) => console.log(line))
  // 开发逃生口不是"整体关掉禁区检查":只对 fake-IP 网段放行,localhost/内网照拒(见 devLookup.ts)。
  // 测试注入的 lookup 优先——它们要的是完全可控的解析结果
  const hop: RendererDeps['hop'] = cfg.allowForbiddenDev
    ? { transport: deps.hop?.transport, lookup: deps.hop?.lookup ?? createFakeIpTolerantLookup() }
    : deps.hop
  const onCloseTimeout =
    deps.onCloseTimeout ??
    (() => {
      process.exit(1)
    })

  return async function render(url: string, signal: AbortSignal): Promise<RenderUrlResponse> {
    if (signal.aborted) throw abortError()
    const started = Date.now()

    // 唯一的失败出口:墙钟、取消、主文档错误、导航守卫、页面崩溃都汇到这里,先到者为准
    const failed: { error: Error | null } = { error: null }
    let rejectFailure: (e: Error) => void = () => {}
    const failure = new Promise<never>((_, reject) => {
      rejectFailure = reject
    })
    // 没人 race 它的时候(启动阶段、渲染结束之后)也不能变成未处理的 rejection
    failure.catch(() => {})
    const failWith = (e: Error): void => {
      if (failed.error) return
      failed.error = e
      rejectFailure(e)
    }

    const wallClock = setTimeout(() => failWith(new FetchFailedError('渲染超时')), totalTimeoutMs)
    const onAbort = (): void => failWith(abortError())
    signal.addEventListener('abort', onAbort, { once: true })

    const h: RenderHandles = { browser: null, context: null, page: null, run: null }
    try {
      // 防线依赖这个开关没被设置:设了,playwright 就不再追加 <-loopback>(args 里那条显式的仍在)
      delete process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK
      let browser: Browser
      try {
        // 启动不参与 race:它自带超时且到点会杀掉进程;race 掉它反而可能留下一个没人管的浏览器
        browser = await chromium.launch(buildLaunchOptions(cfg))
      } catch (e) {
        // 启动错误文本来自 playwright/Chromium 自身(此刻还没加载任何页面),可以进日志;仍转义 + 截断
        log(`[render] launch failed: ${JSON.stringify(e instanceof Error ? e.message : String(e)).slice(0, 600)}`)
        throw new RenderLaunchError('浏览器启动失败')
      }
      h.browser = browser
      // 启动期间被取消/超时:别再往下建上下文了
      if (failed.error) throw failed.error

      const work = (async (): Promise<RenderUrlResponse> => {
        const context = await browser.newContext(buildContextOptions())
        h.context = context
        const page = await context.newPage()
        h.page = page
        const run: RenderRun = {
          page,
          budget: createBudget(limits),
          gate: createSemaphore(limits.concurrency),
          allowForbiddenDev: cfg.allowForbiddenDev,
          hop,
          deadline: started + totalTimeoutMs,
          finished: false,
          pendingRedirect: null,
          failWith,
          log,
        }
        h.run = run

        // 弹窗/新标签页一律关掉:它们同样受 context.route 约束,但白占一个渲染进程
        context.on('page', (p) => {
          if (p !== page) void p.close().catch(() => {})
        })

        // 主框架导航守卫:顶层文档只许停在 http(s) 上。落到 chrome-error:// / about:blank / 其它协议
        // 都意味着我们即将序列化的不是目标页面
        let committed = false
        page.on('framenavigated', (frame) => {
          if (frame !== page.mainFrame()) return
          if (/^https?:\/\//i.test(frame.url())) {
            committed = true
            return
          }
          failWith(new FetchDeniedError('页面跳转到了不允许的地址'))
        })
        // 页面崩溃(含渲染进程被 cgroup OOM 杀掉):后面的 evaluate 只会一直挂到墙钟,不如立刻失败
        page.on('crash', () => failWith(new FetchFailedError('页面渲染进程崩溃')))

        await context.route('**/*', (route) => {
          void handleRoute(run, route)
        })
        return await capture(run, url, () => committed)
      })()
      // failure 先到时 work 还会在关浏览器的过程中抛错,那个错误没人要
      work.catch(() => {})

      const result = await Promise.race([work, failure])
      log(
        `[render] ok url=${logUrl(url)} ms=${Date.now() - started} requests=${h.run?.budget.requests ?? 0} ` +
          `bytes=${h.run?.budget.bytes ?? 0} html=${result.html.length} blockedScripts=${result.blockedScripts}`,
      )
      return result
    } catch (e) {
      // 只记错误类名:message 可能带上游状态/主机名,而 url 已单独转义输出
      log(`[render] fail url=${logUrl(url)} ms=${Date.now() - started} error=${errName(e)}`)
      throw e
    } finally {
      clearTimeout(wallClock)
      signal.removeEventListener('abort', onAbort)
      if (h.run) h.run.finished = true
      if (!(await closeWithin(h))) {
        log('[render] browser.close() 超过 5s 未返回,进程退出交给 systemd 回收')
        onCloseTimeout()
      }
    }
  }
}
