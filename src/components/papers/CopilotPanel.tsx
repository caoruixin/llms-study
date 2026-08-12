import { describeTarget, type ScrollTarget } from '../../lib/paper/anchors'
import type { PendingAsk } from '../../pages/papers/paperUiStore'
import type { SourceAnchor } from '../../lib/paper/types'

/**
 * 右栏 Copilot 占位（Phase 3 接入真实对话）。
 * Phase 2 的职责有两个：说明能力边界与隐私承诺，以及展示选区快捷操作攒下的待提问队列。
 */

const CAPABILITIES = [
  '论文地图：一句话结论、研究问题、核心贡献、方法管线、实验与局限',
  '逐节精读与方法拆解，按你的掌握程度自动调整讲解层次',
  '公式推导、算法步骤器、对比表与概念关系图',
  '每条论文事实都带可点击回跳原文的引用，证据不足时明说不编造',
  '选择题、闪卡与 Teach-back 复述，检查你是否真的理解了',
]

interface Props {
  asks: PendingAsk[]
  onRemove: (id: string) => void
  onClear: () => void
  onJump: (anchor: SourceAnchor) => ScrollTarget
  onClose: () => void
}

export default function CopilotPanel({ asks, onRemove, onClear, onJump, onClose }: Props) {
  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-semibold text-accent">Paper Copilot</h2>
        <button type="button" onClick={onClose} className="text-sm text-dim transition-colors hover:text-fg">
          收起
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {asks.length > 0 && (
          <section className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-fg">已加入提问（{asks.length}）</p>
              <button type="button" onClick={onClear} className="text-xs text-dim transition-colors hover:text-fg">
                清空
              </button>
            </div>
            <p className="mb-2 rounded-lg border border-warn/40 bg-panel-2 px-2 py-1.5 text-[0.7rem] leading-relaxed text-warn">
              已加入提问（Copilot Phase 3 接入）。在此之前这些选段只留在本机，不会发送给任何模型。
            </p>
            <ul className="space-y-2">
              {asks.map((ask) => (
                <li key={ask.id} className="rounded-lg border border-line bg-panel-2 p-2">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="rounded border border-accent/40 px-1.5 py-0.5 text-[0.65rem] text-accent">
                      {ask.label}
                    </span>
                    <button
                      type="button"
                      onClick={() => onRemove(ask.id)}
                      className="text-[0.7rem] text-dim transition-colors hover:text-bad"
                    >
                      移除
                    </button>
                  </div>
                  <p className="line-clamp-3 text-[0.7rem] leading-relaxed text-fg">{ask.text}</p>
                  <button
                    type="button"
                    onClick={() => onJump(ask.anchor)}
                    className="mt-1 text-[0.65rem] text-dim underline-offset-2 transition-colors hover:text-accent hover:underline"
                  >
                    回到原文 ·{' '}
                    {describeTarget({
                      mode: 'text',
                      precision: 'block',
                      blockIndex: ask.anchor.blockIndex,
                      page: ask.anchor.page,
                      section: ask.anchor.section,
                    })}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="mb-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs leading-relaxed text-dim">
          陪读对话将在 Phase 3 接入。届时会先明确告知发送范围并单独征求授权，未授权前论文内容不出本机。
        </p>
        <ul className="space-y-2">
          {CAPABILITIES.map((c) => (
            <li key={c} className="flex gap-2 text-xs leading-relaxed text-dim">
              <span className="shrink-0 text-accent">·</span>
              <span>{c}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
