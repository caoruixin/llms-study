import type { CopilotSeg } from './streamParser'

/**
 * 浏览器朗读封装（§9）：speechSynthesis 按完整句子排队。
 *
 * - 只读 prose 段的 text run：代码块、结构岛、citeToken 天然跳过（流协议已分好段）。
 * - 行内/独立公式替换为「公式」占位，不朗读 LaTeX 原文。
 * - 流式期间句子就绪即入队（takeCompleteSentences 只交出已终结的句子）；
 *   Stop 生成时 stop() 同时清空未读队列。
 * - 不生成、不上传、不保存音频；不支持时 isTtsSupported() 返回 false，UI 隐藏按钮。
 *
 * 句切与队列都是纯函数（reducer），node 环境直测；只有 player 触碰浏览器 API。
 */

export function isTtsSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined'
}

// ---------------------------------------------------------------------------
// 文本提取与句切（纯函数）
// ---------------------------------------------------------------------------

/** markdown 装饰与公式清理：朗读的是内容不是记号 */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/\$\$[\s\S]*?\$\$/g, ' 公式 ')
    .replace(/\$[^$\n]{1,200}\$/g, ' 公式 ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|~~)/g, '')
    .replace(/[ \t]+/g, ' ')
}

/** 从流协议分段中取可朗读文本：prose 的 text run（跳过 cite / code / island） */
export function speakableText(segs: readonly CopilotSeg[]): string {
  const parts: string[] = []
  for (const seg of segs) {
    if (seg.type !== 'prose') continue
    for (const run of seg.runs) {
      if (run.kind === 'text') parts.push(run.text)
    }
  }
  return cleanForSpeech(parts.join(''))
}

const TERMINATORS = new Set(['。', '！', '？', '；', '!', '?', ';', '\n'])
const CLOSERS = new Set(['”', '"', '’', "'", '）', ')', '」', '』', '】', '》', '…', '.', '!', '?', '。', '！', '？'])
const DIGIT_RE = /\d/

/** '.' 是否为句末：小数点、省略号中的点、单字母缩写后的点不算 */
function isSentenceDot(text: string, i: number): boolean {
  const prev = text[i - 1] ?? ''
  const next = text[i + 1] ?? ''
  if (DIGIT_RE.test(prev) && DIGIT_RE.test(next)) return false // 0.5
  if (next === '.' || prev === '.') return false // 省略号
  if (next !== '' && next !== ' ' && next !== '\n' && next !== '"' && next !== "'" && next !== ')') return false // e.g. v1.2b
  return true
}

/**
 * 从 fromIndex 起切出**已终结**的句子；未终结的尾巴留在缓冲里等下一个 delta。
 * flush=true（流结束）时把尾巴也作为一句交出。
 */
export function takeCompleteSentences(
  text: string,
  fromIndex: number,
  flush = false,
): { sentences: string[]; consumed: number } {
  const sentences: string[] = []
  let start = fromIndex
  let i = fromIndex
  while (i < text.length) {
    const ch = text[i]
    const isEnd = ch === '.' ? isSentenceDot(text, i) : TERMINATORS.has(ch)
    if (!isEnd) {
      i += 1
      continue
    }
    let end = i + 1
    while (end < text.length && CLOSERS.has(text[end])) end += 1 // 吸收收尾标点/引号
    const piece = text.slice(start, end).trim()
    if (piece !== '') sentences.push(piece)
    start = end
    i = end
  }
  if (flush) {
    const tail = text.slice(start).trim()
    if (tail !== '') sentences.push(tail)
    return { sentences, consumed: text.length }
  }
  return { sentences, consumed: start }
}

// ---------------------------------------------------------------------------
// 朗读队列 reducer（纯函数）
// ---------------------------------------------------------------------------

export type TtsStatus = 'idle' | 'speaking' | 'paused'

export interface TtsState {
  status: TtsStatus
  /** 待读队列 */
  queue: string[]
  /** 正在朗读的句子（null = 队列空，等更多流式内容） */
  current: string | null
  /**
   * current 的单调序号：播放器 effect 以它为依赖，
   * 连续两句内容相同也能各读一次（字符串相等不足以区分）。
   */
  seq: number
  /** 源文本已结束（流 finalize）：队列读完即回到 idle */
  sourceDone: boolean
}

export const initialTtsState: TtsState = { status: 'idle', queue: [], current: null, seq: 0, sourceDone: false }

export type TtsAction =
  | { type: 'enqueue'; sentences: readonly string[] }
  | { type: 'start' }
  | { type: 'ended' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'source-end' }
  | { type: 'stop' }

/** 队列状态机：UI/播放器只读它，播放器按 current 变化调用 speechSynthesis */
export function ttsReducer(state: TtsState, action: TtsAction): TtsState {
  switch (action.type) {
    case 'enqueue': {
      const queue = [...state.queue, ...action.sentences.filter((s) => s.trim() !== '')]
      // 正在朗读且当前空档 → 立刻补上一句
      if (state.status === 'speaking' && state.current === null && queue.length > 0) {
        return { ...state, queue: queue.slice(1), current: queue[0], seq: state.seq + 1 }
      }
      return { ...state, queue }
    }
    case 'start': {
      if (state.status === 'speaking') return state
      if (state.status === 'paused') return { ...state, status: 'speaking' }
      if (state.queue.length === 0) return { ...state, status: 'speaking' } // 等流式补句
      return { ...state, status: 'speaking', current: state.queue[0], queue: state.queue.slice(1), seq: state.seq + 1 }
    }
    case 'ended': {
      if (state.status !== 'speaking') return state
      if (state.queue.length > 0) {
        return { ...state, current: state.queue[0], queue: state.queue.slice(1), seq: state.seq + 1 }
      }
      return state.sourceDone ? { ...initialTtsState, seq: state.seq } : { ...state, current: null }
    }
    case 'pause':
      return state.status === 'speaking' ? { ...state, status: 'paused' } : state
    case 'resume':
      return state.status === 'paused' ? { ...state, status: 'speaking' } : state
    case 'source-end': {
      // 流结束且已读完 → 收工
      if (state.status === 'speaking' && state.current === null && state.queue.length === 0) {
        return { ...initialTtsState, seq: state.seq }
      }
      return { ...state, sourceDone: true }
    }
    case 'stop':
      return { ...initialTtsState, seq: state.seq } // 未读队列一并清空（§9）
  }
}

// ---------------------------------------------------------------------------
// 播放器（唯一触碰浏览器 API 的部分）
// ---------------------------------------------------------------------------

export interface TtsPlayer {
  speak(sentence: string, onEnd: () => void): void
  pause(): void
  resume(): void
  cancel(): void
}

/** 语言判定：含 CJK 用 zh-CN，否则 en-US（与 speech.ts 的 zh/en 二分一致） */
export function speechLang(text: string): 'zh-CN' | 'en-US' {
  return /[一-鿿]/.test(text) ? 'zh-CN' : 'en-US'
}

export function createTtsPlayer(): TtsPlayer {
  const synth = (): SpeechSynthesis | null => (isTtsSupported() ? window.speechSynthesis : null)
  return {
    speak(sentence, onEnd) {
      const s = synth()
      if (!s) {
        onEnd()
        return
      }
      const utter = new SpeechSynthesisUtterance(sentence)
      utter.lang = speechLang(sentence)
      utter.rate = 1
      utter.onend = () => onEnd()
      utter.onerror = () => onEnd() // 单句失败不卡死队列
      s.speak(utter)
    },
    pause() {
      synth()?.pause()
    },
    resume() {
      synth()?.resume()
    },
    cancel() {
      synth()?.cancel()
    },
  }
}
