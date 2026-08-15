# 账号体系 + 论文库跨设备同步 + LLM 网关收口

> **上线记录(2026-08-14)**:全部阶段已交付并上线。前端 704 测例 / 服务端 78 测例全绿;
> 两轮浏览器 E2E(双源双设备)后 0 P0/P1。生产验证:静态站 200、`/api/app/health` 200、
> 未登录 LLM 401(公开代理漏洞封死)、admin SSE 流式与 Jina 服务端双 key 轮换全通。
> ECS 预配按 deploy/provision.md 执行(系统实为 alinux4/RHEL 系,checklist 已修正);
> nginx 翻转备份 `llms-study.conf.bak-*-preflip`。遗留 P2/P3(不阻塞):配额 413 无前端提示、
> 失败轮次残留孤儿 user 消息且新开会话不接续、登出后已认领论文的游客副本可重复认领、
> paper-eval harness 现需带登录态跑(待接 admin 登录步骤)。

## Context

当前站点(llm-pro.cn)是纯静态 SPA:论文陪读的全部数据(原始文件≤50MB、解析产物、对话、进度、画像)存在浏览器 IndexedDB,换设备/浏览器就要重传重解析,手机上传尤其不便。同时 `/api/deepseek` 等 5 条 nginx LLM 反代是**无鉴权公开代理**(注入服务端 key,仅按 IP 限流),任何人可烧服务端额度——这是已知漏洞。

本次目标:新建后端(Node + SQLite,同 ECS),引入邀请码注册账号;论文数据按账号隔离、跨设备同步("数据跟账号走");LLM 调用一律要求登录态并在服务端注入 key(admin → 服务端 key,普通用户 → 本人 key 加密存服务端),顺势封死公开代理漏洞。只读功能(教程页、本地论文阅读、BM25 搜索)不要求登录。

### 已定决策(与用户确认)
| 决策点 | 结论 |
|---|---|
| 后端 | Node 22 + **Hono** + better-sqlite3(WAL),systemd 单进程,nginx 反代 `127.0.0.1:8787` |
| 注册 | 用户名+密码+**邀请码**(admin 生成);admin 由 env 种子创建(仅空表时) |
| 用户 key | AES-256-GCM 加密存服务端,跟账号走;未登录一律不能调 LLM;面试页"未登录+自带 key"口子取消 |
| 同步范围 | papers/files/blocks/briefs/sessions/messages/conceptStates/evidence/usage 全同步;**chunks 不同步**(blocks 确定性派生物,换设备本地重建,复用现有 `buildPaperIndex` 路径);jobs 不同步(设备瞬态);consents 留本地(知情同意语义按设备);面试历史 llm-infra-history v1 不同步 |
| 鉴权 | 服务端 session + httpOnly cookie(`sid`,Secure+SameSite=Lax+30 天滑动),否决 JWT;密码 argon2id(`@node-rs/argon2`);CSRF = SameSite=Lax + 非 GET 校验 Origin 头 |
| LLM 路由 | **URL 形状不变**:`/api/{deepseek,moonshot,zhipu,jina,openai-compat}/*` nginx 从直连上游改指后端;前端 `proxyPrefix` 常量零改动。新后端业务路由统一前缀 `/api/app/*` |
| 一致性模型 | 本地优先(IndexedDB)+ outbox 后台推 + 打开时拉;服务端全局 **seq 游标**(否决 updatedAt 游标);逐记录 LWW + `progress.maxBlockIndex` 取 max 特例 |

## 任务 0(立即执行,先于大功能各 Phase):Jina 多 key 配置与按序故障转移

用户提供两个新 Jina key,要求:配置进 env;支持 key 列表,请求时逐个尝试,直到全部"invalid 或 out of quota"才最终报错。

- **env**(`.env.local`,gitignored):新增 `JINA_API_KEYS=jina_592f5cd60f5a4be98567fd8fa5bd3422dMZk83JiyZnP-bIeinzVgsISwCA7,jina_82257af3bfcc42a4b3d15351b6c0626eGh59x55Qd-Vst3Q0QknOdKm83xvx`(逗号分隔,依序 failover);同时把 `JINA_API_KEY` 更新为第一个新 key(兼容任何单 key 读取路径)。`.env.example` 增加 `JINA_API_KEYS=` 及注释。
- **轮换逻辑**(纯函数,新增 `src/lib/keyRotation.ts` + `src/lib/keyRotation.test.ts`,vitest include 已覆盖 src/**):`createKeyRotator(keys)` —— 粘性当前 key;失败分类:401/403 = invalid(本进程内标记死亡)、402/429 = quota/限流(冷却 60s 后可重试);当前 key 失败则顺延下一个;全部不可用 → 透出最后一次上游错误。
- **接入点(dev/preview)**:`vite.config.ts` 中 `/api/jina` 从 http-proxy 路由改为自定义中间件(`configureServer` + `configurePreviewServer`):缓冲请求体(Jina embeddings/rerank 均为小 JSON、非流式)→ 按 rotator 依序 fetch 上游,失败换 key 重试同一请求 → 成功则透传响应。`X-User-Key` 存在时仍优先且不轮换(保持现有语义)。其余 4 条 LLM 路由不动(流式请求无法在代理内安全重试;它们的多 key 轮换随后端网关落地)。
- **prod 衔接**:nginx 目前注入单个 Jina key,rerank 尚未在生产启用,风险低;手工把 ECS nginx 的 Jina key 更新为新 key1 即可。真正的多 key 轮换在 P2 后端网关统一实现:服务端 env 改为 `SERVER_*_KEYS` 列表,`server/src/llm/gateway.ts` 复用同一 rotator(非流式请求代理内重试;流式请求 lazy 轮换——本次失败标记,下次请求换 key)。
- **验证**:vitest 覆盖 rotator 状态机(invalid 永久剔除/quota 冷却/全灭透错);dev 起服后请求 `/api/jina/v1/embeddings`,人为把 key1 改错→自动落到 key2 成功;两个都改错→返回上游错误。

## 架构总览

```
浏览器 SPA(HashRouter,同源,cookie 自动携带)
  │ /api/app/*                    账号/同步/文件
  │ /api/deepseek/* 等(不变)      LLM
  ▼
nginx ── / → /var/www/llms-study(静态,不变)
      ── /api/app/ → 127.0.0.1:8787(client_max_body_size:files 路径 60m,其余 1m)
      ── /api/{5 provider}/ → 127.0.0.1:8787(proxy_buffering off, read_timeout 300s,IP 限流放宽 30r/m)
  ▼
Hono 后端(systemd: llms-study-api,用户 llmapp)
  ├ auth:session + argon2id + 邀请码
  ├ llm gateway:requireSession → 按用户注入 key → SSE/JSON 流式透传(allowlist path,仅 POST,body≤2MB)
  ├ sync:sync_records(JSON 文档表,全局 seq)+ 磁盘文件
  └ /var/lib/llms-study/{data.db, files/{userId}/{paperId}.bin}
```

**核心原则:服务端不理解论文业务**。解析/检索/画像全留前端;后端只做账号、按用户注入 key 的 LLM 透传、按账号隔离的制品存储。同步域用单张 JSON 文档表吸收前端"只加字段"的演进,零 schema 联动。

## 服务端 Schema 要点(migration 001/002)

- `users`(username UNIQUE NOCASE、argon2id PHC、role admin/user、disabled、storage_quota_bytes 默认 2GB、storage_used_bytes 事务内增量维护)
- `invite_codes`(一次性 16 字符、created_by、expires_at、used_by/used_at,注册事务内消耗)
- `sessions`(256-bit 随机 id、滑动过期、改密吊销其它会话、登录轮换 id)
- `user_llm_keys`(PK=user_id+provider;AES-256-GCM,iv∥tag∥ct 拼接,AAD=`userId:provider` 防密文移植;主密钥 `LLM_KEY_MASTER` 在 `/etc/llms-study/api.env` 0600;响应永远只回 last4)
- `llm_call_log`(user/provider/model/key_source/status/latency,不含内容,审计+限流)
- `sync_records`(PK=user_id+tbl+id;tbl ∈ 8 张业务表;paper_id 冗余列做级联;payload JSON 原文;**seq 全局单调递增**;deleted 墓碑,90 天 GC;bytes_size 配额记账;索引 `(user_id,seq)`、`(user_id,paper_id)`)
- `stored_files`(PK=user_id+paper_id;sha256/byte_size/mime);字节存磁盘 `files/{userId}/{paperId}.bin`,tmp+rename 原子写,不入 SQLite blob

## API 摘要(`/api/app` 前缀,除 health/login/register 均需登录)

```
POST /auth/register {username,password,inviteCode}   POST /auth/login   POST /auth/logout
GET  /auth/me → {id,username,role,quota,usedBytes,llmKeys:{deepseek:{last4}|null,...}}
POST /auth/change-password(改后吊销其它 session)
PUT/DELETE /me/llm-keys/:provider
POST/GET /admin/invites   GET /admin/users   PATCH /admin/users/:id   POST /admin/recount-quota
GET  /health(无鉴权,部署自检)

POST /sync/push {changes:[{tbl,id,paperId,deleted?,payload?}]}(≤500 条/≤8MB;服务端赋 seq;
     目标 paper 已墓碑 → 该条回 'paper-deleted';resp 含 applied/rejected/cursor)
GET  /sync/changes?since={seq}&limit=1000 → {changes,nextSince,hasMore}
GET  /sync/snapshot(存活 (tbl,id,seq) 清单,长期离线设备对账)
DELETE /sync/papers/:paperId(物理删子记录+文件,papers 行写墓碑)
PUT  /files/:paperId(raw bytes + X-File-Sha256;sha256 相同短路 200;配额预检 413)
GET  /files/:paperId(ETag=sha256,If-None-Match)
```

LLM 网关:`401 {error:'unauthenticated'}` = 未登录;`403 + X-LLM-Deny: no-user-key` = 已登录但该 provider 未配 key;strip 入站 Authorization/X-User-Key;SSE 透传带 `X-Accel-Buffering: no`,禁 compression;Node server `requestTimeout=0`。限流:nginx IP 维度粗防护 + 后端每用户令牌桶(与前端 `PAPER_RATE_LIMIT` 同参)+ 每用户并发 SSE ≤3 + admin 服务端 key 可选日上限。

## 前端集成要点

- **authStore**(`src/lib/auth/authStore.ts`,不 persist,cookie 是唯一真相):status unknown/anon/authed;启动 `GET /auth/me`;`visibilitychange` 回前台 30s 节流 re-check;`BroadcastChannel('auth')` 多标签页同步;`requireLogin(reason)` promise-gate(复用 CopilotPanel GateRequest 交互范式)。
- **UI**:不做 /login 路由(HashRouter 下无服务端重定向,全部"操作时弹窗拦截")。header `UserMenu` + 全局 `LoginDialog`(登录/注册双 tab);SettingsPage 增加:账号区块、每 provider key 管理(last4/保存/清除;admin 显示"使用站点服务端 key")、admin 区块(生成/查看邀请码、用户列表)、"清除本地缓存/重新认领"入口;删除原 sessionStorage key 区块。
- **拦截点仅 3 类**:上传/替换导入(`PapersPage.handleFiles`/`replaceDuplicate` 首行 `requireLogin('upload')`)、LLM 发送(401 兜底 + anon 时按钮旁提示)、认领/同步动作。只读路径零拦截。
- **仓储切换 = 装饰器 + outbox,3 个 repo 接口与 4 个调用点语义不变**:`createSyncedXxxRepository(local, outbox, isAuthed)` 先写本地再入队(`isAuthed` 调用时读取);读方法全部本地直读 → **工作台打开速度不变**。ingest 状态机零改动,`markReady` 落 `push-artifacts` outbox 项(ready 后一次性后台推,不做边解析边推)。4 处 `useMemo(() => createXxxRepository(getPaperDb()), [])` 收敛为 `src/lib/paper/repo/repos.ts` 单例工厂。
- **Dexie version(2)**(纯加法):`outbox: '++seq, op, paperId'` + `syncMeta: 'paperId'`(ownerId/artifactsPushed/blocksPulled/游标);登录后按账号分库 `paper-copilot-u{userId}`,游客沿用 `paper-copilot`。
- **SyncEngine**(`src/lib/paper/sync/syncEngine.ts`):Web Lock `'paper-sync'` 领导者选举防双 tab 双推;push loop 批量合并(progress 同 paperId 只留最新 ~5s 推一次;messages/evidence/usage 攒批≤50)、指数退避、401 停机 + refresh;pull on open(列表页拉 papers LWW 合并;工作台按 since 游标增量拉 state);`pagehide` 用 `keepalive` fetch 兜底推 progress。**bootstrap 必须在 paper 懒加载边界内**(PapersPage/Workbench 内挂),避免 flag-off 构建被 `paperCopilotOffPlugin` 误伤;auth 模块放 `src/lib/auth/`(不在被虚模块化目录)。
- **换设备**:拉 papers 列表即全量可见 → 打开某篇发现 blocks 为空 → 分页拉 blocks → 现有"chunks 缺失补建"effect 自动重建索引 → 原版 PDF 字节按需懒拉。
- **认领**:登录后扫描无 ownerId 的本地论文 → `ClaimBanner`"本地 N 篇未同步 → 全部同步到账号";序列幂等(每步 HEAD)可断点续推;**sha256 撞车 v1 收敛策略**:提示"账号已有同篇",只合并进度(LWW),会话不迁移。登出不清本地;切换账号时过滤隐藏 `ownerId≠当前用户` 的缓存。
- **LLM 链改造**:`llmClient.ts` 删 `userKey`/`X-User-Key`,`throwForHttpStatus` 拆 401/403(加法字段 `code: 'unauthenticated'|'no-user-key'`);三处错误面板(CopilotPanel `friendlyTurnError`、InterviewPage、SelectionAsk)分支引导:未登录 → 弹登录并用 `lastParamsRef` 自动重试;无 key → "去设置页配 key"链接;`store.ts` 删 userKey 状态 + 启动清理 `sessionStorage.removeItem('llm-user-key')`。`vite.config.ts` dev 代理:`/api/app` 与 5 条 LLM 前缀全部指向 `localhost:8787`(dev 拓扑 = 生产)。

## 需求漏洞分析(用户要求的 gap 清单,已纳入方案)

1. **"前端拦截登录"必须配服务端强制**——否则公开代理漏洞依旧。方案:鉴权在后端网关,nginx 翻转即封死;前端拦截只是体验层。
2. **用户 key 托管责任**:加密存储 + 只回 last4 + 可随时删除 + UI 明示"加密保存于服务器";残余风险 = 拿到 ECS root 可解密(单机架构固有边界,文档化)。
3. **公网开放注册刷存储**:邀请码 + 每账号 2GB 配额 + admin 可禁用用户。
4. **切换窗口**:nginx 翻转瞬间,现存未登录用户的 LLM 功能立断(预期,即收口对象);教程页/本地阅读不受影响。**切换顺序必须:后端上线 → 前端发版 → 最后翻 nginx**。
5. **同浏览器多账号串门**:按 userId 分库 + ownerId 过滤。
6. **admin 服务端 key 账单风险**:llm_call_log 审计 + 可选日上限 + DeepSeek 后台消费告警。

## 其余关键风险与缓解(实施时注意)

SSE 双层 buffering(`X-Accel-Buffering:no` + `proxy_buffering off` 双保险,`curl -N` 验证逐帧)| SQLite 并发(WAL+busy_timeout,批量 upsert≤500 行/事务,文件 IO 不进事务)| 50MB 上传(location 级 60m + `proxy_request_buffering off` + Content-Length 配额预检 + tmp/rename)| 并发写冲突(不可变制品/append-only UUID 天然免疫;仅 progress/conceptStates LWW + maxBlockIndex 取 max)| 登录爆破(IP+用户名双限流、恒时比较、dummy 哈希)| 墓碑 GC vs 长离线(90 天 + /sync/snapshot 对账)| usage/evidence 无限增长(每用户每表行数上限滚动裁剪走墓碑)| admin 种子密码(仅空表生效,首登提示改密)。

## 实施阶段(每阶段可独立验证/上线)

### P0 后端骨架 + 运维底座(不动线上行为)
新增:`shared/{apiTypes,apiRoutes}.ts`;`server/`(package.json、tsconfig、src/{index,app,config}.ts、db/{db,migrate}.ts、db/migrations/001_init.sql、routes/health.ts、test/);`deploy/{llms-study-api.service, nginx-llm-pro.conf(目标态留档), provision.md}`。
改:`scripts/deploy.sh`(加 `--server|--web|--all`:server 构建 → tar 上传 `/opt/llms-study-api-new` → 原子 mv → `systemctl restart` → `curl /api/app/health` 失败提示回滚)。
上机(provision.md checklist):Node 22、llmapp 用户、`/var/lib/llms-study`、`/etc/llms-study/api.env`(0600:`LLM_KEY_MASTER`、`ADMIN_USERNAME/ADMIN_INITIAL_PASSWORD`、各 provider 服务端 key)、systemd、nginx 仅加 `/api/app/`。
验证:`curl https://llm-pro.cn/api/app/health` 200;restart 自动 migrate;server vitest(`app.request()` 级)冒烟。

### P1 账号体系
新增:`server/src/auth/{password,session,middleware}.ts`、`routes/{auth,admin,llmKeys}.ts`、`lib/crypto.ts`;前端 `src/lib/auth/{authStore,apiClient}.ts`、`src/components/auth/{LoginDialog,UserMenu}.tsx`。
改:`src/App.tsx`(whoami 启动、UserMenu、LoginDialog 挂载)、`src/pages/SettingsPage.tsx`(账号区/key 管理/admin 区)、`src/nav.ts`。
验证:server vitest(注册消码事务、爆破限流、加解密回环、改密吊销);手工:admin 种子登录 → 生成邀请码 → 注册普通用户 → 存 key 只见 last4;双 tab 登出同步。

### P2 LLM 网关收口 + nginx 切换(安全目标达成点)
新增:`server/src/llm/{gateway,providers,rateLimit}.ts`。
改:`src/lib/llmClient.ts`(删 X-User-Key;401/403 code 拆分)、`src/store.ts`(删 userKey)、`src/pages/InterviewPage.tsx`、`src/components/ask/SelectionAsk.tsx`、`src/components/papers/CopilotPanel.tsx`(auth 错误分支+登录后重试)、`vite.config.ts`(dev 代理指后端)。
线上:nginx 5 条 LLM location 改指后端、删 key 注入与 X-User-Key 改写、限流放宽。
验证:无 cookie `curl -N /api/deepseek/chat/completions` → 401;登录 cookie 流式逐帧;普通用户无 key → 403 引导文案;面试页+陪读+brief 全回归;网络面板确认 X-User-Key 已消失。

### P3 同步服务端
新增:`server/src/routes/{sync,files}.ts`、`lib/quota.ts`、migration 002。
验证:vitest 覆盖 push/changes 游标分页/墓碑/paper-deleted 竞态/配额 413;curl 上传下载 50MB、ETag 短路。

### P4 同步客户端
新增:`src/lib/paper/sync/{outbox,serverApi,syncEngine,merge}.ts`、`src/components/papers/ClaimBanner.tsx`、`src/lib/paper/repo/{syncedRepos,repos}.ts` + 对应 vitest(stub fetch,循 modelGateway.test.ts 惯例)。
改:`src/lib/paper/repo/db.ts`(version(2) + 按账号分库)、`PapersPage.tsx`(repo 换源、上传拦截、pull 合并、ClaimBanner、同步徽标)、`PaperWorkbenchPage.tsx`(repo 换源、blocks/bytes/state 缺失拉取)、`CopilotPanel.tsx`(repo 换源)。
验证:见下 E2E。

### P5 备份/监控/收尾
新增:`deploy/{backup.sh,backup.cron}`(SQLite `.backup` 每日保 14 天+周备 8 周;files/ rsync `--link-dest` 硬链接快照保 7 份;磁盘水位告警;OSS 异地列入 provision.md 待办);恢复演练 checklist。

## E2E 验收(双浏览器模拟双设备,Chrome=A,Firefox=B)

1. A 未登录导入被拦 → 邀请码注册 → 导入 PDF → ready → 网络面板见制品分批上推。
2. A 陪读 5 轮 + 阅读到 60% → 关页 → keepalive 进度推送。
3. B 首登:列表秒出 → 打开 → 拉 blocks + 本地重建索引 → 进度 60%、5 轮消息齐全;原版 PDF 字节懒拉成功。
4. B 续聊 2 轮 → A 重进增量拉到;双端不同进度 → LWW + maxBlockIndex 不回退。
5. A 断网阅读/对话失败重试 → 恢复 → outbox 补推无重复行;A 删论文 → B 级联消失。
6. 游客旧数据 → 登录 → ClaimBanner 认领 → B 可见;同文件 B 再传 → sha256 归并提示。
7. 普通用户无 key → 403 引导 → 配 key → 成功;admin 直接成功;未登录 curl 打 LLM 代理 → 401。
8. 双 tab 登出同步;session 服务端清除 → 回前台自愈为未登录。
9. flag-off 构建(`VITE_ENABLE_PAPER_COPILOT=` 空)`npm run build` 通过且 auth 功能完好。

## 关键既有代码复用点

- `src/lib/paper/repo/{paperRepo,copilotRepo,learnerRepo}.ts` 接口不动,装饰器包装;`deleteCascade` 复用于墓碑合并
- `PaperWorkbenchPage.tsx:246-258` "chunks 缺失本地补建"(`buildPaperIndex`)——换设备重建索引零新代码
- `papers.sha256`(导入时已算)——文件上传去重短路
- CopilotPanel `GateRequest` promise-gate 范式 → `requireLogin` 同构;`lastParamsRef` → 登录后自动重试
- `LlmError` 归一化 + `retryAfterMs` 消费 → 429 退避零改动
