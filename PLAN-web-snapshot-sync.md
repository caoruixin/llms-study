# PLAN：论文陪读「网页原貌」导入 + 跨设备同步自愈

## Context（为什么做）

用户把 https://openvdn.github.io/ 导入论文陪读（`#/papers/62cfa12b-…`），期望三种语言模式（原文 / 中文 / 对照）下都保留原网页的文字、表格、图表、图片与版式（视频可丢）。同时反映：同一账号（admin）在两个 Chrome 实例打开同一论文 URL，一个正常、另一个打不开或正文为空。

### 现状诊断（已在代码 + 生产环境只读核实）

**A. 「原貌」问题不是图片丢失，而是抽取模型本身丢掉了版式与图表**

- 目标页 7 个「图」里只有 2 个 `<img>`（品牌 logo）。其余是：内联 `<svg>`（branch figure）、JS 生成的 HTML/CSS 网格（attention map 用 `createElement('button')` 逐格生成）、CSS 变量驱动的条形图（`style="--component-width: 84%"`）、MathJax `\(..\)` 公式、JS 生成的 `<video>` 结果条（`./GeneratedVideos/*.mp4`）。页面 CSS 113KB、JS 101KB。
- 现有管线 `fetch-url 字节 → Readability → sanitizeArticleHtml（白名单极窄，删 svg/math/style/class/id）→ 正则切块 → PaperBlock{heading|paragraph|list|table|code|caption|image}`（`src/lib/paper/url/extractArticle.ts`、`src/lib/paper/sanitize.ts`、`src/lib/paper/normalizeHtml.ts`），设计上就只保留「语义块」。任何以文本块为终点的抽取器都无法保留这类页面的图表与版式。
- 结论：需要一条与「阅读模式」并列的 **「网页原貌（Web Snapshot）」** 管线：抓取并固化渲染后的 DOM + CSS + 图片资源，在阅读器里以隔离文档原样渲染，并在原 DOM 上就地做双语/高亮/进度。

**B. 「另一个浏览器打不开」= 同步引擎的跨 tab 饥饿 + 接收端锁死（生产实测）**

- 服务端 `sync_records` 里这篇论文只有 `papers` 行（来自 progress 推送），`blocks` 0 行，`GET /api/app/files/:id` 404；同一天导入的 `ae36c53b`（HF 模型页）同样空心。其它论文 blocks/文件都在，说明不是通用故障。
- 当前浏览器 profile 内 `navigator.locks.query()`：`paper-sync` 锁 1 个 held、4 个 pending（5 个 tab）。账号库 `outbox` 积压 159 条（progress 104 / record 54 / push-artifacts 1），最早 2026-09-08T01:56Z，从未推送。原因：`outboxSignal`（`src/lib/paper/sync/outbox.ts:136-148`）是**每 tab 内存事件**，非领导者 tab 入队后领导者 tab 永远不知道；领导者 `loop()` 首轮 flush 后进入 `interruptibleSleep(null)`（`syncEngine.ts:347`），只有本 tab 的 `kick()` 能唤醒（接棒时 `alignEngineToAuth` 的 kick 只保证接棒后 flush 一次；401 后 `start()` 复活路径连这一次都没有）。
- 第二个饥饿点：`flushOnce` 的制品循环（`syncEngine.ts:198-201`）在一个 try 里，任一篇 `pushArtifacts` 抛错（如文件 PUT 413 配额、永久性 400）就中止整轮并返回 `'error'`；下一轮同一篇按 qid 排最前再抛 → 其后所有论文的 push-artifacts 永远推不出去。
- `papers` 行之所以到了服务端，是 `flushProgressKeepalive()`（pagehide keepalive，`syncEngine.ts:411`）绕过 outbox 直推；且 `bootstrapSyncEngine` 在**每个 tab** 都把本地 progress 写入灌进 `progressCache`（`syncEngine.ts:322-324`），非领导者 tab 永远不 flush 也就永远不清，缓存无限增长，每次 pagehide 把所有缓存的 papers 行（status ready、blockCount N）整批重推——服务端「有 papers 行、无文件无 blocks」的空心论文即由此而来。
- 接收端徽标也错：`applyOne` 首次从远端见到论文即写 `{artifactsPushed:true, filePushed:true}`（`syncEngine.ts:255`），空心论文在接收设备显示「已同步」。
- 接收端：`pullPaper()` 拉到 0 个 block 也把 `syncMeta.blocksPulled=true`（`syncEngine.ts:305-307`），工作台门槛 `meta?.blocksPulled !== true`（`PaperWorkbenchPage.tsx:246`）此后永不重试 → 「网页 · 0 段 · 这篇论文没有可显示的正文块」永久化。
- 冷启动深链：`authStatus==='unknown'` 时 `getPaperDb()` 返回游客库，loader 立刻跑完 `setLoading(false)` → 闪「找不到这篇论文」；authed 后 effect 重跑但 `loading` 不复位。
- 可观测性：`flushOnce` 的 catch 只返回 `'error'`，不打日志、不落盘；列表徽标只有 已同步/同步中/仅本地。

## 总体方案

两条工作线，先修同步（P0，小 diff，先发版），再做原貌导入（P1，主体工作）。原貌导入的「跨设备一致」完全依赖同步线修好。

---

## Part 1：同步自愈（P0）

### 1.1 跨 tab 唤醒（根因修复，P0，仅客户端）

- 新模块 `src/lib/paper/sync/crossTab.ts`（避免 `repos → syncedRepos → outbox` 与 `syncEngine` 之间的环）：`BroadcastChannel('paper-sync')`，消息 `{kind:'enqueued', dbName, op, paperId}`（不带 payload）/ `{kind:'flushed', dbName}` / `{kind:'pulled', dbName, paperIds, tables}`；实现照 `authStore.ts:112-117`（无 BroadcastChannel 时静默、node 下 `unref`、校验字段类型）。
- `outbox.ts` `outboxSignal.emit`：本地监听器之后 `postSyncMessage({kind:'enqueued',…})`；模块初始化时 `onSyncMessage` 把远端 `enqueued` 转成合成 item（无 payload）喂给本地监听器 → 引擎 `kick()`。无 payload 意味着 `kick()` 不会碰 `progressCache`（keepalive 由原写入 tab 自己负责）。BroadcastChannel 不回环，无需防抖。
- `syncEngine.ts`：`createSyncEngine(db, opts)` 增加可注入的 `{urgentDelayMs, progressDelayMs, idlePollMs, reconcileIntervalMs, now}`（测试不用真等）；`loop()` 空闲改为 `interruptibleSleep(idlePollMs=30s)`，醒来 `db.outbox.count()>0` 即 flush（BroadcastChannel 缺失/丢消息的兜底）；`start()` 三条路径（拿到锁、无 locks、locks 异常）都先 `kick()`；`'pushed'|'partial'` 时除 `paper-sync-flushed` 窗口事件外再广播 `flushed`，`bootstrapSyncEngine` 收到后在本 tab 重派窗口事件（非领导者 tab 徽标也刷新）。领导者选举不动。
- **keepalive 泄漏闸**：`kick(item)` 对 progress 只在该论文 `syncMeta.blocksPushed || artifactsPushed` 时才写 `progressCache`（制品未推完时，`pushArtifacts` 推 papers 行本就带最新进度，提前推只有坏处）；`flushProgressKeepalive` 前清掉超过 `progressDelayMs*4` 的旧条目。

### 1.2 制品推送拆步 + 逐篇隔离（P0，仅客户端）

- `SyncMetaRow`（`db.ts:65-74`）新增可选字段（syncMeta 只索引主键，**无需 Dexie 升版**）：`blocksPushed?`, `pulledBlockCount?`, `lastError?: {step:'papers'|'blocks'|'file'|'records'|'delete'|'pull'|'reconcile', code, message, status?, at}`, `attempts?`。兼容读法 `blocksDone = meta.blocksPushed ?? meta.artifactsPushed ?? false`；`artifactsPushed` 语义不变（三者齐）。
- `pushArtifacts(paperId): Promise<'done'|'retry'>`（替换 `syncEngine.ts:140-169`），顺序 papers → **blocks → 文件**：
  1. papers 行；`paper-deleted` → 墓碑处理，`'done'`。
  2. `!blocksDone` → `chunkRows` 分批推；成功写 `blocksPushed:true, blocksPulled:true`。抛错 → `'retry'`（401 除外）。
  3. `!filePushed && 本地有文件` → PUT（同 sha 短路）；成功 `filePushed:true`。400（sha 不符/非法）与 413（配额/超限）= **永久失败**：落 `lastError{step:'file'}`，`filePushed` 保持 false，返回 `'done'`（丢弃队列项，靠 1.5 的手动重试）；网络/5xx/429 → 落 `lastError`，`'retry'`。
  4. `artifactsPushed = blocksPushed && filePushed`；全成功清 `lastError`、`attempts=0`。
- `flushOnce` 制品循环与 deletes 循环：**每项独立 try/catch**；`'done'` 删 qid，`'retry'`/抛错保留 qid 并标记 `hadError`；任一处 401 立即返回 `'auth'`。返回值增加 `'partial'`（有推成功也有失败 → 既派 flushed 事件也退避）。
- **不做 sha 自愈**：实测失败是饥饿 + keepalive 泄漏，不是 sha 不符（`ingestPrepared` 对存的同一份字节算 sha，`ingest.ts:282-294`）；改 `papers.sha256` 会波及 `findBySha256` 去重与 `claimedShas`。只记 `lastError`。
- `syncedRepos.ts:61` `markReady`：写 `{artifactsPushed:false, blocksPushed:false, filePushed:false, blocksPulled:true}` 并清 `lastError/attempts`。

### 1.3 与服务端对账（P1，需先发服务端）

- **新增轻量端点** `GET /api/app/sync/summary`（`server/src/routes/sync.ts`）而非扩 snapshot（snapshot 是 O(全部行) 且 records 无 paperId）：每篇非墓碑 papers 的 blocks 计数（子查询走 `idx_sync_records_user_paper`）+ `stored_files` 的 `{paperId, sha256, byteSize}`。`shared/apiTypes.ts` 新增 `SyncSummaryResponse {papers:[{paperId, blocks}], files:[{paperId, sha256, byteSize}], cursor}`；`serverApi.ts` 加 `summary()`。
- 客户端 `syncEngine.reconcile()`：节流键放**共享的** `syncState.lastReconcileAt`（默认 10 分钟，多 tab/接棒不会羊群）；在 `pullSince()` 成功后与拿到领导权后各调一次 `maybeReconcile()`。对账号库每篇 `ready` 且无待决 push-artifacts/delete 的论文：`localBlocks = blocks.where('paperId').count()`、`hasLocalFile = files.where(':id').count()>0`（**绝不 `.get()` 文件行**，50MB blob）；`localBlocks>0 && serverBlocks<localBlocks` 或 `hasLocalFile && serverFile?.sha256 !== paper.sha256` → 只把缺的那步 flag 置 false、`artifactsPushed:false`，入队 push-artifacts（planOutbox 每篇只留一条）并 `kick()`。旧服务端 404 → 记一次日志跳过。
- 效果：修复发版后，持有 `ae36c53b` 本地数据的这台浏览器自动补推（其 outbox 本就有该项，1.1 即可；1.3 覆盖队列项丢失的情形）；`62cfa12b` 由原导入设备打开论文库时自动补推。
- 已知未修缺口（记录）：旧解析比新解析多出的服务端 blocks 行不会被墓碑（既有问题）。

### 1.4 接收端不再锁死 + 明确状态（P0，客户端）

- `pullPaper()`：翻页结束后 `n = blocks.where('paperId').count()`，写 `{pulledBlockCount:n, blocksPulled: n>0 && (record.blockCount===undefined || n>=record.blockCount)}`；应用了 ≥1 条变更时广播/派发 `paper-sync-pulled {paperIds, tables}`（1.6 需要）。`applyOne` 首见远端论文时的 syncMeta 改为 `{artifactsPushed:true, filePushed:true, blocksPushed:true, blocksPulled:false}`，徽标另按 `pulledBlockCount` 判空心。
- 工作台 loader（`PaperWorkbenchPage.tsx:226-285`）：effect 开头 `if (authStatus==='unknown') { setLoading(true); return }`（`refresh()` 必定收敛到 authed|anon，`authStore.ts:54-68`），随后 `setLoading(true); setPullingRemote(false)`；补拉条件改为非锁存 `!record || (record.status==='ready' && list.length < (record.blockCount ?? 1))`，删除 `meta?.blocksPulled !== true` 门槛（保留「到齐即补记」块）；新增 `pullTick` state 进 deps 供「重新拉取」。判定逻辑抽成纯模块 `src/pages/papers/workbenchLoad.ts`（`needsRemotePull`、`isHollow`）+ node 单测（页面本身静态 import pdfjs，不做 happy-dom 页面测试）。
- 空心渲染态：`<main>` 内 `paper.status==='ready' && blocks.length===0 && !pullingRemote` 时代替 BlockReader 渲染面板「正文尚未从原设备同步（原设备打开论文库即可自动补传）」，按钮 **重新拉取**（`pullTick+1`）与（`paper.source?.type==='url'` 时）**从原网址重新导入**（`navigate('/papers?reimport=<paperId>')`，由论文库页的串行队列执行 Part 2 的 `reimportUrlPaperInPlace`，同 paperId 原地重导，导完由本机推送制品；此按钮在 Part 2 步骤 4 落地后再接）。

### 1.5 可观测性（核心 P0，UI P1）

- 引擎：`recordError(paperIds, step, e)` → `console.error('[sync] flush 失败', …)` + 对仍存在的论文写 `lastError`、`attempts+1`；成功即清。`getSyncStatus()` → `{leader, running, pending: outbox.count(), failures, lastError, lastFlushAt, lastSyncAt, nextFlushAt}`；`retryArtifacts(paperId)` → 清 `lastError/attempts` + 入队 push-artifacts + kick（flag 不动，幂等步骤自动跳过已完成项）；`'error'|'partial'` 派发 `paper-sync-error` 窗口事件。
- `PapersPage.tsx` `syncBadge`（107-112）：`meta?.lastError && !meta.artifactsPushed` → 「同步失败」（`title` = message），旁边「重试同步」按钮调 `retryArtifacts`；接收侧 `pulledBlockCount===0 && paper.blockCount>0` → 「正文未同步」；监听 `paper-sync-error` 同 `paper-sync-flushed`。列表头一行：`{n} 项待推送 / 已全部推送 · 上次同步 {time} · 本标签页负责推送 / 由其它标签页推送`。

### 1.6 高亮与译文跨设备同步（用户已确认要做；**服务端先发**）

- `shared/apiTypes.ts:143` `SYNC_TABLES` += `'translations','highlights'`（服务端 allowlist 由它派生，`sync.ts:43`，零逻辑改动；级联删除按 `paper_id` 已覆盖；`gc.ts` ROW_CAPS 不需改——行数受论文体量约束）。
- `syncedRepos.ts` 新增 `createSyncedTranslationRepository`（`putTranslations` → 每行一条 record，带 paperId）与 `createSyncedHighlightRepository`（`applyMerge` → `toDelete` 墓碑 + `toPut` record；`deleteHighlights` → 墓碑）；`repos.ts:54-56` 换成同步版；`syncEngine.ts` `subTables()`（90-99）加两表，`applyOne` 即可落地，`pullPaper` 按 paper_id 自然带出。
- 失效通知：`useTranslations` 增加 `scheduler.reload()`（重跑 load，只补缺失、从 failed 里剔除已到的）并在 hook 内监听 `paper-sync-pulled`（按 paper.id 与 tables 过滤）；`useHighlights` 监听后 `getHighlights` → `commit`（Dexie 为真相；只读事务排在进行中的 applyMerge 之后，不丢本地行）。
- LWW：译文 id 确定性 + `updatedAt`，`srcHash/promptVersion` 校验（`useTranslations.ts:99-101`）处理陈旧；高亮 uuid 行，两台设备同时划重叠区间会留两行重叠（外观问题，记录不修）。体量：译文 ≈ 论文中文文本（300 块 ≈ 450KB JSON/篇），配额影响可忽略。
- 发布顺序必须**服务端先**：旧服务端会以 `tbl-not-allowed` 拒绝，而客户端 `flushOnce` 190-194 会把被拒项直接删掉（顺手修：非 `paper-deleted` 的拒绝保留队列项并记 lastError）。存量本地译文/高亮的一次性回填以 `syncState.backfillSyncV1` 标记做一次。

### 1.7 测试

- `syncEngine.test.ts`（沿用 `stubFetch` + fake-indexeddb，`createSyncEngine(db,{urgentDelayMs:10, idlePollMs:30})`）：① 预置 outbox 不 kick 直接 `start()` → `urgentDelayMs` 内推送；② 空闲轮询：`start()` 后直接 `outbox.add` 不发信号 → `idlePollMs` 后推送；③ 跨 tab：node 的 BroadcastChannel 同线程可达，`postMessage({kind:'enqueued',…})` → flush 且 keepalive 不发任何请求；④ keepalive 闸：制品未推完的 progress 不进缓存；⑤ 制品顺序改为 papers→blocks→file；⑥ 文件 PUT 500 → blocks 仍推、`blocksPushed:true`、`filePushed:false`、`lastError.step==='file'`、队列项保留、结果 `'partial'`；413 → 队列项删除、lastError 落盘；⑦ 两篇制品前一篇瞬时失败不影响后一篇；⑧ `pullPaper` 拉到 0 块不置 `blocksPulled`；⑨ 5xx → `console.error` 一次 + lastError；⑩ `reconcile()` 四种情形（缺 blocks 入队 / 齐全不入队 / 已有待决项不入队 / 节流内不请求）。
- `outbox.test.ts`：远端 enqueued 消息触发监听器且无 payload；畸形消息忽略。`syncedRepos.test.ts`：markReady 写新 flag；译文/高亮装饰器入队 record/墓碑。`workbenchLoad.test.ts`：表驱动。server `sync.test.ts`：`/sync/summary` 计数排除墓碑、401；`translations/highlights` 可 push 且随论文级联删除。
- 手工 E2E（两个 Chrome profile A/B）：A 导入 → 10s 内 A/B 徽标均「已同步」，B 打开正文完整；A 推送中被杀（限速）→ B 列表显示失败/未同步及原因 → A 重开列表 → 对账入队 → B 收敛；B 冷启动深链只显示「正在加载/同步」不闪「找不到」；空心论文在 B 显示面板 → 重新拉取（每次打开都可重试）→ 从原网址重新导入；A 开 5 个 tab 在非领导者 tab 阅读，领导者 ~5s 内推送；发版后仍开着的旧包 tab 会继续饿死新 tab（不监听频道也不轮询）——写进发布说明，关掉/刷新即收敛。

### 1.8 一次性修复与运维核查

- `ae36c53b`：1.1/1.3 从持有本地数据的这台浏览器自动补推；`62cfa12b`：1.4 空心态 + 重新导入。运维核查 SQL（加入 `deploy/` 运行手册，发版前后各跑一次）：列出 `status='ready'` 且 blocks=0 或无文件的 papers 行（对 `sync_records` 自连接 + `stored_files` EXISTS）。

---

## Part 2：网页原貌导入（P1）

> 已按 Plan 代理对 DOMPurify 3.4.13 / katex 0.18.4 / Vite 6.4.3 / 目标页实测的核查修订。所有新代码只放在 `src/lib/paper/**`、`src/components/papers/**`、`src/pages/papers/**`（`vite.config.ts:21-37` flag-off 虚模块化范围）；重依赖动态 import。

### 2.1 数据形态（先冻结的契约）

- 新文件格式 **web-snapshot 二进制容器**：`'PCS1'` 魔数 | u32 LE 头长 | UTF-8 JSON 头 | 资源字节拼接（按 `assets[]` 顺序，assets 按 id 排序去重）。mime `application/x-paper-web-snapshot`（`webSnapshotMime.ts`，零依赖叶子模块，同 `urlBundleMime.ts`）；`PaperRecord.format` 仍为 `'html'`；`validate.ts:33` 的 html mime 列表加入新 mime。走**现有** `files` 表与 `PUT /api/app/files/:paperId`（60MB 上限），服务端零新存储端点。
- 头 JSON（`webSnapshot.ts`，node 可测、不碰 DOM）：
  ```ts
  interface WebSnapshotHeader {
    kind:'web-snapshot'; version:1; url; finalUrl; title
    capture:{ mode:'rendered'|'static'; katex:boolean; viewportWidth:number; agentVersion:number }
    html:string              // 已 sanitize + 已打标的 documentElement.outerHTML（无 doctype），≤8MB
    assets:{ id:sha256; url; mime; offset; length }[]
    blocks:NormalizedBlock[] // 唯一的块来源：parse = 解 JSON，不再由 DOM 重推（任何设备字节相同 ⇒ blocks 相同）
    stats:{ assetBytes:number; skipped:{url; reason:'cap'|'too-large'|'fetch'|'type'}[] /* ≤50 */ }
  }
  encodeWebSnapshot(input) → {bytes, header}   // 确定性：固定键序、无时间戳
  decodeWebSnapshot(bytes) → {header, assetBytes(id)}  // 损坏抛 IngestError('corrupt')，照 urlBundle.ts:49-72
  parseWebSnapshotBytes(bytes) → ParseResult   // {blocks: header.blocks, title}
  ```
- `parseHtmlBytes.ts`：按魔数分流 `parseWebSnapshotBytes` / `parseUrlBundleBytes`（两者动态 import）；`PapersPage.tsx:74-77` 的 html 分支改调它；`urlImport.test.ts:19-23` 的测试替身同样嗅探。
- `types.ts`：`PaperSource.capture?: {mode, assetCount, assetBytes, skipped, katex?}`；`UrlProgressPhase` += `'rendering'|'assets'|'packing'`，`UrlProgressEvent.detail?: {done,total}`。Dexie v4 不动、`PARSER_VERSION` 保持 2（快照块由 `header.version` 版本化）。
- 冻结的 DOM 契约：属性 `data-pc-block` / `data-pc-asset` / `data-pc-sheet` / `data-pc-hidden` / `data-pc-fixed` / `data-pc-pre` / `data-pc-run`，CSS 占位 `url("pc-asset:<id>")`，类名 `.pc-zh` / `.pc-orig`，`hostText()` 语义（见 2.3）。

### 2.2 抓取与固化（客户端，导入时）

模块（`src/lib/paper/url/`）：`captureAgent.ts`（Tier 2 代理脚本）、`captureRendered.ts`（Tier 2 驱动）、`captureStatic.ts`（Tier 1 + 共用预处理）、`cssRewrite.ts`（纯字符串）、`snapshotAssets.ts`（资源抓取）、`fidelitySanitize.ts`（DOMPurify 原貌 profile）、`stampBlocks.ts`（打标 + 块推导）、`buildSnapshot.ts`（编排）。

1. `fetchUrl(url)` 取原始 HTML（现有代理）；PDF 直链/微信文章保持现有路径（微信强制阅读模式并提示：其正文 `visibility:hidden` 靠 JS，不透明源 iframe 下不可靠）。
2. **Tier 2 渲染捕获**（`captureRendered.ts` + `captureAgent.ts`）：
   - iframe `sandbox="allow-scripts"`（不透明源：拿不到我们的 cookie/存储；`localStorage/indexedDB` 在其内抛 SecurityError，站点脚本提前中止也无妨）、`referrerpolicy="no-referrer"`。**不能 display:none/移出视口**（IntersectionObserver 与 `loading=lazy` 会按父视口几何计算）：`position:fixed; left:0; top:0; width:min(1280px,100vw); height:100vh; opacity:0; pointer-events:none; z-index:-1`。
   - `buildCaptureSrcdoc(siteHtml, finalUrl, cfg)`：在 `<head>` 最前依次注入 `<meta charset>`、CSP meta **`script-src https: 'unsafe-inline' 'unsafe-eval'; style-src https: 'unsafe-inline'; img-src https: data: blob:; font-src https: data:; connect-src https:; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'`**（原方案 `default-src https:` 会把站点内联 MathJax 配置和我们自己的代理脚本一起挡掉）、`<base href=finalUrl>`、`<script>(${captureAgentMain.toString()})(cfg).run()</script>`（`captureAgentMain` 必须自包含：无 import/闭包，单测断言 `toString()` 不含 `import(`/`__vite`/`require`；`parentOrigin` 编译期注入，不用 `'*'`）。
   - 代理流程：`load` → `await MathJax?.startup?.promise`（v3；封顶 8s；v2 只靠静默）→ **滚动扫描**（每 120ms 一屏、≤40 屏、回顶；`img[loading=lazy]`→eager，`data-src|data-original|data-lazy-src` 提升）→ MutationObserver 静默 700ms（load 后封顶 6s，硬超时 20s 时有什么序列化什么）→ `serialize()`：先在**活树**上标注 `data-pc-hidden`（`display:none/visibility:hidden` 的文本元素，如本页 `.viz-tooltip`）、`data-pc-fixed`（fixed/sticky）、`data-pc-pre`（`white-space:pre*`）；再在克隆树上删 `script/noscript/iframe/object/embed/template/link[rel!=stylesheet]`、剥 `on*` 与 `javascript:`、`img.src := currentSrc` 并删 `srcset/sizes`、`video` → poster 图或 `.pc-placeholder`「[视频：文件名]」、`canvas` → `toDataURL`（污染则占位）、保留 `<style>`（含 MathJax 注入的 `#MJX-CHTML-styles`）、`link[rel=stylesheet]` → `<link data-pc-sheet href media>`（绝对 URL）→ `postMessage(parentOrigin)`；>8MB 回 `{ok:false, reason:'too-large'}`。
   - 父页：校验 `event.source === iframe.contentWindow && event.origin === 'null'`，外层超时 22s，`finally` 移除 iframe；模块级串行（同时只跑一个捕获）；任何 CaptureError → 回退 Tier 1。
3. **Tier 1 静态**（`captureStatic.ts`）：DOMParser → 共用 `preprocessFidelity(doc, base)`（`<base>` 解析照 `extractArticle.ts:83-94`；绝对化 `a[href], img[src], source[src], [poster], svg image[href], use[href 非#]`；懒加载属性提升；删 `srcset/sizes`；`picture` 只留 `img`；`video/audio/iframe/object/embed/canvas` → 占位/poster；删 `annotation, annotation-xml`（DOMPurify 会把 `annotation` 的 TeX 源码提升成可见文本）、`link[rel!=stylesheet]`、`meta`、`base`、`script`、`noscript`、`template`）。KaTeX auto-render（`katex/contrib/auto-render` 已随 0.18.4 导出，签名 `renderMathInElement(elem, opts)`，在 DOMParser 文档上可用；分隔符取页面内联 MathJax 配置，解析不了则默认 `\(..\)`/`\[..\]`/`$$..$$`；`throwOnError:false`）作为可选步骤（步骤 4）；`<math>` 原样保留（Chrome 原生 MathML）。
4. **`buildWebSnapshot()`**（`buildSnapshot.ts`）：解码 → Tier 2（失败回退 Tier 1）→ DOMParser → `preprocessFidelity` → 样式表：逐个 `link[data-pc-sheet]` 经代理（asset kind, text/css）抓取，`absolutizeCssUrls` → `inlineImports`（≤2 层，带 media 的 `@import` 包成 `@media`；抓不到的保留绝对 `@import`——Google Fonts 即如此，其 `fonts.gstatic.com` 已带 `ACAO:*`）→ 收集 `url()` 引用 → 资源计划 → `fetchAssets`（顺序：样式表 → 图片按文档序 → 字体；上限 ≤80 个 / 总 ≤30MB / 单个 ≤8MB / 字体 ≤12 个 ≤6MB；并发 3；429 读 `Retry-After` 退避 ≤3 次；**只代理与页面同站的字体**，第三方字体 CDN 保持远程）→ `substituteCssAssets`（`url("https://…")` → `url("pc-asset:<id>")`）+ `escapeCssForMarkup`（`<` → `\3c `，否则 DOMPurify 的 `SAFE_FOR_XML` 标记探测会把含 `<` 的整个 `<style>` 删掉）→ `<link>` 替换为 `<style data-pc-sheet="<href>" media>`（内联 `<style>` 同样处理；抓不到的样式表转成 `<style>` 内的 `@import url(abs)`，因为 DOMPurify 会剥 `<link>`）；`img[src]/[poster]/svg image[href]` 命中的资源加 `data-pc-asset="<id>"`（**`src` 保留原 https URL 作兜底**：DOMPurify `IS_ALLOWED_URI` 拒绝 `blob:`/自定义协议，占位只能放 data 属性与 CSS 文本）→ `stampBlocks` → `sanitizeFidelityDocumentHtml(documentElement.outerHTML)` → **重新解析 sanitize 后的 HTML 复核**每个文本块 `hostText(el) === block.text`（DOMPurify 可能 unwrap 未知包裹元素改变空白；不符则以 sanitize 后 DOM 为准重算该块 text）→ `encodeWebSnapshot`。全文 <200 字符 → `IngestError('empty','页面依赖脚本渲染，原貌抓取未得到正文；可改用「阅读模式」重试')`；html >8MB → `too-large`。
5. **`fidelitySanitize.ts`**（DOMPurify 3.4.13，实例化 `DOMPurify(window)` 避免与 `sanitize.ts:77-89` 的全局 hook 串味；输入 outerHTML 字符串，不用 IN_PLACE）：`WHOLE_DOCUMENT:true`；不覆盖 `ALLOWED_TAGS`（默认 = html+svg+svgFilters+mathMl，已含 `style`、`button`、`details/summary`、`picture`）；`ADD_TAGS:['use']` + hook：`use` 的 `href/xlink:href` 只准 `#` 开头（MathJax SVG/图标 sprite 需要；`foreignObject` 仍禁）；`FORBID_TAGS:['script','noscript','iframe','object','embed','template','form','input','textarea','select','option','link','meta','base','video','audio','source','track','canvas']`；`FORBID_ATTR:['integrity','crossorigin','srcset','sizes','ping','formaction','autofocus']`；`CUSTOM_ELEMENT_HANDLING:{tagNameCheck:/^mjx-/, attributeNameCheck:/^(?!on)[\w-]+$/i}`（MathJax CHTML 的 `mjx-container[jax][display]`、`mjx-c[class]`、`mjx-assistive-mml` 全覆盖，属性值不校验）；`ALLOWED_URI_REGEXP:/^(?:https?:|mailto:|tel:|#)/i`；hook 剥 `style` 属性中的 `expression(`/`url(javascript:`。默认 `ALLOW_DATA_ATTR` 已放行 `data-pc-*`；`style` 属性与 `id/class/media/loading/poster` 默认放行。输出以 `<html` 开头，水合时补 `<!DOCTYPE html>`。
6. **`stampBlocks.ts`**（单次 body 文档序遍历，happy-dom 可测）：跳过 `nav, [aria-hidden=true], [hidden], [data-pc-hidden], script, style, template, noscript`；`svg/math/mjx-container/.katex` 作为行内原子；候选 = 所有子节点均为文本/短语元素的元素：`h1-h6`→heading(level)，`p/blockquote/dt/dd/summary/div/section/article/aside/header/footer/main/span/a`→paragraph（`li`→list），`figcaption/caption`→caption，`pre`→code；语义标签需 ≥1 个字母，泛型容器（div/section/span/a/…）需 ≥20 字符且含字母。**混合容器**（既有块级子元素又有 ≥20 字的松散行内串）：把每段行内串包进 `<span data-pc-run>` 再打标（不改布局；纯行内容器直接打标，orig 模式下 `li/p/h2/flex 行` 的 DOM 字节不变）。**`<table>` = 一个 `table` 块**（`text=tableToText`、`html=sanitizeArticleHtml('<table>…')`，`normalizeDocx.ts:116-128`；不打单元格——逐格块会污染检索/翻译，BlockReader 也把表格当整块）。不在文本块内的 `img` → `image` 块（`[图: alt]`，src）；独立 `svg`（≥48×48 或在 `figure` 内）→ `image` 块（text 取 `<title>/aria-label`）。每个打标元素 `data-pc-block="N"`；文本块 `normalizeBlockWhitespace`（跳过 pre/code/textarea/`[data-pc-pre]`）；`section` = 最近前置标题（同 `normalizeHtml.ts:85-89`）；`anchor:{kind:'html', blockIndex, section}`。导出 `hostText(host)`：宿主内文本节点拼接，**排除嵌套的 `[data-hl-host]` 子树与 `.pc-zh`**——与 `selectionOffsets.ts` 共用。测试不变式：每个文本块 `hostText(el) === block.text`、索引连续且文档序。
7. **服务端**：`shared/apiRoutes.ts` 新增 `FETCH_ASSET_MAX_BYTES=8MB`、`FETCH_ASSET_TIMEOUT_MS=15_000`、`FETCH_ASSET_RATE_CAPACITY=60`、`FETCH_ASSET_RATE_REFILL_MS=200`、`FETCH_ASSET_MAX_CONCURRENT=3`；`shared/apiTypes.ts` `FetchUrlBody{url; kind?:'page'|'asset'}`；`server/src/lib/fetchRaw.ts` `SafeFetchOptions.accept?`（覆盖 `OUTBOUND_HEADERS.accept`）；`server/src/routes/fetchUrl.ts`：zod `kind` 默认 `page`，asset 独立令牌桶/并发闸（沿 111-112 模式），`ALLOWED_ASSET_MEDIA_TYPES = text/css, image/png|jpeg|gif|webp|avif|svg+xml|x-icon, font/woff|woff2|ttf|otf, application/font-woff|font-woff2|x-font-ttf|x-font-opentype`，octet-stream 嗅探 `wOFF/wOF2/OTTO/\0\1\0\0/PNG/JPEG/GIF/RIFF…WEBP`；svg **仅** asset kind 放行（注释：只在无脚本沙箱的 `<img>`/CSS 图像上下文消费）；SSRF 防线不变。`fetchUrlApi.ts`：`fetchUrl(url, {kind?, signal?})`，429 的 `retryAfterMs` 挂到 `ApiRequestError`。
8. **导入编排**（`urlImport.ts`）：`UrlImportDeps` += `buildSnapshot?`、`fetchAsset?`、`findByFinalUrl?`、`ensureStorage?`；`importFromUrls(urls, deps, onUrlProgress, {presentation:'reader'|'snapshot'})`。快照分支只支持单 URL（多 URL 一律阅读模式，弹窗说明）：抓取 → PDF 判定（现有）→ `findByFinalUrl` 命中 → `duplicate`（渲染捕获字节不稳定，sha 去重不可靠）→ `buildWebSnapshot`（进度 `rendering`/`assets{done,total}`/`packing`）→ `ingestPrepared({format:'html', mime:WEB_SNAPSHOT_MIME, source:{type:'url', entries, capture}})`。新增 `reimportUrlPaperInPlace(paperId, deps, onUrlProgress)`：读论文 → `source.entries[0].finalUrl ?? url` → 构建快照 → `repo.replaceFile` → `reingestPaper(paperId)`（`ingest.ts:380`）。
9. **仓储**：`paperRepo.ts` 新增 `replaceFile(paperId, {bytes, mime, sha256, byteSize, format, source?, title?, fileName?})`：单事务覆盖 `papers/files/jobs/translations/highlights`（状态回 `queued`、清 failure、`progress` 归零、`files.put`、job 回 queued、**删除该论文的 translations/highlights**——重打标后不可能存活，弹窗文案写明）。`syncedRepos.ts` 包装无需入队：随后的 `markReady`（`syncedRepos.ts:57-64`）会把 `filePushed:false` 并入队 push-artifacts，文件以新 sha 重新 PUT（服务端只在 sha 相同时短路，`files.ts:45-49`）。

### 2.3 渲染（工作台）

- **`src/components/papers/snapshotDom.ts`**（纯 DOM 帮手，happy-dom 可测）：`READER_CSS`（`.pc-zh`/`.pc-orig[hidden]`/`.pc-skel`/`.pc-fail`/`mark[data-highlight-id]`/`.paper-flash`/`[data-pc-fixed]{position:static!important}`/`.pc-placeholder`/`html{overflow:hidden}`/`.pc-zh{direction:ltr;text-align:start}`，可选 cookie/consent 横幅隐藏选择器）；`buildReaderSrcdoc(header, urlFor, {katexCssHref?})`：`<!DOCTYPE html>` + 每个 `<style>` 内 `hydrateCssTokens`（`pc-asset:<id>` → `blob:`，无资源回原 https）、`img[data-pc-asset]` 的 `src` → blob、`<head>` 最前插入 CSP meta **`default-src 'none'; img-src blob: data: https:; style-src 'unsafe-inline' blob: https:; font-src blob: data: https:; media-src 'none'; frame-src 'none'; form-action 'none'`**（`script-src` 回落 `'none'`，纵深防御）与 `<style id="pc-reader">`；`[data-pc-block]` 同时补 `data-block-index`（id 不动）；`header.capture.katex` 为真时注入 `<link rel=stylesheet href={new URL(katexCssUrl, location.href)}>`（`import katexCssUrl from 'katex/dist/katex.min.css?url'`，Vite 6.4.3 build 会重写其字体相对路径；`manualChunks` 已隔离 `vendor-katex`）。`applyLangState(doc, blocks, {langMode, translations, failed, authIssue})`、`applyHighlights(doc, byBlock)`、`hostRectInParent(iframe, el)`、`pickLinkAction(a, finalUrl)`。
- **`src/components/papers/WebSnapshotView.tsx`**：`<iframe sandbox="allow-same-origin" referrerPolicy="no-referrer" scrolling="no">`（**绝不加 allow-scripts**：同源沙箱 + 脚本 = 页面可自行摘掉沙箱；单测断言 sandbox 属性恰为 `allow-same-origin`）。**不在 iframe 内滚动**（iOS Safari 会自动撑开 iframe；`scrollReaderTo`/IO/选区条都假定 `main` 容器滚动）：iframe 是**惰性自适应高度文档**，放在现有 `main`（`readerRef`）滚动容器内，`iframe.contentWindow.ResizeObserver` 观察 `documentElement` 同步 `iframe.style.height`；快照模式下 `main` 加 `p-0 overflow-x-hidden`。`useMemo(decodeWebSnapshot)`；挂载时创建 blob URL（卸载/换 bytes 时 revoke），`srcdoc` 赋值；`onLoad`：RO、点击拦截、`onReady(api)`、注册选区源。
  - 进度/可见区间：**在父窗口**建 IntersectionObserver（`root:null` 隐式根，观察 iframe 文档里的 `[data-pc-block]`——规范要求 root 与 target 同文档，不能传 `main`；祖先链 `main` 的 overflow 裁剪已计入），两个观察器与 `rootMargin` 语义照 `BlockReader.tsx:292-343`。
  - 译文：`both` = 在宿主元素**内部**追加 `<div|span class="pc-zh" data-hl-host="zh" data-translated="zh" lang="zh-CN">`（td/th/行内串用 `span` + `display:block`；继承站点该元素的字体字号），骨架/失败 chip（`<button data-pc-retry="N">重试</button>`、`<a data-pc-nav="/settings">`）同 BlockReader 语义；`zh` = 另把原始子节点（除 `.pc-zh`）包进 `<span class="pc-orig" hidden>`（WeakMap 记忆、可逆）；`orig` = 删 `.pc-zh`、解包 `.pc-orig`。orig/both 模式下原始 DOM 零改动。译文数据来自**现有** `useTranslations`（按 blockIndex，与文本视图共享缓存）。
  - 高亮：宿主 = 打标元素（orig）或 `.pc-zh`（zh）；先解包已有 mark + `normalize()`，`validRanges(hostText(host), rows)` 后用 TreeWalker（跳过嵌套宿主）跨文本节点包 `<mark data-highlight-id>`。
  - **`selectionOffsets.ts` 修正**：`hostOffset` 改用 `host.ownerDocument.createRange()`（父文档 Range 对 iframe 节点 `comparePoint` 抛 WrongDocumentError，现被吞成 0 → 偏移悄悄算错）；宿主文本改用 `hostText`（排除嵌套宿主，这样 `both` 模式下译文嵌在原文宿主内也不破坏 `host.textContent === block.text` 不变式）；块查找从 `#paper-block-N` 改为 `[data-block-index="N"]`（BlockReader 已有该属性，`BlockReader.tsx:393`）；`captureHighlightRanges(range, container)` 签名不变。
  - **`SelectionActions.tsx` / `HighlightActions.tsx` 桥接**：新增可选 prop `getSources?: () => SelectionSource[]`，`SelectionSource = {doc: Document; container: HTMLElement; offset: () => {x,y}}`，默认 `[{doc: document, container: readerRef.current, offset: () => ({x:0,y:0})}]`；事件（pointerup/selectionchange/click/keydown）挂在各源的 `doc` 上，矩形加 `offset()`（iframe 的 `getBoundingClientRect()`）。iframe 文档的事件不会冒泡到父 document（`SelectionActions.tsx:104-107`、`HighlightActions.tsx:60-62` 现只监听父文档）。
  - 链接：iframe 文档捕获阶段拦截全部点击：`#frag` → 父页 `scrollReaderTo` 到对应元素；http(s) → `window.open(href,'_blank','noopener')`；其余忽略（沙箱无 popups/forms，但 iframe 仍可**自导航**到外站——必须拦截）。
  - 跳转 API：`scrollToBlock(i,{flash,behavior})` = `main.scrollTo({top: readerScrollTop(main.scrollTop, iframeRect.top + elRect.top, mainRect.top + main.clientTop)})`（`anchors.ts:171`）+ `flashElement`（iframe CSS 里定义 `.paper-flash`）；`container()` 返回 iframe body；`selectionText()`。
- **工作台接线**（`PaperWorkbenchPage.tsx`）：`isSnapshot = paper?.mime === WEB_SNAPSHOT_MIME`（mime 随 papers 行同步，仅拉到 blocks 的设备可立即用文本视图，原貌视图懒拉文件——复用 330-357 的 bytes effect，`fetchRemoteFileToLocal` 保留 `Content-Type` mime）。视图切换按钮在 `format==='pdf' || isSnapshot` 时显示，文案 `网页原貌 / 文本视图`；初始模式（273）`format==='pdf' || isSnapshot ? (p?.mode ?? 'original') : 'text'`；`changeLang`（503-514）在 `isSnapshot` 时不再强制切文本视图；`scrollAndFlash/alignToPosition`（425-485）在快照原貌模式下用 `resolveAnchor(anchor, ctx, 'text')`（块精度）后调 `snapshotApiRef.current?.scrollToBlock`；渲染分支（1036）`mode==='original' && (format==='pdf' || isSnapshot)` → `bytes ? (isSnapshot ? <WebSnapshotView/> : <PdfViewer/>) : …`；`handleHighlight`（637-652）容器取 `snapshotApi.container()`，`onHighlight` 在 `mode==='text' || isSnapshot` 时启用；`handleVoiceTranscript`（720-754）选区文本取 `snapshotApi.selectionText()`；头部 FORMAT 标签显示「网页原貌」；URL 论文头部新增「重新导入（网页原貌）」→ `navigate('/papers?reimport=' + paper.id)`。

### 2.4 UI 与迁移

- `UrlImportDialog.tsx`：`presentation` 单选「网页原貌（默认）/ 阅读模式」，说明：原貌仅支持单个链接、约 10–30s、保存整页样式与图片、视频不保留、依赖交互才出现的内容只保留初始态；`PHASE_LABEL` += `rendering:'渲染页面'`、`assets:'抓取资源'`、`packing:'打包'`，资源阶段显示 `done/total`；失败态提供「改用阅读模式重试」按钮（以 `presentation:'reader'` 重提）；props `onSubmit(urls,{presentation})`、`initialUrl?`、`reimport?:{paperId,title}`（文案：将替换「title」的正文，保留 Copilot 会话与阅读进度；已有高亮与译文缓存会被清除）。
- `PapersPage.tsx`：`runUrlImport(urls, opts)` 传 `presentation` 与新 deps（`buildSnapshot`/`fetchAsset`/`findByFinalUrl`/`ensureStorage` 全部动态 import）；`?reimport=<id>` 查询参数（HashRouter 下 `useSearchParams` 可用，同工作台 287-294）→ 打开重导入模式弹窗 → 提交后在 `queueRef` 串行队列跑 `reimportUrlPaperInPlace`；去重面板文案泛化为「与已有论文相同（同一链接或字节一致）」。存量 URL 论文不自动转换。
- 已知限制（写进弹窗与 README）：视频不保留；hover/点击才出现的内容只有初始态；页面媒体查询按阅读列宽度生效（响应式站点在窄列会走移动布局）；跨站 `<use href="x.svg#id">` sprite 不保留；CSS `url()` 对第三方主机的请求（追踪像素）无法阻断——文档说明。

### 2.5 测试

- vitest（`// @vitest-environment happy-dom` 的文件沿 `extractArticle.weixin.test.ts:14-26` 的 `nodeName` 补丁）：`webSnapshot.test.ts`（node：往返、同输入两次字节与 sha 完全一致、资源排序去重、魔数/头长/JSON/形状损坏 → corrupt、`parseWebSnapshotBytes` 原样返回 `header.blocks`、`looksLikeWebSnapshot`）；`parseHtmlBytes.test.ts`；`cssRewrite.test.ts`（相对/绝对/data:/#frag/引号 url()、带 media 的 @import、深度上限、占位往返、`escapeCssForMarkup` 保 `content:"<"` 语义并中和 `</style>`、`@font-face` 识别）；`stampBlocks.test.ts`（标题/段落、嵌套 li/ul 的 run 包裹、混合 div、figure>img+figcaption、独立 svg、table 单块、nav/aria-hidden/data-pc-hidden 跳过、<20 字泛型跳过、pre 空白原样；不变式 `hostText(el)===block.text`、索引连续文档序、section 追踪）；`fidelitySanitize.test.ts`（保 `<style>`（`\3c` 转义）/style 属性/内联 svg + `use[href=#x]`/math/`mjx-*`/`button`/`data-pc-*`，剥 script/on*/javascript:/iframe/object/form/input/link/meta/base/foreignObject/video/`use[href=https]`，输出以 `<html` 开头）；`captureStatic.test.ts`（base 解析、data-src 提升、picture 解包、video → poster/占位、annotation 删除、katex 开关）；`captureAgent.test.ts`（`serialize()` 剥脚本/on*/javascript:、保 style、link → data-pc-sheet；自包含断言；`buildCaptureSrcdoc` 顺序 CSP→base→agent）；`snapshotDom.test.ts`（水合占位与 CSP/阅读器 CSS 注入；`applyLangState` orig→both→zh→orig 后 `innerHTML` 完全复原；`applyHighlights` 跨拆分文本节点包 mark 且幂等解包；`hostText` 排除 `.pc-zh`；`pickLinkAction`）；`selectionOffsets.test.ts`（新：第二个 Document 的跨文档 Range 偏移、嵌套宿主排除）；`urlImport.test.ts` 增补（snapshot 分支调 `buildSnapshot` 并存新 mime 与 `source.capture`；`findByFinalUrl` 命中先于构建；多 URL + snapshot 回退阅读模式并留提示；`reimportUrlPaperInPlace` 保 paperId、清高亮/译文、进度归零、以新 sha ready）；`paperRepo.test.ts` 增补 `replaceFile` 事务语义；`WebSnapshotView` 用 `renderToStaticMarkup`（照 `highlightRender.test.ts`）断言 `sandbox="allow-same-origin"`、`referrerpolicy="no-referrer"`。
- server（`server/test/fetchUrl.test.ts` 既有桩）：`kind:'asset'` 对 text/css、image/svg+xml、font/woff2、octet-stream 嗅探 wOF2/PNG → 200 且 Content-Type 正确；video/mp4 → 415；`kind:'page'` 仍拒 svg；asset 桶与 page 桶互不影响；asset 8MB → 413；asset 请求 `accept` 含 `image/*`；非法 kind → 400。
- E2E（Chrome 桌面 + iOS Safari；注意隐藏 tab rAF 陷阱 / HashRouter 需显式 reload）：① https://openvdn.github.io/ 原貌导入 → 阶段「渲染页面 → 抓取资源 n/N → 打包」→ 原貌视图：远程 Newsreader 字体、7 个图（CSS 条形图与 JS 生成的 attention 网格）、MathJax 公式、logo 来自 blob、视频条为占位；目录 21 个标题、点击滚动闪烁；划词 → 快捷条位置正确 → 高亮 → mark 可见且在「高亮」tab 列出 → 点 mark 取消；中文/对照 就地出译文；切「文本视图」同一套块/译文/高亮；刷新恢复模式；第二台设备（或清库后登录）文本视图即时、原貌在拉到文件后可用；「重新导入（网页原貌）」保 paperId 与会话。② arXiv HTML（如 `https://arxiv.org/html/2412.06464`，MathML + `<base>` 相对图）。③ 微信文章：弹窗强制阅读模式并提示。④ 失败路径：frame-buster 页 → 静态回退；100+ 资源 → 「跳过 N 个资源」；资源 429 退避。⑤ 手机：iframe 高度正确（无内滚）、选区条定位、Copilot 面板盖住阅读区。

### 2.6 分步与并行（同波内文件不相交）

| 步 | 内容 | 文件 | ~LOC | 并行组 |
|---|---|---|---|---|
| 0a | 容器 + mime + 解析分流 + 类型 | `webSnapshotMime.ts`、`webSnapshot.ts`、`parseHtmlBytes.ts`、`types.ts`、`validate.ts`、`PapersPage.tsx:69-80`、测试 | 350 | A（先冻结契约） |
| 0b | 服务端 asset kind + 客户端 API | `shared/apiRoutes.ts`、`shared/apiTypes.ts`、`server/src/lib/fetchRaw.ts`、`server/src/routes/fetchUrl.ts`、`server/test/fetchUrl.test.ts`、`fetchUrlApi.ts` | 250 | B |
| 0c | 打标 | `stampBlocks.ts` + 测试 | 450 | C |
| 0d | sanitize + CSS 改写 | `fidelitySanitize.ts`、`cssRewrite.ts` + 测试 | 400 | D |
| 1 | 静态捕获 + 编排 + 导入接线 + 弹窗 | `captureStatic.ts`、`snapshotAssets.ts`、`buildSnapshot.ts`、`urlImport.ts`、`UrlImportDialog.tsx`、`PapersPage.tsx`、测试 | 900 | 0a–0d 之后（单代理）；可交付：快照落库、文本视图可用、finalUrl 去重 |
| 2 | 阅读器 | `snapshotDom.ts`、`WebSnapshotView.tsx`、`SelectionActions.tsx`、`HighlightActions.tsx`、`selectionOffsets.ts`、`PaperWorkbenchPage.tsx`、测试 | 1100 | E（只依赖 0a 契约，可用 fixture 快照先行） |
| 3 | 渲染捕获层 | `captureAgent.ts`、`captureRendered.ts`、`buildSnapshot.ts`（renderer 开关一处）、测试 | 500 | F（与 2 并行；`buildSnapshot.ts` 在 1 之后再合） |
| 4 | 原地重导入 + 仓储 + 工作台按钮 + `?reimport` + 空心态按钮接线（Part 1.4）+ KaTeX 静态回退（可选）+ 跳过资源报告 | `paperRepo.ts`、`syncedRepos.ts`、`urlImport.ts`、`PapersPage.tsx`、`PaperWorkbenchPage.tsx`、`captureStatic.ts` | 400 | 1–3 之后 |

风险跟踪：DOMPurify unwrap 改变块内空白（B11 复核兜底）；依赖 `:first-child`/`>` 的站点 CSS 在插入 `data-pc-run` 处（仅混合容器）可能错位——接受；Vite 升级需复核 `css?url` 行为；30MB 资源集的 blob 内存——上限保守；将来若给站点加 CSP 响应头，两个 iframe 都会继承，必须放行 `blob:`/`https:`/`'unsafe-inline'`。

---

## 交付方式（沿用项目惯例）

- 获批后先把本计划另存为项目内新文件 `PLAN-web-snapshot-sync.md`（不覆盖已交付 PLAN 文档），随代码提交。
- **发布顺序**：Wave 1（Part 1 P0：1.1/1.2/1.4/1.5 核心/1.6 服务端 allowlist）→ `deploy.sh --all`（1.3 的 `/sync/summary` 与 1.6 必须服务端先于客户端）→ Wave 1b（1.3 对账 + 1.5 UI + 1.6 客户端）→ Wave 2（Part 2 步骤 0a–0d 四个并行代理 → 1 → 2/3 并行 → 4）→ `deploy.sh --all`。
- 实施：专职子代理按上表文件归属分工（Part 1：引擎代理 / 服务端代理 / 工作台代理 / 列表代理 / 同步扩表代理；Part 2：A–F 组）；每波 `npm run build` + vitest + `cd server && npm test`；deploy.sh 的「论文陪读」grep 自检照旧。
- E2E 验收环：codex CLI（gpt-5.6-terra，xhigh）浏览器 + API 双通道，按 1.7 与 2.5 清单，P0/P1 修到 0 或 3 轮。
- 发布说明：发版后仍开着的旧包 tab 不监听频道也不轮询，会继续饿死新 tab——提示用户关闭/刷新旧 tab；两篇空心论文由对账自动补推（`ae36c53b`）或在阅读器点「从原网址重新导入」（`62cfa12b`）。
