// @vitest-environment happy-dom
// @vitest-environment-options { "settings": { "disableCSSFileLoading": true, "disableJavaScriptFileLoading": true, "disableJavaScriptEvaluation": true } }
import { describe, expect, it } from 'vitest'
import { captureRendered, CaptureError, isCaptureMessage } from './captureRendered'
import { CAPTURE_AGENT_VERSION, type CaptureAgentMessage } from './captureAgent'

/**
 * 父页驱动的单测。iframe 建在**未接入文档树**的 div 里（happy-dom 不会真的去加载 srcdoc），
 * `contentWindow` 用 defineProperty 顶掉，父窗口是手写的假窗口——消息由测试直接喂给注册的监听器，
 * 因为跨源 MessageEvent 的 `source` 在 happy-dom 里造不出来。
 * 真正的来源校验逻辑抽成了纯函数 `isCaptureMessage`，单独打。
 */

interface Harness {
  doc: Document
  body: HTMLElement
  parentWindow: Window
  contentWindow: Window
  created: HTMLIFrameElement[]
  listeners: Array<(event: Event) => void>
  send: (data: unknown, over?: { source?: unknown; origin?: string }) => void
}

function harness(): Harness {
  const body = document.createElement('div')
  const contentWindow = { label: 'capture-frame' } as unknown as Window
  const created: HTMLIFrameElement[] = []
  const doc = {
    body,
    createElement: (tag: string) => {
      const el = document.createElement(tag)
      if (tag === 'iframe') {
        Object.defineProperty(el, 'contentWindow', { value: contentWindow, configurable: true })
        created.push(el as HTMLIFrameElement)
      }
      return el
    },
  } as unknown as Document

  const listeners: Array<(event: Event) => void> = []
  const parentWindow = {
    location: { origin: 'https://app.example' },
    addEventListener: (type: string, fn: (event: Event) => void) => {
      if (type === 'message') listeners.push(fn)
    },
    removeEventListener: (_type: string, fn: (event: Event) => void) => {
      const at = listeners.indexOf(fn)
      if (at >= 0) listeners.splice(at, 1)
    },
  } as unknown as Window

  const send = (data: unknown, over: { source?: unknown; origin?: string } = {}): void => {
    const event = {
      data,
      origin: over.origin ?? 'null',
      source: 'source' in over ? over.source : contentWindow,
    } as unknown as Event
    for (const fn of listeners.slice()) fn(event)
  }

  return { doc, body, parentWindow, contentWindow, created, listeners, send }
}

const INPUT = { html: '<html><head><title>站点</title></head><body><p>hi</p></body></html>', finalUrl: 'https://ex.com/a/b.html' }

const okMessage = (over: Record<string, unknown> = {}): CaptureAgentMessage =>
  ({
    type: 'pc-capture',
    ok: true,
    html: '<html><body><p>rendered</p></body></html>',
    title: '渲染后的标题',
    finalUrl: 'https://ex.com/a/b.html',
    viewportWidth: 1280,
    hidden: 3,
    fixed: 1,
    blockedScripts: 0,
    agentVersion: 2,
    ...over,
  }) as CaptureAgentMessage

async function until(pred: () => boolean, budgetMs = 2000): Promise<void> {
  const started = Date.now()
  while (!pred()) {
    if (Date.now() - started > budgetMs) throw new Error('超时：条件未满足')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

describe('isCaptureMessage', () => {
  const iframe = { contentWindow: { label: 'frame' } } as unknown as HTMLIFrameElement
  const event = (over: Record<string, unknown>): MessageEvent =>
    ({ source: iframe.contentWindow, origin: 'null', data: { type: 'pc-capture' }, ...over }) as unknown as MessageEvent

  it('三条同时满足才认：来自该 iframe 的窗口、不透明源、pc-capture 消息', () => {
    expect(isCaptureMessage(event({}), iframe)).toBe(true)
  })

  it('别的窗口冒充 → 不认', () => {
    expect(isCaptureMessage(event({ source: { label: 'other' } }), iframe)).toBe(false)
    expect(isCaptureMessage(event({ source: null }), iframe)).toBe(false)
  })

  it('非不透明源 → 不认（同源页面/扩展发来的一律丢弃）', () => {
    expect(isCaptureMessage(event({ origin: 'https://app.example' }), iframe)).toBe(false)
    expect(isCaptureMessage(event({ origin: '' }), iframe)).toBe(false)
  })

  it('不是 pc-capture 消息体 → 不认', () => {
    expect(isCaptureMessage(event({ data: { type: 'other' } }), iframe)).toBe(false)
    expect(isCaptureMessage(event({ data: 'pc-capture' }), iframe)).toBe(false)
    expect(isCaptureMessage(event({ data: null }), iframe)).toBe(false)
  })
})

describe('captureRendered', () => {
  it('iframe 的沙箱恰为 allow-scripts，且在视口内隐身而非 display:none', async () => {
    const h = harness()
    const promise = captureRendered(INPUT, {
      doc: h.doc,
      parentWindow: h.parentWindow,
      config: { quietMs: 123 },
      outerTimeoutMs: 2000,
    })
    await until(() => h.created.length === 1)
    const iframe = h.created[0]

    // 只给 allow-scripts：再加 allow-same-origin 等于把沙箱拆了
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(iframe.getAttribute('aria-hidden')).toBe('true')
    expect(iframe.getAttribute('tabindex')).toBe('-1')
    const style = iframe.getAttribute('style') ?? ''
    expect(style).toContain('position:fixed')
    expect(style).toContain('opacity:0')
    expect(style).toContain('pointer-events:none')
    expect(style).not.toContain('display:none')
    expect(style).not.toContain('-9999')
    expect(h.body.contains(iframe)).toBe(true)

    const srcdoc = iframe.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain('Content-Security-Policy')
    expect(srcdoc).toContain(`<base href="${INPUT.finalUrl}">`)
    // parentOrigin 来自父窗口 location，quietMs 是调用方覆盖值
    expect(srcdoc).toContain('"parentOrigin":"https://app.example"')
    expect(srcdoc).toContain('"quietMs":123')

    h.send(okMessage())
    await promise
  })

  it('收到合法消息 → 解析成 RenderedCapture，并把 iframe 摘掉', async () => {
    const h = harness()
    const promise = captureRendered(INPUT, { doc: h.doc, parentWindow: h.parentWindow, outerTimeoutMs: 2000 })
    await until(() => h.created.length === 1)
    h.send(okMessage())
    await expect(promise).resolves.toEqual({
      html: '<html><body><p>rendered</p></body></html>',
      title: '渲染后的标题',
      finalUrl: 'https://ex.com/a/b.html',
      viewportWidth: 1280,
      hidden: 3,
      fixed: 1,
      blockedScripts: 0,
      agentVersion: 2,
    })
    expect(h.body.children).toHaveLength(0)
    expect(h.listeners).toHaveLength(0)
  })

  it('blockedScripts 原样带出；字段缺失（v1 代理）或不是有限数一律按 0', async () => {
    const run = async (over: Record<string, unknown>): Promise<unknown> => {
      const h = harness()
      const promise = captureRendered(INPUT, { doc: h.doc, parentWindow: h.parentWindow, outerTimeoutMs: 2000 })
      await until(() => h.created.length === 1)
      h.send(okMessage(over))
      return promise
    }
    await expect(run({ blockedScripts: 3 })).resolves.toMatchObject({ blockedScripts: 3 })
    // v1 代理的消息里压根没有这个字段；agentVersion 如实保留 1，不被「升级」
    await expect(run({ blockedScripts: undefined, agentVersion: 1 })).resolves.toMatchObject({
      blockedScripts: 0,
      agentVersion: 1,
    })
    // 消息来自不可信的沙箱：站点脚本可以伪造任意形状
    await expect(run({ blockedScripts: Number.NaN })).resolves.toMatchObject({ blockedScripts: 0 })
    await expect(run({ blockedScripts: Number.POSITIVE_INFINITY })).resolves.toMatchObject({ blockedScripts: 0 })
    await expect(run({ blockedScripts: '7' })).resolves.toMatchObject({ blockedScripts: 0 })
    await expect(run({ blockedScripts: null })).resolves.toMatchObject({ blockedScripts: 0 })
  })

  it('agentVersion 缺失时回落到当前代理版本（2）', async () => {
    const h = harness()
    const promise = captureRendered(INPUT, { doc: h.doc, parentWindow: h.parentWindow, outerTimeoutMs: 2000 })
    await until(() => h.created.length === 1)
    h.send(okMessage({ agentVersion: undefined }))
    await expect(promise).resolves.toMatchObject({ agentVersion: CAPTURE_AGENT_VERSION })
    expect(CAPTURE_AGENT_VERSION).toBe(2)
  })

  it('finalUrl 为空时回落到入参', async () => {
    const h = harness()
    const promise = captureRendered(INPUT, { doc: h.doc, parentWindow: h.parentWindow, outerTimeoutMs: 2000 })
    await until(() => h.created.length === 1)
    h.send(okMessage({ finalUrl: '' }))
    await expect(promise).resolves.toMatchObject({ finalUrl: INPUT.finalUrl })
  })

  it('来源或 origin 不对的消息一律忽略（最终走超时）', async () => {
    const h = harness()
    const promise = captureRendered(INPUT, { doc: h.doc, parentWindow: h.parentWindow, outerTimeoutMs: 120 })
    await until(() => h.created.length === 1)
    h.send(okMessage(), { source: { label: 'evil' } })
    h.send(okMessage(), { origin: 'https://evil.example' })
    h.send({ type: 'something-else' })
    await expect(promise).rejects.toMatchObject({ reason: 'timeout' })
    expect(h.body.children).toHaveLength(0)
  })

  it('超时 → CaptureError(timeout)，iframe 与监听器都清干净', async () => {
    const h = harness()
    const promise = captureRendered(INPUT, { doc: h.doc, parentWindow: h.parentWindow, outerTimeoutMs: 40 })
    await expect(promise).rejects.toBeInstanceOf(CaptureError)
    expect(h.body.children).toHaveLength(0)
    expect(h.listeners).toHaveLength(0)
  })

  it('代理回 too-large / 其它失败 → 对应的 CaptureError', async () => {
    const big = harness()
    const p1 = captureRendered(INPUT, { doc: big.doc, parentWindow: big.parentWindow, outerTimeoutMs: 2000 })
    await until(() => big.created.length === 1)
    big.send({ type: 'pc-capture', ok: false, reason: 'too-large', blockedScripts: 0, agentVersion: 2 })
    await expect(p1).rejects.toMatchObject({ reason: 'too-large' })
    expect(big.body.children).toHaveLength(0)

    const bad = harness()
    const p2 = captureRendered(INPUT, { doc: bad.doc, parentWindow: bad.parentWindow, outerTimeoutMs: 2000 })
    await until(() => bad.created.length === 1)
    // v1 形状的失败消息（没有 blockedScripts）照样认
    bad.send({ type: 'pc-capture', ok: false, reason: 'TypeError: boom', agentVersion: 1 })
    await expect(p2).rejects.toMatchObject({ reason: 'agent-error' })
    await expect(p2).rejects.toThrow(/boom/)
  })

  it('模块级串行：第二个捕获要等第一个收尾才建 iframe', async () => {
    const h = harness()
    const opts = { doc: h.doc, parentWindow: h.parentWindow, outerTimeoutMs: 2000 }
    const first = captureRendered(INPUT, opts)
    const second = captureRendered(INPUT, opts)

    await until(() => h.created.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.created).toHaveLength(1)
    expect(h.body.children).toHaveLength(1)

    h.send(okMessage({ title: '第一个' }))
    await expect(first).resolves.toMatchObject({ title: '第一个' })

    await until(() => h.created.length === 2)
    h.send(okMessage({ title: '第二个' }))
    await expect(second).resolves.toMatchObject({ title: '第二个' })
    expect(h.body.children).toHaveLength(0)
  })

  it('取消信号：捕获中途 abort → 抛 AbortError 并摘掉 iframe', async () => {
    const h = harness()
    const controller = new AbortController()
    const promise = captureRendered(INPUT, {
      doc: h.doc,
      parentWindow: h.parentWindow,
      outerTimeoutMs: 2000,
      signal: controller.signal,
    })
    await until(() => h.created.length === 1)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.body.children).toHaveLength(0)
    expect(h.listeners).toHaveLength(0)
  })

  it('信号已经是 aborted → 立刻拒绝，连 iframe 都不建', async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort()
    await expect(
      captureRendered(INPUT, { doc: h.doc, parentWindow: h.parentWindow, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.created).toHaveLength(0)
  })

  it('没有可用 DOM → CaptureError(unavailable)', async () => {
    const h = harness()
    await expect(
      captureRendered(INPUT, { doc: {} as unknown as Document, parentWindow: h.parentWindow }),
    ).rejects.toMatchObject({ reason: 'unavailable' })
  })
})
