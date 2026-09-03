/**
 * PCM 重采样 / 混单声道 / WAV 编码（纯函数）。
 *
 * 用途是**兜底转码**：若 ASR 上游拒收 webm/mp4 容器（PLAN 风险表「SenseVoice 容器兼容」），
 * recorder 端 decodeAudioData → 这三个函数 → 16k 单声道 WAV 再上传。
 * 60s 16kHz 16bit 单声道 ≈ 1.87MiB，仍在服务端 2MiB 帽内。
 *
 * 三个函数都不改入参，也不碰任何浏览器 API：容器兼容性一旦出问题，
 * 调参与回归都能在 node 单测里做完。
 */

/**
 * 线性插值重采样。语音 ASR 场景够用（不追求抗混叠滤波：SenseVoice 前端自带带限处理，
 * 而 16k 目标率下人声主要能量本就在 8k 以下）。
 * 采样率相同时原样返回同一个实例（全链路只读，不复制）。
 */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0) || input.length === 0) return new Float32Array(0)
  if (fromRate === toRate) return input

  const ratio = fromRate / toRate
  const outLength = Math.max(1, Math.round(input.length / ratio))
  const out = new Float32Array(outLength)
  const last = input.length - 1
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const i0 = Math.min(last, Math.floor(pos))
    const i1 = Math.min(last, i0 + 1)
    const frac = pos - i0
    out[i] = input[i0] + (input[i1] - input[i0]) * frac
  }
  return out
}

/**
 * 多声道下混单声道（等权平均）。声道长度不一致时按最短对齐——
 * AudioBuffer 各声道等长，这个守卫只为不信任的入参兜底。
 */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]

  let length = channels[0].length
  for (const ch of channels) length = Math.min(length, ch.length)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    let sum = 0
    for (const ch of channels) sum += ch[i]
    out[i] = sum / channels.length
  }
  return out
}

/** WAV 头固定 44 字节（RIFF + fmt 16 + data） */
export const WAV_HEADER_BYTES = 44

/**
 * Float32 [-1,1] → 16bit PCM 小端 WAV（单声道）。
 * 负半轴用 0x8000、正半轴用 0x7fff 缩放：满量程 -1 精确落在 -32768，+1 落在 32767，不溢出回绕。
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true) // 除 'RIFF' 与本字段外的全部字节数
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt 块长度（PCM 固定 16）
  view.setUint16(20, 1, true) // 格式 1 = 线性 PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byteRate = 采样率 × 块对齐
  view.setUint16(32, 2, true) // blockAlign = 声道数 × 位深/8
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = WAV_HEADER_BYTES
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return buffer
}
