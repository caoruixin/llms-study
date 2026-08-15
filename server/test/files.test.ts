/**
 * 文件存取(P3):PUT/GET 回环、sha256 校验、同 sha 短路、ETag 304、配额预检。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, createUser, login, withSid, type TestCtx } from './helpers.js'

const tmpDirs: string[] = []
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true })
})

interface FilesCtx {
  ctx: TestCtx
  sid: string
  userId: number
  userDir: string
}

async function setupFiles(): Promise<FilesCtx> {
  const filesDir = mkdtempSync(path.join(os.tmpdir(), 'llms-files-test-'))
  tmpDirs.push(filesDir)
  const ctx = createTestApp({ filesDir })
  const userId = await createUser(ctx.db, 'alice', 'password-1')
  const sid = await login(ctx.app, 'alice', 'password-1')
  return { ctx, sid, userId, userDir: path.join(filesDir, String(userId)) }
}

const shaOf = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

async function putFile(
  f: FilesCtx,
  paperId: string,
  body: Buffer,
  opts: { sha?: string; mime?: string } = {},
): Promise<Response> {
  return await f.ctx.app.request(`/api/app/files/${paperId}`, {
    method: 'PUT',
    headers: {
      ...withSid(f.sid),
      'x-file-sha256': opts.sha ?? shaOf(body),
      'content-type': opts.mime ?? 'application/pdf',
    },
    body,
  })
}

describe('files PUT/GET', () => {
  it('PUT → GET 回环:字节一致、mime/ETag 正确、记账入配额', async () => {
    const f = await setupFiles()
    const bytes = Buffer.concat([Buffer.from('%PDF-1.7 '), Buffer.alloc(4096, 7)])
    const res = await putFile(f, 'p1', bytes)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, sha256: shaOf(bytes), byteSize: bytes.length })

    const get = await f.ctx.app.request('/api/app/files/p1', { headers: withSid(f.sid) })
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toBe('application/pdf')
    expect(get.headers.get('etag')).toBe(`"${shaOf(bytes)}"`)
    expect(Buffer.from(await get.arrayBuffer()).equals(bytes)).toBe(true)

    const { u } = f.ctx.db
      .prepare('SELECT storage_used_bytes AS u FROM users WHERE id = ?')
      .get(f.userId) as { u: number }
    expect(u).toBe(bytes.length)
  })

  it('If-None-Match 命中 → 304 不回 body', async () => {
    const f = await setupFiles()
    const bytes = Buffer.from('same-bytes')
    await putFile(f, 'p1', bytes)
    const res = await f.ctx.app.request('/api/app/files/p1', {
      headers: { ...withSid(f.sid), 'if-none-match': `"${shaOf(bytes)}"` },
    })
    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe(`"${shaOf(bytes)}"`)
    expect(await res.text()).toBe('')
  })

  it('X-File-Sha256 不符 → 400,tmp 清理干净、无正式文件', async () => {
    const f = await setupFiles()
    const res = await putFile(f, 'p1', Buffer.from('real-bytes'), { sha: 'a'.repeat(64) })
    expect(res.status).toBe(400)
    expect(existsSync(path.join(f.userDir, 'p1.bin'))).toBe(false)
    // tmp-<rand> 也不许残留
    if (existsSync(f.userDir)) expect(readdirSync(f.userDir)).toEqual([])
    expect(f.ctx.db.prepare('SELECT COUNT(*) AS n FROM stored_files').get()).toEqual({ n: 0 })
  })

  it('缺 X-File-Sha256 头 → 400', async () => {
    const f = await setupFiles()
    const res = await f.ctx.app.request('/api/app/files/p1', {
      method: 'PUT',
      headers: withSid(f.sid),
      body: Buffer.from('x'),
    })
    expect(res.status).toBe(400)
  })

  it('同 sha256 重复 PUT 短路:不重写磁盘', async () => {
    const f = await setupFiles()
    const bytes = Buffer.from('original-content')
    await putFile(f, 'p1', bytes)
    // 声明相同 sha 但 body 是别的字节:命中短路 → 服务端根本不读 body,磁盘保持原样。
    // (诚实客户端只有内容一致才会带相同 sha,这里恰好顺带验证了"不重写")
    const res = await putFile(f, 'p1', Buffer.from('different!!'), { sha: shaOf(bytes) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, sha256: shaOf(bytes), byteSize: bytes.length })
    expect(readFileSync(path.join(f.userDir, 'p1.bin')).equals(bytes)).toBe(true)
  })

  it('替换为不同内容:sha/字节数更新,配额按差值调整', async () => {
    const f = await setupFiles()
    const big = Buffer.alloc(1000, 1)
    const small = Buffer.alloc(200, 2)
    await putFile(f, 'p1', big)
    const res = await putFile(f, 'p1', small)
    expect(res.status).toBe(200)
    const { u } = f.ctx.db
      .prepare('SELECT storage_used_bytes AS u FROM users WHERE id = ?')
      .get(f.userId) as { u: number }
    expect(u).toBe(small.length)
    const get = await f.ctx.app.request('/api/app/files/p1', { headers: withSid(f.sid) })
    expect(Buffer.from(await get.arrayBuffer()).equals(small)).toBe(true)
  })

  it('Content-Length 配额预检:超额直接 413,不落盘', async () => {
    const f = await setupFiles()
    f.ctx.db.prepare('UPDATE users SET storage_quota_bytes = 100 WHERE id = ?').run(f.userId)
    const res = await putFile(f, 'p1', Buffer.alloc(500, 3))
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: 'quota-exceeded' })
    expect(existsSync(path.join(f.userDir, 'p1.bin'))).toBe(false)
  })

  it('GET 不存在的文件 → 404;非法 paperId → 400', async () => {
    const f = await setupFiles()
    const miss = await f.ctx.app.request('/api/app/files/nope', { headers: withSid(f.sid) })
    expect(miss.status).toBe(404)
    // '.' 不在白名单字符集:路径穿越类输入从形状上就进不来
    const bad = await f.ctx.app.request('/api/app/files/a.b', { headers: withSid(f.sid) })
    expect(bad.status).toBe(400)
  })

  it('未登录 PUT/GET → 401', async () => {
    const f = await setupFiles()
    const res = await f.ctx.app.request('/api/app/files/p1', {
      method: 'PUT',
      headers: { 'x-file-sha256': 'b'.repeat(64) },
      body: Buffer.from('x'),
    })
    expect(res.status).toBe(401)
  })
})
