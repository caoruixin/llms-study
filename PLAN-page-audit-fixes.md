# llm-pro.cn 四页问题审计与修复方案（/agent /inference /interview /kda）

## Context

对 https://llm-pro.cn 的四个页面做了代码审查 + 真机浏览器验证（含实际提交一次面试评分）。结论：

- **/kda 质量最高**，仅少量健壮性问题；**/agent 最薄**，且页面标题公开暴露「JD 原文」私人语境；
- **/inference 三个面板参数互相打架**（这正是 PLAN-kda-demo.md 里诊断过但只在 /kda 修掉的老毛病）：生命周期模拟 batch=16 / 缓存命中 70% / DeepSeek-V3，显存计算器 batch=8 / Llama 3 70B，Token 经济缓存命中 60%——同一个问题切个 tab 答案就变；
- **/interview 评分链路在线上实际可用**（实测得分 D 3.2/10，服务端 nginx 代理了 DeepSeek API）——但这意味着 `/api/deepseek` 是一个无鉴权的公开 LLM 代理，任何人可烧掉 API 额度；同时设置页文案仍是「编辑 .env.local 重启 npm run dev」的本地开发口径，对线上访客是错的；
- 若干事实性/展示性硬伤：models.ts 把 DeepSeek-V3 写成 567B（同条目其他字段是 671B）；经济学图表自建成本线水平延伸远超「集群日产能 173 MTok/日」，视觉上宣称无限产能；面试题的 redFlags 喂给了评分器、却从不展示给用户（被扣分却看不到红线）。

用户决定：修 **P0+P1**（P2 打磨留档不做）；/agent 标题**去掉 JD 原文措辞**；**包含**服务端 nginx 限流。

## P0 — 访客可见的硬伤

1. **/inference 三面板参数统一**：在 `src/store.ts` 新增共享 slice `useInferenceParams`（model/gpu/quant/batch/cacheRate），`LifecycleSim.tsx`、`MemoryCalculator.tsx`、`EconomicsPanel.tsx`（其 cacheRate）改为消费同一份状态；tps/时租等面板专属参数保留本地。
2. **models.ts 事实错误**：`src/data/models.ts:63`「567B 模型」→ 671B（对齐同条目 :68/:72）。
3. **/interview 听写吞 interim 文本 bug**：`InterviewPage.tsx:211-212` textarea value 拼接 interim 且 onChange 整体写回 → 编辑时把临时识别文本连带空格永久写入。改为 textarea 只绑 `answer`，interim 用只读预览条展示在 textarea 下方。
4. **展示 redFlags**：参考要点面板（`InterviewPage.tsx:242-263`）补「红线（答错即扣分）」区块——评分器已在用它们（`grading.ts:74`），用户必须看得到。
5. **设置页文案改线上口径**（`SettingsPage.tsx:37,46-51`）：留空 = 走站点默认代理（服务端注入 key）；粘贴自己的 key 走 X-User-Key；`.env.local`/`npm run dev` 一段限定为「本地开发时」。
6. **经济学图表与产能自洽**（`EconomicsPanel.tsx:55-62,155`）：自建成本改阶梯式 `日成本 × ceil(负载/产能)`（与卡片文案「超出需加副本、成本阶梯上移」一致），并画出产能上限参考线。
7. **/agent 标题去 JD**：`AgentPage.tsx:25`「（JD 原文：…）」删除，保留五要素本体。
8. **显存计算器量化/H20 一致性**（`MemoryCalculator.tsx:34,138`）：TTFT 按所选量化取对应算力（数据缺失时按 FP8 标注清楚）；H20 的 `N/A` 补充 LifecycleSim 已有的解释文案（`LifecycleSim.tsx:115` 同款）。

## P1 — 健壮性

9. **ErrorBoundary**：`App.tsx` 每个 Route 包一层，数据漂移只废一页不白屏；`src/data/kda.ts:657` 的模块级 throw 移入组件/selector 层（`probe`/`asDelta` 的 render 期 throw 保留，由 boundary 接住）。
10. **EconomicsPanel 默认价目脆弱**（`:26,47`）：默认 priceKey 从过滤后列表第一项推导；`price` undefined 时兜底而非崩。
11. **时租输入守卫**（`:96`）：清空输入不再得出 $0.00/MTok（对齐 `:100` tps 的 `Math.max` 处理）。
12. **面试历史**：`store.ts:93` persist 数组加上限（如每题保留最近 20 条）；用已有但未接线的 `clear`（`store.ts:86,94`）加「清空历史」按钮。
13. **限时价到期**：`pricing.ts:104`（$2/$10 至 2026-08-31，仅剩 3 周）及依赖它的 `cases.ts:76` ROI 案例——价目加 `validUntil`，过期后 UI 自动标「已过期，见 sourceUrl」。`pricing.ts:223`「限时 5 折」补时限或删限时措辞。
14. **moe 哨兵值**（`models.ts:111,302,326,358`）：`{experts:0}` → 字段改可选/null，`KdaNetwork.tsx:32` 的 truthy 守卫恢复正确（消除潜在「0 专家选 0」）。
15. **store 默认模型过时**（`store.ts:46`）：`gpt-5.5` → 对齐 `pricing.ts` 现有条目。
16. **听写自动重启加退避上限**（`InterviewPage.tsx:76-97`）。
17. **显存条百分比溢出**（`MemoryCalculator.tsx:47-55`）：`Math.max(2,pct)` 逐段下限导致总和可 >100% → 归一化。
18. **/agent 条件边按索引标注**（`AgentPage.tsx:112`）：`GRAPH_NODES` 加 `kind` 字段，去掉 `i === 1`。
19. **agent.ts 补数据规范**：唯一无 `sourceUrl/asOf` 的数据文件（违反 PLAN.md:24 自定规则）——「10~50 倍」等量级断言补来源或降级为「数量级示意」；`data/agent.ts:31` Kimi K3「原生多模态」措辞对齐 `pricing.ts:169` 的保留口径。

## 服务端（ssh llm-pro）

20. **/api/deepseek 限流**：nginx 加 `limit_req_zone`（按 IP，约 6r/m burst 3）+ `limit_conn`，保护 API 额度。改配置前先备份现行 conf；`nginx -t` 通过再 reload。

## 不做（P2 留档）

/interview 侧栏 390px 无响应式、最佳成绩逻辑双实现、评分阈值文案双份、历史仅显示 5 条、/agent 手写 JSX 架构图数据化、LifecycleSim 固定假输出、simEngine GB 口径、KDA ratioNote 派生化、日期字符串与 asOf 去重。

## 交付方式（按既有工作流）

- 批准后：方案存为项目内新文件 `PLAN-page-audit-fixes.md`；开 feature 分支。
- 实现交给专职 impl subagent；QA 用非 fable5 的 qa agent 跑 E2E（浏览器 + API）修复循环直到 0 P0/P1。浏览器 QA 注意 hidden-tab rAF 陷阱（先断言 visibilityState）。
- 验证：`npx vitest run`（现有 123 个引擎/数据一致性测试必须全绿，models.ts 671B 修正可能牵动 kda 一致性测试）+ `npm run build`；dev server 逐页浏览器复查 8 个 P0 点。
- 部署：build + tar 管道原子切换到 llm-pro（`/var/www/llms-study`），随后同一会话做 nginx 限流；勿碰 rkb-ecs。
