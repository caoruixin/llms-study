import type { CiteLevel } from '../../lib/paper/citations'
import type { StoredCiteEntry } from '../../lib/paper/types'

/**
 * 引用徽章（§8.1）：点击滚动到原文并短暂高亮；页码由 CiteMap 映射（模型只产别名）。
 * 三种档位：ok 实心 / weak 空心（词面弱支持）/ missing 灰色不可点（幻觉 ID）。
 */

interface Props {
  alias: string
  entry: StoredCiteEntry | undefined
  level: CiteLevel
  onJump: (entry: StoredCiteEntry) => void
}

export function citeLabel(alias: string, entry: StoredCiteEntry | undefined): string {
  if (!entry) return alias
  if (entry.page !== undefined) return `p.${entry.page}`
  if (entry.section) return `§${entry.section.slice(0, 12)}`
  return alias
}

export default function CiteBadge({ alias, entry, level, onJump }: Props) {
  if (level === 'missing' || !entry) {
    return (
      <span
        title={`引用 ${alias} 不在本轮白名单内，无法定位到原文`}
        className="mx-0.5 inline-flex -translate-y-px items-center gap-0.5 rounded border border-line bg-panel-2 px-1 align-middle text-[0.65rem] leading-4 text-dim"
      >
        ⚠ {alias}
      </span>
    )
  }
  const weak = level === 'weak'
  return (
    <button
      type="button"
      onClick={() => onJump(entry)}
      title={weak ? `跳到原文 ${citeLabel(alias, entry)}（词面支持较弱，请自行核对）` : `跳到原文 ${citeLabel(alias, entry)}`}
      className={`mx-0.5 inline-flex -translate-y-px cursor-pointer items-center rounded border px-1 align-middle text-[0.65rem] leading-4 transition-colors ${
        weak
          ? 'border-dashed border-accent/50 bg-transparent text-accent/80 hover:bg-accent/10'
          : 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/20'
      }`}
    >
      {citeLabel(alias, entry)}
      {weak ? '?' : ''}
    </button>
  )
}
