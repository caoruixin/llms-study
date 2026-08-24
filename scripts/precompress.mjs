/**
 * 构建后预压缩:为 dist 下的文本资产生成 .gz 副本(zlib 级别 9),
 * 供 nginx `gzip_static on` 直接回源——比运行时 gzip(默认级别 1)体积
 * 小 15~20%,且省 CPU。跨境直连带宽 ~17KB/s 的场景里每一 KB 都算数。
 * 不生成 .br:服务器 nginx 未编译 brotli 模块。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'

const gz = promisify(gzip)
const DIST = path.resolve(process.cwd(), 'dist')
const EXT = new Set(['.js', '.css', '.html', '.json', '.svg', '.txt', '.xml', '.wasm', '.mjs'])
const MIN_BYTES = 1024 // 小文件压缩收益抵不过一次额外 stat

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(p)
    else yield p
  }
}

let count = 0
let saved = 0
for await (const file of walk(DIST)) {
  if (!EXT.has(path.extname(file))) continue
  const buf = await fs.readFile(file)
  if (buf.byteLength < MIN_BYTES) continue
  const out = await gz(buf, { level: 9 })
  // 压不动的(已压缩格式误入名单等)不落 .gz,nginx 会正常回退原文件
  if (out.byteLength >= buf.byteLength) continue
  await fs.writeFile(`${file}.gz`, out)
  count += 1
  saved += buf.byteLength - out.byteLength
}
console.log(`precompress: ${count} 个文件,共省 ${(saved / 1024 / 1024).toFixed(1)}MB`)
