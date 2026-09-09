import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ASSET_CAPS,
  fetchAssets,
  isAllowedAssetMime,
  normalizeMime,
  shouldProxyFont,
  type AssetPlanItem,
  type FetchAssetsDeps,
} from './snapshotAssets'

type Served = { bytes: number[]; contentType: string } | { throw: unknown } | { sequence: (Served | undefined)[] }

const bytesOf = (nums: number[]): ArrayBuffer => new Uint8Array(nums).buffer as ArrayBuffer

/** 假抓取：按 URL 配置响应；记录调用顺序、并发峰值、退避 sleep */
function fakeFetcher(table: Record<string, Served>, opts: { delayMs?: number } = {}) {
  const calls: string[] = []
  const sleeps: number[] = []
  let inFlight = 0
  let maxInFlight = 0
  const attempts = new Map<string, number>()
  const resolveServed = (url: string): Served => {
    const s = table[url]
    if (!s) return { throw: new Error(`no fake for ${url}`) }
    if ('sequence' in s) {
      const n = attempts.get(url) ?? 0
      attempts.set(url, n + 1)
      return s.sequence[Math.min(n, s.sequence.length - 1)] ?? { throw: new Error('exhausted') }
    }
    return s
  }
  const fetchAsset: FetchAssetsDeps['fetchAsset'] = async (url) => {
    calls.push(url)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      const s = resolveServed(url)
      if ('throw' in s) throw s.throw
      if ('bytes' in s) return { bytes: bytesOf(s.bytes), contentType: s.contentType }
      throw new Error('unreachable')
    } finally {
      inFlight--
    }
  }
  const deps: FetchAssetsDeps = {
    fetchAsset,
    hash: async (b) => `h:${Array.from(new Uint8Array(b)).join('.')}`,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  }
  return { deps, calls, sleeps, maxInFlight: () => maxInFlight }
}

const img = (url: string): AssetPlanItem => ({ url, kind: 'image' })
const font = (url: string): AssetPlanItem => ({ url, kind: 'font' })
const PNG = 'image/png'

describe('fetchAssets：去重、顺序、结果形态', () => {
  it('按 URL 去重（先到先得）、结果保持文档序、id 为注入 hash 的结果、mime 已去参数', async () => {
    const f = fakeFetcher({
      'https://s/a.png': { bytes: [1], contentType: 'image/png; charset=binary' },
      'https://s/b.png': { bytes: [2, 2], contentType: PNG },
      'https://s/c.png': { bytes: [3], contentType: PNG },
    })
    const { fetched, skipped } = await fetchAssets([img('https://s/a.png'), img('https://s/b.png'), img('https://s/a.png'), img('https://s/c.png')], f.deps)
    expect(f.calls).toEqual(['https://s/a.png', 'https://s/b.png', 'https://s/c.png'])
    expect(fetched.map((a) => [a.url, a.mime, a.id, Array.from(a.bytes)])).toEqual([
      ['https://s/a.png', 'image/png', 'h:1', [1]],
      ['https://s/b.png', 'image/png', 'h:2.2', [2, 2]],
      ['https://s/c.png', 'image/png', 'h:3', [3]],
    ])
    expect(skipped).toEqual([])
  })

  it('并发慢返回时顺序仍按输入而非完成顺序', async () => {
    const f = fakeFetcher(
      { 'https://s/1.png': { bytes: [1], contentType: PNG }, 'https://s/2.png': { bytes: [2], contentType: PNG }, 'https://s/3.png': { bytes: [3], contentType: PNG } },
      { delayMs: 1 },
    )
    const { fetched } = await fetchAssets([img('https://s/1.png'), img('https://s/2.png'), img('https://s/3.png')], { ...f.deps, caps: { concurrency: 3 } })
    expect(fetched.map((a) => a.url)).toEqual(['https://s/1.png', 'https://s/2.png', 'https://s/3.png'])
  })

  it('onProgress 从 0/total 计到 total/total（total = 真正发起抓取的条数，不含被前置配额挡下的）', async () => {
    const f = fakeFetcher({ 'https://s/a.png': { bytes: [1], contentType: PNG }, 'https://s/b.png': { bytes: [2], contentType: PNG } })
    const seen: [number, number][] = []
    await fetchAssets([img('https://s/a.png'), img('https://s/b.png'), img('https://s/c.png')], {
      ...f.deps,
      caps: { maxCount: 2 },
      onProgress: (d, t) => seen.push([d, t]),
    })
    expect(seen).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ])
  })
})

describe('fetchAssets：配额', () => {
  it('maxCount：超出的按文档序判 cap 且不发起抓取', async () => {
    const f = fakeFetcher({ 'https://s/a.png': { bytes: [1], contentType: PNG }, 'https://s/b.png': { bytes: [2], contentType: PNG } })
    const { fetched, skipped } = await fetchAssets([img('https://s/a.png'), img('https://s/b.png'), img('https://s/c.png')], { ...f.deps, caps: { maxCount: 2 } })
    expect(fetched.map((a) => a.url)).toEqual(['https://s/a.png', 'https://s/b.png'])
    expect(skipped).toEqual([{ url: 'https://s/c.png', reason: 'cap' }])
    expect(f.calls).not.toContain('https://s/c.png')
  })

  it('maxAssetBytes：单个超限 → too-large，且不计入总量', async () => {
    const f = fakeFetcher({ 'https://s/big.png': { bytes: [1, 2, 3, 4], contentType: PNG }, 'https://s/ok.png': { bytes: [1, 2, 3], contentType: PNG } })
    const { fetched, skipped } = await fetchAssets([img('https://s/big.png'), img('https://s/ok.png')], { ...f.deps, caps: { maxAssetBytes: 3, maxTotalBytes: 3, concurrency: 1 } })
    expect(skipped).toEqual([{ url: 'https://s/big.png', reason: 'too-large' }])
    expect(fetched.map((a) => a.url)).toEqual(['https://s/ok.png'])
  })

  it('maxTotalBytes：累计超限的那一个起判 cap', async () => {
    const f = fakeFetcher({
      'https://s/a.png': { bytes: [1, 1, 1], contentType: PNG },
      'https://s/b.png': { bytes: [2, 2, 2], contentType: PNG },
      'https://s/c.png': { bytes: [3], contentType: PNG },
    })
    const { fetched, skipped } = await fetchAssets([img('https://s/a.png'), img('https://s/b.png'), img('https://s/c.png')], { ...f.deps, caps: { maxTotalBytes: 5, concurrency: 1 } })
    expect(fetched.map((a) => a.url)).toEqual(['https://s/a.png', 'https://s/c.png'])
    expect(skipped).toEqual([{ url: 'https://s/b.png', reason: 'cap' }])
  })

  it('maxFonts / maxFontBytes：字体数与字体字节各有独立上限，图片不受影响', async () => {
    const f = fakeFetcher({
      'https://s/f1.woff2': { bytes: [1, 1], contentType: 'font/woff2' },
      'https://s/f2.woff2': { bytes: [2, 2], contentType: 'font/woff2' },
      'https://s/f3.woff2': { bytes: [3], contentType: 'font/woff2' },
      'https://s/i.png': { bytes: [9, 9, 9], contentType: PNG },
    })
    const { fetched, skipped } = await fetchAssets(
      [font('https://s/f1.woff2'), font('https://s/f2.woff2'), font('https://s/f3.woff2'), img('https://s/i.png')],
      { ...f.deps, caps: { maxFonts: 2, maxFontBytes: 3, concurrency: 1 } },
    )
    expect(fetched.map((a) => a.url)).toEqual(['https://s/f1.woff2', 'https://s/i.png'])
    expect(skipped).toEqual([
      { url: 'https://s/f2.woff2', reason: 'cap' }, // 字体字节超限
      { url: 'https://s/f3.woff2', reason: 'cap' }, // 字体数超限（前置，未抓取）
    ])
    expect(f.calls).not.toContain('https://s/f3.woff2')
  })
})

describe('fetchAssets：类型、失败、退避', () => {
  it('MIME 不在该 kind 的白名单 → type；抓取抛错（非 429）→ fetch，不重试', async () => {
    const f = fakeFetcher({
      'https://s/page.html': { bytes: [1], contentType: 'text/html' },
      'https://s/font-as-image.woff2': { bytes: [1], contentType: 'font/woff2' },
      'https://s/404.png': { throw: Object.assign(new Error('not found'), { status: 404 }) },
      'https://s/ok.png': { bytes: [1], contentType: PNG },
    })
    const { fetched, skipped } = await fetchAssets(
      [img('https://s/page.html'), img('https://s/font-as-image.woff2'), img('https://s/404.png'), img('https://s/ok.png')],
      f.deps,
    )
    expect(skipped).toEqual([
      { url: 'https://s/page.html', reason: 'type' },
      { url: 'https://s/font-as-image.woff2', reason: 'type' },
      { url: 'https://s/404.png', reason: 'fetch' },
    ])
    expect(fetched.map((a) => a.url)).toEqual(['https://s/ok.png'])
    expect(f.calls.filter((u) => u === 'https://s/404.png')).toHaveLength(1)
    expect(f.sleeps).toEqual([])
  })

  it('429 带 retryAfterMs：sleep min(retryAfterMs, 5000) 后重试，成功即收', async () => {
    const tooMany = Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 20_000 })
    const f = fakeFetcher({
      'https://s/a.png': { sequence: [{ throw: tooMany }, { throw: Object.assign(new Error('rl'), { status: 429, retryAfterMs: 300 }) }, { bytes: [7], contentType: PNG }] },
    })
    const { fetched, skipped } = await fetchAssets([img('https://s/a.png')], f.deps)
    expect(fetched.map((a) => a.url)).toEqual(['https://s/a.png'])
    expect(skipped).toEqual([])
    expect(f.sleeps).toEqual([5000, 300])
    expect(f.calls).toHaveLength(3)
  })

  it('429 连续 4 次（首次 + 3 次重试）仍失败 → fetch；无 Retry-After 的 429 用默认退避', async () => {
    const tooMany = Object.assign(new Error('rate limited'), { status: 429 })
    const f = fakeFetcher({ 'https://s/a.png': { sequence: [{ throw: tooMany }] } })
    const { fetched, skipped } = await fetchAssets([img('https://s/a.png')], f.deps)
    expect(fetched).toEqual([])
    expect(skipped).toEqual([{ url: 'https://s/a.png', reason: 'fetch' }])
    expect(f.calls).toHaveLength(4)
    expect(f.sleeps).toEqual([1000, 1000, 1000])
  })

  it('并发不超过 caps.concurrency', async () => {
    const table: Record<string, Served> = {}
    const items: AssetPlanItem[] = []
    for (let i = 0; i < 7; i++) {
      table[`https://s/${i}.png`] = { bytes: [i], contentType: PNG }
      items.push(img(`https://s/${i}.png`))
    }
    const f = fakeFetcher(table, { delayMs: 2 })
    const { fetched } = await fetchAssets(items, { ...f.deps, caps: { concurrency: 2 } })
    expect(fetched).toHaveLength(7)
    expect(f.maxInFlight()).toBe(2)
  })

  it('signal 已中止 → 抛 AbortError（取消不是「这条资源抓不到」）', async () => {
    const f = fakeFetcher({ 'https://s/a.png': { bytes: [1], contentType: PNG } })
    const controller = new AbortController()
    controller.abort()
    await expect(fetchAssets([img('https://s/a.png')], { ...f.deps, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('shouldProxyFont / isAllowedAssetMime / normalizeMime', () => {
  it('同主机或同可注册域才代理字体；第三方 CDN、非法 URL、非 http(s)、IP 不同均否', () => {
    expect(shouldProxyFont('https://site.test/f.woff2', 'https://site.test/page')).toBe(true)
    expect(shouldProxyFont('https://cdn.site.test/f.woff2', 'https://www.site.test/page')).toBe(true)
    expect(shouldProxyFont('https://fonts.gstatic.com/s/x.woff2', 'https://site.test/page')).toBe(false)
    expect(shouldProxyFont('not a url', 'https://site.test/page')).toBe(false)
    expect(shouldProxyFont('data:font/woff2;base64,AAA', 'https://site.test/page')).toBe(false)
    expect(shouldProxyFont('https://10.0.0.1/f.woff2', 'https://10.0.0.2/page')).toBe(false)
    expect(shouldProxyFont('https://10.0.0.1/f.woff2', 'https://10.0.0.1/page')).toBe(true)
  })

  it('MIME 白名单按 kind 区分；参数被剥掉', () => {
    expect(normalizeMime('Image/PNG; charset=binary')).toBe('image/png')
    expect(isAllowedAssetMime('text/css; charset=utf-8', 'css')).toBe(true)
    expect(isAllowedAssetMime('text/html', 'css')).toBe(false)
    expect(isAllowedAssetMime('image/svg+xml', 'image')).toBe(true)
    expect(isAllowedAssetMime('font/woff2', 'image')).toBe(false)
    expect(isAllowedAssetMime('application/font-woff', 'font')).toBe(true)
    expect(isAllowedAssetMime('application/octet-stream', 'font')).toBe(false)
    expect(DEFAULT_ASSET_CAPS.concurrency).toBe(3)
  })
})
