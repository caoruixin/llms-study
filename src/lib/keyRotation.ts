/**
 * 多 API key 按序故障转移(vite dev 代理与后端 LLM 网关共用的纯逻辑)。
 * 语义:key 列表按优先级排列,请求总是从最高优先级的可用 key 试起;
 * invalid(401/403)在本进程内永久剔除,quota/限流(402/429)冷却后可重试;
 * 全部不可用时由调用方透出最后一次上游错误。
 */
export type KeyFailureKind = 'invalid' | 'quota'

/** quota/限流失败的冷却时长:429 可能只是瞬时限流,冷却后值得再试 */
export const KEY_QUOTA_COOLDOWN_MS = 60_000

/** HTTP 状态 → 失败分类;null = 与 key 无关的失败(不轮换,直接透出) */
export function classifyKeyFailure(status: number): KeyFailureKind | null {
  if (status === 401 || status === 403) return 'invalid'
  if (status === 402 || status === 429) return 'quota'
  return null
}

/** 解析逗号分隔的 key 列表(JINA_API_KEYS=k1,k2);空段剔除,顺序即优先级 */
export function parseKeyList(raw: string | undefined | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export interface KeyRotator {
  /** 按优先级返回当前可尝试的 key(剔除已 invalid 的与冷却中的) */
  candidates(now?: number): string[]
  reportFailure(key: string, kind: KeyFailureKind, now?: number): void
}

export function createKeyRotator(keys: string[], cooldownMs = KEY_QUOTA_COOLDOWN_MS): KeyRotator {
  const dead = new Set<string>()
  const cooldownUntil = new Map<string, number>()
  return {
    candidates(now = Date.now()) {
      return keys.filter((k) => !dead.has(k) && (cooldownUntil.get(k) ?? 0) <= now)
    },
    reportFailure(key, kind, now = Date.now()) {
      if (kind === 'invalid') dead.add(key)
      else cooldownUntil.set(key, now + cooldownMs)
    },
  }
}
