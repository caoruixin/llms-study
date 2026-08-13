import type { ComparisonBlockData } from '../../../lib/paper/blockSchemas'
import type { CiteLevel } from '../../../lib/paper/citations'
import type { StoredCiteEntry } from '../../../lib/paper/types'
import BlockCites from './BlockCites'

/**
 * comparison 展示块（§7.2）：方法/实验/概念对比表。
 * 行列上限由校验器钳位；表格放在 overflow-x-auto 容器内——窄屏只让表格横滚，页面不横滚。
 */

interface Props {
  block: ComparisonBlockData
  citeIndex: ReadonlyMap<string, StoredCiteEntry>
  badges: Readonly<Record<string, CiteLevel>> | null
  onJump: (entry: StoredCiteEntry) => void
}

export default function ComparisonBlock({ block, citeIndex, badges, onJump }: Props) {
  return (
    <div className="my-2 rounded-lg border border-line bg-panel-2 p-3">
      {block.title && <p className="mb-2 text-xs font-medium text-fg">{block.title}</p>}
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-max border-collapse text-[0.7rem]">
          <thead>
            <tr>
              <th className="border-b border-line px-2 py-1 text-left font-medium text-dim" />
              {block.columns.map((c, i) => (
                <th key={i} className="border-b border-line px-2 py-1 text-left font-medium text-fg">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={ri} className={ri % 2 === 1 ? 'bg-panel/60' : undefined}>
                <th scope="row" className="px-2 py-1 text-left align-top font-medium break-words text-dim">
                  {row.label}
                </th>
                {row.cells.map((cell, ci) => (
                  <td key={ci} className="px-2 py-1 align-top break-words text-fg">
                    {cell || '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <BlockCites cites={block.cites} citeIndex={citeIndex} badges={badges} onJump={onJump} />
    </div>
  )
}
