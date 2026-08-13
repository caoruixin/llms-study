import type { IslandFailure } from '../../../lib/paper/blockSchemas'

/**
 * 结构岛降级卡（§7.5 矩阵）：不重试、不打断周围 prose，半截/原始 JSON 收进 details。
 */

const FAILURE_LABELS: Record<IslandFailure | 'unclosed', string> = {
  'bad-json': '交互块解析失败',
  invalid: '交互块字段无法修复',
  'unknown-type': '未知交互类型（可能来自更新版本）',
  'too-large': '交互块超出大小上限（8KB），已截断',
  unclosed: '交互块未完成（响应中断）',
}

interface Props {
  islandType: string
  failure: IslandFailure | 'unclosed'
  raw: string
}

export default function BlockFallback({ islandType, failure, raw }: Props) {
  return (
    <div className="my-2 rounded-lg border border-warn/40 bg-panel-2 p-2.5 text-xs">
      <p className="text-warn">
        {FAILURE_LABELS[failure]}（copilot:{islandType}）
      </p>
      {raw.trim() !== '' && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[0.7rem] text-dim">展开原始内容</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-panel p-2 text-[0.7rem] leading-relaxed whitespace-pre-wrap text-dim">
            {raw.slice(0, 2000)}
          </pre>
        </details>
      )}
    </div>
  )
}
