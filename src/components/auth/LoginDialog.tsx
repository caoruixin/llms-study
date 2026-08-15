import { useState } from 'react'
import { PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN, USERNAME_RE } from '../../../shared/apiRoutes'
import { ApiRequestError } from '../../lib/auth/apiClient'
import { useAuthStore, type LoginReason } from '../../lib/auth/authStore'

/**
 * 全局登录弹窗：受 authStore.loginPrompt 控制（requireLogin 打开、settle 关闭）。
 * 不做 /login 路由——HashRouter 下无服务端重定向，一律「操作时弹窗拦截」。
 * 内层 AuthForms 独立导出：SettingsPage 未登录时内嵌同一套登录/注册表单。
 */

const REASON_COPY: Record<LoginReason, string> = {
  upload: '导入论文需要登录：论文与学习数据将跟随账号跨设备同步',
  llm: 'AI 功能需要登录：API key 按账号在服务端注入，不经过浏览器',
  sync: '同步数据需要登录账号',
  manual: '登录后论文数据与 AI 配置将跟随账号使用',
}

/** ApiRequestError → 表单文案：服务端 message 优先（文案权在服务端），码兜底 */
function formError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    if (e.message && e.code !== 'internal') return e.message
    switch (e.code) {
      case 'network':
        return '网络异常，请检查连接后重试'
      case 'rate-limited':
        return '尝试次数过多，请稍后再试'
      default:
        return '请求失败，请稍后重试'
    }
  }
  return e instanceof Error ? e.message : '请求失败，请稍后重试'
}

const inputCls = 'w-full rounded-md border border-line bg-panel-2 px-3 py-2 text-sm'

interface AuthFormsProps {
  /** 弹窗场景传 REASON_COPY；内嵌场景可省略 */
  hint?: string
}

/** 登录/注册双 tab 表单（内层，无外壳）：成功路径由 authStore.login/register settle gate */
export function AuthForms({ hint }: AuthFormsProps) {
  const login = useAuthStore((s) => s.login)
  const register = useAuthStore((s) => s.register)
  const [tab, setTab] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  const switchTab = (t: 'login' | 'register') => {
    setTab(t)
    setError('')
  }

  // 客户端预检只拦「必然被服务端 400」的输入，规则与 shared/apiRoutes 常量同源
  const precheck = (): string | null => {
    if (tab === 'register') {
      if (username.length < USERNAME_MIN || username.length > USERNAME_MAX || !USERNAME_RE.test(username)) {
        return `用户名须为 ${USERNAME_MIN}-${USERNAME_MAX} 位字母/数字/下划线/连字符`
      }
      if (password.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`
      if (!inviteCode.trim()) return '请输入邀请码'
    } else if (!username || !password) {
      return '请输入用户名和密码'
    }
    return null
  }

  const submit = async () => {
    if (pending) return
    const pre = precheck()
    if (pre) {
      setError(pre)
      return
    }
    setPending(true)
    setError('')
    try {
      if (tab === 'login') await login(username, password)
      else await register(username, password, inviteCode.trim())
      // 成功后 store 已 settle gate 并转 authed；弹窗随 loginPrompt 清空而卸载
    } catch (e) {
      setError(formError(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <div>
      {/* tab 切换：触控热区 ≥44px */}
      <div className="mb-3 flex rounded-lg border border-line p-0.5">
        {(['login', 'register'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => switchTab(t)}
            className={`min-h-11 flex-1 rounded-md text-sm font-medium transition-colors ${
              tab === t ? 'bg-accent/15 text-accent' : 'text-dim hover:text-fg'
            }`}
          >
            {t === 'login' ? '登录' : '注册'}
          </button>
        ))}
      </div>

      {hint && <p className="mb-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs leading-relaxed text-dim">{hint}</p>}

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className="block space-y-1">
          <span className="text-sm text-dim">用户名</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            placeholder={tab === 'register' ? '字母/数字/下划线/连字符' : ''}
            className={inputCls}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-dim">密码</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
            placeholder={tab === 'register' ? `至少 ${PASSWORD_MIN} 位` : ''}
            className={inputCls}
          />
        </label>
        {tab === 'register' && (
          <label className="block space-y-1">
            <span className="text-sm text-dim">邀请码（找管理员获取）</span>
            <input
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              autoComplete="off"
              className={inputCls}
            />
          </label>
        )}
        {error && <p className="text-xs text-bad">{error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 w-full rounded-lg bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
        >
          {pending ? '请稍候…' : tab === 'login' ? '登录' : '注册并登录'}
        </button>
      </form>
    </div>
  )
}

/** 挂在 App 根部的全局弹窗：样式对齐 ConsentDialog（遮罩 + 居中卡片） */
export default function LoginDialog() {
  const loginPrompt = useAuthStore((s) => s.loginPrompt)
  const dismiss = useAuthStore((s) => s.dismissLoginPrompt)
  if (!loginPrompt) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 backdrop-blur-[1px]"
      onKeyDown={(e) => {
        if (e.key === 'Escape') dismiss()
      }}
    >
      <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-fg">登录到 LLM Infra Studio</h3>
          <button
            type="button"
            onClick={dismiss}
            aria-label="关闭登录弹窗"
            className="flex min-h-11 min-w-11 items-center justify-center text-lg leading-none text-dim transition-colors hover:text-fg"
          >
            ×
          </button>
        </div>
        <AuthForms hint={REASON_COPY[loginPrompt.reason]} />
      </div>
    </div>
  )
}
