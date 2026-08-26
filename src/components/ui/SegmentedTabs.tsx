import { useRef, type KeyboardEvent } from 'react'

interface SegmentedTabsProps<T extends string> {
  tabs: readonly { readonly id: T; readonly label: string }[]
  value: T
  onChange: (id: T) => void
  ariaLabel?: string
}

export default function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel = '视图切换',
}: SegmentedTabsProps<T>) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (tabs.length === 0) return

    let nextIndex: number | null = null
    switch (event.key) {
      case 'ArrowLeft':
        nextIndex = (index - 1 + tabs.length) % tabs.length
        break
      case 'ArrowRight':
        nextIndex = (index + 1) % tabs.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = tabs.length - 1
        break
      default:
        return
    }

    event.preventDefault()
    const nextTab = tabs[nextIndex]
    onChange(nextTab.id)
    tabRefs.current[nextIndex]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      className="flex max-w-full gap-1 overflow-x-auto rounded-lg border border-line bg-panel p-1 shadow-sm md:inline-flex md:w-auto md:flex-wrap md:overflow-visible"
    >
      {tabs.map((t, index) => (
        <button
          key={t.id}
          ref={(element) => { tabRefs.current[index] = element }}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(event) => handleKeyDown(event, index)}
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
