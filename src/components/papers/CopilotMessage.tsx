import { memo, useMemo, useRef } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { createStreamParserMemo, type CopilotSeg, type ProseRun } from '../../lib/paper/streamParser'
import type { CiteLevel } from '../../lib/paper/citations'
import type { StoredCiteEntry } from '../../lib/paper/types'
import CiteBadge, { citeLabel } from './CiteBadge'
import PlanChip from './PlanChip'
import BlockFallback from './blocks/BlockFallback'
import BlockSkeleton from './blocks/BlockSkeleton'
import FormulaBlock from './blocks/FormulaBlock'

/**
 * Copilot 回复渲染（§7.6）：raw 流文本 → splitCopilotStream → 分段渲染。
 * - prose 过 react-markdown + remark-gfm + remark-math + rehype-katex（不加 rehype-raw：HTML 一律转义）；
 * - citeToken 预处理为 [label](#cite-cX) 链接，a 组件覆盖为 CiteBadge；外链 _blank + noopener；
 * - 段级记忆化：闭合段 md 字符串不变即跳过重渲，只有开放尾段随 delta 重算；
 *   delta 的 rAF 批量合并在 CopilotPanel 完成。
 */

interface Props {
  content: string
  /** 流已结束（finalize）：未闭合岛转降级卡、残缺 citeToken 不再抑制 */
  done: boolean
  citeMap: readonly StoredCiteEntry[]
  badges: Readonly<Record<string, CiteLevel>> | null
  interrupted?: boolean
  insufficient?: boolean
  onJumpCite: (entry: StoredCiteEntry) => void
}

const CITE_HREF_PREFIX = '#cite-'

/** runs → markdown 源：cite run 变成 #cite- 链接（label 从 CiteMap 映射，missing 用 ⚠ 别名） */
function runsToMarkdown(runs: readonly ProseRun[], citeIndex: ReadonlyMap<string, StoredCiteEntry>): string {
  return runs
    .map((r) => {
      if (r.kind === 'text') return r.text
      const entry = citeIndex.get(r.alias)
      const label = entry ? citeLabel(r.alias, entry) : `⚠ ${r.alias}`
      return `[${label}](${CITE_HREF_PREFIX}${r.alias})`
    })
    .join('')
}

interface ProseSegProps {
  md: string
  citeIndex: ReadonlyMap<string, StoredCiteEntry>
  badges: Readonly<Record<string, CiteLevel>> | null
  onJumpCite: (entry: StoredCiteEntry) => void
}

/** 段级记忆化：md 与依赖引用都不变时整段跳过 react-markdown 重渲 */
const ProseSeg = memo(function ProseSeg({ md, citeIndex, badges, onJumpCite }: ProseSegProps) {
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children, ...rest }) => {
        if (typeof href === 'string' && href.startsWith(CITE_HREF_PREFIX)) {
          const alias = href.slice(CITE_HREF_PREFIX.length)
          const entry = citeIndex.get(alias)
          const level = badges?.[alias] ?? (entry ? 'ok' : 'missing')
          return <CiteBadge alias={alias} entry={entry} level={level} onJump={onJumpCite} />
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2" {...rest}>
            {children}
          </a>
        )
      },
      code: ({ children, className }) => (
        <code className={`rounded bg-panel-2 px-1 py-0.5 text-[0.75rem] text-accent ${className ?? ''}`}>{children}</code>
      ),
      table: ({ children }) => (
        <div className="overflow-x-auto">
          <table className="paper-md-table">{children}</table>
        </div>
      ),
    }),
    [citeIndex, badges, onJumpCite],
  )
  return (
    <div className="paper-md text-sm leading-relaxed break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components}>
        {md}
      </ReactMarkdown>
    </div>
  )
})

function IslandSeg({
  seg,
  done,
  citeIndex,
  badges,
  onJumpCite,
  citeMap,
}: {
  seg: Extract<CopilotSeg, { type: 'island' }>
  done: boolean
  citeIndex: ReadonlyMap<string, StoredCiteEntry>
  badges: Readonly<Record<string, CiteLevel>> | null
  onJumpCite: (entry: StoredCiteEntry) => void
  citeMap: readonly StoredCiteEntry[]
}) {
  if (!seg.closed) {
    return done ? <BlockFallback islandType={seg.islandType} failure="unclosed" raw={seg.raw} /> : <BlockSkeleton islandType={seg.islandType} />
  }
  if (!seg.block) {
    // plan/memo 是 advisory：坏了静默忽略（§7.5），其余降级卡
    if (seg.failure && (seg.islandType === 'plan' || seg.islandType === 'memo')) return null
    return <BlockFallback islandType={seg.islandType} failure={seg.failure ?? 'invalid'} raw={seg.raw} />
  }
  switch (seg.block.kind) {
    case 'plan':
      return <PlanChip plan={seg.block} />
    case 'memo':
      return null // 滚动摘要控制岛：不可见
    case 'evidence':
      if (seg.block.status !== 'insufficient') return null
      return (
        <div className="my-2 rounded-lg border border-warn/40 bg-panel-2 p-3 text-xs">
          <p className="mb-1 font-medium text-warn">论文中证据不足</p>
          {seg.block.note && <p className="mb-2 text-dim">{seg.block.note}</p>}
          {citeMap.length > 0 && (
            <p className="text-dim">
              已检索到的相关原文：
              {citeMap.map((e) => (
                <CiteBadge key={e.alias} alias={e.alias} entry={e} level="ok" onJump={onJumpCite} />
              ))}
            </p>
          )}
        </div>
      )
    case 'formula':
      return <FormulaBlock block={seg.block} citeIndex={citeIndex} badges={badges} onJump={onJumpCite} />
    case 'explanation': {
      const b = seg.block
      return (
        <div className="my-2 rounded-lg border border-line bg-panel-2 p-3">
          {b.level && (
            <span className="mb-1 inline-block rounded-full border border-accent/40 px-2 py-0.5 text-[0.65rem] text-accent">
              {b.level}
            </span>
          )}
          <ProseSeg md={runsToMarkdownFromText(b.text, citeIndex)} citeIndex={citeIndex} badges={badges} onJumpCite={onJumpCite} />
          {b.points.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs text-dim">
              {b.points.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )
    }
  }
}

/** explanation.text 内也允许 [[cite:cX]]（块内引用走 cites 字段，文本内 token 同样识别） */
function runsToMarkdownFromText(text: string, citeIndex: ReadonlyMap<string, StoredCiteEntry>): string {
  return text.replace(/\[\[cite:(c\d{1,3})\]\]/g, (_m, alias: string) => {
    const entry = citeIndex.get(alias)
    const label = entry ? citeLabel(alias, entry) : `⚠ ${alias}`
    return `[${label}](${CITE_HREF_PREFIX}${alias})`
  })
}

export default function CopilotMessage({ content, done, citeMap, badges, interrupted, insufficient, onJumpCite }: Props) {
  // 每条消息一个解析器实例：闭合岛校验结果缓存 + 未变全文直接复用
  const parseRef = useRef<ReturnType<typeof createStreamParserMemo> | null>(null)
  parseRef.current ??= createStreamParserMemo()
  const segs = parseRef.current(content, { open: !done })

  const citeIndex = useMemo(() => new Map(citeMap.map((e) => [e.alias, e])), [citeMap])

  const weakCount = useMemo(() => (badges ? Object.values(badges).filter((l) => l === 'weak').length : 0), [badges])
  const missingCount = useMemo(() => (badges ? Object.values(badges).filter((l) => l === 'missing').length : 0), [badges])

  return (
    <div className="space-y-1">
      {segs.map((seg, i) => {
        if (seg.type === 'prose') {
          return (
            <ProseSeg
              key={`p${i}`}
              md={runsToMarkdown(seg.runs, citeIndex)}
              citeIndex={citeIndex}
              badges={badges}
              onJumpCite={onJumpCite}
            />
          )
        }
        if (seg.type === 'code') {
          return (
            <pre key={`c${i}`} className="overflow-x-auto rounded-md border border-line bg-panel-2 p-3 text-xs">
              <code>{seg.text}</code>
            </pre>
          )
        }
        return (
          <IslandSeg
            key={`i${i}`}
            seg={seg}
            done={done}
            citeIndex={citeIndex}
            badges={badges}
            onJumpCite={onJumpCite}
            citeMap={citeMap}
          />
        )
      })}

      {insufficient && !segs.some((s) => s.type === 'island' && s.block?.kind === 'evidence') && (
        <p className="rounded border border-warn/40 bg-panel-2 px-2 py-1 text-[0.7rem] text-warn">
          本轮未能在论文中找到足够证据，以上内容仅供参考。
        </p>
      )}
      {interrupted && <p className="text-[0.7rem] text-warn">响应中断（已保留部分内容）</p>}
      {done && (weakCount > 0 || missingCount > 0) && (
        <p className="text-[0.7rem] text-dim">
          引用体检：
          {weakCount > 0 && `${weakCount} 处词面支持较弱（空心徽章）`}
          {weakCount > 0 && missingCount > 0 && '；'}
          {missingCount > 0 && `${missingCount} 处引用无法定位（灰色徽章）`}
        </p>
      )}
    </div>
  )
}
