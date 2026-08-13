import { describe, expect, it } from 'vitest'
import { auditCitations, lexicalSupportScore, sentenceAt, WEAK_SUPPORT_THRESHOLD } from './citations'
import { splitCopilotStream } from './streamParser'
import type { CiteMapEntry } from './retrieval'

const entry = (alias: string): CiteMapEntry => ({
  alias,
  chunkId: `chunk-${alias}`,
  anchor: { kind: 'pdf', blockIndex: 3, page: 7, section: '4.2 Method' },
  page: 7,
  section: '4.2 Method',
})

describe('sentenceAt', () => {
  it('中英句界切分', () => {
    const text = '第一句。第二句包含要点。第三句！'
    expect(sentenceAt(text, text.indexOf('要点'))).toBe('第二句包含要点。')
  })
  it('无句界时取全文', () => {
    expect(sentenceAt('只有一句没有标点', 3)).toBe('只有一句没有标点')
  })
})

describe('lexicalSupportScore', () => {
  it('词面高重叠 → 高分；无关句 → 低分', () => {
    const chunk = 'KV cache 的显存占用随上下文长度线性增长，实验显示 32K 上下文占用 5GB。'
    expect(lexicalSupportScore('KV cache 显存占用随上下文长度线性增长', chunk)).toBeGreaterThan(WEAK_SUPPORT_THRESHOLD)
    expect(lexicalSupportScore('宇宙飞船降落在火星表面完成了采样任务', chunk)).toBeLessThan(WEAK_SUPPORT_THRESHOLD)
  })
  it('数字命中双倍计权', () => {
    const chunk = '实验在 32768 长度下测得吞吐 210 tokens/s。'
    const withNum = lexicalSupportScore('吞吐为 210', chunk)
    const wrongNum = lexicalSupportScore('吞吐为 999', chunk)
    expect(withNum).toBeGreaterThan(wrongNum)
  })
  it('句内无内容词 → 1（不惩罚）', () => {
    expect(lexicalSupportScore('！？', '任意')).toBe(1)
  })
})

describe('auditCitations', () => {
  const citeMap = [entry('c1'), entry('c2')]
  const chunks = {
    c1: 'KV cache 的显存占用随上下文长度线性增长。',
    c2: '论文在 §3.2 给出了详细的测量方法与结果。',
  }

  it('存在性 + 词面支持：支持句 ok，幻觉 ID missing', () => {
    const segs = splitCopilotStream('KV cache 显存占用随上下文长度线性增长 [[cite:c1]]。这是编造的引用 [[cite:c9]]。')
    const audit = auditCitations(segs, citeMap, chunks)
    expect(audit.badges.c1).toBe('ok')
    expect(audit.badges.c9).toBe('missing')
    expect(audit.missingCount).toBe(1)
  })

  it('词面不支持 → weak（只降展示不删句）', () => {
    const segs = splitCopilotStream('火星采样任务圆满完成并返回地球 [[cite:c1]]。')
    const audit = auditCitations(segs, citeMap, chunks)
    expect(audit.badges.c1).toBe('weak')
    expect(audit.weakCount).toBe(1)
    // 原句仍在 prose 段中
    expect(segs[0].type === 'prose' && segs[0].text).toContain('火星采样任务')
  })

  it('岛内 cites：只做存在性（词面不适用于结构数据）', () => {
    const segs = splitCopilotStream('```copilot:formula\n{"expr":"2nL","cites":["c2","c8"]}\n```')
    const audit = auditCitations(segs, citeMap, chunks)
    expect(audit.badges.c2).toBe('ok')
    expect(audit.badges.c8).toBe('missing')
  })

  it('同一 alias 多处出现取最差档', () => {
    const segs = splitCopilotStream(
      'KV cache 显存占用随上下文长度线性增长 [[cite:c1]]。银河系旋臂结构与恒星形成率 [[cite:c1]]。',
    )
    const audit = auditCitations(segs, citeMap, chunks)
    expect(audit.badges.c1).toBe('weak')
  })

  it('无引用 → 空审计', () => {
    const audit = auditCitations(splitCopilotStream('没有引用的普通句子。'), citeMap, chunks)
    expect(audit.occurrences).toHaveLength(0)
    expect(audit.missingCount).toBe(0)
  })
})
