import { useState } from 'react'
import type { ClaimScanResult } from '../../lib/paper/sync/syncEngine'

/**
 * 认领横幅（P4）：登录后发现游客库（paper-copilot）里有未同步的 ready 论文时，
 * 在论文库顶部提示「全部同步到账号 / 暂不」。同 sha 撞车的论文单独说明——
 * 它们只合并进度，不迁会话（v1 收敛策略，见 PLAN）。
 */

interface Props {
  scan: ClaimScanResult
  onClaim: () => Promise<void>
  onDismiss: () => void
}

export default function ClaimBanner({ scan, onClaim, onDismiss }: Props) {
  const [busy, setBusy] = useState(false)
  const total = scan.fresh.length + scan.dupes.length

  return (
    <div className="rounded-xl border border-accent/40 bg-panel p-4 shadow-sm">
      <p className="mb-1 font-medium text-fg">本地有 {total} 篇未同步到账号的论文</p>
      <p className="mb-3 text-sm leading-relaxed text-dim">
        这些论文是登录前导入的，目前只存在本浏览器。同步后可在任何设备打开。
        {scan.dupes.length > 0 && (
          <>
            <br />
            其中 {scan.dupes.length} 篇账号已有同篇（内容完全相同），将只合并阅读进度。
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void onClaim().finally(() => setBusy(false))
          }}
          className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? '正在同步…' : '全部同步到账号'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDismiss}
          className="rounded-lg border border-line bg-panel px-4 py-1.5 text-sm text-dim transition-colors hover:bg-panel-2"
        >
          暂不
        </button>
      </div>
    </div>
  )
}
