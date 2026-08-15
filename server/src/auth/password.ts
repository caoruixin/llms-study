/**
 * 密码哈希:argon2id,OWASP 推荐参数(m=19456KiB, t=2, p=1)。
 * @node-rs/argon2 是原生实现,验证 ~50ms 量级——本身就是暴力破解的成本壁垒。
 */
import { randomUUID } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'

const ARGON2_OPTS = {
  // Algorithm.Argon2id 的字面值:该枚举是 ambient const enum,verbatimModuleSyntax 下不可引用
  algorithm: 2,
  memoryCost: 19456, // KiB
  timeCost: 2,
  parallelism: 1,
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTS)
}

export function verifyPassword(phcHash: string, password: string): Promise<boolean> {
  return verify(phcHash, password).catch(() => false)
}

// 未知用户名也要跑一次完整 argon2 验证,让"用户名不存在"与"密码错误"的
// 响应耗时不可区分(防用户名枚举的时序侧信道)。dummy 哈希进程内懒生成一次。
let dummyHash: Promise<string> | null = null

export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hash(randomUUID(), ARGON2_OPTS)
  await verify(await dummyHash, password).catch(() => false)
  return false
}
