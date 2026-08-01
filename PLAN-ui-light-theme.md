# PLAN: UI 明亮化改版：暗夜蓝 → 米白 + 酒红（Warm 风格）

> 状态：已批准，交付中（2026-08-01）。分支 `feat/ask-llm-selection`。

## Context

当前站点是深色海军蓝主题（`--color-ink: #0b1020` 等），用户反馈太黑暗、灰暗，影响使用体验。参考用户提供的 "Warm" 应用截图，整站改为明亮清爽的暖色浅色主题：米白页面底色、纯白卡片、酒红主色（active 态为粉色浅底）、红色下划线 Tab、酒红填充分段控件、近黑正文。单主题就地转换，不做深浅切换。

技术上非常有利：Tailwind v4 CSS-first，全部配色集中在 `src/index.css` 的一个 `@theme` 块（10 个 token），组件几乎全用 token 类；仅 5 个文件有 ~24 处硬编码色值。图表配色已用 dataviz skill 的 validator 预验证通过。

## 1. 新 Token（`src/index.css` 重写，已算好 WCAG 对比度）

```css
@theme {
  --color-ink: #f4f1e8;      /* 页面底色（保留原名，diff 最小）*/
  --color-panel: #ffffff;    /* 卡片 */
  --color-panel-2: #f6f3ea;  /* 嵌套面 / hover */
  --color-line: #e3ded1;     /* 边框 */
  --color-fg: #211f1a;       /* 新增：近黑正文，替换 html color 和 34 处 text-white */
  --color-accent: #9e2b3a;   /* 酒红（白底 7.34 AAA）*/
  --color-accent-2: #6d28d9; /* 深紫（注意力/KV 可视化）*/
  --color-ok: #166534;       /* green-800，其 /20 浅底上仍 5.20 过 AA */
  --color-warn: #92400e;     /* 深锈色，/10 浅底上 5.38 过 AA */
  --color-bad: #d92d20;      /* 亮红，与酒红 ΔE 12.5 可区分 */
  --color-dim: #6e6a60;      /* 次要文字，米白底 4.78 过 AA */
  --color-amber: #d97706;    /* 新增：token 化第 4 强调色（仅图形用）*/
}
html { background: var(--color-ink); color: var(--color-fg); color-scheme: light;
       accent-color: var(--color-accent); /* 10 个 range 滑块自动变酒红 */ }
::selection { background: color-mix(in srgb, var(--color-accent) 20%, transparent); }
/* 滚动条 thumb 改 #cfc8b7（--color-line 在米白上 1.19 会隐形）*/
```

可选：`index.html` 加 `<meta name="theme-color" content="#f4f1e8">`。

## 2. Token 换掉后仍会坏的点（完整清单）

- **`text-white` ×34（10 文件）**：强调文字 → `text-fg`。MasteryDashboard:42,43,50；AskDialog:42,53；MemoryCalculator:62,72,82,124；EconomicsPanel:72,82,96,100；LifecycleSim:129,139,149,167,182,190。`hover:text-white` → `hover:text-fg`（App:26、AskDialog:153、InterviewPage:235；AskDialog:198 的「去设置」改 `hover:text-accent`）。**保留** text-white 的：实心酒红填充上（3 个主按钮、分段控件 active、logo 块、内存条 seg、成绩实心徽章）。
- **霓虹光晕（浅色下必删）**：TransformerDiagram:20 与 LifecycleSim:216 的 `shadow-[0_0_1Xpx_rgba(91,141,239,…)]` → `border-accent bg-accent/10 shadow-sm`；LifecycleSim:226 脉冲点去 glow，:228 `bg-accent/60` → `/40`。
- **`bg-ink` 当"更深底"用**：AskDialog:35 行内 code、:79 代码块 → `bg-panel-2`（代码块加 `border border-line`）。
- **硬编码色值**：QKVFlow.tsx 15 处 SVG fill/stroke → `var(--color-*)`（映射见 §5）；EconomicsPanel:18-21 四常量 + :148 tooltip（见 §4）；MemoryCalculator:116 `bg-[#d97706]`（见 §3）。
- **浅色下失效的对比**：InterviewPage:12-17 `GRADE_STYLE` 浅底徽章 12px 加粗过不了 AA → 改实心：`A: bg-ok text-white / B: bg-accent text-white / C: bg-warn text-white / D: bg-bad text-white`（也更贴近参考图的实心 chip）；InterviewPage:223 录音中态 `bg-bad/20 text-bad` → `bg-bad text-white`；MasteryDashboard:65 进度条轨道 `bg-panel-2` → `bg-line`（白卡上米白轨道隐形）。
- **文案指涉旧颜色**：ModelEvolution:21 「蓝色标签」→「红色标签」；QKVFlow:136 「蓝/紫点」→「红/紫点」；再 grep `蓝` 扫 `src/data/*.ts`。
- **表格斑马纹**：ArchitecturePage:55,90 `bg-panel/50` 米白页上太弱 → `i % 2 ? '' : 'bg-panel-2/60'`，表格容器 (:43,:70) 加 `bg-panel shadow-sm`。

## 3. 组件级改造（对齐参考图设计语言）

- **App.tsx 头部**：sticky 米白 blur 保留（浏览器验证若发闷则退回实色）；品牌 = 酒红方块 logo 块（`h-6 w-6 rounded-md bg-accent text-white` 内白色 "L"）+ `text-fg` 站名；**导航 pill → 红色下划线 Tab**：active `border-b-2 border-accent text-accent font-medium`，inactive `border-transparent text-dim hover:text-fg`。
- **新建 `src/components/ui/SegmentedTabs.tsx`**（分段控件，参考图 DAILY/WEEKLY/MONTHLY 样式）：容器 `inline-flex gap-1 rounded-lg border border-line bg-panel p-1 shadow-sm`，active 段 `bg-accent text-white`，inactive `text-dim hover:bg-panel-2 hover:text-fg`。API：`{ tabs, value, onChange }`。替换 ArchitecturePage:21-33 与 InferencePage:21-33 的重复 Tab 条，以及 TransformerDiagram:36-49 的 decoder 切换。
- **按钮**：主按钮已是 `bg-accent` 白字（LifecycleSim:196、InterviewPage:231、AskDialog:231），hover 调 `/90`；次按钮 = 白底描边（InterviewPage:218 麦克风、AskDialog:221 停止 → `border border-line bg-panel hover:bg-panel-2`）。
- **卡片软阴影**：全仓把类串 `rounded-xl border border-line bg-panel ` 追加 `shadow-sm`（注意保留尾随空格防止误伤 `bg-panel-2`，~15 处）；手补 EconomicsPanel:172、ModelEvolution:29 两处动态边框卡。`bg-panel-2` 嵌套面不加阴影。
- **MemoryCalculator 内存条**（seg() 47-55, 114-118，白字须站得住）：权重 `bg-accent`(7.34)、KV cache `bg-warn`(#92400e, 7.09, 替换 `bg-[#d97706]`)、开销 `bg-dim`(5.39, 替换 `bg-line`)。
- **Ask 功能只改样式，行为冻结**：SelectionAsk:234 浮动按钮 → 白 chip `bg-panel shadow-md`；AskDialog:130 `shadow-2xl`→`shadow-xl`。**不得动** `data-ask-ui` 属性（AskDialog:126、SelectionAsk:229）、拖拽逻辑、选区排除逻辑（SelectionAsk:78-99）。
- **InterviewPage**：题目 active 态 `border-accent/60 bg-accent/10` 恰是参考图粉底选中态，保留；评分条酒红填充 + `bg-line` 轨道，保留。

## 4. EconomicsPanel 图表（recharts，dataviz 已验证）

改 4 个常量（:18-21）+ 1 处内联（:148）：
```ts
const API_COLOR = '#9e2b3a'   // 酒红
const SELF_COLOR = '#0d9488'  // teal-600（注意：#0f766e 验证 FAIL 彩度不足，勿用）
const INK_MUTED = '#6e6a60'
const GRID = '#e3ded1'
```
Tooltip contentStyle → 白底 `#fff` + `1px solid #e3ded1` + 圆角 8 + 软阴影 + `color:#211f1a`。
实施时必跑 validator（要求全 PASS，已预跑通过）：
```
node /private/tmp/claude-501/bundled-skills/2.1.220/eebde141b0f793b8c263fecd1088c88f/dataviz/scripts/validate_palette.js "#9e2b3a,#0d9488" --mode light
```

## 5. QKVFlow SVG 映射（属性内直接用 CSS 变量，最小改动）

`#1a2340`→`var(--color-panel)`；`#2a3558`→`var(--color-line)`；`#e6eaf5`→`var(--color-fg)`；`#8b96b5`→`var(--color-dim)`；`#5b8def`→`var(--color-accent)`；`#5b8def33`→`fill="var(--color-accent)" fillOpacity={0.12}`（8 位 hex alpha 与 var 不兼容）；`#8b5cf6`→`var(--color-accent-2)`；`#d97706`→`var(--color-amber)`。动画 props 不动。

## 6. 实施步骤（专职 subagent 交付，文件所有权无冲突）

实施代理可用 fable/opus5/sonnet5；E2E QA 代理用 fable5 以外的模型。

- **Step 1（Agent A，先行落地）**：`index.css`、`index.html`、`App.tsx`、新建 `SegmentedTabs.tsx`、`ArchitecturePage.tsx`、`InferencePage.tsx`、`SettingsPage.tsx`；并一次性执行全仓卡片阴影替换（B/C 在已替换的文件上工作）。Gate: `npm run typecheck && npm test`。
- **Step 2（Agent B，与 C 并行）**：`TransformerDiagram`、`QKVFlow`、`ModelEvolution`、`StackExplorer`、`MemoryCalculator`、`EconomicsPanel`（含 validator 运行）。Gate 同上。
- **Step 3（Agent C，与 B 并行）**：`InterviewPage`、`AgentPage`（纯验证）、`MasteryDashboard`、`LifecycleSim`、`AskDialog`、`SelectionAsk`。Gate 同上。
- **Step 4（QA agent，非 fable5）**：`npm run dev` (5173) + claude-in-chrome 浏览器逐页走查 + 真实 LLM API 打通 Ask 流；P0/P1/P2 报告，修复循环直到 0 P0/P1。
- 残留检查 grep：`text-white` 仅剩白名单实心填充位；`shadow-\[` 为空；旧 hex（5b8def|8b5cf6|131a2e|1a2340|2a3558|8b96b5|e6eaf5）为空；`d97706` 仅剩 index.css。

## 7. 风险点（QA 走查重点）

1. 酒红 accent vs 亮红 bad：不会同场景做序列色，文字场景有上下文，浏览器确认不混淆。
2. sticky 头部米白 blur 与页面同色可能发闷 → 备选实色 `bg-ink` 或白 `bg-panel/90`。
3. `::selection` 粉色须足够醒目（Ask 圈选入口反馈），且在粉底选中卡内选字仍可辨。
4. 焦点环：必要时全局补 `:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px }`。
5. `text-warn` 新锈色要确认仍读作"警示"而非"棕"。
6. 批量替换附带命中（AgentPage 元素块、题目列表项等吸到 shadow-sm）可接受，但 review diff 确认无重复追加。

## 8. 验证（逐页浏览器走查）

- **/architecture**：米白头部+酒红 logo 块+红下划线导航；分段控件；Transformer 图无 glow、粉底选中；QKV 动画（酒红 K/紫 V/琥珀权重条）；模型演进红色标签；两张白底表格斑马纹清晰。
- **/inference**：四层配色可读；生命周期模拟跑一遍（active 粉底无 glow、滑块酒红、锈色警示条）；显存墙拉 context 到 1M 触发 KV 警告、内存条三段白字可读；Token 经济图酒红/teal 双线、白底 tooltip、展开案例卡。
- **/agent**：五要素粉底 active、编排卡、红色 pitfall 标题。
- **/interview**：完成一次评分：仪表盘数字 `text-fg`、实心成绩徽章、酒红评分条；麦克风白底描边、录音中实红。
- **/settings**：白卡表单、输入可读。
- **Ask 流（任意页）**：圈选 → 粉色高亮 + 白色 Ask chip → 白底对话框可拖拽、引用卡、流式回答 markdown（粗体 ink、行内 code 米白 chip）；无 key 时红错误行 + 去设置；输入框内圈选不出按钮。
- 全局：滚动条 thumb 可见、无残留深蓝闪现。

## 交付日志

- [x] Step 1 基础层 + 站点骨架（Agent A）
- [x] Step 2 架构/推理可视化组件（Agent B）
- [x] Step 3 面试/Agent/Ask 界面（Agent C）
- [x] Step 4 E2E QA 走查 + P0/P1 清零

## QA 结论（2026-08-01）

浏览器（端口 5180，5173 被其他项目占用）+ 真实 API（DeepSeek 评分回路、Ask 流式问答）全量走查：**0 P0**。§7 全部风险点逐一核验未成为阻塞（头部 blur 清爽、焦点环在、粉底选中可辨、accent/bad 语境可区分）。

**P1 处置（均为 0e821e5 既有缺陷，非改版回归）：**
1. Ask 对话框"不可拖拽" → **误报**。QA 标签页处于 hidden 状态，Chrome 暂停 rAF，framer-motion 帧循环停摆导致零位移。可见标签页中实测拖拽正常（位移 200px 且落点保持）。经验：浏览器 QA 动画/手势断言前必须确认 `document.visibilityState === 'visible'`。
2. QKVFlow 琥珀权重条不可见 → **真实缺陷，已修**：motion SVG 的 `animate.y` 是 transform 而非属性（叠加后被 viewBox 裁掉），且 `times` 未覆盖 0→1 导致动画冻结。改用 `attrY` + 完整 times；同病因的 act-3 输出圆圈（scale 冻结为 0）一并修复。浏览器复验：四条琥珀条随周期升起，h+y≡112 基线锚定。

**遗留 P2（不阻塞，择机处理）：**
- 掌握度图例 A/B/C/D 中 B/C/D 三色同为红系小圆点（有字母标注缓解）。
- 显存条极端值（1M context）下窄段白字被截断（「权重 70」→「重 70」）。
- TransformerDiagram 的分段控件因长标签换行成两行，观感似两个按钮。
- liteMd 不解析加粗内嵌行内代码（流式回答中偶现反引号字面量）。
- `--color-warn` 深锈色单看偏棕（各使用点均带 ⚠ 前缀缓解）；粉底卡内文字选区对比偏低。
- ~~滚动条 thumb 偏浅~~ 已修（#cfc8b7 → #bfb7a3）。
