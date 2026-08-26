# 推理 KPI 工作台 — P0/P1 修复与优化计划

## Context

推理 KPI 工作台(AIPerf 导入 / KPI 引擎 / Sizing 推导)已实现并集成到 `/#/inference` 首位 tab,typecheck 与 958 个测试全绿、页面运行无报错。三路深度代码审查(导入管线 / 引擎与注册表 / UI 与集成)确认了 **4 个 P0 + 19 个 P1**:P0 全部是"静默产出错误数据或错误结论"类缺陷;P1 集中在公式对不上账、Sizing 假验证、共享场景状态被副作用覆盖、估算值无标记这四类。用户已确认:**P0 + 全部 P1 全修,且两处架构欠账(MetricObservation 未接入引擎、注册表公式非唯一事实源)本次一并重构**。

审查亮点(无需改动):Goodput 只读不推算的四道防线、单位以文件为权威、未知单位返回 null 不猜、核心公式(E2E/Little's Law/$·MTok/Sizing ceil)逐条核对正确、导入数据不持久化完全达标。

## 实施方式

- 按 [[feature-delivery-workflow]]:先在项目根新建 `PLAN-kpi-p0p1-fixes.md` 落盘本计划(不覆盖已交付 plan 文档),实施用专职 subagent 分批次进行,批次间跑全量测试。
- 修复顺序按依赖排:导入层 → 引擎层 → UI/状态层 → 测试补齐。

---

## 批次 1:导入管线(src/lib/aiperfImport.ts)

### P0-A `parseScalar` 类型推断顺序(一处修复解掉 2 个 P0)
`aiperfImport.ts:277-284`:先 `toFiniteNumber` 再 `asBoolean`(或 `asBoolean` 只认 true/false/yes/no)。修复后:
- CSV `Successful Runs,0` 正确触发 `zero-successful-runs` 错误(现在 `"0"`→`false`→检测永不成立,`:1245`/`:1365`)
- sweep 坐标 `concurrency=1` 不再变成 `true`,Sweep 图不再消失(metricUi.ts:272 的 `every(number)` 检查)、JSON/CSV 跨格式去重恢复(`buildSweepPointKey:506-523`)、variation 展示恢复
- `:1245`/`:1365` 改用从 metadata 原始文本取数的取值器,不依赖推断类型

### P0-B CSV 类型识别顺序
`aiperfImport.ts:1494-1497` + `:1063-1073`:`isConfidenceCsv`/`isProfileCsv` 提到 `isSweepCsv` 之前;`isSweepCsv` 宽表判定只在表头行做(要求同一行 ≥2 个 `sweepCsvColumn` 命中且全为非数值文本),或要求 `Metadata`/`Pareto Optimal Points`/`Best Configurations` 分节标记。现在 tag 式指标名(`request_throughput_avg`)的 confidence/profile CSV 会被误判为 sweep 且指标全丢。

### P1(导入)
1. **纯数字 benchmark_id 丢失**(`:1237-1239`, `:1298-1299`):新增 `asIdentifier()` 把 finite number/boolean 还原为原始文本,否则数字 ID 的 CSV 永远关联不上 server metrics,`buildRunKey:496` 也退化。
2. **跨文件单位冲突静默**(`mergeNormalizedMetric:1594-1609`):单位不兼容时产出 `conflicting-metric-unit` 警告并把该指标 `available:false`,对齐 sweep 路径已有的 `sweepMetricConflicts:1698-1712`。
3. **未知 1.x 顶层块致命**(`:379-392` + `:394-412`):`validateMetricUnits` 按 `metric.unknown` 分流——已知 tag 缺 unit 仍是 error,未知块缺 unit 走 `quarantineUnitlessTelemetry:420-439` 同款降级(warning + `available:false`),满足"忽略未知字段"。同步修改 `aiperfImport.test.ts:80-83` 已固化的错误断言。
4. **trial/variation 哨兵混淆**(`buildRunKey:489-504`):`trial=${trial ?? 'none'}`、`variation=${variation ?? '__none__'}`,防止跨 trial 聚合与单次 run(trial=0)合并后统计口径混杂。
5. **负值零校验**(`toFiniteNumber:262-267` 下游):对 `KNOWN_METRIC_TAGS` 的计数/速率/延迟类加 `negative-value` error,ratio/percent 超界降级 `available:false`,未知 tag 只 warning。
6. **任意 stat 兜底**(`metricUi.ts:85-89`, `:149-154`):删掉 `Object.values(stats).find(Number.isFinite)` 兜底(会把 std 当 p95 展示),取不到明确统计量返回 null 走已有 N/A 通路。

---

## 批次 2:引擎/诊断/注册表(kpiEngine.ts、inferenceKpis.ts)+ 架构重构

### P0-C 抢占累计计数器误读
`BenchmarkAnalysis.tsx:682-695` + `kpiEngine.ts:389-402`:vLLM `num_preemptions_total` 是进程级单调 counter,现在被当"采样窗口抢占计数"用 `>=10` 判 critical,证据文案是事实性错误。修法:识别 `_total`/counter 语义时拒绝作窗口值,无法取得窗口差分(两个采样点)则返回 null 抑制该规则;`DiagnosticSnapshot` 字段改名 `preemptionCountInWindow` 明确契约。

### 架构重构(用户已确认本次做)
1. **注册表成为唯一事实源**:UI 删除内联成本公式(`SizingDerivation.tsx:142-147`),改调 `kpiEngine.costPerMillionOutputTokens/costPerGoodRequest`;把「有效利用率」写进注册表 `cost-per-mtok` 的 `formula` 与 `formulaDependencies`(`inferenceKpis.ts:588`)并让引擎函数收该参数——消除当前 2.5 倍对不上账。同步修 `formulaDependencies` 与公式字符串不同步(`:588-589`, `:606-607`)。
2. **MetricObservation 接入引擎**:`DiagnosticSnapshot`/`SizingInput`(`kpiEngine.ts:243-269`, `:539-549`)从裸 `number|null` 改收 `MetricObservation`(至少 `{value, kind, unit}`);引擎入口对 `kind !== 'measured'` 的输入拒绝进入 `sloValidated` 路径;`BenchmarkAnalysis.tsx:709` 把场景假设 cacheRate 与实测命中率混送 snapshot 的问题随之显式化。

### P1(引擎)
3. **Sizing 门禁未比对 run 的 --goodput SLO**(`SizingDerivation.tsx:102-110`, `:266-267`):用 `fingerprintFor(run).slo`(BenchmarkAnalysis.tsx:181 已解析)与 `scenario.slo` 逐键比对,run SLO 必须不宽于场景 SLO,不一致直接禁用 measured 路径并列出差异项;`fingerprint.gpuCount` 与 `scenario.gpusPerCapacityUnit` 自动比对。这是"绿色 SLO 已验证"可信度的根基。
4. **饱和判定混用 E2E/TTFT**(`kpiEngine.ts:327-330` 与 `metricUi.ts:384-389` 两份拷贝):先选定两端都存在的同一延迟指标再比较,不同则 `latencyWorsened=false`;两份实现合并为一处(metricUi 调 kpiEngine)。
5. **排队规则硬编码阈值**(`kpiEngine.ts:356-363`):删 `>=100ms`/`>=10` 绝对阈值,改用"排队占 TTFT 预算(`ttftTargetMs` 优先)比例"相对判据,severity 同样相对化。
6. **单用户 tok/s / E2E 从不展示**(`metricUi.ts:7-23`、`BenchmarkAnalysis.tsx:47-54`):`METRIC_ALIASES` 增加 `perUserTps: ['outputtokenthroughputperuser']`,加进 `METRIC_CARDS`;实测 TTFT/TPOT 齐备时用 `estimateE2ELatencyMs` 做估算 vs 实测交叉校验展示。
7. **P2 顺手修**(同文件小改):`deriveCapacityMetrics:141` 空窗口 0/0 返回 null 而非 0%;`serializeSlo:197-205` 空对象显式返回 null;`calculateSizing:581` 的 `gpusPerUnit ?? 1` 隐藏默认改为缺失返回 null(对齐 server/rack 行为);`cache-hit-gap` 的预期命中率改用独立、默认 null 的 `expectedPrefixHitRate` 字段(不再借用 `cacheRate=0.7`)。

---

## 批次 3:UI / 共享场景状态

### P1(状态与联动)
1. **分数容量单元**(`EconomicsPanel.tsx:56`):`clusterTps = Math.floor(gpuCount / gpusPerCapacityUnit) * capacityUnitTps`;不足一个单元走 `!valid` 分支提示"卡数不足一个容量单元(需 N 卡)",余数卡标"不成单元不计入产能"。(引擎/UI 两路审查共同点名,输出错误成本结论。)
2. **useEffect 静默覆盖**(`MemoryCalculator.tsx:63-67`、`LifecycleSim.tsx:100-105`):副作用写入改为显式按钮「同步 N 卡/单元 + roofline TPS 到场景」;或仅在 `systemTpsFingerprint === null` 时自动写。同时保护 `measurementConfirmationKey` 不被无谓作废。
3. **KV 口径统一**(`LifecycleSim.tsx:78-86` vs `MemoryCalculator.tsx:51-59`):LifecycleSim 的 `estStepMs` 改用 `inputTokens + outputTokens`(其 `memoryBreakdown:74` 已是此口径),消除两 tab 写入互相矛盾的 systemTps。
4. **估算/手填来源徽标**(`store.ts:128` 的 `systemTpsSource` 目前零消费——直接违反三源区分需求):`SizingDerivation.tsx:182` TPS 输入旁按来源渲染 StatusBadge「公式估算(roofline)/手工输入」;`EconomicsPanel.tsx:184-186` 有效态提示带来源;`costPerMTok` badge 文案注明"基于公式估算吞吐"。
5. **tab 切换状态丢失**(`InferencePage.tsx:29-40` 条件渲染卸载):把 `view`(`InferenceKpiWorkbench.tsx:23`)与 `confirmedMeasurementKey`(`SizingDerivation.tsx:96`)提升到 `kpiUiStore`(仍是会话内存,不违反不持久化要求)。
6. **run 标签与并排承诺**(`metricUi.ts:366-370`、`BenchmarkAnalysis.tsx:193/449/566-580`):`getRunLabel` 在 variation 缺失时回退 `run.sourceNames[0]`;不可比 reason 结构化并用 `run.key` 组合做 React key(消除 duplicate key);「仅并排展示」文案改为「不下比较结论」(真正的并排指标表列入后续,不在本次范围)。
7. **百分比浮点垃圾**(`SizingDerivation.tsx:184/209-215/335`):渲染侧 `Math.round(x*1000)/10` 或 setter 归一,消除 29→28.999999999999996。
8. **换 GPU 主图消失**(`EconomicsPanel.tsx:146-152`):失效警告块内加「按当前模型/GPU/量化重算 roofline TPS」按钮,调用与 MemoryCalculator 相同的 `estStepMs/tokensPerSecond` + `setSystemTps(...,'estimated')`。
9. **P2 顺手修**(同文件小改):`apiCostPerOutputMTok ?? 0` 改保持 null 显示 N/A(`EconomicsPanel.tsx:69`);`DiagnosticsPanel` 改 `useInferenceScenario((s)=>s.slo)` 订阅(`BenchmarkAnalysis.tsx:598`);单 run 时对比面板改中性态;`SegmentedTabs` 两个调用点补 `ariaLabel`。

---

## 批次 4:测试补齐与验证

### 新增测试(修复的回归防线)
- `parseScalar` 表驱动单测("0"/"1"/"2"/true/yes 等边界)
- CSV 用例改用真实 AIPerf tag 命名(`time_to_first_token_avg`/`request_latency_p99`)——现有用例全用人类可读名,正是 P0-B 逃逸原因
- `Successful Runs,0` 的 CSV 用例(现有 `:493` 是假通过);`concurrency=1` 起点的 sweep;纯数字 benchmark_id;同 run ms vs s 单位冲突;负值指标
- Sizing 门禁:run SLO 宽于场景 SLO 时拒绝 measured 路径
- 抢占 counter:`_total` 指标不触发窗口规则
- `toSweepChartPoints`/`paretoKeys` 字段映射(当前零覆盖)
- 测试数据外提 `src/lib/__fixtures__/aiperf/`(仿照 `src/lib/paper/fixtures` 先例)

### 验收
1. `npm run typecheck`、`npm test` 全绿
2. flag-on / flag-off 两种 `npm run build`
3. 浏览器 E2E(按 [[feature-delivery-workflow]] 用 codex CLI QA):导入 tag 命名 CSV、concurrency=1 sweep 出图、零成功运行报错、Sizing 门禁在 SLO 不一致时禁用、显存墙往返不再覆盖手填值且勾选不丢、Token 经济 1 卡 <1 单元时不出成本结论;390/768/1440px 复验
4. 修完后 P0/P1 清零或按约定最多 3 轮修复循环;README/EXTENDING 若行为描述受影响则同步更新

## 不在本次范围(留档)
- 多 run 真正的并排指标表视图
- 图表可读性/a11y 其余 P2(轴 label、线型区分、Pareto 图上标记、tabpanel ARIA、移动端详情就地展开)
- `estimatedRpsPerUnit` 计入 prefill 时间(方向性估算的高估修正)
- 性能类 P2(KpiDictionary memo、双 set 合并、importFiles 请求序号)
