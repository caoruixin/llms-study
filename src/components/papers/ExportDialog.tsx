import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { PAPER_TASKS } from '../../data/paperPolicy'
import { FLAVOR_LABEL } from '../../lib/paper/export/exportFlavor'
import type { ExportFlavor, ExportProgress, ExportResult } from '../../lib/paper/export/exportPaper'
import { estimateTranslationCost, hasTranslatableText } from '../../lib/paper/translate/translateBatch'
import type {
  TranslateAllHalt,
  TranslateAllOptions,
  TranslateAllProgress,
  TranslateAllResult,
} from '../../lib/paper/translate/useTranslations'
import type { PaperBlock, PaperRecord } from '../../lib/paper/types'
import { formatUsd } from '../../lib/paper/usage'

/**
 * 导出 PDF 对话框（PLAN A.7）：confirm（有缺译才出现）→ translating（全篇补译）→ generating → done / error。
 * - 导出内核 exportPaper 只在这里动态 import：pdf-lib / 字体 / 规划器都不进工作台 chunk；
 * - 补译完成后用 translateAll 返回的译文快照导出（React 态可能还没追上最后一包）；
 * - 取消 = abort（已发出的翻译包照常落库）；卸载即 abort；Esc 只在 confirm / done / error 生效，
 *   进行中的阶段必须点「取消」，免得误触把几分钟的补译打断；
 * - 页面把本组件渲染在 ConsentDialog 之前（同为 fixed inset-0 z-50），补译中弹出的授权框靠 DOM 序压在上面。
 */

type ExportModule = typeof import('../../lib/paper/export/exportPaper')
const loadExportModule = (): Promise<ExportModule> => import('../../lib/paper/export/exportPaper')

type Phase =
  | { kind: 'confirm' }
  | { kind: 'translating'; progress: TranslateAllProgress | null }
  | { kind: 'generating'; progress: ExportProgress | null }
  | { kind: 'done'; result: ExportResult }
  | {
      kind: 'error'
      title: string
      message: string
      /** 重试从哪一步重来：补译停下来 → 再补译；生成失败 → 再生成 */
      retry: 'translate' | 'generate'
      /** 补译没走完：给「仍然导出（未译段保留原文）」 */
      fallback: boolean
    }

export interface ExportDialogProps {
  paper: PaperRecord
  blocks: readonly PaperBlock[]
  /** 挂载时冻结：对话框开着期间切视图 / 语言不改变正在导出的版本 */
  flavor: ExportFlavor
  /** 当前已有译文（React 态）：算缺译数与预估；直接导出时作为导出译文 */
  texts: ReadonlyMap<number, string>
  translateAll: (opts?: TranslateAllOptions) => Promise<TranslateAllResult>
  /** 原始文件字节（只有原版两种版本会调用） */
  getBytes: () => Promise<ArrayBuffer>
  onClose: () => void
  onDone?: (result: ExportResult) => void
}

const HALT_MESSAGE: Record<TranslateAllHalt, string> = {
  consent: '未授权 DeepSeek 翻译，剩余段落没有补译。',
  auth: '该账号尚未配置可用的 DeepSeek Key（或登录已过期），剩余段落没有补译；请到设置页配置后重试。',
  blocked: '翻译请求被拦截（未授权或敏感论文策略），剩余段落没有补译。',
  sensitive: '敏感论文已禁用远程翻译，剩余段落无法补译。',
}

/** 导出用译文：基底（补译快照 / 上次所用）补上最新 React 态里多出来的块（窗口调度器期间可能又译了几块） */
function mergeTexts(
  base: ReadonlyMap<number, string> | null,
  latest: ReadonlyMap<number, string>,
): ReadonlyMap<number, string> {
  if (!base || base === latest) return latest
  const out = new Map(base)
  for (const [k, v] of latest) if (!out.has(k)) out.set(k, v)
  return out
}

/** 生成阶段文案：字体阶段只报 KB（total 可能是 gzip 后的 Content-Length，比已下载字节还小，不能算百分比） */
function generatingText(p: ExportProgress | null): string {
  switch (p?.phase) {
    case undefined:
    case 'lib':
      return '加载导出组件…'
    case 'font':
      return p.bytes ? `下载中文字体 ${Math.round(p.bytes / 1024)} KB` : '加载中文字体…'
    case 'open':
      return '准备文档…'
    case 'pages':
      return p.total ? `处理第 ${p.done ?? 0}/${p.total} 页` : '处理页面…'
    case 'save':
      return '写出文件…'
  }
}

const generatingFraction = (p: ExportProgress | null): number | null =>
  p?.phase === 'pages' && p.total ? (p.done ?? 0) / p.total : p?.phase === 'save' ? 1 : null

/** 错误文案：内核包过一层的（如「拿不到原始 PDF 文件」）把 cause 的具体原因接在后面 */
function errorMessage(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const cause = e.cause instanceof Error ? e.cause.message : ''
  return cause && cause !== e.message ? `${e.message}：${cause}` : e.message || String(e)
}

const BTN_SECONDARY =
  'rounded-lg border border-line bg-panel px-4 py-1.5 text-sm text-fg transition-colors hover:bg-panel-2'
const BTN_PRIMARY =
  'rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90'

function ProgressBar({ fraction }: { fraction: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100)
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-1.5 w-full overflow-hidden rounded bg-panel-2"
    >
      <div className="h-full rounded bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
    </div>
  )
}

export default function ExportDialog(props: ExportDialogProps) {
  const { blocks, texts, onClose } = props
  const [flavor] = useState(props.flavor)
  const titleId = useId()

  // 回调与可变 props 走 ref：异步流程跨多次渲染，读最新值
  const propsRef = useRef(props)
  propsRef.current = props

  /** 缺译的可译块（随 React 态译文实时更新：确认期间窗口调度器可能又补了几块） */
  const pending = useMemo(() => blocks.filter((b) => hasTranslatableText(b) && !texts.has(b.index)), [blocks, texts])
  const estimate = useMemo(() => estimateTranslationCost(pending, PAPER_TASKS.translate.cap.pricing), [pending])

  const [phase, setPhase] = useState<Phase>(() =>
    pending.length > 0 ? { kind: 'confirm' } : { kind: 'generating', progress: null },
  )
  /** 挂载即生成（无缺译）：StrictMode 下 effect 重放也要重新开跑，记在 ref 里 */
  const autoStartRef = useRef(phase.kind === 'generating')

  const ctrlRef = useRef<AbortController | null>(null)
  const runIdRef = useRef(0)
  /** 最近一次导出 / 补译结果的译文（生成失败「重试」与「仍然导出」复用） */
  const lastTextsRef = useRef<ReadonlyMap<number, string> | null>(null)
  const modRef = useRef<ExportModule | null>(null)

  /** 开一轮新流程：中止上一轮，拿到本轮的 signal 与「还是不是当前轮」判定 */
  const begin = () => {
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    const id = ++runIdRef.current
    return { signal: ctrl.signal, live: () => runIdRef.current === id && !ctrl.signal.aborted }
  }

  const runGenerate = async (base: ReadonlyMap<number, string> | null) => {
    const { signal, live } = begin()
    const exportTexts = mergeTexts(base, propsRef.current.texts)
    lastTextsRef.current = exportTexts
    setPhase({ kind: 'generating', progress: null })
    try {
      const mod = modRef.current ?? (await loadExportModule())
      modRef.current = mod
      if (!live()) return
      const { paper, blocks: allBlocks, getBytes } = propsRef.current
      const result = await mod.exportPaperPdf({
        paper,
        blocks: allBlocks,
        texts: exportTexts,
        flavor,
        getBytes,
        signal,
        onProgress: (p) => {
          if (live()) setPhase({ kind: 'generating', progress: p })
        },
      })
      if (!live()) return
      mod.downloadBytes(result.bytes, result.fileName)
      setPhase({ kind: 'done', result })
      propsRef.current.onDone?.(result)
    } catch (e) {
      if (!live()) return
      setPhase({ kind: 'error', title: '导出失败', message: errorMessage(e), retry: 'generate', fallback: false })
    }
  }

  const runTranslate = async () => {
    const { signal, live } = begin()
    setPhase({ kind: 'translating', progress: null })
    let r: TranslateAllResult
    try {
      r = await propsRef.current.translateAll({
        signal,
        onProgress: (p) => {
          if (live()) setPhase({ kind: 'translating', progress: p })
        },
      })
    } catch (e) {
      if (!live()) return
      setPhase({ kind: 'error', title: '补译未完成', message: errorMessage(e), retry: 'translate', fallback: true })
      return
    }
    if (!live()) return
    // 队列跑空即导出（个别块仍失败 → 保留原文，完成页报数）
    if (r.outcome === 'done') {
      void runGenerate(r.texts)
      return
    }
    lastTextsRef.current = r.texts
    const head = r.outcome === 'halted' ? HALT_MESSAGE[r.halt ?? 'blocked'] : '补译被中断（论文已重新加载）。'
    setPhase({
      kind: 'error',
      title: '补译未完成',
      message: r.total > 0 ? `${head}已译 ${r.translated}/${r.total} 段。` : head,
      retry: 'translate',
      fallback: true,
    })
  }

  // 挂载：无缺译直接生成；卸载：中止当前轮（补译 / 生成都停，已发出的翻译包照常落库）
  useEffect(() => {
    if (autoStartRef.current) void runGenerate(null)
    return () => {
      runIdRef.current += 1
      ctrlRef.current?.abort()
    }
    // 只在挂载 / 卸载时跑：流程函数读的都是 ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cancel = () => {
    runIdRef.current += 1
    ctrlRef.current?.abort()
    onClose()
  }

  // Esc：进行中的阶段不响应（要点「取消」）
  const escClosable = phase.kind === 'confirm' || phase.kind === 'done' || phase.kind === 'error'
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (!escClosable) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [escClosable])

  // 熔断冷却倒计时
  const pausedUntil = phase.kind === 'translating' ? (phase.progress?.pausedUntil ?? null) : null
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (pausedUntil === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [pausedUntil])
  const coolSecs = pausedUntil === null ? 0 : Math.max(0, Math.ceil((pausedUntil - now) / 1000))

  let title: string
  let body: ReactNode
  let footer: ReactNode

  switch (phase.kind) {
    case 'confirm':
      title = `导出 PDF · ${FLAVOR_LABEL[flavor]}`
      body = (
        <>
          <p className="text-sm text-fg">
            导出前先翻译剩余 {pending.length} 段（预计 {formatUsd(estimate.cost)}，约 {estimate.batches} 包）·
            已译段落本地复用不重复计费
          </p>
          <p className="mt-2 text-xs text-dim">补译逐包进行，篇幅长时需要几分钟；中途取消不影响已译段落。</p>
        </>
      )
      footer = (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => void runGenerate(null)}
            className="text-xs text-dim underline underline-offset-2 transition-colors hover:text-fg"
          >
            直接导出（未译段保留原文）
          </button>
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onClose} className={BTN_SECONDARY}>
              取消
            </button>
            <button type="button" onClick={() => void runTranslate()} className={BTN_PRIMARY}>
              翻译并导出
            </button>
          </div>
        </div>
      )
      break

    case 'translating': {
      const p = phase.progress
      title = '正在补译剩余段落'
      body = (
        <>
          <p className="mb-2 text-sm text-fg" aria-live="polite">
            {p ? `已译 ${p.done}/${p.total} 段${p.failed > 0 ? ` · 失败 ${p.failed} 段` : ''}` : '准备补译…'}
          </p>
          <ProgressBar fraction={p && p.total > 0 ? p.done / p.total : 0} />
          {pausedUntil !== null && (
            <p className="mt-2 text-xs text-warn">熔断冷却中，{coolSecs} 秒后自动继续</p>
          )}
          <p className="mt-2 text-xs text-dim">取消即停止补译，已译段落会保留。</p>
        </>
      )
      footer = (
        <div className="flex justify-end">
          <button type="button" onClick={cancel} className={BTN_SECONDARY}>
            取消
          </button>
        </div>
      )
      break
    }

    case 'generating': {
      const fraction = generatingFraction(phase.progress)
      title = '正在生成 PDF'
      body = (
        <>
          <p className="mb-2 text-sm text-fg" aria-live="polite">
            {generatingText(phase.progress)}
          </p>
          {fraction !== null && <ProgressBar fraction={fraction} />}
        </>
      )
      footer = (
        <div className="flex justify-end">
          <button type="button" onClick={cancel} className={BTN_SECONDARY}>
            取消
          </button>
        </div>
      )
      break
    }

    case 'done': {
      const r = phase.result
      title = '导出完成'
      body = (
        <div className="space-y-1.5 text-sm">
          <p className="break-all text-fg">已开始下载 {r.fileName}</p>
          <p className="text-xs text-dim">
            {FLAVOR_LABEL[r.flavor]} · 共 {r.pageCount} 页
          </p>
          {r.untranslated > 0 && <p className="text-warn">{r.untranslated} 段未译，已保留原文</p>}
          {/* 回退提示是内核拼好的整句（原因 + 「已改为导出 X」），原样显示 */}
          {r.fellBackToText && <p className="text-warn">{r.fellBackToText}</p>}
        </div>
      )
      footer = (
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => modRef.current?.downloadBytes(r.bytes, r.fileName)} className={BTN_SECONDARY}>
            再次下载
          </button>
          <button type="button" onClick={onClose} className={BTN_PRIMARY}>
            关闭
          </button>
        </div>
      )
      break
    }

    case 'error': {
      const { retry, fallback } = phase
      title = phase.title
      body = <p className="break-words text-sm text-bad">{phase.message}</p>
      footer = (
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={BTN_SECONDARY}>
            关闭
          </button>
          <button
            type="button"
            onClick={() => void (retry === 'translate' ? runTranslate() : runGenerate(lastTextsRef.current))}
            className={fallback ? BTN_SECONDARY : BTN_PRIMARY}
          >
            重试
          </button>
          {fallback && (
            <button type="button" onClick={() => void runGenerate(lastTextsRef.current)} className={BTN_PRIMARY}>
              仍然导出（未译段保留原文）
            </button>
          )}
        </div>
      )
      break
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 backdrop-blur-[1px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-export-phase={phase.kind}
        className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-xl"
      >
        <h3 id={titleId} className="mb-2 font-semibold text-fg">
          {title}
        </h3>
        <div className="mb-4">{body}</div>
        {footer}
      </div>
    </div>
  )
}
