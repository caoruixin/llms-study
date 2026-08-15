import { afterEach, describe, expect, it } from 'vitest'
import { ensurePdfCompat } from './pdfCompat'

/**
 * node 的 ReadableStream 原生支持异步迭代,polyfill 在这里天然 no-op。
 * 因此用「缺失 asyncIterator 的假 ReadableStream」还原 WebKit 的处境,
 * 验证补齐后 for await 可用、reader 锁被释放、原生实现绝不被覆盖。
 */

const RealReadableStream = globalThis.ReadableStream

class FakeReader {
  private i = 0
  released = false
  cancelled = false
  constructor(private chunks: unknown[]) {}
  read() {
    return this.i < this.chunks.length
      ? Promise.resolve({ done: false, value: this.chunks[this.i++] })
      : Promise.resolve({ done: true, value: undefined })
  }
  releaseLock() {
    this.released = true
  }
  cancel() {
    this.cancelled = true
    return Promise.resolve()
  }
}

/** 模拟 WebKit:有 getReader,无 values / Symbol.asyncIterator */
class FakeStream {
  reader: FakeReader
  constructor(chunks: unknown[]) {
    this.reader = new FakeReader(chunks)
  }
  getReader() {
    return this.reader
  }
}

afterEach(() => {
  ;(globalThis as { ReadableStream: unknown }).ReadableStream = RealReadableStream
})

describe('ensurePdfCompat', () => {
  it('为缺失异步迭代的 ReadableStream 补齐 for await 消费能力', async () => {
    ;(globalThis as { ReadableStream: unknown }).ReadableStream = FakeStream
    ensurePdfCompat()

    const stream = new FakeStream(['a', 'b', 'c'])
    const seen: unknown[] = []
    for await (const chunk of stream as unknown as AsyncIterable<unknown>) seen.push(chunk)

    expect(seen).toEqual(['a', 'b', 'c'])
    // 规范:迭代正常结束(done)后必须释放 reader 锁
    expect(stream.reader.released).toBe(true)
  })

  it('提前 break 时 cancel 流并释放锁(return 语义)', async () => {
    ;(globalThis as { ReadableStream: unknown }).ReadableStream = FakeStream
    ensurePdfCompat()

    const stream = new FakeStream(['a', 'b', 'c'])
    for await (const chunk of stream as unknown as AsyncIterable<unknown>) {
      void chunk
      break
    }
    expect(stream.reader.cancelled).toBe(true)
    expect(stream.reader.released).toBe(true)
  })

  it('为 Map/WeakMap 补齐 getOrInsert / getOrInsertComputed(WebKit 缺失的 upsert 提案)', () => {
    ensurePdfCompat()
    type Upsert<K, V> = {
      getOrInsert: (key: K, value: V) => V
      getOrInsertComputed: (key: K, cb: (key: K) => V) => V
    }
    const map = new Map<string, number>() as Map<string, number> & Upsert<string, number>

    expect(map.getOrInsertComputed('a', () => 1)).toBe(1)
    // 已有键:不再调用回调,返回既有值
    expect(map.getOrInsertComputed('a', () => 99)).toBe(1)
    expect(map.getOrInsert('b', 2)).toBe(2)
    expect(map.getOrInsert('b', 99)).toBe(2)

    const wm = new WeakMap<object, string>() as WeakMap<object, string> & Upsert<object, string>
    const k = {}
    expect(wm.getOrInsertComputed(k, () => 'x')).toBe('x')
    expect(wm.getOrInsertComputed(k, () => 'y')).toBe('x')
    // 补丁属性不可枚举:不污染 for-in / Object.keys 语义
    expect(Object.keys(Map.prototype)).not.toContain('getOrInsertComputed')
  })

  it('为 Uint8Array 补齐 toHex / toBase64 / fromBase64(iOS 17.4~18.1 缺失)', () => {
    ensurePdfCompat()
    type U8Compat = Uint8Array & { toHex: () => string; toBase64: (o?: { omitPadding?: boolean }) => string }
    const bytes = new Uint8Array([0, 1, 0xab, 0xff]) as U8Compat
    expect(bytes.toHex()).toBe('0001abff')
    expect(bytes.toBase64()).toBe('AAGr/w==')

    const from = (Uint8Array as unknown as { fromBase64: (s: string) => Uint8Array }).fromBase64
    expect([...from('AAGr/w==')]).toEqual([0, 1, 0xab, 0xff])
    // 与 pdf.js 的用法闭环:toBase64 → fromBase64 round-trip
    const big = new Uint8Array(70000).map((_, i) => i % 251) as U8Compat
    expect([...from(big.toBase64())]).toEqual([...big])
  })

  it('原生已支持异步迭代时不做任何改动', () => {
    // TS 的 DOM lib 尚未声明 ReadableStream 的 asyncIterator,运行时(node)是有的
    const proto = RealReadableStream.prototype as unknown as Record<symbol, unknown>
    const native = proto[Symbol.asyncIterator]
    expect(typeof native).toBe('function')
    ensurePdfCompat()
    expect(proto[Symbol.asyncIterator]).toBe(native)
  })
})
