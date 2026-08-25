// 参考资料块:编号与决策卡收益条目的 [n] 角标一一对应(n = sourceIdx + 1)。
import type { ArchSource } from '../../data/archAtlas'

const KIND_LABEL: Record<ArchSource['kind'], string> = {
  paper: '论文',
  blog: '博客',
  docs: '文档',
  video: '视频',
  github: 'GitHub',
}

const KIND_CLASS: Record<ArchSource['kind'], string> = {
  paper: 'bg-accent/15 text-accent',
  blog: 'bg-accent-2/15 text-accent-2',
  docs: 'bg-ok/15 text-ok',
  video: 'bg-amber/15 text-amber',
  github: 'bg-panel-2 text-dim',
}

export interface ArchSourcesProps {
  sources: readonly ArchSource[]
}

export default function ArchSources({ sources }: ArchSourcesProps) {
  return (
    <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
      <div className="mb-2 text-xs font-semibold tracking-wide text-dim">参考资料(可点开原文核对)</div>
      <ol className="space-y-1.5 text-sm leading-relaxed">
        {sources.map((s, i) => (
          <li key={s.sourceUrl} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-xs text-dim">[{i + 1}]</span>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${KIND_CLASS[s.kind]}`}>
              {KIND_LABEL[s.kind]}
            </span>
            <a
              href={s.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 break-words text-accent hover:underline"
            >
              {s.title}({s.asOf})↗
            </a>
          </li>
        ))}
      </ol>
    </div>
  )
}
