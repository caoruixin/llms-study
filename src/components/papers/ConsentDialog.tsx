import { PAPER_PROVIDER_LABELS, type PaperProviderId } from '../../data/paperPolicy'

/**
 * provider 独立授权对话框（§8）：首次向某 provider 发送论文内容前弹出，
 * 说明发送范围与成本上限；授权按 provider 独立记录（Dexie consents 表），不跨厂继承。
 */

interface Props {
  provider: PaperProviderId
  onDecide: (granted: boolean) => void
}

const SCOPE_LINES = [
  '仅发送：本轮检索命中的论文片段、你的问题与选区、对话摘要',
  '不发送：原始文件、文件名、其他论文、学习记录、任何身份信息',
  '授权按服务商独立记录，可随时在对话中拒绝后续请求（刷新后重新询问前保持生效）',
]

export default function ConsentDialog({ provider, onDecide }: Props) {
  const label = PAPER_PROVIDER_LABELS[provider]
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 backdrop-blur-[1px]">
      <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-xl">
        <h3 className="mb-2 font-semibold text-fg">向 {label} 发送论文内容？</h3>
        <p className="mb-3 text-sm leading-relaxed text-dim">
          陪读回答由 {label} 生成。继续前请确认允许把论文片段发送给该服务商：
        </p>
        <ul className="mb-3 space-y-1.5 text-xs leading-relaxed text-dim">
          {SCOPE_LINES.map((l) => (
            <li key={l} className="flex gap-2">
              <span className="shrink-0 text-accent">·</span>
              <span>{l}</span>
            </li>
          ))}
        </ul>
        <p className="mb-4 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-dim">
          成本上限：普通一轮约 {provider === 'deepseek' ? '$0.007' : '$0.06'}，超过{' '}
          {provider === 'deepseek' ? '$0.02' : '$0.15'} 会再次单独确认。
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onDecide(false)}
            className="rounded-lg border border-line bg-panel px-4 py-1.5 text-sm text-fg transition-colors hover:bg-panel-2"
          >
            暂不授权
          </button>
          <button
            type="button"
            onClick={() => onDecide(true)}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
          >
            授权 {label}
          </button>
        </div>
      </div>
    </div>
  )
}
