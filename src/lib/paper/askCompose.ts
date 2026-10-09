import {
  MAX_ASK_TEXT,
  PAPER_ASK_ACTIONS,
  type AskQuote,
  type PaperAskFire,
  type PendingAsk,
} from '../../pages/papers/paperUiStore'
import type { CopilotMessage } from './types'

/**
 * Copilot 选区动作 / 输入框引用的纯逻辑（node 可测；CopilotPanel 太大无法在 vitest node 下导入）：
 * 快捷动作模板、多段引用的组装与配额、落库消息还原成模型历史文本 / 重放轮次、chip 文案、队列取头、
 * 一轮结局（ok / failed / rejected）对队列的处置与被拒播报文案。
 */

/** 快捷动作的问题模板；task 与面板的 TurnTask 兼容（'chat' | 'deep' 是其子集） */
export interface AskTemplate {
  question: string
  task: 'chat' | 'deep'
}

const ASK_TEMPLATES: Record<PaperAskFire, AskTemplate> = {
  explain: { question: '请解释我选中的这段论文内容。', task: 'chat' },
  simpler: {
    question: '请用更简单的方式解释我选中的这段内容：假设我是入门读者，先给直觉和类比，再给必要术语。',
    task: 'chat',
  },
  derive: { question: '请逐步推导/拆解我选中的这段中的公式或方法：给出每一步的依据与每个符号的含义。', task: 'deep' },
  example: { question: '请举一个具体的例子帮助理解我选中的这段内容。', task: 'chat' },
}

export const askTemplate = (action: PaperAskFire): AskTemplate => ASK_TEMPLATES[action]

/** 由落库消息的动作小签反查快捷动作模板（重放旧轮次用）；「加入提问」/ 语音提问等非模板小签返回 null */
export function askTemplateByLabel(label: string | undefined): AskTemplate | null {
  if (!label) return null
  const hit = PAPER_ASK_ACTIONS.find((a) => a.label === label)
  return hit && hit.id !== 'queue' ? ASK_TEMPLATES[hit.id] : null
}

/** 选区来自应用内译文时注入 question 最前（用户不可见）：模型须回到英文原文语义作答 */
export const TRANSLATED_ASK_NOTE = '以下引用是应用内生成的中文译文，原文为英文，请以原文语义为准。'

/** 多段引用的分隔符；contextBuilder 据此切换引导语 */
export const QUOTE_SEPARATOR = '\n---\n'
/** 多段时每段的最低配额：再低就只剩半句话，不如少引几段 */
const MIN_QUOTE_QUOTA = 800
const TRUNCATED_MARK = '…（已截断）'
/** 历史 / 展示里每段引用的封顶（沿今天 displayText 的 600 字先例，token 不涨） */
const HISTORY_QUOTE_CHARS = 600

/** 落库消息里的引用形态（anchor 可缺：旧数据 / 导出场景） */
export type MessageQuote = NonNullable<CopilotMessage['quotes']>[number]

/**
 * 把 n 段引用拼成本轮 selection：1 段直接封顶；多段按条配额 `max(800, floor(4000/n))`，
 * 截断处标注，`---` 连接，最终再封顶 MAX_ASK_TEXT（contextBuilder 的 SELECTION_MAX_CHARS 同值，不改 builder 常量）。
 */
export function composeSelection(quotes: readonly { text: string }[]): string | null {
  const texts = quotes.map((q) => q.text).filter((t) => t.trim() !== '')
  if (texts.length === 0) return null
  if (texts.length === 1) return texts[0].slice(0, MAX_ASK_TEXT)
  const quota = Math.max(MIN_QUOTE_QUOTA, Math.floor(MAX_ASK_TEXT / texts.length))
  return texts
    .map((t) => (t.length > quota ? `${t.slice(0, quota)}${TRUNCATED_MARK}` : t))
    .join(QUOTE_SEPARATOR)
    .slice(0, MAX_ASK_TEXT)
}

export interface ComposedAskTurn {
  question: string
  selection: string | null
  quotes: MessageQuote[]
}

/** 组装一轮：任一引用来自译文则前置 TRANSLATED_ASK_NOTE；quotes 只保留落库需要的三个字段 */
export function composeAskTurn(quotes: readonly AskQuote[], question: string): ComposedAskTurn {
  const translated = quotes.some((q) => q.translated === true)
  return {
    question: translated ? `${TRANSLATED_ASK_NOTE}\n${question}` : question,
    selection: composeSelection(quotes),
    quotes: quotes.map((q) => ({ text: q.text, anchor: q.anchor, ...(q.translated ? { translated: true } : {}) })),
  }
}

/**
 * 给模型看的历史文本：无 quotes 的旧消息原样透传（引用已烤在 content 里）；
 * 有 quotes 时把引用重新拼回去——字节与改造前的 displayText 一致（快捷动作 `【label】\n"""…"""`，
 * 自由提问 `"""…"""\n问题`），不然模型在后续轮次看不到引用。
 */
export function historyTextOf(m: Pick<CopilotMessage, 'content'> & Partial<Pick<CopilotMessage, 'quotes' | 'actionLabel'>>): string {
  if (!m.quotes || m.quotes.length === 0) return m.content
  const quoted = m.quotes.map((q) => `"""\n${q.text.slice(0, HISTORY_QUOTE_CHARS)}\n"""`).join('\n')
  if (m.content) return `${quoted}\n${m.content}`
  return m.actionLabel ? `【${m.actionLabel}】\n${quoted}` : quoted
}

/** 只有引用、没有问题也查不到模板时的兜底问题（重发用；深度解释另传自己的） */
export const QUOTE_ONLY_QUESTION = '请解释我引用的这段内容。'

export interface ReplayTurn {
  /** 本轮 question（任一引用来自译文则已前置 TRANSLATED_ASK_NOTE） */
  question: string
  /** 不带译文提示的问题本身（检索查询用它，免得提示语稀释关键词） */
  bareQuestion: string
  selection: string | null
  /** 原样带上的引用（新消息的气泡照常出引用块）；旧消息为 undefined */
  quotes?: MessageQuote[]
  /** 问题是用户自己写的（不是模板 / 兜底）：只有这种才做抽象度启发式画像 */
  userAuthored: boolean
}

/**
 * 由落库的用户消息重建一轮（换一种深度解释、重发孤儿共用）：
 * 有 quotes → 引用走 selection（composeSelection 按条配额，与首发同口径），question 只放问题本身——
 * 快捷动作 content 为空就按小签反查模板问题，查不到用 fallback。不能像 historyTextOf 那样把引用拼进
 * question：多段引用会占满长度上限，后面的截断把真正的问题截掉。
 * 无 quotes 的旧消息 → 引用本就烤在 content 里，原样作 question、selection 为空（旧行为）。
 */
export function replayTurnOf(
  m: Pick<CopilotMessage, 'content'> & Partial<Pick<CopilotMessage, 'quotes' | 'actionLabel'>>,
  fallback: string = QUOTE_ONLY_QUESTION,
): ReplayTurn {
  if (!m.quotes || m.quotes.length === 0) {
    return { question: m.content, bareQuestion: m.content, selection: null, userAuthored: true }
  }
  const bare = m.content || askTemplateByLabel(m.actionLabel)?.question || fallback
  const translated = m.quotes.some((q) => q.translated === true)
  return {
    question: translated ? `${TRANSLATED_ASK_NOTE}\n${bare}` : bare,
    bareQuestion: bare,
    selection: composeSelection(m.quotes),
    quotes: m.quotes,
    userAuthored: m.content !== '',
  }
}

/** chip 上的一行摘要：压扁空白，超长截到 max 字并补省略号 */
export function chipText(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat
}

const NO_IDS: ReadonlySet<string> = new Set()

/**
 * 队列取头：本论文、尚未发起过（firedIds 幂等守卫）、也没被暂停冻结（heldIds）的第一条。
 * 暂停只冻结暂停那一刻已在队里的动作；之后新点的照常按序发起，不被旧的暂停卡住。
 */
export function nextQueuedAsk(
  pending: readonly PendingAsk[],
  paperId: string,
  firedIds: ReadonlySet<string>,
  heldIds: ReadonlySet<string> = NO_IDS,
): PendingAsk | null {
  return pending.find((a) => a.paperId === paperId && !firedIds.has(a.id) && !heldIds.has(a.id)) ?? null
}

// ---------------------------------------------------------------------------
// 一轮发起的结局 → 队列处置（面板 sendTurn 的返回值）
// ---------------------------------------------------------------------------

/** 被拒原因：not-ready 会话还在装载 / 已有轮次在飞（时机不对）；blocked 敏感论文 / 未授权（要用户表态） */
export type TurnRejectReason = 'not-ready' | 'blocked'

/**
 * ok 正常收尾（含用户 Stop 的半截）；failed 用户消息已落库、回答失败（成本确认被拒也在此：它发生在落库之后，
 * 气泡留着「重新发送」）；rejected 用户消息落库前就被挡下——什么都没写，调用方要把带走的动作 / 引用放回去。
 */
export type SendResult = { status: 'ok' | 'failed' } | { status: 'rejected'; reason: TurnRejectReason }

/** 结局是否暂停自动续发：出错 / 被拦截都等用户表态（免得把队列全砸在同一个错上）；未就绪只是时机不对，就绪后照常续发 */
export const shouldPauseQueue = (r: SendResult): boolean =>
  r.status === 'failed' || (r.status === 'rejected' && r.reason === 'blocked')

/** 快捷动作被拒后的 aria-live 播报（原因本身由错误行说明） */
export function rejectedAskNotice(label: string, reason: TurnRejectReason): string {
  return reason === 'not-ready'
    ? `「${label}」暂未发送：会话就绪后自动发送`
    : `「${label}」未发送，已留在排队中（点击芯片重试）`
}

/** 输入框发送被拒后的 aria-live 播报：问题回到输入框、引用回到 chip */
export function rejectedComposerNotice(reason: TurnRejectReason, quoteCount: number): string {
  const back = quoteCount > 0 ? `问题与 ${quoteCount} 段引用已放回` : '问题已放回输入框'
  return reason === 'not-ready' ? `会话尚未就绪，未发送：${back}` : `未发送：${back}`
}
