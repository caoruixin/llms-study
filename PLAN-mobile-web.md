# Mobile Web 适配改造 + Paper Copilot 补部署

## Context

用户手机访问 llm-pro.cn(LLM Infra Studio)体验极差,截图证实两类问题:

1. **移动端布局未适配**:全站仅 46 处 Tailwind 断点前缀,面试陪练页 `InterviewPage.tsx:202-204` 是硬编码双栏(`flex gap-6` + `aside w-80 shrink-0`,无任何响应式兜底),390px 屏上答题区被挤到 ~46px(截图里一行一个字);顶部导航在手机上被截断只露半个 tab。需要专门面向 mobile-web 的一套布局。
2. **Paper Copilot 线上缺失**(根因已查明):`VITE_ENABLE_PAPER_COPILOT=1` 只在 `.env.development.local`(Vite 仅 dev 模式加载),8-13 13:23 部署 PR #9 时裸 `npm run build`(flag-off)→ `vite.config.ts:24-40` 的 `paperCopilotOffPlugin` 把 `pages/papers/`、`lib/paper/`、`components/papers/` 整棵子树 resolve 成空模块 → 覆盖了当天上午的 flag-on 部署,旧目录当场删除无回滚点。线上 bundle 0 处 "Paper" 字符串已验证。nginx 代理层实测完好(`/api/deepseek`/`/api/moonshot`/`/api/jina` 均为上游响应),**只差前端产物**。

用户已确认:**移动导航用底部 Tab Bar;Paper Copilot 立即先行部署**。

技术底座:React 18 + Vite 6 + Tailwind v4(无 config,主题在 `src/index.css` @theme,默认断点)+ HashRouter + zustand。无 UI 自动化测试,唯一门是 `tsc --noEmit`。可复用资产:`PaperWorkbenchPage.tsx:81-94` 私有 `useMediaQuery`、`:741-758` 抽屉、`:761-778` bottom sheet(全站唯一已验证的三档响应式范式)。

设计基调:**移动优先补写(base=手机)+ 抽屉/底部承载次级内容 + 桌面(1440px)零回归**。不引入新依赖/UI 库,纸感米黄主题沿用。

---

## Part A: Paper Copilot 补部署(先行,独立交付)

1. **flag 持久化**:新建入 git 的 `.env.production`,内容 `VITE_ENABLE_PAPER_COPILOT=1`。裸 `npm run build` 从此默认带 Paper;门控机制本身不动(仍可显式关闭)。
2. **固化部署脚本** `scripts/deploy.sh`:`npm run build` → `tar -C dist -czf - . | ssh llm-pro 'tar -xzf - -C /var/www/llms-study-new'` → 原子目录切换;切换时把旧目录改名为带时间戳的备份(替代现在的当场 `rm -rf`),保留最近 1-2 份回滚点。
3. **构建 + 部署 + 线上验证**:`https://llm-pro.cn/#/papers` 可达;`assets/` 出现 PapersPage/pdfjs chunk;`pdf.worker.min.mjs` 200;bundle 内 grep 到「论文陪读」。

不改 nginx、不涉及后端(纯静态 SPA + nginx 反代注入 key)。

---

## Part B: Mobile Web 适配(分 6 个 Phase)

### Phase 0 — 共享基建

- **`src/lib/useMediaQuery.ts`(新)**:逐字迁移 `PaperWorkbenchPage.tsx:81-94` 的 hook,导出 `MQ = { md: '(min-width: 768px)', lg: '(min-width: 1024px)', xl: '(min-width: 1280px)' }`(px 不用 rem,与 papers 现值逐字一致);PaperWorkbenchPage 改 import。
- **`src/components/ui/Drawer.tsx`(新)**:从 `PaperWorkbenchPage.tsx:741-758` 抽取,props `{ open, onClose, title, children, widthClass?='w-[min(20rem,85vw)]' }`。**不用 portal**(papers 根节点有 `-translate-x-1/2` transform 祖先,fixed 以容器为包含块是已验收现状;保持调用处渲染两种上下文各自正确)。迁移顺序:先建组件 → interview 首用 → 单独 commit 替换 papers 抽屉并三视口对照(可独立 revert)。BottomSheet 暂不抽(仅一个消费者)。
- **safe-area/dvh**:`index.html:5` viewport 加 `viewport-fit=cover`;`App.tsx:35` `min-h-screen`→`min-h-dvh`;`AskDialog.tsx:130` `70vh`→`70dvh`(全站仅此一处 vh 高度)。
- 断点约定:沿用 Tailwind 默认;语义 base=手机、md=平板、lg=桌面双栏、xl=宽桌面。

### Phase 1 — 壳层(P0,解决导航截断)

文件:`src/App.tsx`、`src/nav.ts`、新 `src/components/ui/MobileTabBar.tsx`。

- **header <md 收敛**(`App.tsx:38-62`):副标题加 `hidden md:inline`;标题 `text-base md:text-lg`;现有横滚 nav 加 `hidden md:flex`(桌面零变化)。手机 header 两行 ~100px → 一行 ~52px。
- **底部 Tab Bar**:`nav.ts` NAV 项加 `short` 字段(架构/推理/Agent/面试/论文/设置,单一数据源,flag-off 自动 5 项;设置直接做第 6 个 tab,不做「更多」)。`MobileTabBar.tsx`:`fixed inset-x-0 bottom-0 z-40 border-t border-line bg-ink/95 backdrop-blur pb-[env(safe-area-inset-bottom)] md:hidden`,每项 NavLink `flex-1 min-h-12`,active 用 accent 色 + 顶部 2px 指示条。
- **与 papers bottom sheet 共存**:App 内 `useLocation`,`/^\/papers\/./.test(pathname)` 时隐藏 tab bar(工作台是沉浸态,自带 z-40 底部 Copilot 面板);main 的 padding 跟随:`hideTabBar ? 'pb-6' : 'pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-6'`(条件类必须完整字面量三元)。z 约定:抽屉 z-50 > tab bar/header/papers sheet z-40(后两者不同路由不共存)。

### Phase 2 — 面试陪练(P0,最大单点)

文件:`src/pages/InterviewPage.tsx`、新 `src/components/interview/QuestionList.tsx`、复用 Drawer。

- 题库侧栏 → **Drawer**(不用 select 下拉:列表带最佳等级徽章/EN 标/分类分组三层富信息)。`:204` aside → `hidden lg:block w-80 shrink-0 space-y-4`(选 lg 不选 md:768px 下侧栏会把 textarea 挤到 ~390px);`:205-229` 列表 JSX 提取为 `QuestionList`,aside 与 Drawer 双处渲染,Drawer 内选题后自动关闭;`<lg` 时在 MasteryDashboard 与答题卡之间加当前题切换条(`min-h-12 lg:hidden`,内容:☰ 题库 + truncate 题干 + 最佳等级徽章,点击开抽屉)。
- 触控目标(规范:移动主操作 ≥44px 即 `min-h-11 md:min-h-0`,紧凑列表 ≥40px):`:376-398` 两段式清空按钮、`:413` 删除 ✕(外扩容器 `min-h-11 min-w-11`)、`:275`/`:429` 文本按钮;`:409` 历史行 `flex` → `flex flex-wrap gap-x-3 gap-y-1`(时间戳可换行)。
- 顺带硬化:两段式确认靠 `onBlur` 复原,iOS Safari 按钮 tap 不聚焦 → 加 document `pointerdown` 外点复原(或 3s 超时)。

### Phase 3 — 架构演进 + Agent 架构(P1)

文件:`src/pages/ArchitecturePage.tsx`、`src/components/TransformerDiagram.tsx`、`src/pages/AgentPage.tsx`。

- **两张宽表 → md 以下卡片**(同一数据渲染两份:表格容器加 `hidden md:block`,卡片列表 `md:hidden`):注意力表(`:38`,min-w-[900px])每机制一张卡,三段纵排;价目表(`:73`,min-w-[1100px],9 列)每模型一张卡:头(provider + modelId 链接 + 开源徽章)+ 数字区 `grid grid-cols-2` 五组「小灰 label + font-mono 值」+ 脚注(实用上下文/备注/过期提示),格式化逻辑与表格行共享。
- TransformerDiagram:`:126` `sticky top-20` → `lg:sticky lg:top-20`;`:41` 类名映射表(完整字面量)保持写法;encdec `grid-cols-2` 先保留,验收溢出再加横滚兜底(不改竖排,横向 K/V 流向是图的语义)。
- AgentPage:`:65`/`:71` 框图 `grid-cols-3` → `grid gap-2 sm:grid-cols-3`(手机竖排,循环语义靠虚线框标题保留);`:93-98`/`:111-115` 流程行去 `whitespace-nowrap`,改 `flex flex-wrap items-baseline`,desc 加 `basis-full sm:basis-auto`。

### Phase 4 — 推理链路四面板(P1)

文件:`src/components/EconomicsPanel.tsx`、`MemoryCalculator.tsx`、`LifecycleSim.tsx`、`StackExplorer.tsx`。

- EconomicsPanel `:108`:`md:grid-cols-3 lg:grid-cols-7` → 补 `sm:grid-cols-2`;MemoryCalculator `:67`:`md:grid-cols-5` → `sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5`;LifecycleSim `:188`:`min-w-64 flex-1` → `basis-full sm:basis-auto sm:min-w-64 flex-1`,`:204` ▶ 按钮 `min-h-11 md:min-h-0`;StackExplorer `:49` `sticky top-20` → `lg:sticky lg:top-20`。
- recharts 面板验收 390px tick 不重叠(必要时调 tick fontSize)。

### Phase 5 — P2 收尾

- **SegmentedTabs**(`src/components/ui/SegmentedTabs.tsx`,4 页共用):<md 单行横滚不换行(wrap 会让长 label 换成参差药丸;不吸顶,避免新增 top-* 魔法值):容器 `flex max-w-full overflow-x-auto … md:inline-flex md:flex-wrap md:overflow-visible`,按钮加 `shrink-0 whitespace-nowrap py-2 md:py-1.5`。
- **AskDialog** 移动形态:`<md` 时 `drag=false`(消除触屏拖拽/滚动冲突)+ 底部面板形态 `absolute inset-x-0 bottom-0 max-h-[70dvh] rounded-t-xl pb-[env(safe-area-inset-bottom)]`(两套完整字面量三元);关闭 × 外扩 `min-h-10 min-w-10`。
- **SelectionAsk** 触屏策略:`(pointer: coarse)` 下改监听 `selectionchange` 防抖 ~350ms(现 pointerup 路径在长按选词/拖选区把手时失效),fine pointer 保持现路径;Ask 按钮 coarse 下 `min-h-10 px-3`。
- KdaNetwork `:149` `lg:sticky lg:top-20`(一行);papers Drawer 迁移 commit;PaperWorkbench sheet 全屏按钮 `min-h-10`。

---

## 验证

每 Phase 收尾门:`npm run typecheck` → `npm run test`(现有 vitest 全绿,UI 改动不碰 .test.ts)→ `npm run build` → `npm run dev`(自带 LLM proxy,可真实走评分/Ask 流)+ Chrome DevTools 三视口 **390×844 / 768×1024 / 1440×900** 人工验收(可用 claude-in-chrome 浏览器工具执行)。

通用断言:390px 下 `document.documentElement.scrollWidth === 390`(无横向溢出);1440px 逐页与改造前目视 diff 为零。关键场景:papers 工作台三档行为与改前一致(Phase 0 回归基准);/papers/:id 无 tab bar 且满高无空隙;面试页 390px 抽屉选题→答题→评分→历史全链路拇指可达。

Phase 1、2 完成即解决截图中两个 P0,可先部署真机验证(iOS Safari safe-area 需真机或 DevTools iPhone 机型确认)。

## 交付编排(批准后执行)

1. **保存计划文档**:将本计划另存为项目内新文件 `PLAN-mobile-web.md`(不覆盖任何已交付 PLAN 文档),作为实施基准。
2. **Part A 先行**:主会话直接执行 Paper Copilot 补部署(.env.production + scripts/deploy.sh + 构建部署 + 线上验证),体量小不派代理。
3. **Part B 派专职实施代理**(模型按任务复杂度分配):
   - Agent 1(sonnet5):Phase 0 基建 + Phase 1 壳层(useMediaQuery/Drawer 提取、header 收敛、MobileTabBar)。
   - Agent 2(fable/opus5):Phase 2 面试陪练(最大单点,含 QuestionList 提取与 iOS 确认态硬化)。
   - Agent 3(sonnet5):Phase 3 架构+Agent 页(宽表卡片化、框图竖排)。
   - Agent 4(sonnet5):Phase 4 推理面板 + Phase 5 P2 收尾。
   - 串行推进(Phase 0/1 是后续依赖),每个代理收尾必须过 typecheck + test + build 门。
4. **QA 代理验证**(不用 fable5,按既往工作流用 opus5/sonnet5):claude-in-chrome 浏览器 E2E,三视口 390/768/1440 逐页验收 + 修复循环,直到 0 P0/P1;papers 工作台以改造前行为为回归基准。
5. **最终部署**:QA 通过后经 deploy.sh 上线,真机复核截图中的两个 P0 场景。

## 风险清单

1. **Tailwind v4 完整字面量**:条件类必须写成两个完整字面量的三元,禁止拼接;build 后在 dist css grep 关键新类名(如 `pb-[calc(4.5rem+env(safe-area-inset-bottom))]`)。
2. **sticky top-20 与 header 高度耦合**(三处):统一降级 `lg:sticky lg:top-20`,lg+ header 单行成立。
3. **papers `h-[calc(100dvh-14rem)]`**(`:690`):md+ 不动 header/main,<md 工作台隐藏 tab bar,均无联动;留约束记录——将来若工作台显示 tab bar 此式必须联动。
4. **Drawer 不加 portal**(transform 祖先语义);papers 迁移独立 commit 可 revert。
5. **iOS 两段式确认 onBlur 失效**:Phase 2 一并加外点/超时复原。
