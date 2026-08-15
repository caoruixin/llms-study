/**
 * pdf.js v6 在 WebKit(iOS/macOS Safari)上的两个引擎级兼容缺口,各补一个最小 shim。
 * Chrome/Firefox 均原生支持这两个特性,故桌面完全正常、真机 iPhone 逐页失败。
 *
 * 1. ReadableStream 异步迭代协议(`values()` / `Symbol.asyncIterator`)缺失:
 *    pdf.js 主线程直接 `for await (const value of readableStream)` 消费
 *    `getTextContent()` 的流,WebKit 上抛
 *    `undefined is not a function (near '...value of readableStream...')`——
 *    解析(parsePdfBytes 逐页 getTextContent)与文字层全部炸掉。
 *    按 Streams 规范补 read → next、cancel → return、结束/出错释放 reader 锁。
 *    (worker 里唯一的 for await 自带 try/catch 回退,可不管。)
 *
 * 2. `Map/WeakMap.prototype.getOrInsertComputed / getOrInsert`(TC39 upsert 提案,
 *    Chrome 已带、WebKit 未实现)缺失:pdf.js 主线程 16 处 + worker 15 处在用,
 *    渲染必经的 `render → getOptionalContentConfig → cacheSimpleMethod` 首当其冲——
 *    WebKit 上每一页 `page.render()` 都抛
 *    `getOrInsertComputed is not a function`,表现为「每页渲染失败、重试立刻再失败」。
 *
 * 3. `Uint8Array.prototype.toHex / toBase64` 与静态 `Uint8Array.fromBase64`
 *    (TC39 base64/hex 提案,Safari 18.2 才实现——iOS 17.4~18.1 全缺;旧版 Chromium
 *    同样缺)缺失:worker 用 toHex 算文档指纹(getDocument 必经),主线程签名/
 *    图章注解用 toBase64/fromBase64。缺失时解析直接抛 `toHex is not a function`。
 *
 * 主线程在 parsePdf / PdfViewer 使用 pdf.js 前调用;worker 线程经 pdfWorkerEntry.ts
 * 包装入口在官方 worker 脚本评估前调用(workerSrc 指向包装而非官方脚本)。
 */

interface UpsertProto {
  has: (key: unknown) => boolean
  get: (key: unknown) => unknown
  set: (key: unknown, value: unknown) => unknown
  getOrInsert?: (key: unknown, defaultValue: unknown) => unknown
  getOrInsertComputed?: (key: unknown, callback: (key: unknown) => unknown) => unknown
}

function installUpsert(proto: UpsertProto): void {
  // defineProperty + enumerable:false:与原生内建方法的属性语义一致,不污染 for-in
  if (typeof proto.getOrInsert !== 'function') {
    Object.defineProperty(proto, 'getOrInsert', {
      value: function (this: UpsertProto, key: unknown, defaultValue: unknown) {
        if (this.has(key)) return this.get(key)
        this.set(key, defaultValue)
        return defaultValue
      },
      writable: true,
      configurable: true,
    })
  }
  if (typeof proto.getOrInsertComputed !== 'function') {
    Object.defineProperty(proto, 'getOrInsertComputed', {
      value: function (this: UpsertProto, key: unknown, callback: (key: unknown) => unknown) {
        if (this.has(key)) return this.get(key)
        const value = callback(key)
        this.set(key, value)
        return value
      },
      writable: true,
      configurable: true,
    })
  }
}

interface AsyncIterableStreamProto {
  values?: (options?: { preventCancel?: boolean }) => AsyncIterator<unknown>
  [Symbol.asyncIterator]?: (options?: { preventCancel?: boolean }) => AsyncIterator<unknown>
  getReader: () => ReadableStreamDefaultReader<unknown>
}

interface Uint8ArrayCompatProto {
  toHex?: () => string
  toBase64?: (options?: { alphabet?: 'base64' | 'base64url'; omitPadding?: boolean }) => string
}

function installUint8ArrayCompat(): void {
  const proto = Uint8Array.prototype as Uint8ArrayCompatProto
  if (typeof proto.toHex !== 'function') {
    Object.defineProperty(proto, 'toHex', {
      value: function (this: Uint8Array) {
        let s = ''
        for (const b of this) s += b.toString(16).padStart(2, '0')
        return s
      },
      writable: true,
      configurable: true,
    })
  }
  if (typeof proto.toBase64 !== 'function') {
    Object.defineProperty(proto, 'toBase64', {
      value: function (this: Uint8Array, options?: { alphabet?: 'base64' | 'base64url'; omitPadding?: boolean }) {
        // 分块 fromCharCode:一次展开整个数组会撞调用栈参数上限(大图章/签名可到 MB 级)
        let bin = ''
        for (let i = 0; i < this.length; i += 0x8000) {
          bin += String.fromCharCode(...this.subarray(i, i + 0x8000))
        }
        let s = btoa(bin)
        if (options?.alphabet === 'base64url') s = s.replace(/\+/g, '-').replace(/\//g, '_')
        if (options?.omitPadding) s = s.replace(/=+$/, '')
        return s
      },
      writable: true,
      configurable: true,
    })
  }
  const ctor = Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }
  if (typeof ctor.fromBase64 !== 'function') {
    Object.defineProperty(Uint8Array, 'fromBase64', {
      value: function (s: string) {
        const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        return bytes
      },
      writable: true,
      configurable: true,
    })
  }
}

export function ensurePdfCompat(): void {
  installUpsert(Map.prototype as unknown as UpsertProto)
  installUpsert(WeakMap.prototype as unknown as UpsertProto)
  installUint8ArrayCompat()

  const proto = globalThis.ReadableStream?.prototype as AsyncIterableStreamProto | undefined
  if (!proto || typeof proto[Symbol.asyncIterator] === 'function') return

  function values(this: AsyncIterableStreamProto, { preventCancel = false }: { preventCancel?: boolean } = {}) {
    const reader = this.getReader()
    const iterator: AsyncIterableIterator<unknown> = {
      async next() {
        try {
          const r = await reader.read()
          if (r.done) reader.releaseLock()
          return { done: r.done ?? false, value: r.value }
        } catch (e) {
          reader.releaseLock()
          throw e
        }
      },
      async return(value?: unknown) {
        if (preventCancel) {
          reader.releaseLock()
        } else {
          // 规范:先取 cancel promise 再释放锁,最后等 cancel 落地
          const cancel = reader.cancel(value)
          reader.releaseLock()
          await cancel
        }
        return { done: true, value }
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
    return iterator
  }

  proto.values ??= values
  proto[Symbol.asyncIterator] = values
}
