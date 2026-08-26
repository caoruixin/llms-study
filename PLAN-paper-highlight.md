# 论文陪读:划词高亮功能

## Context

论文阅读页(`/papers/:paperId`)现有划词浮层只有 5 个提问类按钮(解释这段/更简单/推导公式/举例/加入提问)。用户希望新增「高亮」按钮:选中一段文字后一键飘黄并持久保存,用于通读时标记不熟悉的内容,读完后统一回查——而不是见一个查一个打断阅读节奏。

已确认的范围决策:
- **持久化只存本地 IndexedDB**(照 translations 表模式,不进云同步;以后要同步再加白名单)
- **左侧大纲栏加「高亮」tab**:列出本篇全部高亮片段,点击跳回原文并闪烁定位
- 支持取消高亮(点击已高亮文本弹「取消高亮」小浮层 + 列表项删除按钮)
- 仅支持文本视图(原版 PDF 视图锚点只到页,不支持);table 块(dangerouslySetInnerHTML)不支持,formula/code/heading/list/paragraph 均支持

## 核心设计

### 数据模型(`src/lib/paper/types.ts` 追加)

```ts
export interface PaperHighlight {
  id: string          // uuid(合并会改写区间,确定性拼接键无意义)
  paperId: string
  blockIndex: number
  blockId: string     // 容错/调试,沿 BlockTranslation 惯例
  lang: 'orig' | 'zh' // 原文高亮只渲染在原文上,译文高亮只在译文上
  start: number       // [start, end) 相对源字符串(block.text 或该块译文)
  end: number
  text: string        // 快照:列表展示 + 渲染前一致性校验
  createdAt: number
}
```

- **偏移相对源字符串而非 DOM**:给每个"textContent 恰好等于源字符串"的元素加 `data-hl-host="orig" | "zh"`(BlockBody 各分支:h3 / list 内层 span(避开 '·' 前缀)/ pre / p;TranslatedBody 同理 + 对照模式译文 div)。table 分支不加 → 天然排除。
- **容错不用 parserVersion**:渲染前校验 `source.slice(start, end) === row.text`,失配(重解析/译文重生成)不渲染正文 mark,列表仍展示快照并可跳块。
- **跨块选区按块拆成多条记录**(每块各自钳位区间,空交集跳过,上限 `MAX_HIGHLIGHT_BLOCKS = 50`);跨语言混合选区按起点语言归类(与 SelectionActions 现有 translated 判定同一口径)。
- **重叠高亮自动合并**:新区间吞并所有相交/相邻旧区间(删旧行 + 写合并行,单事务)。

### 新增文件

| 文件 | 内容 |
|---|---|
| `src/lib/paper/highlight/highlightModel.ts` | 纯函数:`mergeRanges`(线扫吞并)、`splitByRanges(text, ranges) → {text, id?}[]`(区间切分,照 `retrieval.ts` 的 `splitHighlight` 模式)、`validRanges`(快照校验)、`newHighlightId`、常量 |
| `src/lib/paper/highlight/selectionOffsets.ts` | `captureHighlightRanges(range, container) → CapturedRange[]`:Range → 逐块 {blockIndex, lang, start, end, text}。偏移用 `Range.selectNodeContents(host) + setEnd(node, offset) → toString().length` 计算,起止块间遍历 `blockDomId(i)` 取宿主并钳位 |
| `src/lib/paper/highlight/useHighlights.ts` | hook(照 `useTranslations` 形状):载入、内存态、`addCaptured`(跑合并 → `repo.applyMerge`,落库失败不回滚内存态)、`remove`、`byBlock: ReadonlyMap<number, PaperHighlight[]>` |
| `src/lib/paper/repo/highlightRepo.ts` | 仓储(照 `translationRepo.ts` 模板):`getHighlights` / `applyMerge(toDelete, toPut)`(单事务)/ `deleteHighlights` / `deleteByPaper` |
| `src/components/papers/HighlightActions.tsx` | 点击 `<mark data-highlight-id>` 的「取消高亮」小浮层(照 SelectionActions 结构;根节点挂 `data-paper-selection-ui` 互相豁免;click 时选区非塌陷则 return,避免与划词冲突) |
| 测试 | `highlightModel.test.ts`(node 纯函数)、`highlightRepo.test.ts`(fake-indexeddb + v3→v4 迁移)、`src/components/papers/highlightRender.test.ts`(renderToStaticMarkup 冒烟;注意只认 `.test.ts` 不认 `.tsx`,用 createElement) |

### 修改文件

1. **`src/lib/paper/repo/db.ts`** — `highlights!: Table<PaperHighlight, string>`;`this.version(4).stores({ highlights: 'id, paperId, [paperId+blockIndex]' })`,纯加法迁移。
2. **`src/lib/paper/repo/paperRepo.ts`** — allTables 数组 + `deletePaper` 的 Promise.all 各补 `db.highlights`(级联删除)。
3. **`src/lib/paper/repo/repos.ts`** — 挂 `highlight` 裸实现(不套 synced 装饰器,注释说明照 translation 先例)。
4. **`src/components/papers/BlockReader.tsx`** — Props 加 `highlights?: ReadonlyMap<number, readonly PaperHighlight[]>`;各文本分支加 `data-hl-host`;`{block.text}`/`{text}` 换成内部组件 `HlText`(validRanges → splitByRanges → 段渲染),mark 样式 `<mark data-highlight-id={id} className="cursor-pointer rounded-[3px] bg-amber/30 text-fg hover:bg-amber/45">`(照 OutlinePane 搜索命中 mark 加深一档)。
5. **`src/components/papers/SelectionActions.tsx`** — `BAR_WIDTH` 336 → 400;BarState 存 `range: Range`(setTimeout 里 cloneRange 快照);Props 加可选 `onHighlight?: (range: Range) => void`,有值时渲染第 6 个「高亮」按钮。**不扩展 `PaperAskAction`**(高亮不进 Copilot 队列,onAction 签名不动)。
6. **`src/components/papers/OutlinePane.tsx`** — `OutlineTab` 加 `'highlights'`,TABS 加 `{ id: 'highlights', label: '高亮' }`;新分区照搜索结果列表样式:条目点击 `onJumpBlock(blockIndex)`(复用现有跳转+闪烁链路,零新代码),右侧 ✕ 删除(stopPropagation),zh 行加「译」徽章,空态引导文案。
7. **`src/pages/papers/PaperWorkbenchPage.tsx`** — 接线:`useHighlights(paperId)`;`handleHighlight`(capture → addCaptured → toast「已高亮,可在左栏『高亮』里回查」/ 不支持提示 → 清除选区);`onHighlight` 仅 `mode === 'text'` 时传入;`highlights` 传 BlockReader;挂 `<HighlightActions>`;高亮列表(排序 + 补 section)传 OutlinePane。

### 实施顺序

1. 纯函数层:types + highlightModel + 测试(零依赖先行)
2. 存储层:db v4 → highlightRepo → paperRepo 级联 → repos 门面 → 仓储/迁移测试
3. DOM 捕获:selectionOffsets
4. 渲染:BlockReader data-hl-host + HlText → 渲染冒烟测试
5. 交互:SelectionActions 扩展 + HighlightActions
6. 列表:OutlinePane 高亮 tab
7. 接线:useHighlights + PaperWorkbenchPage
8. `npx vitest run` + lint + build

按既定交付流程:批准后先把本计划另存为项目内 `PLAN-paper-highlight.md`,实施走专职 subagent,完成后 codex CLI 做浏览器 E2E QA(orig/zh/both 三态、跨块选区、重叠合并、取消、列表跳转闪烁、刷新后持久、删论文级联),P0/P1 修到 0 或 3 轮。

## 验证

- 单测:`npx vitest run`(区间切分边界、合并吞并、快照失配过滤、仓储原子性、v3→v4 迁移无损、渲染冒烟含 mark 位置/'·' 不进 mark/zh 高亮不进原文)
- 浏览器手工/E2E:本地 `npm run dev` 打开一篇论文 → 划词 → 高亮 → 刷新仍在 → 切三态语言 → 跨块划选 → 点 mark 取消 → 左栏列表跳转 → 删除论文后 IndexedDB highlights 已清
