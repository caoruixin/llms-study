import type { ParseResult } from '../ingest'
import { looksLikeWebSnapshot } from './webSnapshotMime'

/**
 * format='html' 的统一解析入口：按魔数分流两种「html 源文件」形态。
 *
 *   'PCS1' 开头 → 网页原貌快照容器（webSnapshot.ts）
 *   其余        → URL 净化正文合集 JSON（urlBundle.ts，阅读模式）
 *
 * 这个函数取代 PapersPage.parseByFormat 里对 parseUrlBundleBytes 的直接调用
 * （后续步骤接线；本步只落地契约，不动 PapersPage.tsx）。
 *
 * 两个实现都**动态 import**：嗅探本身走零依赖叶子 webSnapshotMime.ts，于是导入一篇
 * 阅读模式论文不会拉进快照解码器，反之亦然，论文库入口 chunk 也不含任何一个。
 */
export async function parseHtmlBytes(bytes: ArrayBuffer): Promise<ParseResult> {
  if (looksLikeWebSnapshot(bytes)) {
    const { parseWebSnapshotBytes } = await import('./webSnapshot')
    return parseWebSnapshotBytes(bytes)
  }
  const { parseUrlBundleBytes } = await import('./urlBundle')
  return parseUrlBundleBytes(bytes)
}
