import { createSerialQueue, type SerialQueue } from './ingest'

/**
 * 导入 / 重新解析共用的串行队列（模块单例）。
 *
 * 为什么不再是 PapersPage 里的 `useRef(createSerialQueue())`：工作台的「重新解析」按钮也要解析 PDF，
 * 若各自建队列，列表页导入进行中跳到工作台再点重解析就会有两个 pdf.js worker 并行，
 * 内存叠加（§4.4 的「同一时刻只解析一个文档」约束失效）。单例让两处入口天然排队。
 */
export const ingestQueue: SerialQueue = createSerialQueue()
