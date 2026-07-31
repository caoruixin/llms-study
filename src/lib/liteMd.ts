// 轻量 markdown 辅助：只切代码围栏，行内样式交给渲染层的正则

export type Seg = { type: 'code'; lang: string; text: string } | { type: 'text'; text: string }

// 按行扫 ``` 围栏；未闭合围栏一直算 code 段到文本末尾——流式中的半截代码块也按代码样式渲染
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
        segs.push({ type: 'code', lang, text: take() })
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
    segs.push({ type: 'code', lang, text: take() })
  } else {
    const text = take()
    if (text.trim() !== '') segs.push({ type: 'text', text })
  }
  return segs
}
