import type { CiteLevel } from '../../../lib/paper/citations'
import type { StoredCiteEntry } from '../../../lib/paper/types'
import CiteBadge from '../CiteBadge'

/** 展示块底部的「依据」引用行（各块共用；无引用时不渲染） */
export default function BlockCites({
  cites,
  citeIndex,
  badges,
  onJump,
}: {
  cites: readonly string[]
  citeIndex: ReadonlyMap<string, StoredCiteEntry>
  badges: Readonly<Record<string, CiteLevel>> | null
  onJump: (entry: StoredCiteEntry) => void
}) {
  if (cites.length === 0) return null
  return (
    <div className="mt-2 text-[0.7rem] text-dim">
      依据：
      {cites.map((alias) => (
        <CiteBadge
          key={alias}
          alias={alias}
          entry={citeIndex.get(alias)}
          level={badges?.[alias] ?? (citeIndex.has(alias) ? 'ok' : 'missing')}
          onJump={onJump}
        />
      ))}
    </div>
  )
}
