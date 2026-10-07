import type { IngestDeps, IngestState, ParseResult } from './ingest'
import { rekeyBlockDerivatives } from './rekeyDerivatives'
import { getRepos } from './repo/repos'
import type { PaperFormat } from './types'
import { sha256Hex } from './validate'

/**
 * 导入编排的运行时依赖（无 React）：论文列表页的导入 / 重试与工作台的「重新解析」共用同一份，
 * 两处的解析器选择、哈希、派生物重打键行为字节不差。
 */

/**
 * 解析器按格式动态 import：pdfjs / mammoth / 两种 html 容器解码器都不进入口 chunk，
 * 首次导入对应格式时才拉取。html 有两种源文件形态，由 parseHtmlBytes 按魔数再分流一次：
 * 网页原貌快照（webSnapshot.ts）与 URL 净化正文合集（urlBundle.ts）。
 */
export async function parseByFormat(input: { bytes: ArrayBuffer; format: PaperFormat }): Promise<ParseResult> {
  if (input.format === 'pdf') {
    const { parsePdfBytes } = await import('./parsePdf')
    return parsePdfBytes(input.bytes)
  }
  if (input.format === 'html') {
    const { parseHtmlBytes } = await import('./url/parseHtmlBytes')
    return parseHtmlBytes(input.bytes)
  }
  const { parseDocxBytes } = await import('./parseDocx')
  return parseDocxBytes(input.bytes)
}

/**
 * 组装 IngestDeps：仓储走 getRepos() 门面（引用永不变，调用时按登录态路由到游客库 / 账号库），
 * `rekeyDerivatives` 让 reingestPaper 在重解析后按「文本相等」把译文与高亮搬到新序号上。
 */
export function createIngestDeps(opts: { onState?: (s: IngestState) => void } = {}): IngestDeps {
  return {
    repo: getRepos().paper,
    hash: sha256Hex,
    parse: parseByFormat,
    rekeyDerivatives: (input) => rekeyBlockDerivatives(input, getRepos()).then(() => undefined),
    ...(opts.onState ? { onState: opts.onState } : {}),
  }
}
