import { describe, expect, it } from 'vitest'
import { WEIXIN_BLOCKED_MESSAGE, isWeixinArticleUrl, isWeixinCaptchaUrl } from './weixin'

describe('isWeixinArticleUrl', () => {
  it('微信公众号域正例（文章页与验证页都算微信域）', () => {
    expect(isWeixinArticleUrl('https://mp.weixin.qq.com/s/abc')).toBe(true)
    expect(isWeixinArticleUrl('https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=x&target_url=y')).toBe(true)
  })

  it('非微信域负例（含子域伪装：hostname 必须精确等于 mp.weixin.qq.com）', () => {
    expect(isWeixinArticleUrl('https://example.com/s/abc')).toBe(false)
    expect(isWeixinArticleUrl('https://weixin.qq.com/s/abc')).toBe(false)
    expect(isWeixinArticleUrl('https://mp.weixin.qq.com.evil.com/s/abc')).toBe(false)
  })

  it('非法字符串 → false 而不是抛错', () => {
    expect(isWeixinArticleUrl('not a url')).toBe(false)
  })
})

describe('isWeixinCaptchaUrl', () => {
  it('人机验证页正例', () => {
    expect(isWeixinCaptchaUrl('https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=x&target_url=y')).toBe(true)
  })

  it('正常文章 URL 负例（是微信域但不是验证页）', () => {
    expect(isWeixinCaptchaUrl('https://mp.weixin.qq.com/s/abc')).toBe(false)
  })

  it('非微信域即使 path 相同也是负例', () => {
    expect(isWeixinCaptchaUrl('https://example.com/mp/wappoc_appmsgcaptcha')).toBe(false)
  })

  it('非法字符串 → false 而不是抛错', () => {
    expect(isWeixinCaptchaUrl('not a url')).toBe(false)
  })
})

describe('WEIXIN_BLOCKED_MESSAGE', () => {
  it('是可行动的风控提示（不是「依赖脚本渲染」误导文案）', () => {
    expect(WEIXIN_BLOCKED_MESSAGE).toContain('微信风控')
    expect(WEIXIN_BLOCKED_MESSAGE).not.toContain('脚本渲染')
  })
})
