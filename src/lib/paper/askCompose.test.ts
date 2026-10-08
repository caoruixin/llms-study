import { describe, expect, it } from 'vitest'
import {
  askTemplate,
  askTemplateByLabel,
  chipText,
  composeAskTurn,
  composeSelection,
  historyTextOf,
  nextQueuedAsk,
  QUOTE_ONLY_QUESTION,
  QUOTE_SEPARATOR,
  rejectedAskNotice,
  rejectedComposerNotice,
  replayTurnOf,
  shouldPauseQueue,
  TRANSLATED_ASK_NOTE,
} from './askCompose'
import { MAX_ASK_TEXT, type AskQuote, type PendingAsk } from '../../pages/papers/paperUiStore'
import type { SourceAnchor } from './types'

const anchor: SourceAnchor = { kind: 'pdf', blockIndex: 3, page: 7, section: '4.2 Method' }
const quote = (text: string, translated?: boolean): AskQuote => ({ text, anchor, ...(translated ? { translated } : {}) })
const ask = (id: string, paperId = 'p1'): PendingAsk => ({
  id,
  paperId,
  action: 'explain',
  label: '解释这段',
  text: `t-${id}`,
  anchor,
  at: 0,
})

describe('askTemplate', () => {
  it('推导走 deep 档，其余 chat', () => {
    expect(askTemplate('derive').task).toBe('deep')
    for (const a of ['explain', 'simpler', 'example'] as const) expect(askTemplate(a).task).toBe('chat')
    expect(askTemplate('explain').question).toContain('解释')
  })
})

describe('composeSelection · 配额与连接', () => {
  it('空 / 全空白 → null', () => {
    expect(composeSelection([])).toBeNull()
    expect(composeSelection([quote('   '), quote('\n')])).toBeNull()
  })

  it('单段只封顶 MAX_ASK_TEXT，不加截断标', () => {
    expect(composeSelection([quote('abc')])).toBe('abc')
    const out = composeSelection([quote('x'.repeat(MAX_ASK_TEXT + 50))])
    expect(out).toHaveLength(MAX_ASK_TEXT)
    expect(out).not.toContain('已截断')
  })

  it('多段按 max(800, floor(4000/n)) 配额截断、标注并以 --- 连接', () => {
    const out = composeSelection([quote('a'.repeat(3000)), quote('b'.repeat(100))])!
    const parts = out.split(QUOTE_SEPARATOR)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toBe(`${'a'.repeat(2000)}…（已截断）`)
    expect(parts[1]).toBe('b'.repeat(100))
  })

  it('段数多到配额低于 800 时按 800 保底，整体再封顶 4000', () => {
    const six = Array.from({ length: 6 }, (_, i) => quote(String.fromCharCode(97 + i).repeat(1000)))
    const out = composeSelection(six)!
    expect(out.length).toBeLessThanOrEqual(MAX_ASK_TEXT)
    // 第一段拿到 800 配额（floor(4000/6)=666 < 800）
    expect(out.startsWith(`${'a'.repeat(800)}…（已截断）${QUOTE_SEPARATOR}`)).toBe(true)
  })

  it('空白段被剔除后只剩一段 → 按单段处理', () => {
    expect(composeSelection([quote(''), quote('only')])).toBe('only')
  })
})

describe('composeAskTurn', () => {
  it('无译文引用：问题原样，quotes 只保留 text/anchor', () => {
    const t = composeAskTurn([quote('seg')], 'Q?')
    expect(t.question).toBe('Q?')
    expect(t.selection).toBe('seg')
    expect(t.quotes).toEqual([{ text: 'seg', anchor }])
  })

  it('任一引用来自译文 → 前置 TRANSLATED_ASK_NOTE，并在 quotes 上保留 translated', () => {
    const t = composeAskTurn([quote('a'), quote('b', true)], 'Q?')
    expect(t.question).toBe(`${TRANSLATED_ASK_NOTE}\nQ?`)
    expect(t.quotes[1]).toEqual({ text: 'b', anchor, translated: true })
    expect(t.quotes[0]).not.toHaveProperty('translated')
  })

  it('没有引用：selection 为 null、quotes 为空数组', () => {
    expect(composeAskTurn([], 'Q?')).toEqual({ question: 'Q?', selection: null, quotes: [] })
  })
})

describe('historyTextOf · 与改造前的历史字节一致', () => {
  it('无 quotes 的旧消息原样透传（引用已烤在 content 里）', () => {
    const legacy = '"""\nold\n"""\n问题'
    expect(historyTextOf({ content: legacy })).toBe(legacy)
    expect(historyTextOf({ content: 'plain', quotes: [] })).toBe('plain')
  })

  it('快捷动作（content 空 + actionLabel）= 【label】 + 引用块，与今天 consumeAsk 的 displayText 一致', () => {
    const sel = 's'.repeat(700)
    expect(historyTextOf({ content: '', actionLabel: '解释这段', quotes: [{ text: sel }] })).toBe(
      `【解释这段】\n"""\n${sel.slice(0, 600)}\n"""`,
    )
  })

  it('自由提问（content 非空）= 引用块 + 换行 + 问题，与今天 sendFree 的 displayText 一致', () => {
    expect(historyTextOf({ content: '为什么？', quotes: [{ text: 'sel' }] })).toBe('"""\nsel\n"""\n为什么？')
  })

  it('多段引用逐段封顶 600 字、换行相连；无 label 无 content 时只有引用块', () => {
    const out = historyTextOf({ content: '', quotes: [{ text: 'a'.repeat(900) }, { text: 'b' }] })
    expect(out).toBe(`"""\n${'a'.repeat(600)}\n"""\n"""\nb\n"""`)
  })
})

describe('chipText', () => {
  it('压扁空白并截到 40 字补省略号', () => {
    expect(chipText('  a  b\n\nc ')).toBe('a b c')
    const long = 'x'.repeat(60)
    expect(chipText(long)).toBe(`${'x'.repeat(39)}…`)
    expect(chipText('x'.repeat(40))).toBe('x'.repeat(40))
    expect(chipText('abcdef', 3)).toBe('ab…')
  })
})

describe('nextQueuedAsk', () => {
  it('取本论文第一条未发起的；别的论文与已发起的跳过', () => {
    const pending = [ask('x', 'p2'), ask('a'), ask('b')]
    expect(nextQueuedAsk(pending, 'p1', new Set())?.id).toBe('a')
    expect(nextQueuedAsk(pending, 'p1', new Set(['a']))?.id).toBe('b')
    expect(nextQueuedAsk(pending, 'p1', new Set(['a', 'b']))).toBeNull()
    expect(nextQueuedAsk(pending, 'p3', new Set())).toBeNull()
  })
})

describe('nextQueuedAsk · 暂停冻结', () => {
  it('heldIds 里的跳过（暂停那一刻已在队里的），之后新来的照常取到；不传 heldIds 等于不冻结', () => {
    const pending = [ask('a'), ask('b'), ask('c')]
    expect(nextQueuedAsk(pending, 'p1', new Set(), new Set(['a', 'b']))?.id).toBe('c')
    expect(nextQueuedAsk(pending, 'p1', new Set(['c']), new Set(['a', 'b']))).toBeNull()
    expect(nextQueuedAsk(pending, 'p1', new Set())?.id).toBe('a')
  })
})

describe('askTemplateByLabel', () => {
  it('快捷动作小签反查模板；加入提问 / 语音提问 / 空 → null', () => {
    expect(askTemplateByLabel('推导公式')).toEqual(askTemplate('derive'))
    expect(askTemplateByLabel('解释这段')?.question).toBe(askTemplate('explain').question)
    expect(askTemplateByLabel('加入提问')).toBeNull()
    expect(askTemplateByLabel('语音提问')).toBeNull()
    expect(askTemplateByLabel(undefined)).toBeNull()
  })
})

describe('replayTurnOf · 重发 / 深度解释的重建', () => {
  it('无 quotes 的旧消息：content 原样作问题、无 selection、算用户所写（旧行为）', () => {
    const legacy = '【解释这段】\n"""\nold\n"""'
    expect(replayTurnOf({ content: legacy, actionLabel: '解释这段' })).toEqual({
      question: legacy,
      bareQuestion: legacy,
      selection: null,
      userAuthored: true,
    })
  })

  it('快捷动作（content 空）：按小签还原模板问题，引用走 selection，不算用户所写', () => {
    const quotes = [{ text: 'sel', anchor }]
    const t = replayTurnOf({ content: '', actionLabel: '推导公式', quotes })
    expect(t.question).toBe(askTemplate('derive').question)
    expect(t.selection).toBe('sel')
    expect(t.quotes).toBe(quotes)
    expect(t.userAuthored).toBe(false)
  })

  it('多段长引用不挤掉问题：问题完整保留，引用按条配额进 selection', () => {
    const quotes = Array.from({ length: 5 }, (_, i) => ({ text: String(i).repeat(1200) }))
    const t = replayTurnOf({ content: '这里的 KV cache 为什么能复用？', quotes })
    expect(t.question).toBe('这里的 KV cache 为什么能复用？')
    expect(t.userAuthored).toBe(true)
    expect(t.selection).toBe(composeSelection(quotes))
    expect(t.selection!.split(QUOTE_SEPARATOR)).toHaveLength(5)
  })

  it('查不到模板且没有问题 → fallback（默认 QUOTE_ONLY_QUESTION）；译文引用前置提示，bareQuestion 不带', () => {
    const quotes = [{ text: '译文段', translated: true }]
    expect(replayTurnOf({ content: '', quotes }).bareQuestion).toBe(QUOTE_ONLY_QUESTION)
    const t = replayTurnOf({ content: '', actionLabel: '加入提问', quotes }, '请就我引用的内容给出更深入的解释')
    expect(t.bareQuestion).toBe('请就我引用的内容给出更深入的解释')
    expect(t.question).toBe(`${TRANSLATED_ASK_NOTE}\n请就我引用的内容给出更深入的解释`)
  })
})

describe('一轮结局 → 队列处置', () => {
  it('failed / 被拦截暂停自动续发；ok 与未就绪不暂停', () => {
    expect(shouldPauseQueue({ status: 'ok' })).toBe(false)
    expect(shouldPauseQueue({ status: 'failed' })).toBe(true)
    expect(shouldPauseQueue({ status: 'rejected', reason: 'blocked' })).toBe(true)
    expect(shouldPauseQueue({ status: 'rejected', reason: 'not-ready' })).toBe(false)
  })

  it('被拒播报文案（QA 按原文核对）', () => {
    expect(rejectedAskNotice('解释这段', 'not-ready')).toBe('「解释这段」暂未发送：会话就绪后自动发送')
    expect(rejectedAskNotice('更简单', 'blocked')).toBe('「更简单」未发送，已留在排队中（点击芯片重试）')
    expect(rejectedComposerNotice('blocked', 2)).toBe('未发送：问题与 2 段引用已放回')
    expect(rejectedComposerNotice('blocked', 0)).toBe('未发送：问题已放回输入框')
    expect(rejectedComposerNotice('not-ready', 0)).toBe('会话尚未就绪，未发送：问题已放回输入框')
  })
})
