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
    <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg border border-line bg-panel p-1 shadow-sm md:inline-flex md:w-auto md:flex-wrap md:overflow-visible">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`shrink-0 whitespace-nowrap rounded-md px-4 py-2 md:py-1.5 text-sm font-medium transition-colors ${
            value === t.id ? 'bg-accent text-white' : 'text-dim hover:bg-panel-2 hover:text-fg'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
