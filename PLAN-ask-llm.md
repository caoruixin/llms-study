# 圈选文字 → Ask LLM 悬浮答疑 — 实施计划(v3,经 codex 两轮评审修订)

> **进度(2026-07-31):全部交付完成,P0/P1 清零。** lib 层 + 组件层由专职 opus agent 实现;QA agent 经 claude-in-chrome + 真实 DeepSeek API 完成两轮 E2E(首轮 26 项清单 24 PASS,发现 2 P0 / 1 P1 / 3 P2;修复后复测 6/6 PASS,新 P0/P1 = 0,控制台零错误)。终态:`npm run typecheck` 干净,`npm test` 69/69(28 旧 + 41 新),`npm run build` 通过。详见文末「E2E 交付记录」。

## Context

站点(LLM Infra Studio 面试备战台)内容术语密集,用户在缺乏扎实 LLM 理论基础时阅读吃力,目前只能把术语 copy-paste 到 Claude/ChatGPT 来回跳转提问。项目已打通 LLM API(Vite dev 代理 + `.env.local` key 注入),因此在站内直接做「圈选即问」答疑交互:

- 鼠标圈选页面正文文字 → 选区附近浮出「Ask LLM」小按钮
- 点击 → 弹出**可拖拽**的聊天对话框(不挡视线),圈选内容作为引用上下文
- 对话框内可**多轮连续追问**,全部历史随每次请求带给 LLM
- **纯临时会话**(用户已确认):关闭对话框即丢弃上下文;下次圈选 = 全新对话。不做历史列表、不做持久化
- **流式输出**(用户已确认):打字机效果,llmClient 新增 SSE 流式函数
- 对话框未关闭时再次圈选 → 新圈选作为追加引用注入当前对话
- **范围决策**:圈选仅覆盖页面渲染正文(document selection);textarea/input 内的选区**明确忽略**(用户自己打的字无需答疑,且必须防止设置页密码框中的 API key 被引用外发)

## 现状基线(已核实)

- Vite 6 + React 18 + TS(strict + noUnusedLocals/Parameters)+ HashRouter + Tailwind v4 + zustand;framer-motion 已是依赖;深色主题 CSS 变量 ink/panel/panel-2/line/accent/dim;卡片惯例 `rounded-xl border border-line bg-panel`
- `src/App.tsx`:唯一共享布局,sticky header `z-40`,内含 `const NAV`
- `src/lib/llmClient.ts`:`chatComplete`(非流式)、`LlmError`(auth/rate-limit/timeout/network/bad-response/server)、`extractContent`;401/403→auth、429→rate-limit、!ok→server;120s 超时基线(兼容思考模型)
- `src/store.ts`:`PROVIDERS`(4 家 OpenAI 兼容)、`useSettings`(userKey 在 sessionStorage);调用范式 `src/pages/InterviewPage.tsx:110-163`
- 代理透传 body,SSE 传输层无障碍;LLM 功能仅 `npm run dev` 可用(既有限制)
- 全仓无 modal/portal/浮层/markdown 依赖 → 全部新建,**零新增 npm 依赖**
- vitest `environment: 'node'`(Node ≥18:fetch/Response/ReadableStream 全局可用,可 stub `globalThis.fetch`);tsconfig 无 node types(timer 用 `ReturnType<typeof setTimeout>`)

## 文件清单

```
新增  src/nav.ts                           NAV 常量(自 App.tsx 迁出,避免 App↔SelectionAsk 循环导入)
新增  src/lib/sse.ts                       纯函数 SSE 事件解析器 + delta 提取(node 可测)
新增  src/lib/sse.test.ts
新增  src/lib/liteMd.ts                    纯函数代码围栏切分(node 可测)
新增  src/lib/liteMd.test.ts
新增  src/lib/llmClient.test.ts            chatStream 单测(stub globalThis.fetch)
新增  src/components/ask/SelectionAsk.tsx  编排:选区监听、浮动按钮、会话状态与竞态防护
新增  src/components/ask/AskDialog.tsx     展示:可拖拽对话框、消息列表、输入区
修改  src/lib/llmClient.ts                 新增 chatStream()
修改  src/App.tsx                          改从 nav.ts 导入 NAV;import 并挂载 <SelectionAsk />
```

状态全部在 SelectionAsk 内的 React state(纯临时,不进 zustand、不落盘)。

## Step 1 — `src/lib/sse.ts`(纯函数,先行 + 单测)

```ts
export interface SseParser { push(chunk: string): string[]; flush(): string[] }
export function createSseParser(): SseParser
export function extractStreamDelta(data: unknown): string | null
export function extractStreamError(data: unknown): string | null
```

**按 SSE 事件(而非行)解析**:内部 buffer 按 `\n` 切行(尾段留 buffer,去尾 `\r`);逐行累积**当前事件**的 `data:` 字段(`slice(5)`,去单个前导空格),**空行为事件边界**——emit 该事件所有 data 行以 `\n` join 的 payload(含 `[DONE]` 原样);`:` 注释/`event:`/`id:` 行跳过。`flush()`:处理残留行后,若当前事件有未 emit 的 data 一并 emit。`extractStreamDelta`:逐层守卫读 `choices[0].delta.content`(首帧可能 role-only;尾部 usage 帧 `choices` 可为空数组;忽略 `reasoning_content`),缺失返回 `null`。`extractStreamError`:读 `error.message`(或 `error` 为字符串),无则 `null`。

单测:单事件单行/一 chunk 多事件/事件跨 chunk 断开/**多 `data:` 行合并**/CRLF/`[DONE]` 透传/注释与 event 行忽略/末尾无换行 flush 收尾/role-only 帧/空 choices 帧/正常 delta/error 帧提取。

## Step 2 — `chatStream()` 加入 `src/lib/llmClient.ts`

```ts
export interface ChatStreamOptions {
  provider: ProviderId; model: string; userKey?: string
  messages: ChatMessage[]
  signal?: AbortSignal            // 外部中止(Stop/Close 均走此,语义区分在调用方)
  firstByteTimeoutMs?: number     // 默认 120_000,fetch 前启动,首个 chunk 到达即换挡
  idleTimeoutMs?: number          // 默认 30_000,首字节后帧间空闲超时,每次 read 重置
  onDelta: (delta: string) => void
}
export async function chatStream(opts: ChatStreamOptions): Promise<string>  // 返回累计全文
```

- preset 查找 / `X-User-Key` 头与 `chatComplete` 一致;body `{ model, messages, temperature: 0.7, stream: true }`
- **双段超时**:fetch **前**启动 120s 首字节计时器(对齐现有思考模型基线);收到首个 chunk 后改为 30s 帧间空闲计时器,每次 `read()` 返回后重置;超时置 `timedOut` 再 abort 内部 controller。`opts.signal` abort → abort 内部
- 状态码→LlmError 映射与 `chatComplete` 相同(4 行复制);`res.body === null` → bad-response;`content-type` 含 JSON(厂商忽略 stream)→ 整体 `extractContent` 兜底(受首字节 120s 计时器保护),一次 `onDelta(full)` 后返回
- 读循环:`decoder.decode(value, {stream:true})` → `parser.push`;payload `[DONE]` → **先 `reader.cancel()` 关闭连接**(上游发完哨兵可能不主动断开)再返回累计;否则 `JSON.parse`(坏 payload 跳过);**`extractStreamError` 命中 → 无条件抛 `LlmError('server', msg)`**(无论是否已有累计——半截内容的取舍交给调用方);否则 delta 累计 + `onDelta`。流自然结束:`flush()` 的 payload 走同一处理;有累计则返回,否则 `LlmError('bad-response', '流式返回为空')`
- catch:`LlmError` 原样抛;AbortError 且 `opts.signal?.aborted` → **正常 resolve 返回已累计文本**(调用方区分 Stop 保留 / Close 丢弃);`timedOut` → timeout;其余 → network。finally 清计时器、release reader

**`src/lib/llmClient.test.ts`**(stub `globalThis.fetch`,用 `ReadableStream`+`TextEncoder` 造流,`afterEach` 还原):正常多帧流式(onDelta 序列 + 返回全文)/`[DONE]` 终止(含上游不断开也能收尾)/外部 abort → resolve 部分文本/流中 error 帧(有累计后出现也抛 server)/JSON 兜底(content-type: application/json)/401 → auth/`res.body` null → bad-response/**fake timers(`vi.useFakeTimers`)覆盖双段超时**:首字节超时抛 timeout、首帧后切换为帧间 idle、每帧续期不误杀。

## Step 3 — `src/lib/liteMd.ts`(轻量渲染辅助 + 单测)

```ts
export type Seg = { type: 'code'; lang: string; text: string } | { type: 'text'; text: string }
export function splitFences(src: string): Seg[]
```

按行扫 ``` 围栏;**未闭合围栏一直算 code 段到文本末尾**(流式中的半截代码块实时按代码样式渲染)。行内 `` `code` ``/`**bold**` 在 AskDialog 渲染时用一个正则 split 映射 `<code>`/`<strong>`。单测:纯文本/带语言围栏/无语言围栏/多围栏/未闭合围栏/围栏后接文本。

## Step 4 — `src/components/ask/AskDialog.tsx`(展示组件)

```ts
export interface AskMsg {
  id: number; role: 'user' | 'assistant'; content: string
  quoted?: boolean      // 引用卡
  pending?: boolean     // 流式中的助手占位消息
}
interface Props {
  messages: AskMsg[]
  busy: boolean                    // 流式请求进行中
  error: string
  errorKind: LlmErrorKind | null   // 'auth' 时附「去设置」Link
  onSend: (text: string) => void
  onStop: () => void
  onClose: () => void
}
```

- 结构:全屏约束层 + 对话框
  ```tsx
  <div ref={constraintsRef} className="pointer-events-none fixed inset-0 z-50">
    <motion.div drag dragListener={false} dragControls={controls}
      dragMomentum={false} dragElastic={0} dragConstraints={constraintsRef}
      data-ask-ui role="dialog" aria-labelledby="ask-title" aria-modal="false"
      className="pointer-events-auto absolute bottom-6 right-6 flex max-h-[70vh]
                 w-[min(560px,calc(100vw-2rem))] flex-col rounded-xl border border-line bg-panel shadow-2xl">
  ```
  初始固定右下角(通常避开正文阅读区;真挡住了可拖走,不承诺绝对不遮挡);**仅标题栏可拖**(`useDragControls`,header `onPointerDown={(e)=>controls.start(e)}` + `cursor-move select-none touch-none`);**关闭按钮 `onPointerDown={(e)=>e.stopPropagation()}`** 防拖拽手势吃掉 click;`dragConstraints` 限制视口内;开着期间 drag 位置跨消息保持;`z-50` > header `z-40`
- 标题栏:`<span id="ask-title">Ask LLM</span>` + busy 状态小圆点(`aria-live="polite"` 文案「回答中…」)+ 关闭按钮(`aria-label="关闭对话"`)
- 消息列表:`flex-1 overflow-y-auto p-4 space-y-3`。`quoted` → 引用卡(`border-l-2 border-accent bg-panel-2 text-dim text-xs whitespace-pre-wrap break-words`,`max-h-32 overflow-y-auto`);普通用户消息右对齐 `bg-accent/15 whitespace-pre-wrap break-words`(多段引用与 Shift+Enter 多行提问保留换行,长 URL 不横向溢出);助手消息经 `splitFences` 渲染(text 段 `whitespace-pre-wrap text-sm`,code 段 `<pre class="overflow-x-auto rounded-md bg-ink p-3 text-xs">`);`pending && content===''` 的占位消息渲染「…」脉冲。**没有独立 streaming 气泡——流式文本直接写进占位消息**(见 Step 5),本组件纯展示
- 自动滚动:`listRef` + `stickRef`(默认 true);`onScroll` 距底 <48px 判定粘底;`useEffect([messages])` 粘底时 `scrollTop = scrollHeight`(占位消息内容变化即触发;用户上翻不抢滚动)
- 输入区:`<textarea rows={2}>` 自动聚焦;Enter 且非 shiftKey 且非 `e.nativeEvent.isComposing`(中文输入法守卫)**且 `!busy`**(流式中 Enter 不触发第二次请求,预打字保留在输入框)→ preventDefault + 发送;**发送前 `trim()` 校验 → 快照文本 → 立即清空 textarea → `onSend(text)`**(失败不回填,错误行可见);发送按钮 `busy || !text.trim()` 禁用;busy 时显示 Stop 按钮;textarea busy 期间保持可输入(可预打字)
- 键盘:对话框内按 Esc → `onClose`(在根 div `onKeyDown` 处理)
- 错误行在输入区上方:`text-bad text-xs`;`errorKind === 'auth'` 时附 `<Link to="/settings">去设置</Link>`

## Step 5 — `src/components/ask/SelectionAsk.tsx`(编排组件)

State:`btn: {x, y, snippet} | null`、`open`、`messages: AskMsg[]`、`busy`、`error`/`errorKind`;refs:`abortRef`、**`sessionRef = useRef(0)`(会话代数,竞态防护核心)**、`idRef`(消息自增 id);读 `useSettings()` 与 `useLocation()`。

**竞态防护(P0)**:两层约束——
1. **会话代数**:`send()` 开始时快照 `const gen = sessionRef.current`;此后每一次 state 写入(onDelta、成功收尾、catch、finally)都先校验 `gen === sessionRef.current`,不等则直接丢弃。
2. **单会话单 in-flight**:`send()` 开头硬守卫 `if (busy || abortRef.current) return`(与 AskDialog 的 Enter `!busy` 检查双保险,杜绝流式中/Stop 未 settle 时并发第二个请求);`finally` 仅在 `abortRef.current === ctrl`(所有权匹配)时才清 busy 与 abortRef。

Close 顺序:先 `sessionRef.current++`,再 `const old = abortRef.current; abortRef.current = null; old?.abort()`,再清 state——旧 `send()` 恢复执行时代数与所有权都不匹配,无任何副作用;新会话也不会被旧 in-flight 守卫拦住。

**选区监听** — 单个 `useEffect(() => {...}, [])`,handler 与 **`timer` 变量**都在 effect 内声明,cleanup 移除监听 + `clearTimeout(timer)`(StrictMode 安全);每次 pointerup 先 clear 旧 timer 再排新的:

- `document 'pointerup'`:target 为 Element 且 `closest('[data-ask-ui]')` → 忽略;**target 为(或位于)`textarea` / `input` → 忽略**(范围决策:表单控件选区不支持,密码框 API key 绝不可能被引用);`timer = setTimeout(0)` 后读 `window.getSelection()`:要求非 collapsed、`rangeCount > 0`、`toString().trim().length >= 2`;`anchorNode` Element 化后再查一次 `closest('[data-ask-ui]')` 与表单控件;取 `getRangeAt(0).getBoundingClientRect()` 定位:
  ```ts
  const x = Math.min(Math.max(r.left + r.width / 2 - 44, 8), window.innerWidth - 96)
  const y = r.top > 96 ? r.top - 38 : r.bottom + 8   // 顶部不够翻到选区下方
  setBtn({ x, y, snippet })
  ```
- `document 'selectionchange'`:选区空/collapsed → clear timer + `setBtn(null)`(覆盖点击他处、Esc、路由跳转)
- `window 'scroll'`(`capture: true, passive: true`):clear timer + 隐藏按钮

**浮动按钮**(`btn !== null` 时渲染):`position: fixed` 于 `(btn.x, btn.y)`,`data-ask-ui`、`z-50`、`aria-label="就选中内容提问"`,样式 `rounded-md border border-line bg-panel-2 px-2.5 py-1 text-xs text-accent shadow-lg`;`onPointerDown={(e)=>e.preventDefault()}`(防选区塌陷/抢焦点);snippet 在按钮出现时已快照进 state,`onAsk` 不读活选区。

**`onAsk`**(对话框开着时 = 追加引用):

```ts
const selected = btn                      // strict 下 btn 为 X | null,先快照收窄
if (!selected) return
const pageLabel = NAV.find((n) => n.to === pathname)?.label ?? pathname
const quote: AskMsg = { id: nextId(), role: 'user', quoted: true,
  content: `我在「${pageLabel}」页选中了以下内容：\n"""\n${selected.snippet.slice(0, 4000)}\n"""` }
setMessages((m) => (open ? [...m, quote] : [quote]))
setOpen(true); setError(''); setErrorKind(null); setBtn(null)
```

不自动发送——引用卡先可见,用户接着输入问题。页面上下文随每条引用消息携带,system prompt 静态。**流式中追加引用是安全的**:占位消息已在列表末尾之前插入(见下),新引用排在占位之后,时序天然正确;它只影响下一轮请求。

**System prompt**(模块常量,中文):

```
你是「LLM Infra Studio」站内答疑助手。这个站点用于准备 LLM 基础设施 /
Token 与算力售前方向的面试，用户会框选页面上的内容并向你提问。
回答要求：
- 中文作答，面向面试表达：先给一句简明结论，再展开关键机制与取舍；
- 适当补充数量级、成本与业务视角（这是售前面试的加分项）；
- 严格围绕引用的选中内容作答，不确定的信息明确说明，不要编造；
- 代码、公式、配置用 markdown 代码块，保持简洁。
```

**`send(text)`(占位消息流式,P0 时序修复)**:

```ts
if (busy || abortRef.current) return                        // 单 in-flight 硬守卫
const gen = sessionRef.current
const userMsg: AskMsg = { id: nextId(), role: 'user', content: text }
const holderId = nextId()
const history = [...messages, userMsg]                      // 本轮请求上下文快照
setMessages((m) => [...m, userMsg, { id: holderId, role: 'assistant', content: '', pending: true }])
setBusy(true); setError(''); setErrorKind(null)
const ctrl = new AbortController(); abortRef.current = ctrl
try {
  const full = await chatStream({
    provider: settings.provider, model: settings.model,
    userKey: settings.userKey || undefined,
    messages: [{ role: 'system', content: SYSTEM_PROMPT },
               ...history.map(({ role, content }) => ({ role, content }))],
    signal: ctrl.signal,
    onDelta: (d) => { if (gen !== sessionRef.current) return
      setMessages((m) => m.map((x) => x.id === holderId ? { ...x, content: x.content + d } : x)) },
  })
  if (gen !== sessionRef.current) return
  setMessages((m) => full
    ? m.map((x) => x.id === holderId ? { ...x, content: full, pending: false } : x)
    : m.filter((x) => x.id !== holderId))                   // 空回答移除占位
} catch (e) {
  if (gen !== sessionRef.current) return
  const { msg, kind } = friendlyError(e)                    // LlmError 按 kind;auth 附设置指引
  setError(msg); setErrorKind(kind)
  setMessages((m) => m.map((x) => x.id === holderId && x.content
    ? { ...x, pending: false } : x).filter((x) => !(x.id === holderId && !x.content)))
  // 流中 error 帧:半截内容保留为普通消息 + 错误行提示「响应中断」;无内容则移除占位
} finally {
  if (abortRef.current === ctrl) {                          // 所有权匹配才收尾
    if (gen === sessionRef.current) setBusy(false)
    abortRef.current = null
  }
}
```

每轮携带全量历史。**Stop** = `abortRef.current?.abort()`(不动 sessionRef → chatStream resolve 部分文本 → 占位转正保留半截)。**Close** = `sessionRef.current++` → `const old = abortRef.current; abortRef.current = null; old?.abort()` → 清空 messages/busy/error/errorKind → `setOpen(false)`(旧请求任何后续写入被代数+所有权校验丢弃,「关掉即忘」严格成立)。

## Step 6 — `src/nav.ts` + `src/App.tsx`

1. 新建 `src/nav.ts`:`export const NAV = [...]`(原样迁出);App.tsx 改 `import { NAV } from './nav'`,SelectionAsk 同源导入——**无 App↔SelectionAsk 循环依赖**
2. App.tsx:`import SelectionAsk from './components/ask/SelectionAsk'`,在 `</main>` 后、根 div 内挂 `<SelectionAsk />`(HashRouter 内,useLocation/Link 可用;不在 Routes 内,路由切换不卸载)

## 边界情况(设计已覆盖)

- 对话框/按钮内选字不触发按钮(target + anchorNode 双重 `data-ask-ui` 检查);textarea/input/密码框选区一律忽略
- 按钮点击选区塌陷:snippet 快照 + pointerdown preventDefault;pointerup 的 setTimeout 在新事件/滚动/cleanup 时清理
- 中文输入法 Enter 不误发(`isComposing`);发送即清空输入框,失败不回填
- 超长圈选截断 4000 字;滚动/点他处/路由切换隐藏按钮;近顶部按钮翻下方
- StrictMode 双跑:单 effect 对称 add/remove + timer 清理
- 流式:事件级 SSE 解析(多 data 行合并、跨 chunk、CRLF、无 `[DONE]` flush 收尾)、role-only 首帧、空 choices usage 帧、坏 payload 跳过、厂商忽略 stream 的 JSON 兜底、`res.body` null、**error 帧无论早晚必抛**(半截保留+「响应中断」)、首字节 120s / 帧间 30s 双超时、Stop 保留半截
- 竞态:Close 后旧请求的 delta/收尾/finally 全部被会话代数+controller 所有权校验丢弃;快速开新会话不受旧 finally 影响;流式中/Stop 未 settle 时 Enter 不会并发第二个请求(`!busy` + `abortRef` 双守卫)
- 流式中追加引用:占位消息先于引用入列,时序正确,只影响下一轮
- 生产构建无代理 → LLM 不可用,既有限制不处理

## 验证

1. `npm test` — sse/liteMd/llmClient 新单测 + 原 28 例全绿
2. `npm run typecheck`
3. `npm run dev` E2E 走查(由 QA subagent 经 claude-in-chrome 浏览器自动化执行,调真实 API;.env.local 已有 key):
   - /architecture 圈选 → 按钮浮现;滚动隐藏;顶部选区翻下方;**面试页 textarea 里选字、设置页密码框选字 → 不出按钮**
   - 点 Ask LLM → 右下角弹框带「架构演进」引用卡;提问 → 打字机流式;Shift+Enter 换行;输入法 Enter 不误发;发送后输入框已清空
   - 拖标题栏跨 sticky 导航 → 置顶且不出视口;**点 × 一次即关**(不被拖拽手势吃掉);Esc 关闭
   - 消息区选字复制 → 不触发按钮、不拖动窗口
   - 开着对话框再圈选(含流式中) → 追加引用卡且顺序正确;多轮上下文连续(问「刚才第一段讲了什么」验证)
   - 要代码 → 围栏流式渲染;中途 Stop → 半截保留可继续
   - **流式中预打字并按 Enter → 不发出第二个请求**(文字留在输入框,流结束后可发);Stop 刚按下未 settle 时连按 Enter 同样不重复发
   - **流式中直接 Close → 立刻再圈选开新会话 → 新会话无任何旧内容渗入、可正常发送**(P0 竞态回归)
   - 多段落圈选与 Shift+Enter 多行提问 → 气泡内换行保留
   - 关闭 → 再圈选 → 全新会话;坏 key → auth 错误 + 「去设置」
4. 终检:`npm run typecheck && npm test`

## 交付编排(按用户约定)

1. **计划落盘**:批准后将本计划保存为项目内**新文档 `PLAN-ask-llm.md`**——不改动已交付的 `PLAN.md`(它是上一期的交付记录);实施中在新文档内按阶段更新进度
2. **实现交付**:派出专职实现 agent(模型选用 opus/sonnet,**不用 fable5**)按 Step 1→6 交付:lib 层(sse/liteMd/chatStream + 单测)与组件层(AskDialog/SelectionAsk/nav/App 接线)顺序完成;每步之后 `npm run typecheck && npm test` 把关
3. **E2E 验证**:派出专职 QA subagent(模型除 fable5 外自选,建议 opus)在 `npm run dev` 下,通过 **claude-in-chrome 浏览器自动化 + 真实 LLM API**(.env.local key 经 dev 代理)执行下方「验证」节的全部走查条目,产出 P0/P1/P2 分级报告
4. **修复循环**:对报告的 P0/P1 派 agent 修复 → 回归 typecheck/vitest → QA 复测,**循环直至 P0/P1 清零**;P2 酌情处理并记录

## 评审记录(codex gpt-5.6-sol xhigh)

### 第 1 轮(结论:需修订)→ 已修订如下

| # | 级别 | 发现 | 处置 |
|---|------|------|------|
| 1 | P0 | Close 后旧请求(resolve 部分文本/迟到 delta/finally)污染新会话 | **采纳**:会话代数 `sessionRef` 全写入校验;finally 仅在持有权匹配时清 abortRef;Stop/Close 语义在调用方区分 |
| 2 | P0 | textarea/input 选区不可靠且密码框 key 可能被引用外发 | **部分采纳(范围决策)**:不支持表单控件选区,pointerup/anchorNode 双重排除 textarea/input(含密码框),写入需求范围;不做 selectionStart/End 分支(用户答疑对象是页面正文) |
| 3 | P0 | 流式中追加引用导致消息时序错乱/引用丢失 | **采纳**:改为发送时插入 assistant 占位消息,delta 按 id 原位更新;追加引用天然排在占位后 |
| 4 | P1 | SSE 按行解析不符 framing(多 data 行/flush 未消费) | **采纳**:事件级解析,空行为界,多 data 行 `\n` join;flush 走同一消费路径 |
| 5 | P1 | 30s 超时与 120s 思考模型基线冲突,首字节无保护 | **采纳**:首字节 120s(fetch 前启动)+ 帧间 30s 双段超时;JSON 兜底受 120s 保护 |
| 6 | P1 | 流中 error 帧在已有累计后被吞 | **采纳**:error 帧无条件抛 server;UI 保留半截并示「响应中断」 |
| 7 | P1 | 标题栏拖拽手势吃掉关闭按钮 click | **采纳**:关闭按钮 pointerdown stopPropagation |
| 8 | P1 | error/errorKind 不在重试/关闭时清除 | **采纳**:send 与 Close 均重置两者 |
| 9 | P1 | 输入框发送后不清空 | **采纳**:快照→清空→onSend,失败不回填 |
| 10 | P1 | pointerup 的 setTimeout 未清理 | **采纳**:timer 归 effect 管,新事件/滚动/cleanup 均清理 |
| 11 | P1 | chatStream 无自动化测试 | **部分采纳**:新增 llmClient.test.ts(stub fetch,覆盖流式/abort/error 帧/JSON 兜底/401);会话 reducer 抽取不做(代数防护已消除主要竞态面),Close 竞态入手工回归清单 |
| 12 | P2 | 「右下角永不遮挡」说法过强 | **采纳**:改为「通常避开,可拖走」 |
| 13 | P2 | SelectionAsk↔App 循环导入 | **采纳**:NAV 迁至 `src/nav.ts` |
| 14 | P2 | 无障碍缺失 | **采纳(轻量)**:role="dialog"/aria-labelledby/关闭 aria-label/Esc 关闭/busy aria-live |

### 第 2 轮(结论:需修订;第 1 轮 14 条修订全部核实有效,无新引入竞态)→ 已修订如下,评审收口

| # | 级别 | 发现 | 处置 |
|---|------|------|------|
| 15 | P0 | `onAsk` 直读 `btn.snippet`,strict 下 possibly-null 报错 | **采纳**:函数开头 `const selected = btn; if (!selected) return` 快照收窄 |
| 16 | P0 | busy 期间 Enter 可并发第二个 chatStream(覆盖 abortRef、busy 提前复位、历史带入 pending 消息) | **采纳**:Enter 路径查 `!busy`;`send()` 开头 `busy \|\| abortRef.current` 硬守卫;finally 以 controller 所有权+代数双校验收尾;Close 先置空 abortRef 再 abort;回归用例入手工清单 |
| 17 | P1 | 引用卡/用户消息不保留换行、长内容溢出 | **采纳**:两类气泡加 `whitespace-pre-wrap break-words` |
| 18 | P2 | `[DONE]` 后上游不断开,连接滞留 | **采纳**:哨兵路径先 `reader.cancel()` 再返回 |
| 19 | P2 | 双段超时无自动化测试 | **采纳**:llmClient.test.ts 用 fake timers 覆盖首字节超时/idle 切换/每帧续期 |

## E2E 交付记录(2026-07-31,QA agent 经浏览器 + 真实 API)

### 首轮走查(26 项清单,24 PASS)发现与处置

| # | 级别 | 发现 | 处置 |
|---|------|------|------|
| E1 | P0 | `scroll` 捕获监听把对话框内部滚动(含流式自动贴底)也当页面滚动,按钮秒消失 → 流式中无法追加引用 | **已修复**:scroll handler 忽略源自 `[data-ask-ui]` 内的事件;页面滚动仍隐藏按钮 |
| E2 | P0 | 路由切换时 React 卸载选中节点不触发 `selectionchange`,残留按钮且引用标成当前页页名 | **已修复**:`pathname` 变化清 btn;pageLabel 在圈选时快照进 btn state |
| E3 | P1 | 用户上翻后发送新消息,列表不回底,看不到自己的提问与流式回答 | **已修复**:用户主动发送时重新贴底;流式 delta 仍不抢滚动 |
| E4 | P2 | busy 期间 Enter 往输入框塞换行 | **已修复**:普通 Enter 一律 preventDefault,busy 时为 no-op |
| E5 | P2 | `##` 标题 / `-` 列表渲染为原始文本 | **已修复(轻量)**:渲染期行级处理,标题加粗、列表转 「• 」;代码围栏行为不变 |
| E6 | P2 | 按钮可能遮住选区上一行文字 | **不修**:化妆级,计划仅承诺选区上方 38px 定位 |

### 复测(修复后)

6/6 全 PASS,新 P0/P1 = 0,控制台零错误/零警告;网络面板确认每次提问仅 1 个请求(单 in-flight 守卫生效);流式中 Close → 新会话无旧内容渗入(竞态回归通过)。复测新发现 P2:二级嵌套列表 `  - ` 未渲染 → **已修复**(BULLET_RE 允许前导空白并保留缩进),修后 typecheck/69 测试全绿。

### 未能自动化覆盖(建议人工 10 秒抽查)

- 中文输入法 Enter 确认(`isComposing` 守卫代码在位,自动化无法驱动真实 IME)
- framer-motion 拖拽快甩到角落时 `dragConstraints` 的精确钳制(自动化 rAF 受限;常规拖拽与 z 序已验证)
