import type { ReactNode } from 'react'

export type StatusTone = 'neutral' | 'measured' | 'estimated' | 'target' | 'ok' | 'warn' | 'bad'

const toneClasses: Record<StatusTone, string> = {
  neutral: 'border-line bg-panel-2 text-dim',
  measured: 'border-ok/30 bg-ok/10 text-ok',
  estimated: 'border-accent-2/30 bg-accent-2/10 text-accent-2',
  target: 'border-accent/30 bg-accent/10 text-accent',
  ok: 'border-ok/30 bg-ok/10 text-ok',
  warn: 'border-warn/30 bg-warn/10 text-warn',
  bad: 'border-bad/30 bg-bad/10 text-bad',
}

export function StatusBadge({ tone = 'neutral', children }: { tone?: StatusTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${toneClasses[tone]}`}>
      {children}
    </span>
  )
}

export function Panel({
  children,
  className = '',
  as: Tag = 'div',
}: {
  children: ReactNode
  className?: string
  as?: 'div' | 'section' | 'aside'
}) {
  return <Tag className={`min-w-0 rounded-xl border border-line bg-panel p-4 shadow-sm ${className}`}>{children}</Tag>
}

export function MetricTile({
  label,
  value,
  note,
  badge,
}: {
  label: string
  value: ReactNode
  note?: ReactNode
  badge?: ReactNode
}) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-panel-2/50 p-3">
      <div className="flex min-w-0 items-start justify-between gap-2 text-xs text-dim">
        <span>{label}</span>
        {badge}
      </div>
      <div className="mt-1 break-words font-mono text-xl font-bold text-fg">{value}</div>
      {note && <div className="mt-1 text-[11px] leading-relaxed text-dim">{note}</div>}
    </div>
  )
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-panel-2/40 px-4 py-8 text-center">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mx-auto mt-2 max-w-2xl text-xs leading-relaxed text-dim">{children}</div>
    </div>
  )
}

export const inputClass =
  'mt-1 min-h-11 w-full rounded-md border border-line bg-panel-2 px-2.5 py-2 text-sm text-fg placeholder:text-dim/70'

