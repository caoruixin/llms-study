// Web Speech API 语音听写封装（Chrome webkitSpeechRecognition），不可用时由调用方降级为文本输入

interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: { error?: string }) => void) | null
  onend: (() => void) | null
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

function getRecognitionCtor(): (new () => RecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => RecognitionLike) | null
}

export function isSpeechSupported(): boolean {
  return getRecognitionCtor() !== null
}

export interface DictationSession {
  stop: () => void
}

export function startDictation(
  lang: 'zh' | 'en',
  onText: (finalText: string, interimText: string) => void,
  onEnd: (error?: string) => void,
): DictationSession | null {
  const Ctor = getRecognitionCtor()
  if (!Ctor) {
    onEnd('当前浏览器不支持语音识别，请使用 Chrome，或改用文本输入')
    return null
  }
  const rec = new Ctor()
  rec.lang = lang === 'en' ? 'en-US' : 'zh-CN'
  rec.continuous = true
  rec.interimResults = true

  rec.onresult = (e) => {
    let finalText = ''
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]
      if (r.isFinal) finalText += r[0].transcript
      else interim += r[0].transcript
    }
    onText(finalText, interim)
  }
  rec.onerror = (e) => onEnd(e.error === 'not-allowed' ? '麦克风权限被拒绝' : `语音识别错误：${e.error ?? '未知'}`)
  rec.onend = () => onEnd()
  rec.start()
  return { stop: () => rec.stop() }
}
