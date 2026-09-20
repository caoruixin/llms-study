/**
 * 渲染服务内部的共享类型。单独成文件是为了让 server.ts **不 import browser.ts**:
 * browser.ts 是全仓唯一引 playwright-core 的文件,server.ts 只认下面这个函数签名,
 * 于是 http 层的全部分支都能用假渲染器测到,不必起浏览器。
 */
import type { RenderUrlResponse } from '../../../shared/apiTypes.js'

/**
 * 渲染一个 URL。约定:
 * - 成功 resolve 一份已校验过的 RenderUrlResponse;
 * - 失败 reject 抓取那套错误类(FetchDeniedError / FetchFailedError / FetchTooLargeError,
 *   见 ../lib/fetchRaw.ts)或 RenderLaunchError,http 层据此映射状态码;
 * - **无论成败,返回(settle)时浏览器必须已经关干净**——http 层靠这一点做单飞:
 *   上一个 Chromium 还没退、下一个就起来,小机器上就是两份几百 MB 的内存。
 * - signal abort 后应尽快收尾并 reject。
 */
export type Renderer = (url: string, signal: AbortSignal) => Promise<RenderUrlResponse>

/**
 * 浏览器起不来(二进制不在、沙箱初始化失败、启动超时…)。
 * 与"目标页面抓不到"是两码事:这是**本部署的渲染能力不可用**,http 层映射 503 render-unavailable,
 * 前端据此回落到如实报错,而不是让用户以为是那个网页的问题。
 */
export class RenderLaunchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RenderLaunchError'
  }
}

/** 日志里的 URL 一律过这个:JSON.stringify 把换行/控制字符转义掉(防日志注入),再截到 200 字符 */
export function logUrl(url: string): string {
  return JSON.stringify(String(url)).slice(0, 200)
}
