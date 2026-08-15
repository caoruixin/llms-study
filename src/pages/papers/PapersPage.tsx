import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ClaimBanner from '../../components/papers/ClaimBanner'
import SegmentedTabs from '../../components/ui/SegmentedTabs'
import { useAuthStore } from '../../lib/auth/authStore'
import { createSerialQueue, importPaper, isRetryable, reingestPaper, type IngestDeps, type ParseResult } from '../../lib/paper/ingest'
import { getPaperDb, type SyncMetaRow } from '../../lib/paper/repo/db'
import { getRepos } from '../../lib/paper/repo/repos'
import {
  bootstrapSyncEngine,
  claimGuestPapers,
  getSyncEngine,
  scanClaimables,
  setClaimDismissed,
  type ClaimScanResult,
} from '../../lib/paper/sync/syncEngine'
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

/** 同步徽标：按登录态与 syncMeta 推导；处理中的论文不显示（状态列已足够） */
function syncBadge(paper: PaperRecord, meta: SyncMetaRow | undefined, authed: boolean): string | null {
  if (paper.status !== 'ready') return null
  if (!authed) return '仅本地'
  if (meta?.artifactsPushed) return '已同步'
  return '同步中'
}

export default function PapersPage() {
  const navigate = useNavigate()
  // 门面引用永不变（repos.ts 单例工厂），方法体内按登录态路由到游客库/账号库
  const repo = getRepos().paper
  const authStatus = useAuthStore((s) => s.status)
  const userId = useAuthStore((s) => s.user?.id ?? null)
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
  const [syncMetas, setSyncMetas] = useState<Record<string, SyncMetaRow>>({})
  const [claimScan, setClaimScan] = useState<ClaimScanResult | null>(null)

  const { sortBy, filter, pendingDuplicate, confirmDeleteId, setSortBy, setFilter, setPendingDuplicate, setConfirmDeleteId } =
    usePaperUi()

  const refresh = useCallback(async () => {
    setPapers(await repo.listPapers())
    // syncMeta 直接读活跃库：徽标是纯展示，不值得为它扩仓储接口
    try {
      const metas = await getPaperDb().syncMeta.toArray()
      setSyncMetas(Object.fromEntries(metas.map((m) => [m.paperId, m])))
    } catch {
      setSyncMetas({})
    }
  }, [repo])

  // 同步引擎 bootstrap 放页面挂载而非 App.tsx：flag-off 构建把 lib/paper 虚模块化，
  // App 层引用会破坏 flag-off 产物
  useEffect(() => {
    bootstrapSyncEngine()
  }, [])

  const rescanClaim = useCallback(async () => {
    const scan = await scanClaimables().catch(() => null)
    setClaimScan(scan && !scan.dismissed ? scan : null)
  }, [])

  // 账号切换（登录/登出/换号）→ 活跃库变了：重读列表；已登录再拉一轮增量 + 认领扫描
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        await refresh()
      } catch (e) {
        if (alive) setNotice(e instanceof Error ? e.message : '读取本地论文库失败')
      } finally {
        if (alive) setLoading(false)
      }
      if (!alive) return
      if (authStatus === 'authed') {
        // 拉取失败静默（断网属常态）：本地优先，列表照常可用，回前台/下次进页自然重试
        try {
          await getSyncEngine()?.pullSince()
          if (!alive) return
          await refresh()
          await rescanClaim()
        } catch {
          /* 静默 */
        }
      } else {
        setClaimScan(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [authStatus, userId, refresh, rescanClaim])

  // 同步引擎每推完一批就重读徽标(syncMeta)——否则「同步中」要停到下次手动刷新才变「已同步」
  useEffect(() => {
    const onFlushed = () => void refresh()
    window.addEventListener('paper-sync-flushed', onFlushed)
    return () => window.removeEventListener('paper-sync-flushed', onFlushed)
  }, [refresh])

  // 回前台补拉一轮增量:页面常驻(移动端 webview 常见)时,另一设备新传的论文要能自动出现,
  // 而不是等用户手动刷新(工作台已有同款,列表页此前只在挂载时拉一次)
  useEffect(() => {
    if (authStatus !== 'authed') return
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      void (async () => {
        try {
          await getSyncEngine()?.pullSince()
          await refresh()
        } catch {
          /* 断网属常态,静默;下次回前台自然重试 */
        }
      })()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [authStatus, refresh])

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
      // 必须在任何 await 之前快照：onChange 会同步清 input.value（live FileList 随之被清空），
      // onDrop 的 dataTransfer 在事件处理器返回后进入 protected mode——await 之后再读就全没了
      const picked = Array.from(files)
      // 上传拦截：未登录先弹登录（取消即放弃导入）——导入必须落进账号库才能同步
      if (!(await useAuthStore.getState().requireLogin('upload'))) return
      setNotice(null)
      for (const file of picked) {
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
    if (!(await useAuthStore.getState().requireLogin('upload'))) return
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
          {authStatus === 'authed'
            ? '已登录：文档与阅读记录会自动同步到你的账号，换设备打开即得；向模型发送内容前会单独征求授权。'
            : '文档与阅读记录只保存在当前浏览器（IndexedDB），不会自动外发；登录后可自动同步到账号。'}
        </p>
      </header>

      {claimScan && (
        <ClaimBanner
          scan={claimScan}
          onClaim={async () => {
            try {
              const { claimed, merged } = await claimGuestPapers()
              setClaimScan(null)
              setNotice(
                merged > 0
                  ? `已开始同步 ${claimed} 篇；另有 ${merged} 篇账号已有同篇，仅合并了阅读进度`
                  : `已开始同步 ${claimed} 篇，制品将在后台推送到账号`,
              )
              await refresh()
            } catch (e) {
              setNotice(e instanceof Error ? e.message : '认领失败，请稍后重试')
            }
          }}
          onDismiss={() => {
            setClaimScan(null)
            void setClaimDismissed(true)
          }}
        />
      )}

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
        {/* 非「全部」时展示筛选后数量:曾有用户在「处理中」tab 下看到「共 1 篇 + 空列表」误判同步失败 */}
        <span className="text-sm text-dim">
          {filter === 'all' ? `共 ${papers.length} 篇` : `筛选后 ${visible.length} / 共 ${papers.length} 篇`}
        </span>
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
          {papers.length > 0 && (
            <button
              type="button"
              onClick={() => setFilter('all')}
              className="mt-4 min-h-11 rounded-lg border border-line bg-panel-2 px-4 py-1.5 text-sm text-fg transition hover:bg-panel md:min-h-0"
            >
              显示全部 {papers.length} 篇
            </button>
          )}
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map((p) => (
            <li key={p.id} className="rounded-xl border border-line bg-panel shadow-sm p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                {/* 手机:basis-full 让标题块独占整行,按钮组自动折到第二行;md+:grow+basis-0 与原 flex-1
                    (flex:1 1 0%) 布局等效。不用 flex-1 是因为它是 shorthand,与 basis-* 的生成顺序
                    有覆盖歧义 */}
                <div className="min-w-0 grow basis-full md:basis-0">
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
                    {(() => {
                      const badge = syncBadge(p, syncMetas[p.id], authStatus === 'authed')
                      return badge ? (
                        <span
                          className={`shrink-0 rounded border px-1.5 py-0.5 text-[0.65rem] ${
                            badge === '已同步' ? 'border-ok/40 text-ok' : 'border-line text-dim'
                          }`}
                        >
                          {badge}
                        </span>
                      ) : null
                    })()}
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
                        className="min-h-11 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-fg transition-colors hover:bg-panel-2 md:min-h-0"
                      >
                        预览
                      </button>
                      <button
                        type="button"
                        onClick={() => navigate(`/papers/${p.id}?copilot=open`)}
                        className="min-h-11 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 md:min-h-0"
                      >
                        启动 Copilot
                      </button>
                    </>
                  )}
                  {p.status === 'failed' && p.failure && isRetryable(p.failure.kind) && (
                    <button
                      type="button"
                      onClick={() => retry(p)}
                      className="min-h-11 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-fg transition-colors hover:bg-panel-2 md:min-h-0"
                    >
                      重试
                    </button>
                  )}
                  {confirmDeleteId === p.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void remove(p.id)}
                        className="min-h-11 rounded-lg border border-bad/50 bg-panel px-3 py-1.5 text-sm text-bad transition-colors hover:bg-panel-2 md:min-h-0"
                      >
                        确认删除
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="min-h-11 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-dim transition-colors hover:bg-panel-2 md:min-h-0"
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(p.id)}
                      className="min-h-11 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-dim transition-colors hover:bg-panel-2 md:min-h-0"
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
