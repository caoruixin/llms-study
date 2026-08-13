# 面试陪练：历史记录三级清理 + 评分体验改造

## Context

线上 https://llm-pro.cn/#/interview 面试陪练页两项改造：

**一、历史清理三级粒度。** 历史回答记录存在 localStorage（zustand persist，key=`llm-infra-history`）。当前清理只有一档：卡片右上角按钮一次清掉**所有题目**记录，且入口只在"当前题有历史"时可见。扩展为：① 清空所有题目 ② 清空当前题目 ③ 删除单条记录。已确认：历史卡片改为常驻（任何题有历史即显示）；单条删除用两段式确认。

**二、评分模块调整。** 现状问题：(a) 用户常用语音转文本作答，转写错误（同音字、英文术语误转）被刻板判为"没理解到位"；(b) 语义相同但措辞不同的表述被判为"没覆盖"；(c) system prompt 明确写「宁严勿松」，输出只有 comments/missed 两类，无亮点识别，负面反馈过多、分数系统性偏低，答题者持续受挫。目标：评分者变为积极评价者——先识别亮点、基础分+扣减的打分心智、语义等价即算覆盖、语音转写错误不扣分。**用户补充强调**：语气积极 ≠ 报喜不报忧——「遗漏要点」输出必须保留，对遗漏的**关键点**知无不言，但要专业克制、不事无巨细；点评的完整性标准：亮点 + 改进建议 + 遗漏要点合起来构成一条清晰的改进路径，把指出的问题都解决后，该回答应能达到面对真实客户拿 90–95 分的水平。

**三、参考答案优化。** 现状 `referenceNotes` 是一段密集连排文字，学习者抓不住主线。重写为「主线 + 结构化展开」格式：先一句话主线（回答骨架/抓手），再按结构分条展开关键点——学习者照主线作答至少及格、展开到位即良好。

无后端参与。不引入新依赖。

---

## Part 1：历史记录三级清理

### 改动 1.1：`src/store.ts`（114–139 行区域）

**扩展 `HistoryState`**，新增两个 action（实现各一行 filter，`clear` 不动）：

```ts
removeAttempt: (id) => set((s) => ({ attempts: s.attempts.filter((x) => x.id !== id) })),
clearQuestion: (questionId) =>
  set((s) => ({ attempts: s.attempts.filter((x) => x.questionId !== questionId) })),
```

store 保持不依赖 data 层（questions）。

**新增导出 `newAttemptId()`**，修复 id 撞车隐患。现状 `id: \`${Date.now()}\``（InterviewPage.tsx:138）是纯毫秒时间戳，同毫秒重复——既是按 id 删除的正确性隐患，也是 React key 冲突隐患。沿用仓库现有惯例（参照 `src/lib/paper/repo/paperRepo.ts` 的写法）：

```ts
export const newAttemptId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
```

**persist 迁移去重**：options 升级为 `version: 1` + `migrate`（zustand 存量默认 version 0，升级自动跑一次）：

```ts
{
  name: 'llm-infra-history',
  version: 1, // v1：旧记录 id 为纯毫秒时间戳可能重复，迁移时对重复/缺失 id 重新生成
  migrate: (persisted) => {
    const s = persisted as { attempts?: AttemptRecord[] }
    const seen = new Set<string>()
    const attempts = (s?.attempts ?? []).map((a) => {
      if (!a.id || seen.has(a.id)) return { ...a, id: newAttemptId() }
      seen.add(a.id)
      return a
    })
    return { attempts }
  },
}
```

注意 zustand v5 `migrate` 入参是 `unknown`，需一次 `as` 断言，别破坏 `tsc --noEmit`。

### 改动 1.2：`src/pages/InterviewPage.tsx`

**id 生成替换**（138 行）：`id: \`${Date.now()}\`` → `id: newAttemptId()`（从 `../store` 导入）。

**确认状态重构**（替换 37 行 `confirmClear`）：三个删除动作共用一个"待确认目标"，同一时刻只有一个按钮处于确认态；沿用现有两段式（首次点击变红、onBlur 取消、再次点击执行）：

```ts
type ConfirmTarget = { kind: 'all' } | { kind: 'question' } | { kind: 'one'; id: string }
const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null)
const [showAllHistory, setShowAllHistory] = useState(false)

function confirmThen(target: ConfirmTarget, run: () => void) {
  const same =
    confirmTarget?.kind === target.kind &&
    (target.kind !== 'one' || (confirmTarget as { id?: string }).id === target.id)
  if (same) { run(); setConfirmTarget(null) }
  else setConfirmTarget(target)
}
```

`selectQuestion()`（58 行）追加 `setConfirmTarget(null)` 和 `setShowAllHistory(false)`。43 行改为解构 `{ attempts, addAttempt, clear, clearQuestion, removeAttempt }`。

**历史卡片重构**（341–374 行）：

- 外层条件 `pastAttempts.length > 0` → **`attempts.length > 0`**（卡片常驻，清空全部入口始终可达）。
- 头部右侧两个小按钮并排（复用现有按钮类名：确认态 `border-bad/60 bg-bad/10 text-bad`，常态 `border-line text-dim hover:text-bad`）：
  - 「清空本题」→ 确认态「确认清空本题？」→ `clearQuestion(selectedId)`；仅 `pastAttempts.length > 0` 时渲染
  - 「清空全部题目」→ 确认态沿用「确认清空？（全部题目）」→ `clear()`
- 本题无历史时列表区显示占位：`本题暂无历史记录（其他题目共 {attempts.length} 条）`。
- 每条记录行末尾加 `✕` 按钮：常态 `text-dim hover:text-bad`，确认态红色小胶囊「确认删除？」，onBlur 取消 → `removeAttempt(a.id)`。
- **解除 slice(0,5) 限制**：默认显示 5 条，超过时底部「展开全部 N 条 / 收起」（`showAllHistory`），否则第 6~20 条无法单条删除。每题上限 20 条，无性能顾虑。切题自动收起。

`src/components/MasteryDashboard.tsx` 零改动：从同一 attempts 派生，自动重算/隐藏。

---

## Part 2：评分模块调整

### 改动 2.1：`src/data/types.ts` — `ScoreResult` 增加亮点字段

```ts
export interface ScoreResult {
  ...
  highlights: string[] // 回答中的亮点（答对/答得好的地方）
  comments: string[]
  missed: string[]
}
```

历史旧记录的 score 无此字段，但当前没有任何代码路径读取历史记录的 score 明细（历史行只展示 grade 徽章+答案+时间，结果面板只展示新鲜评分），无需数据迁移；未来若展示历史详情用 `?? []` 兜底即可。

### 改动 2.2：`src/lib/grading.ts` — prompt 重写 + 解析扩展

**`parseScoreJson`**：返回对象增加 `highlights: strArr('highlights')`（`strArr` 对缺失字段已容错为 `[]`，重试链路无需改动）。

**`buildGradingMessages` system prompt**：保留面试官人设与岗位要求，删除「宁严勿松」，改为积极评价者立场，新增三条评分纪律：

1. **语音转写容错**：候选人回答可能来自语音转文本，会有同音字、近音词、英文术语误转写（真实用户案例："前缀缓存"被转成"善意轮缓存/善意弱攻击"、"SGLang"→"SDLang"、"前置/前缀缓存"→"潜置缓存"）。评分前先按上下文在心里纠错还原；明显的转写错误不是技术错误，不扣分，不计入"表述粗糙/影响专业度"，更不要在点评中当作"概念没理解"。
2. **语义等价即覆盖**：判断"必须覆盖"要点时按语义判断，说法与要点原文不同但本质一致即算覆盖；候选人已实际提到的点（哪怕简略）不得整条计入 missed，最多在改进建议里提"可再展开"；只有真正未提及或本质说错的才计入 missed。
3. **基础分+扣减的打分心智**：先识别回答中答对/答好的内容（亮点），据此建立各维度基础分，再按真实缺失与红线扣减。校准锚点：覆盖大部分必须要点且无红线 → 各维度 7 分起；有明显亮点且结构清楚 → 8 分以上不要吝啬；答对了核心机制、只缺细节量化 → 不应低于 6；只有完全跑题、空泛或触红线才低于 5 分。避免系统性压分。
4. **遗漏关键点知无不言、但不事无巨细**：missed 输出是本评分器的核心价值，必须保留——语气积极不等于报喜不报忧，真正遗漏的**关键点**一条不落地列出；同时作为专业面试官要有判断力，只列影响回答质量的关键缺失，不罗列细枝末节。
5. **反馈完整性标准（90–95 分路径）**：highlights + comments + missed 三者合起来必须构成一条完整的改进路径——候选人把 missed 的关键点补上、按 comments 改进后，这个回答应能达到面对真实客户拿 90–95 分的水平。输出前自查：如果照单全改仍到不了 90 分，说明关键缺失还没点全。

**user prompt 输出格式**：

```
{"accuracy": ..., "structure": ..., "business": ..., "depth": ...,
 "highlights": ["回答中的亮点，具体指出好在哪，尽量引用候选人自己的表述，2-5 条"],
 "comments": ["改进建议，先肯定后建议、具体可执行，2-4 条"],
 "missed": ["语义上确实未覆盖的关键要点，按重要性排序；知无不言但只列关键项、不事无巨细"]}
```

comments 的定位从"好在哪/差在哪混编"改为"改进建议"（亮点已单列，避免重复）。

**`toGrade` 阈值不动**（A≥8/B≥6.5/C≥5）：分数偏低的根因在 prompt 评分立场，先从源头校准；实测后若仍偏低再调阈值，避免双重放水。`WEIGHTS` 不动。

### 改动 2.3：`src/pages/InterviewPage.tsx` — 结果面板增加「亮点」区块（294–339 行区域）

在「面试官点评」上方插入，配色用绿色系（与 GRADE_STYLE 中 A 级同一套 token，如 `text-ok`，以文件内实际 token 为准）：

```tsx
{result.score.highlights.length > 0 && (
  <div className="mb-3">
    <div className="mb-1 text-xs text-ok">回答亮点</div>
    <ul className="list-inside list-disc space-y-1 text-sm text-ok/90">
      {result.score.highlights.map((h, i) => <li key={i}>{h}</li>)}
    </ul>
  </div>
)}
```

区块顺序：等级+总分 → 四维度分 → **回答亮点** → 面试官点评（改进建议）→ 遗漏要点（保留不动）。

---

## Part 3：参考答案重写（40 题）

### 改动 3.1：`src/data/questions.ts` — 全部 40 题 `referenceNotes` 重写为「主线 + 结构化展开」

字段类型不变（仍是 string），内容改为模板字面量多行字符串，统一模板：

```
主线：<一句话回答骨架——先给结论/框架，照此开场即立住结构>
① <要点组标题>：<关键点，含必要的数字/参数>
② <要点组标题>：<...>
③ ...
```

（3–6 个分条，分条顺序即建议的作答顺序。）

内容纪律：
- 以该题现有 `mustCover`（必须全部融入）+ `niceToHave`（择要融入）+ 旧 `referenceNotes`（其中的数字与事实全部保留）为材料整合改写，**不虚构新数字**。
- 主线一句话要能回答"这道题的答题框架是什么"——学习者照主线作答至少及格，分条展开到位即 90+ 回答的骨架。
- 40 题按 6 个板块分批（te-1..7 / mc-1..6 / ag-1..8 / cp-1..6 / id-1..6 / ps-1..7），每批完成后跑 typecheck 防手误。

连带收益：`referenceNotes` 同时注入评分 prompt 的「参考要点」段（grading.ts），结构化后评分判断也更有依据，无需额外改动。

### 改动 3.2：`src/pages/InterviewPage.tsx` — 参考要点面板支持换行

约 290 行 `<p className="border-t border-line pt-3 text-dim">{question.referenceNotes}</p>` 增加 `whitespace-pre-line`，让主线/分条的换行渲染出来。

---

## 实施顺序

1. `src/store.ts`：`newAttemptId` + 两个新 action + persist version/migrate。
2. `src/pages/InterviewPage.tsx`（清理部分）：id 替换 → 确认状态重构 → 卡片 UI 重构。
3. `src/data/types.ts` + `src/lib/grading.ts`：`highlights` 字段 + prompt 重写（含五条评分纪律）。
4. `src/pages/InterviewPage.tsx`（评分部分）：结果面板加亮点区块 + 参考要点 `whitespace-pre-line`。
5. `src/data/questions.ts`：40 题 referenceNotes 按板块分批重写。
6. `npm run typecheck`（或 `tsc --noEmit`）+ `npm run build`。

## 验证方式

`npm run dev` 起服务后：

**清理功能**（造数据用 DevTools Console 播种，无需评分 API key）：
1. 迁移：播种 version 0 且两条同 id 的旧数据 → 刷新 → localStorage 变 `version: 1` 且 id 已去重。
2. 单条删除：点 ✕ → 「确认删除？」→ 失焦复原 → 连点两次只删该条，计数与仪表盘同步，localStorage 对应条目消失。
3. 清空本题：两段式确认后仅该题条目消失；其他题有历史时卡片保留并显示占位文案。
4. 清空全部：卡片与仪表盘一并消失，localStorage `attempts: []`。
5. 展开折叠：播种 7+ 条 → 默认 5 条 + 展开可删第 6/7 条 → 切题自动收起。
6. 新 id：真实提交一次，新记录 id 为 uuid 格式。

**评分功能**（需真实 API key 调用评分）：
7. **用户真实 case 回归基准**：用"上下文缓存显式 vs 隐式"那道题，原样提交用户提供的语音转写回答（含"善意轮缓存/善意弱攻击/SDLang/潜置缓存"等转写错误；改造前打分 D / 4.6，depth 3、business 4）。改造后预期：
   - 等级不低于 C+，合理落点 B−/C+（答对了 KV cache 本质、显式/隐式区分、RadixAttention、前缀一致命中条件、"何时更贵"的方向判断；确实缺计价参数与成本公式）
   - 点评中不出现对转写错误的"表述粗糙/影响专业度"类批评
   - "前缀完全一致"这类已提到的点不再出现在 missed（用户原话说了"前缀和之前完全一致"，改造前仍被判"未展开"）
   - missed 只保留真正未提的计价细节（写入溢价倍率、存储费、最短可缓存前缀等）
   - 亮点区块点出上述答对的内容
8. 构造一份措辞与 mustCover 原文不同但语义等价的回答 → missed 不应列入该要点；但真正遗漏的关键点必须仍出现在 missed（遗漏要点功能不能被"积极化"弱化掉）。
9. 正常回答 → 结果面板出现绿色「回答亮点」区块（2-5 条、引用回答原文），comments 变为改进建议风格。
10. JSON 解析重试链路：highlights 缺失时容错为 `[]`，不报错。

**参考答案**：
11. 抽查每个板块至少 1 题：参考要点面板显示「主线：…」+ ①②③ 分条且换行正常；主线是一句可直接照着开场的框架句；原 referenceNotes 中的数字/事实未丢失（对照 git diff 抽查）。
12. `QUESTIONS` 数组结构未变：40 题、id/板块不变，typecheck + build 通过。

按既有工作流：实施与 QA 走独立 subagent，部署上线前先本地过一遍上述各项。
