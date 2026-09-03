/**
 * 麦克风 MediaStream 的模块级引用计数单例（形制同 gatewaySingleton.ts）。
 *
 * 为什么必须共用一条流：悬浮球与面板内的 🎙 听写是两个组件，各自 getUserMedia 会
 * (a) 在部分浏览器上二次弹权限、(b) 让两条流同时占用采集设备（Windows 上直接
 * NotReadableError）、(c) 让「谁来 stop」变成没有答案的问题。
 *
 * StrictMode 双挂安全：acquire/release 成对计数，归零才真正 stop() 轨道；
 * 开发期的「挂载→卸载→再挂载」最多多做一次 getUserMedia（权限已授时无提示、无声）。
 *
 * 轨道被外部终止（用户在系统设置里撤权、拔掉 USB 麦）后不能再复用：
 * acquire 时校验 readyState，已死就整体重建。
 */

/** 语音链路的采集约束：回声消除是半双工之外的第二道防回环保险（PLAN 风险表「回声」） */
const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
}

let pending: Promise<MediaStream> | null = null
let current: MediaStream | null = null
let refCount = 0

const isLive = (s: MediaStream | null): boolean =>
  s !== null && s.getAudioTracks().some((t) => t.readyState === 'live')

function hardReset(): void {
  current?.getTracks().forEach((t) => t.stop())
  current = null
  pending = null
  refCount = 0
}

export async function acquireStream(): Promise<MediaStream> {
  if (current !== null && !isLive(current)) hardReset() // 轨道已死（撤权/拔设备）：重来

  refCount += 1
  pending ??= navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS).then((s) => {
    current = s
    return s
  })

  try {
    return await pending
  } catch (e) {
    // 失败不留残局：下一次按下要能重新发起（用户刚在弹窗里点了允许）
    refCount = Math.max(0, refCount - 1)
    if (refCount === 0) pending = null
    throw e
  }
}

export function releaseStream(): void {
  refCount = Math.max(0, refCount - 1)
  if (refCount > 0) return
  hardReset() // 归零必停轨道：浏览器标签上的录音红点必须随之熄灭
}

/** 切论文 / 卸载 / 标签页 hidden 的兜底归位：无视计数直接收麦 */
export function releaseAllStreams(): void {
  hardReset()
}

/** 仅供调试与单测观察 */
export function streamRefCount(): number {
  return refCount
}
