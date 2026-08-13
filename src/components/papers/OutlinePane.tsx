import { useMemo } from 'react'
import SegmentedTabs from '../ui/SegmentedTabs'
import { splitHighlight, type SearchHit } from '../../lib/paper/retrieval'
import type { BriefData } from '../../lib/paper/briefPipeline'
import type { BriefUiState } from '../../pages/papers/paperUiStore'
import type { PaperBlock, SourceAnchor } from '../../lib/paper/types'

/** 左栏：目录 + 阅读进度 + 论文地图（§3.4）+ 本地全文搜索 */

export interface OutlineItem {
  blockIndex: number
  /** 本章节最后一个块的序号，用于判定「已读」与「当前所在章节」 */
  endBlockIndex: number
  level: number
  text: string
  page?: number
}

export function buildOutline(blocks: readonly PaperBlock[]): OutlineItem[] {
  const items: OutlineItem[] = []
  for (const b of blocks) {
    if (b.kind !== 'heading') continue
    items.push({
      blockIndex: b.index,
      endBlockIndex: b.index,
      level: Math.min(6, Math.max(1, b.level ?? 1)),
      text: b.text,
      page: b.anchor.page,
    })
  }
  const lastIndex = blocks.length ? blocks[blocks.length - 1].index : 0
  for (let i = 0; i < items.length; i++) {
    items[i].endBlockIndex = i + 1 < items.length ? items[i + 1].blockIndex - 1 : lastIndex
  }
  return items
}

export type OutlineTab = 'outline' | 'search'

const TABS = [
  { id: 'outline', label: '目录' },
  { id: 'search', label: '搜索' },
] as const satisfies readonly { readonly id: OutlineTab; readonly label: string }[]

interface Props {
  outline: OutlineItem[]
  currentBlockIndex: number
  maxBlockIndex: number
  ratio: number
  tab: OutlineTab
  onTabChange: (tab: OutlineTab) => void
  onJumpBlock: (blockIndex: number) => void
  onJumpAnchor: (anchor: SourceAnchor) => void
  searchQuery: string
  onSearchQueryChange: (q: string) => void
  onSearch: () => void
  searchHits: SearchHit[]
  searchBusy: boolean
  searchRan: boolean
  /** 论文地图（Phase 3）：数据 + 进度由 CopilotPanel 写入 store，经工作台传入 */
  brief: BriefData | null
  briefUi: BriefUiState | null
  onGenerateBrief: () => void
}

function BriefField({ label, text }: { label: string; text: string }) {
  if (!text || text.startsWith('（未能提取')) return null
  return (
    <div>
      <dt className="text-[0.65rem] font-medium text-dim">{label}</dt>
      <dd className="text-[0.7rem] leading-relaxed text-fg">{text}</dd>
    </div>
  )
}

function BriefCard({ brief, briefUi, onGenerate }: { brief: BriefData | null; briefUi: BriefUiState | null; onGenerate: () => void }) {
  if (brief) {
    return (
      <div className="mt-4 rounded-lg border border-line bg-panel-2 p-3">
        <p className="mb-1.5 text-xs font-medium text-fg">论文地图</p>
        <dl className="space-y-1.5">
          <BriefField label="一句话结论" text={brief.oneLiner} />
          <BriefField label="研究问题" text={brief.problem} />
          {brief.contributions.length > 0 && (
            <div>
              <dt className="text-[0.65rem] font-medium text-dim">核心贡献</dt>
              <dd>
                <ul className="list-disc pl-4 text-[0.7rem] leading-relaxed text-fg">
                  {brief.contributions.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
          <BriefField label="方法/管线" text={brief.method} />
          <BriefField label="理论与公式" text={brief.theory === '（无）' ? '' : brief.theory} />
          <BriefField label="算法步骤" text={brief.algorithm === '（无）' ? '' : brief.algorithm} />
          <BriefField label="实验与结论" text={brief.experiments} />
          <BriefField label="局限与开放问题" text={brief.limitations} />
          {brief.prerequisites.length > 0 && <BriefField label="前置知识" text={brief.prerequisites.join('；')} />}
          {brief.readingPath.length > 0 && (
            <div>
              <dt className="text-[0.65rem] font-medium text-dim">推荐阅读路径</dt>
              <dd>
                <ol className="list-decimal pl-4 text-[0.7rem] leading-relaxed text-fg">
                  {brief.readingPath.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </dd>
            </div>
          )}
          {brief.gaps.length > 0 && (
            <p className="rounded border border-warn/40 px-1.5 py-1 text-[0.65rem] text-warn">
              以下部分摘要失败，地图未覆盖：{brief.gaps.join('、')}
            </p>
          )}
        </dl>
      </div>
    )
  }
  if (briefUi?.status === 'running') {
    return (
      <div className="mt-4 rounded-lg border border-dashed border-line p-3">
        <p className="mb-1 text-xs font-medium text-fg">论文地图</p>
        <p className="mb-1.5 text-[0.7rem] text-dim">
          生成中：{briefUi.done}/{briefUi.total}
        </p>
        <div className="h-1 w-full overflow-hidden rounded-full bg-panel-2">
          <div
            className="h-full bg-accent transition-[width]"
            style={{ width: `${briefUi.total ? Math.round((briefUi.done / briefUi.total) * 100) : 0}%` }}
          />
        </div>
      </div>
    )
  }
  return (
    <div className="mt-4 rounded-lg border border-dashed border-line p-3">
      <p className="mb-1 text-xs font-medium text-fg">论文地图</p>
      <p className="mb-2 text-[0.7rem] leading-relaxed text-dim">
        一句话结论、研究问题、核心贡献、方法管线、实验与局限，由 Copilot 生成（会显示预估成本）。
      </p>
      <button
        type="button"
        onClick={onGenerate}
        className="rounded-lg border border-accent/40 px-2.5 py-1 text-xs text-accent transition-colors hover:bg-accent/10"
      >
        生成论文地图
      </button>
    </div>
  )
}

const INDENT = ['pl-0', 'pl-0', 'pl-3', 'pl-6', 'pl-9', 'pl-12', 'pl-12']

export default function OutlinePane({
  outline,
  currentBlockIndex,
  maxBlockIndex,
  ratio,
  tab,
  onTabChange,
  onJumpBlock,
  onJumpAnchor,
  searchQuery,
  onSearchQueryChange,
  onSearch,
  searchHits,
  searchBusy,
  searchRan,
  brief,
  briefUi,
  onGenerateBrief,
}: Props) {
  // 当前章节 = 覆盖当前块的最后一个标题
  const activeIndex = useMemo(() => {
    let active = -1
    outline.forEach((item, i) => {
      if (item.blockIndex <= currentBlockIndex) active = i
    })
    return active
  }, [outline, currentBlockIndex])

  return (
    <div className="flex h-full flex-col gap-3">
      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-dim">
          <span>阅读进度</span>
          <span>{Math.round(ratio * 100)}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
          <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
      </div>

      <SegmentedTabs tabs={TABS} value={tab} onChange={onTabChange} />

      {tab === 'outline' ? (
        <nav className="min-h-0 flex-1 overflow-y-auto pr-1">
          {outline.length === 0 ? (
            <p className="text-xs leading-relaxed text-dim">这篇论文没有识别出标题层级，可以用「搜索」定位内容。</p>
          ) : (
            <ul className="space-y-0.5">
              {outline.map((item, i) => {
                const read = item.endBlockIndex <= maxBlockIndex
                const active = i === activeIndex
                return (
                  <li key={`${item.blockIndex}-${item.text}`}>
                    <button
                      type="button"
                      onClick={() => onJumpBlock(item.blockIndex)}
                      className={`flex w-full items-baseline gap-2 rounded-md py-1 pr-2 text-left text-xs leading-relaxed transition-colors ${
                        INDENT[item.level]
                      } ${active ? 'bg-panel-2 font-semibold text-accent' : read ? 'text-dim hover:text-fg' : 'text-fg hover:bg-panel-2'}`}
                    >
                      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${read ? 'bg-ok' : 'bg-line'}`} />
                      <span className="min-w-0 flex-1 break-words">{item.text}</span>
                      {item.page !== undefined && <span className="shrink-0 text-[0.65rem] text-dim">p.{item.page}</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          <BriefCard brief={brief} briefUi={briefUi} onGenerate={onGenerateBrief} />
        </nav>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              onSearch()
            }}
            className="flex gap-2"
          >
            <input
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              placeholder="全文搜索（本地 BM25）"
              className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2 py-1.5 text-xs text-fg"
            />
            <button
              type="submit"
              className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent/90"
            >
              搜索
            </button>
          </form>
          <p className="text-[0.7rem] leading-relaxed text-dim">
            完全本地检索，不联网、不依赖模型——模型不可用时这条路径始终可用。
          </p>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {searchBusy ? (
              <p className="text-xs text-dim">正在检索…</p>
            ) : searchRan && searchHits.length === 0 ? (
              <p className="text-xs text-dim">没有找到匹配的段落。</p>
            ) : (
              <ul className="space-y-2">
                {searchHits.map((hit) => (
                  <li key={hit.chunkId}>
                    <button
                      type="button"
                      onClick={() => onJumpAnchor(hit.anchor)}
                      className="w-full rounded-lg border border-line bg-panel-2 p-2 text-left transition-colors hover:border-accent/50"
                    >
                      <div className="mb-1 flex items-center gap-2 text-[0.65rem] text-dim">
                        {hit.section && <span className="truncate">{hit.section}</span>}
                        {hit.page !== undefined && <span className="shrink-0">p.{hit.page}</span>}
                      </div>
                      <p className="text-xs leading-relaxed text-fg">
                        {splitHighlight(hit.snippet, hit.matched).map((part, i) =>
                          part.hit ? (
                            <mark key={i} className="rounded bg-amber/25 text-fg">
                              {part.text}
                            </mark>
                          ) : (
                            <span key={i}>{part.text}</span>
                          ),
                        )}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
