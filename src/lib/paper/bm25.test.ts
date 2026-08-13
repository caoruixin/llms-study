import { describe, expect, it } from 'vitest'
import {
  bm25Search,
  buildDoc,
  deserializeBm25Index,
  indexTexts,
  serializeBm25Index,
  stemLatin,
  tokenize,
} from './bm25'

describe('tokenize', () => {
  it('英文小写化并做轻量词干（复数归一）', () => {
    expect(tokenize('The Models are Trained')).toEqual(['the', 'model', 'are', 'trained'])
  })

  it('数字与单字母保留（公式里的 L、2024 都是有效检索项）', () => {
    expect(tokenize('L = 2024')).toEqual(['l', '2024'])
  })

  it('中文按词切分，并额外发射字符二元组', () => {
    const tokens = tokenize('注意力机制')
    expect(tokens).toContain('注意力')
    expect(tokens).toContain('机制')
    expect(tokens).toContain('注意')
    expect(tokens).toContain('力机')
  })

  it('中英混排：两种语言的词元同时产出', () => {
    const tokens = tokenize('KV cache 的显存占用')
    expect(tokens).toContain('kv')
    expect(tokens).toContain('cache')
    expect(tokens).toContain('显存')
  })

  it('全角与大小写经 NFKC 归一', () => {
    expect(tokenize('ＡＢＣ')).toEqual(['abc'])
  })

  it('空文本 → 空数组', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   ')).toEqual([])
  })
})

describe('stemLatin', () => {
  it('只归一复数，不碰 -ed/-ing，也不误伤 ss/us/is 结尾', () => {
    expect(stemLatin('models')).toBe('model')
    expect(stemLatin('policies')).toBe('policy')
    expect(stemLatin('batches')).toBe('batch')
    expect(stemLatin('trained')).toBe('trained')
    expect(stemLatin('loss')).toBe('loss')
    expect(stemLatin('bias')).toBe('bias')
    // us/is 结尾一律不动：宁可漏掉 gpus→gpu，也不能把 status 砍成 statu
    expect(stemLatin('status')).toBe('status')
  })
})

describe('bm25Search', () => {
  const corpus = [
    { id: 'a', text: 'KV cache memory grows linearly with context length in transformer inference' },
    { id: 'b', text: 'We train the model with a cosine learning rate schedule and warmup steps' },
    { id: 'c', text: 'Paged attention reduces KV cache fragmentation and improves throughput' },
    { id: 'd', text: 'The dataset contains one million documents collected from the web' },
  ]
  const index = indexTexts(corpus)

  it('相关文档排在前面', () => {
    const hits = bm25Search(index, 'KV cache memory')
    expect(hits[0].id).toBe('a')
    expect(hits.map((h) => h.id)).toContain('c')
    expect(hits.map((h) => h.id)).not.toContain('b')
  })

  it('返回命中词元，供片段高亮', () => {
    const hits = bm25Search(index, 'paged attention')
    expect(hits[0].id).toBe('c')
    expect(hits[0].matched.sort()).toEqual(['attention', 'paged'])
  })

  it('词干化让 models 命中 model', () => {
    const hits = bm25Search(index, 'models')
    expect(hits[0].id).toBe('b')
  })

  it('无命中 / 空查询 / 空索引 → 空结果', () => {
    expect(bm25Search(index, 'quantum entanglement')).toEqual([])
    expect(bm25Search(index, '')).toEqual([])
    expect(bm25Search(indexTexts([]), 'anything')).toEqual([])
  })

  it('topK 截断', () => {
    expect(bm25Search(index, 'the', { topK: 2 })).toHaveLength(2)
  })

  it('中文：二元组让「显存」区分开「显示存储」', () => {
    const zh = indexTexts([
      { id: 'x', text: '显存占用随上下文长度线性增长' },
      { id: 'y', text: '显示存储设备的容量与带宽' },
    ])
    const hits = bm25Search(zh, '显存')
    expect(hits[0].id).toBe('x')
    expect(hits[0].score).toBeGreaterThan(hits[1]?.score ?? 0)
  })

  it('结果确定：同一输入多次查询完全一致（含同分平局）', () => {
    const tie = indexTexts([
      { id: 'd2', text: 'alpha beta' },
      { id: 'd1', text: 'alpha beta' },
    ])
    const first = bm25Search(tie, 'alpha')
    const second = bm25Search(tie, 'alpha')
    expect(first).toEqual(second)
    // 同分按入库序号，与 id 字典序无关
    expect(first.map((h) => h.id)).toEqual(['d2', 'd1'])
  })

  it('boost 可按文档加权（当前阅读章节倾斜）', () => {
    const plain = bm25Search(index, 'cache')
    const boosted = bm25Search(index, 'cache', { boost: (id) => (id === 'a' ? 5 : 1) })
    expect(plain[0].id).toBe('c') // 同样命中 "cache" 时短文档占优
    expect(boosted[0].id).toBe('a')
  })

  it('长文档不因词多而天然占优（b 参数生效）', () => {
    const idx = indexTexts([
      { id: 'short', text: 'attention mechanism' },
      { id: 'long', text: `attention mechanism ${'filler words here '.repeat(50)}` },
    ])
    const hits = bm25Search(idx, 'attention mechanism')
    expect(hits[0].id).toBe('short')
  })
})

describe('序列化', () => {
  it('往返后查询结果完全一致', () => {
    const index = indexTexts([
      { id: 'a', text: 'transformer attention is all you need' },
      { id: 'b', text: '中文论文的注意力机制章节' },
    ])
    const restored = deserializeBm25Index(JSON.parse(JSON.stringify(serializeBm25Index(index))))
    expect(restored.n).toBe(index.n)
    expect(restored.avgdl).toBe(index.avgdl)
    expect(bm25Search(restored, 'attention')).toEqual(bm25Search(index, 'attention'))
    expect(bm25Search(restored, '注意力')).toEqual(bm25Search(index, '注意力'))
  })

  it('坏数据宽容处理：跳过坏行而不是整篇索引作废', () => {
    const good = buildDoc('ok', 'hello world')
    const idx = deserializeBm25Index({
      v: 1,
      docs: [null, { id: 42 }, { id: 'bad', tf: null }, { id: 'neg', tf: { a: -1 } }, good],
    })
    expect(idx.n).toBe(2)
    expect(bm25Search(idx, 'hello')[0].id).toBe('ok')
  })

  it('完全不认识的输入 → 空索引而不是抛错', () => {
    expect(deserializeBm25Index(undefined).n).toBe(0)
    expect(deserializeBm25Index({ nope: true }).n).toBe(0)
  })
})
