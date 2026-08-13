import { describe, expect, it } from 'vitest'
import {
  cleanForSpeech,
  initialTtsState,
  speakableText,
  speechLang,
  takeCompleteSentences,
  ttsReducer,
  type TtsState,
} from './tts'
import { splitCopilotStream } from './streamParser'

describe('takeCompleteSentences · 句切', () => {
  it('中文句号/问号/叹号/分号切句，保留标点', () => {
    const { sentences } = takeCompleteSentences('第一句。第二句？第三句！第四句；', 0)
    expect(sentences).toEqual(['第一句。', '第二句？', '第三句！', '第四句；'])
  })
  it('英文句号 + 空格切句', () => {
    expect(takeCompleteSentences('First one. Second one! Third?', 0).sentences).toEqual([
      'First one.',
      'Second one!',
      'Third?',
    ])
  })
  it('小数点不切句', () => {
    const { sentences } = takeCompleteSentences('准确率是 0.85，比基线高 1.2 个点。', 0)
    expect(sentences).toEqual(['准确率是 0.85，比基线高 1.2 个点。'])
  })
  it('省略号不逐点切句', () => {
    expect(takeCompleteSentences('等一下...好了。', 0).sentences).toEqual(['等一下...好了。'])
  })
  it('换行也作为句子边界', () => {
    expect(takeCompleteSentences('标题行\n正文句子。', 0).sentences).toEqual(['标题行', '正文句子。'])
  })
  it('吸收句末引号/括号', () => {
    expect(takeCompleteSentences('他说：「就是这样。」下一句。', 0).sentences).toEqual([
      '他说：「就是这样。」',
      '下一句。',
    ])
  })
  it('未终结的尾巴不交出，consumed 停在最后一个完整句之后', () => {
    const r = takeCompleteSentences('完整句。半截还没', 0)
    expect(r.sentences).toEqual(['完整句。'])
    expect('完整句。半截还没'.slice(r.consumed)).toBe('半截还没')
  })
  it('流式续接：从 consumed 继续切，不重复朗读', () => {
    const first = takeCompleteSentences('第一句。第二句还没完', 0)
    const second = takeCompleteSentences('第一句。第二句完了。第三句', first.consumed)
    expect(second.sentences).toEqual(['第二句完了。'])
  })
  it('flush=true 时把未终结尾巴也交出', () => {
    const r = takeCompleteSentences('完整句。尾巴', 0, true)
    expect(r.sentences).toEqual(['完整句。', '尾巴'])
    expect(r.consumed).toBe('完整句。尾巴'.length)
  })
  it('空白与空字符串不产生句子', () => {
    expect(takeCompleteSentences('   \n  ', 0, true).sentences).toEqual([])
  })
})

describe('cleanForSpeech / speakableText', () => {
  it('公式替换为占位，不朗读 LaTeX 原文', () => {
    expect(cleanForSpeech('代价是 $O(n^2)$ 级别')).toContain('公式')
    expect(cleanForSpeech('代价是 $O(n^2)$ 级别')).not.toContain('O(n^2)')
    expect(cleanForSpeech('$$\\sum_i x_i$$')).not.toContain('sum')
  })
  it('markdown 记号被剥掉，链接只留文字', () => {
    expect(cleanForSpeech('## 标题\n- **要点**在这里\n[链接](http://x)')).toBe('标题\n要点在这里\n链接')
  })
  it('只朗读 prose 的文本 run：跳过代码块、结构岛与引用记号', () => {
    const src = [
      '这段讲 KV cache [[cite:c2]]。',
      '```copilot:formula',
      '{"expr":"2nL"}',
      '```',
      '```python',
      'print(1)',
      '```',
      '结尾一句。',
    ].join('\n')
    const text = speakableText(splitCopilotStream(src, { open: false }))
    expect(text).toContain('这段讲 KV cache')
    expect(text).toContain('结尾一句。')
    expect(text).not.toContain('expr')
    expect(text).not.toContain('print')
    expect(text).not.toContain('cite')
  })
})

describe('speechLang', () => {
  it('含中文用 zh-CN，纯英文用 en-US', () => {
    expect(speechLang('这是中文 with English')).toBe('zh-CN')
    expect(speechLang('pure english sentence.')).toBe('en-US')
  })
})

describe('ttsReducer · 朗读队列', () => {
  const withQueue = (over: Partial<TtsState> = {}): TtsState => ({ ...initialTtsState, ...over })

  it('start 从队列取第一句，其余留队', () => {
    const s = ttsReducer(withQueue({ queue: ['一。', '二。'] }), { type: 'start' })
    expect(s).toMatchObject({ status: 'speaking', current: '一。', queue: ['二。'] })
    expect(s.seq).toBe(1)
  })
  it('ended 依次取下一句，seq 单调递增', () => {
    let s = ttsReducer(withQueue({ queue: ['一。', '二。'] }), { type: 'start' })
    s = ttsReducer(s, { type: 'ended' })
    expect(s.current).toBe('二。')
    expect(s.seq).toBe(2)
  })
  it('队列读完但源未结束 → 保持 speaking 等待流式补句', () => {
    let s = ttsReducer(withQueue({ queue: ['一。'] }), { type: 'start' })
    s = ttsReducer(s, { type: 'ended' })
    expect(s).toMatchObject({ status: 'speaking', current: null, queue: [] })
  })
  it('speaking 且空档时 enqueue 立刻续上', () => {
    let s = ttsReducer(withQueue(), { type: 'start' })
    s = ttsReducer(s, { type: 'enqueue', sentences: ['新句。', '再一句。'] })
    expect(s).toMatchObject({ current: '新句。', queue: ['再一句。'] })
  })
  it('enqueue 过滤空白句', () => {
    const s = ttsReducer(withQueue(), { type: 'enqueue', sentences: ['  ', '有效。'] })
    expect(s.queue).toEqual(['有效。'])
  })
  it('source-end 后读完最后一句 → 回到 idle', () => {
    let s = ttsReducer(withQueue({ queue: ['一。'] }), { type: 'start' })
    s = ttsReducer(s, { type: 'source-end' })
    s = ttsReducer(s, { type: 'ended' })
    expect(s.status).toBe('idle')
    expect(s.current).toBeNull()
  })
  it('源已结束且当前已空 → source-end 立刻收工', () => {
    const s = ttsReducer(withQueue({ status: 'speaking' }), { type: 'source-end' })
    expect(s.status).toBe('idle')
  })
  it('pause / resume 只切状态，不动队列', () => {
    let s = ttsReducer(withQueue({ queue: ['一。', '二。'] }), { type: 'start' })
    s = ttsReducer(s, { type: 'pause' })
    expect(s).toMatchObject({ status: 'paused', current: '一。', queue: ['二。'] })
    s = ttsReducer(s, { type: 'resume' })
    expect(s.status).toBe('speaking')
  })
  it('idle 状态下 pause/resume/ended 都是空操作', () => {
    expect(ttsReducer(initialTtsState, { type: 'pause' })).toBe(initialTtsState)
    expect(ttsReducer(initialTtsState, { type: 'resume' })).toBe(initialTtsState)
    expect(ttsReducer(initialTtsState, { type: 'ended' })).toBe(initialTtsState)
  })
  it('stop 清空未读队列（Stop 生成时的语义）', () => {
    let s = ttsReducer(withQueue({ queue: ['一。', '二。', '三。'] }), { type: 'start' })
    s = ttsReducer(s, { type: 'stop' })
    expect(s).toMatchObject({ status: 'idle', queue: [], current: null, sourceDone: false })
  })
  it('paused 时 start 直接恢复播放', () => {
    let s = ttsReducer(withQueue({ queue: ['一。'] }), { type: 'start' })
    s = ttsReducer(s, { type: 'pause' })
    s = ttsReducer(s, { type: 'start' })
    expect(s).toMatchObject({ status: 'speaking', current: '一。' })
  })
})
