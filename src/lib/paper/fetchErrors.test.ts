import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../auth/apiClient'
import { describeFileFetchError } from './fetchErrors'

describe('describeFileFetchError', () => {
  it('401 未认证 → 引导重新登录（重试无意义）', () => {
    expect(describeFileFetchError(new ApiRequestError('unauthenticated', '无有效 session', 401))).toBe(
      '登录已过期，请重新登录后重试',
    )
  })

  it('网络错误（请求未送达）→ 引导检查网络', () => {
    expect(describeFileFetchError(new ApiRequestError('network', '网络错误：Failed to fetch'))).toBe(
      '网络异常，请检查网络后重试',
    )
  })

  it('其他服务端错误码 → 兜底文案携带原始 message（便于反馈排查）', () => {
    expect(describeFileFetchError(new ApiRequestError('internal', '请求失败（500）', 500))).toBe(
      '读取原始文件失败（请求失败（500））',
    )
  })

  it('非 ApiRequestError（本地 IndexedDB 读失败等）→ 同样走兜底文案', () => {
    expect(describeFileFetchError(new Error('QuotaExceededError'))).toBe('读取原始文件失败（QuotaExceededError）')
    // 防御：抛出的不是 Error 对象也不能崩
    expect(describeFileFetchError('boom')).toBe('读取原始文件失败（boom）')
  })
})
