import type { Font as FontkitFont } from '@pdf-lib/fontkit'
import fontUrl from '../../../assets/fonts/NotoSerifSC-sub.ttf?url'
import { abortError, type FontMetrics, type PlanFont } from './exportTypes'

/**
 * 导出用中文字体（Noto Serif SC 子集，见 src/assets/fonts/README.md）：
 * - `loadCjkFont` 模块级记忆（失败重置可重试），`body.getReader()` 流式报字节；
 * - fontkit `create(bytes)` 提供 upm / ascent / descent / hasGlyph / advance（去掉 GSUB/GPOS 后 cmap 1:1，
 *   `Σ advance × size / upm` 即精确宽度，与 pdf-lib 写出的 /W 一致）；
 * - `sanitizeForFont`：NFC、`\r\n` / `\r` → `\n`、`\t` → 两空格、NBSP → 空格、去控制符与零宽字符、缺字 → `□`。
 * 规划器只认 `PlanFont`（exportTypes），本模块的 CjkFont 实现它；node 测试用 `createCjkFont(bytes)` 绕过 fetch。
 */

export const CJK_FONT_URL: string = fontUrl
/** 缺字占位（子集里保证收录） */
export const MISSING_GLYPH = '□'
const MISSING_CP = MISSING_GLYPH.codePointAt(0)!

export interface CjkFont extends PlanFont {
  bytes: Uint8Array
  metrics: FontMetrics
  hasGlyph(cp: number): boolean
  /** 字形前进宽（字体单位） */
  advance(cp: number): number
  measureAt(text: string, size: number): number
  sanitize(text: string): string
}

export interface LoadCjkFontOptions {
  signal?: AbortSignal
  /** 已下载字节 / 总字节（Content-Length 缺失或为压缩长度时 total 为 null 或偏小，只作提示） */
  onProgress?: (loaded: number, total: number | null) => void
}

export interface FontkitModule {
  create(buffer: Uint8Array, postscriptName?: string): FontkitFont
}

/** ESM 构建是 `export default fontkit`，CJS/UMD 是 `module.exports = { create }`：两种形态都认 */
export async function loadFontkit(): Promise<FontkitModule> {
  const mod = (await import('@pdf-lib/fontkit')) as unknown as { create?: unknown; default?: { create?: unknown } }
  const create = typeof mod.create === 'function' ? mod.create : mod.default?.create
  if (typeof create !== 'function') throw new Error('fontkit 模块没有 create 导出')
  return { create: create as FontkitModule['create'] }
}

/**
 * 要删掉的不可见字符：控制符、零宽 / 格式字符、变体选择符、BOM。
 * 刻意留出 U+0009 / U+000A / U+000D——制表、换行、回车在 sanitizeForFont 里先单独换成空格 / `\n`，
 * 删除类不碰它们，两步谁先谁后结果都一样。
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
]
/** `\uXXXX` 转义串（字符串里是反斜杠 + u + 四位十六进制，交给 RegExp 解释）：源码与正则源都不含原始控制字符 */
const uEsc = (cp: number): string => `\\u${cp.toString(16).padStart(4, '0')}`
const CONTROL_RE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => `${uEsc(a)}-${uEsc(b)}`).join('')}]`, 'g')
const NBSP_RE = new RegExp(uEsc(0xa0), 'g')

/**
 * 字体字符清洗：NFC → `\r\n` / `\r` → `\n` → `\t` 两空格 → NBSP 空格 → 去控制符 / 零宽 / 变体选择符；
 * 传 hasGlyph 时缺字（含 emoji 等代理对）→ `□`。`\n` 保留（规划器按它硬换行；执行器逐行落笔前再洗一次，幂等）。
 */
export function sanitizeForFont(text: string, hasGlyph?: (cp: number) => boolean): string {
  let t = text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(NBSP_RE, ' ')
    .replace(CONTROL_RE, '')
  if (hasGlyph) {
    let out = ''
    for (const ch of t) out += ch === '\n' || hasGlyph(ch.codePointAt(0)!) ? ch : MISSING_GLYPH
    t = out
  }
  return t
}

/** 由字节建 CjkFont（fontkit 解析 + 度量记忆）；node 测试从磁盘读 TTF 后直接用 */
export async function createCjkFont(bytes: Uint8Array): Promise<CjkFont> {
  const fontkit = await loadFontkit()
  const font = fontkit.create(bytes)
  const metrics: FontMetrics = { unitsPerEm: font.unitsPerEm, ascent: font.ascent, descent: font.descent }
  const glyphs = new Map<number, boolean>()
  const advances = new Map<number, number>()
  const hasGlyph = (cp: number): boolean => {
    let v = glyphs.get(cp)
    if (v === undefined) {
      try {
        v = font.hasGlyphForCodePoint(cp)
      } catch {
        v = false
      }
      glyphs.set(cp, v)
    }
    return v
  }
  const advance = (cp: number): number => {
    let v = advances.get(cp)
    if (v === undefined) {
      try {
        v = hasGlyph(cp) ? font.glyphForCodePoint(cp).advanceWidth : NaN
      } catch {
        v = NaN
      }
      if (!Number.isFinite(v)) v = cp === MISSING_CP ? metrics.unitsPerEm / 2 : advance(MISSING_CP)
      advances.set(cp, v)
    }
    return v
  }
  const measureAt = (text: string, size: number): number => {
    let units = 0
    for (const ch of text) units += advance(ch.codePointAt(0)!)
    return (units * size) / metrics.unitsPerEm
  }
  return { bytes, metrics, hasGlyph, advance, measureAt, sanitize: (t) => sanitizeForFont(t, hasGlyph) }
}

interface SharedLoad {
  promise: Promise<CjkFont>
  controller: AbortController
  listeners: Set<(loaded: number, total: number | null) => void>
  waiters: number
  settled: boolean
}

let shared: SharedLoad | null = null

async function fetchFontBytes(signal: AbortSignal, report: (loaded: number, total: number | null) => void): Promise<Uint8Array> {
  const res = await fetch(fontUrl, { signal })
  if (!res.ok) throw new Error(`字体下载失败（${res.status}）`)
  const lenHeader = Number(res.headers.get('content-length'))
  const total = Number.isFinite(lenHeader) && lenHeader > 0 ? lenHeader : null
  const reader = res.body?.getReader()
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    report(buf.byteLength, total)
    return buf
  }
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    report(loaded, total)
  }
  const out = new Uint8Array(loaded)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/**
 * 下载 + 解析导出字体，模块级记忆：同时发起的调用共享一次下载；失败重置（下次重试）；
 * 全部等待方都取消才真正中止下载（已成功的缓存不受取消影响）。
 */
export function loadCjkFont(opts: LoadCjkFontOptions = {}): Promise<CjkFont> {
  const { signal, onProgress } = opts
  if (signal?.aborted) return Promise.reject(abortError())
  if (!shared) {
    const controller = new AbortController()
    const entry: SharedLoad = {
      controller,
      listeners: new Set(),
      waiters: 0,
      settled: false,
      promise: (async () => {
        const bytes = await fetchFontBytes(controller.signal, (l, t) => {
          for (const fn of entry.listeners) fn(l, t)
        })
        return createCjkFont(bytes)
      })(),
    }
    entry.promise.then(
      () => {
        entry.settled = true
      },
      () => {
        entry.settled = true
        if (shared === entry) shared = null
      },
    )
    shared = entry
  }
  const entry = shared
  entry.waiters += 1
  if (onProgress) entry.listeners.add(onProgress)

  return new Promise<CjkFont>((resolve, reject) => {
    let done = false
    const finish = () => {
      done = true
      entry.waiters -= 1
      if (onProgress) entry.listeners.delete(onProgress)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      if (done) return
      finish()
      // 最后一个等待方也走了：中止下载，让下次调用重新发起
      if (entry.waiters === 0 && !entry.settled) {
        entry.controller.abort()
        if (shared === entry) shared = null
      }
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    entry.promise.then(
      (font) => {
        if (done) return
        finish()
        resolve(font)
      },
      (e: unknown) => {
        if (done) return
        finish()
        reject(e)
      },
    )
  })
}

/** 测试用：清掉记忆的字体（模块级状态） */
export function resetCjkFontCache(): void {
  shared = null
}
