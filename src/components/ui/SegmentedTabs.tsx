interface SegmentedTabsProps<T extends string> {
  tabs: readonly { readonly id: T; readonly label: string }[]
  value: T
  onChange: (id: T) => void
}

export default function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
}: SegmentedTabsProps<T>) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-lg border border-line bg-panel p-1 shadow-sm">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
            value === t.id ? 'bg-accent text-white' : 'text-dim hover:bg-panel-2 hover:text-fg'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
