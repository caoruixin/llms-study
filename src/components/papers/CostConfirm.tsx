import { PAPER_PROVIDER_LABELS, type PaperProviderId } from '../../data/paperPolicy'
import { formatTokens, formatUsd } from '../../lib/paper/usage'

/** 成本二次确认（§5.4）：超过阈值时展示 provider、预算与原因 */

export interface CostConfirmInfo {
  provider: PaperProviderId
  estCost: number
  threshold: number
  inputTokens: number
  reason: string
}

interface Props {
  info: CostConfirmInfo
  onDecide: (ok: boolean) => void
}

export default function CostConfirm({ info, onDecide }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 backdrop-blur-[1px]">
      <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-xl">
        <h3 className="mb-2 font-semibold text-fg">本次调用成本超过阈值</h3>
        <dl className="mb-4 space-y-1.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-dim">服务商</dt>
            <dd className="text-fg">{PAPER_PROVIDER_LABELS[info.provider]}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-dim">预估成本</dt>
            <dd className="font-medium text-warn">{formatUsd(info.estCost)}（阈值 {formatUsd(info.threshold)}）</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-dim">预估输入</dt>
            <dd className="text-fg">≈ {formatTokens(info.inputTokens)} tokens</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="shrink-0 text-dim">原因</dt>
            <dd className="text-right text-fg">{info.reason}</dd>
          </div>
        </dl>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onDecide(false)}
            className="rounded-lg border border-line bg-panel px-4 py-1.5 text-sm text-fg transition-colors hover:bg-panel-2"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onDecide(true)}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
          >
            继续调用
          </button>
        </div>
      </div>
    </div>
  )
}
