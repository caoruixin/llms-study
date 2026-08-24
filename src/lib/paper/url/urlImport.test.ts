import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { type ParseResult } from '../ingest'
import { PaperDb } from '../repo/db'
import { createPaperRepository } from '../repo/paperRepo'
import { sha256Hex } from '../validate'
import { parseUrlBundleBytes } from './urlBundle'
import { importFromUrls, type FetchedUrlResult, type UrlImportDeps, type UrlProgressEvent } from './urlImport'

function freshRepo() {
  const db = new PaperDb(`t-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange })
  return createPaperRepository(db)
}

const textBytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer
const pdfBytes = (payload = 'hello'): ArrayBuffer => textBytes(`%PDF-1.7\n${payload}`)

/** parseByFormat 的测试替身：html 走真实 parseUrlBundleBytes（覆盖全链路），pdf 走假实现 */
const parseByFormat = async (input: { bytes: ArrayBuffer; format: 'pdf' | 'docx' | 'html' }): Promise<ParseResult> => {
  if (input.format === 'html') return parseUrlBundleBytes(input.bytes)
  if (input.format === 'pdf') return { blocks: [{ index: 0, kind: 'paragraph', text: 'PDF 正文', anchor: { kind: 'pdf', blockIndex: 0, page: 1 } }], pageCount: 1, title: 'PDF 标题' }
  throw new Error('unexpected format in test')
}

interface FakeUrlResult {
  html?: string
  title?: string
  pdf?: boolean
  finalUrl?: string
  fetchError?: string
  extractError?: string
}

/** 逐 URL 配置的假抓取 + 假抽取：按传入的 url → FakeUrlResult 映射驱动 */
function makeDeps(
  repo: ReturnType<typeof freshRepo>,
  byUrl: Record<string, FakeUrlResult>,
): UrlImportDeps {
  const fetchUrl = async (url: string): Promise<FetchedUrlResult> => {
    const cfg = byUrl[url]
    if (!cfg) throw new Error(`no fake config for ${url}`)
    if (cfg.fetchError) throw new Error(cfg.fetchError)
    if (cfg.pdf) {
      return { bytes: pdfBytes(url), contentType: 'application/pdf', finalUrl: cfg.finalUrl ?? url }
    }
    return { bytes: textBytes(cfg.html ?? '<p>x</p>'), contentType: 'text/html; charset=utf-8', finalUrl: cfg.finalUrl ?? url }
  }
  const extract = async (input: { url: string }) => {
    const cfg = byUrl[input.url]
    if (cfg?.extractError) throw new Error(cfg.extractError)
    return { title: cfg?.title ?? 'Untitled', html: cfg?.html ?? '<p>x</p>' }
  }
  return { repo, hash: sha256Hex, parse: parseByFormat, fetchUrl, extract }
}

describe('importFromUrls', () => {
  it('全成功：落库 + source.entries 全 ok + 多节合并出的标题下压', async () => {
    const repo = freshRepo()
    const urls = ['https://docs.a.com/intro', 'https://docs.a.com/detail']
    const deps = makeDeps(repo, {
      [urls[0]]: { title: '总览', html: '<h1>总览</h1><p>第一节正文</p>' },
      [urls[1]]: { title: '细节', html: '<h1>细节</h1><p>第二节正文</p>' },
    })
    const progress: UrlProgressEvent[] = []
    const outcome = await importFromUrls(urls, deps, (ev) => progress.push(ev))

    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    expect(outcome.paper.format).toBe('html')
    expect(outcome.paper.source?.entries).toHaveLength(2)
    expect(outcome.paper.source?.entries.every((e) => e.ok)).toBe(true)
    expect(outcome.paper.source?.entries.map((e) => e.url)).toEqual(urls)
    expect(outcome.paper.title).toBe('总览') // 首节标题

    const blocks = await repo.getBlocks(outcome.paper.id)
    // 多节合并：每节合成 level-1 heading，原 h1 下压一级且与节 title 同名被去重
    expect(blocks.map((b) => [b.kind, b.level, b.text])).toEqual([
      ['heading', 1, '总览'],
      ['paragraph', undefined, '第一节正文'],
      ['heading', 1, '细节'],
      ['paragraph', undefined, '第二节正文'],
    ])

    // 进度回调覆盖了 pending → fetching → extracting → done 的完整阶梯
    const phasesForFirst = progress.filter((p) => p.url === urls[0]).map((p) => p.phase)
    expect(phasesForFirst).toEqual(['pending', 'fetching', 'extracting', 'done'])
  })

  it('部分失败：≥1 成功即落库为 ready，失败条目记录在 source.entries', async () => {
    const repo = freshRepo()
    const urls = ['https://a.com/ok1', 'https://a.com/bad', 'https://a.com/ok2']
    const deps = makeDeps(repo, {
      [urls[0]]: { title: 'OK1', html: '<h1>OK1</h1><p>正文一</p>' },
      [urls[1]]: { fetchError: '连接超时' },
      [urls[2]]: { title: 'OK2', html: '<h1>OK2</h1><p>正文二</p>' },
    })
    const outcome = await importFromUrls(urls, deps)

    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    const entries = outcome.paper.source?.entries ?? []
    expect(entries).toHaveLength(3)
    expect(entries.find((e) => e.url === urls[1])).toMatchObject({ ok: false, error: '连接超时' })
    expect(entries.filter((e) => e.ok)).toHaveLength(2)

    const blocks = await repo.getBlocks(outcome.paper.id)
    // 失败的那一条不参与正文合并：只有两节被规范化
    expect(blocks.filter((b) => b.kind === 'heading').map((b) => b.text)).toEqual(['OK1', 'OK2'])
  })

  it('全部失败：不落库，返回 failed 且不产生任何论文记录', async () => {
    const repo = freshRepo()
    const urls = ['https://a.com/x', 'https://a.com/y']
    const deps = makeDeps(repo, {
      [urls[0]]: { fetchError: '网络错误' },
      [urls[1]]: { extractError: '页面依赖脚本渲染，无法抓取正文' },
    })
    const outcome = await importFromUrls(urls, deps)

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.paper).toBeUndefined()
    expect(await repo.listPapers()).toHaveLength(0)
  })

  it('批量导入中混入 PDF 直链：该条判失败「PDF 直链请单独导入」，其余 URL 正常合并', async () => {
    const repo = freshRepo()
    const urls = ['https://a.com/report.pdf', 'https://a.com/page']
    const deps = makeDeps(repo, {
      [urls[0]]: { pdf: true },
      [urls[1]]: { title: '页面', html: '<h1>页面</h1><p>正文</p>' },
    })
    const outcome = await importFromUrls(urls, deps)

    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    expect(outcome.paper.format).toBe('html') // 整体仍是 HTML 合集，PDF 那条被跳过
    const pdfEntry = outcome.paper.source?.entries.find((e) => e.url === urls[0])
    expect(pdfEntry).toMatchObject({ ok: false, error: 'PDF 直链请单独导入' })
    const okEntry = outcome.paper.source?.entries.find((e) => e.url === urls[1])
    expect(okEntry?.ok).toBe(true)
  })

  it('单 URL 直链 PDF：转投 importPaper，走 pdf 格式而不是 html 合集，且补写 source', async () => {
    const repo = freshRepo()
    const urls = ['https://a.com/whitepaper.pdf']
    const deps = makeDeps(repo, { [urls[0]]: { pdf: true, finalUrl: 'https://a.com/final/whitepaper.pdf' } })
    const outcome = await importFromUrls(urls, deps)

    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    expect(outcome.paper.format).toBe('pdf')
    expect(outcome.paper.mime).toBe('application/pdf')
    expect(outcome.paper.source?.entries).toEqual([
      expect.objectContaining({ url: urls[0], finalUrl: 'https://a.com/final/whitepaper.pdf', ok: true }),
    ])
    // 走的是真正的 PDF 解析管线（parseByFormat 的 pdf 分支），不是 normalizeHtmlSections
    const blocks = await repo.getBlocks(outcome.paper.id)
    expect(blocks.map((b) => b.text)).toEqual(['PDF 正文'])
  })

  it('去重命中：同样内容的 URL 导入两次，第二次返回 duplicate 不产生第二条记录', async () => {
    const repo = freshRepo()
    const urls = ['https://a.com/same-page']
    const deps = makeDeps(repo, { [urls[0]]: { title: '页面', html: '<h1>页面</h1><p>不变的正文</p>' } })

    const first = await importFromUrls(urls, deps)
    expect(first.kind).toBe('ready')

    const second = await importFromUrls(urls, deps)
    expect(second.kind).toBe('duplicate')
    expect(await repo.listPapers()).toHaveLength(1)
  })

  it('抽取正文超过字符上限：落库为 failed（status=failed），而不是静默丢弃', async () => {
    const repo = freshRepo()
    const urls = ['https://a.com/huge']
    const huge = 'x'.repeat(2_000_001)
    const deps = makeDeps(repo, { [urls[0]]: { title: '巨大页面', html: `<p>${huge}</p>` } })

    const outcome = await importFromUrls(urls, deps)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.failure.kind).toBe('too-much-text')
    // 与「全部抓取失败」不同：这里走到了解析阶段，论文记录已创建，只是被标记为 failed
    expect(outcome.paper).toBeDefined()
    const stored = await repo.getPaper(outcome.paper!.id)
    expect(stored?.status).toBe('failed')
  })

  it('空 URL 列表：直接返回 failed，不调用任何 fetch', async () => {
    const repo = freshRepo()
    const outcome = await importFromUrls([], { repo, hash: sha256Hex, parse: parseByFormat, fetchUrl: async () => {
      throw new Error('不应被调用')
    }, extract: async () => {
      throw new Error('不应被调用')
    } })
    expect(outcome.kind).toBe('failed')
  })

  it('onState 全程只报告 validating 一次（抓取+抽取阶段不产生新 stage），随后进入常规 parsing→ready 序列', async () => {
    const repo = freshRepo()
    const urls = ['https://a.com/x', 'https://a.com/y']
    const deps: UrlImportDeps = {
      ...makeDeps(repo, {
        [urls[0]]: { title: 'A', html: '<h1>A</h1><p>a</p>' },
        [urls[1]]: { title: 'B', html: '<h1>B</h1><p>b</p>' },
      }),
    }
    const stages: string[] = []
    const outcome = await importFromUrls(urls, { ...deps, onState: (s) => stages.push(s.stage) })
    expect(outcome.kind).toBe('ready')
    // 'validating' 只出现一次（即便中间抓了两个 URL），说明抓取/抽取没有产生额外 stage
    expect(stages.filter((s) => s === 'validating')).toHaveLength(1)
    expect(stages).toEqual(['validating', 'parsing', 'normalizing', 'indexing', 'ready'])
  })
})
