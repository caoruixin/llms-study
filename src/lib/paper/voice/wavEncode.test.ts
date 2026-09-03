import { describe, expect, it } from 'vitest'
import { encodeWavPcm16, mixToMono, resampleLinear, WAV_HEADER_BYTES } from './wavEncode'

const ascii = (view: DataView, offset: number, len: number): string =>
  Array.from({ length: len }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join('')

describe('resampleLinear', () => {
  it('采样率相同 → 原样返回同一实例（不复制）', () => {
    const input = Float32Array.from([0.1, 0.2, 0.3])
    expect(resampleLinear(input, 16000, 16000)).toBe(input)
  })

  it('降采样 2:1 长度减半，线性插值取值正确', () => {
    const input = Float32Array.from([0, 1, 2, 3])
    const out = resampleLinear(input, 32000, 16000)
    expect(out.length).toBe(2)
    expect(Array.from(out)).toEqual([0, 2])
  })

  it('升采样 1:2 长度翻倍，中间点是相邻样本的中值', () => {
    const out = resampleLinear(Float32Array.from([0, 1]), 8000, 16000)
    expect(out.length).toBe(4)
    expect(out[0]).toBeCloseTo(0, 6)
    expect(out[1]).toBeCloseTo(0.5, 6)
    expect(out[2]).toBeCloseTo(1, 6)
  })

  it('48k → 16k：长度按比例，末尾不越界', () => {
    const out = resampleLinear(new Float32Array(4800).fill(0.5), 48000, 16000)
    expect(out.length).toBe(1600)
    expect(out[out.length - 1]).toBeCloseTo(0.5, 6)
  })

  it('空输入 / 非法采样率 → 空数组', () => {
    expect(resampleLinear(new Float32Array(0), 48000, 16000).length).toBe(0)
    expect(resampleLinear(Float32Array.from([1]), 0, 16000).length).toBe(0)
    expect(resampleLinear(Float32Array.from([1]), 48000, 0).length).toBe(0)
  })
})

describe('mixToMono', () => {
  it('单声道原样返回', () => {
    const ch = Float32Array.from([0.1, 0.2])
    expect(mixToMono([ch])).toBe(ch)
  })

  it('双声道等权平均', () => {
    const out = mixToMono([Float32Array.from([1, -1]), Float32Array.from([0, 1])])
    expect(Array.from(out)).toEqual([0.5, 0])
  })

  it('声道长度不一致时按最短对齐', () => {
    const out = mixToMono([Float32Array.from([1, 1, 1]), Float32Array.from([0, 0])])
    expect(out.length).toBe(2)
  })

  it('空入参 → 空数组', () => {
    expect(mixToMono([]).length).toBe(0)
  })
})

describe('encodeWavPcm16 · RIFF 头与长度', () => {
  const samples = Float32Array.from([0, 0.5, -0.5, 1, -1])
  const buffer = encodeWavPcm16(samples, 16000)
  const view = new DataView(buffer)

  it('总长 = 44 字节头 + 每样本 2 字节', () => {
    expect(buffer.byteLength).toBe(WAV_HEADER_BYTES + samples.length * 2)
    expect(WAV_HEADER_BYTES).toBe(44)
  })

  it('RIFF / WAVE / fmt  / data 四个块标记就位', () => {
    expect(ascii(view, 0, 4)).toBe('RIFF')
    expect(ascii(view, 8, 4)).toBe('WAVE')
    expect(ascii(view, 12, 4)).toBe('fmt ')
    expect(ascii(view, 36, 4)).toBe('data')
  })

  it('RIFF 长度字段 = 文件长 - 8，data 长度 = 样本字节数', () => {
    expect(view.getUint32(4, true)).toBe(buffer.byteLength - 8)
    expect(view.getUint32(40, true)).toBe(samples.length * 2)
  })

  it('fmt 块声明 16bit 单声道 PCM，byteRate / blockAlign 自洽', () => {
    expect(view.getUint32(16, true)).toBe(16) // fmt 块长度
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // 单声道
    expect(view.getUint32(24, true)).toBe(16000) // 采样率
    expect(view.getUint32(28, true)).toBe(16000 * 2) // byteRate
    expect(view.getUint16(32, true)).toBe(2) // blockAlign
    expect(view.getUint16(34, true)).toBe(16) // 位深
  })

  it('样本按 16bit 小端写入，满量程不溢出回绕', () => {
    expect(view.getInt16(WAV_HEADER_BYTES, true)).toBe(0)
    expect(view.getInt16(WAV_HEADER_BYTES + 2, true)).toBe(Math.trunc(0.5 * 0x7fff))
    expect(view.getInt16(WAV_HEADER_BYTES + 4, true)).toBe(Math.trunc(-0.5 * 0x8000))
    expect(view.getInt16(WAV_HEADER_BYTES + 6, true)).toBe(32767)
    expect(view.getInt16(WAV_HEADER_BYTES + 8, true)).toBe(-32768)
  })

  it('超出 [-1,1] 的样本被钳制而不是回绕', () => {
    const clipped = new DataView(encodeWavPcm16(Float32Array.from([2, -2]), 8000))
    expect(clipped.getInt16(WAV_HEADER_BYTES, true)).toBe(32767)
    expect(clipped.getInt16(WAV_HEADER_BYTES + 2, true)).toBe(-32768)
  })

  it('零样本也产出合法的 44 字节空 WAV', () => {
    const empty = encodeWavPcm16(new Float32Array(0), 16000)
    expect(empty.byteLength).toBe(44)
    expect(new DataView(empty).getUint32(40, true)).toBe(0)
  })

  it('60s 16k 单声道 ≈ 1.83MiB，仍在服务端 2MiB 帽内', () => {
    const bytes = WAV_HEADER_BYTES + 16000 * 60 * 2
    expect(bytes).toBeLessThan(2 * 1024 * 1024)
  })
})
