import { useCallback, useEffect, useRef, useState } from 'react'
import { PAPER_TASKS, buildStructuredFallbackSpec } from '../../../data/paperPolicy'
import { LlmError, type LlmAuthCode } from '../../llmClient'
import { GatewayError, type ModelGateway } from '../modelGateway'
import { getPaperGateway } from '../gatewaySingleton'
import { getRepos } from '../repo/repos'
import type { BlockTranslation, LangMode, PaperBlock, PaperRecord } from '../types'
import {
  TRANSLATE_PROMPT_VERSION,
  buildTranslateMessages,
  packBatches,
  planTranslationWindow,
  srcHash,
  translateItemKey,
  validateTranslationJson,
  type TranslateItem,
} from './translateBatch'

/**
 * 全文翻译的调度层：内存 Map 缓存、单飞行逐包串行、窗口重算、失败对分与 Dexie 读写。
 * 调度器（createTranslationScheduler）不含 React，依赖全部注入，node 环境直接单测；
 * useTranslations 是薄 hook 外壳：接线真实 gateway/repo/consent 并做 300ms 防抖。
 */

/** 窗口重算防抖：滚动中 position.blockIndex 高频变化，稳定 300ms 才出包 */
export const WINDOW_DEBOUNCE_MS = 300

export interface TranslationSnapshot {
  /** blockIndex → 已完成译文（缺席 = 骨架态） */
  texts: ReadonlyMap<number, string>
  /** 修复/对分后仍失败的块：显示原文 + 重试 chip，不再自动重试（防失败风暴） */
  failed: ReadonlySet<number>
  /** 账号侧 auth 失败（未登录/未配 key）：重试无意义，UI 据此把失败 chip 换成配置引导 */
  authIssue: LlmAuthCode | null
}

export interface TranslationSchedulerDeps {
  gateway: Pick<ModelGateway, 'completePaperJson'>
  loadTranslations: (paperId: string) => Promise<BlockTranslation[]>
  saveTranslations: (rows: BlockTranslation[]) => Promise<void>
  /** deepseek 授权 gate：false = 用户拒绝，调度停机、骨架态保留 */
  ensureConsent: () => Promise<boolean>
  now?: () => number
}

export interface TranslationScheduler {
  /** 首次（或再次）激活：整表载入内存 Map 并按当前窗口开工；拒绝授权后的再激活会重新询问 */
  activate(): Promise<void>
  /** 阅读位置变化：重算窗口（未 activate / sensitive 时是空操作） */
  setWindow(currentBlockIndex: number): void
  /** 单块重试：清失败标记并重新入窗 */
  retryBlock(blockIndex: number): void
  dispose(): void
}

export function createTranslationScheduler(opts: {
  paper: Pick<PaperRecord, 'id' | 'sensitive'>
  blocks: readonly PaperBlock[]
  deps: TranslationSchedulerDeps
  onChange: (snap: TranslationSnapshot) => void
}): TranslationScheduler {
  const { paper, blocks, deps } = opts
  const now = deps.now ?? (() => Date.now())
  const blockByIndex = new Map<number, PaperBlock>()
  for (const b of blocks) blockByIndex.set(b.index, b)

  const texts = new Map<number, string>()
  const failed = new Set<number>()
  /** 正在飞行的批次覆盖的块：窗口重算不重复入队 */
  const inFlight = new Set<number>()
  /** 长块分片缓冲：blockIndex → (piece → 译文)；集齐才落库，避免半块译文入表 */
  const pieceBuf = new Map<number, Map<number, string>>()

  let queue: TranslateItem[][] = []
  let currentIndex = 0
  let running = false
  let disposed = false
  /** 授权被拒 / 网关级失败（熔断等）后停机：骨架保留，重试或再激活恢复 */
  let halted = false
  /** auth 失败细分码（未登录/未配 key）：随停机记录，重试/再激活清除 */
  let authIssue: LlmAuthCode | null = null
  let consentOk = false
  let loadPromise: Promise<void> | null = null

  const emit = () => {
    if (!disposed) opts.onChange({ texts: new Map(texts), failed: new Set(failed), authIssue })
  }

  const load = async () => {
    let rows: BlockTranslation[] = []
    try {
      rows = await deps.loadTranslations(paper.id)
    } catch {
      // 读缓存失败按空缓存处理：代价是重译，不阻断阅读
    }
    for (const row of rows) {
      const block = blockByIndex.get(row.blockIndex)
      if (!block) continue
      // promptVersion / srcHash 不符视同缺失（协议升级或原文重解析后懒重译）
      if (row.promptVersion !== TRANSLATE_PROMPT_VERSION || row.srcHash !== srcHash(block.text)) continue
      texts.set(row.blockIndex, row.text)
    }
    emit()
  }

  const recompute = () => {
    const items = planTranslationWindow(blocks, currentIndex, {
      has: (i) => texts.has(i) || failed.has(i) || inFlight.has(i),
    }).filter((it) => it.piece === undefined || !pieceBuf.get(it.blockIndex)?.has(it.piece))
    queue = packBatches(items)
  }

  /** 长块的分片总数（与 planTranslationWindow 同一套切分口径，集齐判定用） */
  const planPieceCount = (block: PaperBlock): number =>
    planTranslationWindow([block], block.index, { has: () => false }).length

  const finalize = (blockIndex: number, text: string, rows: BlockTranslation[]) => {
    texts.set(blockIndex, text)
    const block = blockByIndex.get(blockIndex)
    if (!block) return
    const ts = now()
    rows.push({
      id: `${paper.id}:${blockIndex}:zh`,
      paperId: paper.id,
      blockIndex,
      blockId: block.id,
      targetLang: 'zh',
      promptVersion: TRANSLATE_PROMPT_VERSION,
      model: PAPER_TASKS.translate.cap.model,
      srcHash: srcHash(block.text),
      text,
      createdAt: ts,
      updatedAt: ts,
    })
  }

  const apply = (batch: readonly TranslateItem[], zhByKey: Map<string, string>) => {
    const rows: BlockTranslation[] = []
    for (const it of batch) {
      const zh = zhByKey.get(translateItemKey(it.blockIndex, it.piece))
      if (zh === undefined) continue // 键集合校验已保证完备，防御分支
      if (it.piece === undefined) {
        finalize(it.blockIndex, zh, rows)
        continue
      }
      let buf = pieceBuf.get(it.blockIndex)
      if (!buf) {
        buf = new Map()
        pieceBuf.set(it.blockIndex, buf)
      }
      buf.set(it.piece, zh)
      const block = blockByIndex.get(it.blockIndex)
      const total = block ? planPieceCount(block) : 0
      if (total > 0 && buf.size >= total) {
        const joined = [...buf.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join('')
        finalize(it.blockIndex, joined, rows)
        pieceBuf.delete(it.blockIndex)
      }
    }
    if (rows.length) {
      // 落库失败不回滚内存态：本会话译文仍可读，下次打开懒重译
      void deps.saveTranslations(rows).catch(() => undefined)
    }
    emit()
  }

  const markFailed = (batch: readonly TranslateItem[]) => {
    for (const it of batch) failed.add(it.blockIndex)
    emit()
  }

  /**
   * 单包执行：gateway 内部已带 validate→同模型修复→兜底阶梯；仍对不齐时在这里
   * 对分递归隔离坏条目，最终单条失败才标记块级 error。
   */
  const runBatch = async (batch: TranslateItem[]): Promise<void> => {
    if (disposed || halted) return
    const expectedKeys = batch.map((it) => translateItemKey(it.blockIndex, it.piece))
    let parsed: unknown
    try {
      const res = await deps.gateway.completePaperJson({
        spec: PAPER_TASKS.translate,
        messages: buildTranslateMessages(batch),
        paperId: paper.id,
        sensitive: paper.sensitive,
        task: 'translate',
        validate: (raw) => validateTranslationJson(raw, expectedKeys),
        structuredFallback: buildStructuredFallbackSpec(PAPER_TASKS.translate.maxOutputTokens),
      })
      parsed = res.parsed
    } catch (e) {
      if (e instanceof GatewayError) {
        // 熔断/敏感/未授权：整体停机保骨架（standalone 重试或再激活恢复），不刷一屏失败 chip
        halted = true
        return
      }
      if (e instanceof LlmError && e.kind === 'auth') {
        // 账号侧配置问题（未登录/未配 key）：继续出包只会刷一屏 403，停机；
        // 已入队的块标失败，失败 chip 按 authIssue 换成「去设置页配置」引导
        authIssue = e.code ?? 'forbidden'
        halted = true
        markFailed(batch)
        return
      }
      markFailed(batch)
      return
    }
    if (parsed instanceof Map) {
      apply(batch, parsed as Map<string, string>)
      return
    }
    if (batch.length > 1) {
      const mid = Math.ceil(batch.length / 2)
      await runBatch(batch.slice(0, mid))
      await runBatch(batch.slice(mid))
      return
    }
    markFailed(batch)
  }

  const drain = async () => {
    running = true
    try {
      while (!disposed && !halted && queue.length) {
        // 每轮出包前宏任务让位：drain 是 fire-and-forget，微任务续体总排在
        // 「await activate() 后同步调 dispose()/setWindow()」的调用方之前，
        // 不让位的话首包会抢在 dispose 前发出。让位后世界可能已变，重查再走。
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (disposed || halted || !queue.length) break
        if (!consentOk) {
          consentOk = await deps.ensureConsent()
          if (!consentOk) {
            halted = true
            break
          }
          continue // 授权对话框挂起期间世界可能已变（dispose/窗口重算），回循环头重查
        }
        const batch = queue.shift()!
        for (const it of batch) inFlight.add(it.blockIndex)
        try {
          await runBatch(batch)
        } finally {
          for (const it of batch) inFlight.delete(it.blockIndex)
        }
        // 每包结束按最新阅读位置重算：滚动期间窗口已经移走，别翻早已离屏的块
        recompute()
      }
    } finally {
      running = false
    }
  }

  const schedule = () => {
    if (running || disposed || halted || paper.sensitive) return
    if (queue.length) void drain()
  }

  return {
    async activate() {
      if (disposed) return
      halted = false // 再激活给拒绝授权/熔断后的用户一次重来机会
      authIssue = null
      loadPromise ??= load()
      await loadPromise
      if (paper.sensitive) return // 敏感论文：只读缓存，绝不出包
      recompute()
      schedule()
    },
    setWindow(currentBlockIndex) {
      currentIndex = currentBlockIndex
      if (disposed || !loadPromise || paper.sensitive) return
      recompute()
      schedule()
    },
    retryBlock(blockIndex) {
      if (disposed) return
      failed.delete(blockIndex)
      halted = false
      authIssue = null // 用户可能已去设置页配好 key，给一次干净重试
      emit()
      if (paper.sensitive || !loadPromise) return
      recompute()
      schedule()
    },
    dispose() {
      disposed = true
      queue = []
    },
  }
}

// ---------------------------------------------------------------------------
// React hook 外壳
// ---------------------------------------------------------------------------

export interface UseTranslationsResult extends TranslationSnapshot {
  retryBlock: (blockIndex: number) => void
  /** 未授权 deepseek 时挂起的授权请求：由页面渲染 ConsentDialog 并回填决定 */
  consentAsk: ((granted: boolean) => void) | null
}

const EMPTY_SNAPSHOT: TranslationSnapshot = { texts: new Map(), failed: new Set(), authIssue: null }

export function useTranslations(opts: {
  paper: PaperRecord | null
  blocks: PaperBlock[]
  langMode: LangMode
  currentBlockIndex: number
}): UseTranslationsResult {
  const { paper, blocks, langMode, currentBlockIndex } = opts
  const [snapshot, setSnapshot] = useState<TranslationSnapshot>(EMPTY_SNAPSHOT)
  const [consentAsk, setConsentAsk] = useState<((granted: boolean) => void) | null>(null)
  const schedulerRef = useRef<TranslationScheduler | null>(null)

  // 换论文/blocks 重载时重建调度器（创建是零 IO 的，activate 才读库出包）
  useEffect(() => {
    if (!paper || paper.status !== 'ready' || blocks.length === 0) {
      schedulerRef.current = null
      setSnapshot(EMPTY_SNAPSHOT)
      return
    }
    const scheduler = createTranslationScheduler({
      paper,
      blocks,
      deps: {
        gateway: getPaperGateway(),
        loadTranslations: (paperId) => getRepos().translation.getTranslations(paperId),
        saveTranslations: (rows) => getRepos().translation.putTranslations(rows),
        // consent gate 复用 ConsentDialog 流程：已授权直接过；否则挂起等页面对话框回填
        ensureConsent: async () => {
          const existing = await getRepos().copilot.getConsent('deepseek')
          if (existing?.granted) return true
          return new Promise<boolean>((resolve) => {
            setConsentAsk(() => (granted: boolean) => {
              setConsentAsk(null)
              if (granted) void getRepos().copilot.setConsent('deepseek', true).catch(() => undefined)
              resolve(granted)
            })
          })
        },
      },
      onChange: setSnapshot,
    })
    schedulerRef.current = scheduler
    setSnapshot(EMPTY_SNAPSHOT)
    return () => {
      scheduler.dispose()
      if (schedulerRef.current === scheduler) schedulerRef.current = null
      setConsentAsk(null)
    }
    // paper.sensitive 变化也要重建：敏感开关切换即刻改变「是否允许出包」
  }, [paper, blocks])

  // 激活：每次从原文切到中文/对照都重新 activate（拒绝授权后再切换会重新询问）
  useEffect(() => {
    if (langMode === 'orig') return
    void schedulerRef.current?.activate()
  }, [langMode, paper, blocks])

  // 窗口跟随阅读位置：300ms 防抖，滚动停稳才重算出包
  useEffect(() => {
    if (langMode === 'orig') return
    const timer = setTimeout(() => schedulerRef.current?.setWindow(currentBlockIndex), WINDOW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [langMode, currentBlockIndex, paper, blocks])

  const retryBlock = useCallback((blockIndex: number) => {
    schedulerRef.current?.retryBlock(blockIndex)
  }, [])

  return { texts: snapshot.texts, failed: snapshot.failed, authIssue: snapshot.authIssue, retryBlock, consentAsk }
}
