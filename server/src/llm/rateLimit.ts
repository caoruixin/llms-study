/**
 * LLM 网关限流原语:每用户令牌桶 + 并发流闸门。
 * 进程内存实现即可——单进程部署,重启清零可接受(与登录爆破限流同理);
 * nginx 的 IP 维度限流是另一层粗防护,两层互补。
 */

export type LimiterKey = string | number

export type TakeResult = { ok: true } | { ok: false; retryAfterMs: number }

export interface TokenBucketLimiter {
  take(key: LimiterKey, now?: number): TakeResult
}

/**
 * 令牌桶:capacity 满桶起步,每 refillMs 回一枚。
 * 与前端 modelGateway 的桶算法同构(整枚回填、满桶时重置 lastRefill),
 * 差别只在超限行为:前端排队等待,服务端直接 429 + Retry-After 让前端退避。
 */
export function createTokenBucket(capacity: number, refillMs: number): TokenBucketLimiter {
  const state = new Map<LimiterKey, { tokens: number; lastRefill: number }>()
  return {
    take(key, now = Date.now()) {
      let s = state.get(key)
      if (!s) {
        s = { tokens: capacity, lastRefill: now }
        state.set(key, s)
      }
      const add = Math.floor((now - s.lastRefill) / refillMs)
      if (add > 0) {
        s.tokens = Math.min(capacity, s.tokens + add)
        // 满桶后停表:否则闲置期"攒出"超过 capacity 的突发额度
        s.lastRefill = s.tokens === capacity ? now : s.lastRefill + add * refillMs
      }
      if (s.tokens >= 1) {
        s.tokens -= 1
        return { ok: true }
      }
      return { ok: false, retryAfterMs: Math.max(1, s.lastRefill + refillMs - now) }
    },
  }
}

export interface ConcurrencyGate {
  tryAcquire(key: LimiterKey): boolean
  release(key: LimiterKey): void
}

/** 并发闸门:acquire/release 必须严格配对(流式响应结束/取消/出错时 release) */
export function createConcurrencyGate(max: number): ConcurrencyGate {
  const active = new Map<LimiterKey, number>()
  return {
    tryAcquire(key) {
      const n = active.get(key) ?? 0
      if (n >= max) return false
      active.set(key, n + 1)
      return true
    },
    release(key) {
      const n = active.get(key) ?? 0
      if (n <= 1) active.delete(key)
      else active.set(key, n - 1)
    },
  }
}

/**
 * 包装上游响应流:结束/取消/出错任一路径触发一次 onDone——
 * 并发闸门的 release 挂在这里,保证 SSE 长流真正结束才归还名额。
 */
export function tapStream(
  src: ReadableStream<Uint8Array>,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  const reader = src.getReader()
  let done = false
  const finish = () => {
    if (!done) {
      done = true
      onDone()
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: d, value } = await reader.read()
        if (d) {
          finish()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (e) {
        finish()
        controller.error(e)
      }
    },
    cancel(reason) {
      finish()
      return reader.cancel(reason)
    },
  })
}
