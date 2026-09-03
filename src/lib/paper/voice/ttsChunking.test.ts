import { describe, expect, it } from 'vitest'
import { groupSentencesForTts, stripTtsMarkers, TTS_MAX_GROUP_CHARS, TTS_MIN_GROUP_CHARS } from './ttsChunking'

const sentence = (n: number, mark = '。') => '字'.repeat(n - 1) + mark

describe('groupSentencesForTts · 首句压 TTFA', () => {
  it('isFirst 时第一句单独成组，哪怕只有几个字', () => {
    const groups = groupSentencesForTts(['好的。', sentence(80), sentence(80)], { isFirst: true })
    expect(groups[0]).toBe('好的。')
    expect(groups.length).toBeGreaterThan(1)
  })

  it('isFirst=false 时不再单放，直接参与合并', () => {
    const groups = groupSentencesForTts(['好的。', '再说一句。', '第三句。'], { isFirst: false })
    expect(groups).toHaveLength(1)
    expect(groups[0]).toBe('好的。再说一句。第三句。')
  })
})

describe('groupSentencesForTts · 合并与上限', () => {
  it('攒到 ≥minChars 才发一组（压调用数）', () => {
    const groups = groupSentencesForTts(Array.from({ length: 10 }, () => sentence(20)), { isFirst: false })
    for (const g of groups.slice(0, -1)) expect(g.length).toBeGreaterThanOrEqual(TTS_MIN_GROUP_CHARS)
  })

  it('句子用完时最后一组允许不足 minChars', () => {
    const groups = groupSentencesForTts([sentence(70), sentence(10)], { isFirst: false })
    expect(groups).toHaveLength(2)
    expect(groups[1].length).toBeLessThan(TTS_MIN_GROUP_CHARS)
  })

  it('绝不超过 maxChars（除非单句本身超长）', () => {
    const groups = groupSentencesForTts(Array.from({ length: 20 }, () => sentence(50)), { isFirst: false })
    for (const g of groups) expect(g.length).toBeLessThanOrEqual(TTS_MAX_GROUP_CHARS)
  })

  it('单句超长时自己独占一组，不切开句子', () => {
    const long = sentence(500)
    const groups = groupSentencesForTts([long, sentence(30)], { isFirst: false })
    expect(groups[0]).toBe(long)
    expect(groups).toContain(long)
  })

  it('切分前后文本无损（拼起来等于原文）', () => {
    const sentences = ['第一句。', '第二句很长'.repeat(8) + '。', '第三句。', '第四句结束。']
    const joined = groupSentencesForTts(sentences, { isFirst: true }).join('')
    for (const s of sentences) expect(joined).toContain(s)
  })

  it('中文句末直接拼接，英文句末补空格', () => {
    expect(groupSentencesForTts(['一句。', '两句。'], { isFirst: false })[0]).toBe('一句。两句。')
    expect(groupSentencesForTts(['First one.', 'Second one.'], { isFirst: false })[0]).toBe('First one. Second one.')
  })

  it('空白句被丢弃；全空输入返回空数组', () => {
    expect(groupSentencesForTts(['  ', '\n', '有效。'], { isFirst: true })).toEqual(['有效。'])
    expect(groupSentencesForTts([], { isFirst: true })).toEqual([])
    expect(groupSentencesForTts(['   '], { isFirst: false })).toEqual([])
  })

  it('阈值可注入（便于按供应商调参）', () => {
    const groups = groupSentencesForTts(['甲。', '乙。', '丙。'], { isFirst: false, minChars: 4, maxChars: 8 })
    expect(groups).toEqual(['甲。乙。', '丙。'])
  })
})

describe('stripTtsMarkers', () => {
  it('剥掉 <|...|> 特殊标记', () => {
    expect(stripTtsMarkers('先说结论<|endofprompt|>再展开。')).toBe('先说结论 再展开。')
    expect(stripTtsMarkers('<|im_start|>你好<|im_end|>')).toBe('你好')
  })

  it('多个标记与跨行标记都能剥', () => {
    expect(stripTtsMarkers('<|a|>甲<|b|>乙<|c|>')).toBe('甲 乙')
    expect(stripTtsMarkers('甲<|多\n行|>乙')).toBe('甲 乙')
  })

  it('普通文本原样保留（含尖括号与竖线的正常写法）', () => {
    expect(stripTtsMarkers('准确率 85%，比基线高 1.2 个点。')).toBe('准确率 85%，比基线高 1.2 个点。')
    expect(stripTtsMarkers('a < b 且 c | d')).toBe('a < b 且 c | d')
  })
})
