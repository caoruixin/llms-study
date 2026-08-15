/**
 * 论文原始文件存取(P3):PUT 流式落盘 + GET 流式回源。
 * 字节不进 SQLite:50MB 级 blob 会拖垮 WAL 与备份;DB 只存元数据(mime/sha256/size),
 * 本体在 FILES_DIR/{userId}/{paperId}.bin,tmp+fsync+rename 原子替换——
 * 任何中途失败都只留 tmp 垃圾,永远不会出现半个正式文件。
 */
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { FILE_ID_RE, FILE_MAX_BYTES } from '../../../shared/apiRoutes.js'
import type { FilePutResponse } from '../../../shared/apiTypes.js'
import { requireSession } from '../auth/middleware.js'
import type { StoredFileRow } from '../db/db.js'
import { addStorageUsed, readQuota } from '../lib/quota.js'
import { apiError } from '../lib/respond.js'
import type { AppDeps, AppEnv } from '../types.js'

/** 正式文件路径;调用方必须先用 FILE_ID_RE 校验 paperId(路径拼接不信任外部输入) */
export function storedFilePath(filesDir: string, userId: number, paperId: string): string {
  return path.join(filesDir, String(userId), `${paperId}.bin`)
}

const SHA256_RE = /^[0-9a-f]{64}$/

export function filesRoutes(deps: AppDeps): Hono<AppEnv> {
  const { db, config } = deps
  const r = new Hono<AppEnv>()
  r.use('*', requireSession(deps))

  r.put('/:paperId', async (c) => {
    const paperId = c.req.param('paperId')
    if (!FILE_ID_RE.test(paperId)) return apiError(c, 400, 'invalid-input', 'paperId 不合法')
    const shaHeader = (c.req.header('x-file-sha256') ?? '').toLowerCase()
    if (!SHA256_RE.test(shaHeader)) {
      return apiError(c, 400, 'invalid-input', '缺少或非法的 X-File-Sha256 头')
    }
    const user = c.get('user')

    const existing = db
      .prepare('SELECT * FROM stored_files WHERE user_id = ? AND paper_id = ?')
      .get(user.id, paperId) as StoredFileRow | undefined
    // 同 sha256 短路:换设备重传同一文件是常态,不读 body 不写盘直接确认
    if (existing && existing.sha256 === shaHeader) {
      const body: FilePutResponse = { ok: true, sha256: existing.sha256, byteSize: existing.byte_size }
      return c.json(body)
    }
    const oldSize = existing?.byte_size ?? 0

    // Content-Length 配额预检:50MB 白传完才发现超额太浪费,能提前拒就提前拒
    const declared = Number(c.req.header('content-length') ?? Number.NaN)
    const { used, quota } = readQuota(db, user.id)
    if (Number.isFinite(declared)) {
      if (declared > FILE_MAX_BYTES) return apiError(c, 413, 'invalid-input', '文件超过 60MB 上限')
      if (used - oldSize + declared > quota) return apiError(c, 413, 'quota-exceeded', '存储配额不足')
    }

    const body = c.req.raw.body
    if (!body) return apiError(c, 400, 'invalid-input', '缺少请求体')

    const finalPath = storedFilePath(config.filesDir, user.id, paperId)
    await mkdir(path.dirname(finalPath), { recursive: true })
    // tmp 与正式文件同目录:rename 才保证是同文件系统内的原子替换
    const tmpPath = `${finalPath}.tmp-${randomBytes(6).toString('hex')}`

    const hash = createHash('sha256')
    let total = 0
    let failure: Response | null = null
    const handle = await open(tmpPath, 'w')
    try {
      // 边写边算 sha256:不在内存里攒 50MB,also 不用写完再重读一遍
      for await (const chunk of body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += buf.length
        if (total > FILE_MAX_BYTES) {
          failure = apiError(c, 413, 'invalid-input', '文件超过 60MB 上限')
          break
        }
        // 流式配额兜底:防 Content-Length 缺失/说谎的客户端硬塞
        if (used - oldSize + total > quota) {
          failure = apiError(c, 413, 'quota-exceeded', '存储配额不足')
          break
        }
        hash.update(buf)
        await handle.write(buf)
      }
      if (!failure) {
        const sha = hash.digest('hex')
        if (sha !== shaHeader) {
          failure = apiError(c, 400, 'invalid-input', 'sha256 与 X-File-Sha256 不符')
        } else {
          // fsync 后再 rename:确保 rename 可见时字节已持久化(掉电不会拿到空文件)
          await handle.sync()
        }
      }
    } catch (e) {
      await handle.close().catch(() => undefined)
      await rm(tmpPath, { force: true })
      throw e
    }
    await handle.close()
    if (failure) {
      await rm(tmpPath, { force: true })
      return failure
    }
    await rename(tmpPath, finalPath)

    const now = Date.now()
    db.transaction(() => {
      db.prepare(
        `INSERT INTO stored_files (user_id, paper_id, mime, sha256, byte_size, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, paper_id) DO UPDATE SET
           mime = excluded.mime, sha256 = excluded.sha256, byte_size = excluded.byte_size,
           updated_at = excluded.updated_at`,
      ).run(
        user.id,
        paperId,
        c.req.header('content-type') ?? 'application/octet-stream',
        shaHeader,
        total,
        now,
        now,
      )
      addStorageUsed(db, user.id, total - oldSize)
    })()

    const resBody: FilePutResponse = { ok: true, sha256: shaHeader, byteSize: total }
    return c.json(resBody)
  })

  r.get('/:paperId', (c) => {
    const paperId = c.req.param('paperId')
    if (!FILE_ID_RE.test(paperId)) return apiError(c, 400, 'invalid-input', 'paperId 不合法')
    const user = c.get('user')
    const row = db
      .prepare('SELECT * FROM stored_files WHERE user_id = ? AND paper_id = ?')
      .get(user.id, paperId) as StoredFileRow | undefined
    if (!row) return apiError(c, 404, 'not-found')

    const etag = `"${row.sha256}"`
    const inm = c.req.header('if-none-match')
    // 内容寻址:sha256 相同即字节相同,304 让换设备后的重复拉取只花一个 RTT
    if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag } })
    }

    const filePath = storedFilePath(config.filesDir, user.id, paperId)
    if (!existsSync(filePath)) {
      // 元数据在、文件丢了(磁盘事故/手工误删):按 404 报,并留日志供恢复排查
      console.error(`[files] 元数据存在但磁盘文件缺失:user=${user.id} paper=${paperId}`)
      return apiError(c, 404, 'not-found')
    }
    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>
    return new Response(stream, {
      headers: {
        'Content-Type': row.mime,
        'Content-Length': String(row.byte_size),
        ETag: etag,
        // no-cache = 可缓存但必须回源验证 → 命中上面的 304 分支
        'Cache-Control': 'private, no-cache',
      },
    })
  })

  return r
}
