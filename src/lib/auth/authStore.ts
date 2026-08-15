import { create } from 'zustand'
import type { MeResponse } from '../../../shared/apiTypes'
import { ApiRequestError, authApi } from './apiClient'

/**
 * 登录态 store（**不 persist**：httpOnly cookie 是唯一真相，本地缓存登录态
 * 只会与服务端漂移——刷新时以 /auth/me 为准，宁可闪一下也不显示假登录）。
 *
 * requireLogin 是 promise-gate（复用 CopilotPanel GateRequest 范式）：调用方
 * await 一个布尔值，LoginDialog 负责 UI；登录成功（无论从弹窗还是设置页内嵌表单）
 * 都会 settle(true)，取消/关闭 settle(false)。
 */

export type AuthStatus = 'unknown' | 'anon' | 'authed'

/** 拦截来源：决定 LoginDialog 的引导文案 */
export type LoginReason = 'upload' | 'llm' | 'sync' | 'manual'

interface AuthState {
  status: AuthStatus
  /** llmKeys 只含 last4，明文 key 永不出服务端 */
  user: MeResponse | null
  /** 非 null = LoginDialog 打开中 */
  loginPrompt: { reason: LoginReason } | null
  /** 以 /auth/me 校准登录态（启动、回前台、跨标签页广播时调用） */
  refresh: () => Promise<void>
  /** 失败抛 ApiRequestError（表单展示 message）；成功即 settle 所有等待中的 gate */
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string, inviteCode: string) => Promise<void>
  logout: () => Promise<void>
  /** 已登录立即 true；否则弹 LoginDialog，登录成功 true / 取消 false */
  requireLogin: (reason: LoginReason) => Promise<boolean>
  /** LoginDialog 取消/关闭：所有等待者收到 false */
  dismissLoginPrompt: () => void
}

// gate 的 pending resolver 放闭包而非 state：resolve 函数不是可渲染数据，
// 且并发多处 requireLogin 时要一次 settle 全部
let pendingResolvers: ((ok: boolean) => void)[] = []

export const useAuthStore = create<AuthState>()((set, get) => {
  const settle = (ok: boolean) => {
    const resolvers = pendingResolvers
    pendingResolvers = []
    set({ loginPrompt: null })
    for (const r of resolvers) r(ok)
  }

  return {
    status: 'unknown',
    user: null,
    loginPrompt: null,

    refresh: async () => {
      try {
        const me = await authApi.me()
        set({ status: 'authed', user: me })
      } catch (e) {
        if (e instanceof ApiRequestError && e.code !== 'network') {
          // 401/403 等明确回答：确定未登录（或被停用），清空本地登录态
          set({ status: 'anon', user: null })
        } else if (get().status === 'unknown') {
          // 网络失败且尚无结论：先按未登录渲染（不阻塞首屏），回前台 re-check 自愈；
          // 已 authed 时网络抖动不降级——避免断网瞬间 UI 闪成未登录
          set({ status: 'anon' })
        }
      }
    },

    login: async (username, password) => {
      const me = await authApi.login({ username, password })
      set({ status: 'authed', user: me })
      settle(true)
      broadcast('login')
    },

    register: async (username, password, inviteCode) => {
      // 服务端注册即登录（响应已带 session cookie）
      const me = await authApi.register({ username, password, inviteCode })
      set({ status: 'authed', user: me })
      settle(true)
      broadcast('register')
    },

    logout: async () => {
      try {
        await authApi.logout()
      } catch {
        // 网络失败也按已登出处理：本地清态，服务端 session 靠过期/下次 refresh 收敛
      }
      set({ status: 'anon', user: null })
      broadcast('logout')
    },

    requireLogin: (reason) => {
      if (get().status === 'authed') return Promise.resolve(true)
      return new Promise<boolean>((resolve) => {
        pendingResolvers.push(resolve)
        // 已有弹窗时保留首个 reason 的文案（后来者只是搭车等待同一次登录）
        if (!get().loginPrompt) set({ loginPrompt: { reason } })
      })
    },

    dismissLoginPrompt: () => settle(false),
  }
})

// ---------------------------------------------------------------------------
// 跨标签页同步：任一 tab 登录/登出 → 其它 tab refresh 对齐（cookie 已变，me 即新真相）。
// BroadcastChannel 不回环投递给发送方自身，无需防抖。
// ---------------------------------------------------------------------------
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('auth') : null
// node（vitest）下 channel 会挂住事件循环，unref 让进程正常退出；浏览器无此方法
;(channel as { unref?: () => void } | null)?.unref?.()
channel?.addEventListener('message', () => {
  void useAuthStore.getState().refresh()
})

function broadcast(type: 'login' | 'register' | 'logout') {
  channel?.postMessage(type)
}
