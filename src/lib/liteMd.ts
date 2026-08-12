// 轻量 markdown 辅助：只切代码围栏，行内样式交给渲染层的正则

export type Seg = { type: 'code'; lang: string; text: string; closed: boolean } | { type: 'text'; text: string }

// 按行扫 ``` 围栏；未闭合围栏一直算 code 段到文本末尾——流式中的半截代码块也按代码样式渲染。
// closed 标志（Phase 3 加法）：闭合围栏 true / 到 EOF 仍未闭合 false，
// 供 paper 流式线协议判断岛是否完整；AskDialog 等既有调用方不读该字段，行为不变。
export function splitFences(src: string): Seg[] {
  const segs: Seg[] = []
  let buf: string[] = []
  let inCode = false
  let lang = ''

  const take = () => {
    const text = buf.join('\n')
    buf = []
    return text
  }

  for (const line of src.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (inCode) {
        segs.push({ type: 'code', lang, text: take(), closed: true })
        inCode = false
        lang = ''
      } else {
        const text = take()
        if (text.trim() !== '') segs.push({ type: 'text', text })
        inCode = true
        lang = line.trim().slice(3).trim()
      }
      continue
    }
    buf.push(line)
  }

  if (inCode) {
    segs.push({ type: 'code', lang, text: take(), closed: false })
  } else {
    const text = take()
    if (text.trim() !== '') segs.push({ type: 'text', text })
  }
  return segs
}
