# LLM Infra Studio

**English** | [简体中文](README.zh-CN.md)

An interactive, visual **AI learning & coaching companion** for LLM infrastructure — model architecture evolution, the inference serving pipeline, agent architecture, graded pre-sales practice drills, and an AI paper-reading copilot. Built for people selling, operating, or just seriously learning large-model infrastructure.

**Live site: [llm-pro.cn](https://llm-pro.cn)**

Everything runs local-first: your notes, papers, and practice history stay in your browser (IndexedDB) unless you sign in, in which case they sync to your account across devices.

## Modules

| Module | Route | What you get |
|---|---|---|
| **Architecture Evolution** | `/architecture` | Classic Transformer interactive diagram (QKV animation, encoder-decoder view) → modern frontier models (DeepSeek V3/V4, Kimi K3, GLM-5/5.2, Qwen3); attention mechanism evolution (MHA → GQA → MLA → DSA / KDA / CSA-HCA); model API pricing comparison |
| **KDA Deep-dive** | `/kda` | Interactive step-by-step derivation of Kimi Delta Attention with live numeric scenarios (linked from the attention evolution table) |
| **Inference Pipeline** | `/inference` | KPI panorama and AIPerf benchmark analysis, full serving stack, 7-architecture atlas, prompt lifecycle simulation, **VRAM-wall calculator**, and token economics |
| **Agent Architecture** | `/agent` | Annotated agent architecture diagram — where the base model sits, where the harness boundary is |
| **Pre-sales Trainer** | `/interview` | Rubric-based question bank (must-cover points + red flags per question), answers graded live by an LLM, voice input, mastery dashboard, attempt history |
| **Paper Copilot** | `/papers` | Import PDF/DOCX papers, read in original PDF or semantic text view, select-to-ask, streaming AI copilot with citations, reading progress; guest-local by default, account sync when signed in |

## Engineering highlights

- **Data-driven extensibility.** All content — models, hardware, attention stages, questions, pricing — is typed data under `src/data/`; components only render. Adding a model or question means appending one object, no component changes. See [EXTENDING.md](EXTENDING.md).
- **No fake precision.** The sim engine (`src/lib/simEngine.ts`) is pure functions with unit tests against known worked examples. Architectures without public formula parameters (DSA, KDA, …) are explicitly marked "no numeric estimate" and show official relative metrics only. Volatile facts (prices, specs) carry `sourceUrl` + `asOf`.
- **Benchmark provenance stays visible.** The inference KPI workbench keeps business targets, roofline estimates, and imported AIPerf measurements as distinct value types. AIPerf summary/sweep/server-metrics JSON or CSV is parsed entirely in the browser and is never uploaded or persisted.
- **Keys never reach the client bundle.** LLM calls go through an allowlisted proxy (`/api/moonshot`, `/api/zhipu`, `/api/deepseek`, `/api/openai-compat`) to a backend gateway that injects credentials, with multi-key ordered failover (invalid keys evicted, quota/rate-limited keys cooled down — `src/lib/keyRotation.ts`).
- **iOS WebKit PDF compatibility layer.** pdf.js v6 depends on three JS features WebKit hasn't shipped (ReadableStream async iteration, `Map.getOrInsertComputed`, `Uint8Array.toHex/toBase64`). `src/lib/paper/pdfCompat.ts` shims them on both the main thread and — via a wrapper worker entry — inside the pdf.js worker. Regressions are guarded by a Playwright dual-engine harness: `node scripts/webkit-pdf-repro.mjs` (WebKit + Chromium, self-hosting dev server, seeds a fixture paper, asserts rendered canvas pixels and the 390 px mobile layout).
- **Build-time feature flag with zero leakage.** `VITE_ENABLE_PAPER_COPILOT` gates the whole paper subtree; flag-off builds virtualize those modules so not a single paper chunk or pdf.js asset ships.
- **Mobile-adapted.** Responsive layouts with 44 px touch targets; desktop/tablet (`md+`) rendering kept byte-identical when mobile classes are added.

## Architecture

```
Browser (React 18 + Vite + TS + Tailwind v4 + zustand)
  ├─ src/data/        typed content (models, hardware, questions, pricing…)
  ├─ src/lib/         pure engines: simEngine, grading, keyRotation, paper/(ingest, sync, pdfCompat…)
  ├─ src/pages/       architecture / inference / agent / kda / interview / papers / settings
  └─ IndexedDB (dexie): papers, blocks, chunks, progress — local-first
        │  /api/app/*  (auth, sync)          /api/{provider}/*  (LLM gateway)
        ▼
server/ (Hono + SQLite)
  auth (sessions) · paper artifact sync · original-file store · LLM key gateway
  with rotation & rate limits · admin · health
```

## Getting started

```bash
npm install
npm run dev          # web app on http://localhost:5173
```

The paper copilot is enabled by default in dev (`.env.development.local` sets `VITE_ENABLE_PAPER_COPILOT=1`). Grading and the copilot need an LLM key — paste one in **Settings** (sent per-request via `X-User-Key`; signed-in users can also save it to their account, stored AES-256-GCM-encrypted with only the last 4 characters ever echoed back), or run the backend gateway with server-side keys:

```bash
cd server
npm install
cp .env.example .env   # fill provider keys
npm run dev            # gateway on http://localhost:8787 (vite proxies /api/* to it)
```

### Quality gates

```bash
npm run typecheck                      # tsc --noEmit
npx vitest run                         # 720+ unit tests (web)
cd server && npx vitest run            # backend suite
npm run build                          # flag-on production build
VITE_ENABLE_PAPER_COPILOT= npm run build   # flag-off build (must also pass)
node scripts/webkit-pdf-repro.mjs      # WebKit/Chromium PDF + mobile-layout regression
```

## Deployment

```bash
scripts/deploy.sh --web      # static site (build self-check → tar upload → atomic swap, keeps 2 backups)
scripts/deploy.sh --server   # backend API
scripts/deploy.sh --all      # both
```

Infra config (nginx, systemd unit, backup cron) lives in [`deploy/`](deploy/).

## Repository layout

```
src/            web app (pages, components, data, lib)
server/         account/sync/LLM-gateway backend (Hono + SQLite)
shared/         API routes & types shared between web and server
scripts/        deploy.sh · webkit-pdf-repro.mjs · paper-eval/ (copilot eval harness)
deploy/         nginx / systemd / backup provisioning
PLAN*.md        design docs per delivered feature (accounts sync, paper copilot, mobile, …)
EXTENDING.md    how to add models / hardware / questions / formulas without touching components
```

## Disclaimer

Built-in throughput/latency/VRAM numbers are **illustrative estimates from documented formulas, not benchmarks**, and the UI labels them as such. Imported AIPerf runs remain explicitly marked as measured data with their workload and run provenance. Model specs and prices carry their source URL and as-of date; verify against official sources before quoting them in the field.
