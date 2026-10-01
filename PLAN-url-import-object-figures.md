# PLAN: URL 导入保留 arXiv `<object>` SVG 图（论文陪读）

> 状态：2026-10-01 实施完成并通过验收，部署见下「交付记录」。

## 交付记录（2026-10-01）
- 实现：fable 子代理在独立 worktree 完成 §2–§4；额外修正（计划外，已认可）：阅读模式摘掉 `table.ltx_guessed_headers` 的 class（Readability 的 unlikelyCandidates `/header/` 会把 arXiv 表整张删掉）；figure 内图/表/**全部**图注按源码顺序落块（含子表面板与多面板图）。
- 门槛：typecheck 通过；客户端 1968/1968、服务端 349 通过（2 skip）；build 通过。
- 全库回归（同日 baseline vs 改后，26 条 URL + 2 条 z.ai 共 44 次，`.e2e-qa-fixtures/url-regression-objfig-compare.txt`）：44/44 成功，0 硬违规、0 待复核。变化仅：2407.00079v4 原貌 资源 10→23、图块 5→18、无图 figure 13→1（剩 Listing 1 代码清单）；2606.30560v1 原貌 无图 figure 7→0、阅读模式 图块 4→12、表块 5→17。z.ai 三篇经本机 Tier 3（新代理 v3）成功，字数块数与 09-19 一致。
- codex QA r1（gpt-5.6-terra xhigh）：主场景 1–8 全 PASS（13 张 SVG 逐图解码、0 次 arXiv 实时请求、离线重载、跨设备同步、阅读模式 14 图/3 表/20 图注、SVG 代理兜底）。2 个 P1 经复核不成立：#14「重新导入未结算」是脚本等一条导航后即卸载的提示——实测重导 16.5s 成功（mime→快照、23 资源、id 与进度保留）；#15 390px 横向溢出（423>388）来自 Algorithm 1 浮动块与两张表，改动前即存在，记为 P2 待办。自造页场景 9–11/13/16 因 API 拒绝 loopback 而 BLOCKED（单测覆盖）。
- 事实更正：源页实际是 13 个 `<object>`（13 个唯一 SVG），不是 14。
- 待办（P2）：arXiv 快照在窄屏的横向溢出（算法块/宽表；快照里 ar5iv 的 `.ltx_graphics{max-width:95%}` 未生效，需查 `@import … layer()` 内联）。


## Context

The imported Mooncake paper (`c5d37d1a…`, source https://arxiv.org/html/2407.00079v4) shows almost no figures in 网页原貌. The cause is confirmed from both the source page and the stored copy.

**What arXiv sends.** The page has 20 `<figure>` elements. Only 1 is an `<img>` (cache_unit_v2.png). The other 14 figure slots, covering 13 unique files, embed a vector graphic this way:
`<object type="image/svg+xml" data="2407.00079v4/architecturev2.svg" width=476 height=273 class="ltx_graphics">`.
LaTeXML produces this for most modern arXiv papers.

**What llm-pro stored.** The record's mime is `application/x-paper-web-snapshot`, captured in rendered mode, with 10 assets (fonts, logos, the one PNG) and 0 skipped. The snapshot HTML contains **0 `<object>` elements**. Figure 1 is now only its `<figcaption>`. The 13 SVGs were never downloaded; they appear in neither `assets` nor `skipped`. The 3 tables are intact.

**Why they were dropped.** Every capture path deletes `<object>` before anything reads its URL:
- **Rendered capture (Tier 2 in the browser, Tier 3 on the server).** `CAPTURE_CSP` sets `object-src 'none'`. `serialize()` then deletes `DROP_SELECTOR` (`…object, embed…`) with no replacement (`src/lib/paper/url/captureAgent.ts:166, :389-394`).
- **Static capture (Tier 1).** `replaceMedia` swaps it for a `[嵌入内容]` placeholder (`captureStatic.ts:235-238`).
- **Reader mode (阅读模式).** Readability `_clean(…,"object")` removes it, and the DOMPurify FORBID list would remove it too.
- **Asset planner.** It only looks at `img[src], [poster], image, style` (`buildSnapshot.ts:209`), so it never asks for these files.

**Why converting them is safe.** All 13 SVGs are plain static graphics (26–226 KB, about 1.3 MB total): no `<script>`, no `foreignObject`, no event handlers, no external references. An SVG shown through `<img>` can't run scripts anyway. The asset downloader already allows `image/svg+xml` (`shared/apiRoutes.ts:137`), and the reader builds blobs with the right mime (`WebSnapshotView.tsx:174`).

**Goal.** An `<object>`/`<embed>` that points at an image becomes an ordinary `<img>`. From there the existing image pipeline downloads it, packs it, and shows it offline, with no new asset code. Non-image embeds (PDF, HTML, Flash) behave exactly as today.

## Changes

### 1. Shared rule: which embeds count as images
An `object[data]` or `embed[src]` counts as an image when **either** its `type` starts with `image/` **or** its URL path ends in one of `.svg .png .jpg .jpeg .gif .webp .avif` (checked before `?`/`#`). Tracker-sized ones (width or height ≤ 1, or `hidden`) are still removed.

The replacement `<img>`:
- `src` = the resolved absolute URL
- copies `id`, `class`, `style`, `width`, `height`, `title`
- `alt` = the element's trimmed fallback text, or `""`

### 2. Rendered capture: `src/lib/paper/url/captureAgent.ts`
- In `serialize()`, add a step **before** "4) 脚本执行面与嵌入内容整体删掉". It walks `clone.querySelectorAll('object[data], embed[src]')` and replaces matching elements with the `<img>` from §1.
  - Use the existing `absolutize(attr, base)` and `replaceNode` helpers.
  - The agent is stringified, so the rule must be inlined here, following the same pattern already used for the canvas and video handling.
- Bump `CAPTURE_AGENT_VERSION` 2 → 3. Update the constant and the inline `agentVersion: 2` literals (see the comment at :32), plus the tests that assert `2`: `captureAgent.test.ts:163`, `captureRendered.test.ts:197`.
- This also fixes Tier 3, because `server/src/render/browser.ts` runs the same `captureAgentMain`.

### 3. Static capture: `src/lib/paper/url/captureStatic.ts`
- Add `promoteImageEmbeds(doc)` and call it in `preprocessFidelity` **after `promoteLazyImages` and before `absolutizeUrls`**. The new `<img src>` is then made absolute by the existing `absolutizeUrls`.
- Put it before `replaceMedia`, so `replaceMedia` only ever sees non-image embeds.

### 4. Reader mode (阅读模式)
- **Figures.** In `preprocess()` in `src/lib/paper/url/extractArticle.ts`, convert image embeds with the same rule, placed before the `img` loop (around :106). They then go through the existing https check, `<figure>` wrapping, and `<p>` hoisting, and become `image` blocks with a remote `src`.
- **Tables.** arXiv tables are `<figure class="ltx_table"><table>`, and the `figure` branch of `src/lib/paper/normalizeHtml.ts:111-126` ignores everything except img and figcaption. Change it to also emit a `table` block for each outermost `<table>` inside the figure, in source order with the caption. Reuse the depth-aware `extractBlocks` / `tableToText` from `normalizeDocx.ts`; don't add a new non-greedy regex, because LaTeXML nests tabulars.
  - Update the test that currently asserts "other figure content is ignored" (`normalizeHtml.test.ts:180`).
- **Proxy fallback.** In the 「通过代理加载」 fallback, `src/components/papers/BlockReader.tsx:106` calls `fetchUrl(block.src)`. That is the page kind, which returns 415 for SVG, and it builds an untyped Blob. Change it to `fetchUrl(block.src, { kind: 'asset' })` and `new Blob([bytes], { type: contentType })`. Confirm first that `FetchUrlOptions` accepts `kind`.

### 5. Tests (vitest; happy-dom per file, following the existing files)
| File | New cases |
|---|---|
| `captureAgent.test.ts` | svg `<object>` becomes an `<img>` with an absolute src, keeping width/height/class; a PDF `<object>` is still dropped; a 1×1 object is dropped; an image `embed[src]` is promoted |
| `captureStatic.test.ts` | image `<object>` becomes `<img>`; a non-image object still becomes the `[嵌入内容]` placeholder (the existing :143-155 case must still pass) |
| `buildSnapshot.test.ts` | an `<object>` svg ends up in the asset plan and gets `data-pc-asset` |
| `normalizeHtml.test.ts` | `<figure><figcaption>Table 1</figcaption><table>…<table>nested</table>…</table></figure>` produces caption + table blocks, and the nested table stays inside the outer one |
| `fidelitySanitize.test.ts` / `sanitize.test.ts` | should still pass unchanged: raw `<object>` stays forbidden |

## Delivery
Order follows the usual workflow: save the plan doc, implement with subagents, run the gates, run QA, then deploy.
1. Save this plan as a new `PLAN-url-import-object-figures.md` in the repo root (don't touch existing PLAN docs).
2. Implement with one subagent covering §2–§4. They're small and share one rule, so splitting would only create file conflicts. Gate: `npm run typecheck && npm test && npm run build` and `cd server && npm test`.
3. **Full-library regression** (required for capture-agent changes):
   - Take a same-day baseline on the **unchanged** code first, then rerun on the new code.
   - Cover every URL in the library, enumerated read-only from IndexedDB through the `/api/app/health` tab. Reader-mode URLs run in reader mode and also in snapshot mode.
   - Run only on local dev with the `qa_img` account (localhost:5173, server `.env` has `FETCH_URL_ALLOW_FORBIDDEN_DEV=1`). Delete created papers between runs.
   - Compare block counts, asset counts, `skipped`, and `<figure>` elements with no image.
   - Record which library pages contain image `<object>`/`<embed>` elements: those are the other papers that would gain figures from a re-import.
4. codex E2E QA (gpt-5.6-terra xhigh, browser + API, detached with the `QA-DONE` sentinel). Fix only P0/P1 findings I agree with. Stop at 0 P0/P1 or after 3 rounds.
5. Commit on `feat/agent-rl-and-url-import-render` (production already runs this branch; PR #11). Deploy with `scripts/deploy.sh --all`: the server is needed because the render service runs the capture agent, and `--server` try-restarts `llms-study-render`.
6. **Repair the user's paper.** Open `/#/papers/c5d37d1a…` and click 「重新导入（网页原貌）」. This keeps Copilot sessions and reading progress. It currently has 0 highlights, 0 translations and 0 sessions, so nothing is lost. Report the other library papers from step 3 and let the user choose whether to re-import them.

## Verification (acceptance)
- **Local 网页原貌 import of 2407.00079v4:**
  - Figures 1, 2 and 4–13 (including the 10a/10b sub-panels) show their SVGs; Figure 3 is the PNG.
  - Snapshot header has `assets` ≈ 23, `skipped` = 0, and `html` has 0 `<object>` and 0 `[嵌入内容]`.
  - The reader iframe makes no network requests to arxiv.org for the SVGs (they're served from `blob:`).
  - 文本视图 shows `image` blocks for the SVG figures, with captions next to them.
- **Local 阅读模式 import:** image blocks for every figure, plus 3 `table` blocks with real cell text.
- **Static tier:** the same arXiv HTML run through Tier 1, forced via the unit fixture, gives `<img>` and not placeholders.
- **Library regression:** no other URL gets fewer blocks, assets or images than the baseline, and there are no new failures.
- **Production after deploy and re-import:** screenshot of Figure 1 (architecture) and a Section 8 results figure visible in 网页原貌; `capture.agentVersion` = 3.
