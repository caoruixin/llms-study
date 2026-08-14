import { Fragment, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, useDragControls } from 'framer-motion'
import { splitFences } from '../../lib/liteMd'
import type { LlmErrorKind } from '../../lib/llmClient'

export interface AskMsg {
  id: number
  role: 'user' | 'assistant'
  content: string
  quoted?: boolean // 引用卡
  pending?: boolean // 流式中的助手占位消息
}

interface Props {
  messages: AskMsg[]
  busy: boolean
  error: string
  errorKind: LlmErrorKind | null // 'auth' 时附「去设置」
  onSend: (text: string) => void
  onStop: () => void
  onClose: () => void
}

// 行内 `code` / **bold**：一个正则 split 即可，块级围栏交给 splitFences
const INLINE_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/
// 渲染期的行级增强（不进 liteMd）：## 标题 → 加粗，- 列表 → 圆点，仅此两种
const HEADING_RE = /^#{1,6}\s+(.*)$/
const BULLET_RE = /^(\s*)[-*]\s+(.*)$/

function renderInline(text: string) {
  return text.split(INLINE_RE).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={i} className="rounded bg-panel-2 px-1 py-0.5 text-[12px] text-accent">
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={i} className="font-semibold text-fg">
          {part.slice(2, -2)}
        </strong>
      )
    }
    return part
  })
}

function renderLine(line: string) {
  const heading = HEADING_RE.exec(line)
  if (heading) return <strong className="font-semibold text-fg">{renderInline(heading[1])}</strong>
  const bullet = BULLET_RE.exec(line)
  if (bullet) {
    return (
      <>
        {`${bullet[1]}• `}
        {renderInline(bullet[2])}
      </>
    )
  }
  return renderInline(line)
}

// 逐行渲染，换行符自己补回去（外层 whitespace-pre-wrap 负责显示）
function renderText(text: string) {
  return text.split('\n').map((line, i) => (
    <Fragment key={i}>
      {i > 0 && '\n'}
      {renderLine(line)}
    </Fragment>
  ))
}

function renderAssistant(content: string) {
  return splitFences(content).map((seg, i) =>
    seg.type === 'code' ? (
      <pre key={i} className="overflow-x-auto rounded-md border border-line bg-panel-2 p-3 text-xs">
        <code>{seg.text}</code>
      </pre>
    ) : (
      <div key={i} className="text-sm leading-relaxed break-words whitespace-pre-wrap">
        {renderText(seg.text)}
      </div>
    ),
  )
}

export default function AskDialog({ messages, busy, error, errorKind, onSend, onStop, onClose }: Props) {
  const [text, setText] = useState('')
  const constraintsRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true) // 粘底状态：用户上翻后不再抢滚动
  const controls = useDragControls()

  useEffect(() => {
    const el = listRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  // 发送前 trim 校验 → 快照 → 立即清空输入框（失败不回填，错误行可见）
  function submit() {
    const value = text.trim()
    if (!value || busy) return
    setText('')
    stickRef.current = true // 只有自己发消息才重新粘底；流式增量仍不抢用户上翻的滚动
    onSend(value)
  }

  return (
    <div
      ref={constraintsRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
      className="pointer-events-none fixed inset-0 z-50"
    >
      <motion.div
        drag
        dragListener={false}
        dragControls={controls}
        dragMomentum={false}
        dragElastic={0}
        dragConstraints={constraintsRef}
        data-ask-ui=""
        role="dialog"
        aria-labelledby="ask-title"
        aria-modal="false"
        className="pointer-events-auto absolute right-6 bottom-6 flex max-h-[70dvh] w-[min(560px,calc(100vw-2rem))] flex-col rounded-xl border border-line bg-panel shadow-xl"
      >
        {/* 仅标题栏可拖 */}
        <div
          onPointerDown={(e) => controls.start(e)}
          className="flex cursor-move touch-none items-center gap-2 border-b border-line px-4 py-2.5 select-none"
        >
          <span id="ask-title" className="text-sm font-semibold text-accent">
            Ask LLM
          </span>
          <span aria-live="polite" className="flex flex-1 items-center gap-1.5 text-xs text-dim">
            {busy && (
              <>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                回答中…
              </>
            )}
          </span>
          {/* stopPropagation：否则拖拽手势会吃掉这一下 click */}
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onClose}
            aria-label="关闭对话"
            className="rounded px-1.5 text-lg leading-none text-dim transition-colors hover:text-fg"
          >
            ×
          </button>
        </div>

        <div
          ref={listRef}
          onScroll={() => {
            const el = listRef.current
            if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          }}
          className="flex-1 space-y-3 overflow-y-auto p-4"
        >
          {messages.map((m) =>
            m.quoted ? (
              <div
                key={m.id}
                className="max-h-32 overflow-y-auto border-l-2 border-accent bg-panel-2 px-3 py-2 text-xs break-words whitespace-pre-wrap text-dim"
              >
                {m.content}
              </div>
            ) : m.role === 'user' ? (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-lg bg-accent/15 px-3 py-2 text-sm break-words whitespace-pre-wrap">
                  {m.content}
                </div>
              </div>
            ) : m.pending && m.content === '' ? (
              <div key={m.id} className="animate-pulse text-sm text-dim">
                …
              </div>
            ) : (
              <div key={m.id} className="space-y-2">
                {renderAssistant(m.content)}
              </div>
            ),
          )}
        </div>

        <div className="border-t border-line p-3">
          {error && (
            <p className="mb-2 text-xs text-bad">
              {error}
              {errorKind === 'auth' && (
                <Link to="/settings" className="ml-2 underline hover:text-accent">
                  去设置
                </Link>
              )}
            </p>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // 中文输入法回车（isComposing）不误发；流式中 Enter 吞掉即可——既不发第二次请求，也不给预打字插入换行
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                if (!busy) submit()
              }
            }}
            autoFocus
            rows={2}
            placeholder="就选中内容提问，Enter 发送 / Shift+Enter 换行"
            className="w-full resize-y rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm leading-relaxed"
          />
          <div className="mt-2 flex items-center justify-end gap-3">
            {busy ? (
              <button
                onClick={onStop}
                className="rounded-lg border border-line bg-panel px-4 py-1.5 text-sm font-medium text-bad transition-colors hover:bg-panel-2"
              >
                ■ 停止
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={busy || !text.trim()}
                className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
              >
                发送
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  )
}
