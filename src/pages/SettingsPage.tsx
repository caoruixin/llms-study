import { PROVIDERS, useSettings } from '../store'
import type { ProviderId } from '../store'

export default function SettingsPage() {
  const { provider, model, userKey, setProvider, setModel, setUserKey } = useSettings()
  const preset = PROVIDERS.find((p) => p.id === provider)!

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">设置</h1>
      <section className="space-y-4 rounded-xl border border-line bg-panel shadow-sm p-5">
        <h2 className="font-semibold text-accent">评分用 LLM API</h2>
        <label className="block space-y-1">
          <span className="text-sm text-dim">Provider（固定 allowlist，代理转发）</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
            className="w-full rounded-md border border-line bg-panel-2 px-3 py-2"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-dim">模型 ID</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={preset.defaultModel}
            className="w-full rounded-md border border-line bg-panel-2 px-3 py-2"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-dim">API Key（只存本会话 sessionStorage，不落盘；留空则使用 .env.local 中配置）</span>
          <input
            type="password"
            value={userKey}
            onChange={(e) => setUserKey(e.target.value)}
            placeholder="sk-..."
            className="w-full rounded-md border border-line bg-panel-2 px-3 py-2"
          />
        </label>
        <p className="text-xs leading-relaxed text-dim">
          推荐方式：在项目根目录复制 <code className="text-accent">.env.example</code> 为{' '}
          <code className="text-accent">.env.local</code> 填入 key（不进前端代码，由 dev 代理注入鉴权头），改完需重启{' '}
          <code className="text-accent">npm run dev</code>。此处粘贴的 key 走同源
          <code className="text-accent"> X-User-Key </code>头，由代理改写为上游 Authorization。
        </p>
      </section>
    </div>
  )
}
