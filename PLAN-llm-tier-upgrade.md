# 升级通用 LLM 档位：deepseek-v4-flash → v4-pro，并显式关闭默认思考

## Context

用户问「当前 app 配的什么 LLM？同一个 base-url 下有没有质量更高、但响应不会明显变慢的选项？」

排查结果（`server/.env` → `SERVER_DEEPSEEK_KEYS` + `DEEPSEEK_BASE_URL=https://api.deepseek.com`，服务端只配了 DeepSeek 与 Jina 两家 key）：

**当前实际在用的模型分两条线**

| 链路 | 代码位置 | 模型 | 思考档 |
|---|---|---|---|
| 面试评分 / 划词提问（AskDialog、SelectionAsk、InterviewPage） | `src/store.ts:38,66` `useSettings` 默认值 | `deepseek-v4-flash` | **未显式设置** |
| 论文陪读 Paper Copilot 全部任务 | `src/data/paperPolicy.ts` `DEEPSEEK_V4_PRO` | `deepseek-v4-pro` | 显式 off / on-high |

`.env.local` 里的 `DEEPSEEK_MODEL=deepseek-v4-pro` / `KIMI_MODEL=kimi-k3` 全代码库无人引用（文件头还写着 Spring Boot，是从别的项目抄来的残留），不影响运行。

**base-url 下可用模型（实测 `GET /models`）**：`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`。只有 `v4-pro` 是真正的质量升级档（同架构，1.6T/49B 激活 vs Flash 284B/13B 激活，见 `src/data/models.ts:104-145`）；vision-exp 是 flash 的多模态实验版，不是质量升级。

**实测发现的更大问题**：`src/lib/llmClient.ts` 的 `chatComplete`（:82-100）与 `chatStream`（:273-290）**既不发 `thinking` 字段也不发 `max_tokens`**，而 DeepSeek V4 两档的**默认思考都是开的**。同一道中等难度问题（非流式）实测：

| 请求形态 | 耗时 | reasoning tokens | 结果 |
|---|---|---|---|
| flash，不发 thinking（= 现状） | **195.0 s** | 24 806 | 超过 `chatComplete` 的 120 s 超时 → 用户看到「请求超时」 |
| pro，不发 thinking | 107.2 s | 4 540 | 正常返回 |
| flash，`thinking: disabled` | 12.0–14.4 s（流式，TTFT 0.55–0.77 s） | 0 | 2 690–3 110 字 |
| pro，`thinking: disabled` | 14.5–19.7 s（流式，TTFT 0.78–1.13 s） | 0 | 1 530–2 450 字 |
| pro，`reasoning_effort: low`，max_tokens 3000 | 61.7 s | 3 000（吃满） | **正文 0 字**（空流） |
| pro，`reasoning_effort: high`，max_tokens 3000 | 58.3 s | 3 000（吃满） | **正文 0 字**（空流） |
| pro，`reasoning_effort: high`，max_tokens 1500 | 32.9 / 36.8 s | 1 500（吃满） | **正文 0 字**（空流，两轮均是） |

也就是说：**现在的响应慢，主因不是模型档位，而是思考模式在通用链路里没人管**。flash 的思考长度极不稳定（简单题 110 token，中等题 24.8K token），才是超时的来源。`src/lib/sse.ts:56` 的 `extractStreamDelta` 只取 `delta.content`，思考期间划词提问面板是完全空白的。

**用户已选定方案（2026-09-02）**：换 pro + 显式关思考，接受 token 单价 3×（$1.32/$3.96 vs $0.44/$1.32，错峰均 5 折）。

**结论**：把通用链路换成 `deepseek-v4-pro` **并同时显式发送 `thinking: {type:'disabled'}` + `max_tokens`**，质量升一档（激活参数 3.8×，与论文陪读拉齐），响应时间反而从现状（含失控思考）大幅下降；相对「flash + 关思考」的理论最快态，代价是 TTFT +0.3~0.5 s、解码速率约 120 → 52 tok/s，因 pro 输出更精炼，端到端墙钟约 +20%~60%，符合「不要延迟太多」。

## 改动

### 1. `src/lib/llmClient.ts` — 显式思考档与输出上限（核心）

`ChatOptions` / `ChatStreamOptions` 各加两个可选字段：

- `thinking?: 'off' | 'low' | 'high'`，默认 `'off'`
- `maxOutputTokens?: number`

请求体构造复用 `src/lib/paper/providerAdapters.ts:20` `buildChatBody` 已经验证过的参数语义（**不要直接 import**——`lib/paper` 在 flag-off 构建里被虚模块化，主入口静态图禁止引用，见 `src/data/paperPolicy.ts:6-8）：在 `llmClient.ts` 内写一个同语义的小 helper：

- `deepseek`（`thinking.kind === 'toggle'`）：`off` → `thinking:{type:'disabled'}`；`low`/`high` → `thinking:{type:'enabled'}` + `reasoning_effort`
- `moonshot`（Kimi 思考不可关）：只发 `reasoning_effort: 'low'|'high'`，`off` 映射成 `low`；且 `max_completion_tokens` 而非 `max_tokens`
- `zhipu` / `openai-compat`：保持现状不发思考字段（无实测依据，别猜）
- 输出上限参数名同上按 provider 分支

调用点默认值：
- `InterviewPage.tsx:193,204` 评分：`thinking: 'off'`，`maxOutputTokens: 1500`（评分输出是固定 JSON，1500 足够）
- `SelectionAsk.tsx:229` 划词提问：`thinking: 'off'`，`maxOutputTokens: 2000`

`chatComplete` 的 120 s 超时（`llmClient.ts:88`）连同注释一起下调到 60 s——关掉思考后 P99 在 20 s 内，120 s 只会让失败案例干等。

> **为什么通用链路不开思考**：实测 pro + `effort: low` / max_tokens 3000 与 pro + `effort: high` / max_tokens 1500 在同一道硬题上都被思考吃满预算、正文 0 字（`paperPolicy.ts:95-97` 记录过同一现象，论文陪读的 deep 档因此把预算提到 6000）。通用链路要开思考就得给到 8000+ token 预算、延迟进入 60 s 量级——与「响应时间不要延迟太多」冲突，本次不做。

### 2. `src/store.ts` — 默认模型换档 + persist 迁移

- `PROVIDERS` 里 deepseek 项 `defaultModel: 'deepseek-v4-flash'` → `'deepseek-v4-pro'`（:38）
- `useSettings` 初始 `model` 同步（:66）
- `persist` 配置（:71-74）加 `version: 1` + `migrate`：老用户 localStorage 里存着 `deepseek-v4-flash`，不迁移就升级不到。迁移规则只在「provider===deepseek 且 model==='deepseek-v4-flash'」时改写，用户手动填过别的 model id 一律保留。参考同文件 `useHistory` 已有的 `version/migrate` 写法（:295-296）。

### 3. 顺带修掉的小项

- `.env.local` 里 `DEEPSEEK_MODEL` / `KIMI_MODEL` 及那段 Spring Boot 注释是死配置，删掉或加注释标注「未被引用」，避免下次排查再被误导。

### 4. 测试

- `src/lib/llmClient.test.ts`：`base` fixture 模型改 `deepseek-v4-pro`，:148 断言同步；新增用例断言 deepseek 请求体带 `thinking:{type:'disabled'}` 与 `max_tokens`，以及 moonshot 走 `reasoning_effort` + `max_completion_tokens`。
- `server/test/llmGateway.test.ts:12,163` 的 `deepseek-v4-flash` 只是网关透传 fixture，与档位无关，可不动。

## 验证

1. `npm run test`（vitest）——llmClient 契约用例全绿。
2. `npm run dev` + 后端起服（见 memory「Local E2E QA env」：vite 只听 `[::1]:5173`，用 `localhost` 访问），登录后：
   - 面试页跑一次评分，确认 **< 20 s** 返回且 JSON 解析成功（改前中等难度题会撞 120 s 超时）。
   - 划词提问问一道硬题（如「MLA 相比 GQA 为什么能压缩 KV Cache」），确认**首字 ~1 s 内**出现、不再有长时间空白面板。
   - 设置页确认「模型 ID」占位符显示 `deepseek-v4-pro`；手动改成 `deepseek-v4-flash` 仍能正常调用（迁移不锁死用户选择）。
   - 老会话验证：改前先在设置页存下 flash，改后 **`location.reload()`**（memory「Browser QA hidden-tab rAF trap」：HashRouter 同 URL navigate 不重载模块，验证 persist migrate 必须显式 reload），确认已迁移到 pro。
3. 论文陪读回归：本次不动 `paperPolicy.ts`，跑一次 `npx vite-node scripts/paper-eval/run.ts -- --smoke` 确认无回归即可。

---

## 交付记录（2026-09-02）

实施 + 独立验收 + 验收 P2 修复均已完成。判定：**通过**，无 P0/P1。

**实弹冒烟**（改后代码构造的确切请求体直打 `api.deepseek.com`）：

| 链路 | HTTP | 耗时 | 思考 token | 结果 |
|---|---|---|---|---|
| 面试评分（非流式 + json_object + max_tokens 1500） | 200 | 1.76 s | 0 | JSON 可解析，score=85 |
| 划词提问（流式 + max_tokens 3000） | 200 | 首字 765 ms / 总 20.1 s | 0 | 1 989 字，正常收尾 |

对照改前：同类评分请求 195 s / 24 806 思考 token / 撞穿 120 s 超时。

**验收发现的 3 条 P2，处理如下**

- **P2-1｜60 s 超时零测试覆盖** → 已修。`llmClient.test.ts` 新增 `describe('chatComplete 超时（fake timers）')` 两例：59 s 时不得误杀 + 越过 60 s 抛 timeout 且文案含「60s」，以及 `timeoutMs` 显式传入优先。变异验证：把 `60_000` 改回 `120_000` → 该用例转红。
- **P2-2｜划词提问 2000 token 余量仅 11%，且截断静默** → 已修。上限 2000 → 3000；`src/lib/sse.ts` 新增 `extractFinishReason`，`chatStream` 增加 `onTruncated` 回调，`AskMsg` 增加 `truncated` 字段，`AskDialog` 在被截断的回答尾部渲染「回答已达长度上限，内容可能不完整——可追问『继续』。」。变异验证：删掉截断检测行 → 新用例转红。
- **P2-3｜moonshot 分支无条件发 temperature，与 `providerAdapters.ts` 的 `sampling: fixed` 相悖** → **未修，已知留存**。这是本次改动之前就存在的行为（本次只新增了 `reasoning_effort`），且 moonshot 通路在服务端不可达（只配了 DeepSeek + Jina key），用 Kimi key 实测三种请求形状均在参数校验前被 429「余额不足」拒绝，无法证伪。**日后启用 moonshot 通路时，需在 `applyThinkingAndLimit` 同处把 moonshot 的 temperature 一并去掉。**

**门禁**：`npx tsc --noEmit` ✅ ｜ `npm run test` 75 files / **1102 passed** ✅ ｜ `npm run build` ✅ ｜ `VITE_ENABLE_PAPER_COPILOT=0 npm run build` ✅（产物中 `paperPolicy` / `CopilotPanel` / `providerAdapters` 命中数为 0，`llmClient.ts` 对 `lib/paper` 只有注释提及、无静态引用）

**persist 迁移实证**：验收方另建「改动前形状」的 store 实测确认 zustand 会把默认 `version: 0` 写进 localStorage，因此老会话确实进得了 `migrate`（不是空迁移）；畸形 payload（`state` 缺失 / null / 字符串 / 数组 / `provider:42,model:null` / 整包非 JSON）逐个跑过不崩，回落默认值。

**尚未做**：浏览器端 E2E（登录态下真机点评分/划词、老会话 `location.reload()` 验迁移）——见上方「验证」章节第 2 项。
