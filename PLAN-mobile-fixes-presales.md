# 移动端体验修复 + 售前陪练升级(三个工作流)

## Context

账号同步上线后的首次真实双设备使用暴露三组问题:(1) 手机列表页「共 1 篇但列表空」——筛选 tab 停在「处理中」造成的 UX 陷阱,数据同步本身正常;(2) 手机打开论文,原版 PDF 全部停在"第 N 页"占位符空白,且工作台移动端布局失衡(标题被顶走、工具条三行堆叠、页宽仅 ~308px);(3) 产品定位升级为"AI 学习与实践工作台",需去掉全站"面试"字眼,按赋能团队宗旨改为售前陪练(帮团队准备客户项目/方案沟通)。

已定口径(与用户确认):文案**改包装不改题**(题库本来就是 Token/算力售前方向技术题);路由 `/interview` 与存储 key `llm-infra-history` **保留不动**。

## 工作流 1:列表页筛选 UX + 回前台补拉(`src/pages/papers/PapersPage.tsx`)

1. 计数反映筛选:`filter==='all'` 时保持 `共 N 篇`,否则 `筛选后 M / 共 N 篇`(复用现有 filtered memo)。
2. 空态逃生口:`papers.length>0 && 筛选结果空` 时空态卡片加「显示全部」按钮 → `setFilter('all')`。
3. 回前台补拉:新增 visibilitychange effect(镜像 PaperWorkbenchPage 已有模式):authed 且 visible 时 `getSyncEngine()?.pullSince()` 后 `refresh()`,失败静默。

## 工作流 2:移动端工作台(设计已评审,按下述执行)

### A. 原版 PDF 空白修复(`src/components/papers/PdfViewer.tsx` + `PaperWorkbenchPage.tsx`)

根因:两条完全静默的失败路径 + 一个错误态粘滞 bug。

- **A1 单页失败可见化**:PdfPage 加 `renderError`/`retryTick` state;catch 里区分 RenderingCancelledException(保持静默)/文字层失败(仅 console)/位图失败(`console.error('[pdf]…')` + 占位符变「本页渲染失败·点按重试」按钮 min-h-11)。
- **A2 渲染窗口冷启动兜底**(F7):`range ?? {min:1,max:1}` 兜底使首屏 1-3 页无条件 active;IO 空批加一次性 `console.warn`;当前页 measure() 后 `setRange(prev => prev ?? {min:page,max:page})` 几何补种(只填 null 不覆盖 IO)。
- **A3 bytes 懒拉修复**:渲染分支顺序反转为 `bytes ? PdfViewer : bytesError ? 错误框 : 加载中`(成功永远赢);去掉 `.catch(()=>null)`,新纯函数 `describeFileFetchError`(新文件 `src/lib/paper/fetchErrors.ts`+测试)按 ApiRequestError.code 分类文案(unauthenticated/network/其他;404 走 file==null 分支);错误框加「重试」(bytesTick 重跑 effect)与「用文本视图阅读」按钮;加载态加 spinner + 文件大小(`paper.byteSize`)。
- **A4 防御**:`'withResolvers' in Promise` 守卫(iOS<17.4 提示切文本视图而非白屏);全部失败路径统一 `[pdf]` console 前缀。

### B. 移动端布局(仅 <768px;md+ 用 `md:` 前缀逐字还原今日类名,构造性保证桌面零变化)

- **B1 杀文档级滚动**(标题被顶走与 Copilot sheet fixed 包含块漂移的共同根因):App.tsx 壳层 hideTabBar 分支 `flex h-dvh flex-col md:block md:h-auto…`、header `shrink-0`、main 手机满幅零 padding(md: 还原 px-4 py-6);工作台根改 flex 链 `h-full min-h-0 flex-col`(md: 还原);阅读行 `min-h-0 flex-1`(md: 还原 `h-[calc(100dvh-14rem)]`);`scrollAndFlash`/`alignToPosition` 容器化滚动(新纯函数 `readerScrollTop` 进 `src/lib/paper/anchors.ts`+测试,容器内 scrollTo 替代 scrollIntoView 滚 window)。
- **B2 工具条收敛两行**:标题行(← + truncate 标题,meta 段 `hidden md:block`)+ 工具行(`MODE_TABS_SHORT`「PDF/文本」短标签、目录、Copilot、行尾 mini-meta「第x/y页 · z%」`md:hidden`);SegmentedTabs 组件零改动。
- **B3 页宽回收**:阅读列 `p-2 md:p-4`;PdfViewer scale 余量手机 8/桌面 16(`useMediaQuery(MQ.md)`);390 设备页宽 308→**364px**。
- **B4 Copilot sheet**:根满高贴底后 `fixed bottom-0` 恢复正确;safe-area padding 两分支完整字面量(`pb-[calc(1rem+env(safe-area-inset-bottom))]` 等);全屏内容高改 `min-h-0 flex-1`;加注释固化"sheet 依赖根满高贴底"的耦合。
- **B5 触控**:新增/改动按钮统一 `min-h-11 md:min-h-0`。

约束:Tailwind v4 条件类必须完整字面量三元禁止拼接;Drawer/sheet 不加 portal(仓库既有约定);flag-off 构建不受影响(全部改动在 paper 目录与 App 壳层 className)。

## 工作流 3:售前陪练文案升级(改包装不改题)

约 20 处"面试"字眼,14 个文件。核心改点:
- `src/nav.ts:10`:label「面试陪练」→「售前陪练」,short「面试」→「售前」。
- `src/lib/grading.ts`(评分 prompt):角色「资深技术面试官」→「资深售前教练(以客户视角评审)」;「面试题」→「陪练题」;"候选人"表述改"回答者";保留评分维度与输出结构不变(结构变了会影响解析,只改角色与语境措辞)。
- `src/pages/InterviewPage.tsx`:「面试官点评」→「教练点评」;页面标题/引导文案按售前陪练语境改。
- `src/components/ask/SelectionAsk.tsx`(划词 prompt ×3):「售前方向的面试」→「售前场景的客户沟通准备」;「面向面试表达」→「面向客户沟通表达」;「售前面试的加分项」→「售前沟通的加分项」。
- 其余 10 文件(questions.ts/stack.ts/transformer.ts/types.ts/models.ts/KdaNetwork/KdaDerivation/TransformerDiagram/StackExplorer/AgentPage)各 1-2 处教程语境:「面试时…」→「与客户沟通时…」、「面试前背熟」→「与客户沟通前背熟」等,逐处按上下文改写,不机械替换。
- **不改**:路由 `/interview`、`llm-infra-history` key、题库题目本身、grading 输出 JSON 结构。

## 验证

- vitest:新增 `fetchErrors.test.ts`、`anchors.test.ts`(readerScrollTop 数学等价性、isPageActive range-null 兜底);全量 `npx vitest run` 零回归;`npm run typecheck`;flag-on/flag-off 双构建。
- 浏览器手验(dev + DevTools 390×844 与 1440×900,双源双设备):
  - PDF:正常打开立即出位图;删 files 行模拟远端懒拉(spinner→成功);Offline→分类错误文案→重试成功且错误框消失;强制单页 render reject→页内重试徽标;`delete Promise.withResolvers` 后刷新→降级提示。
  - 布局:手机无文档级滚动(scrollHeight===clientHeight)、标题工具行常驻、目录/引用跳转只滚阅读列、canvas ≥350px、sheet 贴底+safe-area+全屏;**桌面 768/1440 与改前逐屏目视 diff 为零**。
  - 列表:非全部筛选+空 → 「筛选后 0 / 共 N 篇」+「显示全部」;切走切回自动出现新论文。
  - 文案:全站 grep "面试" 零残留(src 内);/interview 页面走一轮评分(真实 LLM)确认 prompt 改动后评分 JSON 解析正常。
- 发版:`scripts/deploy.sh --web`;用户手机端复验 PDF 渲染与布局(真机是最终裁判,模拟器无法完全复现 webview)。
