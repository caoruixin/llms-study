# PLAN：论文陪读「导出 PDF」（中文 / 对照）+ Paper Copilot 选区操作改为输入框引用

> 状态：2026-10-08 用户批准 → 2026-10-09 实施完成（typecheck / 2381 单测 / build 通过，QA 三轮 P0/P1 清零），待部署与生产复验（记录见文末 §F）。分支：从当前 `feat/pdf-inline-translation`（c0d26d5，PR #15 待合并）切 `feat/export-pdf-copilot-compose`；若 PR #15 先合入 main 则 rebase 到 main。`.e2e-qa-fixtures/`、`HANDOFF-*.md` 保持未跟踪。批准后第一步：把本文存为项目根 `PLAN-export-pdf-copilot-compose.md`。

## Context

两项用户需求（2026-10-08）：

1. **导出 PDF**：论文陪读里切到「中文 / 对照」后，一键把当前版本导出成 PDF 文件（直接下载，不走打印对话框）。已确认范围：**原版 PDF 视图**导出保留版式的真 PDF（中文 = 译文原位覆盖；对照 = 原文条带 + 译文流），**文本视图 / 网页原貌 / DOCX / URL 论文**导出重新排版的中文版或对照版。
2. **Copilot 选区操作**：现在「解释这段 / 更简单 / 推导公式 / 举例 / 加入提问」都只是把一张卡片塞到 Copilot 面板**顶部**的「待提问」区，聊了几轮后要翻回顶部才能点。已确认改成 Codex 式：解释类操作**立即在对话末尾发起**（回答进行中则在输入框上方排队、结束后自动发起），「加入提问」变成**输入框上方的引用 chip**（可叠多条，随问题一起发送），顶部「待提问」区整体移除，对话自动滚到底。

### 现状事实（已核对代码）

- 翻译是懒的：`useTranslations.ts` 调度器只翻当前块前 4 后 16（`translateBatch.ts:39-40`），全篇从没整体翻过 → 导出前必须先补全译文（成本确认 + 进度 + 可取消）。
- 应用里**没有任何导出 / 打印 / PDF 生成代码**；`pdfjs-dist 6.2` 只用于解析与查看；服务器 nginx 只有 `gzip_static`（无 brotli），跨境链路实测 ~17 KB/s（`vite.config.ts:146`）→ 中文字体文件体积要控制。
- 原版 PDF 就地译文的几何契约在 `src/lib/paper/pdfLayout.ts`（`segmentsOnPage / partitionPageFlow / translationBounds / planFontFit / splitTranslation`），覆盖层 `PdfZhOverlay.tsx`（`buildPieces` 盒子 / 字号拟合 / 背景取样），对照流 `PdfFlowPage.tsx`（条带裁切 + 译文框 CSS `ReaderContext.tsx:163-168`）。导出复用这套几何，不另写一份真相。
- Copilot：`pendingAsks` 在 zustand（`paperUiStore.ts:205,275-278`，不落盘）；面板 `CopilotPanel.tsx` 把队列渲染在滚动列表顶部（:1334-1375）；`consumeAsk`（:615-637）；粘底 `stickRef` 只在 `submit` / 语音提问里复位（:1246, :1190）；手机端面板收起即卸载（`PaperWorkbenchPage.tsx:1269`）→ 输入框引用必须放 store。消息 `CopilotMessage`（`types.ts:267-293`）同步到服务端是不透明 JSON，加字段安全。
- 选区条标签与宽度被 E2E 断言（`.e2e-qa-fixtures/highlight-e2e.mjs:276`），不改。

## 交付方式（沿 feature-delivery-workflow）

1. 批准后先把本计划存为 `PLAN-export-pdf-copilot-compose.md`（项目根，不动旧 PLAN 文档）。
2. 按文件归属分波派实施子代理（fable：调度器 / 几何 / 导出内核；opus：UI 组件与面板；sonnet：机械核验与脚本）。每波 `npm run typecheck && npm test && npm run build`。
3. QA：专职子代理（非 fable）跑 API 级 + Playwright 浏览器 E2E，P0/P1 修到 0 或 3 轮；最后在用户 Chrome 上做生产复验。

---

# A. 导出 PDF（中文覆盖版 / 中英对照流版 / 文本排版版）

## A.0 口径

| 当前视图 | 导出版本（`exportFlavorFor({mode, pdfInPlace, langMode: translateLang})`） |
|---|---|
| 原版 PDF + 中文（`mode==='original' && pdfInPlace`） | **中文覆盖版**：原 PDF 每个已译正文段落框盖底色矩形 + 中文（版式、图、公式、页数不变；原文仍在框下可搜索） |
| 原版 PDF + 对照 | **中英对照流版**：每个原页 → 一张同宽、变高的新页，原文按条带（矢量裁切）排布，每条可译条带下接译文框，双栏并排——与屏幕对照流同一几何 |
| 其余（文本视图 / 网页原貌 / DOCX / URL / 旧版解析 PDF）| **文本排版版**：A4 重排，中文 = 译文（不可译块原文），对照 = 原文 + 译文框 |
| 原文 / 敏感论文 / 未 ready / 空壳论文 | 不显示按钮 |

注意 `pdfInPlace`（`PaperWorkbenchPage.tsx:578`）不含视图判断——带 layout 的 PDF 在文本视图下必须导出文本排版版。

机制：纯客户端 `pdf-lib@1.17.1` + `@pdf-lib/fontkit@1.1.1`（只从导出模块动态 `import()`，`manualChunks` 加 `vendor-pdflib`，正则只匹配 `pdf-lib|@pdf-lib/*`——`pako`/`tslib` 与 mammoth/jszip 共用，不能卷进来）。文件名 `${stem}.中文.pdf` / `${stem}.中英对照.pdf`，`a[download]` + blob URL 直接下载。

## A.1 翻译补全 `translateAll`（`src/lib/paper/translate/`）

- `translateBatch.ts` 新增 `planFullTranslation(blocks, cache)`（文档顺序、全部缺译可译块、与 `planTranslationWindow` 同一 `expandBlock` 切片）与 `translatableIndices(blocks)`。
- `useTranslations.ts` 调度器新增：
  ```ts
  translateAll(opts?: { signal?: AbortSignal; onProgress?: (p: TranslateAllProgress) => void }): Promise<TranslateAllResult>
  // TranslateAllProgress { done; total; failed; pausedUntil: number | null }
  // TranslateAllResult { outcome: 'done'|'aborted'|'halted'; halt?: 'consent'|'auth'|'blocked'|'sensitive'; texts: Map 快照; translated; failed: number[]; total }
  ```
  内部：`full` 状态对象（onProgress/signal/resolve）；`recompute()` 在 full 模式改用 `planFullTranslation`；`apply/markFailed` 后回报进度；每处 `halted = true` 同时记 `haltReason`（consent 拒绝 :307 / GatewayError :268 → blocked / auth :275）；`pauseFor` 记 `pauseUntil` 并在定时器续跑后 `settleFull()`；`drain` 的 finally 里 `running=false` 后 `settleFull()`；`settleFull`：disposed→aborted，halted→halted，paused→只报进度，`running||inFlight` 退，否则 `recompute()`，有队列 `schedule()`，否则 `finishFull('done')`；`finishFull` 清 full、解绑 abort、`recompute()` 回窗口模式、resolve（在飞的包仍经 `apply` 落库）。进入时沿 `activate()` 复位（清熔断定时器、halted/authIssue 清零、`loadPromise`），`paper.sensitive` → 直接 `halted/sensitive` 不碰网关；`failed.clear()` 让此前失败块在全篇模式下恰好再试一次；重复调用返回同一 promise；`dispose` 中止。
- Hook `UseTranslationsResult` 加稳定的 `translateAll`。
- 成本预估：`estimateTranslationCost(blocks.filter(b => hasTranslatableText(b) && !texts.has(b.index)), PAPER_TASKS.translate.cap.pricing)`（`paperPolicy.ts:137-138`，别写死 `DEEPSEEK_V4_PRO`）；`batches` 兼作时长提示（单飞，30 页 ≈ 10–15 包 ≈ 1–3 分钟）。
- 授权沿现有 `ensureConsent` → 页面 `ConsentDialog`；`ExportDialog` 渲染在 `ConsentDialog` 之前（同为 `fixed inset-0 z-50`，靠 DOM 序让授权框压在上面）。

## A.2 中文字体

- 资产：`src/assets/fonts/NotoSerifSC-sub.ttf`（提交到仓库）+ `README.md`（来源、命令、实测体积）+ `.gitattributes` `*.ttf binary`。构建脚本 `scripts/build-cjk-font.sh` + `scripts/cjk-font-unicodes.py`：Google Fonts 的 **TrueType 变量字体** `NotoSerifSC[wght].ttf`（不用 CFF/CID 的 Source Han——fontkit 对 CFF CID 子集化有已知 glyph 映射缺陷）→ `fonttools varLib.instancer wght=400` → `pyftsubset --no-hinting --layout-features='' --drop-tables+=GSUB,GPOS,vhea,vmtx,VORG,BASE,JSTF,DSIG,meta,STAT --notdef-outline`。码点：ASCII、Latin-1、`2000-206F`、`2070-209F`、`2190-21FF`、`2200-22FF`、`25A0-25FF`（含 `□` 作缺字占位）、希腊 `0370-03FF`、`3000-303F`、`FF00-FFEF`、GB2312 全部汉字（6763）。预期 ≈7.5k 字形、≈3 MB 原始 / ≈2.0–2.3 MB gz，**预算 ≤ 2.5 MB gz**；超了依次退：Noto Sans SC → 一级汉字 3755。
- `src/lib/paper/export/cjkFont.ts`：`import fontUrl from '…/NotoSerifSC-sub.ttf?url'`（Vite 哈希）；`loadCjkFont({signal,onProgress})` 模块级记忆（失败重置可重试），`body.getReader()` 流式报字节；fontkit `create(bytes)` 提供 `unitsPerEm/ascent/descent/hasGlyph/advance(cp)`（去掉 GSUB/GPOS 后 cmap 1:1，`Σ advance × size/upm` 即精确宽度，与 pdf-lib 写出的 `/W` 一致）；`sanitizeForFont(text)`：NFC、`\t`→两空格、NBSP→空格、去控制符、缺字→`□`。输出 PDF `embedFont(bytes, {subset:true})` 一次（30 页 ≈ 1.5k 字 ≈ 0.5 MB）。
- **Spike 门（实施第 1 步）** `src/lib/paper/export/cjkFont.spike.test.ts`（node，TTF 不存在则 skip）：pdf-lib 嵌入子集字体画 500 个不同汉字 + 标点 → `save()` → `pdfjs-dist/legacy/build/pdf.mjs` `getTextContent()` 回读完全相等（沿 `normalizePdf.arxiv.test.ts:18-19` 用法）；`widthOfTextAtSize` 与自测量误差 < 0.05 pt；输出 < 400 KB。失败 → `subset:false`（整字体嵌入 ≈3 MB）→ 再退 Noto Sans SC。
- 构建/部署：`scripts/precompress.mjs:14` EXT 加 `.ttf`；nginx `gzip_static on`（`deploy/nginx-llm-pro.conf:151`）不看 `gzip_types`、`/assets/` 已 immutable（:41-43），无需改；`scripts/deploy.sh` 自检加 `ls dist/assets/NotoSerifSC-sub-*.ttf.gz`；部署后 `curl -sI -H 'Accept-Encoding: gzip' …ttf | grep content-encoding`。flag-off 构建：所有新模块在 `src/lib/paper/export/` 与 `src/components/papers/` 下，整棵子树被 `paperCopilotOffPlugin` 置空，字体不会被打进去。

## A.3 文本排版工具 `src/lib/paper/export/textLayout.ts`（纯函数，node 单测）

- `tokenize(text): Atom[]`：CJK 码点逐字一个 atom；拉丁字母数字串连同紧邻 ASCII 标点一个 `word`（闭标点粘前、开标点粘后）；空白 `space`；`\n` `break`。
- `wrapText(text, maxWidth, measure, {firstLineIndent?, hangingIndent?}): WrappedLine[]`：贪心填充 + 避头尾：行首禁 `，。、；：？！”’）》」』】〕〉…` 与 ASCII `, . ; : ? ! ) ] }`，行尾禁 `“‘（《「『【〔〈 ( [ {`，整行只剩一个 atom 时允许悬挂不死循环；超宽 atom（URL）按码点硬切（= `overflow-wrap: anywhere`）。
- `justifySpacing(line, maxWidth, size)`：**只用 `Tc`（setCharacterSpacing）**——`Tw` 对 Identity-H 双字节 CID 字体无效（PDF 32000 §9.3.3）；硬换行/末行为 0；间距 > `0.08×size` 则放弃对齐（左对齐）。
- `fitTextInBox(text, {w,h}, {f0, pitch0, fMin, indent, measureAt, maxRounds=6})`：镜像 `PdfZhOverlay.fitFonts` 但无 DOM——每轮 wrap → `need = lines×pitch`，溢出用 `planFontFit(box.h, need, f, fMin)`（`pdfLayout.ts:818`）缩，到下限仍溢出 → `overflow:true`，保留能放下的行并把末行尾部换 `…`。
- `baselineOffset(size, pitch, metrics)`：CSS 行盒模型 `(pitch − contentH)/2 + ascent×size/upm`。

## A.4 共享几何（`src/lib/paper/pdfLayout.ts`）

把 `PdfZhOverlay.tsx:99-184` 的 `Piece` / `buildPieces(portions, blockOf, scale, {round?})` 及其常量搬到 `pdfLayout.ts` 导出（`round:false` 给导出用——行框有 0.1 pt 精度，DOM 继续 `round:true`）；新增 `pieceText(piece, fullText)`（即 :290-304 的 `splitTranslation` 分派）与 `groupBlocksByPage(blocks)`（从 `PdfViewer.tsx:558-572` 抽出，viewer 改用它——导出传给 `segmentsOnPage` 的必须是 viewer 同一份「本页有 seg 的块」列表，`isLabelLike` 的页级上下文才一致）。`sampleBackgrounds` 留在 `PdfZhOverlay.tsx` 但 `export`。覆盖层组件改为引用这些导出，像素行为不变（`PdfZhOverlay.test.ts` 继续通过）。

## A.5 原版导出内核 `src/lib/paper/export/`

### `exportTypes.ts`
`ExportFlavor = 'pdf-zh-overlay' | 'pdf-both-flow' | 'text-zh' | 'text-both'`；`DrawOp = text | rect | line | strip | image`（全部 PDF 用户空间，y 向上）；`PagePlan { width; height; base: {kind:'existing'; index} | {kind:'new'} | {kind:'copy'; srcPage}; ops }`；`ExportProgress { phase: 'lib'|'font'|'open'|'pages'|'save'; done?; total?; bytes? }`；`ExportInput { paper; blocks; texts; flavor; getBytes; signal?; onProgress? }`；`ExportResult { bytes; fileName; pageCount; untranslated; flavor; fellBackToText?: string }`；`ExportError { code: 'aborted'|'font'|'bytes'|'parse'|'unknown' }`；`cssColorToRgb`。

### `inPlacePlan.ts`（纯规划器，可用假 `measureAt` 单测）
- **坐标**：全部几何来自 pdf.js `page.getViewport({scale:1}).rawDims`（与 viewer `PdfViewer.tsx:524-532` 同源），CSS→PDF：`x' = cssX + pageX`，`y'(底) = pageY + pageHeight − (cssY + h)`，基线 `y' = pageY + pageHeight − baseline`。不用 pdf-lib `getSize()`（MediaBox 口径）。`/Rotate ≠ 0` 的页：viewer 本就不给块（`PdfViewer.tsx:583`），导出同样原样保留 / `copy`。
- `planOverlayPage({geom, portions, blockOf, texts, backgrounds?, font, measureAt})`：对每个 `prose && !label && hasTranslatableText` 的片取 `pieceText`，缺译跳过（原文可见，按块计 1 次未译）；`fitTextInBox(text, box, {f0: piece.f0, pitch0: piece.lh0, fMin, indent})`；ops = 底色矩形（`backgrounds.get(key) ?? 白`）+ 逐行文字（居中片按 `(box.w − line.width)/2`，否则首行缩进 + `Tc` 对齐；颜色 `#1a1814`；heading 用 `Tr 2` 描边 `0.028×size` 仿粗，可选抛光）。
- `planFlowPage({page, geom, rows, textBounds, texts, blockOf, bodyLineH, font, measureAt})`：`fz = clamp(0.92×bodyLineH, 7, 12)`，`pitch = 1.7×fz`；自上而下走 `rows`（与 `PdfFlowPage` 同序）：full 行 = 条带 `[0,pageWidth)×rect.h`，columns 行 = 左右两栈各自累加、行高取 max；`showTranslation && texts.has(i)` 的条带下接译文框：x 范围 `[max(s.x+4, bounds[0]), min(s.x+s.w−4, bounds[1])]`（镜像 `zhInset` :227-233；无 bounds 或 < 40 → 条带内缩 8），`boxH = 2×3 + lines×pitch`，ops = 5% 色底 `(0.981,0.958,0.961)` + 1.5 pt 左线 `(0.848,0.667,0.691)`（accent `#9e2b3a` 混白）+ 文字（左内边 6），上下外边 2/4；无译条带精确前进 `rect.h`。页高 `H = 末 y`；条带 op：`clip = {x: dst.x, y: H − dst.y − src.h, w, h}`，`tx = dst.x − src.x − pageX`，`ty = H − dst.y − pageY − pageHeight + src.y`。

### `exportPdfInPlace.ts`（执行器）
- 公共：`ensurePdfCompat()` + `import('pdfjs-dist')` + `GlobalWorkerOptions.workerSrc`（沿 `PdfViewer.tsx:39,412-415`）；`getDocument({data: bytes.slice(0)})`；`registerFontkit`、`embedFont` 一次；每页检查 `signal`；`finally` 里 `page.cleanup()` / `loadingTask.destroy()`；`setTitle/setModificationDate`；`save({useObjectStreams:true})`。
- **覆盖版**：`outDoc = PDFDocument.load(bytes)`（抛错 / 加密 → `ExportError('parse')` → 编排层自动改走文本排版版并提示）；每页有覆盖片才离屏渲染（scale 1、DPR 1）取 `sampleBackgrounds` 后立即归零 canvas（≈100–300 ms/页，进度「第 i/N 页」；无 2d 上下文→白底）；`runOps(outDoc.getPage(p−1))`。
- **对照流版**：`srcDoc = load(bytes)`、`outDoc = create()`；每个原页 **只 `embedPage` 一次**，且必须显式传 `boundingBox = {left: pageX, bottom: pageY, right: pageX+pageWidth, top: pageY+pageHeight}`（pdf-lib 默认 BBox 假设 MediaBox 原点 0,0，`drawPage` 不补偿 BBox）；每条带：
  ```ts
  page.pushOperators(pushGraphicsState(), rectangle(clip.x, clip.y, clip.w, clip.h), clip(), endPath())
  page.drawPage(embedded, { x: tx, y: ty })
  page.pushOperators(popGraphicsState())
  ```
  （XObject 共享，输出体积 ≈ 原文件；不要每条带 `embedPage` 带 bbox——会把内容流复制 N 份）。新页 `addPage([width, H])`（PDF 上限 14400 pt，对照页 ≤ ~2.5× 原页）；旋转页 `copyPages`。原页的链接注释不进 XObject（已知限制）。
- `runOps`：`text` → `pushGraphicsState() + setCharacterSpacing(cs)` → `drawText(sanitizeForFont(t), {x,y,size,font,color})` → `popGraphicsState()`（pdf-lib 的 drawText 自带 q/Q 但会继承 `Tc`）。
- pdf-lib 本地未安装、操作符导出名（`pushGraphicsState/popGraphicsState/rectangle/clip/endPath/setCharacterSpacing/setTextRenderingMode`）按记忆——`npm i` 后首个 `tsc` 核对，spike 测试是硬门。

## A.6 文本排版版 `textDocPlan.ts` / `textDocTables.ts` / `exportTextDoc.ts`

- 页 595×842、边距 54、页脚 `i / N`（8 pt，CSS y 812）。**全篇单字体**（Noto Serif SC 的拉丁字形排英文与代码）：单一测量路径，标准 14 字体遇到 `→`/希腊/数学/弯引号会抛错。
- 版式表：标题 18/1.4 粗 → meta 行 8.5（`fileName · N 页 · M 段 · 导出于 YYYY-MM-DD · 版本 · 译文为 deepseek-v4-pro 机器翻译`）+ 0.5 pt 分隔线；heading L1/L2/≥3 = 16/13.5/12 ×1.35，前距 16/12/10，`keepWithNext`；paragraph 10.5/1.65 两端对齐；list `•` + 悬挂 12；caption 9/1.5 居中灰；code 8.5/1.5 硬行、逐字换行、灰底 `#f4f4f5` 内边 6；formula 9.5 居中灰（`block.text` 纯文本）；table 8.5/1.4 网格（`sanitizeArticleHtml(block.html)` → DOMParser → tr/th/td 文本，列宽 ∝ `clamp(平均内容宽, 40, 200)` 归一到 487，> 8 列降 7 pt，仍放不下退回 `block.text` 段落，0.5 pt `#c8c4bc` 线、表头 `#f4f4f5`；行可跨页、单元格不拆、超 12 行 `…`；解析放 `textDocTables.ts` 以 happy-dom 测）；image 居中 `w ≤ 487, h ≤ 0.6×内容高`。
- 中文模式：可译块有译文→译文按类别排，缺译→原文（计未译）；不可译类别→原文。对照模式：原文行 + 译文框（同 A.5 配色，左内边 8）放**同一 Chunk**、`keepTogether`，跨页时框装饰按页段开合。
- `paginate(chunks, contentH)`：页顶丢 `spaceBefore`；`keepTogether && 整块 ≤ 页高` → 换页整放，否则按行拆（≥4 行时 2 行孤寡保护）；`keepWithNext` 末块随后继走。
- 图片 `loadImageForExport(src, signal)`：同源直接 `fetch`，否则走现有代理 `fetchUrl(src, {kind:'asset'})`（`src/lib/paper/url/fetchUrlApi.ts:50`，`BlockReader.tsx:77-79` 同款——跨域 `<img>` 不需 CORS 但 `fetch`/canvas 需要）；8 s 超时、并发 3、单图 ≤ 5 MB、总 ≤ 20 MB；png/jpeg 直接 `embedPng/embedJpg`（先 `createImageBitmap` 验码），svg/webp/gif → canvas（长边 ≤ 1600）→ PNG；失败 → 虚线占位框「[图片] + 图注」。

## A.7 编排、对话框、页面接线

- `exportPaper.ts`：`exportFlavorFor`、`FLAVOR_LABEL`（中文覆盖版 / 中英对照流版 / 文本排版版（中文）/ 文本排版版（中英对照））、`sanitizeFileStem`（NFC → 去 `[\u0000-\u001f\u007f\\/:*?"<>|]` → 折叠空白 → 去尾部 `.`/空格 → 80 码点；`title → fileName 去扩展名 → 'paper'`）、`exportFileName`、`countUntranslated(blocks, texts)`、`exportPaperPdf(input)`（`lib` → `font` → 分派；原版两种捕获 `ExportError('parse')` 自动改文本排版版并带 `fellBackToText` 提示；阶段间检查 `signal`）、`downloadBytes`（blob URL + `a[download]`，60 s 后 revoke）。
- `src/components/papers/ExportDialog.tsx`（props `{paper, blocks, flavor, texts, translateAll, getBytes, onClose, onDone}`，flavor 挂载时冻结；壳与按钮沿 `CostConfirm.tsx:21-22`）阶段：
  1. `confirm`（仅 `untranslated > 0`）：「导出前先翻译剩余 N 段（预计 $X，约 K 包）· 已译段落本地复用不重复计费」[取消] [翻译并导出]，次级链接 [直接导出（未译段保留原文）]。
  2. `translating`：进度条 done/total、失败数、熔断时「冷却中，N 秒后自动继续」；[取消] → abort → 关闭。`halted` → `error`（consent / auth / blocked 对应文案）+ [仍然导出（未译段保留原文）]。
  3. `generating`：「加载导出组件…」/「下载中文字体 x KB」/「处理第 i/N 页」/「写出文件…」+ [取消]。
  4. `done`：「已开始下载 {fileName}」+「N 段未译，已保留原文」+ 回退提示；[再次下载] [关闭]。
  5. `error`：[重试] [关闭]。Esc 只在 confirm/done/error 生效；卸载即 abort。
- `PaperWorkbenchPage.tsx`：`exportOpen` 状态；`exportFlavor = exportFlavorFor({mode, pdfInPlace, langMode: translateLang})`；`canExport = exportFlavor && !paper.sensitive && paper.status==='ready' && blocks.length > 0 && !isHollow(paper, blocks.length)`；按钮紧跟语言 tabs 包装层（:1319-1326）之后，`hidden … md:block`，`title="导出{FLAVOR_LABEL} PDF"`，文案「导出 PDF」；手机：目录抽屉（:1573-1577）顶部加一整行 `min-h-11` 按钮（点击关抽屉开对话框）；`getBytes = bytes ?? repo.getFileBytes ?? fetchRemoteFileToLocal(…)`（沿 :504-508），都没有 → `ExportError('bytes')`；`<ExportDialog>` 渲染在 `ConsentDialog`（:1618）之前；`useTranslations` 解构加 `translateAll`；完成 `setToast('已导出 …')`。

---

# B. Paper Copilot：选区操作改为「立即发起 + 输入框引用」

## B.1 语义

| 操作 | 新行为 |
|---|---|
| 解释这段 / 更简单 / 推导公式 / 举例 | 立即在对话末尾发起一轮（用户气泡 = 动作小签 + 可跳回原文的引用块；无中间卡片）；回答进行中则进入输入框上方「排队中」chip，本轮结束后自动发起下一条；× 取消；用户按「■ 停止」后队列暂停（chip 保留，点 chip 手动发） |
| 加入提问 | 进入输入框上方「引用」chip（同一论文最多 5 条，第 6 条拒绝并 toast；不静默丢旧的）；点 chip 展开预览；随输入的问题一起发送后清空；桌面/平板加入后聚焦 textarea |
| 顶部「待提问」区 | 整体删除（含 `clearPendingAsks` / `onClearAsks`） |
| 滚动 | 任何发起路径都复位粘底；不在底部且有新内容时显示「↓ 最新」浮钮 |

已核对的坑（实施必须照此做）：
- React 是 **18.3.1**（`package.json:21`），StrictMode 只在挂载时双跑 effect。
- `busy` 是 React 状态（由 `live` 推导，`CopilotPanel.tsx:437`），`getRunner().busy()` 在 `await ensureConsent` 之后才为真（:452）→ 两次快速点击会各 `addMessage` 一条孤儿气泡。**排队门闸用 `sendTurn` 里同步置位的 `occupiedRef`**，不用 `busy`。
- 历史给模型时用 `msg.content`（:466-469；`resendOrphan` :715-729、`deepAlternative` :759-777 同）→ 新消息把引用放 `quotes` 字段后，这三处必须改用 `historyTextOf(msg)` 把引用重新拼回去，否则模型看不到引用。
- `contextBuilder.ts` 的 1200 字裁剪只在阶梯第 4 步（:101, :225-230）；真正的硬上限是 `SELECTION_MAX_CHARS = 4000`（:142/:177）→ 多条引用在**组装时**按条配额，不改 builder 常量。
- `.e2e-qa-fixtures/qa-pdf-inline-lib.mjs:73-125` 的 LLM 桩只回 `{"items":[]}`（翻译用），Copilot E2E 需要按 `stream===true` 分流的聊天桩（JSON `choices[0].message.content` 即可走 `llmClient.ts:249-253` 回退）。
- 手机 sheet 收起即卸载面板并丢 runner（:412）：进行中的轮次会中断，队列在重开时续发——记录为已知行为。

## B.2 Store（`src/pages/papers/paperUiStore.ts`）

```ts
export type PaperAskFire = Exclude<PaperAskAction, 'queue'>
export interface AskQuote { text: string; anchor: SourceAnchor; translated?: boolean }
export interface PendingAsk extends AskQuote { id; paperId; action: PaperAskFire; label; at }   // 现在 = 动作 FIFO 队列（面板卸载也在）
export interface ComposerQuote extends AskQuote { id; paperId; at }
export const MAX_COMPOSER_QUOTES = 5
// state: pendingAsks（语义改为动作队列）、composerQuotes（新，运行时）
// actions: addPendingAsk（签名不变）、removePendingAsk、dropPendingAsks(paperId)（替代 clearPendingAsks）、
//          attachQuote(q): boolean（同论文 ≥5 返回 false 不写）、removeComposerQuote(id)、clearComposerQuotes(paperId)
```
`partialize`（:299-311）不动——两个数组都不落盘；更新 :11-12 / :204 注释。测试 `paperUiStore.test.ts`：白名单用例加 `attachQuote` 后键集不变；新 describe：5 条后第 6 条 false、跨论文互不影响、`dropPendingAsks` / `clearComposerQuotes` 只清本论文。

## B.3 工作台（`PaperWorkbenchPage.tsx`）

- `handleAskAction`（:1029-1045）：`queue` → `attachQuote`（false → toast「最多引用 5 段，请先发送或移除后再添加」）+ `setCopilotOpen(true)` + toast「已引用到 Copilot 输入框」；其余 → `addPendingAsk` + `setCopilotOpen(true)`（不再 toast，对话里的气泡/排队 chip 就是反馈）。
- `copilotPane`（:1240-1259）去掉 `asks / onRemoveAsk / onClearAsks`（面板自己订阅 store；现在每次渲染 `filter` 出新数组会让 effect 空转）。
- 离开论文清动作队列：`useEffect(() => () => { if (paperId) dropPendingAsks(paperId) }, [paperId])`；`composerQuotes` 有意保留（草稿）。
- `SelectionActions.tsx` 标签 / 400px 不动。

## B.4 纯逻辑模块 `src/lib/paper/askCompose.ts`（新，node 可测；面板 1678 行无法在 vitest node 下导入）

- 搬入 `ASK_TEMPLATES`（:136-144）→ `askTemplate(action)`、`TRANSLATED_ASK_NOTE`（:152）。
- `composeSelection(quotes)`: 1 条 → `slice(0, MAX_ASK_TEXT)`；n 条 → 每条配额 `max(800, floor(4000/n))`，截断处加「…（已截断）」，`'\n---\n'` 连接，最终再 `slice(0, 4000)`；空 → null。
- `composeAskTurn(quotes, question) → { question, selection, quotes }`：任一 `translated` 则前置 `TRANSLATED_ASK_NOTE`。
- `historyTextOf(m)`: 无 quotes → `content`；有 → `quotes.map(q => '"""\n' + q.text.slice(0,600) + '\n"""').join('\n')` + （content ? `\n${content}` : actionLabel ? 前置 `【label】\n` : ''）——快捷动作与今天 :633 的历史字节一致，token 不涨。
- `chipText(text, 40)`、`nextQueuedAsk(pending, paperId, firedIds)`。
- 可选小改：`contextBuilder.ts:144` 含 `'\n---\n'` 时引导语改「我选中了论文中的这些内容（多段以 --- 分隔）」+ 1 个用例；system prompt / 版本不动。

## B.5 面板（`CopilotPanel.tsx`）

- 删：`attachedAsk`（:206, :401, :598-601, :1591-1598）、`consumeAsk`（:615-637）、`paperAsks`（:1254）、三个 props（:99-101, :188-190）、待提问 `<section>`（:1334-1375）。
- 新状态/ref：`queued = pendingAsks.filter(paper.id)`（useMemo）、`quotes = composerQuotes.filter(paper.id)`（useMemo）、`occupiedRef`（同步在飞）、`firedRef: Set<id>`（幂等）、`drainTick`、`queuePaused`、`queueNotice`、`atBottom`、`hasNew`、`textareaRef`。
- `runSendTurn` 返回 `'ok' | 'failed' | 'skipped'`（:442 → skipped；:443-446 / :453-459 / :512-516 / :540-546 → failed）；`SendParams` 加 `quotes?: AskQuote[]`，落库时写入（:472-478）；历史用 `historyTextOf`（:467）。
- `sendTurn` 成为唯一入口：进入即 `occupiedRef = true; stickRef = true; setAtBottom(true); setHasNew(false)`，finally `occupiedRef=false; status!=='ok' → setQueuePaused(true); setDrainTick(+1)`（覆盖 submit / 语音 / 引导 / teach-back / deepAlternative / resend / retry 的粘底复位）。`stopTurn`（:919-922）同时 `setQueuePaused(true)`。
- `fireAsk(ask)`: `firedRef.add` → `removePendingAsk`（先于 sendTurn）→ `askTemplate` → `evidenceFromShortcut`（沿 :625-626）→ `sendTurn({ ...composeAskTurn([ask], tpl.question), task, planIsland:false, label, displayText:'', quotes })`。
- drain effect：`session === null` 先退（与语音 effect :1178 同序）；`occupiedRef || busy || queuePaused` 退；`head = nextQueuedAsk(usePaperUi.getState().pendingAsks, …)`（读 store 现值不读闭包）；`setQueueNotice('已发送排队中的「label」')`；`fireAsk(head)`。deps `[queued, session, busy, drainTick, queuePaused, paper.id, fireAsk]`。忙时新入队 → notice「已排队：解释这段（回答结束后自动发送）」。`fireNow(ask)`（点 chip）：未占用时 `setQueuePaused(false); setError(null); fireAsk`。
- `sendComposer(text)` 替代 `sendFree`：取 store 现值 quotes → `clearComposerQuotes` → `sendTurn({ ...composeAskTurn(qs, text), task:'chat', planIsland:true, extraDirectives:[LEARNER_DIRECTIVE], userAuthored:true, displayText:text, quotes })`；`submit` 同时 `setQueuePaused(false)`；有引用时 placeholder「针对引用的 N 段内容提问…」；发送仍要求非空文本。
- `resendOrphan` → `question: historyTextOf(msg)`、`quotes: msg.quotes`；`deepAlternative` → `historyTextOf(prevUser)`。
- 聚焦：`quotes.length` 增加且 `isMdUp && copilotOpen` → `textareaRef.current?.focus()`。
- 滚动：列表外包 `relative flex min-h-0 flex-1 flex-col`；`onScroll` 同步 `setAtBottom`、到底清 `hasNew`；粘底 effect 不粘时 `setHasNew(true)`；浮钮 `!atBottom && hasNew` → 「↓ 最新」（`absolute bottom-2 right-3 rounded-full border bg-panel px-3 py-1 text-xs text-accent shadow-md`）。
- 渲染：用户气泡 = 小签 + `m.quotes.map(<CopilotQuote>)` + `m.content !== '' && 正文`（旧消息 `"""` 烤在 content 里照常显示）；输入区 textarea 上方 `<ComposerAsks queued quotes busy={busy||occupied} paused onFire onRemoveQueued onRemoveQuote />`；唯一 `aria-live` 行（:1614）按优先级显示 sendBlocked / queueNotice / voiceNotice，4 s 清空。

### 新组件
- `src/components/papers/CopilotQuote.tsx`：`QuoteBlock({ quote, onJump })`，样式沿 `AskDialog.tsx:185`（`border-l-2 border-accent bg-panel-2 px-3 py-2 text-xs text-dim max-w-[min(92%,36rem)]`）；头行 = 「译文」徽章（:1358 类名）+ `§section · p.N` + 「回到原文 ↗」（有 onJump 才出）；正文 `line-clamp-3`，`text.length > 160 || 含换行` 时出「展开 ▾ / 收起 ▴」；按钮互为兄弟不嵌套。
- `src/components/papers/ComposerAsks.tsx`：两行 chips——「排队中」（label + chipText + ×，`!busy` 可点发起；paused 时提示「已暂停自动发送，点击芯片发送」）与「引用」（chipText + 译文徽章 + ×，点开展开 `QuoteBlock` 预览）。chip 类名沿 `:1404`（`rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[0.65rem] text-accent`）；`data-queued-ask` / `data-composer-quote` 供 E2E；`role="list"/"listitem"`，× 有 `aria-label`，chip 聚焦时 Delete/Backspace 移除并把焦点移到下一 chip 或 textarea。

## B.6 消息类型与同步

- `types.ts:267-293` `CopilotMessage` 加 `quotes?: { text; anchor?: SourceAnchor; translated?: boolean }[]`（用户侧；`content` 只放输入的问题，快捷动作为空串；旧行无 quotes）。Dexie `messages` 只索引 `[sessionId+createdAt]` → 无需升版本；`syncedRepos.ts:154-159` 整行镜像、服务端 `payload: z.unknown()` → 透明。旧客户端只显示小签气泡——写进 CHANGELOG。
- 更新 `PLAN-paper-copilot.md:120` 队列措辞（只改一行说明，不改交付记录的实质）。

## B.7 测试

- vitest：`askCompose.test.ts`（配额/连接/译文前缀/historyTextOf 旧消息透传与快捷动作字节一致/600 字封顶/nextQueuedAsk/chipText/derive→deep）；`paperUiStore.test.ts` 见 B.2；`CopilotQuote.test.ts`（renderToStaticMarkup：line-clamp-3、徽章、`p.7 / §4.2`、无 onJump 无按钮）；`ComposerAsks.test.ts`（happy-dom：点 chip 展开、Delete 移除、busy 时点排队 chip 不发）。
- Playwright（QA 代理）：① 解释这段立即出气泡 + 引用块 + 滚到底；② 持住首轮再点「更简单」→ 排队 chip + aria-live「已排队」→ 放行后自动发第二轮、顺序正确；③ × 取消排队请求数仍为 1；④ ■ 停止 → chip 留存「已暂停自动发送」，点 chip 发；⑤ 加入提问 ×2 → toast + 两 chip + textarea 聚焦 → 发送后气泡含两引用块、请求里 `---` 连接；⑥ 第 6 条拒绝；⑦ 点引用块回跳 `#paper-block-N` 进入视口；⑧ 「↓ 最新」出现与消失；⑨ 390×844 手机：加入引用→收起 sheet→重开 chip 仍在；⑩ `highlight-e2e.mjs` 工具条守卫不变、旧 `"""` 消息刷新后渲染不变。

---

# C. 实施波次与文件归属（并行代理按文件独占划分）

| 波 | 代理 | 独占文件 | 门禁 |
|---|---|---|---|
| 0 | sonnet | `scripts/build-cjk-font.sh`、`scripts/cjk-font-unicodes.py`、`src/assets/fonts/*`、`.gitattributes`、`package.json`（加 pdf-lib / fontkit）、`vite.config.ts`、`scripts/precompress.mjs`、`scripts/deploy.sh` 自检 | 字体 ≤ 2.5 MB gz；`npm i`；`cjkFont.spike.test.ts` 通过（**失败即按 A.2 退路，再开后续波**） |
| 1a | fable | `translateBatch.ts`、`useTranslations.ts`（+ 测试） | `translateAll` 单测全绿 |
| 1b | fable | `pdfLayout.ts`（buildPieces/pieceText/groupBlocksByPage）、`PdfZhOverlay.tsx`、`PdfViewer.tsx`（改用 groupBlocksByPage）、`export/textLayout.ts`、`export/exportTypes.ts`、`export/cjkFont.ts`（+ 测试） | 既有 `PdfZhOverlay.test.ts` / `pdfLayout.test.ts` 不变通过 |
| 1c | fable | `src/lib/paper/askCompose.ts`（+ 测试）、`paperUiStore.ts`（+ 测试）、`types.ts`（`CopilotMessage.quotes`）、`contextBuilder.ts` 引导语 | 单测全绿 |
| 2a | fable | `export/inPlacePlan.ts`、`export/exportPdfInPlace.ts`、`export/textDocPlan.ts`、`export/textDocTables.ts`、`export/exportTextDoc.ts`、`export/exportPaper.ts`（+ 测试） | 规划器单测；手工用 fixture PDF 跑一次三种版本生成 |
| 2b | opus | `CopilotPanel.tsx`、`CopilotQuote.tsx`、`ComposerAsks.tsx`、`PaperWorkbenchPage.tsx` 的 B.3 改动 | typecheck + 组件测试 |
| 3 | opus | `ExportDialog.tsx`、`PaperWorkbenchPage.tsx` 的 A.7 接线（与 2b 串行，同文件） | `npm run typecheck && npm test && npm run build` |
| 4 | QA 代理（opus，非 fable） | `.e2e-qa-fixtures/qa-export-pdf-e2e.mjs`、`qa-copilot-compose-e2e.mjs`、聊天桩扩展 | P0/P1 修到 0 或 3 轮 |

每波结束跑 `npm run typecheck && npm test`；波 3 后 `npm run build` 并核对 `dist/assets/` 出现 `vendor-pdflib-*.js` 与 `NotoSerifSC-sub-*.ttf(.gz)`，入口包体积不涨。

# D. 验证

**单元（vitest，`src/**/*.test.ts`）**：A.2 spike；`textLayout`（tokenize / 避头尾 / 超宽硬切 / `Tc` 对齐与上限 / fitTextInBox 收缩与 `…`）；`translateAll`（沿 `useTranslations.test.ts:30-175` 假网关：文档序补齐、已全译立即 done、熔断暂停报 `pausedUntil` 并假时钟续跑、中途 abort 在飞包仍落库且随后 `setWindow` 回窗口模式、拒绝授权 → halted/consent、auth → halted/auth 带 failed、dispose → aborted、重复调用同一 promise、此前失败块重试一次）；`pdfLayout`（`round:false` 保小数、`pieceText` 跨 seg、`groupBlocksByPage`）；`inPlacePlan`（覆盖：矩形 = 并集 + 内边并转 PDF 坐标、行数字号、居中/对齐、双 seg 拆文、非正文/标签/缺译不出 op；对照：页高 = Σ 行、无译条带高 = rect.h、列行高取 max、`pageX/pageY ≠ 0` 的 `tx/ty/clip`、译文框 x 范围、旋转页 → copy）；`textDocPlan`（分页规则、孤寡、表格跨页、页脚计数、中文模式缺译回退、`sanitizeFileStem/exportFileName`）；`textDocTables`（happy-dom）；`ExportDialog`（renderToStaticMarkup 各阶段文案）；B.7 的四个测试文件。

**E2E（Playwright chromium，`npx vite --config .e2e-qa-fixtures/vite.qa.config.mjs`，账号 `qa_img`，`qa-pdf-inline-lib.mjs` 的 login/launch/importFile/openPaper/clickLang/armConsent）**：
1. 导入 `.e2e-qa-fixtures/pdf-inline/arxiv-2609.36054v1.pdf` → 原版 → 中文 → 导出 PDF → confirm →「翻译并导出」→ `waitForEvent('download')` → node 里 `pdfjs-dist/legacy` 打开：页数 = 原文件、各页尺寸 = 原页、第 1 页 `getTextContent` 匹配 `/[一-鿿]{20,}/`。
2. 同论文对照 → 页数相等、至少一页比原页高、含中文。
3. DOCX fixture（`scripts/paper-eval/fixtures/*.docx`）文本视图对照 → 页尺寸 595×842、第 1 页同时含英文与中文。
4. 翻译中取消 → 无下载、对话框关闭、无 console error。
5. 文本视图下带 layout 的 PDF → 导出的是文本排版版（页尺寸 A4）。
6. B.7 的 ①–⑩。
7. 回归：`.e2e-qa-fixtures/qa-pdf-inline-e2e.mjs`、`highlight-e2e.mjs`、`voice-e2e.mjs` 仍通过；WebKit 跑一次导出下载路径（`scripts/webkit-pdf-repro.mjs` 同款启动）。

**生产复验（用户 Chrome，llm-pro.cn）**：生产论文 `77757973…` 原版 PDF 中文 / 对照各导出一次，Preview 与 Chrome 打开检查版式；首次导出观察字体下载进度与耗时；Copilot 选段「解释这段」立即出现在对话末尾、「加入提问」出现在输入框上方。

# E. 风险与已知限制

- 补译时长：调度器单飞，30 页 ≈ 1–3 分钟（对话框显示包数与已译数；并发 2 作为后续优化，涉及 `drain/inFlight` 与令牌桶）。
- 字体：体积预算与 fontkit 子集化正确性由波 0 门禁兜底；用户首次导出需下载一次（immutable 缓存）。
- pdf-lib 对损坏 xref / 所有者口令加密的 PDF 容错低于 pdf.js → 自动回退文本排版版并提示；原版两种版本在 `paper.byteSize > 40 MB`、原文件不在本机且拉不到、pdf-lib 页数与 pdf.js 不一致时**自动改走文本排版版**并在完成页给出原因（实施时由代码评审改进，取代原「直接拒绝」）。
- 覆盖版原文仍在白框下（可搜索、复制时会混入）；对照流版丢失原页链接注释；旋转页原样保留不叠译文；高亮不导出。
- 文本排版版：代码用比例字形、表格忽略 colspan、公式为纯文本——V1 口径。
- `Tc` 对齐在拉丁为主的行超过上限时退回左对齐。
- Copilot：手机收起 sheet 会中断在飞轮次、队列在重开时续发；旧客户端对新快捷动作消息只显示小签（content 为空）；多引用用 `---` 分隔是模型没见过的新形态（引导语已调整）。

---

# F. 交付记录（2026-10-09）

**实施**：按 §C 四路并行（字体管线 sonnet / translateAll fable / 导出内核 fable / Copilot fable）+ 波 3 对话框接线（opus）。随后 `/code-review high` 出 11 条发现，采纳 9 条分两路修复（opus）：Copilot 的 `queuePaused` 只冻结当时已排队的条目、被拒（敏感 / 未授权 / 会话未就绪）的提问与引用回灌 store、`deepAlternative` 不再截断问题；导出的 `data:`/`blob:` 图直接取、原文件缺失 / 超 40 MB / 页数不一致一律回退文本排版版、未译计数按版本口径、控制符正则改转义构造。未采纳：median 去重（P2 重构）、deploy 自检改通用断言（现有逐名检查足够）。

**波 0 发现的真坑**：pyftsubset 产物的 glyf 记录奇数长度，fontkit 子集化写短格式 loca 会错位——pdf.js 文本回读照样正确、但 poppler / macOS 渲染缺字。`scripts/build-cjk-font.sh` 已加 `glyf.padding = 4` 重存，`cjkFont.spike.test.ts` 逐字形比对嵌入轮廓。字体最终 Noto Serif SC、7455 字形、3.03 MB 原始 / 1.74 MB gz。

**门禁**：`npm run typecheck` ✓；`npm test` 129 文件 / 2381 用例 ✓（新增约 150 条：textLayout、inPlacePlan、textDocPlan、textDocTables、exportPaper、exportPdfInPlace、exportTextDoc、cjkFont(+spike)、translateAll、askCompose、store、CopilotQuote、ComposerAsks、ExportDialog、真 fixture 集成测试）；`npm run build` ✓（入口包体积不变；`vendor-pdflib` 509 KB gz 与字体均懒加载）。

**QA**（`.e2e-qa-fixtures/QA-REPORT-export-copilot-r1.md` / `-r3.md`，样例 PDF/PNG 在 `.e2e-qa-fixtures/export-copilot/out/`）：r1 发现 1 条 P1（文本排版版代码块丢行首缩进，已修 `textLayout.ts`）；r3 全量复验 Copilot ①–⑩ + 新语义 6 条、导出 A1–A9 + 回退三条 + 图片五类 + 回归脚本，P0/P1 = 0。遗留 P2：DOCX 导入即剥掉 `<img>`（图不进阅读器也不进导出，属导入范围）；拉取原文件期间对话框只显示「准备文档…」；限流器排队 Copilot 快捷请求无提示；覆盖版会盖住被解析成段落的作者行；对照流版把竖排水印切碎；子集外字形显示 □；手机全屏 sheet 麦克风球遮「清空重开」（既有）。

**部署 / 生产复验**：见下方追加记录。

### 部署与生产复验（2026-10-09）

- 提交 22649d4 推送，PR #16（base `feat/pdf-inline-translation`，叠在 #15 上；#15 合入删分支后 GitHub 自动改 base 为 main）。
- `scripts/deploy.sh --web` 三次部署 llm-pro.cn（备份 `.bak-20261009-074407` / `-075658` / `-080134`）；入口包 `index-4Tucfngo.js`；字体 1.82 MB gz、`vendor-pdflib` 509 KB gz 均 `gzip_static` + 30 天 immutable 直出。
- 生产论文 `77757973…`（原版 PDF，218 段）在用户 Chrome 复验：
  - Copilot：「加入提问」→ 输入框上方引用 chip（带「译文」徽章）、textarea 聚焦、toast「已引用到 Copilot 输入框」；「解释这段」→ 立即在对话末尾出现引用块 + 回答流式到底，无排队、无顶部卡片。
  - 导出：对照 → 确认框「剩余 106 段 · 预计 $0.01 · 约 6 包」→ 补译 ≈ 60 s → 生成下载 `….中英对照.pdf`（15 页、同宽变高、node pdf.js 回读含中英文）；中文 → 译文已缓存直接生成 `….中文.pdf`（15 页）。
- **复验暴露的两个真缺陷（已修、已部署）**：MCP 控制的标签页 `visibilityState === 'hidden'`，Chrome 节流链式定时器并停掉 rAF——① pdf-lib 默认 `ParseSpeeds.Slow`（每 100 对象 setTimeout）与 `save` 每 50 对象让位，1271 对象的论文在后台页拖成 60 s（node 实测本体 load 12 ms / save 9 ms）→ 改 `parseSpeed: Fastest` + `objectsPerTick: MAX_SAFE_INTEGER`；② 覆盖版取底色的离屏 `page.render` 走 display 意图靠 rAF 续跑，后台页永远完不成（卡在「准备文档…」）→ 改 `intent: 'print'`。修后同一后台标签页：中文 20 s（含逐页「处理第 i/15 页」）、对照 8 s。用户切走标签页等导出的场景因此也不再卡死。
- 提示：浏览器对非用户手势触发的第二次自动下载可能弹「允许多个文件下载」权限；完成页的「再次下载」按钮是直接点击，可用来补救。
