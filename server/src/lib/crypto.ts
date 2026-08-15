/**
 * 用户 LLM key 的落库加密:AES-256-GCM,BLOB = iv(12) || tag(16) || ct。
 * AAD 绑定 `${userId}:${provider}`——即使攻击者能改 DB,把 A 用户的密文挪到
 * B 用户行下也解不开(GCM 认证失败),防密文移植。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_LEN = 12
const TAG_LEN = 16

export function llmKeyAad(userId: number, provider: string): string {
  return `${userId}:${provider}`
}

export function encryptSecret(master: Buffer, plaintext: string, aad: string): Buffer {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', master, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct])
}

/** 认证失败(密文被篡改/AAD 不匹配/主密钥错误)时抛错,调用方视同 key 不存在 */
export function decryptSecret(master: Buffer, blob: Buffer, aad: string): string {
  const iv = blob.subarray(0, IV_LEN)
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ct = blob.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', master, iv)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
