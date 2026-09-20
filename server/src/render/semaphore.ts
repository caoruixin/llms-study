/**
 * 极小的计数信号量:限制一次渲染内同时在途的出网请求数。
 *
 * 为什么要排队而不是像 API 的并发闸那样"满了就拒":这里的请求方是页面本身,
 * 拒掉一个脚本请求 = 页面渲染不出来;而页面一上来并发几十个请求是常态。
 * 排队的代价有上界——每个在途请求都有自己的超时,整次渲染还有总时长兜底。
 */
export interface Semaphore {
  /** 领一个名额;满了就等。返回的函数用于归还,重复调用无害 */
  acquire(): Promise<() => void>
  /** 在途数(测试/日志用) */
  readonly active: number
}

export function createSemaphore(max: number): Semaphore {
  let active = 0
  const waiters: (() => void)[] = []

  const grant = (): (() => void) => {
    active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      active -= 1
      // 名额直接交给队首,不经过"先减后加"之间的空窗——否则新来的请求能插队
      const next = waiters.shift()
      if (next) next()
    }
  }

  return {
    acquire() {
      if (active < max) return Promise.resolve(grant())
      return new Promise<() => void>((resolve) => {
        waiters.push(() => resolve(grant()))
      })
    },
    get active() {
      return active
    },
  }
}
