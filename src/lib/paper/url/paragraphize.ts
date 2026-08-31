/**
 * 「散落文本包段」pass：URL 导入正文在 sanitize 之前的结构规整（碰 DOM，happy-dom 可测）。
 *
 * 背景：微信公众号排版把正文文字嵌在 <section>（甚至多层嵌套）里。后续两步都会毁掉它：
 *   1. sanitizeArticleHtml（DOMPurify）unwrap 白名单外的 <section> 时，文本无分隔符
 *      直接拼接——段落边界一旦丢失不可恢复（中文没有空格分词，尤其致命）；
 *   2. normalizeHtml 的 extractBlocks 只收块级标签（BLOCK_TAGS），散落在容器里的
 *      裸文本会被整段丢弃。
 * 因此必须**在 sanitize 之前**，把每个容器内「连续的文本节点/非块级元素 run」就地
 * 包进 <p>，用块级边界固化段落结构。Readability 输出本就是 <p> 结构 → arxiv 路径近似 no-op。
 *
 * 已知限制（v1 接受）：同一 section 内用 <br> 分行的文字会合成一段。
 */

/** 视为块级边界的标签：run 在它们处截断，且它们自身不会被包进 <p> */
const BLOCKISH = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'UL', 'OL', 'TABLE', 'PRE', 'BLOCKQUOTE', 'FIGURE', 'DIV', 'SECTION', 'HR',
])

function isBlockish(node: Node): boolean {
  return node.nodeType === Node.ELEMENT_NODE && BLOCKISH.has((node as Element).tagName)
}

/** run 的有效文本：只数文本节点与元素（注释等其他节点不算，避免注释造出空 <p>） */
function runText(run: Node[]): string {
  let text = ''
  for (const n of run) {
    if (n.nodeType === Node.TEXT_NODE || n.nodeType === Node.ELEMENT_NODE) text += n.textContent ?? ''
  }
  return text
}

/** 把 container 直接子级里连续的非块级 run（有非空白文本的）就地包进 <p> */
function wrapLooseRuns(container: Element, doc: Document): void {
  // 先快照 childNodes 再分组收集 run，最后统一挪动——边遍历 live NodeList 边改 DOM 是经典脚枪
  const children = Array.from(container.childNodes)
  const runs: Node[][] = []
  let current: Node[] = []
  for (const node of children) {
    if (isBlockish(node)) {
      if (current.length) runs.push(current)
      current = []
    } else {
      current.push(node)
    }
  }
  if (current.length) runs.push(current)

  for (const run of runs) {
    // 纯空白 run（块级元素之间的排版空白）不动，避免制造空 <p>
    if (!runText(run).trim()) continue
    const p = doc.createElement('p')
    // 在 run 首节点原位插入 <p>，再把整个 run 挪进去 → 保持文档顺序不变
    container.insertBefore(p, run[0])
    for (const node of run) p.appendChild(node)
  }
}

export function paragraphizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  // 静态快照即可：包 <p> 不会新增容器元素，嵌套 section>section 也已都在快照里
  const containers: Element[] = [doc.body, ...Array.from(doc.body.querySelectorAll('div,section,blockquote'))]
  for (const container of containers) wrapLooseRuns(container, doc)
  return doc.body.innerHTML
}
