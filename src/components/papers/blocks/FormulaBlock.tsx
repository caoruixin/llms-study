import { useMemo } from 'react'
import katex from 'katex'
import type { FormulaBlockData } from '../../../lib/paper/blockSchemas'
import type { CiteLevel } from '../../../lib/paper/citations'
import type { StoredCiteEntry } from '../../../lib/paper/types'
import CiteBadge from '../CiteBadge'

/**
 * formula 展示块（§7.2/§7.6）：expr 用 KaTeX 渲染（失败回退等宽原文）+ 各项含义表 + 推导步骤。
 * KaTeX 产出的 HTML 来自本地渲染器（模型只提供 LaTeX 字符串），不含脚本。
 */

interface Props {
  block: FormulaBlockData
  citeIndex: ReadonlyMap<string, StoredCiteEntry>
  badges: Readonly<Record<string, CiteLevel>> | null
  onJump: (entry: StoredCiteEntry) => void
}

function Katex({ expr }: { expr: string }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(expr, { displayMode: true, throwOnError: true, output: 'html' })
    } catch {
      return null
    }
  }, [expr])
  if (html === null) {
    return <pre className="overflow-x-auto rounded bg-panel p-2 text-xs text-fg">{expr}</pre>
  }
  return <div className="overflow-x-auto py-1 text-fg" dangerouslySetInnerHTML={{ __html: html }} />
}

export default function FormulaBlock({ block, citeIndex, badges, onJump }: Props) {
  return (
    <div className="my-2 rounded-lg border border-line bg-panel-2 p-3">
      <Katex expr={block.expr} />
      {block.terms.length > 0 && (
        <dl className="mt-2 space-y-1 border-t border-line pt-2 text-xs">
          {block.terms.map((t, i) => (
            <div key={`${t.sym}-${i}`} className="flex gap-2">
              <dt className="shrink-0 font-mono text-accent">{t.sym}</dt>
              <dd className="text-dim">{t.mean}</dd>
            </div>
          ))}
        </dl>
      )}
      {block.steps.length > 0 && (
        <ol className="mt-2 list-decimal space-y-1 border-t border-line pt-2 pl-5 text-xs text-fg">
          {block.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      {block.cites.length > 0 && (
        <div className="mt-2 text-[0.7rem] text-dim">
          依据：
          {block.cites.map((alias) => (
            <CiteBadge
              key={alias}
              alias={alias}
              entry={citeIndex.get(alias)}
              level={badges?.[alias] ?? (citeIndex.has(alias) ? 'ok' : 'missing')}
              onJump={onJump}
            />
          ))}
        </div>
      )}
    </div>
  )
}
