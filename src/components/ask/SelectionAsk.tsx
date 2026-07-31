import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { chatStream, LlmError } from '../../lib/llmClient'
import type { LlmErrorKind } from '../../lib/llmClient'
import { useSettings } from '../../store'
import { NAV } from '../../nav'
import AskDialog from './AskDialog'
import type { AskMsg } from './AskDialog'

const SYSTEM_PROMPT = `你是「LLM Infra Studio」站内答疑助手。这个站点用于准备 LLM 基础设施 /
Token 与算力售前方向的面试，用户会框选页面上的内容并向你提问。
回答要求：
- 中文作答，面向面试表达：先给一句简明结论，再展开关键机制与取舍；
- 适当补充数量级、成本与业务视角（这是售前面试的加分项）；
- 严格围绕引用的选中内容作答，不确定的信息明确说明，不要编造；
- 代码、公式、配置用 markdown 代码块，保持简洁。`

interface BtnState {
  x: number
  y: number
  snippet: string
  pageLabel: string // 选中那一刻的页面，路由切换后引用也不会张冠李戴
}

function friendlyError(e: unknown): { msg: string; kind: LlmErrorKind | null } {
  if (e instanceof LlmError) {
    switch (e.kind) {
      case 'auth':
        return { msg: 'API key 无效或未配置：请到设置页粘贴 key，或配置 .env.local 后重启 dev', kind: 'auth' }
      case 'rate-limit':
        return { msg: '触发上游限流（429），请稍后重试', kind: e.kind }
      case 'timeout':
        return { msg: '请求超时，可以重试或换个更快的模型', kind: e.kind }
      case 'network':
        return { msg: `网络异常：${e.message}`, kind: e.kind }
      case 'bad-response':
        return { msg: `上游返回异常：${e.message}`, kind: e.kind }
      case 'server':
        return { msg: `上游报错：${e.message}`, kind: e.kind }
    }
  }
  return { msg: e instanceof Error ? `出错了：${e.message}` : '出错了，请重试', kind: null }
}

export default function SelectionAsk() {
  const [btn, setBtn] = useState<BtnState | null>(null)
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<AskMsg[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [errorKind, setErrorKind] = useState<LlmErrorKind | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const sessionRef = useRef(0) // 会话代数：竞态防护核心，关闭即 +1
  const idRef = useRef(0)
  const nextId = () => ++idRef.current

  const settings = useSettings()
  const { pathname } = useLocation()
  // 选区 effect 空依赖（不能因换路由重挂监听），当前路由靠 ref 在渲染期同步进去
  const pathnameRef = useRef(pathname)
  pathnameRef.current = pathname

  // 路由切换时 React 卸载选区所在节点不会触发 selectionchange → 按钮会残留，显式收起
  useEffect(() => {
    setBtn(null)
  }, [pathname])

  // 选区监听：单 effect + 对称 cleanup（含 timer），StrictMode 双跑安全
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const clear = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
    const inAskUi = (node: EventTarget | null): boolean => {
      const el = node instanceof Element ? node : node instanceof Node ? node.parentElement : null
      return el !== null && el.closest('[data-ask-ui]') !== null
    }
    // 排除对话框/浮动按钮自身，以及表单控件——设置页密码框里的 API key 绝不可能被引用外发
    const excluded = (node: EventTarget | null): boolean => {
      const el = node instanceof Element ? node : node instanceof Node ? node.parentElement : null
      if (!el) return true
      return inAskUi(el) || el.closest('textarea, input') !== null
    }

    const onPointerUp = (e: PointerEvent) => {
      clear()
      if (excluded(e.target)) return
      // 延后一拍读选区：pointerup 当帧 selection 还可能是旧值
      timer = setTimeout(() => {
        timer = null
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
        const snippet = sel.toString().trim()
        if (snippet.length < 2) return
        if (excluded(sel.anchorNode)) return
        const r = sel.getRangeAt(0).getBoundingClientRect()
        const x = Math.min(Math.max(r.left + r.width / 2 - 44, 8), window.innerWidth - 96)
        const y = r.top > 96 ? r.top - 38 : r.bottom + 8 // 顶部空间不够就翻到选区下方
        const path = pathnameRef.current
        setBtn({ x, y, snippet, pageLabel: NAV.find((n) => n.to === path)?.label ?? path })
      }, 0)
    }

    // 点他处 / Esc / 路由跳转导致选区塌陷 → 收起按钮
    const onSelectionChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.toString().trim() === '') {
        clear()
        setBtn(null)
      }
    }

    // capture 阶段能听到任意后代滚动：对话框自己的消息列表（流式自动滚底/滚轮）不算页面滚动，放行
    const onScroll = (e: Event) => {
      if (inAskUi(e.target)) return
      clear()
      setBtn(null)
    }

    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('selectionchange', onSelectionChange)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      clear()
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [])

  // 对话框开着时 = 追加引用；不自动发送，引用卡先可见
  function onAsk() {
    const selected = btn // strict 下 btn 为 X | null，先快照收窄
    if (!selected) return
    const quote: AskMsg = {
      id: nextId(),
      role: 'user',
      quoted: true,
      content: `我在「${selected.pageLabel}」页选中了以下内容：\n"""\n${selected.snippet.slice(0, 4000)}\n"""`,
    }
    setMessages((m) => (open ? [...m, quote] : [quote]))
    setOpen(true)
    setError('')
    setErrorKind(null)
    setBtn(null)
  }

  async function send(text: string) {
    if (busy || abortRef.current) return // 单会话单 in-flight 硬守卫
    const gen = sessionRef.current
    const userMsg: AskMsg = { id: nextId(), role: 'user', content: text }
    const holderId = nextId()
    const history = [...messages, userMsg] // 本轮上下文快照：必须在插入占位消息之前取
    setMessages((m) => [...m, userMsg, { id: holderId, role: 'assistant', content: '', pending: true }])
    setBusy(true)
    setError('')
    setErrorKind(null)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    let partial = '' // 供 catch 判断是否保留了半截内容
    try {
      const full = await chatStream({
        provider: settings.provider,
        model: settings.model,
        userKey: settings.userKey || undefined,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...history.map(({ role, content }) => ({ role, content })),
        ],
        signal: ctrl.signal,
        onDelta: (d) => {
          partial += d
          if (gen !== sessionRef.current) return
          setMessages((m) => m.map((x) => (x.id === holderId ? { ...x, content: x.content + d } : x)))
        },
      })
      if (gen !== sessionRef.current) return
      setMessages((m) =>
        full
          ? m.map((x) => (x.id === holderId ? { ...x, content: full, pending: false } : x))
          : m.filter((x) => x.id !== holderId), // 空回答移除占位
      )
    } catch (e) {
      if (gen !== sessionRef.current) return
      const { msg, kind } = friendlyError(e)
      // 半截内容保留为普通消息并提示「响应中断」；无内容则移除占位
      setError(partial ? `响应中断：${msg}（已保留部分内容）` : msg)
      setErrorKind(kind)
      setMessages((m) =>
        m
          .map((x) => (x.id === holderId && x.content ? { ...x, pending: false } : x))
          .filter((x) => !(x.id === holderId && !x.content)),
      )
    } finally {
      if (abortRef.current === ctrl) {
        // 所有权匹配才收尾：Close 后新会话的 controller 不会被旧请求清掉
        if (gen === sessionRef.current) setBusy(false)
        abortRef.current = null
      }
    }
  }

  // Stop：不动 sessionRef → chatStream 正常 resolve 半截文本，占位转正保留
  function onStop() {
    abortRef.current?.abort()
  }

  // Close：先升代数、再交出所有权后 abort，旧请求的任何后续写入都会被丢弃（关掉即忘）
  function onClose() {
    sessionRef.current++
    const old = abortRef.current
    abortRef.current = null
    old?.abort()
    setMessages([])
    setBusy(false)
    setError('')
    setErrorKind(null)
    setOpen(false)
  }

  return (
    <>
      {btn && (
        <button
          data-ask-ui=""
          aria-label="就选中内容提问"
          onPointerDown={(e) => e.preventDefault()} // 防选区塌陷 / 抢焦点
          onClick={onAsk}
          style={{ left: btn.x, top: btn.y }}
          className="fixed z-50 rounded-md border border-line bg-panel-2 px-2.5 py-1 text-xs text-accent shadow-lg"
        >
          Ask LLM
        </button>
      )}
      {open && (
        <AskDialog
          messages={messages}
          busy={busy}
          error={error}
          errorKind={errorKind}
          onSend={send}
          onStop={onStop}
          onClose={onClose}
        />
      )}
    </>
  )
}
