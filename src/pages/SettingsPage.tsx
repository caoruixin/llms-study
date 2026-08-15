import { useCallback, useEffect, useState } from 'react'
import { LLM_PROVIDERS } from '../../shared/apiTypes'
import type { AdminUser, InviteCode, LlmProvider, MeResponse } from '../../shared/apiTypes'
import { ApiRequestError, authApi } from '../lib/auth/apiClient'
import { useAuthStore } from '../lib/auth/authStore'
import { AuthForms } from '../components/auth/LoginDialog'
import { PROVIDERS, useSettings } from '../store'
import type { ProviderId } from '../store'

/**
 * 设置页：账号（登录/注册、改密、登出）、LLM Key 托管（按 provider，只见 last4）、
 * admin 管理面（邀请码/用户）、评分用 provider/model 本地选择、本地数据占位。
 * 旧「API Key 存 sessionStorage」区块已删除——key 一律加密托管在服务端、按登录态注入。
 */

const sectionCls = 'space-y-4 rounded-xl border border-line bg-panel shadow-sm p-5'
const inputCls = 'w-full rounded-md border border-line bg-panel-2 px-3 py-2 text-sm'

/** provider → 展示名（key 托管区含 jina；与 shared LLM_PROVIDERS 全集对齐） */
const PROVIDER_LABELS: Record<LlmProvider, string> = {
  deepseek: 'DeepSeek',
  moonshot: 'Kimi (Moonshot)',
  zhipu: '智谱 GLM',
  'openai-compat': 'OpenAI 兼容端点',
  jina: 'Jina（检索/重排）',
}

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`
  return `${Math.ceil(n / 1024)} KB`
}

function errText(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message
  return e instanceof Error ? e.message : '操作失败，请重试'
}

// ---------------------------------------------------------------------------
// 改密表单
// ---------------------------------------------------------------------------
function ChangePasswordForm() {
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const submit = async () => {
    if (pending || !oldPassword || !newPassword) return
    setPending(true)
    setMsg(null)
    try {
      await authApi.changePassword({ oldPassword, newPassword })
      setOldPassword('')
      setNewPassword('')
      setMsg({ ok: true, text: '密码已修改；其它设备的登录已全部失效' })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <p className="text-sm font-medium text-fg">修改密码</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          type="password"
          value={oldPassword}
          onChange={(e) => setOldPassword(e.target.value)}
          placeholder="旧密码"
          autoComplete="current-password"
          className={inputCls}
        />
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="新密码（至少 8 位）"
          autoComplete="new-password"
          className={inputCls}
        />
      </div>
      {msg && <p className={`text-xs ${msg.ok ? 'text-ok' : 'text-bad'}`}>{msg.text}</p>}
      <button
        type="submit"
        disabled={pending || !oldPassword || newPassword.length < 8}
        className="min-h-11 rounded-lg border border-line px-4 text-sm text-fg transition-colors hover:bg-panel-2 disabled:opacity-40 md:min-h-0 md:py-1.5"
      >
        {pending ? '提交中…' : '修改密码'}
      </button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// LLM Key 托管：每 provider 一行；key 只在提交瞬间过内存，展示永远只有 last4
// ---------------------------------------------------------------------------
function LlmKeyRow({ provider, info }: { provider: LlmProvider; info: { last4: string } | null }) {
  const refresh = useAuthStore((s) => s.refresh)
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    const key = value.trim()
    if (pending || key.length < 8) return
    setPending(true)
    setError('')
    try {
      await authApi.putLlmKey(provider, key)
      setValue('') // 提交即清空：明文不留在输入框
      await refresh() // llmKeys last4 以服务端为准
    } catch (e) {
      setError(errText(e))
    } finally {
      setPending(false)
    }
  }

  const remove = async () => {
    if (pending) return
    setPending(true)
    setError('')
    try {
      await authApi.deleteLlmKey(provider)
      await refresh()
    } catch (e) {
      setError(errText(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="rounded-lg border border-line bg-panel-2 p-3">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-fg">{PROVIDER_LABELS[provider]}</span>
        {info ? (
          <span className="flex items-center gap-2 text-xs">
            <code className="text-accent">sk-***{info.last4}</code>
            <button
              type="button"
              onClick={() => void remove()}
              disabled={pending}
              className="min-h-11 px-2 text-dim transition-colors hover:text-bad disabled:opacity-40 md:min-h-0"
            >
              清除
            </button>
          </span>
        ) : (
          <span className="text-xs text-dim">未配置</span>
        )}
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={info ? '粘贴新 key 可覆盖' : 'sk-...'}
          autoComplete="off"
          className={inputCls}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={pending || value.trim().length < 8}
          className="min-h-11 shrink-0 rounded-lg bg-accent px-3 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
        >
          保存
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-bad">{error}</p>}
    </div>
  )
}

function LlmKeysSection({ user }: { user: MeResponse }) {
  return (
    <section className={sectionCls}>
      <h2 className="font-semibold text-accent">LLM API Key</h2>
      {user.role === 'admin' ? (
        <p className="text-sm leading-relaxed text-dim">
          管理员账号使用站点服务端 key，无需配置；服务端会按调用记录审计用量。
        </p>
      ) : (
        <>
          <p className="text-xs leading-relaxed text-dim">
            key 加密保存在服务器（AES-256-GCM，绑定你的账号），调用时由服务端注入，浏览器与页面
            都接触不到明文；此处永远只显示末四位，可随时清除。
          </p>
          <div className="space-y-2">
            {LLM_PROVIDERS.map((p) => (
              <LlmKeyRow key={p} provider={p} info={user.llmKeys[p]} />
            ))}
          </div>
        </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// admin 管理面：邀请码 + 用户列表（简洁实现）
// ---------------------------------------------------------------------------
function inviteStatus(inv: InviteCode, now: number): { text: string; cls: string } {
  if (inv.usedBy !== null) return { text: `已使用（用户 #${inv.usedBy}）`, cls: 'text-dim' }
  if (inv.expiresAt !== null && inv.expiresAt <= now) return { text: '已过期', cls: 'text-bad' }
  return { text: '可用', cls: 'text-ok' }
}

function AdminSection({ selfId }: { selfId: number }) {
  const [invites, setInvites] = useState<InviteCode[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [expiresInDays, setExpiresInDays] = useState('')
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const [inv, us] = await Promise.all([authApi.adminInvites(), authApi.adminUsers()])
      setInvites(inv)
      setUsers(us)
    } catch (e) {
      setError(errText(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const createInvite = async () => {
    if (pending) return
    const days = expiresInDays.trim() === '' ? undefined : Number(expiresInDays)
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) {
      setError('有效期须为 1-365 的整数天数（留空 = 永不过期）')
      return
    }
    setPending(true)
    setError('')
    try {
      const inv = await authApi.adminCreateInvite({
        ...(days !== undefined ? { expiresInDays: days } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      setInvites((list) => [inv, ...list])
      setNote('')
    } catch (e) {
      setError(errText(e))
    } finally {
      setPending(false)
    }
  }

  const toggleDisabled = async (u: AdminUser) => {
    try {
      const updated = await authApi.adminUpdateUser(u.id, { disabled: !u.disabled })
      setUsers((list) => list.map((x) => (x.id === u.id ? updated : x)))
    } catch (e) {
      setError(errText(e))
    }
  }

  const now = Date.now()
  return (
    <section className={sectionCls}>
      <h2 className="font-semibold text-accent">管理员</h2>
      {error && <p className="text-xs text-bad">{error}</p>}

      <div className="space-y-2">
        <p className="text-sm font-medium text-fg">生成邀请码</p>
        <div className="flex flex-wrap gap-2">
          <input
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
            inputMode="numeric"
            placeholder="有效期天数（留空=永久）"
            className={`${inputCls} w-44 flex-none`}
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="备注（给谁的）"
            className={`${inputCls} min-w-0 flex-1`}
          />
          <button
            type="button"
            onClick={() => void createInvite()}
            disabled={pending}
            className="min-h-11 shrink-0 rounded-lg bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
          >
            生成
          </button>
        </div>
        {invites.length > 0 && (
          <ul className="space-y-1.5">
            {invites.map((inv) => {
              const st = inviteStatus(inv, now)
              return (
                <li
                  key={inv.code}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-panel-2 px-3 py-2 text-xs"
                >
                  <code className="select-all text-accent">{inv.code}</code>
                  <span className={st.cls}>{st.text}</span>
                  {inv.note && <span className="text-dim">{inv.note}</span>}
                  {inv.expiresAt !== null && inv.usedBy === null && (
                    <span className="text-dim">至 {new Date(inv.expiresAt).toLocaleDateString('zh-CN')}</span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-fg">用户（{users.length}）</p>
        <ul className="space-y-1.5">
          {users.map((u) => (
            <li
              key={u.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-panel-2 px-3 py-2 text-xs"
            >
              <span className="font-medium text-fg">{u.username}</span>
              <span className="rounded bg-panel px-1.5 py-0.5 text-dim">{u.role}</span>
              <span className="text-dim">
                {fmtBytes(u.storageUsedBytes)} / {fmtBytes(u.storageQuotaBytes)}
              </span>
              {u.disabled && <span className="text-bad">已停用</span>}
              <span className="min-w-0 flex-1" />
              {u.id !== selfId && (
                <button
                  type="button"
                  onClick={() => void toggleDisabled(u)}
                  className={`min-h-11 rounded-lg border px-2.5 transition-colors md:min-h-0 md:py-1 ${
                    u.disabled
                      ? 'border-line text-dim hover:text-ok'
                      : 'border-line text-dim hover:text-bad'
                  }`}
                >
                  {u.disabled ? '恢复' : '停用'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 账号区
// ---------------------------------------------------------------------------
function AccountSection() {
  const status = useAuthStore((s) => s.status)
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)

  if (status === 'unknown') {
    return (
      <section className={sectionCls}>
        <h2 className="font-semibold text-accent">账号</h2>
        <p className="animate-pulse text-sm text-dim">正在检查登录状态…</p>
      </section>
    )
  }

  if (status !== 'authed' || !user) {
    return (
      <section className={sectionCls}>
        <h2 className="font-semibold text-accent">账号</h2>
        <AuthForms hint="登录后：论文数据跟随账号跨设备同步，AI 功能的 API key 由服务端按账号注入" />
      </section>
    )
  }

  return (
    <section className={sectionCls}>
      <h2 className="font-semibold text-accent">账号</h2>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-base font-semibold text-fg">{user.username}</span>
        <span className="rounded bg-panel-2 px-2 py-0.5 text-xs text-dim">
          {user.role === 'admin' ? '管理员' : '普通用户'}
        </span>
        <span className="min-w-0 flex-1" />
        <button
          type="button"
          onClick={() => void logout()}
          className="min-h-11 rounded-lg border border-line px-4 text-sm text-dim transition-colors hover:text-bad md:min-h-0 md:py-1.5"
        >
          登出
        </button>
      </div>
      <div className="border-t border-line pt-4">
        <ChangePasswordForm />
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------
export default function SettingsPage() {
  const { provider, model, setProvider, setModel } = useSettings()
  const status = useAuthStore((s) => s.status)
  const user = useAuthStore((s) => s.user)
  const preset = PROVIDERS.find((p) => p.id === provider)!
  const authed = status === 'authed' && user !== null

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">设置</h1>

      <AccountSection />
      {authed && <LlmKeysSection user={user} />}
      {authed && user.role === 'admin' && <AdminSection selfId={user.id} />}

      <section className={sectionCls}>
        <h2 className="font-semibold text-accent">评分用 LLM</h2>
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
        <p className="text-xs leading-relaxed text-dim">
          AI 调用需要登录：请求经同源代理转发到站点后端，由服务端按账号注入
          key（管理员用站点 key，普通用户用上方「LLM API Key」区配置的本人 key），浏览器不携带任何
          key。provider 与模型选择只存在本机。
        </p>
      </section>

      {PAPER_ENABLED && <LocalDataSection />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 本地数据区（P4）：清除本地论文缓存 + 重新检查未同步论文。
// 只在论文陪读 flag-on 构建里渲染；对 lib/paper 的引用全部走动态 import——
// flag-off 构建把 lib/paper 虚模块化，这里若静态 import 会破坏 flag-off 产物。
// ---------------------------------------------------------------------------
const PAPER_ENABLED = import.meta.env.VITE_ENABLE_PAPER_COPILOT === '1'

function LocalDataSection() {
  const authed = useAuthStore((s) => s.status === 'authed')
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const clearLocal = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const { PAPER_DB_NAME, dbNameForUser, destroyPaperDb } = await import('../lib/paper/repo/db')
      // 游客库与当前账号库一起清：两库都是「本机缓存」，账号数据以服务端为准可随时拉回
      await destroyPaperDb(PAPER_DB_NAME)
      if (userId !== null) await destroyPaperDb(dbNameForUser(userId))
      setMsg({ ok: true, text: '本地论文缓存已清除，页面即将刷新…' })
      // 刷新收尾：内存里还留着旧库的组件状态/单例连接，整页重载最干净
      setTimeout(() => window.location.reload(), 800)
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  const recheckClaim = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const { setClaimDismissed } = await import('../lib/paper/sync/syncEngine')
      await setClaimDismissed(false)
      setMsg({ ok: true, text: '已重置认领提示：回到「论文陪读」页即可重新看到未同步论文的同步横幅' })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={sectionCls}>
      <h2 className="font-semibold text-accent">本地数据</h2>
      <p className="text-xs leading-relaxed text-dim">
        论文文件与解析产物缓存在浏览器 IndexedDB。已登录时数据会同步到账号，清除本地缓存后可随时从账号拉回；
        未登录（游客）数据只存在本机，清除即永久删除。
      </p>
      <div className="flex flex-wrap gap-2">
        {confirming ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void clearLocal()}
              className="min-h-11 rounded-lg border border-bad/50 px-4 text-sm text-bad transition-colors hover:bg-panel-2 md:min-h-0 md:py-1.5"
            >
              {busy ? '正在清除…' : '确认清除全部本地缓存'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="min-h-11 rounded-lg border border-line px-4 text-sm text-dim transition-colors hover:bg-panel-2 md:min-h-0 md:py-1.5"
            >
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(true)}
            className="min-h-11 rounded-lg border border-line px-4 text-sm text-fg transition-colors hover:bg-panel-2 md:min-h-0 md:py-1.5"
          >
            清除本地论文缓存
          </button>
        )}
        {authed && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void recheckClaim()}
            className="min-h-11 rounded-lg border border-line px-4 text-sm text-fg transition-colors hover:bg-panel-2 md:min-h-0 md:py-1.5"
          >
            重新检查未同步论文
          </button>
        )}
      </div>
      {msg && <p className={`text-sm ${msg.ok ? 'text-ok' : 'text-bad'}`}>{msg.text}</p>}
    </section>
  )
}
