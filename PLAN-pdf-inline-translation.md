# PLAN：论文陪读「原版 PDF」就地译文 — 中文覆盖 + 段落对照流 + PDF 解析修复

> 状态：2026-10-07 用户批准，实施中（交付终点：部署 llm-pro.cn 并生产复验；部署记录见文末）。
> 分支：PR #14（`fix/snapshot-scroll-anchoring`）已于 2026-10-06 合入 main。`git fetch` 后从 `origin/main` 拉 `feat/pdf-inline-translation`。`.e2e-qa-fixtures/` 与 `HANDOFF-*.md` 是未跟踪文件，原样带过去，绝不 stage。

## Context

网页原貌视图的「对照」把译文直接挂在每个原文块下面，用户很满意。PDF 则不行：选「中文 / 对照」会被强制切到文本视图（`PaperWorkbenchPage.tsx:573-584` 的 `changeLang`），整篇变成纯文本流，版面、图表、公式全丢；而且文本视图的分段本身有错——用户贴的例子（生产论文 `77757973…`，arXiv `2609.36054v1`「What if automating AI R&D triggers an intelligence explosion?」第 5 页）里页眉「… page 4 of 14」和左右栏逐行交错拼成一段。

用户的目标：像「生成了一份合并了译文的新 PDF」那样，在原版 PDF 里看到中文，不破坏版式。已确认的方案（AskUserQuestion）：

- **中文** = 译文原位覆盖原段落框（版面不动），点段落可临时看回原文。
- **对照** = 段落对照流：每段原文按原样裁成画布图条，译文紧跟其下；双栏仍左右并排，页面只是变高。文字层仍可选中。
- **顺带修 PDF 解析**：分栏检测忽略通栏行；去重复页眉页脚与「page N of M」；按字号变化断段；并记录每块的版面几何。`PARSER_VERSION` 2→3，已导入 PDF 点一次「重新解析」（译文与高亮按文本重打键保留）。

两种模式都依赖同一份新数据：每个块在每页上的行框（PDF 用户空间）与栏位标签。原文模式（`原文` tab）逐像素不变。

## 现状事实（已核对代码、pdf.js 6.2 源码与生产页面）

- 原版 PDF 视图 = `PdfViewer.tsx`：每页一个固定宽高容器（`:159-172`），内含 pdf.js canvas + 透明文字层（`lib.TextLayer`，`:113-118`）；只渲染可见页 ±2（`isPageActive`），离窗即 `canvas.width = 0`。当前页由 `pickCurrentPage` 按滚动几何判定，只上报页码。
- 翻译窗口按 `position.blockIndex` 走；原版视图下 `handleVisiblePage` 只能映射到「该页第一块」（`:665-673`），窗口粒度是整页。
- 解析：`parsePdf.ts` 逐页 `getTextContent()` → `normalizePdf.ts` 聚行 / 分栏 / 标题 / 合段。**块只保留起始页与章节名**（`normalizePdf.ts:400-409`），行框、字号、栏位全部丢弃。
- 生产第 5 页实测：有一个通栏框（多行横跨版心 0.09–0.94）。`detectGutter` 对跨槽行只容忍 `floor(rows×0.15)` 条（`:191`），被通栏行打败 → 整页按单栏 → 同一 y 的左右栏项被 `joinLineItems` 拼成一行，这就是逐行交错。页眉只有纯数字页码规则（`PAGE_NUMBER_ONLY`）能删，「… page 4 of 14」原样并入段落。
- pdf.js 事实（决定查看器方案）：TextLayer 的 span 用**页面百分比**定位（`viewport.rawDims`，与 offsetX/offsetY 无关）→ 子矩形文字层不能靠 offset viewport，但可以「整页尺寸的文字层容器 + 负偏移 + 父元素 `overflow:clip`」零成本裁切；`textContentSource` 接受普通 `TextContent` 对象 → 一次 `getTextContent()` 后按条带过滤 items 分别建层；`page.render` 没有子矩形参数 → 对照流必须**一次离屏整页渲染再 `drawImage` 裁切**。
- 块同步：blocks 行是服务端 `sync_records` 的通用 JSON payload（`sync.ts:37` `payload: z.unknown()`），新增字段无需改服务端；`push-artifacts` 待推期间远端旧块不落地（`syncEngine.ts:556`）。
- 重解析：`reingestPaper`（`ingest.ts:390`）从 files 表取字节重跑解析并 `saveBlocks`，**不删** translations / highlights；但 `parserVersion` 只有 `createPaper`/`replaceFile` 写，`markReady` 不写。译文行 id 含 blockIndex（`useTranslations.ts:168`），高亮按文本切片校验（`highlightModel.ts:54-58`）。

---

## 1. 数据模型：块级版面几何

### 1.1 `src/lib/paper/types.ts`（加法字段，Dexie 非索引，零迁移；随 blocks 行 JSON 同步）

```ts
export type PdfColumn = 'full' | 'left' | 'right' | 'span'
/** [x0, yTop, x1, height]，PDF 用户空间（未做 rotate，y 向上），1 位小数。
 *  yTop = 基线 + ascent×字号（ascent 取 pdf.js styles[fontName].ascent，缺省 0.8，与 TextLayer 回退值一致）；盒子覆盖 [yTop−height, yTop]。 */
export type PdfLineBox = [x0: number, yTop: number, x1: number, height: number]
/** 块落在同一页同一栏的连续行（阅读序，自上而下）；跨栏 / 跨页的块有多个 seg */
export interface PdfLayoutSeg { page: number; col: PdfColumn; lines: PdfLineBox[] }
export interface PdfBlockLayout { segs: PdfLayoutSeg[] }
export interface PaperBlock { /* 既有字段 */ layout?: PdfBlockLayout }   // v3 起 PDF 解析器产出；缺失 = 旧版解析
```

查看器换算用 `viewport.rawDims`（cropbox 原点非零的 PDF 才正确，TextLayer 自己也这么做）：`cssX = (x − pageX)×scale`，`cssY = (pageY + pageHeight − yTop)×scale`。

`normalizePdf.ts:22` 的本地 `Column` 改为引用 `PdfColumn`。`PdfTextItem` 加 `ascent?: number`：`parsePdf.ts` 的 `toTextItem(raw, content.styles)` 镜像 pdf.js `TextLayer.#getAscent`（`ascent || (descent ? 1 + descent : undefined)`，钳位 [0.5, 1.2]）。

**不存每页信息**：页尺寸查看器本就从 `page.getViewport({scale:1})` 拿；栏范围 / 分栏位置由该页 `left/right` 行盒的 x 并集推出，与解析器实际归栏一致，不会有两份真相。体积：300 块论文约 +60 KB；同步批上限 6 MB / 服务端 8 MB 无压力。实施时核对 `server/src/config.ts` 的每用户存储配额。

### 1.2 `src/lib/paper/repo/db.ts` / `paperRepo.ts` / `translationRepo.ts` / `syncedRepos.ts`

- `PARSER_VERSION = 3`，注释说明 v3 语义：PDF 块携带 layout；解析规则修正；存量论文不自动重解析，工作台原版视图切中文/对照时提示「重新解析」。
- **`markReady` 补写 `parserVersion: PARSER_VERSION`**（否则重解析后记录仍是 v2）。
- `TranslationRepository` 新增 `deleteTranslations(ids)`；synced 包装照 `deleteHighlights`（`syncedRepos.ts:296-302`）逐行入队墓碑——重打键删旧 id 时另一台设备才不会把旧行拉回来。

---

## 2. 解析器修复（`src/lib/paper/normalizePdf.ts`，纯函数，全部进 vitest）

内部 `Line` 增 `yTop / yBottom`（`max(y + ascent·h)` / `min(y + (ascent−1)·h)`），`height` 改为**主导字号**（按 str 长度加权的 height 中位数，原为 max；带上标 [12] 的行不再误判字号；顺带让 `detectHeading` 的「大字号」规则不被单个大字符触发）。`Draft` 增 `lines: Line[]` 与 `edge`（当前栏段确立的左边界）。预处理 `prepareRows(page)`：过滤空白项 + **丢弃旋转项**（`|transform[1]| > |transform[0]|`，arXiv 左缘竖排水印会伪装成一条横跨版心的假行）。

### 2.1 分栏槽检测（缺陷 1：左右栏逐行交错）

`detectGutter` 内部改为**只用「窄行」建直方图**：行内按 x 排序、项间距 ≤ max(2, h×1.0) 合并成 run；任一 run 跨度 > 70% 版心宽 = 通栏行（`WIDE_RUN_RATIO = 0.7`），排除出直方图。要求窄行 ≥ 6 条且 ≥ 50% 的行是窄行（单栏页几乎每行都是通栏 run → 直接否决）；跨槽容差改为 `max(1, floor(narrow×0.1))`。其余（0.35–0.65 搜索带、3% 最小槽宽、两侧各 ≥ 20% 项）不变。

按 run 而不是行跨度：二栏页的「行」是 y 聚类，天然含左右两栏的项；按 run 后二栏行 = 两个 ≈0.47 宽的 run（窄），通栏框行 = 一个 ≈0.85 宽的 run（宽）。既有「单栏页不受双栏逻辑影响」「通栏标题」用例按此定义仍通过。

**文档级回退**：`normalizePdf` 先对每页 `detectGutter`，≥ 2 页检出时取中位数做 `consensusGutter`；检不出的页若通过 `acceptDocGutter(rows, doc)`（行数 ≥ 2、跨槽行 ≤ 50%、两侧各 ≥ 20% 项）就沿用文档槽——解决「只剩 3 行二栏正文 + 一条通栏图注」的页。

### 2.2 页眉页脚（缺陷 2，新函数 `dropRunningLines(perPage, bodyHeight)`）

候选 = 每页文本纵向跨度上下 8% 带内、自上/自下排名 ≤ 3 的行，且 `height ≤ bodyHeight×1.05`（大字标题豁免，首页标题不会被当页眉）。删除条件：匹配 `/^page\s+\d+\s+of\s+\d+$/i`、`/\bpage\s+\d+\s+of\s+\d+$/i`、`/^\d+\s*\/\s*\d+$/`、`/^第\s*\d+\s*页(\s*共\s*\d+\s*页)?$/` 之一，**或** 其 key（小写、数字→`#`、空白折叠）在 ≥ `max(2, min(3, ceil(0.4×pageCount)))` 页的候选里重复。既有 `PAGE_NUMBER_ONLY` 保留。生产论文的「… page 4 of 14」由模式分支直接命中。

### 2.3 字号与缩进断段（缺陷 3/4：脚注、图注并进正文）

- `heightDiffers(a, b) = |a−b| > max(a,b)×0.08`（LaTeX 10pt 正文的 `\small` 图注 9pt 差 10%、`\footnotesize` 脚注 8pt 差 20%；同字体同字号在 pdf.js 里稳定到 0.01，8% 不会被噪声触发）。
- **跨页/换栏**：`breakHere = ENDS_SENTENCE || heightDiffers(上段末行, 本行)`——栏底 8pt 脚注不再吞下一栏首行。
- **同栏**：原两条规则 `|| heightDiffers(prev, line) || indentBreak`。`indentBreak`：段落左边界由**第 2 行**确立（首行缩进不作数），之后 `|line.x0 − edge.x0| > max(3, bodyHeight×0.5)` 即断；换页/换栏重置 edge。悬挂缩进列表也能切开。

### 2.4 layout 产出

Draft 的 `lines` 按连续同 (page, col) 归 seg，每行 `[r1(x0), r1(yTop), r1(x1), r1(yTop − yBottom)]`；heading 块同样带 layout。输出处（`:400-409`）加 `block.layout = toLayout(d.lines)`。

### 2.5 测试（`normalizePdf.test.ts`；既有 23 个用例断言不改）

fixture 增 `item(..., extra?)`、`twoColumnPage()`、`wideItem()`。新增用例：通栏框页（20 行二栏 + 6 条宽行 + 页眉「Title … page 4 of 14」→ 左右不互穿、框行自成块、页眉消失）；文档级回退（第 2 页仅 3 行二栏 + 1 条图注）；4 页重复页眉/页脚；首页大字标题与页眉同文（标题保留）；2 页顶行各异全保留；单页「page 3 of 12」；脚注 8pt 独立成块且右栏首行不并入脚注；图注 9pt vs 正文 10pt 分开；缩进 A(72,72,72)/B(82,72) 两块；悬挂缩进列表两条；主导字号（10pt + 7pt 上标）不断段；旋转项不出现；layout 单栏 3 行（`yTop = y + 0.8h`、1 位小数）、ascent=0.9、跨栏两 seg、跨页两 seg。

---

## 3. 共享几何模块 `src/lib/paper/pdfLayout.ts`（新建，纯函数、无 DOM、无 pdf.js；解析器与查看器的唯一契约）

```ts
export interface PageGeom { pageX; pageY; pageWidth; pageHeight }        // = viewport.rawDims
export interface Rect { x; y; w; h }                                      // 页面 CSS 空间（scale=1，左上原点，y 向下）
export interface PortionRect { blockIndex; segIndex; segCount; col: PdfColumn; rect: Rect; lines: Rect[]; prose: boolean }

hasPdfLayout(blocks) / needsLayoutReparse(paper, blocks)   // 后者 = pdf && ready && blocks.length>0 && !hasPdfLayout
segmentsOnPage(blocks, page, geom): PortionRect[]           // 阅读序；rect = 行框并集；prose = isProseLayout
columnExtents(rects): { left:[x0,x1]; right:[x0,x1]; split } | null   // 各栏行盒 x 并集；单侧缺失 → null（整页按 full）
isProseLayout(lines, kind, colWidth, text): boolean
scaleRect(r, scale): Rect                                   // 边界先乘后 round，相邻条带共享边界 → 无缝
pickCurrentBlock(edges, bandTop, bandBottom) / visibleBlockRange(edges, top, bottom)
partitionPageFlow(geom, rects): FlowRow[]                   // 对照流分区（§5.3）
assignPointsToStrips(points, strips): Int32Array           // 文本项基线点 → 条带归属（边界点归上方）
planFontFit(boxH, scrollH, f, fMin): number | null          // 覆盖字号拟合的纯数学部分
splitTranslation(text, weights): string[]                   // 跨栏/跨页块的译文按行数比例、就近标点切分
```

`isProseLayout`：`kind ∈ {table, code, formula, image}` → false；空 → false；单行 → true；多行需同时满足：左对齐（去首行后 ≥ 80% 行的 x0 与众数差 < 3% 栏宽）、行距规整（相邻行距 max/median ≤ 1.6）、行高规整（max/min ≤ 1.5）、填充（中位行宽 ≥ 45% 栏宽）、文本中数字/符号占比 ≤ 0.35 且含字母或 CJK。公式行、表格行、作者块都留原文。

测试 `pdfLayout.test.ts`：见 §8.1。

---

## 4. 重解析路径（存量 PDF 一次性升级，译文与高亮保留）

判定以 **blocks 是否带 layout** 为准（`needsLayoutReparse`），不看 `parserVersion`：另一台设备拉到 v3 blocks 时本机 papers 行可能仍是 v2。

- **`src/lib/paper/ingestDeps.ts`（新）**：把 `PapersPage.tsx:74-85` 的 `parseByFormat` 搬来并导出 `createIngestDeps({ onState })`（repo / sha256Hex / parse / `rekeyDerivatives` / onState）。`PapersPage` 的 `depsFor` 与 URL 导入改从这里取。
- **`src/lib/paper/ingestQueue.ts`（新）**：`export const ingestQueue = createSerialQueue()` 模块单例，替换 `PapersPage.tsx:151` 的 `useRef(createSerialQueue())`——列表页导入进行中跳到工作台再点重解析也只排队，不会两个 pdf.js worker 并行。
- **`ingest.ts`**：`IngestDeps` 加可选 `rekeyDerivatives({ paperId, oldBlocks, newBlocks })`；`reingestPaper` 在 `saveBlocks` 前取旧块、之后 `buildPaperIndex` 前调用它（抛错只 warn，不翻转结果）。`ingestPrepared` 不动。
- **`src/lib/paper/rekeyDerivatives.ts`（新，纯函数 + 一个 IO 入口）**：
  - `mapBlockIndices(old, new, lookahead=64)`：按 `text.trim()` 精确相等的单调贪心（两指针 + 前瞻窗口）得到 旧序号 → 新序号。
  - `planRekey(paperId, map, translations, highlights)`：只对命中且序号变化的行产出改写；译文新行 `id = ${paperId}:${new}:zh`、`blockIndex/blockId` 改写，`delete = movedOldIds − putIds`（防 5→6、6→7 碰撞），**先 delete 再 put**；高亮 id 不变只改 `blockIndex/blockId`。未命中的行不动（`srcHash` / 文本切片校验让它们自然失效）。
  - 效果：文本未变的段落即使序号漂移，译文与高亮都保留；吞过页眉/脚注的段文本变了 → 懒重译。
- **工作台横幅与 `runReparse`**（见 §6）。
- 同步：`markReady` 整行重置 syncMeta → 推 v3 papers 行 + 带 layout 的 blocks + 文件（同 sha 短路）；旧尾块按旧 `blockCount` 墓碑（`syncedRepos.ts:73-79`）；其它设备拉到 v3 blocks 后不必各自重解析。
- 测试：`rekeyDerivatives.test.ts`（映射四种情形、`planRekey` 碰撞/高亮/未命中、fake-indexeddb 跑真实 repo 验证 delete 先于 put）；`ingest.test.ts` 加 reingest 调用 rekey 与 rekey 抛错仍 ready；`paperRepo.test.ts` 加 markReady 写 parserVersion；`translationRepo.test.ts` / `syncedRepos.test.ts` 加 `deleteTranslations`。

---

## 5. 原版视图：中文覆盖与段落对照流

### 5.1 `PdfViewer` 新 props 与命令式 API（全部可选；不传 = 今天的原文视图，逐像素不变）

```ts
export interface PdfViewerApi { scrollToBlock(index, opts?: { flash?; behavior? }): boolean }   // 无几何/越界 → false，调用方回退页级
interface Props {
  bytes; containerRef; onVisiblePage; onLoaded?                                   // 既有
  blocks?; langMode?; translations?; failedTranslations?; translationAuthIssue?; onRetryTranslation?; highlights?
  onVisibleBlock?: (blockIndex, page) => void; onVisibleRange?; onReady?: (api) => void
  compensateScroll?: boolean   // WebKit 无原生 overflow-anchor 时由 viewer 补偿对照流的高度变化
}
```

模式判定（viewer 内）：`hasLayout = hasPdfLayout(blocks)`；`inPlace = hasLayout && langMode !== 'orig'`；`flow = inPlace && langMode === 'both'`。`inPlace=false` 时渲染树与今天完全一致（源码级护栏测试：`PdfPage` 渲染 effect 的依赖数组不含译文相关项）。页尺寸 `pageSizes: Map<page, PageGeom & {width,height}>` 仅在 `inPlace` 时按 10 页一批 `getViewport({scale:1})` 取；每页译文切片用签名缓存，签名不变复用同一对象让 `memo(PdfPage)` 继续生效。

### 5.2 中文覆盖 `src/components/papers/PdfZhOverlay.tsx`（新）

`PdfPage` 在 `rendered` 后、文字层之后追加 `<div class="paper-zhlayer">`（`z-index:2`，`pointer-events:none`），每个 portion 一个元素：

- **覆盖框** = 行框并集 `scaleRect` 后上方外扩 0.1·lineH、下方 0.15·lineH、左右 1px（用并集而非逐行框：译文换行与原行不对应）。
- **背景取样**：渲染后从同一 canvas `getImageData(1×1)`：多行块取首行底与次行顶之间的行间隙点（在块自身背景里，callout 色块也正确）；单行块取 `(x0−3, midY)`；过深（亮度 < 0.5，打到图形）→ 回退 `#fff`。一页一次，`useMemo` 按 `rendered/scale`。
- **字号拟合**（页级 `useLayoutEffect`，依赖本页译文签名 / scale / toggle 集合）：`lineH = median(h)×scale`，`pitch` = 相邻行距（单行取 1.25·lineH），`f0 = 0.92·lineH`，`lineHeight = pitch`，`fMin = max(0.6·f0, 6px)`。「全写→全读」避免抖动：所有块先写 f0、读 `scrollHeight`，溢出者 `f' = f×clamp(√(boxH/scrollH)×0.98, 0.5, 0.97)`，最多 3 轮；仍溢出 → `data-overflow="1"`（底部 8px 渐隐 + 「…」）。中文译文通常只需英文 60–70% 的面积，绝大多数块一轮合格。首行缩进按原段落首行与其余行 x0 差还原；栏内居中的单/双行用 `text-align:center`，其余 `justify`。每块 `contain: layout style`。
- **跨栏/跨页块**：`splitTranslation(text, 各 seg 行数)` 把译文拆到各 portion（±15% 窗口内就近标点）；拆分块的元素**不带** `data-hl-host`（宿主 textContent 必须等于整段译文，`selectionOffsets.ts` 的偏移口径才成立）。
- **三态**：已译且 prose → `<div class="paper-zh-block" data-block-index data-translated="zh" data-hl-host="zh"(单 portion)>`；未译且可译 → `.paper-zh-skel`（脉冲虚线描边、不覆盖、`pointer-events:none`）；failed → 不覆盖，右下角 `<TranslationError compact>`（文案与 BlockReader 同源）；非 prose / 不可译（`isTranslatableBlock`）→ 不出元素。
- **点段落看原文**：`onClick`（选区非塌陷则忽略）toggle 进 `Set<number>`；原文态 `data-state="orig"`：背景透明、译文 `visibility:hidden`、`pointer-events:none`（点击/选区落到下方文字层），右上角保留「中」chip 切回。页离开渲染窗口即卸载，状态自然重置（「临时」语义）。
- `pendingFlash`：跳转目标页未渲染时把序号放 ref，overlay 挂载后 `flashElement`。

### 5.3 段落对照流 `src/components/papers/PdfFlowPage.tsx`（新）

页容器 `<div id=paper-page-N data-page=N class="paper-flow-page" style={{width, --total-scale-factor, --scale-round-x/y}}>`（**无 height**）。**DOM 对所有页常驻，只有位图与文字层按 ±2 页窗口化**：条带尺寸是纯几何，译文 div 像 BlockReader 一样全量在 DOM 里；页高只在「译文到达 / scale 变化 / 页尺寸首次得知」时变化，WebKit 下不会因为页进出渲染窗口而跳动。尺寸未知的页用 base 尺寸固定占位。

**分区 `partitionPageFlow(geom, rects) → FlowRow[]`**（纯函数，三条可测不变量：铺满、无重叠、阅读序）：

```ts
type Strip = { key; rect: Rect; blockIndex?; showTranslation: boolean }
type FlowRow = { kind:'full'; strip } | { kind:'columns'; top; bottom; split; left: Strip[]; right: Strip[] }
```

- 边界 `cut(prev, next) = prev.bottom + clamp(gap/2, 0, 0.6·prevLineH)`：普通段间距 → 中点；大空隙（插图）→ 紧贴前块底，**空隙归下一块的条带**。
- 无 left/right → 单栏：每 portion 一个 `full` 行，首行从 0、末行到页底。
- 双栏：`span/full` portion 为「带」（上下边界用 `cut` 对最近内容求得），带之间含列 portion → `columns` 行；页眉（最上方列内容顶 − cut > 2·lineH）/ 页脚（两列最下块底 + cut 之后剩余 > 2·lineH）独立成无块 `full` 行，页码不会被两列不同高度的译文撕成两半；列内首条带从行顶起、相邻用 `cut`、末条带延伸到行底或加无块 trailing 条带；某侧无 portion → 整侧一个 trailing 条带。
- `showTranslation = 有 blockIndex ∧ 是该块最后一个 seg ∧ isTranslatableBlock ∧ 文本非空`。
- `scaleRect` 对边界取整，相邻条带共享边界 → 无 1px 缝。

**条带渲染**（effect，沿 `PdfViewer.tsx:73-156` 的取消/释放/错误分诊纪律）：离屏整页 canvas `page.render`（不入 DOM）→ 每条带 `drawImage` 裁切到自己的 canvas（`alpha:false`）→ 离屏 canvas 立即归零（峰值 2× 页位图，稳态 1×）→ `getTextContent()` 一次，`convertToViewportPoint` 得各项基线点，`assignPointsToStrips` 归属 → 每条带 `new lib.TextLayer({ textContentSource: { items: 该条带项, styles, lang }, container, viewport })`。条带 DOM：`<div class="paper-flow-strip" data-block-index?><canvas/><div class="paper-textlayer paper-flow-text" style="left:-X;top:-Y"/></div>`（文字层容器整页尺寸、父元素 `overflow:clip`）。清理：cancel、每层 `cancel()`、`replaceChildren()`、条带 canvas 归零但**不动 style 尺寸**（布局不塌）。DOM 序 = 阅读序，跨条带选区 `toString()` 正确。

**译文元素**（`showTranslation` 的条带之后）：已译 `<div data-block-index data-translated="zh" data-hl-host="zh" class="paper-flow-zh">`（左 accent 边线、浅底，同 `BlockReader.tsx:372-378` 语义）；failed `.paper-flow-fail` 含 `TranslationError`；未译 `.paper-flow-skel`。译文 div 也带 `data-block-index`，当前块判定把译文区域算进块内。

### 5.4 当前块 / 可见区间 / 跳转

- 扩展 `PdfViewer.tsx:374-392` 的 rAF `measure`：同一帧算 `pickCurrentPage` + 观察带 `[viewportTop + CURRENT_PAGE_EPSILON, viewportTop + clientHeight×CURRENT_BLOCK_BAND_RATIO(0.25)]`（与 BlockReader `-8px … -75%` 同口径）。zh/orig 模式块边来自按 (page, scale) 缓存的 `segmentsOnPage`；对照流量候选页（≤ 2 页）内 `[data-block-index]` 的 DOM 矩形。`pickCurrentBlock` = 与带相交者中序号最小，变化才 `onVisibleBlock(i, page)`；`onVisibleRange` 对整个视口做同样聚合（语音用，工作台只写 ref）。
- `scrollToBlock(index, {flash, behavior})`：zh/orig 用页节点 top + `scaleRect(rect).y` 直接算（页未渲染也能对齐）；对照流有元素则量 DOM，否则先滚到页并记 `pendingAlign`，`PdfFlowPage.onLaidOut(page)` 时补一次；`behavior:'auto'` 时两帧后再量一次，偏差 > 2px 修正。都用 `readerScrollTop`（`anchors.ts:174-182`）。
- 锚定：覆盖模式页高恒定，无问题。对照流在 Chromium/Firefox 由原生 `overflow-anchor` 兜住（PDF 在主文档里，不像快照 iframe）；WebKit（`compensateScroll`）：rAF 测量时记录锚元素（当前页内第一个底边 > 探测线的 `[data-block-index]`/条带）及其相对窗格顶的偏移，`useLayoutEffect([translations, failed, pageSizes, scale])` 提交后、绘制前按位移补 `scrollTop`；护栏：最近 150ms 有 scroll 事件（惯性中）或锚元素已断开则跳过。scale 变化时改用「scrollTop/scrollHeight 比例保持」。

### 5.5 其它文件

- **`src/components/papers/translationBits.tsx`（新）**：把 `BlockReader.tsx` 的 `HlText`、`TranslationSkeleton`、`TranslationError` 原样搬出并 export（`TranslationError` 加 `compact?`）；BlockReader 改 import，无行为变化。
- **`ReaderContext.tsx`**：`ReaderStyles()` 追加 `.paper-zhlayer / .paper-zh-block[data-state|data-overflow] / .paper-zh-chip / .paper-zh-skel / .paper-zh-fail / .paper-flow-page / .paper-flow-row / .paper-flow-col / .paper-flow-strip / .paper-flow-text / .paper-flow-zh / .paper-flow-skel / .paper-flow-fail`，颜色用 `--color-accent` 等主题变量；`:root { --paper-zh-font: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "Songti TC", serif }`。
- **`anchors.ts`**：新增 `CURRENT_BLOCK_BAND_RATIO = 0.25`；把 `PaperWorkbenchPage.tsx:66-67` 的 `HAS_NATIVE_SCROLL_ANCHORING` 搬来 export（工作台与 viewer 共用）。`resolveAnchor` 不改（块精度沿用快照做法：以 `'text'` 解析再报 `mode:'original'`）。
- **`selectionOffsets.ts`**：`findBlockElement` 只取第一个 `[data-block-index=i]`，对照流里同一块有条带 + 译文 div 两个元素 → 改为遍历同序号元素找 `[data-hl-host=lang]` 宿主；加一条「同块多元素」用例。
- **手机**（390px，scale≈0.4）：覆盖字号随 scale 缩（与原文同样靠浏览器缩放）；对照流保留两列并排（条带 ~170px，译文 0.82rem），与原 PDF 等宽等缩放。窄屏纵向堆叠 + 2× 栏缩放是后续可选项，本期不做。

---

## 6. 工作台接线 `src/pages/papers/PaperWorkbenchPage.tsx`

| 位置 | 改动 |
|---|---|
| 判定 | `hasLayout = useMemo(() => hasPdfLayout(blocks))`；`pdfInPlace = format==='pdf' && !isSnapshot && hasLayout`（+ ref）；`legacyPdf = format==='pdf' && !isSnapshot && needsLayoutReparse(paper, blocks)` |
| `changeLang` `:573-584` | **删掉强制切文本视图**。有几何 → 原版视图就地渲染；无几何（旧解析）→ 仍停在原版视图显示原文 + 横幅（下一行）。两个 Plan 子代理对此有分歧，取「不强切」：用户看着原文做选择，比被动切走更清楚 |
| 横幅 | 原版 PDF 分支在 `<PdfViewer>` 上方，条件 `langMode !== 'orig' && legacyPdf`：「旧版解析，重新解析后可在原版 PDF 显示译文」+「重新解析」（busy 时显示阶段并禁用；队列里不是本任务时「排队中」）+「先用文本视图看译文」→ `changeMode('text')` + 错误重试。样式照 `:1262-1276` 的成本提示条 |
| `runReparse` | `ingestQueue.enqueue(..., () => reingestPaper(paperId, createIngestDeps({ onState })))` → 完成后重读 paper/blocks、`position.blockIndex` 按 `firstBlockOfPage[page]` 重设、`maxBlockIndex` 钳位、`retrieval.invalidate`、派发 `paper-sync-pulled`（detail `{paperIds:[id], tables:['translations','highlights']}`，复用两个 hook 已监听的契约）让它们重读重打键后的行、toast「已重新解析，原版 PDF 可显示译文」。期间 `paper.status` 内存里保持 ready、`bytes` 不变 → `PdfViewer` 不卸载 |
| `handlePdfReady(api)` | 存 `pdfApiRef`，`alignOnce(`${paperId}:original`)`（替代 `handlePdfLoaded` 的对齐时机） |
| `scrollToAnchor` / `alignToPosition` | `mode==='original' && pdfInPlace` 分支：`target = {...resolveAnchor(anchor, ctx, 'text'), mode:'original'}`，`pdfApiRef.current?.scrollToBlock(idx, {...})` 为 false 时回退 `pageDomId(page)` |
| `useTranslations` `:600` | `aheadFirst: (mode==='original' && (isSnapshot \|\| pdfInPlace)) \|\| HAS_NATIVE_SCROLL_ANCHORING` |
| `handleVisiblePage` | `pdfInPlace` 时只更新 `page`，不把 `blockIndex` 冲成页首块；新增 `handlePdfVisibleBlock(blockIndex, page)` 写 position + maxBlockIndex |
| `<PdfViewer>` `:1221-1226` | 传入 blocks / langMode / translations / failed / authIssue / `retryBlock` / `highlightsByBlock` / `handlePdfVisibleBlock` / `handleVisibleRange` / `handlePdfReady` / `compensateScroll={!HAS_NATIVE_SCROLL_ANCHORING}` |
| `onHighlight` `:1350` | `mode==='text' \|\| isSnapshot \|\| (pdfInPlace && langMode!=='orig')`：译文可高亮；原文文字层选区无宿主 → 现有「暂不支持高亮」提示 |
| 成本提示 `:1262-1276` | 抽成小组件，两个分支都渲染；**绝对定位叠在阅读区顶部**（main 里内容上方不能有会变高变矮的流内元素，否则 WebKit 对齐后整体位移，沿 `WebSnapshotView.tsx:916-926` 的理由） |
| 语音 `handleVoiceTranscript` | 有几何时用 viewer 喂的 `visibleRangeRef`，否则沿页级回退；切模式时清空 ref |

---

## 7. 实施分波（按文件冲突面划清归属）

**Wave 1 · 根基（fable）**：`types.ts`、`normalizePdf.ts` + 测试、`parsePdf.ts`、`pdfLayout.ts` + 测试、`db.ts`、`paperRepo.ts`、`translationRepo.ts`、`syncedRepos.ts`、`ingest.ts`、`ingestDeps.ts`、`ingestQueue.ts`、`rekeyDerivatives.ts` + 测试、`PapersPage.tsx`（只换 depsFor / 队列单例）、`anchors.ts`（常量搬迁）。交付物：`npm run typecheck && npm test` 绿；用 arXiv `2609.36054v1` 跑一次 `parsePdfBytes`（node 脚本或 vitest 集成）打印第 5 页附近块文本，确认无交错、无页眉、脚注独立。

**Wave 2 · 查看器与接线（opus，依赖 Wave 1 的契约）**：`PdfViewer.tsx`、`PdfZhOverlay.tsx`、`PdfFlowPage.tsx`、`translationBits.tsx`、`BlockReader.tsx`（import 换源）、`ReaderContext.tsx`、`selectionOffsets.ts`、`PaperWorkbenchPage.tsx`（§6 全部，含横幅与 runReparse）。交付物：三道门槛绿 + 本地 Chromium 手动走通三态。

**Wave 3 · 核验（sonnet）**：源码级护栏测试、E2E 脚本（§8.2）Chromium + WebKit、既有回归脚本（`scripts/webkit-pdf-repro.mjs`、`.e2e-qa-fixtures/` 里的 scroll-anchor / translate-window 诊断脚本）全部重跑。

然后 codex E2E QA（§8.3）→ 修认同的 P0/P1 → 部署 → 生产复验 → 汇报。

---

## 8. 验证

### 8.1 单测（vitest）

- `normalizePdf.test.ts`：§2.5 全部用例；既有 23 个不改断言。
- `pdfLayout.test.ts`：`segmentsOnPage`（pageX/pageY 非零映射、多 seg 的 segIndex/Count）；`columnExtents` 双栏 split / 单侧 null；`isProseLayout` 六类正反例（段落、首行缩进、居中公式行、表格数字行、单行标题、kind=table）；`partitionPageFlow` 八个合成页（单栏 3 段；双栏 + 中间通栏图注 → columns/full/columns；跨栏块译文只在右栏首条带；列内大空隙归下一条带；列末插图 trailing；页眉页脚独立行与「不足 2·lineH 并入」；一侧空列；边界取整无缝）且每例断言铺满 / 无重叠 / 阅读序；`assignPointsToStrips` 边界归上方；`planFontFit` 序列与钳位；`splitTranslation`；`pickCurrentBlock / visibleBlockRange`。
- `rekeyDerivatives.test.ts`、`ingest.test.ts`、`paperRepo.test.ts`、`translationRepo.test.ts`、`syncedRepos.test.ts`：§4。
- `PdfZhOverlay.test.ts` / `PdfFlowPage.test.ts`（沿 `WebSnapshotView.test.ts` 的 `renderToStaticMarkup` 先例）：DOM 契约（三属性、骨架/失败/非 prose、容器 `data-page` 无 height、译文紧跟最后条带、`size=null` 占位）。
- `selectionOffsets.test.ts`：同块多元素。
- 源码级护栏：`PdfViewer.tsx` 中 `PdfPage` 渲染 effect 依赖数组不含译文相关项。

### 8.2 本地 E2E（Playwright 1.52，Chromium `--use-mock-keychain` + WebKit；脚本放 `.e2e-qa-fixtures/`，沿既有登录 / 路由 mock / 导入 / 清理骨架；LLM 用 `context.route('**/api/deepseek/chat/completions')` 打桩，桩译文长度与原文相近）

环境：`cd server && npm run dev` + `npx vite --config .e2e-qa-fixtures/vite.qa.config.mjs --host 127.0.0.1`，访问 `http://localhost:5173`，预检标题与 `/api/app/health`。账号 `qa_img`。样本：arXiv `2609.36054v1`（双栏、通栏框、脚注、页眉）新导入；`attention-is-all-you-need.pdf`（单栏）与 `vllm-paged-attention.pdf`（双栏）做回归；旧解析样本 = 导入后用脚本删掉 Dexie 里该论文 blocks 的 `layout`。

1. 解析：`2609.36054v1` 第 5 页附近块文本无左右栏交错、无「page 4 of 14」行、脚注独立成块；单栏样本块数与分段与 v2 基线一致（±页眉页脚差异）。
2. 原版 PDF 点「中文」：仍在「原版 PDF」tab，无「已切换到文本视图」toast；`.paper-zh-block[data-translated="zh"]` > 0；页框 `getBoundingClientRect` 尺寸与原文模式一致；任一覆盖块 `scrollHeight ≤ clientHeight + 1`，`data-overflow` 占比 < 5%。
3. 覆盖块点击 → `data-state="orig"`，点「中」chip 恢复；划选覆盖文字 → 选区条出现且识别为译文。
4. 「对照」：`[data-page]` 高度 > 原文高度；每个已译块恰 1 个 `.paper-flow-zh`；条带文字层划选原文 → 选区条出现，anchor 为块级；页码 / 页眉在独立通栏条带里。
5. 对照流锚定（WebKit 重点）：滚到第 5 页中部，桩延迟放出上方块译文，锚元素 `top` 位移 < 2px；Chromium 同。
6. 目录跳转到块 i（两种模式）：`[data-block-index=i]` 顶边 − 窗格顶 ≈ 16px（±3）；未渲染页也能对齐。
7. 当前块跟随：滚动后目录高亮与 `position.blockIndex` 随块变化；「当前第 N 页」仍正确；重开论文位置漂移 0（沿 `diag-reopen-walkback` 的测法）。
8. 切回「原文」：`.paper-zhlayer` / `.paper-flow-*` 为 0，页框尺寸与初始一致；`scripts/webkit-pdf-repro.mjs` 两引擎全绿。
9. 旧解析样本：点中文 → 原文 + 横幅；点「重新解析」→ 完成后 overlay 出现，之前已缓存的译文（文本未变的块）直接复用、不再请求；高亮保留；「先用文本视图」按钮可用。
10. 手机视口 390×844：对照流两列并排，`main.scrollWidth === clientWidth`。
11. 文本视图与网页原貌视图回归：既有 scroll-anchor / translate-window 诊断脚本全部通过。

### 8.3 codex E2E QA

`nohup codex exec -s danger-full-access -m gpt-5.6-terra -c model_reasoning_effort=xhigh "<charter>" > .e2e-qa-fixtures/codex-qa-pdf-inline-r1.log 2>&1 &`，charter 沿 `.e2e-qa-fixtures/QA-CHARTER-snapshot-scroll-anchoring.md` 的格式，覆盖 §8.2 全部条目 + API 层（blocks 行带 layout 推送 / 拉取、`deleteTranslations` 墓碑），报告写 `QA-REPORT-pdf-inline-r1.md` 并打印 `QA-DONE`；用 Monitor 盯哨兵。只修认同的 P0/P1，清零或满 3 轮。

### 8.4 部署与生产复验

`scripts/deploy.sh --web`（本次只改前端）。在用户 Chrome 新标签页打开 `https://llm-pro.cn/#/papers/77757973-b74f-4d5f-8ae7-b33d1889b199`：先截图让续读对齐跑完 → 点「中文」出现横幅 →（**经用户点头后**）点「重新解析」→ 确认第 5 页覆盖译文、文本视图分段已修、已缓存译文复用 → 切「对照」看段落对照流 → 切回「原文」逐像素不变。然后在 `PLAN-pdf-inline-translation.md` 末尾补部署记录。commit / push / 开 PR 都先问用户。

---

## 9. 风险与取舍

1. **8% 字号阈值**偏激进（为抓 9pt 图注）；Word 导出的 PDF 若同段混用微调字号会多切段。常量集中，可回调。
2. **缩进规则**让作者块、显示公式逐行成块（可接受）；居中排版摘要（罕见）会被切碎。
3. **文本变化的段落译文失效**（吞过页眉/脚注的段）必然重译；主体段落靠 rekey 保留。可在真实论文上看 `planRekey.stats` 验收。
4. **行框精度**：pdf.js `height` 是字号不是字形包围盒，已用 ascent + 外扩；E2E 截图核对露边。
5. **插图无几何**：列末插图可能被页脚带切一道缝；可接受，后续可从 `getOperatorList` 抽图像矩形（本期不做）。
6. **对照流 DOM 常驻**：150 页约 6–8k 节点，首次提交 50–100ms；译文批次靠签名缓存让未变页跳过 reconcile。若实测偏重，退回「窗口外页记忆高度占位」。
7. **WebKit 补偿与惯性滚动**：150ms 静默窗口是经验值；若 QA 发现跳动，改为「滚动中冻结译文快照、停稳再提交」。
8. **页面 rotate / userUnit≠1**：既有文字层 CSS 本就不处理，本期沿用「未旋转页面空间」。
9. **旧客户端**：未更新设备拉到带 `layout` 的块会忽略该字段，无害。
10. **`paper-sync-pulled` 事件复用**：工作台借同步引擎的契约刷新 hook；替代方案是给 `useHighlights` 加 `reload()`，若实施时觉得借用不妥就加。

---

## 实施记录（2026-10-07，分支 `feat/pdf-inline-translation`，基于 `origin/main` a49c060，尚未提交）

### 门槛
`npm run typecheck` ✓ · `npx vitest run` 114 文件 / 2153 通过 · `cd server && npx vitest run` 349 通过 / 2 跳过 · `npm run build` ✓。

### 交付的文件
- 契约：`src/lib/paper/types.ts`（`PdfColumn / PdfLineBox / PdfLayoutSeg / PdfBlockLayout`、`PaperBlock.layout?`）、`src/lib/paper/pdfLayout.ts`（+ 39 测试）、`src/lib/paper/anchors.ts`（`CURRENT_BLOCK_BAND_RATIO`、`hasNativeScrollAnchoring`）。
- 解析器：`normalizePdf.ts`（+27 测试，既有 20 条断言不变）、`parsePdf.ts`、`normalizePdf.arxiv.test.ts`（真实 PDF 门控集成测试，fixture 缺席即跳过）。
- 数据/重解析：`repo/db.ts`（PARSER_VERSION 3）、`paperRepo.ts`（markReady 写 parserVersion）、`translationRepo.ts` + `syncedRepos.ts`（`deleteTranslations` 墓碑）、`ingest.ts`（`rekeyDerivatives` 钩子）、新 `ingestDeps.ts` / `ingestQueue.ts` / `rekeyDerivatives.ts`（+13 测试）、`PapersPage.tsx`（只换 deps 与队列单例）。
- 查看器：`PdfViewer.tsx`（新 props/API、当前块上报、WebKit 补偿、scrollToBlock、源码级护栏测试 `PdfViewer.test.ts`）、新 `PdfZhOverlay.tsx`（+6 测试）、新 `PdfFlowPage.tsx`（+6 测试）、新 `translationBits.tsx`、`BlockReader.tsx`（只换 import）、`ReaderContext.tsx`（CSS）、`selectionOffsets.ts`（同块多元素，+1 测试）、`PaperWorkbenchPage.tsx`（§6 全部）。

### 解析器在主样本（arXiv 2609.36054v1）上的结果
249 块 / 15 标题 / 14 页，每块都有 layout。第 5 页「Diminishing returns」段 26 行独立成块，不再与右栏交错；「page N of 14」页脚全部消失；跨栏续段（左栏 11 行 → 右栏 8 行）正确；16 条 9pt 尾注与「2 · 10⁶–2 · 10⁸. As in the main text…」不再成为标题。

### 与计划的偏差（都是在真实 PDF 上被迫或更稳的选择）
1. `RUN_GAP_EM` 1.0 → 0.5：本文分栏槽只有 8–10pt（LaTeX 默认 `\columnsep`），1em 会把左右栏并成一个「宽 run」。
2. 最小槽宽 3% 版心 → `max(1.2% 版心, 0.65em)`，直方图 200 → 2000 箱：3% ≈ 15pt 永远检不到 10pt 的槽。
3. `toTextItem` / `styleAscent` 移到 `normalizePdf.ts` 导出（parsePdf.ts 引用 `?worker&url`，vitest 无法加载）。
4. 独立的「page N of M」文本项先于整行规则剔除（fancyhdr 把它单独成项，首页与脚注末行同 y）。
5. 编号标题三道守卫：字号 ≥ 0.95×正文、正文以字母/CJK 开头、无句中句界。
6. 工作台的 in-place 判定额外要求 `langMode !== 'orig'`（原文模式 viewer 不上报块位置，否则页级处理器会把块序号冻住）。
7. 「中」chip 放在覆盖块旁而非块内（否则块文本含「中」破坏高亮偏移）。
8. 背景取样多点取最亮，仍深则白。
9. 成本提示/横幅放在零高度 sticky 容器里（纯 absolute 会随滚动消失）。
10. 切入/切出对照流同步重对齐（两帧延迟会把已读 27% 冲到 90%）。
11. 对照流页框比原文宽 2px（边框画在内容外，条带不压边）。

### 冒烟（实现者，Chromium，桩译文 ≈ 0.45× 原文长度；脚本 `.e2e-qa-fixtures/pdf-inline/smoke-viewer.mjs`，截图同目录 `smoke-*.png`）
中文：停留原版 PDF、无 toast、页框 930×1315 与原文一致、22 块 0 溢出、点段看原文与「中」chip 正常。对照：第 5 页 1315 → 2567px、11 条带全部绘制、184 个文字层 span、条带划选出选区条。切回原文：覆盖/条带元素清零、页框一致、已读 27% → 27%。390px：双列并排无横向滚动。旧解析样本：横幅 → 重新解析 < 1s → 249 块回 layout、缓存译文直接复用、0 次新 LLM 调用。

### 实现者报告的待 QA 事项
- WebKit 全部未测（含对照流滚动补偿与 150ms 静默窗）。
- **重解析失败会把 ready 论文置为 failed**（`reingestPaper` 既有行为；旧块仍在库里，重开却显示「还不能阅读」）——应修：失败时恢复 ready。
- 重解析进行中离开再回来，横幅回到空闲态，再点会再排一次。
- 对照流高度变化后当前块要等用户滚动才重算。
- 作者行等单行块被当 prose 覆盖（设计接受）。

### QA 轮次 r1（独立 QA 子代理，Chromium + WebKit，API + 浏览器；报告 `.e2e-qa-fixtures/QA-REPORT-pdf-inline-r1.md`，脚本 `qa-pdf-inline-*.mjs`，截图 `shots-qa-pdf-inline/final-*.png`）
23 条场景全部 PASS（B7 为设计接受的 P2）。本轮发现并修掉 8 个 P1（含代码审查转来的 3 个）：
1. 升级重解析失败不再把 ready 论文置为 failed（`ingest.ts`，旧块保持可读，横幅显示错误 + 重试）。
2. 重解析进行中刷新 / 离开再回来：新增 `src/lib/paper/reparseTasks.ts` 模块级任务登记（按论文去重、任何挂载可订阅）；工作台对中间态论文每秒重读直到 ready/failed。
3. 旧解析 PDF 的横幅期间不再翻译 / 弹授权 / 计费（`translateLang`：原版视图下旧解析按「原文」驱动 `useTranslations`）。横幅期间请求 1 → 0。
4. 对照流双栏行里视线上方落地的译文会推走正在读的栏（Chromium 647px / WebKit 500px）：插入点在视线之上且所在双栏行与窗格相交的译文先保留骨架，滚回去再挂（`pdfLayout.insertionPushesReader`）。修后 0.2 / 0px。
5. 开合 Copilot / 改窗口宽度把视线推走 1304px（原生 overflow-anchor 在锚点尺寸变化时被抑制）：scale 变化后按视线处元素复位。修后 ≤ 0.9px。
6. WebKit 补偿的静默窗被 viewer 自己的程序化滚动打开：只认 wheel / touchstart / pointerdown / keydown 为用户滚动。
7. 跳转目标被冲成同高的别栏块、平滑跳转停在 +82：跳转后钉住目标、在途不上报、停稳复核一次。B10 三跳全部命中，E22 重开 4 次位置不漂。
8. 旋转页按原文渲染；观察带内无块时报「刚读过的块」（`pickNearestBlock`）。
审查项顺带：`flowLayoutOf` 每页只算一次；共享谓词 `hasTranslatableText`；URL 导入展开 `createIngestDeps`；高度变化后补测一帧。

### 润色（部署前）
- 图内文字守卫 `pdfLayout.isLabelLike`（三条规则：孤立短单行 / 粘连的多 seg 单行块 / 离栏左缘 >10% 且窄于 80% 栏宽的短块；标题、图表题注前缀、列表标记豁免）：中文模式不覆盖、对照流不出译文行，第 4 页示意图不再被切开；第 1 页作者行顺带不再覆盖。三份样本扫描 101 个命中全是图标签 / 公式 / 表格行 / 作者行，无正文误伤（`qa-pdf-inline-labels-polish.txt`）。
- 升级重解析不覆盖已有标题；`pickPdfTitle`：元数据标题含连续空格或控制字符时改用首个 heading（本篇元数据是「AI R   D」）。
- 多行大字标题合并为一个 heading（同页同栏、字号差 ≤5%、行距 ≤1.6 行高、前一行未收句、合计 ≤120 字）：arXiv 标题合为一条，标题数 15 → 13；attention 不变。
- 门槛：typecheck ✓ · 2199 测试 ✓ · server 349 ✓ · build ✓。

### 遗留（P2，未修）
- 第 3 页 Figure 1：一段正文被解析器粘到图内文本框，译文行落进图里；图内 4 个右侧框离栏缘仅 8.5%、间距 1.8 行，不满足标签规则——需要图形区域检测（PLAN §9.5）。
- 对照流宽度变化时非当前栏漂 130–350px（两栏各自一叠，单一 scrollTop 保不住两栏）。
- 解析：attention 块数 +11.9%（行内公式小字片段按字号规则独立成块）；vLLM 参考文献悬挂缩进续行被切开。
- 升级重解析会经 `markReady` 重置 syncMeta，把未变的原始文件整份重传（服务端按 sha 短路，只浪费上行）。
- 原文模式开合 Copilot 丢位置、pdf.js worker 失败后整会话退化：既有问题。

### 润色 2
- 宽段落的短尾行（如 Figure 2 题注最后一行只占左半）不再被标成 left 栏：续行与上一行同左缘时继承 span/full（`wideTailCol`，只改一行、句末不触发）。题注块由 `[span×3, left×1]` 变 `[span×4]`。
- 对照流译文行宽度：多行 span/full 与左右栏段延伸到栏右缘（`translationBounds`），标题与单行 span 保持自身文本宽度（不压图框）。
- 门槛：typecheck ✓ · 2206 测试 ✓ · server 349 ✓ · build ✓。

### 部署记录
- 2026-10-07 23:14 `scripts/deploy.sh --web`，入口包 `index-BXzWaDcS.js`，备份 `/var/www/llms-study.bak-20261007-231436`（服务端未改）。
- 生产复验（用户 Chrome，论文 `77757973…`，旧解析 175 块）：新包已加载；原版 PDF + 对照 → 显示「这篇 PDF 是旧版解析…」横幅，DeepSeek 请求 0 次，PDF 按原文渲染（15 页，页框 929×1315）。「重新解析」待用户点头后执行并复验中文 / 对照。
- 生产重解析（用户点头后，2026-10-07 23:2x）：175 → 218 块，横幅消失，缓存译文直接复用（对照流里 11 条译文行即刻出现），标题合并为一条、目录里「13 adapt to…」「2 · 10⁶–2 · 10⁸…」等垃圾条目消失。第 6 页（用户例子所在页）：文本视图里「Diminishing returns.」块（#37）不再与右栏交错、全文无「page N of M」；中文覆盖 9 块全部贴合（0 溢出 / 0 失败），译文「收益递减。证据表明，收益递减不会阻止智能爆炸…」原位覆盖；对照流 7 条译文行、181 个文字层 span，跨栏段「Data.」的译文挂在右栏续段之下。切回原文：无覆盖/条带元素，页框 922×1303 与改动前一致。
