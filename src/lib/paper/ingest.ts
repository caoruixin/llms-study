import { buildChunkRows, chunkBlocks } from './chunking'
import { MAX_TEXT_CHARS, validateFile } from './validate'
import type { PaperRepository } from './repo/paperRepo'
import type {
  IngestFailure,
  IngestFailureKind,
  IngestStage,
  NormalizedBlock,
  PaperChunk,
  PaperFormat,
  PaperRecord,
} from './types'

/** 全链路统一的分类错误：解析器 / 仓储 / 编排层都抛它，编排层据此写 IngestFailure */
export class IngestError extends Error {
  readonly kind: IngestFailureKind
  constructor(kind: IngestFailureKind, message: string) {
    super(message)
    this.name = 'IngestError'
    this.kind = kind
  }
}

// ---------------------------------------------------------------------------
// 状态机（纯函数）
// ---------------------------------------------------------------------------

export interface IngestState {
  stage: IngestStage
  attempts: number
  failure?: IngestFailure
}

export const INITIAL_INGEST_STATE: IngestState = { stage: 'queued', attempts: 0 }

export type IngestEvent =
  | { type: 'enqueue' }
  | { type: 'validate:start' }
  | { type: 'validate:ok' }
  | { type: 'parse:start' }
  | { type: 'parse:ok' }
  | { type: 'normalize:ok' }
  | { type: 'index:ok' }
  | { type: 'fail'; kind: IngestFailureKind; message: string; at: number }
  | { type: 'retry'; at: number }

/**
 * 阶段推进：queued → validating → parsing → normalizing → indexing → ready。
 * 非法迁移一律原样返回（不抛）——导入流程里迟到的事件不该炸掉整条管线。
 *
 * 两个进入 parsing 的入口是有意的：`validate:ok` 供首次导入（刚校验完），
 * `parse:start` 供重试路径（字节已在首次导入时校验过，直接重跑解析）。
 */
export function ingestReducer(s: IngestState, ev: IngestEvent): IngestState {
  switch (ev.type) {
    case 'enqueue':
      // 重新入队：清掉上一轮的失败信息，attempts 由 retry 事件负责累加
      return s.stage === 'queued' && !s.failure ? s : { stage: 'queued', attempts: s.attempts }
    case 'validate:start':
      return s.stage === 'queued' ? { ...s, stage: 'validating' } : s
    case 'validate:ok':
      return s.stage === 'validating' ? { ...s, stage: 'parsing' } : s
    case 'parse:start':
      return s.stage === 'queued' || s.stage === 'validating' ? { ...s, stage: 'parsing' } : s
    case 'parse:ok':
      return s.stage === 'parsing' ? { ...s, stage: 'normalizing' } : s
    case 'normalize:ok':
      return s.stage === 'normalizing' ? { ...s, stage: 'indexing' } : s
    case 'index:ok':
      return s.stage === 'indexing' ? { ...s, stage: 'ready' } : s
    case 'fail':
      // 已经 ready 的论文不再被迟到的失败事件推翻
      return s.stage === 'ready'
        ? s
        : { stage: 'failed', attempts: s.attempts, failure: { kind: ev.kind, message: ev.message, at: ev.at } }
    case 'retry':
      return s.stage === 'failed' ? { stage: 'queued', attempts: s.attempts + 1 } : s
  }
}

/**
 * 可重试 = 外因失败（存储、未知）。其余都是对这份文件的确定性拒绝：
 * 同样的字节再跑一次结果必然相同，只能删除或换文件，UI 不显示「重试」。
 */
export function isRetryable(kind: IngestFailureKind): boolean {
  return kind === 'storage' || kind === 'unknown'
}

// ---------------------------------------------------------------------------
// 串行队列（§4.4：同一时刻只解析一个文档，避免多 Worker 内存叠加）
// ---------------------------------------------------------------------------

interface QueueItem {
  id: string
  run: (signal: AbortSignal) => Promise<void>
  resolve: () => void
  reject: (e: unknown) => void
  controller: AbortController
}

export interface SerialQueue {
  /**
   * 入队并返回该任务的完成 Promise。
   * 任务抛错 → reject（不影响后续任务）；任务被 cancel → resolve（调用方通过 signal 自行区分）。
   */
  enqueue(id: string, run: (signal: AbortSignal) => Promise<void>): Promise<void>
  /** 尚未完成的任务总数（含正在执行的那个）；为 0 表示队列已排空 */
  size(): number
  activeId(): string | null
  cancel(id: string): void
  cancelAll(): void
}

export function createSerialQueue(): SerialQueue {
  const pending: QueueItem[] = []
  let active: QueueItem | null = null
  let draining = false

  async function drain(): Promise<void> {
    if (draining) return
    draining = true
    try {
      while (pending.length) {
        const item = pending.shift()!
        active = item
        try {
          // 并发恒为 1：上一个任务 settle 之前不会取下一个
          await item.run(item.controller.signal)
          item.resolve()
        } catch (e) {
          // 单个任务失败不阻塞后续任务
          item.reject(e)
        } finally {
          active = null
        }
      }
    } finally {
      draining = false
    }
  }

  return {
    enqueue(id, run) {
      return new Promise<void>((resolve, reject) => {
        pending.push({ id, run, resolve, reject, controller: new AbortController() })
        void drain()
      })
    },
    size: () => pending.length + (active ? 1 : 0),
    activeId: () => active?.id ?? null,
    cancel(id) {
      // 运行中的任务只能 abort signal，由 run 自行响应；排队中的直接出队
      if (active && active.id === id) {
        active.controller.abort()
        return
      }
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].id === id) {
          const [item] = pending.splice(i, 1)
          item.controller.abort()
          item.resolve()
        }
      }
    },
    cancelAll() {
      if (active) active.controller.abort()
      while (pending.length) {
        const item = pending.pop()!
        item.controller.abort()
        item.resolve()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 导入编排（依赖注入：解析器由调用方动态 import 后注入，测试可用假 parse 跑全链路）
// ---------------------------------------------------------------------------

export interface ParseResult {
  blocks: NormalizedBlock[]
  pageCount?: number
  title?: string
}

export interface IngestDeps {
  repo: PaperRepository
  hash: (bytes: ArrayBuffer) => Promise<string>
  parse: (input: { bytes: ArrayBuffer; format: PaperFormat }) => Promise<ParseResult>
  now?: () => number
  onState?: (s: IngestState) => void
}

export interface ImportFileInput {
  name: string
  size: number
  type: string
  bytes: ArrayBuffer
}

export type ImportOutcome =
  | { kind: 'duplicate'; existing: PaperRecord }
  | { kind: 'ready'; paper: PaperRecord }
  | { kind: 'failed'; paper?: PaperRecord; failure: IngestFailure }

/** 未知异常兜底分类：只有 IngestError 携带确定 kind，其余一律 unknown（可重试） */
function toFailure(e: unknown, at: number): IngestFailure {
  if (e instanceof IngestError) return { kind: e.kind, message: e.message, at }
  const message = e instanceof Error ? e.message : String(e)
  return { kind: 'unknown', message: message || '导入失败（未知错误）', at }
}

const titleFromFileName = (name: string): string => name.replace(/\.[^.]+$/, '') || name

export function countBlockChars(blocks: NormalizedBlock[]): number {
  let n = 0
  for (const b of blocks) n += b.text.length
  return n
}

/** 分词是同步 CPU 工作：每批之后让出事件循环，导入长文时 UI 仍可响应 */
const INDEX_BATCH = 32

/**
 * 索引阶段（§4.4）：正文块 → 语义 chunk（连同 BM25 词频表）→ 落库。
 * 全部本地计算，不发生任何网络请求；索引建好后「模型不可用也能全文搜索」的承诺才成立。
 */
export async function buildPaperIndex(
  paperId: string,
  blocks: NormalizedBlock[],
  repo: PaperRepository,
): Promise<PaperChunk[]> {
  const drafts = chunkBlocks(blocks)
  const rows: PaperChunk[] = []
  for (let i = 0; i < drafts.length; i += INDEX_BATCH) {
    rows.push(...buildChunkRows(paperId, drafts.slice(i, i + INDEX_BATCH)))
    if (i + INDEX_BATCH < drafts.length) await new Promise<void>((r) => setTimeout(r, 0))
  }
  await repo.saveChunks(paperId, rows)
  return rows
}

/**
 * 单文件导入全链路：
 * 校验 → SHA-256 → 去重早退 → 建记录 → 解析 → 落块 → 索引（Phase 1 为 no-op 占位）→ ready。
 * 任何抛出都被分类成 IngestFailure 并写进论文记录，绝不留下卡在中间态的空论文。
 */
export async function importPaper(file: ImportFileInput, deps: IngestDeps): Promise<ImportOutcome> {
  const now = deps.now ?? Date.now
  let state = INITIAL_INGEST_STATE
  const dispatch = (ev: IngestEvent) => {
    state = ingestReducer(state, ev)
    deps.onState?.(state)
  }

  dispatch({ type: 'validate:start' })

  const head = new Uint8Array(file.bytes.slice(0, 8))
  const verdict = validateFile({ name: file.name, size: file.size, type: file.type }, head)
  if (!verdict.ok) {
    // 校验不过的文件不写库——列表里不该出现一条永远打不开的记录
    dispatch({ type: 'fail', kind: verdict.kind, message: verdict.message, at: now() })
    return { kind: 'failed', failure: { kind: verdict.kind, message: verdict.message, at: now() } }
  }
  dispatch({ type: 'validate:ok' })

  let paper: PaperRecord | undefined
  try {
    const sha = await deps.hash(file.bytes)
    const existing = await deps.repo.findBySha256(sha)
    if (existing) return { kind: 'duplicate', existing }

    paper = await deps.repo.createPaper({
      title: titleFromFileName(file.name),
      fileName: file.name,
      format: verdict.format,
      mime: verdict.mime,
      byteSize: file.size,
      sha256: sha,
      bytes: file.bytes,
    })
    await deps.repo.setStage(paper.id, 'parsing')

    const parsed = await deps.parse({ bytes: file.bytes, format: verdict.format })
    dispatch({ type: 'parse:ok' })

    const charCount = countBlockChars(parsed.blocks)
    if (charCount > MAX_TEXT_CHARS) {
      throw new IngestError('too-much-text', `抽取正文 ${charCount} 字符，超过 200 万字符上限`)
    }
    if (parsed.blocks.length === 0) {
      throw new IngestError('no-text-layer', '没有抽取到任何文字内容（可能是扫描件，首版不做 OCR）')
    }

    await deps.repo.setStage(paper.id, 'normalizing')
    await deps.repo.saveBlocks(paper.id, parsed.blocks)
    dispatch({ type: 'normalize:ok' })

    await deps.repo.setStage(paper.id, 'indexing')
    await buildPaperIndex(paper.id, parsed.blocks, deps.repo)
    dispatch({ type: 'index:ok' })

    await deps.repo.markReady(paper.id, {
      pageCount: parsed.pageCount,
      blockCount: parsed.blocks.length,
      charCount,
      title: parsed.title,
    })
    const ready = await deps.repo.getPaper(paper.id)
    return { kind: 'ready', paper: ready ?? paper }
  } catch (e) {
    const failure = toFailure(e, now())
    dispatch({ type: 'fail', ...failure })
    if (paper) {
      // markFailed 自身再抛（例如存储彻底不可用）时不覆盖原始失败原因
      try {
        await deps.repo.markFailed(paper.id, failure)
      } catch {
        /* 已经在失败路径上，尽力而为 */
      }
    }
    return { kind: 'failed', paper, failure }
  }
}

/**
 * 失败重试：从 files 表取回原始字节重跑解析（不重新校验——字节在首次导入时已校验过）。
 * attempts 由 repo.retryPaper 累加。
 */
export async function reingestPaper(paperId: string, deps: IngestDeps): Promise<ImportOutcome> {
  const now = deps.now ?? Date.now
  let state = INITIAL_INGEST_STATE
  const dispatch = (ev: IngestEvent) => {
    state = ingestReducer(state, ev)
    deps.onState?.(state)
  }

  const paper = await deps.repo.getPaper(paperId)
  if (!paper) {
    const failure: IngestFailure = { kind: 'unknown', message: '论文记录不存在（可能已被删除）', at: now() }
    dispatch({ type: 'fail', ...failure })
    return { kind: 'failed', failure }
  }

  try {
    await deps.repo.retryPaper(paperId)
    const file = await deps.repo.getFileBytes(paperId)
    if (!file) throw new IngestError('storage', '原始文件字节已丢失，请重新导入该文件')

    dispatch({ type: 'parse:start' })
    await deps.repo.setStage(paperId, 'parsing')

    const parsed = await deps.parse({ bytes: file.bytes, format: paper.format })
    dispatch({ type: 'parse:ok' })

    const charCount = countBlockChars(parsed.blocks)
    if (charCount > MAX_TEXT_CHARS) {
      throw new IngestError('too-much-text', `抽取正文 ${charCount} 字符，超过 200 万字符上限`)
    }
    if (parsed.blocks.length === 0) {
      throw new IngestError('no-text-layer', '没有抽取到任何文字内容（可能是扫描件，首版不做 OCR）')
    }

    await deps.repo.setStage(paperId, 'normalizing')
    await deps.repo.saveBlocks(paperId, parsed.blocks)
    dispatch({ type: 'normalize:ok' })

    await deps.repo.setStage(paperId, 'indexing')
    await buildPaperIndex(paperId, parsed.blocks, deps.repo)
    dispatch({ type: 'index:ok' })

    await deps.repo.markReady(paperId, {
      pageCount: parsed.pageCount,
      blockCount: parsed.blocks.length,
      charCount,
      title: parsed.title,
    })
    const ready = await deps.repo.getPaper(paperId)
    return { kind: 'ready', paper: ready ?? paper }
  } catch (e) {
    const failure = toFailure(e, now())
    dispatch({ type: 'fail', ...failure })
    try {
      await deps.repo.markFailed(paperId, failure)
    } catch {
      /* 已经在失败路径上，尽力而为 */
    }
    return { kind: 'failed', paper, failure }
  }
}
