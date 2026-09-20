# PLAN — URL import fails on client-rendered pages (z.ai blog): root cause, other bugs, fix

## Status (2026-09-19 — DONE in production: code deployed, render service provisioned and ON, the original z.ai URL imports on llm-pro.cn. Committed 2026-09-20 on branch `feat/agent-rl-and-url-import-render` (pushed; not yet merged to `main`): `f08f642` Agent RL, `f0fd671` this fix.)

| Step | State | Evidence |
|---|---|---|
| A1 capture agent v2 | done | 73 targeted tests; v1 vs v2 timing identical to the ms on pages with content |
| A2 fair comparison + honest failure | done | 43 tests in `buildSnapshot.test.ts` (33 new) |
| A3/A4 failure hint + 「取消导入」 | done | 19 new tests; `hint` passes through sync untouched (server stores rows as opaque JSON) |
| A5 docs | done | known-limits section in both READMEs + dialog help text |
| B1 `safeFetchHop` | done | 46 new tests, 208 existing untouched |
| B2 shared constants/types | done | |
| B3/B4 render service + `POST /api/app/render-url` | done | 345 server tests; real-browser e2e gated behind `RENDER_E2E_CHROME` |
| B5 client wiring | done | `renderUrlApi.ts` + 7 tests |
| B6 deploy files | written, **not executed** | `deploy/llms-study-render.service`, `provision.md` §10, `deploy.sh` |
| Gates | green | client 1,958 tests, server 349 (+2 real-browser tests gated behind `RENDER_E2E_CHROME`), both typechecks, client and server builds |
| **Sweep baseline → after A** | **0 hard violations, 0 review items** | 40/40 library runs ready; 38/40 identical in mode+chars+blocks, 2 captured slightly more text |
| z.ai, render flag off | honest failure in ~7 s, no reader-retry button | `…脚本被浏览器跨源策略拦截；阅读模式同样无法抓取（…1 个脚本加载失败）；服务器渲染：本部署未启用` |
| **z.ai, render flag on** | **all 3 import** (24,314 / 19,924 / 12,738 chars, mode `rendered`, ~16 s) | sandbox on (no `--no-sandbox`), ~4–5 s per render, no leftover Chrome |
| Sweep after B (flag on) | 0 hard violations; **Tier 3 calls across all 40 library runs: 0**; 1 review item | minimax.io +11 s: agent v2 waited 10 s for content on a page whose fetched HTML already had the article (render is blank in the sandbox, static fallback wins regardless) |
| Wait fix | done | content-aware wait now only when the fetched HTML is an empty shell (`minTextChars: 0` otherwise = v1 timing); 3 new tests |
| **Final sweep (flag on, wait fix)** — the record | **43/43 ready, 0 hard violations, 0 review items** | 40/40 library runs first-attempt, 39/40 identical to baseline in mode+chars+blocks (NVIDIA blog +1 % text, live drift); Tier 3 calls on library runs: 0; minimax.io 18 s → 28 s → 21 s; library snapshot total 643 s → 617 s; z.ai 3/3 on first attempt. Results: `.e2e-qa-fixtures/url-regression-{baseline,after-a,after-b,final}.json` |
| codex QA round | stopped early at the user's request once the report showed no P0; no further rounds | charter `.e2e-qa-fixtures/QA-CHARTER-url-import-csr-render.md`, report `QA-REPORT-url-import-csr-render.md`. PASS: route-level SSRF probes (12 inputs, all 400/403/413, none hung), 401/403 auth, redirect `finalUrl`, honest failure for 503 and 404, reader-retry kept when the HTML has text, WeChat/multi-link/PDF never call `render-url`, mobile layout, excalidraw.com via Tier 3 |
| Codex findings re-checked by hand | **1 real, fixed; 2 not bugs** | **#1 real:** cancel during 抓取中, import again at once → `429 已有抓取任务进行中` → 「全部链接都未能抓取到正文」. Cause: the browser aborted but the server kept fetching upstream and held the per-user slot (page concurrency is 1). **#2 not a bug:** closing and reopening the dialog shows the running job, which then finishes. **#11/#12 not a bug:** an aborted render reaches the render service in ~1 s (`error=AbortError` in its log) and the next render succeeds; codex had run out of its per-user allowance. The rest (#3 #4 #7 #10 #21) were codex's own script |
| Cancel fix | done | **Server:** `SafeFetchOptions.signal` → `nodeTransport` destroys the upstream request; route passes `c.req.raw.signal`. Direct to the API the slot is free **50 ms** after the client aborts. 4 new tests in `server/test/fetchAbort.test.ts`, incl. a route test that first proves the 429 exists. **Client:** `fetchUrlWithBusyRetry` (4 attempts, ≤ ~9 s) for the residual window — vite's dev proxy does **not** forward the disconnect, so locally the slot frees only when the upstream fetch ends; nginx closes the upstream connection on client abort by default, **not verified on the production box**. 6 new tests |
| Render allowance | raised 3 / 100 s → 5 / 60 s per user | importing four CSR articles in a row hit the old limit, and a request refused by the site-wide gate still cost a token. The site-wide "one render at a time" is what protects the box |
| Sandbox check | redone properly | my first check grepped `pgrep` output that this machine rewrites to bare PIDs, so it could not fail. Redone by matching on the flag itself with a positive control (`--proxy-bypass-list` seen): 0 Chrome processes with `--no-sandbox` during a live render |
| **Sweep on the final code (`final2`)** — the deploy gate | **43/43 ready, 0 hard violations, 0 review items** | 40/40 library runs first-attempt, 39/40 identical to baseline (NVIDIA blog +1 % text); Tier 3 calls on library runs: 0; z.ai 3/3 first attempt; library snapshot total 643 s → 650 s |
| **Production deploy (code, render OFF)** | **done 2026-09-19 21:39–21:40 CST** via `scripts/deploy.sh --all`, at the user's instruction; includes the previously-unshipped Agent RL work (user's choice) | server `20260919-213944` health OK, web `20260919-214012`; entry bundle `index-BcZJ9zEV.js` → `index-R28Oxbca.js` (HTTP/2 + gzip); deployed assets contain 取消导入 / 服务器渲染 / 阅读模式同样无法抓取 / agent-rl / 论文陪读; `POST /api/app/render-url` without session → 401 (mounted); API log clean; `RENDER_SERVICE_SOCKET` absent from `api.env` ⇒ render off. Backups: `/opt/llms-study-api.bak-20260919-213944`, `/var/www/llms-study.bak-20260919-214012`. `deploy.sh` does not install unit files, so the repo's `SupplementaryGroups=llmrender` line is NOT applied yet (the group does not exist; applying it early would stop the API from starting) |
| **B0 preflight (read-only)** | **GO** | x86_64 (Chrome RPM path applies, no aarch64 fallback); 3,557 MB RAM, **2,992 MB available**, API using 29 MB of its 512 MB cap, no swap; 2 vCPU; 33 GB disk free; `user.max_user_namespaces=14023`, `kernel.unprivileged_userns_clone=1` (namespace sandbox possible under `NoNewPrivileges`); cgroup2fs + systemd 255 (`IPAddressDeny` supported); resolvers `100.100.2.136` / `100.100.2.138` — exactly the values the unit file's `IPAddressAllow=` placeholder assumed; nginx never sets `proxy_ignore_client_abort` ⇒ default off ⇒ a client abort closes the upstream connection, so the cancel slot-release works in production as it did direct-to-API; no Chrome, no Google repo, no `llmrender` user yet. **Still to run during provisioning (not read-only):** `sudo -u nobody unshare -U true`, and a throwaway `systemd-run -p IPAddressDeny=any` to confirm the BPF firewall |
| **Provisioning + flag ON** | **done 2026-09-19 21:45–21:50 CST**, on the user's go, following `deploy/provision.md` §10 | Remaining preflight: `unshare -U` as `nobody` ok; `IPAddressDeny=any` blocks, baseline reaches the net. **Deviation:** `dnf install google-chrome-stable` failed — alinux4 has the real fonts but not the `liberation-fonts` metapackage name Chrome's RPM requires (the only unsatisfiable dependency of all). Built an empty shim RPM (`Provides: liberation-fonts`, `Requires: liberation-sans-fonts`; spec + rpm kept in `/root/llms-study-shim/`), installed shim + Chrome 153.0.8010.52 via dnf, removed the temporary `rpm-build`; `dnf check` clean, Chrome stays on Google's repo for updates; GPG fingerprint matched Google's key. §10.2 now documents this. `llmrender` (uid/gid 990) can read code + Chrome, is **denied** `api.env`, the data dir and `data.db`. Unit active, caps applied, socket `srw-rw---- llmrender:llmrender` |
| Production render self-test (socket, no user involved) | pass | z.ai article: HTTP 200 in 3.3 s, html 40,446 chars (same as local), 12 Chrome processes incl. 3 zygotes, **0 with `--no-sandbox`** ⇒ the namespace sandbox works under `NoNewPrivileges`; only `node` left afterwards |
| Production SSRF checks | pass, both layers | App layer: `127.0.0.1:8787`, `100.100.100.200`, `file://`, `localhost`, `[::1]`, `169.254.169.254`, `10.0.0.1` all 400/403, none hung. Kernel layer, independent of our code: a process with the unit's user + `IPAddressDeny` cannot reach the metadata IP or the local API (timeouts), while the same user WITHOUT the policy reaches the local API (200) — so the block is the policy |
| Flag ON | done, with backups + auto-rollback guard | Backups `*.bak-20260919-214929-pre-render` of the API unit and `api.env`. On-box API unit was byte-identical to the repo's committed one, so replacing it lost nothing. API healthy 1 s after restart, process groups include gid 990; socket opens for `llmapp`+`llmrender`, refused without the group; public health 200; `render-url` without session 401 |
| **The original URL, on llm-pro.cn, in the user's session** | **imports** | 「已导入「Toward Recursive Self-Improvement: How GLM Built Its Own Inference Infrastructure」」; stored `ready`, `capture.mode = rendered`, 77 blocks, 24,314 chars (identical to local), 18 assets; library 29 → 30; render log shows the 3.1 s production render. Took 43 s because the automation tab was in the background (rAF suspended ⇒ in-page capture waits out its 20 s hard timeout); ~18 s in a foreground tab |
| Production memory | healthy | unit peak 627 MB / current 426 MB of which **339 MB is reclaimable file cache** (Chrome binary + libs), 85 MB anon, 0 shmem; `memory.events`: high 0, max 0, oom 0; `NRestarts=0`; API 46 MB; box 2,868 MB available |
| **Kill switch** | one line | `sed -i '/^RENDER_SERVICE_SOCKET=/d' /etc/llms-study/api.env && systemctl restart llms-study-api` ⇒ `render-url` answers 503 and the app falls back to the honest failure. Full removal: `provision.md` §10.8 |

Not verified anywhere yet (production-only): Linux user-namespace sandbox under `NoNewPrivileges`, systemd `IPAddressDeny/Allow`, Chrome RPM on Alibaba Cloud Linux 4, peak memory vs the 768M cap, socket access across users.

## Context

On https://llm-pro.cn/#/papers, "按 URL 导入" of `https://z.ai/blog/glm-built-its-inference-infrastructure` fails with
「渲染捕获只得到 0 字正文，未能生成网页原貌；可改用「阅读模式」重试」.
Goal: explain why, list the other defects found on the same pipeline, and fix them so this URL imports.
Decision already taken: add a server-side headless-Chromium render fallback ("Tier 3"), plus the bug fixes, plus fast honest failures.

## 1. Root cause (verified first-hand)

- The page is a 2,122-byte Vite/React client-only shell. Body is `<div id="root"></div>`; visible text = 0 chars; no `<noscript>`. The article is compiled into the JS bundle as string literals; no runtime API calls.
- Entry is `<script type="module" crossorigin src="/blog/assets/…js">`. Module scripts are always fetched under CORS. The asset returns 200 with **zero `access-control-*` headers** (checked for `Origin: null` and `Origin: https://llm-pro.cn`).
- "Render capture" (Tier 2) is not a headless browser. It is a hidden `sandbox="allow-scripts"` iframe in the user's browser fed by `srcdoc` (`src/lib/paper/url/captureRendered.ts:131`). Any non-z.ai origin gets the module blocked, React never mounts, `#root` stays empty. Adding `allow-same-origin` would not help (origin would be llm-pro.cn, still cross-origin).
- So Tier 1 static = 0, Tier 2 = 0, reader mode (`extractArticle.ts`, same 200-char floor, runs no JS) = 0. The check at `buildSnapshot.ts:385-392` (`MIN_TOTAL_CHARS = 200`) fires correctly. The floor dates from `7d99619`; `4df4d77` only reworded it.
- Control: headless Chrome on the real URL renders 24,464 chars; headless and desktop UA outputs are byte-identical. `/blog/glm-image` and `/blog/glm-5` are the same shell.
- Ruled out: bot/WAF blocking, path resolution (`<base href=finalUrl>` injected at `captureAgent.ts:684`), Next.js streaming timing, CSS/cookie/region gates, shadow DOM/iframes, third-party host blocking, short wait.

## 2. Other defects (each verified in source)

| # | Defect | Where |
|---|---|---|
| B | Error text and the 「改用阅读模式重试」 button are shown for every snapshot failure. When the fetched HTML has no text, that retry is guaranteed to fail | `buildSnapshot.ts:391`, `UrlImportDialog.tsx:99,237-248` |
| C | Render-vs-static comparison mixes two counting rules: render skips `data-pc-hidden` subtrees, static counts them, so static runs high and can wrongly demote a good render | `buildSnapshot.ts:320-325`, `stampBlocks.ts:39` |
| D | Dead zone: rendered 150 / static 250 fails `250 >= 300`, keeps rendered, hard-fails though static would pass | `buildSnapshot.ts:325` |
| E | Comparison only runs when rendered < 1000 chars; a render that got only nav+footer is never compared | `buildSnapshot.ts:74,321` |
| F | `blockTextTotal` probes with `stampBlocks`, which mutates the document that later ships (low) | `buildSnapshot.ts:286-290` |
| G | `quiesce()` resolves after one 700 ms quiet window; a still-downloading bundle looks identical. Nothing waits for body text | `captureAgent.ts:529-573` |
| H | The job queue hands every job an `AbortSignal` (`ingest.ts:96,129,152`) but it is dropped at `PapersPage.tsx:385`, and there is no cancel control. **Not** "close should cancel": close-keeps-running is a documented decision (`UrlImportDialog.tsx:12-16`, `PapersPage.tsx:170-171`) and stays | `PapersPage.tsx:337-344,385` |
| I | Snapshot limits were meant for dialog + README (`PLAN-web-snapshot-sync.md:151`); README has none; client-rendered pages are listed nowhere | `README.md`, `README.zh-CN.md` |

Out of scope: pre-existing P2 duplication (`toAbs` ×3, `isElement/isText`, `abortError` spellings).

## 3. Fix — Phase A: client only (ships with `deploy.sh --web`, zero infra risk)

**A1. Capture agent v2** — `src/lib/paper/url/captureAgent.ts`
- Make the file zero-import: delete line 1 import and the `:33` re-export (only `captureAgent.test.ts` uses it; point the test at `./stampBlocks`). Change `win?: Window` → `unknown`, `window` → `globalThis` (`:101,104`). Needed for Phase B; harmless now.
- Bug G: add `hasContent()` (sum text nodes under `body`, skip script/style/noscript/template, early-exit at `cfg.minTextChars`). A quiet tick only ends the wait when `hasContent()` is true, or `blockedScripts > 0`, or `cfg.emptyWaitCapMs` elapsed. New defaults `minTextChars: 200`, `emptyWaitCapMs: 10000`.
- Add a capture-phase `error` listener counting failed `<script>` loads → `blockedScripts` on the ok message. This is the measured signal for "scripts blocked cross-origin" and makes the z.ai case fail in seconds instead of 10–28 s (estimate from timers, to be measured).
- Add `collect(): Promise<CaptureAgentMessage>` (resolves an internal sink instead of `parent.postMessage`), for Phase B.
- Bump version to 2 in all three places (`:24`, `:357`, `:385`; kept in sync by `captureAgent.test.ts:134`). Carry `blockedScripts` through `captureRendered.ts:167-175`.
- Tests (existing `fakeWin` pattern): empty body does not finish on first quiet tick; late content finishes promptly; blocked script finishes fast with `blockedScripts: 1`; `collect()` resolves once and never posts; self-containment tests (`captureAgent.test.ts:105-139`) stay green.

**A2. Fair comparison** — `src/lib/paper/url/buildSnapshot.ts` (bugs C, D, E, F)
- Replace `blockTextTotal` with `measure(doc, {ignoreHidden})` that works on a **clone** (fixes F).
- Add exported pure `chooseCapture({rendered, renderedRaw, static})`: static when `rendered < MIN && static >= MIN` (fixes D); static when `static >= MIN && static >= renderedRaw * 2` where `renderedRaw` counts hidden text too (fixes C); else rendered.
- Bug E: always compute a cheap raw body-text length of the fetched HTML; run the full comparison when rendered < 1000 **or** raw static ≥ 2× raw rendered.
- Tests: `chooseCapture` table; 150/250 dead zone; 1,200 vs 50,000 demotion; good render with heavy hidden static text is not demoted; document byte-identical before/after measuring; existing `buildSnapshot.test.ts:248-289` green.

**A3. Honest failure** (bug B)
- `IngestError` gets optional `hint`; `IngestFailure` (`types.ts:40-44`) gets `hint?: 'reader-wont-help'`; copy it in **both** `toFailure` (`ingest.ts:208`, `urlImport.ts:148`). Structured signal, no string matching.
- Set the hint at `buildSnapshot.ts:385-392` when static text is below the floor. Shell-case message: 「该页面正文完全由脚本生成，且其脚本被浏览器跨源策略拦截；阅读模式同样无法抓取」.
- `UrlImportDialog.tsx:99`: hide the reader-retry button when `failure.hint === 'reader-wont-help'`.

**A4. Cancel** (bug H) — explicit 「取消导入」 button while running; closing the dialog still does not cancel.
- Use the queue's signal: `enqueue(jobId, async (signal) => …)`; `loadUrlDeps(jobId, signal)` passes it to `fetchUrl`, `buildWebSnapshot({signal})`, later `captureRemote`. `importSnapshot` rethrows aborts; PapersPage `.catch` stays quiet on abort. Track the job id in a ref → `queueRef.current.cancel(id)`.
- Tests: abort mid-Tier-2 → AbortError, no asset calls; urlImport abort creates no paper row.

**A5. Docs** (bug I) — 已知限制 section in `README.md` + `README.zh-CN.md` (both have unrelated uncommitted edits: merge, do not clobber) and extend `PRESENTATION_HELP` (`UrlImportDialog.tsx:76`): client-rendered pages, shadow DOM, iframes, video, hover-only content.

## 4. Fix — Phase B: Tier 3 server render (behind a flag, default off)

**B0. Go/no-go preflight on the box (read-only).** `uname -m`, `free -m` (need ~1 GB available with API running), `nproc`, `sysctl user.max_user_namespaces` + `unshare -U true` as an unprivileged user, `/etc/resolv.conf`, whether systemd `IPAddressDeny=` works on this kernel. Any failure → stop and report; Phase A still stands.

**Architecture**
- **Separate systemd unit `llms-study-render`, separate Unix user `llmrender`.** The API unit has `MemoryMax=512M` (`deploy/llms-study-api.service:19`); Chromium as its child would share that cgroup. Separate user because the API's env holds `LLM_KEY_MASTER` and the DB is readable by `llmapp`. Own `render.env` with no secrets; the entry must not call `loadConfig()` (`server/src/config.ts:100-103`).
- **Unix socket**, not a TCP port (`RuntimeDirectory=`, mode 0660; API unit gets `SupplementaryGroups=llmrender`).
- **Sandbox on.** Playwright adds `--no-sandbox` unless `chromiumSandbox: true` (`playwright-core/lib/server/chromium/chromium.js:285-286`) — set it and assert it in a test. `NoNewPrivileges=true` rules out the setuid sandbox, hence the userns preflight.
- **Chromium never touches the network.** `context.route('**/*')` fulfils every request from the existing SSRF-hardened fetcher (pinned IP, per-hop revalidation, byte caps, deadline). Extract the loop body of `safeFetchUrl` (`server/src/lib/fetchRaw.ts:258-339`) into exported `safeFetchHop()`; `safeFetchUrl` becomes a loop over it (behaviour unchanged, existing tests cover it). ~~Tier 3 fulfils 30x verbatim so the browser re-requests each hop.~~ **Corrected during implementation (real-browser test):** Playwright auto-continues any request that has `redirectedFrom` WITHOUT calling the route handler, so a fulfilled 30x sends the next hop around the interception. Actual design: a main-document 30x aborts the navigation, the `Location` is re-validated, and the renderer calls `page.goto(next)` itself (URL identity exact, capped at `FETCH_URL_MAX_REDIRECTS`); a subresource 30x is followed hop by hop inside the handler, every hop through `safeFetchHop`, and the final bytes are fulfilled under the original URL (known limit: a redirected module resolves relative imports against the pre-redirect URL). Consequence: the dead proxy below is **load-bearing**, not a backstop — without it a single redirect would bypass all SSRF validation.
- Abort: non-GET, non-http(s), ports ≠ 80/443, types media/font/ping/manifest/eventsource/texttrack. Images → 1×1 placeholder (aborting fires `onerror` handlers); client refetches real images via the asset channel anyway. Synthesize CORS headers on fulfilled responses (context has no credentials); forward only a sanitised `content-type`.
- Backstops: `proxy: { server: 'http://127.0.0.1:9' }` via the Playwright option (it appends `<-loopback>`, `chromium.js:294-303`, so unrouted WebSockets cannot reach localhost); `serviceWorkers: 'block'`; WebRTC policy flag; no downloads/permissions; kernel-level `IPAddressDeny=` for private/link-local/CGNAT ranges on the render unit with `IPAddressAllow=` for the box's DNS resolvers only.
- **One browser per render, crash-only service**: `browser.close()` not done in 5 s → `process.exit(1)`; `Restart=always`, `KillMode=control-group`, `StartLimitBurst` so a crash loop ends as a failed unit and the API answers 503.
- **Reuse the capture agent in the real page** (true origin, real CSS, real computed styles): `page.evaluate('(' + captureAgentMain.toString() + ')(cfg).collect()')` after `goto(waitUntil:'domcontentloaded')`; never wait for `load`/`networkidle` (the probe's `chrome --dump-dom` had the full DOM within milliseconds yet took over 120 s to exit on this page). Compile `captureAgent.ts` into the server via the tsconfig `include` list, the `keyRotation.ts` precedent. Result is untrusted: zod-validate, cap html 8 MB, `validateTargetUrl(finalUrl)`.
- **Tier 3 reports `mode: 'rendered'`.** `webSnapshot.ts:205` rejects any other mode, and old cached clients would fail to decode a synced snapshot.
- Browser binary: `playwright-core` (own, current version in `server/package.json`) + Google Chrome RPM, explicit `RENDER_CHROME_PATH`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. If the box is aarch64, fall back to `chromium-headless-shell`.

**Steps**
- B1 `safeFetchHop` + hop tests (302 not followed, relative Location, 404 passthrough, forbidden DNS denied).
- B2 `shared/apiRoutes.ts` `RENDER_URL_*` (30 s wall clock — must stay under nginx's 60 s default, `deploy/nginx-llm-pro.conf:49-57`; 3 per 5 min per user; global concurrency 1; 200 subrequests; 30 MB total; 12 MB response) and `shared/apiTypes.ts` (`RenderUrlBody/Response`, error code `render-unavailable`).
- B3 `server/src/render/` — `config.ts`, `policy.ts` (pure `decideRequest()` + budgets), `browser.ts` (only file importing playwright-core), `server.ts` (`node:http` on the socket: `POST /render`, `GET /health`, aborts on request close), `index.ts`.
- B4 `server/src/routes/renderUrl.ts` — new route `POST /api/app/render-url` (not a new `kind`: `KindLimits` models raw-byte fetches). `requireSession` → 4 KB body + zod → per-user bucket → global gate (`createConcurrencyGate(1)`, immediate 429, no queue) → `validateTargetUrl` → socket client. Flag = `RENDER_SERVICE_SOCKET` env, absent means off → 503. Tests follow `server/test/fetchUrl.test.ts` with a stub on a temp socket.
- B5 client — `src/lib/paper/url/renderUrlApi.ts` (model on `fetchUrlApi.ts`); `BuildSnapshotDeps.captureRemote`; flow in `capture()`: Tier 2 → `chooseCapture` → if winner < floor and `captureRemote` exists → Tier 3, accepted only if it reaches the floor; 404/503 → the A3 honest error. New phase `remote` (「服务器渲染」) in `SnapshotPhase`/`UrlProgressPhase` (exhaustive Records at `urlImport.ts:140`, `UrlImportDialog.tsx:22` force every site). No markup heuristic to skip Tier 2: many SPAs serve assets with CORS headers and work there for free.
- B6 deploy — `deploy/llms-study-render.service` (`MemoryMax=768M`, `MemorySwapMax=0`, `TasksMax=256`, `ProtectSystem=strict`, `PrivateTmp`), `deploy/provision.md` §10, `scripts/deploy.sh` adds `systemctl try-restart llms-study-render || true`, `server/.env.example`.

**To verify during implementation (flagged unverified by the design review):** default `OOMPolicy` behaviour; that `currentSrc`/srcset survive placeholder images; the Tier 2 fast-fail timing.

## 5. Delivery

1. First action after approval: kill the leftover probe Chrome (`pkill -f scratchpad/chrome-profile`), then save this plan as new `PLAN-url-import-csr-render.md` in the repo root (existing PLAN docs untouched). Also save a memory: URL-pipeline changes are verified against every URL in the user's library, not a sample.
1b. **Before any code change: build the sweep script and record the baseline** on the current code (§6). Without a same-day baseline, a later failure cannot be told apart from an upstream site change.
2. Implement via dedicated subagents in waves split by file ownership. Wave 1: A1 (`captureAgent*`) ∥ A3+A4+A5 (dialog/page/types/docs); then A2 (`buildSnapshot*`, depends on A1's message shape). Wave 2: B1+B2 → B3 ∥ B4 → B5 → B6.
3. Gate per wave: `npm run typecheck && npm test` in root and `server/`, plus build.
4. E2E QA via codex CLI (detached, per the standing workflow), fix agreed P0/P1, max 3 rounds.
5. No commits unless asked; if asked, branch off `main` and stage only this feature's files (the working tree has unrelated uncommitted agent-rl work).
6. **Every production action waits for an explicit go**: Phase A deploy, B0 preflight over ssh, provisioning, turning the flag on.

## 6. Verification

### 6a. Full-library regression sweep (every URL already imported)

A1 and A2 change how **every** page is captured and how render-vs-static is chosen, so the test set is the whole library, not a sample. Read read-only from the production IndexedDB (`paper-copilot-u1`, store `papers`, `source.entries` + `source.capture`) on 2026-09-19: 28 rows = 4 PDF uploads + **24 URL imports** (5 rendered snapshot, 1 static snapshot, 18 reader mode). The page showed 29, so the list is re-dumped right before the baseline run; nothing is hardcoded.

| Original mode | URLs (host + path; `[+q]` = has a query string) |
|---|---|
| snapshot, rendered (5) | docs.sglang.io/docs/advanced_features/{sgl_model_gateway, pd_disaggregation, hicache_design} · lmsys.org/blog/2025-09-10-sglang-hicache · openvdn.github.io |
| snapshot, static (1) | openai.com/index/research-acceleration-view-inside-openai |
| reader (18) | vllm.ai/blog/2026-07-23-glm-5.2-nvfp4-b300-pd · docs.nvidia.com/…/ai-factory-white-paper/latest/{ecosystem-architecture, ai-factory-overview}.html · developer.nvidia.com/blog/dynosim-simulating-the-pareto-frontier `[+q]` · arxiv.org/html/{2606.30560v1, 2601.06288v1} · huggingface.co/learn/diffusion-course/en/unit1/1 · huggingface.co/MiniMaxAI/MiniMax-H3 · docs.sglang.io/docs/sglang-diffusion/performance-optimization · docs.sglang.io/cookbook/diffusion/MiniMax/MiniMax-H3 · docs.sglang.io/cookbook/autoregressive/Moonshotai/Kimi-K3 · s201.q4cdn.com/…Q2-2027-Earnings-Call….pdf (direct PDF) · openai.com/index/path-to-astra · fireworks.ai/blog/DeepSeekV4Pro-Fable5 · mp.weixin.qq.com/s/PY3KJuUyhPdwvCQGOlRvHg · minimax.io/blog/minimax-h3 · recipes.vllm.ai/moonshotai/Kimi-K3 `[+q]` · lmsys.org/blog/2026-08-27-minimax-h3-h200 |

Plus the new positive cases: the 3 z.ai blog posts (`glm-built-its-inference-infrastructure`, `glm-image`, `glm-5`).

**How**
- New `.e2e-qa-fixtures/url-regression-sweep.mjs`, extending the existing Playwright-chromium harness (`.e2e-qa-fixtures/web-snapshot-e2e.mjs`: local dev at `localhost:5173`, `qa_img` account, tracks and deletes the papers it creates). Tier 2 needs a real browser, so this cannot be a unit test.
- **Never run against the production library**: re-import there wipes highlights and translation caches (`PapersPage.tsx:430-432`). QA account only; each created paper is deleted before the next URL, since dedupe by `finalUrl` would otherwise block the second pass.
- The URL list file holds your reading list: it stays in `.e2e-qa-fixtures/` (not gitignored today) and is never staged. The two `[+q]` URLs are run without their query string unless you give me the full URLs (the browser tool redacts query strings); baseline and after-runs use the same list, so comparisons stay valid.
- Each URL runs in its **original mode**, and every reader-mode URL additionally runs in **snapshot mode**, because snapshot is the default and is what this plan changes. WeChat and the direct PDF route the same way in both modes, so ≈ 40 imports per pass, sequential, ≈ 15–25 min.
- Recorded per run: outcome, failure message, `capture.mode`, `renderFallback`, block count, total chars, assets/skipped, duration, Tier 3 call count, and a screenshot of the reader view into `.e2e-qa-fixtures/shots-url-regression/`.
- Three passes: **baseline** (current code, before any change) → **after Phase A** → **after Phase B with the flag on**. A failing run is retried once before it is classified (WeChat captcha and IP blocks are upstream noise).

**Pass criteria, after vs baseline**
1. No URL that succeeded at baseline fails after.
2. Chars and blocks ≥ 90 % of baseline. Larger drops go to manual review, not auto-fail, because live pages drift.
3. `rendered → static` is only acceptable with a `renderFallback` reason and a manual look; `static → rendered` is fine.
4. Anything that already failed at baseline is reported as-is, with the new message.
5. Phase B: Tier 3 call count is **0** for every URL that succeeds without it. Only the z.ai posts may trigger it.
6. No URL more than ~10 s slower than baseline (A1's `emptyWaitCapMs` is the thing to watch).
7. Screenshots of the 6 original snapshot papers look the same as they do in production today.

Observed, not in scope: two existing snapshots skipped many assets (lmsys hicache 55, openai static 86). The sweep records `skipped` so any change shows up.

### 6b. Targeted checks

- z.ai, render service against local Chrome: imports with `mode: 'rendered'`, ≥ 20,000 chars, phase trail 渲染页面 → 服务器渲染; `ps` shows no `--no-sandbox`.
- Flag off: same URL fails in seconds with the honest message and **no** reader-retry button.
- Cancel mid-render leaves no paper row and no failure notice; closing the dialog still does not cancel.
- Security spot checks against the render service: `http://127.0.0.1:8787`, `http://100.100.100.200/`, a public URL 302-ing to a private IP, `file:///etc/passwd` → all denied.
- Production smoke after each deploy (on your go): only the z.ai URL, which you want imported anyway. Existing library URLs would just hit the duplicate panel.

## 7. Rollout / rollback

Phase A `deploy.sh --web` → Phase B code with flag off (server, then web) → B0 preflight → provision (Chrome repo, `llmrender`, unit, `render.env`) → `curl --unix-socket … /health` → add `RENDER_SERVICE_SOCKET` to `api.env` + `SupplementaryGroups`, restart → test the z.ai URL in production.
Rollback: remove the env line and restart the API (instant kill switch) → `systemctl disable --now llms-study-render` → `.bak` dir swap per `provision.md` §7.
