import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { IngestError, type ParseResult } from '../ingest'
import { PaperDb } from '../repo/db'
import { createPaperRepository } from '../repo/paperRepo'
import type { NormalizedBlock } from '../types'
import { sha256Hex } from '../validate'
import { parseHtmlBytes } from './parseHtmlBytes'
import { URL_BUNDLE_MIME } from './urlBundleMime'
import {
  importFromUrls,
  reimportUrlPaperInPlace,
  type FetchedUrlResult,
  type UrlImportDeps,
  type UrlProgressEvent,
} from './urlImport'
import { encodeWebSnapshot } from './webSnapshot'
import { WEB_SNAPSHOT_MIME } from './webSnapshotMime'

function freshDb() {
  const db = new PaperDb(`t-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange })
  return { db, repo: createPaperRepository(db) }
}
const freshRepo = () => freshDb().repo

const textBytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer
const pdfBytes = (payload = 'hello'): ArrayBuffer => textBytes(`%PDF-1.7\n${payload}`)

/** parseByFormat 的测试替身：html 走真实 parseHtmlBytes（按魔数分流合集/快照，覆盖全链路），pdf 走假实现 */
const parseByFormat = async (input: { bytes: ArrayBuffer; format: 'pdf' | 'docx' | 'html' }): Promise<ParseResult> => {
  if (input.format === 'html') return parseHtmlBytes(input.bytes)
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
  extra: Partial<UrlImportDeps> = {},
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
  return { repo, hash: sha256Hex, parse: parseByFormat, fetchUrl, extract, ...extra }
}

/**
 * buildSnapshot 的替身：不碰 DOM，直接用 encodeWebSnapshot 造一份真实容器（块文本带上输入 html，
 * 好让不同输入产出不同 sha），并按真实实现的阶段顺序回调 onPhase。
 */
function fakeSnapshotBuilder(opts: { title?: string; throwError?: unknown } = {}) {
  const calls: { url: string; html: string; finalUrl: string }[] = []
  let last: ArrayBuffer | null = null
  const build: NonNullable<UrlImportDeps['buildSnapshot']> = async (input, o) => {
    calls.push(input)
    if (opts.throwError) throw opts.throwError
    o.onPhase?.('rendering')
    o.onPhase?.('assets', { done: 0, total: 2 })
    o.onPhase?.('assets', { done: 2, total: 2 })
    o.onPhase?.('sanitizing')
    o.onPhase?.('packing')
    const title = opts.title ?? '快照标题'
    const body = input.html.replace(/<[^>]+>/g, '')
    const blocks: NormalizedBlock[] = [
      { index: 0, kind: 'heading', level: 1, text: title, anchor: { kind: 'html', blockIndex: 0, section: title } },
      { index: 1, kind: 'paragraph', text: body, anchor: { kind: 'html', blockIndex: 1, section: title } },
    ]
    const { bytes, header } = encodeWebSnapshot({
      header: {
        url: input.url,
        finalUrl: input.finalUrl,
        title,
        capture: { mode: 'static', katex: false, viewportWidth: 0, agentVersion: 0 },
        html: `<html><head><title>${title}</title></head><body><h1 data-pc-block="0">${title}</h1><p data-pc-block="1">${body}</p></body></html>`,
        blocks,
        stats: { assetBytes: 0, skipped: [{ url: 'https://a.com/x.png', reason: 'fetch' }] },
      },
      assets: [{ id: 'aaa', url: 'https://a.com/a.png', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) }],
    })
    last = bytes
    return {
      bytes,
      header,
      capture: { mode: 'static', assetCount: header.assets.length, assetBytes: header.stats.assetBytes, skipped: 1, katex: false },
    }
  }
  return { build, calls, lastBytes: () => last }
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

describe('importFromUrls：网页原貌（presentation=snapshot）', () => {
  it('单 URL 走 buildSnapshot：落库 mime=WEB_SNAPSHOT_MIME、source.capture 摘要、块来自快照头，进度含 rendering/assets(done/total)/packing', async () => {
    const repo = freshRepo()
    const url = 'https://a.com/page'
    const snap = fakeSnapshotBuilder()
    const deps = makeDeps(repo, { [url]: { html: '<p>原貌正文</p>', finalUrl: 'https://a.com/final/page' } }, { buildSnapshot: snap.build })
    const progress: UrlProgressEvent[] = []
    const stages: string[] = []
    const outcome = await importFromUrls([url], { ...deps, onState: (s) => stages.push(s.stage) }, (ev) => progress.push(ev), { presentation: 'snapshot' })

    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    expect(snap.calls).toEqual([{ url, html: '<p>原貌正文</p>', finalUrl: 'https://a.com/final/page' }])
    expect(outcome.paper.format).toBe('html')
    expect(outcome.paper.mime).toBe(WEB_SNAPSHOT_MIME)
    expect(outcome.paper.title).toBe('快照标题')
    expect(outcome.paper.fileName).toBe('a.com')
    expect(outcome.paper.source).toEqual({
      type: 'url',
      entries: [expect.objectContaining({ url, finalUrl: 'https://a.com/final/page', title: '快照标题', ok: true })],
      capture: { mode: 'static', assetCount: 1, assetBytes: 3, skipped: 1, katex: false },
    })
    expect(outcome.paper.sha256).toBe(await sha256Hex(snap.lastBytes()!))
    // 字节原样入库（容器），parse 走快照分支：块 = 头里的块
    const file = await repo.getFileBytes(outcome.paper.id)
    expect(file?.mime).toBe(WEB_SNAPSHOT_MIME)
    const blocks = await repo.getBlocks(outcome.paper.id)
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ['heading', '快照标题'],
      ['paragraph', '原貌正文'],
    ])
    // 进度阶梯：sanitizing 映射为 packing；assets 带 done/total
    expect(progress.map((p) => p.phase)).toEqual(['pending', 'fetching', 'rendering', 'assets', 'assets', 'packing', 'packing', 'done'])
    expect(progress.filter((p) => p.phase === 'assets').map((p) => p.detail)).toEqual([
      { done: 0, total: 2 },
      { done: 2, total: 2 },
    ])
    expect(progress.some((p) => p.note)).toBe(false)
    expect(stages).toEqual(['validating', 'parsing', 'normalizing', 'indexing', 'ready'])
  })

  it('findByFinalUrl 命中 → duplicate，先于快照构建（buildSnapshot 不被调用）', async () => {
    const repo = freshRepo()
    const url = 'https://a.com/page'
    const snap = fakeSnapshotBuilder()
    const deps = makeDeps(repo, { [url]: { html: '<p>x</p>', finalUrl: 'https://a.com/final' } }, { buildSnapshot: snap.build })
    const first = await importFromUrls([url], deps, undefined, { presentation: 'snapshot' })
    expect(first.kind).toBe('ready')
    if (first.kind !== 'ready') return

    const findByFinalUrl = vi.fn(async (finalUrl: string) => (finalUrl === 'https://a.com/final' ? first.paper : undefined))
    const second = await importFromUrls([url], { ...deps, findByFinalUrl }, undefined, { presentation: 'snapshot' })
    expect(second.kind).toBe('duplicate')
    if (second.kind !== 'duplicate') return
    expect(second.existing.id).toBe(first.paper.id)
    expect(findByFinalUrl).toHaveBeenCalledWith('https://a.com/final')
    expect(snap.calls).toHaveLength(1)
    expect(await repo.listPapers()).toHaveLength(1)
  })

  it('多 URL + snapshot → 自动回落阅读模式：合集 mime、buildSnapshot 不被调用、进度事件带 note 且 console.warn 一次', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const repo = freshRepo()
      const urls = ['https://a.com/1', 'https://a.com/2']
      const snap = fakeSnapshotBuilder()
      const deps = makeDeps(
        repo,
        { [urls[0]]: { title: 'A', html: '<h1>A</h1><p>a</p>' }, [urls[1]]: { title: 'B', html: '<h1>B</h1><p>b</p>' } },
        { buildSnapshot: snap.build },
      )
      const progress: UrlProgressEvent[] = []
      const outcome = await importFromUrls(urls, deps, (ev) => progress.push(ev), { presentation: 'snapshot' })
      expect(outcome.kind).toBe('ready')
      if (outcome.kind !== 'ready') return
      expect(outcome.paper.mime).toBe(URL_BUNDLE_MIME)
      expect(outcome.paper.source?.capture).toBeUndefined()
      expect(snap.calls).toEqual([])
      expect(progress.filter((p) => p.phase === 'pending').every((p) => p.note?.includes('阅读模式'))).toBe(true)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('微信文章 + snapshot → 强制阅读模式', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const repo = freshRepo()
      const url = 'https://mp.weixin.qq.com/s/abc'
      const snap = fakeSnapshotBuilder()
      const deps = makeDeps(repo, { [url]: { title: '公众号', html: '<h1>公众号</h1><p>正文</p>' } }, { buildSnapshot: snap.build })
      const progress: UrlProgressEvent[] = []
      const outcome = await importFromUrls([url], deps, (ev) => progress.push(ev), { presentation: 'snapshot' })
      expect(outcome.kind).toBe('ready')
      if (outcome.kind !== 'ready') return
      expect(outcome.paper.mime).toBe(URL_BUNDLE_MIME)
      expect(snap.calls).toEqual([])
      expect(progress[0].note).toContain('微信')
    } finally {
      warn.mockRestore()
    }
  })

  it('deps 未注入 buildSnapshot → 阅读模式（旧调用方零改动）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const repo = freshRepo()
      const url = 'https://a.com/page'
      const deps = makeDeps(repo, { [url]: { title: 'P', html: '<h1>P</h1><p>正文</p>' } })
      const outcome = await importFromUrls([url], deps, undefined, { presentation: 'snapshot' })
      expect(outcome.kind).toBe('ready')
      if (outcome.kind !== 'ready') return
      expect(outcome.paper.mime).toBe(URL_BUNDLE_MIME)
    } finally {
      warn.mockRestore()
    }
  })

  it('ensureStorage 拒绝 → failed(storage) 带文案，不落库', async () => {
    const repo = freshRepo()
    const url = 'https://a.com/page'
    const snap = fakeSnapshotBuilder()
    const deps = makeDeps(repo, { [url]: { html: '<p>x</p>' } }, {
      buildSnapshot: snap.build,
      ensureStorage: async (bytes) => ({ ok: false, message: `空间不足（需要 ${bytes} 字节）` }),
    })
    const progress: UrlProgressEvent[] = []
    const outcome = await importFromUrls([url], deps, (ev) => progress.push(ev), { presentation: 'snapshot' })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.failure.kind).toBe('storage')
    expect(outcome.failure.message).toMatch(/^空间不足（需要 \d+ 字节）$/)
    expect(outcome.paper).toBeUndefined()
    expect(await repo.listPapers()).toHaveLength(0)
    expect(progress[progress.length - 1]).toMatchObject({ phase: 'failed', error: outcome.failure.message })
  })

  it('buildSnapshot 抛 IngestError(empty) → failed 保留 kind 与文案，不落库', async () => {
    const repo = freshRepo()
    const url = 'https://a.com/page'
    const snap = fakeSnapshotBuilder({ throwError: new IngestError('empty', '页面依赖脚本渲染，原貌抓取未得到正文；可改用「阅读模式」重试') })
    const deps = makeDeps(repo, { [url]: { html: '<p>x</p>' } }, { buildSnapshot: snap.build })
    const outcome = await importFromUrls([url], deps, undefined, { presentation: 'snapshot' })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.failure).toMatchObject({ kind: 'empty', message: expect.stringContaining('阅读模式') })
    expect(await repo.listPapers()).toHaveLength(0)
  })

  it('单 URL 直链 PDF + snapshot → 仍走原版 PDF 导入（呈现方式与 PDF 无关）', async () => {
    const repo = freshRepo()
    const url = 'https://a.com/paper.pdf'
    const snap = fakeSnapshotBuilder()
    const deps = makeDeps(repo, { [url]: { pdf: true } }, { buildSnapshot: snap.build })
    const outcome = await importFromUrls([url], deps, undefined, { presentation: 'snapshot' })
    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    expect(outcome.paper.format).toBe('pdf')
    expect(snap.calls).toEqual([])
  })
})

describe('reimportUrlPaperInPlace', () => {
  it('paperId 不变，源文件换成新快照后以新 sha ready，块与 source.capture 随之更新', async () => {
    const { db, repo } = freshDb()
    const url = 'https://a.com/page'
    const byUrl: Record<string, FakeUrlResult> = { [url]: { html: '<p>第一版</p>', finalUrl: url } }
    const snap = fakeSnapshotBuilder()
    const replaceFile = vi.fn<NonNullable<UrlImportDeps['replaceFile']>>(async (paperId, input) => {
      // 步骤 4 的 paperRepo.replaceFile 契约：单事务覆盖 papers/files（此处只模拟本步依赖的最小语义）
      await db.transaction('rw', [db.papers, db.files], async () => {
        await db.papers.update(paperId, {
          sha256: input.sha256,
          byteSize: input.byteSize,
          mime: input.mime,
          format: input.format,
          source: input.source,
          title: input.title,
          fileName: input.fileName,
          status: 'queued',
          failure: undefined,
        })
        await db.files.put({ paperId, bytes: input.bytes, mime: input.mime })
      })
    })
    const deps = makeDeps(repo, byUrl, { buildSnapshot: snap.build, replaceFile })

    const first = await importFromUrls([url], deps, undefined, { presentation: 'snapshot' })
    expect(first.kind).toBe('ready')
    if (first.kind !== 'ready') return
    const oldSha = first.paper.sha256

    byUrl[url] = { html: '<p>第二版</p>', finalUrl: url }
    const progress: UrlProgressEvent[] = []
    const outcome = await reimportUrlPaperInPlace(first.paper.id, deps, (ev) => progress.push(ev))

    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    expect(outcome.paper.id).toBe(first.paper.id)
    expect(outcome.paper.status).toBe('ready')
    expect(outcome.paper.sha256).not.toBe(oldSha)
    expect(outcome.paper.sha256).toBe(await sha256Hex(snap.lastBytes()!))
    expect(outcome.paper.mime).toBe(WEB_SNAPSHOT_MIME)
    expect(outcome.paper.source?.capture).toEqual({ mode: 'static', assetCount: 1, assetBytes: 3, skipped: 1, katex: false })
    expect(replaceFile).toHaveBeenCalledTimes(1)
    expect(replaceFile.mock.calls[0][1]).toMatchObject({ format: 'html', mime: WEB_SNAPSHOT_MIME, title: '快照标题', fileName: 'a.com' })

    const blocks = await repo.getBlocks(first.paper.id)
    expect(blocks.map((b) => b.text)).toEqual(['快照标题', '第二版'])
    expect(await repo.listPapers()).toHaveLength(1)
    expect(progress.map((p) => p.phase)).toEqual(['fetching', 'rendering', 'assets', 'assets', 'packing', 'packing', 'done'])
  })

  it('deps 缺 replaceFile → failed「当前版本不支持原地重导入」，论文不动', async () => {
    const repo = freshRepo()
    const url = 'https://a.com/page'
    const snap = fakeSnapshotBuilder()
    const deps = makeDeps(repo, { [url]: { html: '<p>v1</p>' } }, { buildSnapshot: snap.build })
    const first = await importFromUrls([url], deps, undefined, { presentation: 'snapshot' })
    if (first.kind !== 'ready') throw new Error('setup failed')

    const outcome = await reimportUrlPaperInPlace(first.paper.id, deps)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.failure.message).toBe('当前版本不支持原地重导入')
    expect(outcome.paper?.id).toBe(first.paper.id)
    expect(snap.calls).toHaveLength(1) // 没有再次构建
    expect((await repo.getPaper(first.paper.id))?.sha256).toBe(first.paper.sha256)
  })

  it('论文不存在 → failed；来源为微信 → failed', async () => {
    const repo = freshRepo()
    const snap = fakeSnapshotBuilder()
    const deps = makeDeps(repo, {}, { buildSnapshot: snap.build, replaceFile: async () => {} })
    const missing = await reimportUrlPaperInPlace('nope', deps)
    expect(missing.kind).toBe('failed')

    const paper = await repo.createPaper({
      title: 'wx',
      fileName: 'mp.weixin.qq.com',
      format: 'html',
      mime: URL_BUNDLE_MIME,
      byteSize: 1,
      sha256: 'x',
      bytes: textBytes('{}'),
      source: { type: 'url', entries: [{ url: 'https://mp.weixin.qq.com/s/abc', ok: true, fetchedAt: 0 }] },
    })
    const wx = await reimportUrlPaperInPlace(paper.id, deps)
    expect(wx.kind).toBe('failed')
    if (wx.kind !== 'failed') return
    expect(wx.failure.message).toContain('微信')
  })

  it('多链接合集 → failed「多链接合并的文档不支持」，不抓取、不构建快照、论文不动', async () => {
    const repo = freshRepo()
    const snap = fakeSnapshotBuilder()
    const fetchUrl = vi.fn<UrlImportDeps['fetchUrl']>(async () => {
      throw new Error('不该抓取')
    })
    const replaceFile = vi.fn<NonNullable<UrlImportDeps['replaceFile']>>(async () => {})
    const deps = { ...makeDeps(repo, {}, { buildSnapshot: snap.build, replaceFile }), fetchUrl }
    const paper = await repo.createPaper({
      title: '合集',
      fileName: 'a.com 等 2 个站点',
      format: 'html',
      mime: URL_BUNDLE_MIME,
      byteSize: 1,
      sha256: 'x',
      bytes: textBytes('{}'),
      source: {
        type: 'url',
        entries: [
          { url: 'https://a.com/1', finalUrl: 'https://a.com/1', ok: true, fetchedAt: 0 },
          { url: 'https://b.com/2', finalUrl: 'https://b.com/2', ok: true, fetchedAt: 0 },
        ],
      },
    })
    const outcome = await reimportUrlPaperInPlace(paper.id, deps)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.failure.message).toContain('多链接')
    expect(fetchUrl).not.toHaveBeenCalled()
    expect(snap.calls).toEqual([])
    expect(replaceFile).not.toHaveBeenCalled()
    const after = await repo.getPaper(paper.id)
    expect(after?.sha256).toBe('x')
    expect(after?.source?.type === 'url' ? after.source.entries : []).toHaveLength(2)
  })
})
