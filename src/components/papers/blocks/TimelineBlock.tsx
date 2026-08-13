import type { TimelineBlockData } from '../../../lib/paper/blockSchemas'
import type { CiteLevel } from '../../../lib/paper/citations'
import type { StoredCiteEntry } from '../../../lib/paper/types'
import BlockCites from './BlockCites'

/**
 * timeline 展示块（§7.2）：论文脉络或算法阶段线。
 * 自适应方向——窄栏（Copilot 标准档 ≈18rem 内宽、手机底部面板）用竖排时间线，
 * 宽栏（容器 ≥24rem，即 @sm：加宽/超宽档与专注陪读）用横排卡片。
 * 断点必须是**容器**（@sm）而非视口（sm）：同一视口下面板宽度有三档。
 */

interface Props {
  block: TimelineBlockData
  citeIndex: ReadonlyMap<string, StoredCiteEntry>
  badges: Readonly<Record<string, CiteLevel>> | null
  onJump: (entry: StoredCiteEntry) => void
}

export default function TimelineBlock({ block, citeIndex, badges, onJump }: Props) {
  return (
    <div className="my-2 rounded-lg border border-line bg-panel-2 p-3">
      {block.title && <p className="mb-2 text-xs font-medium text-fg">{block.title}</p>}
      <ol className="flex flex-col gap-2 @sm:flex-row @sm:flex-wrap">
        {block.items.map((item, i) => (
          <li
            key={i}
            className="relative min-w-0 border-l-2 border-accent/40 pl-3 @sm:min-w-[9rem] @sm:flex-1 @sm:border-t-2 @sm:border-l-0 @sm:pt-2 @sm:pl-0"
          >
            <span className="absolute -left-[5px] top-1 h-2 w-2 rounded-full bg-accent @sm:-top-[5px] @sm:left-0" />
            {item.at && <p className="text-[0.65rem] text-accent">{item.at}</p>}
            <p className="text-xs font-medium break-words text-fg">{item.title}</p>
            {item.detail && <p className="mt-0.5 text-[0.7rem] leading-relaxed break-words text-dim">{item.detail}</p>}
          </li>
        ))}
      </ol>
      <BlockCites cites={block.cites} citeIndex={citeIndex} badges={badges} onJump={onJump} />
    </div>
  )
}
