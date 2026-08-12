/** 未闭合结构岛的占位（§7.4）：类型标签 + 定高 shimmer，防布局跳动 */

const TYPE_LABELS: Record<string, string> = {
  explanation: '讲解块',
  formula: '公式块',
  plan: '教学计划',
  memo: '摘要',
  evidence: '证据核对',
}

export default function BlockSkeleton({ islandType }: { islandType: string }) {
  return (
    <div className="my-2 h-20 rounded-lg border border-line bg-panel-2 p-3">
      <div className="mb-2 text-[0.65rem] text-dim">{TYPE_LABELS[islandType] ?? islandType} 生成中…</div>
      <div className="space-y-2">
        <div className="h-2.5 w-3/4 animate-pulse rounded bg-line/60" />
        <div className="h-2.5 w-1/2 animate-pulse rounded bg-line/60" />
      </div>
    </div>
  )
}
