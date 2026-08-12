import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import SegmentedTabs from '../../components/ui/SegmentedTabs'
import { createSerialQueue, importPaper, isRetryable, reingestPaper, type IngestDeps, type ParseResult } from '../../lib/paper/ingest'
import { createPaperRepository } from '../../lib/paper/repo/paperRepo'
import { getPaperDb } from '../../lib/paper/repo/db'
import { ensureStorageFor } from '../../lib/paper/storage'
import { MAX_FILE_BYTES, MAX_PDF_PAGES, sha256Hex } from '../../lib/paper/validate'
import type { IngestStage, PaperFormat, PaperRecord } from '../../lib/paper/types'
import { usePaperUi, type PaperFilter, type PaperSortBy } from './paperUiStore'

const FILTER_TABS = [
  { id: 'all', label: '全部' },
  { id: 'processing', label: '处理中' },
  { id: 'ready', label: '可阅读' },
  { id: 'failed', label: '失败' },
] as const satisfies readonly { readonly id: PaperFilter; readonly label: string }[]

const SORT_OPTIONS: { id: PaperSortBy; label: string }[] = [
  { id: 'lastRead', label: '最近阅读' },
  { id: 'created', label: '最近上传' },
  { id: 'title', label: '标题' },
]

const STAGE_LABEL: Record<IngestStage, string> = {
  queued: '排队中',
  validating: '校验中',
  parsing: '解析中',
  normalizing: '规范化',
  indexing: '建索引',
  ready: '可阅读',
  failed: '失败',
}

const fmtSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

const fmtTime = (ts?: number): string =>
  ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'

const isProcessing = (s: IngestStage) => s !== 'ready' && s !== 'failed'

/** 解析器按格式动态 import：pdfjs / mammoth 都不进论文库入口 chunk，首次导入对应格式时才拉取 */
async function parseByFormat(input: { bytes: ArrayBuffer; format: PaperFormat }): Promise<ParseResult> {
  if (input.format === 'pdf') {
    const { parsePdfBytes } = await import('../../lib/paper/parsePdf')
    return parsePdfBytes(input.bytes)
  }
  const { parseDocxBytes } = await import('../../lib/paper/parseDocx')
  return parseDocxBytes(input.bytes)
}

interface ActiveJob {
  id: string
  name: string
  stage: IngestStage
}

export default function PapersPage() {
  const navigate = useNavigate()
  const repo = useMemo(() => createPaperRepository(getPaperDb()), [])
  const queueRef = useRef(createSerialQueue())
  const inputRef = useRef<HTMLInputElement>(null)
  // 重复导入时暂存原 File，供「替换导入」重跑；串行队列保证同时只有一个待决项
  const duplicateFileRef = useRef<File | null>(null)
  const dragDepth = useRef(0)

  const [papers, setPapers] = useState<PaperRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [jobs, setJobs] = useState<ActiveJob[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const { sortBy, filter, pendingDuplicate, confirmDeleteId, setSortBy, setFilter, setPendingDuplicate, setConfirmDeleteId } =
    usePaperUi()

  const refresh = useCallback(async () => {
    setPapers(await repo.listPapers())
  }, [repo])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const list = await repo.listPapers()
        if (alive) setPapers(list)
      } catch (e) {
        if (alive) setNotice(e instanceof Error ? e.message : '读取本地论文库失败')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [repo])

  const depsFor = useCallback(
    (jobId: string): IngestDeps => ({
      repo,
      hash: sha256Hex,
      parse: parseByFormat,
      onState: (s) => {
        setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, stage: s.stage } : j)))
        void refresh()
      },
    }),
    [repo, refresh],
  )

  const runImport = useCallback(
    (file: File) => {
      const jobId = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      setJobs((prev) => [...prev, { id: jobId, name: file.name, stage: 'queued' }])
      void queueRef.current
        .enqueue(jobId, async () => {
          // 字节在任务内才读取：串行队列保证同一时刻只有一个文件的字节驻留内存
          const bytes = await file.arrayBuffer()
          const outcome = await importPaper(
            { name: file.name, size: file.size, type: file.type, bytes },
            depsFor(jobId),
          )
          if (outcome.kind === 'duplicate') {
            duplicateFileRef.current = file
            setPendingDuplicate({ existing: outcome.existing, fileName: file.name })
          } else if (outcome.kind === 'failed') {
            setNotice(`${file.name}：${outcome.failure.message}`)
          }
        })
        .catch((e: unknown) => setNotice(e instanceof Error ? e.message : '导入失败'))
        .finally(() => {
          setJobs((prev) => prev.filter((j) => j.id !== jobId))
          void refresh()
        })
    },
    [depsFor, refresh, setPendingDuplicate],
  )

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setNotice(null)
      for (const file of Array.from(files)) {
        // 配额预检只看 size，不必先把文件读进内存
        const check = await ensureStorageFor(file.size)
        if (!check.ok) {
          setNotice(check.message ?? '本地存储空间不足')
          continue
        }
        runImport(file)
      }
    },
    [runImport],
  )

  const retry = useCallback(
    (paper: PaperRecord) => {
      const jobId = `retry-${paper.id}-${Date.now()}`
      setJobs((prev) => [...prev, { id: jobId, name: paper.fileName, stage: 'queued' }])
      void queueRef.current
        .enqueue(jobId, async () => {
          const outcome = await reingestPaper(paper.id, depsFor(jobId))
          if (outcome.kind === 'failed') setNotice(`${paper.fileName}：${outcome.failure.message}`)
        })
        .catch((e: unknown) => setNotice(e instanceof Error ? e.message : '重试失败'))
        .finally(() => {
          setJobs((prev) => prev.filter((j) => j.id !== jobId))
          void refresh()
        })
    },
    [depsFor, refresh],
  )

  const remove = useCallback(
    async (paperId: string) => {
      setConfirmDeleteId(null)
      try {
        await repo.deletePaper(paperId)
      } catch (e) {
        setNotice(e instanceof Error ? e.message : '删除失败')
      }
      await refresh()
    },
    [repo, refresh, setConfirmDeleteId],
  )

  const replaceDuplicate = useCallback(async () => {
    const file = duplicateFileRef.current
    const existing = pendingDuplicate?.existing
    setPendingDuplicate(null)
    duplicateFileRef.current = null
    if (!file || !existing) return
    try {
      await repo.deletePaper(existing.id)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '替换失败')
      return
    }
    await refresh()
    runImport(file)
  }, [pendingDuplicate, repo, refresh, runImport, setPendingDuplicate])

  const visible = useMemo(() => {
    const filtered = papers.filter((p) => {
      if (filter === 'all') return true
      if (filter === 'ready') return p.status === 'ready'
      if (filter === 'failed') return p.status === 'failed'
      return isProcessing(p.status)
    })
    const sorted = [...filtered]
    if (sortBy === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
    else if (sortBy === 'created') sorted.sort((a, b) => b.createdAt - a.createdAt)
    else sorted.sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0) || b.createdAt - a.createdAt)
    return sorted
  }, [papers, filter, sortBy])

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">论文陪读</h1>
        <p className="text-sm text-dim">
          文档与阅读记录只保存在当前浏览器（IndexedDB），不会自动外发；向模型发送内容前会单独征求授权。
        </p>
      </header>

      {/* 导入区：拖放 + 文件选择 */}
      <section
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragEnter={(e) => {
          e.preventDefault()
          dragDepth.current += 1
          setDragging(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          dragDepth.current -= 1
          if (dragDepth.current <= 0) {
            dragDepth.current = 0
            setDragging(false)
          }
        }}
        onDrop={(e) => {
          e.preventDefault()
          dragDepth.current = 0
          setDragging(false)
          if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files)
        }}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          dragging ? 'border-accent bg-accent/5' : 'border-line bg-panel'
        }`}
      >
        <p className="mb-1 font-medium text-fg">把 PDF / DOCX 拖到这里</p>
        <p className="mb-4 text-xs text-dim">
          单文件 ≤ {Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB · PDF ≤ {MAX_PDF_PAGES} 页 · 不支持 .doc 与扫描件（无文字层）
        </p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
        >
          选择文件
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.docx"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void handleFiles(e.target.files)
            e.target.value = '' // 允许连续选择同一个文件
          }}
        />
      </section>

      {notice && (
        <div className="flex items-start justify-between gap-4 rounded-xl border border-bad/40 bg-panel shadow-sm p-4">
          <p className="text-sm leading-relaxed text-bad">{notice}</p>
          <button type="button" onClick={() => setNotice(null)} className="shrink-0 text-sm text-dim hover:text-fg">
            知道了
          </button>
        </div>
      )}

      {pendingDuplicate && (
        <div className="rounded-xl border border-warn/40 bg-panel shadow-sm p-4">
          <p className="mb-1 font-medium text-warn">该文件已导入过</p>
          <p className="mb-3 text-sm text-dim">
            「{pendingDuplicate.fileName}」与已有论文「{pendingDuplicate.existing.title}」内容完全相同（SHA-256 一致）。
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                const id = pendingDuplicate.existing.id
                setPendingDuplicate(null)
                duplicateFileRef.current = null
                navigate(`/papers/${id}`)
              }}
              className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
            >
              打开已有
            </button>
            <button
              type="button"
              onClick={() => void replaceDuplicate()}
              className="rounded-lg border border-line bg-panel px-4 py-1.5 text-sm text-fg transition-colors hover:bg-panel-2"
            >
              替换导入
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingDuplicate(null)
                duplicateFileRef.current = null
              }}
              className="rounded-lg border border-line bg-panel px-4 py-1.5 text-sm text-dim transition-colors hover:bg-panel-2"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
          <p className="mb-2 text-sm font-medium text-fg">正在导入（同一时刻只解析一个文档）</p>
          <ul className="space-y-1">
            {jobs.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-4 text-sm">
                <span className="truncate text-dim">{j.name}</span>
                <span className="shrink-0 text-amber">{STAGE_LABEL[j.stage]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <SegmentedTabs tabs={FILTER_TABS} value={filter} onChange={setFilter} />
        <label className="flex items-center gap-2 text-sm text-dim">
          排序
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as PaperSortBy)}
            className="rounded-md border border-line bg-panel-2 px-3 py-1.5 text-fg"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <span className="text-sm text-dim">共 {papers.length} 篇</span>
      </div>

      {loading ? (
        <p className="text-sm text-dim">正在读取本地论文库…</p>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel shadow-sm p-8 text-center">
          <p className="mb-2 font-medium text-fg">{papers.length === 0 ? '还没有导入任何论文' : '当前筛选下没有论文'}</p>
          <p className="text-sm leading-relaxed text-dim">
            支持可抽取文字的 PDF 与 DOCX，单文件 ≤ {Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB、PDF ≤ {MAX_PDF_PAGES} 页。
            <br />
            暂不支持旧版 .doc 与纯扫描件（无文字层，首版不做 OCR）。
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map((p) => (
            <li key={p.id} className="rounded-xl border border-line bg-panel shadow-sm p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate font-semibold text-fg">{p.title}</h2>
                    <span className="shrink-0 rounded border border-line px-1.5 py-0.5 text-xs text-dim uppercase">
                      {p.format}
                    </span>
                    <span
                      className={`shrink-0 text-xs font-medium ${
                        p.status === 'ready' ? 'text-ok' : p.status === 'failed' ? 'text-bad' : 'text-amber'
                      }`}
                    >
                      {STAGE_LABEL[p.status]}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-dim">{p.fileName}</p>
                  <p className="mt-1 text-xs text-dim">
                    {fmtSize(p.byteSize)}
                    {p.pageCount ? ` · ${p.pageCount} 页` : ''}
                    {p.blockCount ? ` · ${p.blockCount} 段` : ''}
                    {` · 最近阅读 ${fmtTime(p.lastReadAt)}`}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {p.status === 'ready' && (
                    <>
                      <button
                        type="button"
                        onClick={() => navigate(`/papers/${p.id}`)}
                        className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-fg transition-colors hover:bg-panel-2"
                      >
                        预览
                      </button>
                      <button
                        type="button"
                        onClick={() => navigate(`/papers/${p.id}?copilot=open`)}
                        className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
                      >
                        启动 Copilot
                      </button>
                    </>
                  )}
                  {p.status === 'failed' && p.failure && isRetryable(p.failure.kind) && (
                    <button
                      type="button"
                      onClick={() => retry(p)}
                      className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-fg transition-colors hover:bg-panel-2"
                    >
                      重试
                    </button>
                  )}
                  {confirmDeleteId === p.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void remove(p.id)}
                        className="rounded-lg border border-bad/50 bg-panel px-3 py-1.5 text-sm text-bad transition-colors hover:bg-panel-2"
                      >
                        确认删除
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-dim transition-colors hover:bg-panel-2"
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(p.id)}
                      className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-dim transition-colors hover:bg-panel-2"
                    >
                      删除
                    </button>
                  )}
                </div>
              </div>

              {p.status === 'failed' && p.failure && (
                <p className="mt-3 rounded-lg border border-bad/30 bg-panel-2 px-3 py-2 text-sm text-bad">
                  {p.failure.message}
                  {!isRetryable(p.failure.kind) && <span className="text-dim">（该文件无法解析，只能删除或更换文件）</span>}
                </p>
              )}

              {p.status === 'ready' && p.progress.ratio > 0 && (
                <div className="mt-3">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
                    <div className="h-full bg-accent" style={{ width: `${Math.round(p.progress.ratio * 100)}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-dim">已读 {Math.round(p.progress.ratio * 100)}%</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
