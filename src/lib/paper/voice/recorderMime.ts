/**
 * 录音容器选型与麦克风错误文案（纯函数，注入 isTypeSupported → node 环境直测）。
 *
 * 为什么要梯子而不是写死 webm：Safari（含 iOS 全部浏览器）的 MediaRecorder 只出 mp4/aac，
 * Chrome/Firefox 只出 webm/opus；服务端按 Content-Type 派生上传文件名的扩展名，
 * 所以 mime 与 ext 必须成对给出（部分 ASR 供应商按扩展名分发解码器）。
 */

export interface RecorderMime {
  /** 传给 MediaRecorder 的 mimeType，同时作为上传的 Content-Type */
  mime: string
  /** 服务端组 multipart 时的文件扩展名（不含点） */
  ext: string
}

/** 优先 opus（同码率下语音质量最好、体积最小），其次裸 webm，最后 Safari 的 mp4 */
export const RECORDER_MIME_LADDER: readonly RecorderMime[] = [
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/webm', ext: 'webm' },
  { mime: 'audio/mp4', ext: 'm4a' },
]

/** 返回 null = 该浏览器一个可用容器都没有（iOS<14.3 无 MediaRecorder），调用方隐藏麦克风球 */
export function pickRecorderMime(isTypeSupported: (t: string) => boolean): RecorderMime | null {
  for (const candidate of RECORDER_MIME_LADDER) {
    let ok = false
    try {
      ok = isTypeSupported(candidate.mime)
    } catch {
      ok = false // 老 Safari 的 isTypeSupported 可能直接抛
    }
    if (ok) return candidate
  }
  return null
}

/** getUserMedia 拒绝原因 → 用户能照做的中文文案（沿 speech.ts 的「麦克风权限被拒绝」口径细化） */
export function micErrorMessage(e: unknown): string {
  const name = typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return '麦克风权限被拒绝，请在浏览器地址栏允许后重试'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有找到可用的麦克风'
    case 'NotReadableError':
    case 'TrackStartError':
      return '麦克风被其他应用占用'
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return '麦克风不支持所需的录音参数，请更换设备后重试'
    case 'AbortError':
      return '麦克风被中断，请重试'
    default: {
      // 部分环境（自动化浏览器 / 旧 WebKit）拒权时抛的不是标准 DOMException 名：
      // 再按 message 关键词捞一次，别把明确的「权限被拒」降级成泛化文案
      const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
      if (/permission|denied|not.?allowed|dismissed/i.test(msg)) {
        return '麦克风权限被拒绝，请在浏览器地址栏允许后重试'
      }
      return '无法访问麦克风，请检查系统与浏览器的麦克风权限'
    }
  }
}

/** 按下时长小于它算「轻点」（锁定免按），否则算「按住说话」 */
export const PRESS_TAP_MS = 300

/**
 * 手势判定：轻点 → toggle（说完再点一下结束），按住 → hold（松手即发）。
 * 时间戳异常（非有限值、时钟倒流）一律判轻点——宁可让麦克风多开一会儿等用户再点，
 * 也不要把一段刚开口的话直接掐掉。
 */
export function classifyPressGesture(downAt: number, upAt: number): 'hold' | 'tap' {
  const dt = upAt - downAt
  if (!Number.isFinite(dt) || dt < 0) return 'tap'
  return dt < PRESS_TAP_MS ? 'tap' : 'hold'
}
