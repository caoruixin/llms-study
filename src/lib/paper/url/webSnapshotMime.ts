/**
 * 「网页原貌」快照容器的 MIME 与魔数——零依赖叶子文件（同 urlBundleMime.ts 的角色）。
 *
 * 为什么单独拆出来：validate.ts 的 MIME_BY_FORMAT 需要这个常量，而 webSnapshot.ts
 * 依赖 ingest.ts（取 IngestError）、ingest.ts 又依赖 validate.ts（取 MAX_TEXT_CHARS/
 * validateFile）——若 validate.ts 直接从 webSnapshot.ts 取值就会成环
 * （validate → webSnapshot → ingest → validate）。
 *
 * 另一层作用：parseHtmlBytes.ts 靠 looksLikeWebSnapshot 分流两种 html 字节形态
 * （快照容器 / URL 合集 JSON），嗅探必须**同步且零依赖**——真正的解析器才动态 import，
 * 这样两个重实现都不会进论文库入口 chunk。
 */

/** PaperRecord.format 仍是 'html'；mime 才区分「网页原貌快照」与「URL 净化合集」 */
export const WEB_SNAPSHOT_MIME = 'application/x-paper-web-snapshot'

/** 容器头 4 字节：'PCS1' = Paper Copilot Snapshot v1 */
export const WEB_SNAPSHOT_MAGIC = [0x50, 0x43, 0x53, 0x31]

/** 魔数粗检：只看前 4 字节，不解 JSON、不校验长度（那是 decodeWebSnapshot 的事） */
export function looksLikeWebSnapshot(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < WEB_SNAPSHOT_MAGIC.length) return false
  const head = new Uint8Array(bytes, 0, WEB_SNAPSHOT_MAGIC.length)
  for (let i = 0; i < WEB_SNAPSHOT_MAGIC.length; i++) {
    if (head[i] !== WEB_SNAPSHOT_MAGIC[i]) return false
  }
  return true
}
