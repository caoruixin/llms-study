interface StepControlsProps {
  index: number
  count: number
  onChange: (index: number) => void
  playable?: boolean
  playing?: boolean
  onPlayingChange?: (playing: boolean) => void
  labels?: readonly string[]
}

export default function StepControls({
  index,
  count,
  onChange,
  playable,
  playing,
  onPlayingChange,
  labels,
}: StepControlsProps) {
  const atStart = index <= 0
  const atEnd = index >= count - 1
  const currentLabel = labels?.[index]

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel shadow-sm p-3">
      <button
        type="button"
        onClick={() => onChange(index - 1)}
        disabled={atStart}
        className="rounded-lg border border-line bg-panel px-4 py-2 text-sm font-medium text-fg hover:bg-panel-2 disabled:opacity-40"
      >
        上一步
      </button>
      <button
        type="button"
        onClick={() => onChange(index + 1)}
        disabled={atEnd}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-40"
      >
        下一步
      </button>
      {playable && (
        <button
          type="button"
          onClick={() => onPlayingChange?.(!playing)}
          className="rounded-lg border border-line bg-panel px-4 py-2 text-sm font-medium text-fg hover:bg-panel-2"
        >
          {playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
      )}
      <span className="text-xs text-dim">
        {index + 1} / {count}
        {currentLabel ? ` · ${currentLabel}` : ''}
      </span>
    </div>
  )
}
