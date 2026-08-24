import { useMemo, useState } from 'react'
import { MAX_URLS_PER_IMPORT } from '../../../shared/apiRoutes'
import type { ImportOutcome } from '../../lib/paper/ingest'
import { parseUrlInput } from '../../lib/paper/url/urlValidate'
import type { UrlProgressEvent } from '../../lib/paper/url/urlImport'

/**
 * 「按 URL 导入」弹窗：粘贴多行链接 → 实时校验 chips → 提交后逐 URL 进度 → 结果报告。
 *
 * 提交后本弹窗只是「进度视窗」——真正抓取任务跑在 PapersPage 持有的串行队列里（与文件
 * 导入共用同一个队列，同一时刻只解析一个文档）。关闭弹窗不会取消任务：与文件导入的
 * 后台任务语义一致（顶部 jobs 面板始终能看到进度），重新点开「按 URL 导入」还能看到
 * 同一个仍在运行的任务的最新进度。去重命中（outcome.kind === 'duplicate'）由 PapersPage
 * 直接关闭本弹窗、转交给页面既有的 pendingDuplicate 面板处理，本组件不需要认识这个分支。
 */

const PHASE_LABEL: Record<UrlProgressEvent['phase'], string> = {
  pending: '等待中',
  fetching: '抓取中',
  extracting: '抽取正文',
  done: '完成',
  failed: '失败',
}

/**
 * 进度/跳过清单里同域多链接必须能区分（E2E R2 P2-1）：域名 + 路径，
 * 超长时中段截断保尾部——文档站 URL 的末段才是章节名。
 */
function displayUrl(raw: string): string {
  let full: string
  try {
    const u = new URL(raw)
    full = u.hostname + (u.pathname === '/' ? '' : u.pathname)
  } catch {
    full = raw
  }
  return full.length > 56 ? `${full.slice(0, 24)}…${full.slice(-30)}` : full
}

interface Props {
  onClose: () => void
  onSubmit: (urls: string[]) => void
  /** 队列任务是否仍在执行（与「已提交」不同：结果 result 出来后 running 会变 false） */
  running: boolean
  progress: UrlProgressEvent[]
  result: { outcome: ImportOutcome } | null
}

export default function UrlImportDialog({ onClose, onSubmit, running, progress, result }: Props) {
  const [text, setText] = useState('')
  const { valid, invalid } = useMemo(() => parseUrlInput(text), [text])
  // 一旦提交（running）或已经有结果，就不再展示输入表单，改展示进度/结果视图
  const started = running || result !== null

  const readyEntries = result?.outcome.kind === 'ready' ? (result.outcome.paper.source?.entries ?? null) : null
  const failedEntries = readyEntries?.filter((e) => !e.ok) ?? []
  const okCount = readyEntries?.filter((e) => e.ok).length ?? 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 backdrop-blur-[1px]">
      <div role="dialog" aria-modal="true" className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-line bg-panel p-5 shadow-xl">
        <div className="mb-3 flex shrink-0 items-center justify-between">
          <h3 className="font-semibold text-fg">按 URL 导入</h3>
          <button type="button" onClick={onClose} className="text-sm text-dim transition-colors hover:text-fg">
            关闭
          </button>
        </div>

        {!started && (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="每行一个链接；多个链接将按顺序合并为一篇文档"
              rows={8}
              className="w-full resize-none rounded-lg border border-line bg-panel-2 p-3 text-sm text-fg placeholder:text-dim focus:border-accent focus:outline-none"
            />
            <p className="mt-1 shrink-0 text-xs text-dim">
              单次最多 {MAX_URLS_PER_IMPORT} 条链接；单个直链 PDF 会自动走原版 PDF 导入。
            </p>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {valid.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {valid.map((v, i) => (
                    <span key={v.url} className="rounded-full border border-line bg-panel-2 px-2.5 py-1 text-xs text-fg">
                      {i + 1}. {v.hostname}
                    </span>
                  ))}
                </div>
              )}
              {invalid.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-bad">
                  {invalid.map((v, i) => (
                    <li key={`${v.raw}-${i}`}>
                      「{v.raw}」{v.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-4 flex shrink-0 justify-end">
              <button
                type="button"
                disabled={valid.length === 0}
                onClick={() => onSubmit(valid.map((v) => v.url))}
                className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                开始导入（{valid.length} 个链接）
              </button>
            </div>
          </>
        )}

        {started && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ul className="space-y-1.5">
              {progress.map((p) => (
                <li key={p.url} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-dim">{displayUrl(p.url)}</span>
                  <span
                    className={`shrink-0 text-xs ${
                      p.phase === 'done' ? 'text-ok' : p.phase === 'failed' ? 'text-bad' : 'text-amber'
                    }`}
                  >
                    {PHASE_LABEL[p.phase]}
                  </span>
                </li>
              ))}
            </ul>

            {readyEntries && failedEntries.length > 0 && (
              <div className="mt-4 rounded-lg border border-warn/40 bg-panel-2 p-3">
                <p className="mb-2 text-sm font-medium text-warn">
                  已导入 {okCount}/{readyEntries.length} 页，以下链接被跳过：
                </p>
                <ul className="space-y-1 text-xs text-dim">
                  {failedEntries.map((e) => (
                    <li key={e.url}>
                      {displayUrl(e.url)}：{e.error ?? '未知错误'}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result && result.outcome.kind === 'failed' && (
              <div className="mt-4 rounded-lg border border-bad/40 bg-panel-2 p-3">
                <p className="mb-2 text-sm font-medium text-bad">全部链接导入失败</p>
                <p className="text-xs text-dim">{result.outcome.failure.message}</p>
              </div>
            )}

            {result && (
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-line bg-panel px-4 py-1.5 text-sm text-fg transition-colors hover:bg-panel-2"
                >
                  完成
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
