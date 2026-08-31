/**
 * 微信公众号 URL 判定：纯函数，不碰 DOM，node 环境可测（weixin.test.ts）。
 *
 * 背景：微信风控会把被限流的抓取 302 到 `mp/wappoc_appmsgcaptcha` 人机验证页
 * （约 18KB JS 壳，纯文本仅几十字符）。服务端代理会跟随跳转，最终落地 URL 经
 * `x-fetch-final-url` 头带回（fetchUrlApi.ts）——在 client 侧凭 finalUrl 识别
 * 风控页，避免把它误报成「页面依赖脚本渲染」。
 */

export const WEIXIN_BLOCKED_MESSAGE = '微信风控拦截（触发访问验证），请稍后重试或降低导入频率'

/** 是否微信公众号域下的 URL（含文章页与验证页）。非法 URL 一律 false，不抛错 */
export function isWeixinArticleUrl(url: string): boolean {
  try {
    return new URL(url).hostname === 'mp.weixin.qq.com'
  } catch {
    return false
  }
}

/** 是否微信人机验证页（302 落地的 wappoc_appmsgcaptcha）。非法 URL 一律 false */
export function isWeixinCaptchaUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.hostname === 'mp.weixin.qq.com' && u.pathname.includes('wappoc_appmsgcaptcha')
  } catch {
    return false
  }
}
