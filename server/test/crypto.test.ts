/**
 * AES-256-GCM 封装:回环、认证失败(篡改/错 AAD/错主密钥)、iv 随机性。
 */
import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, llmKeyAad } from '../src/lib/crypto.js'

const master = Buffer.from('cd'.repeat(32), 'hex')
const aad = llmKeyAad(42, 'deepseek')

describe('encryptSecret/decryptSecret', () => {
  it('回环还原;BLOB 布局 = iv(12)+tag(16)+ct', () => {
    const blob = encryptSecret(master, 'sk-plain-secret', aad)
    expect(blob.length).toBe(12 + 16 + Buffer.byteLength('sk-plain-secret'))
    expect(decryptSecret(master, blob, aad)).toBe('sk-plain-secret')
  })

  it('同一明文两次加密产生不同密文(iv 随机)', () => {
    const a = encryptSecret(master, 'same-text-here', aad)
    const b = encryptSecret(master, 'same-text-here', aad)
    expect(a.equals(b)).toBe(false)
  })

  it('篡改密文 / AAD 不符 / 主密钥不符 → 抛错', () => {
    const blob = encryptSecret(master, 'sk-plain-secret', aad)
    const tampered = Buffer.from(blob)
    tampered[tampered.length - 1] ^= 0x01
    expect(() => decryptSecret(master, tampered, aad)).toThrow()
    expect(() => decryptSecret(master, blob, llmKeyAad(43, 'deepseek'))).toThrow()
    expect(() => decryptSecret(Buffer.from('ef'.repeat(32), 'hex'), blob, aad)).toThrow()
  })
})
