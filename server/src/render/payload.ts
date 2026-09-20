/**
 * 捕获代理回传内容的校验。
 *
 * 代理跑在页面的**主世界**里:站点脚本可以改写 Promise/JSON/Array 原型,也可以干脆伪造整条消息,
 * 所以 page.evaluate 拿回来的东西和用户输入同级——逐字段校验形状、卡大小、重验 finalUrl,
 * 最后**按字段重新拼**一份 RenderUrlResponse 交出去,多余字段一个不留。
 * 从 browser.ts 拆出来是为了不起浏览器就能测。
 */
import { z } from 'zod'
import type { RenderUrlResponse } from '../../../shared/apiTypes.js'
import { FetchDeniedError, FetchFailedError, FetchTooLargeError } from '../lib/fetchRaw.js'
import { validateTargetUrl } from '../lib/ssrf.js'

/** 与捕获代理自己的 maxHtmlBytes(DEFAULT_CAPTURE_CONFIG,8MB)一致;代理在页面里,它的自我约束不算数 */
export const RENDER_MAX_HTML_BYTES = 8 * 1024 * 1024
/** 标题上限:正常标题几十个字;再长只可能是页面在塞垃圾 */
export const RENDER_MAX_TITLE_CHARS = 500

/** 计数类字段:非负整数且有界(页面再大也到不了这个数),挡掉 NaN/Infinity/负数/小数 */
const count = z.number().int().min(0).max(10_000_000)

const okSchema = z.object({
  type: z.literal('pc-capture'),
  ok: z.literal(true),
  html: z.string(),
  title: z.string(),
  finalUrl: z.string().min(1),
  viewportWidth: z.number().min(0).max(100_000),
  hidden: count,
  fixed: count,
  blockedScripts: count,
  agentVersion: z.number().int().min(1).max(1_000),
})

const failSchema = z.object({
  type: z.literal('pc-capture'),
  ok: z.literal(false),
  reason: z.string(),
})

/**
 * 校验并规整捕获结果;不合格按抓取那套错误类抛出(http 层统一映射)。
 * 错误文案一律是我们自己的固定字符串:代理的 `reason` 可能是页面里抛出的异常文本
 * (页面可控),绝不原样进响应或日志。
 */
export function parseCapturePayload(raw: unknown): RenderUrlResponse {
  const failed = failSchema.safeParse(raw)
  if (failed.success) {
    // 'too-large' 是代理自己的固定枚举值,只拿来做等值比较,不回显
    if (failed.data.reason === 'too-large') throw new FetchTooLargeError('渲染后的页面超过大小上限')
    throw new FetchFailedError('页面捕获失败')
  }

  const parsed = okSchema.safeParse(raw)
  if (!parsed.success) throw new FetchFailedError('页面捕获结果不合法')
  const msg = parsed.data

  // 先按字符数粗筛(UTF-8 字节数 ≥ 字符数),免得对一个几百 MB 的字符串白算一遍字节长度
  if (
    msg.html.length > RENDER_MAX_HTML_BYTES ||
    Buffer.byteLength(msg.html, 'utf8') > RENDER_MAX_HTML_BYTES
  ) {
    throw new FetchTooLargeError('渲染后的页面超过大小上限')
  }

  // finalUrl 会被客户端当作相对链接/资源的解析基准,随后逐个去抓——页面可以用 <base> 或
  // history.pushState 把它指到任何地方,所以和用户输入走同一道闸
  const checked = validateTargetUrl(msg.finalUrl)
  if (!checked.ok) {
    if (checked.code === 'fetch-denied') throw new FetchDeniedError('页面最终地址被安全策略拒绝')
    throw new FetchFailedError('页面最终地址不合法')
  }

  return {
    html: msg.html,
    title: msg.title.slice(0, RENDER_MAX_TITLE_CHARS),
    finalUrl: checked.url.toString(),
    viewportWidth: Math.round(msg.viewportWidth),
    hidden: msg.hidden,
    fixed: msg.fixed,
    blockedScripts: msg.blockedScripts,
    agentVersion: msg.agentVersion,
  }
}
