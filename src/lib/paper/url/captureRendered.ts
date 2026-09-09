import { abortError } from './abort'
import {
  buildCaptureSrcdoc,
  CAPTURE_AGENT_VERSION,
  DEFAULT_CAPTURE_CONFIG,
  type CaptureAgentConfig,
  type CaptureAgentMessage,
} from './captureAgent'

/**
 * 网页原貌导入 Tier 2 的**父页驱动**（PLAN-web-snapshot-sync.md §2.2 第 2 条）。
 *
 * 把站点 HTML 塞进一个 `sandbox="allow-scripts"` 的 iframe 里跑起来，等注入的捕获代理
 * （captureAgent.ts）postMessage 回一份渲染后的 HTML。本模块不发任何网络请求：
 * 入参就是 fetchUrl 已经取回的字节解码结果，iframe 里的站点脚本自己去拉它需要的资源。
 *
 * 三条安全线，改代码时不要动：
 * 1. sandbox **只给** `allow-scripts`：不给 `allow-same-origin`，iframe 是不透明源——
 *    站点脚本读不到我们的 cookie/localStorage/IndexedDB（在里面访问会抛 SecurityError），
 *    也访问不了 `parent` 的任何东西。两者同时给等于没有沙箱。
 * 2. 收消息时**同时**校验 `event.source === iframe.contentWindow` 与 `event.origin === 'null'`：
 *    前者挡住别的 iframe/窗口冒充，后者确认它确实来自不透明源（同源的消息一律不认）。
 * 3. iframe **不能** display:none 或移出视口：`IntersectionObserver` 与 `loading=lazy`
 *    按父视口几何算可见性，藏起来的 iframe 里懒加载图片永远不会开始加载。
 *    所以它就摆在视口左上角，靠 opacity:0 + pointer-events:none + z-index:-1 隐身。
 *
 * 模块级串行：同一时刻只跑一个捕获——一个渲染中的页面就足以吃满 CPU 与带宽，
 * 并行只会让每一个都更慢、更容易撞上超时。
 */

export type CaptureErrorReason = 'timeout' | 'too-large' | 'agent-error' | 'unavailable'

export class CaptureError extends Error {
  constructor(
    public readonly reason: CaptureErrorReason,
    message: string,
  ) {
    super(message)
    this.name = 'CaptureError'
  }
}

export interface RenderedCapture {
  /** 渲染后的 `documentElement.outerHTML`（未 sanitize、未打标，父页后续处理） */
  html: string
  title: string
  /** 代理回报的 `document.baseURI`，即我们注入的 `<base href>`；空则回落入参 finalUrl */
  finalUrl: string
  viewportWidth: number
  hidden: number
  fixed: number
  /**
   * 代理脚本版本，原样进快照头 `capture.agentVersion`（buildSnapshot 只把它当可选字段，
   * 但写死 1 会让将来改了代理的快照说谎，所以这里如实回传）。
   */
  agentVersion: number
}

export interface CaptureRenderedOptions {
  signal?: AbortSignal
  config?: Partial<Omit<CaptureAgentConfig, 'parentOrigin'>>
  /** 外层超时：默认比代理自己的硬超时多 `SERIALIZE_HEADROOM_MS`，留给硬超时那一刻才开始的序列化 */
  outerTimeoutMs?: number
  /** 注入点（测试用）：iframe 建在哪个文档、消息监听挂在哪个窗口 */
  doc?: Document
  parentWindow?: Window
}

/**
 * 代理硬超时之后再留给父页的窗口。
 *
 * 硬超时到点时代理**才刚开始** `finish()`（annotate + cloneNode(true) + 九次树遍历 + outerHTML +
 * encode）。原来只留 2s，2MB 级文档做不完——父页先超时、iframe 被移除，代理消息永远送不到，
 * 于是一次「其实能抓到」的捕获被记成 timeout。给足余量，让慢但有效的捕获能落地。
 */
const SERIALIZE_HEADROOM_MS = 8000

/** 在视口内但完全隐身：见文件头第 3 条，不能换成 display:none / left:-9999px */
const IFRAME_STYLE =
  'position:fixed; left:0; top:0; width:min(1280px,100vw); height:100vh; opacity:0; pointer-events:none; z-index:-1; border:0'

/**
 * 消息校验（纯函数，单测直接打）：必须来自我们那个 iframe 的窗口、必须是不透明源、
 * 必须是捕获代理的消息类型。三条缺一不可。
 */
export function isCaptureMessage(event: MessageEvent, iframe: HTMLIFrameElement): boolean {
  if (event.source !== iframe.contentWindow) return false
  // 不透明源（sandbox 无 allow-same-origin）的 origin 序列化就是字符串 'null'
  if (event.origin !== 'null') return false
  const data = event.data as { type?: unknown } | null | undefined
  return !!data && typeof data === 'object' && data.type === 'pc-capture'
}

/**
 * postMessage 的 targetOrigin。file: 协议或其它不透明源下 `location.origin` 是 `'null'`/空串，
 * 这两个值 postMessage 不接受（会抛 SyntaxError），只能回退 `'*'`——
 * 消息体本身只是这份 HTML，且接收方（上面的 isCaptureMessage）仍然校验 source 与 origin。
 */
function parentOriginOf(win: Window): string {
  let origin = ''
  try {
    origin = String(win.location?.origin ?? '')
  } catch {
    origin = ''
  }
  return origin && origin !== 'null' ? origin : '*'
}

const ABORT_MESSAGE = '渲染捕获已取消'

function runCapture(
  input: { html: string; finalUrl: string },
  opts: CaptureRenderedOptions,
): Promise<RenderedCapture> {
  const doc = opts.doc ?? (typeof document === 'undefined' ? null : document)
  const parentWindow = opts.parentWindow ?? (typeof window === 'undefined' ? null : window)
  if (!doc?.body || !parentWindow) {
    return Promise.reject(new CaptureError('unavailable', '当前环境不支持渲染捕获（没有可用的 DOM）'))
  }
  const signal = opts.signal
  if (signal?.aborted) return Promise.reject(abortError(ABORT_MESSAGE, signal))

  const cfg: CaptureAgentConfig = {
    ...DEFAULT_CAPTURE_CONFIG,
    ...opts.config,
    parentOrigin: parentOriginOf(parentWindow),
  }
  const outerTimeoutMs = opts.outerTimeoutMs ?? cfg.hardTimeoutMs + SERIALIZE_HEADROOM_MS

  const iframe = doc.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.setAttribute('referrerpolicy', 'no-referrer')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.setAttribute('tabindex', '-1')
  iframe.setAttribute('style', IFRAME_STYLE)

  let onMessage: ((event: Event) => void) | null = null
  let onAbort: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const settled = new Promise<CaptureAgentMessage>((resolve, reject) => {
    onMessage = (event: Event): void => {
      if (!isCaptureMessage(event as MessageEvent, iframe)) return
      resolve((event as MessageEvent).data as CaptureAgentMessage)
    }
    parentWindow.addEventListener('message', onMessage)
    if (signal) {
      onAbort = (): void => reject(abortError(ABORT_MESSAGE, signal))
      signal.addEventListener('abort', onAbort, { once: true })
    }
    timer = setTimeout(() => {
      reject(new CaptureError('timeout', '页面渲染超时（' + outerTimeoutMs + 'ms），未能完成原貌抓取'))
    }, outerTimeoutMs)
    // 先挂监听再插 iframe：srcdoc 里的代理理论上可以在 load 前就同步 postMessage
    iframe.srcdoc = buildCaptureSrcdoc(input.html, input.finalUrl, cfg)
    doc.body.appendChild(iframe)
  })

  return settled
    .then((message) => {
      if (!message.ok) {
        if (message.reason === 'too-large') {
          throw new CaptureError('too-large', '渲染结果超过大小上限（8MB）')
        }
        throw new CaptureError('agent-error', '页面渲染捕获失败：' + message.reason)
      }
      return {
        html: message.html,
        title: message.title,
        finalUrl: message.finalUrl || input.finalUrl,
        viewportWidth: message.viewportWidth,
        hidden: message.hidden,
        fixed: message.fixed,
        agentVersion: Number.isFinite(message.agentVersion) ? message.agentVersion : CAPTURE_AGENT_VERSION,
      }
    })
    .finally(() => {
      if (timer !== undefined) clearTimeout(timer)
      if (onMessage) parentWindow.removeEventListener('message', onMessage)
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      iframe.remove()
    })
}

/** 模块级串行链：任何结局（成功/失败/取消）都只放行下一个，不让两个捕获同时跑 */
let queue: Promise<unknown> = Promise.resolve()

/**
 * 渲染一份站点 HTML 并取回捕获结果。失败一律是 `CaptureError`（调用方据此回退 Tier 1 静态捕获），
 * 主动取消则原样抛 `AbortError`。
 */
export function captureRendered(
  input: { html: string; finalUrl: string },
  opts: CaptureRenderedOptions = {},
): Promise<RenderedCapture> {
  const next = queue.catch(() => undefined).then(() => runCapture(input, opts))
  queue = next.catch(() => undefined)
  return next
}
