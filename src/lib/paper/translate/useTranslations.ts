import { useCallback, useEffect, useRef, useState } from 'react'
import type { SyncTable } from '../../../../shared/apiTypes'
import { PAPER_CIRCUIT, PAPER_TASKS, buildStructuredFallbackSpec } from '../../../data/paperPolicy'
import { LlmError, type LlmAuthCode } from '../../llmClient'
import { GatewayError, type ModelGateway } from '../modelGateway'
import { getPaperGateway } from '../gatewaySingleton'
import { getRepos } from '../repo/repos'
import type { BlockTranslation, LangMode, PaperBlock, PaperRecord } from '../types'
import {
  TRANSLATE_PROMPT_VERSION,
  buildTranslateMessages,
  packBatches,
  planFullTranslation,
  planTranslationWindow,
  srcHash,
  translatableIndices,
  translateItemKey,
  validateTranslationJson,
  type TranslateItem,
} from './translateBatch'

/**
 * 全文翻译的调度层：内存 Map 缓存、单飞行逐包串行、窗口重算、失败对分、熔断暂停到点自动续上与 Dexie 读写；
 * 导出前的全篇补全（translateAll）复用同一条 drain，只是规划改按文档顺序不裁窗口。
 * 调度器（createTranslationScheduler）不含 React，依赖全部注入，node 环境直接单测；
 * useTranslations 是薄 hook 外壳：接线真实 gateway/repo/consent 并做 300ms 防抖。
 */

/** 窗口重算防抖：滚动中 position.blockIndex 高频变化，稳定 300ms 才出包 */
export const WINDOW_DEBOUNCE_MS = 300

/**
 * 熔断暂停的恢复余量：网关按 openUntil > now 判定仍在冷却，定时器要比 remainingMs 晚一点再续，
 * 别正好踩在到期边界上又被拒一次（那只会白换一个定时器，但没必要）
 */
export const CIRCUIT_RESUME_SLACK_MS = 500

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

/** 全篇补全停下来的原因：都要用户动作才能解除（授权 / 配 key / 解除敏感），对话框据此给不同引导 */
export type TranslateAllHalt = 'consent' | 'auth' | 'blocked' | 'sensitive'

export interface TranslateAllProgress {
  /** 已有译文的可译块数（含此前缓存命中） */
  done: number
  /** 全篇可译块总数 */
  total: number
  /** 当前仍失败的块数 */
  failed: number
  /** 熔断暂停到点的时刻（deps.now 口径，缺省 Date.now 的毫秒时间戳）；未暂停为 null */
  pausedUntil: number | null
}

export interface TranslateAllResult {
  /** done = 队列跑空（failed 可能非空）；aborted = signal 中止 / dispose；halted = 停机，原因见 halt */
  outcome: 'done' | 'aborted' | 'halted'
  halt?: TranslateAllHalt
  /** 结束时刻的译文快照（拷贝：之后调度器继续写也不影响它） */
  texts: ReadonlyMap<number, string>
  /** 有译文的可译块数；translated === total 即全篇齐备 */
  translated: number
  /** 仍失败的块序号（升序） */
  failed: number[]
  total: number
}

export interface TranslateAllOptions {
  /** 中止：立即 resolve aborted，在飞的包仍照常落库 */
  signal?: AbortSignal
  onProgress?: (p: TranslateAllProgress) => void
}

/** 一次全篇补全的在册状态：有它即「全篇模式」 */
interface FullRun {
  signal?: AbortSignal
  onAbort: () => void
  onProgress?: (p: TranslateAllProgress) => void
  resolve: (r: TranslateAllResult) => void
  promise: Promise<TranslateAllResult>
}

export interface TranslationScheduler {
  /** 首次（或再次）激活：整表载入内存 Map 并按当前窗口开工；拒绝授权后的再激活会重新询问 */
  activate(): Promise<void>
  /** 阅读位置变化：重算窗口（未 activate / sensitive 时是空操作） */
  setWindow(currentBlockIndex: number): void
  /** 单块重试：清失败标记并重新入窗 */
  retryBlock(blockIndex: number): void
  /**
   * 重读译文表并补进内存（跨设备同步补拉后的失效通知，见 PLAN 1.6）：
   * 只补缺失/有变化的块、把这些块从 failed 里剔除；不改停机/授权状态。
   */
  reload(): Promise<void>
  /**
   * 导出前全篇补全：文档顺序把全部缺译可译块译完（此前失败的块恰好再试一次）。进行中重复调用返回同一 promise；
   * signal 中止 / dispose → aborted（在飞的包仍落库）；停机 → halted 带原因；敏感论文直接 halted/sensitive 不碰网关
   */
  translateAll(opts?: TranslateAllOptions): Promise<TranslateAllResult>
  dispose(): void
}

export function createTranslationScheduler(opts: {
  paper: Pick<PaperRecord, 'id' | 'sensitive'>
  blocks: readonly PaperBlock[]
  deps: TranslationSchedulerDeps
  /**
   * 出包顺序开关：true = 当前块起往后在前、回看在后（只在有滚动锚定兜底的场合成立），false = 文档顺序。
   * 每次重算时读——同一个调度器存续期间视图可能切换，不必为此重建。缺省恒真
   */
  aheadFirst?: () => boolean
  onChange: (snap: TranslationSnapshot) => void
}): TranslationScheduler {
  const { paper, blocks, deps } = opts
  const aheadFirst = opts.aheadFirst ?? (() => true)
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
  /**
   * 要用户动作才能解除的停机：授权被拒、敏感 / 未授权（GatewayError）、账号 auth 失败。
   * 骨架保留，retryBlock 或再激活恢复。熔断不走这里——它有期限，见 pauseTimer
   */
  let halted = false
  /**
   * 熔断暂停定时器：circuit-open 不停机也不标失败，按网关给的剩余冷却时长暂停，到点自动
   * recompute + schedule 续上。「定时器在手」即「暂停中」，二者永远一致，任何时刻最多一个；
   * activate / retryBlock 先把它清掉再立即重试，dispose 清掉后到点绝不再出包
   */
  let pauseTimer: ReturnType<typeof setTimeout> | null = null
  /** auth 失败细分码（未登录/未配 key）：随停机记录，重试/再激活清除 */
  let authIssue: LlmAuthCode | null = null
  /** 停机原因：与 halted 同时记录，全篇补全据此回报；activate / retryBlock / translateAll 复位时清零 */
  let haltReason: TranslateAllHalt | null = null
  /** 熔断暂停到点时刻：与 pauseTimer 同生同灭，全篇补全的进度回报用 */
  let pauseUntil: number | null = null
  let consentOk = false
  let loadPromise: Promise<void> | null = null
  /** 全篇可译块序号：进度分母 */
  const translatable = translatableIndices(blocks)
  /**
   * 进行中的全篇补全（translateAll）：有它 recompute 就改按文档顺序规划全部缺译块，不裁窗口；
   * 结束（done / aborted / halted）即清空回窗口模式。任何时刻最多一个，重复调用共享同一 promise
   */
  let full: FullRun | null = null

  const emit = () => {
    if (!disposed) opts.onChange({ texts: new Map(texts), failed: new Set(failed), authIssue })
  }

  const paused = () => pauseTimer !== null

  const progress = (): TranslateAllProgress => {
    let done = 0
    let failedCount = 0
    for (const i of translatable) {
      if (texts.has(i)) done += 1
      else if (failed.has(i)) failedCount += 1
    }
    return { done, total: translatable.length, failed: failedCount, pausedUntil: paused() ? pauseUntil : null }
  }

  /** 全篇模式下每次落库 / 标失败 / 暂停都回报进度；窗口模式空操作 */
  const reportProgress = () => {
    full?.onProgress?.(progress())
  }

  /**
   * 把库里的译文行灌进内存 Map，返回实际写入（新增或内容有变）的块序号。
   * load 与 reload 共用同一套校验口径，reload 据返回值精准清 failed。
   */
  const applyRows = (rows: readonly BlockTranslation[]): number[] => {
    const applied: number[] = []
    for (const row of rows) {
      const block = blockByIndex.get(row.blockIndex)
      if (!block) continue
      // promptVersion / srcHash 不符视同缺失（协议升级或原文重解析后懒重译）
      if (row.promptVersion !== TRANSLATE_PROMPT_VERSION || row.srcHash !== srcHash(block.text)) continue
      if (texts.get(row.blockIndex) === row.text) continue // 已是同一份译文：不动、不算变化
      texts.set(row.blockIndex, row.text)
      applied.push(row.blockIndex)
    }
    return applied
  }

  const readRows = async (): Promise<BlockTranslation[]> => {
    try {
      return await deps.loadTranslations(paper.id)
    } catch {
      // 读缓存失败按空缓存处理：代价是重译，不阻断阅读
      return []
    }
  }

  const load = async () => {
    applyRows(await readRows())
    emit()
  }

  const recompute = () => {
    const cache = { has: (i: number) => texts.has(i) || failed.has(i) || inFlight.has(i) }
    // 全篇模式不裁窗口、文档顺序；否则按阅读位置出窗口
    const planned = full
      ? planFullTranslation(blocks, cache)
      : planTranslationWindow(blocks, currentIndex, cache, aheadFirst() ? 'ahead-first' : 'document')
    queue = packBatches(planned.filter((it) => it.piece === undefined || !pieceBuf.get(it.blockIndex)?.has(it.piece)))
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
    reportProgress()
  }

  const markFailed = (batch: readonly TranslateItem[]) => {
    for (const it of batch) failed.add(it.blockIndex)
    emit()
    reportProgress()
  }

  const clearPause = () => {
    pauseUntil = null
    if (pauseTimer === null) return
    clearTimeout(pauseTimer)
    pauseTimer = null
  }

  /** 熔断暂停：先清旧定时器再设新的（任何时刻最多一个），到点未 dispose 就按最新窗口续上 */
  const pauseFor = (ms: number) => {
    // 网关是在 await 之后才抛的：这个空当里若已 dispose，别再挂一个最长 5 分钟的空定时器
    if (disposed) return
    clearPause()
    pauseUntil = now() + ms
    pauseTimer = setTimeout(() => {
      pauseTimer = null
      pauseUntil = null
      if (disposed) return
      recompute()
      schedule()
      settleFull() // 全篇模式：到点时队列已空（暂停期间 reload 补齐了）就该收尾，别悬着
    }, ms)
    settleFull() // 全篇模式：pausedUntil 立即报给对话框
  }

  /**
   * 单包执行：gateway 内部已带 validate→同模型修复→兜底阶梯；仍对不齐时在这里
   * 对分递归隔离坏条目，最终单条失败才标记块级 error。
   */
  const runBatch = async (batch: TranslateItem[]): Promise<void> => {
    // 暂停中也不出包：对分递归里前半包撞上熔断，后半包别再去碰网关
    if (disposed || halted || paused()) return
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
        if (e.kind === 'circuit-open') {
          // 熔断是有期限的（网关按 provider 冷却，对话/brief 的失败也会连带熔断翻译）：
          // 不停机、不标失败，骨架保留；这包的块随 drain 的 finally 移出 inFlight，
          // 暂停到点按最新窗口重新规划。网关在发请求之前就抛，这里没花钱
          pauseFor((e.remainingMs ?? PAPER_CIRCUIT.cooldownMs) + CIRCUIT_RESUME_SLACK_MS)
          return
        }
        // 敏感 / 未授权：要用户动作才能解除，整体停机保骨架（retryBlock 或再激活恢复），不刷一屏失败 chip
        halted = true
        haltReason = 'blocked'
        return
      }
      if (e instanceof LlmError && e.kind === 'auth') {
        // 账号侧配置问题（未登录/未配 key）：继续出包只会刷一屏 403，停机；
        // 已入队的块标失败，失败 chip 按 authIssue 换成「去设置页配置」引导
        authIssue = e.code ?? 'forbidden'
        halted = true
        haltReason = 'auth'
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
      while (!disposed && !halted && !paused() && queue.length) {
        // 每轮出包前宏任务让位：drain 是 fire-and-forget，微任务续体总排在
        // 「await activate() 后同步调 dispose()/setWindow()」的调用方之前，
        // 不让位的话首包会抢在 dispose 前发出。让位后世界可能已变，重查再走。
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (disposed || halted || paused() || !queue.length) break
        if (!consentOk) {
          consentOk = await deps.ensureConsent()
          if (!consentOk) {
            halted = true
            haltReason = 'consent'
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
      settleFull() // 全篇模式：drain 退出的每个出口（跑空 / 停机 / 暂停 / dispose）都在这里收口
    }
  }

  const schedule = () => {
    // 暂停中不出包：窗口变化只重算队列（setWindow / reload 照常 recompute），到点或用户动作再出
    if (running || disposed || halted || paused() || paper.sensitive) return
    if (queue.length) void drain()
  }

  // ---- 全篇补全（translateAll）----

  /** 结果快照：译文 Map 拷贝 + 失败块序号，resolve 之后调度器继续写也不影响拿到的人 */
  const fullResult = (outcome: TranslateAllResult['outcome'], halt?: TranslateAllHalt): TranslateAllResult => {
    const p = progress()
    return {
      outcome,
      ...(halt ? { halt } : {}),
      texts: new Map(texts),
      translated: p.done,
      failed: translatable.filter((i) => failed.has(i) && !texts.has(i)),
      total: p.total,
    }
  }

  /** 结束全篇补全：清状态、解绑 abort、回窗口模式（在飞的包仍经 apply 落库），resolve 快照 */
  const finishFull = (outcome: TranslateAllResult['outcome'], halt?: TranslateAllHalt) => {
    const run = full
    if (!run) return
    full = null
    run.signal?.removeEventListener('abort', run.onAbort)
    if (!disposed) recompute()
    run.resolve(fullResult(outcome, halt))
  }

  /**
   * 全篇补全的收口判定（drain 退出 / 暂停 / 到点续跑后都来一趟）：
   * 已 dispose → aborted；停机 → halted 带原因；暂停中 → 只报进度等到点；还在跑或有在飞的包 → 等它回来；
   * 否则重算一次（暂停期间 reload 可能补了几块），还有活就继续出包，没有就 done
   */
  const settleFull = () => {
    if (!full) return
    if (disposed) {
      finishFull('aborted')
      return
    }
    if (halted) {
      finishFull('halted', haltReason ?? 'blocked')
      return
    }
    if (paused()) {
      reportProgress()
      return
    }
    if (running || inFlight.size) return
    recompute()
    if (queue.length) {
      schedule()
      return
    }
    finishFull('done')
  }

  const startFull = async (run: FullRun) => {
    // 沿 activate() 复位：熔断不等到点立即试、停机 / auth 码清零，给全篇一次干净的开工
    clearPause()
    halted = false
    haltReason = null
    authIssue = null
    loadPromise ??= load()
    await loadPromise
    if (full !== run) return // 等库期间已被 abort / dispose 收尾
    if (paper.sensitive) {
      finishFull('halted', 'sensitive') // 敏感论文绝不出包，也不问授权
      return
    }
    // 此前失败的块在全篇模式下恰好再试一次：清空失败集重新入队，再失败仍落回 failed，不会风暴
    failed.clear()
    emit()
    reportProgress() // 开工先报一次：对话框立刻拿到 total 与缓存命中数
    recompute()
    schedule() // 窗口 drain 正在跑时这里直接返回：它下一次重算就切到全篇队列，不并发
    settleFull()
  }

  return {
    async activate() {
      if (disposed) return
      // 再激活给拒绝授权/熔断后的用户一次重来机会：熔断暂停不等到点，立即试一次；
      // 冷却未过网关会在发请求之前再抛 circuit-open，届时换一个新定时器
      clearPause()
      halted = false
      haltReason = null
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
    async reload() {
      if (disposed) return
      const rows = await readRows()
      if (disposed) return
      const applied = applyRows(rows)
      if (!applied.length) return // 无新增/无变化：不 emit，免得每次同步补拉都白重渲染整篇
      // 本地翻译失败的块，远端（另一台设备）已经译好了：清掉失败标记，chip 变回正文
      for (const i of applied) failed.delete(i)
      emit()
      // 新到的译文可能正好补上当前窗口的缺口：重算，别再花钱翻已经有的块。
      // 未 activate（loadPromise 为空）时不出包——与 setWindow 同一道门槛
      if (paper.sensitive || !loadPromise) return
      recompute()
      schedule()
    },
    retryBlock(blockIndex) {
      if (disposed) return
      clearPause() // 用户主动重试：不等熔断到点，立即试一次（同 activate）
      failed.delete(blockIndex)
      halted = false
      haltReason = null
      authIssue = null // 用户可能已去设置页配好 key，给一次干净重试
      emit()
      if (paper.sensitive || !loadPromise) return
      recompute()
      schedule()
    },
    translateAll(opts = {}) {
      if (full) return full.promise // 进行中重复调用（再点一次导出）：共享同一次补全
      if (disposed || opts.signal?.aborted) return Promise.resolve(fullResult('aborted'))
      let resolve!: (r: TranslateAllResult) => void
      const promise = new Promise<TranslateAllResult>((r) => {
        resolve = r
      })
      const run: FullRun = {
        signal: opts.signal,
        onAbort: () => finishFull('aborted'),
        onProgress: opts.onProgress,
        resolve,
        promise,
      }
      full = run
      opts.signal?.addEventListener('abort', run.onAbort, { once: true })
      void startFull(run)
      return promise
    },
    dispose() {
      disposed = true
      clearPause() // 到点后绝不再出包
      queue = []
      finishFull('aborted') // 全篇补全进行中：等着的对话框要有个归宿
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
  /** 导出前全篇补全（见 TranslationScheduler.translateAll）；没有调度器（论文未 ready / 无块）直接 aborted */
  translateAll: (opts?: TranslateAllOptions) => Promise<TranslateAllResult>
}

const EMPTY_SNAPSHOT: TranslationSnapshot = { texts: new Map(), failed: new Set(), authIssue: null }

/**
 * `paper-sync-pulled`（同步引擎补拉落库后派发）的 detail 过滤：只认「这篇论文 + 这张表」的补拉。
 * detail 缺失/字段畸形一律忽略——窗口事件是跨模块契约，别让一个坏消息把重读打成异常。
 */
export function isPulledFor(detail: unknown, paperId: string, table: SyncTable): boolean {
  if (!detail || typeof detail !== 'object') return false
  const { paperIds, tables } = detail as { paperIds?: unknown; tables?: unknown }
  if (!Array.isArray(paperIds) || !Array.isArray(tables)) return false
  return paperIds.includes(paperId) && tables.includes(table)
}

export function useTranslations(opts: {
  paper: PaperRecord | null
  blocks: PaperBlock[]
  langMode: LangMode
  currentBlockIndex: number
  /** 出包顺序：true = 当前块起往后在前（要有滚动锚定兜底），false = 文档顺序；缺省 true。变化不重建调度器 */
  aheadFirst?: boolean
}): UseTranslationsResult {
  const { paper, blocks, langMode, currentBlockIndex, aheadFirst = true } = opts
  const [snapshot, setSnapshot] = useState<TranslationSnapshot>(EMPTY_SNAPSHOT)
  const [consentAsk, setConsentAsk] = useState<((granted: boolean) => void) | null>(null)
  const schedulerRef = useRef<TranslationScheduler | null>(null)
  // 出包顺序放 ref：调度器每次重算时读最新值，视图切换（原貌 ↔ 文本）不必重建调度器、不丢在飞行的包
  const aheadFirstRef = useRef(aheadFirst)
  aheadFirstRef.current = aheadFirst

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
      aheadFirst: () => aheadFirstRef.current,
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

  // 跨设备同步：另一台设备译好的行被补拉进本地库后，引擎派 paper-sync-pulled；
  // Dexie 里已经是新真相，重读补进内存即可（PLAN 1.6 的客户端失效通知）
  const syncPaperId = paper?.id
  useEffect(() => {
    if (!syncPaperId) return
    const onPulled = (e: Event) => {
      if (isPulledFor((e as CustomEvent).detail, syncPaperId, 'translations')) void schedulerRef.current?.reload()
    }
    window.addEventListener('paper-sync-pulled', onPulled)
    return () => window.removeEventListener('paper-sync-pulled', onPulled)
  }, [syncPaperId])

  const retryBlock = useCallback((blockIndex: number) => {
    schedulerRef.current?.retryBlock(blockIndex)
  }, [])

  const translateAll = useCallback((opts?: TranslateAllOptions): Promise<TranslateAllResult> => {
    const scheduler = schedulerRef.current
    if (!scheduler) return Promise.resolve({ outcome: 'aborted', texts: new Map(), translated: 0, failed: [], total: 0 })
    return scheduler.translateAll(opts)
  }, [])

  return { texts: snapshot.texts, failed: snapshot.failed, authIssue: snapshot.authIssue, retryBlock, consentAsk, translateAll }
}
