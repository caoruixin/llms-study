# LLM Infra Studio

[English](README.md) | **简体中文**

一个围绕**大模型基础设施**的交互式可视化 **AI 学习与陪练**应用——模型架构演进、推理服务链路、Agent 架构、带评分的售前陪练,以及 AI 论文陪读。为售卖、运营或认真学习大模型 Infra 的人而做。

**在线站点:[llm-pro.cn](https://llm-pro.cn)**

一切本地优先:笔记、论文、陪练记录默认只存在浏览器(IndexedDB);登录后自动同步到账号,跨设备可用。

## 功能模块

| 模块 | 路由 | 内容 |
|---|---|---|
| **架构演进** | `/architecture` | 经典 Transformer 交互图解(QKV 动画、encoder-decoder 视图)→ 前沿模型(DeepSeek V3/V4、Kimi K3、GLM-5/5.2、Qwen3);注意力机制演进(MHA → GQA → MLA → DSA / KDA / CSA-HCA);模型 API 价格横评 |
| **KDA 拆解** | `/kda` | Kimi Delta Attention 分步推导 + 实时数值场景(入口在注意力演进表的「交互式拆解」链接) |
| **推理链路** | `/inference` | KPI 全景图与 AIPerf Benchmark 分析、全链路四层、7 类推理架构图谱、Prompt 生命周期、**显存墙计算器**与 Token 经济 |
| **Agent 架构** | `/agent` | Agent 架构标注图——基础模型在哪里,Harness 边界在哪里 |
| **售前陪练** | `/interview` | rubric 题库(每题带必答点 + 红线),LLM 实时评分,语音作答,掌握度仪表盘,答题历史 |
| **论文陪读** | `/papers` | 导入 PDF/DOCX,原版 PDF / 语义文本双视图,选段提问,流式 AI 陪读(带引用),阅读进度;游客本地优先,登录后账号同步 |

## 工程亮点

- **数据驱动的扩展性。** 所有内容——模型、硬件、注意力阶段、题目、价格——都是 `src/data/` 下的类型化数据,组件只负责渲染。加一个模型或题目就是往数组里加一个对象,不碰组件。见 [EXTENDING.md](EXTENDING.md)。
- **拒绝伪精确。** 模拟引擎(`src/lib/simEngine.ts`)是纯函数,配已知算例单测。没有公开公式参数的架构(DSA、KDA 等)显式标注「不支持数值估算」,只展示官方相对指标。易变事实(价格/规格)必须带 `sourceUrl` + `asOf`。
- **Benchmark 来源始终可见。** 推理 KPI 工作台把业务目标、roofline 示意估算和 AIPerf 实测值建模为三种不同类型。AIPerf 汇总/Sweep/server-metrics JSON 或 CSV 全部在浏览器内解析，不上传、不持久化。
- **Key 永不进前端产物。** LLM 调用走固定 allowlist 代理(`/api/moonshot`、`/api/zhipu`、`/api/deepseek`、`/api/openai-compat`)到后端网关注入凭据,多 key 按序故障转移(无效 key 永久剔除、配额/限流 key 冷却——`src/lib/keyRotation.ts`)。
- **iOS WebKit 的 PDF 兼容层。** pdf.js v6 依赖三个 WebKit 尚未实现的 JS 特性(ReadableStream 异步迭代、`Map.getOrInsertComputed`、`Uint8Array.toHex/toBase64`)。`src/lib/paper/pdfCompat.ts` 在主线程与(经包装 worker 入口)pdf.js worker 线程内补齐 shim。回归由 Playwright 双引擎脚本守护:`node scripts/webkit-pdf-repro.mjs`(WebKit + Chromium,自起 dev server、种入 fixture 论文、断言 canvas 真实像素与 390px 移动布局)。
- **构建期特性开关,零泄漏。** `VITE_ENABLE_PAPER_COPILOT` 门控整棵论文子树;flag-off 构建把相关模块虚模块化,产物中不含任何论文 chunk 或 pdf.js 资产。
- **移动端适配。** 响应式布局 + 44px 触控热区;新增移动类时桌面/平板(`md+`)渲染逐字节保持不变。

## 架构

```
浏览器(React 18 + Vite + TS + Tailwind v4 + zustand)
  ├─ src/data/        类型化内容(模型、硬件、题库、价格…)
  ├─ src/lib/         纯函数引擎:simEngine、grading、keyRotation、paper/(ingest、sync、pdfCompat…)
  ├─ src/pages/       architecture / inference / agent / kda / interview / papers / settings
  └─ IndexedDB(dexie):论文、正文块、chunk、进度——本地优先
        │  /api/app/*(鉴权、同步)      /api/{provider}/*(LLM 网关)
        ▼
server/(Hono + SQLite)
  会话鉴权 · 论文制品同步 · 原始文件存储 · LLM key 网关(轮换 + 限流)· admin · health
```

## 快速开始

```bash
npm install
npm run dev          # Web 应用:http://localhost:5173
```

dev 下论文陪读默认开启(`.env.development.local` 里 `VITE_ENABLE_PAPER_COPILOT=1`)。评分与陪读需要 LLM key——在**设置页**粘贴(每次请求经 `X-User-Key` 传递;登录用户也可保存到账号,AES-256-GCM 加密落库、任何接口只回显末 4 位),或用服务端 key 启动后端网关:

```bash
cd server
npm install
cp .env.example .env   # 填入各 provider 的 key
npm run dev            # 网关:http://localhost:8787(vite 把 /api/* 代理过去)
```

### 质量门禁

```bash
npm run typecheck                      # tsc --noEmit
npx vitest run                         # 720+ 前端单测
cd server && npx vitest run            # 后端测试
npm run build                          # flag-on 生产构建
VITE_ENABLE_PAPER_COPILOT= npm run build   # flag-off 构建(必须同样通过)
node scripts/webkit-pdf-repro.mjs      # WebKit/Chromium 的 PDF + 移动布局回归
```

## 部署

```bash
scripts/deploy.sh --web      # 静态站(构建自检 → tar 上传 → 原子切换,保留 2 份备份)
scripts/deploy.sh --server   # 后端 API
scripts/deploy.sh --all      # 两者
```

基础设施配置(nginx、systemd、备份 cron)见 [`deploy/`](deploy/)。

## 仓库结构

```
src/            Web 应用(pages、components、data、lib)
server/         账号/同步/LLM 网关后端(Hono + SQLite)
shared/         前后端共享的 API 路由与类型
scripts/        deploy.sh · webkit-pdf-repro.mjs · paper-eval/(陪读评测框架)
deploy/         nginx / systemd / 备份 供给配置
PLAN*.md        各已交付特性的设计文档(账号同步、论文陪读、移动端…)
EXTENDING.md    如何不碰组件地新增模型/硬件/题目/公式
```

## 免责声明

内置吞吐/时延/显存数字都是**基于公式的示意估算,不是实测 benchmark**,UI 中均已标注。导入的 AIPerf 结果会单独标为实测并保留负载/运行口径。模型规格与价格带来源 URL 和更新日期;对外引用前请以官方来源为准。
