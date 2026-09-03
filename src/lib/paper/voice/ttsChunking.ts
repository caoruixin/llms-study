/**
 * 云端 TTS 的分片策略（纯函数）。
 *
 * 两个互相拉扯的目标，用「首句单发 + 其余合并」一次性摆平：
 * - **TTFA**：回答第一句必须立刻出声（首音延迟 2.5-6s 已经是这条链路最痛的地方），
 *   所以 isFirst 时第一句原样放行，哪怕只有几个字；
 * - **调用数**：一条回答 4-8 次 TTS 调用就会啃掉专属令牌桶，后续句子合并到 ≥minChars
 *   再发，句间停顿也更自然（逐句发音的机械感主要来自每句都重新起调）。
 *
 * 永不切开句子内部：入参已是 tts.takeCompleteSentences 的产物，句子是最小不可分单位。
 */

/** 合并目标下限：低于它就继续攒（除非句子已用完） */
export const TTS_MIN_GROUP_CHARS = 60
/** 单次请求硬上限：服务端 /tts body ≤8KiB 且 text ≤400 字，留足余量 */
export const TTS_MAX_GROUP_CHARS = 320

export interface TtsGroupOpts {
  /** 本轮的第一批句子：第一句单独成组压 TTFA */
  isFirst: boolean
  minChars?: number
  maxChars?: number
}

/** 中日韩收尾标点后直接拼接，其余（英文句号等）补一个空格，避免 "one.Two" 连读 */
const CJK_TAIL = /[。！？；：、，…”’）】》」』]$/

function joinPieces(head: string, tail: string): string {
  return CJK_TAIL.test(head) ? head + tail : `${head} ${tail}`
}

export function groupSentencesForTts(sentences: readonly string[], opts: TtsGroupOpts): string[] {
  const minChars = opts.minChars ?? TTS_MIN_GROUP_CHARS
  const maxChars = opts.maxChars ?? TTS_MAX_GROUP_CHARS
  const list = sentences.map((s) => s.trim()).filter((s) => s !== '')
  if (list.length === 0) return []

  const out: string[] = []
  let rest = list
  if (opts.isFirst) {
    out.push(list[0])
    rest = list.slice(1)
  }

  let cur = ''
  for (const s of rest) {
    if (cur === '') {
      cur = s
    } else {
      const merged = joinPieces(cur, s)
      if (merged.length > maxChars) {
        // 装不下就先把攒好的发出去，当前句另起一组（单句超长时它自己独占一组）
        out.push(cur)
        cur = s
      } else {
        cur = merged
      }
    }
    if (cur.length >= minChars) {
      out.push(cur)
      cur = ''
    }
  }
  if (cur !== '') out.push(cur)
  return out
}

/**
 * 剥离供应商特殊标记：CosyVoice 的 `<|endofprompt|>` 一类记号在 input 里有指令语义，
 * 原样发过去会被当控制符解释（轻则读出怪音，重则改变音色）。
 */
export function stripTtsMarkers(text: string): string {
  return text
    .replace(/<\|[\s\S]*?\|>/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
