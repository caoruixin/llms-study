import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { createPaperRepository } from '../../lib/paper/repo/paperRepo'
import { getPaperDb } from '../../lib/paper/repo/db'
import type { PaperBlock, PaperRecord } from '../../lib/paper/types'
import { usePaperUi } from './paperUiStore'

/**
 * 阅读工作台（Phase 1 简版）：规范化块只读预览 + 阅读位置持久化 + Copilot 折叠占位。
 * PDF 原版页面渲染、文字层选区、目录树、长文虚拟化与真正的三栏形态见 Phase 2；
 * Copilot 对话能力见 Phase 3。
 */

const BLOCKS_PER_PAGE = 40
/** 阅读进度节流：翻页频繁时不必每次都写 IndexedDB */
const PROGRESS_DEBOUNCE_MS = 600

const COPILOT_CAPABILITIES = [
  '论文地图：一句话结论、研究问题、核心贡献、方法管线、实验与局限',
  '逐节精读与方法拆解，按你的掌握程度自动调整讲解层次',
  '公式推导、算法步骤器、对比表与概念关系图',
  '每条论文事实都带可点击回跳原文的引用，证据不足时明说不编造',
  '选择题、闪卡与 Teach-back 复述，检查你是否真的理解了',
]

function BlockView({ block }: { block: PaperBlock }) {
  switch (block.kind) {
    case 'heading': {
      const level = block.level ?? 2
      const size = level <= 1 ? 'text-xl' : level === 2 ? 'text-lg' : 'text-base'
      return <h3 className={`${size} mt-6 font-semibold text-fg first:mt-0`}>{block.text}</h3>
    }
    case 'list':
      return (
        <p className="flex gap-2 text-sm leading-relaxed text-fg">
          <span className="shrink-0 text-dim">·</span>
          <span>{block.text}</span>
        </p>
      )
    case 'table':
      return (
        <pre className="overflow-x-auto rounded-lg border border-line bg-panel-2 p-3 text-xs leading-relaxed text-fg">
          {block.text}
        </pre>
      )
    case 'code':
      return (
        <pre className="overflow-x-auto rounded-lg border border-line bg-panel-2 p-3 font-mono text-xs leading-relaxed text-fg">
          {block.text}
        </pre>
      )
    default:
      return <p className="text-sm leading-relaxed text-fg">{block.text}</p>
  }
}

export default function PaperWorkbenchPage() {
  const { paperId } = useParams<{ paperId: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const repo = useMemo(() => createPaperRepository(getPaperDb()), [])

  const [paper, setPaper] = useState<PaperRecord | null>(null)
  const [blocks, setBlocks] = useState<PaperBlock[]>([])
  const [loading, setLoading] = useState(true)
  const [pageIndex, setPageIndex] = useState(0)
  // 记住「已经为哪一篇论文恢复过阅读位置」：SPA 内换论文时要重新恢复，同一篇内翻页则不覆盖
  const restoredFor = useRef<string | null>(null)

  const { copilotOpen, setCopilotOpen } = usePaperUi()

  // 「启动 Copilot」入口带 ?copilot=open（HashRouter 下 query 在 hash 内，useSearchParams 正常工作）
  useEffect(() => {
    setCopilotOpen(searchParams.get('copilot') === 'open')
  }, [searchParams, setCopilotOpen])

  useEffect(() => {
    if (!paperId) return
    let alive = true
    void (async () => {
      try {
        const [record, list] = await Promise.all([repo.getPaper(paperId), repo.getBlocks(paperId)])
        if (!alive) return
        setPaper(record ?? null)
        setBlocks(list)
        // 恢复阅读位置：把上次的 blockIndex 换算回所在页
        if (record && restoredFor.current !== paperId) {
          restoredFor.current = paperId
          setPageIndex(Math.floor((record.progress?.blockIndex ?? 0) / BLOCKS_PER_PAGE))
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [paperId, repo])

  const totalPages = Math.max(1, Math.ceil(blocks.length / BLOCKS_PER_PAGE))
  const safePage = Math.min(pageIndex, totalPages - 1)
  const start = safePage * BLOCKS_PER_PAGE
  const shown = blocks.slice(start, start + BLOCKS_PER_PAGE)
  // 依赖数组里只放原始值：shown 是每次 render 重新 slice 出的新数组，
  // 直接进依赖会让防抖计时器每次 render 都被重置。
  const shownCount = shown.length
  const firstPage = shown[0]?.anchor.page
  const totalBlocks = blocks.length

  // 翻页写进度（节流）：ratio 按「已翻过的块 / 总块数」估算
  useEffect(() => {
    if (!paperId || !totalBlocks || loading) return
    const timer = setTimeout(() => {
      void repo
        .updateProgress(paperId, {
          blockIndex: start,
          ratio: Math.min(1, (start + shownCount) / totalBlocks),
          page: firstPage,
          updatedAt: Date.now(),
        })
        .catch(() => undefined)
    }, PROGRESS_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [paperId, repo, start, shownCount, firstPage, totalBlocks, loading])

  const goto = useCallback(
    (next: number) => {
      setPageIndex(Math.max(0, Math.min(totalPages - 1, next)))
      window.scrollTo({ top: 0, behavior: 'smooth' })
    },
    [totalPages],
  )

  if (loading) return <p className="text-sm text-dim">正在加载论文…</p>

  if (!paper) {
    return (
      <div className="rounded-xl border border-line bg-panel shadow-sm p-6">
        <p className="mb-3 font-medium text-fg">找不到这篇论文</p>
        <p className="mb-4 text-sm text-dim">它可能已经被删除，或者这个链接来自另一个浏览器的本地论文库。</p>
        <button
          type="button"
          onClick={() => navigate('/papers')}
          className="rounded-lg border border-line bg-panel px-4 py-2 text-sm text-fg transition-colors hover:bg-panel-2"
        >
          返回论文库
        </button>
      </div>
    )
  }

  if (paper.status !== 'ready') {
    return (
      <div className="rounded-xl border border-line bg-panel shadow-sm p-6">
        <p className="mb-3 font-medium text-fg">「{paper.title}」还不能阅读</p>
        <p className="mb-4 text-sm text-dim">
          {paper.status === 'failed' ? (paper.failure?.message ?? '解析失败') : '正在解析中，请稍后回到论文库查看进度。'}
        </p>
        <button
          type="button"
          onClick={() => navigate('/papers')}
          className="rounded-lg border border-line bg-panel px-4 py-2 text-sm text-fg transition-colors hover:bg-panel-2"
        >
          返回论文库
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => navigate('/papers')}
            className="mb-1 text-sm text-dim transition-colors hover:text-fg"
          >
            ← 返回论文库
          </button>
          <h1 className="truncate text-xl font-bold">{paper.title}</h1>
          <p className="text-xs text-dim">
            {paper.format.toUpperCase()}
            {paper.pageCount ? ` · ${paper.pageCount} 页` : ''} · {blocks.length} 段 · 第 {safePage + 1}/{totalPages} 屏
          </p>
        </div>
        {!copilotOpen && (
          <button
            type="button"
            onClick={() => setCopilotOpen(true)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
          >
            展开 Copilot
          </button>
        )}
      </header>

      <div className={`grid gap-4 ${copilotOpen ? 'lg:grid-cols-[minmax(0,1fr)_22rem]' : 'grid-cols-1'}`}>
        {/* 中栏：规范化块只读预览。长文虚拟化与 PDF 原版页面渲染归 Phase 2 */}
        <article className="space-y-3 rounded-xl border border-line bg-panel shadow-sm p-5">
          {shown.length === 0 ? (
            <p className="text-sm text-dim">这篇论文没有可显示的正文块。</p>
          ) : (
            shown.map((b) => <BlockView key={b.id} block={b} />)
          )}

          <nav className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <button
              type="button"
              disabled={safePage === 0}
              onClick={() => goto(safePage - 1)}
              className="rounded-lg border border-line bg-panel px-4 py-1.5 text-sm text-fg transition-colors hover:bg-panel-2 disabled:opacity-40"
            >
              上一屏
            </button>
            <label className="flex items-center gap-2 text-sm text-dim">
              跳转
              <select
                value={safePage}
                onChange={(e) => goto(Number(e.target.value))}
                className="rounded-md border border-line bg-panel-2 px-2 py-1 text-fg"
              >
                {Array.from({ length: totalPages }, (_, i) => (
                  <option key={i} value={i}>
                    {i + 1} / {totalPages}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={safePage >= totalPages - 1}
              onClick={() => goto(safePage + 1)}
              className="rounded-lg border border-line bg-panel px-4 py-1.5 text-sm text-fg transition-colors hover:bg-panel-2 disabled:opacity-40"
            >
              下一屏
            </button>
          </nav>
        </article>

        {/* 右栏：Copilot 占位。窄屏时自然落到正文下方（单列 grid） */}
        {copilotOpen && (
          <aside className="h-fit rounded-xl border border-line bg-panel shadow-sm p-5 lg:sticky lg:top-20">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="font-semibold text-accent">Paper Copilot</h2>
              <button type="button" onClick={() => setCopilotOpen(false)} className="text-sm text-dim hover:text-fg">
                收起
              </button>
            </div>
            <p className="mb-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs leading-relaxed text-dim">
              陪读对话将在 Phase 3 接入。届时会先明确告知发送范围并单独征求授权，未授权前论文内容不出本机。
            </p>
            <ul className="space-y-2">
              {COPILOT_CAPABILITIES.map((c) => (
                <li key={c} className="flex gap-2 text-xs leading-relaxed text-dim">
                  <span className="shrink-0 text-accent">·</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </div>
  )
}
