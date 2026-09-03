# 论文陪读语音助手(Voice Copilot)实施计划

## Context
llm-pro.cn/#/papers 阅读工作台已有 Copilot 文字陪读,但看论文时随手产生的疑问要打字才能问。目标:加一个类 ChatGPT Voice 的语音助手——随时唤起、说完自动把问题连同"当前屏幕可见正文 + 划词选区 + 近几轮对话"发给 Copilot,回答流式写入 Copilot 对话框并边生成边朗读。附带治好一个存量 bug:现有 🎙 听写走 Chrome `webkitSpeechRecognition`(需连 Google),在大陆正式站上实际不可用。

## 已确认决策(用户)
1. 唤醒:悬浮麦克风球(可拖) + 全局按住 `V` 说话热键 + 可选"连续对话"模式;不做唤醒词/常开 VAD
2. 回复:回答写入 Copilot + 云端 TTS 朗读,失败退浏览器 `speechSynthesis` 兜底
3. 屏幕上下文:DOM 提取可见正文(段落/标题/图注),不截屏
4. 语音厂商:**SiliconFlow**(key 已注册,已放入 server/.env 的 `siliconflow_base_url`/`siliconflow_api_key`——实现时规范为 `SERVER_SILICONFLOW_KEYS` 逗号列表 + `SILICONFLOW_BASE_URL`,复用 `src/lib/keyRotation.ts` 故障转移)
5. 回答问题的 LLM 链路不变(DeepSeek,经现有 modelGateway)

## SiliconFlow 契约(已对 docs.siliconflow.com 核实,2026-09-03)
- ASR:`POST {base}/v1/audio/transcriptions`,Bearer,multipart `file`+`model`;模型 `FunAudioLLM/SenseVoiceSmall`;响应 `{"text":"..."}`
- TTS:`POST {base}/v1/audio/speech`,JSON `{model:"FunAudioLLM/CosyVoice2-0.5B", input(≤128k), voice:"FunAudioLLM/CosyVoice2-0.5B:<alex|anna|bella|benjamin|charles|claire|david|diana>", response_format:mp3|opus|wav|pcm, speed, gain, stream}`;响应=音频字节,支持 chunked
- 剩余待实现时验证:SenseVoice 对 webm/mp4 容器的接受度(**兜底已定**:若拒收,recorder 端 decodeAudioData→重采样 16k 单声道→WAV 编码上传,纯函数可测;60s≈1.87MiB 仍在 2MiB 帽内)、音色试听标签、单价(成本按公式记账:ASR≈分钟×单价,TTS≈字符/1000×单价)
- TTS input 含 `<|endofprompt|>` 指令语义,发送前剥离特殊标记

## 架构总览
```
PaperWorkbenchPage(持有 readerRef/blocks/position/visibleRange)
├─ BlockReader: 现有观察器不动 + 新增第二个 IntersectionObserver(rootMargin:'0px')→ onVisibleRange{min,max}
├─ PdfViewer: 不改;PDF 原版模式用 anchors.firstBlockOfPage 由 position.page 推块区间
├─ VoiceMicBall(新, 悬浮球)── useVoiceCopilot(录音+状态机+热键+打断+连续循环)
│    写 → usePaperUi.requestVoiceAsk({text, viewportContext, selection, ...})(内含 copilotOpen:true)
│    读 ← usePaperUi.voiceTurnPhase / voicePanelBusy
└─ CopilotPanel: 消费 voiceAsk → sendTurn → turnEngine → modelGateway(LLM 路径零改动)
     TTS 沿用现有 ttsReducer/驱动 effect,仅 getPlayer() 换成 cloudTtsPlayer(实现同一 TtsPlayer 接口)
     回写 → setVoiceTurnPhase('thinking'|'speaking'|'done'|'error')

浏览器 →(同源)/api/app/voice/* → Hono voice 路由(鉴权+限流+key轮换+审计)→ SiliconFlow
```
录音归悬浮球、播报归面板(面板已拥有流文本/成句切分/朗读队列,搬走=全部重写);二者只通过 store 粗粒度槽位通信(音量电平走 ref+CSS 变量,绝不进 zustand——两处组件都是无 selector 订阅)。

### 核心流(按住说话)
按下(手势内 unlockAudio + 敏感论文/授权闸)→ getUserMedia(echoCancellation 等)→ MediaRecorder 录音(电平 RAF)→ 松开 → blob<2KB 直接"没听到" → `POST /api/app/voice/transcribe` → `{text}` 空="没听清" → 发送瞬间快照上下文(live selection + buildViewportContext)→ requestVoiceAsk → 面板 busy 则显式报"回答进行中"(不排队),否则 `pendingLiveSpeakRef=true` + sendTurn → effect 等 `live!==null` 才 startLiveSpeak(见"设计代理抓出的坑"#2)→ 成句入队 → cloudTtsPlayer 逐句 POST /voice/tts 播放+预取下一句,失败句转浏览器朗读且本轮粘性降级 → 队列排空 → 连续模式 300ms 后重新收音(半双工:speaking 态禁止开麦,唯一入口是打断)
**打断(barge-in)**:speaking 态按球/按 V → 取消播放+清未读队列,**不停止生成**,200ms 后转 listening。

## P0 — 最小闭环

### Server(新 5 文件 + 改 6)
新:`server/src/routes/voice.ts`(GET /config、POST /transcribe、POST /tts;requireSession + 独立令牌桶/并发闸/字节帽,模板=fetchUrl.ts;key 轮换+同字节重放,模板=gateway.ts)、`server/src/voice/adapter.ts`(VoiceAdapter 接口,零网络)、`server/src/voice/siliconflow.ts`、`server/src/db/migrations/003_voice.sql`(voice_call_log:user_id/kind(asr|tts)/provider/model/bytes_in/chars_in/status/latency_ms/created_at;**不存任何文本与音频**)、`server/test/voice.test.ts`
改:`app.ts`(`api.route('/voice', ...)`,落在现有 nginx `/api/app/` location 下,**零 nginx 改动**;**不要**把 siliconflow 加进 `LLM_PROVIDERS`)、`config.ts`(VOICE_PROVIDER=none|siliconflow 起动校验 fail-fast)、`types.ts`(AppDeps.voiceTuning 注入适配器供测试)、`shared/apiRoutes.ts`(常量)、`shared/apiTypes.ts`(ApiErrorCode 加 `voice-upstream-failed`/`voice-unavailable`)、`server/.env.example`

契约:
- `GET /voice/config` → `{enabled, provider, providerLabel, asrModel, voices[], maxUtteranceMs, maxAudioBytes}` 或 `{enabled:false}`(前端据此隐藏球)
- `POST /transcribe`:**原始音频字节直传**(非 multipart;Content-Type ∈ audio/webm|mp4|ogg|wav|mpeg 白名单,`X-Voice-Lang: zh|en|auto`),服务端自组 multipart(文件扩展名按 mime 派生,部分 ASR 按扩展名分发)→ `200 {text, model, latencyMs}`;**空转写=200 {text:""}**,不是错误
- `POST /tts`:JSON `{text≤400字, voice?, format:'mp3'|'wav', speed?}`(body≤8KiB)→ `audio/mpeg` 字节,`Cache-Control: no-store`
- 错误封装同 `respond.ts` `{error,message}`:401 unauthenticated / 413 / 415 unsupported-content / 429 rate-limited(+Retry-After)/ 502 voice-upstream-failed / 503 voice-unavailable

限额常量(shared/apiRoutes.ts,注释写明尺寸依据):ASR `2MiB / 20s超时 / 桶6·10s / 并发1`;TTS `桶20·回填1/s / 并发2(播+预取) / 15s超时`——**不得复用 LLM 桶 3/10s**(一条回答要 4-8 次 TTS 调用);`VOICE_DAILY_CHAR_LIMIT`(0=不限)按 voice_call_log 当日 SUM(chars_in) 兜底账单。

### Web(新 11 文件 + 改 7,全部落 paper 树内 → flag-off 构建自动剔除)
新(src/lib/paper/voice/):
- `voiceMachine.ts` **纯**:状态机 reducer(unavailable|idle|requesting|listening|transcribing|thinking|speaking|error + 全迁移表,非法迁移原样返回)、`voiceStatusText`
- `endpointing.ts` **纯**(P1 用,P0 可先建):`rmsOf`、`createSilenceDetector({minSpeechMs:400, silenceMs:1200, maxUtteranceMs:30000})`
- `recorderMime.ts` **纯**:`pickRecorderMime`(webm/opus→mp4→null,注入 isTypeSupported)、`micErrorMessage`(NotAllowed→'麦克风权限被拒绝…'等)
- `recorder.ts`:getUserMedia+MediaRecorder+AnalyserNode 电平;`recorderSingleton.ts`:引用计数单例 MediaStream(球与面板内麦共享,StrictMode 双挂安全,release 必 `getTracks().forEach(stop)`)
- `voiceApi.ts`:getVoiceConfig/transcribeAudio/synthesizeSpeech + 中文错误文案映射(fetchUrlApi 形制)
- `ttsChunking.ts` **纯**:`groupSentencesForTts`——**首句不合并直接放行**(压 TTFA),后续合并到 ≥60 字(压调用数)
- `cloudTtsPlayer.ts`:实现现有 `TtsPlayer` 接口(tts.ts:174-179)——逐句 fetch→objectURL→复用单个 HTMLAudioElement 播放+预取下一句;`unlockAudio()` 在手势内播静音 data-URI;失败句转 fallback(浏览器 player)+本轮粘性降级 onDegrade;播毕 revokeObjectURL
- `viewportContext.ts` **纯**:`buildViewportContext(blocks,{min,max},{selection,maxChars:2000,centerIndex})`——位置头(§x · p.y,沿 renderChunkHeader 格式)+ 块文本;image 只取 `[图: alt]`,table 用 text 不用 html;超帽从 centerIndex(视口顶块)向外扩而非截尾;选区≥40字且被包含时替换为"（此处即上面的「选中内容」）"去重;`pageBlockRange(firstBlockOfPage,page,blockCount)` PDF 退化
- `prompts.ts` **纯**:`VOICE_ANSWER_DIRECTIVE`(口语化、先结论、少公式、≤200字)
- `useVoiceCopilot.ts`:组装 recorder+machine+热键+打断+连续循环+清理(paper.id 变更/unmount/visibilitychange→hidden 一律收麦归位)
- `src/components/papers/VoiceMicBall.tsx`(P0 固定位不可拖)

改:
- `BlockReader.tsx`(:289-311 旁):加 `onVisibleRange?` prop + **第二个** IO(`rootMargin:'0px'`,自维护 Set,min/max 变才回调,cleanup 同步断开);现有观察器与 onVisibleBlock **一字不动**(阅读进度/大纲高亮零回归);注释引用 PdfViewer.tsx:323-326"两个问题两套机制"先例
- `PaperWorkbenchPage.tsx`:visibleRange state+ref(仿 :379 positionRef);buildVoiceAsk(发送瞬间读 `window.getSelection()`∈readerRef + buildViewportContext;PDF 原版模式走 pageBlockRange,无页码格式退化为 position.blockIndex 起的字符预算窗);球挂在工作台根内(:805 transform=包含块,同 toast 先例),渲染条件 `paper.status==='ready' && !paper.sensitive && voiceConfig.enabled`
- `paperUiStore.ts`:持久化 VoicePrefs{voiceSpeakAloud:true, voiceSpeakTypedTurns:false, voiceContinuous:false, voiceHotkey:true, voiceTtsVoice:'', voiceTtsEngine:'cloud', voiceBallHidden:false} + `sanitizeVoicePrefs`(partialize/merge 双处并入,**无需 version bump**);会话态(不落盘):`voiceAsk:VoiceAsk|null`(**consume-and-clear,勿用 tick+seenTick**——见坑#1)、voiceTurnPhase、voicePanelBusy、voiceStopSpeakTick、requestVoiceAsk(内含 copilotOpen:true)
- `CopilotPanel.tsx`:SendParams+`viewportContext?`;voiceAsk 消费 effect(先 consumeVoiceAsk 再发;busy→setVoiceTurnPhase('error')+'回答进行中,说完这轮再问',**显式不静默**——turnEngine:269 busy 返回 null 无信号);`pendingLiveSpeakRef` + 等 `live!==null` 的 effect 再 startLiveSpeak(坑#2);getPlayer(:752-755)按 prefs 选 cloud/browser——**prefs.voiceTtsEngine/voiceTtsVoice 变更时重置 playerRef**(否则缓存旧实现);:820 成句结果过 groupSentencesForTts;busy→setVoicePanelBusy effect;voiceStopSpeakTick→stopSpeaking()(不 stopTurn);phase 回写
- `contextBuilder.ts`:AssembleInput+`viewportContext?`;buildFinalUser 在选区块**后**、白名单块**前**插【当前屏幕上的正文】段(显式声明"仅用于理解指代,不是引用来源,不得为其编造别名");裁剪梯变 7 档:**阶梯0(新) viewport→600字** → 现有1-4 → **阶梯5(新) viewport 整段丢弃** → overBudget 报错;BudgetReport+viewportTruncated/viewportDropped;`VIEWPORT_MAX_CHARS=2000`(≈667 token,chat 12k 预算的 ~5.5%)
- `turnEngine.ts`:TurnRequest+viewportContext;streamOnce 传入 assembleContext;**两处** deps.retrieve(:339 与证据重试 :359)都传 viewport
- `retrieval.ts`:RetrieveContext+viewport;expandQuery 仅在**无选区**时并入 viewport 前 300 字(选区是更强信号,BM25 噪声敏感;currentSection boost 已偏向视口章节);开关 `viewportQuery:'auto'|'always'|'never'` 便于调参

## P1 — 打磨(单次交付内顺序做,不单独部署)
- 球可拖(AskDialog 范式:dragListener=false + 边缘拖柄 start(e),drag 仅 ≥md,dragMomentum=false,constraints=pointer-events-none fixed inset-0 z-50 wrapper,按钮 stopPropagation,位置不持久化);移动端锚位字面量 `right-3 bottom-[calc(70dvh+0.75rem)]`(sheet 开)/`right-3 top-14`(sheet 全屏),z-50 压过 z-40 sheet
- 热键:全局 keydown/keyup(空依赖 effect+ref 镜像);忽略 e.repeat / 任意修饰键(Cmd+V 不触发)/ `activeElement.closest('textarea,input,[contenteditable]')`;Escape 仅在非 idle 时 CANCEL(与 SelectionActions 的 Escape 共存)
- 连续对话:endpointing 静默 1.2s 断句;TTS_DRAINED 后 300ms 重臂;8s 无人声自动退出;连续 2 次"没听清"退出;error/手动取消/标签页 hidden 不重臂
- `VoiceSettingsPopover.tsx`(PersonaChip 外点关闭范式;开关表见 store 默认值;音色下拉自 /voice/config + 试听钮)
- `VoiceConsentDialog.tsx`:**首次开麦前**弹,存现有 Dexie `consents` 表 key `'voice'`(字符串键,零 schema 改动);敏感论文三层拦截(球不渲染 / runSendTurn:411 / 面板麦禁用)
- **面板 🎙 听写换血**(:839-880 + :1400-1412):startDictation → recorderSingleton+transcribeAudio,转写**追加进输入框不自动发**(保留打字流手动确认心智;只有球自动发);去掉 speech.ts import(InterviewPage 不动);状态行'正在录音…/正在识别…'
- 文档反转修正:`tts.ts:10` 头注释、`PLAN-paper-copilot.md` §9("不上传音频"→云端语音口径:音频仅用于转写、服务端不存不记、合成音频 no-store 播毕即弃)、ConsentDialog SCOPE_LINES 加一行边界说明、README(env 说明)
- 球呼吸动画 keyframes 加进 ReaderStyles(ReaderContext.tsx:50-104,带 prefers-reduced-motion 守卫)

## 状态机边界(浓缩;全表见 voiceMachine 测试)
busy 拒绝不排队 / 敏感论文球不渲染 / 未授权先弹 VoiceConsentDialog / 麦克风被拒·被占·不存在分文案 / ASR 空与失败分流(失败留 blob 一键重试) / TTS 粘性降级一次性提示"云端朗读不可用,已切换为浏览器朗读" / 双兜底皆失效纯文字+状态提示 / autoplay 拒绝→降级+「点击继续朗读」 / 切论文·卸载·hidden 全量清理(discard 已有) / iOS<14.3 无 MediaRecorder→球隐藏。

## 测试与验收
- Web vitest(node,纯 .ts):voiceMachine 全迁移表、endpointing、recorderMime、ttsChunking、viewportContext(含 pageBlockRange/选区去重/向外扩)、voiceApi(stub fetch)+ 扩展 contextBuilder(阶梯0/5 次序、指代守卫)/retrieval(选区抑制 viewport)/turnEngine(viewport 达两处 retrieve)/paperUiStore(sanitize/partialize 排除会话态)
- Server vitest:13 用例——401/config disabled/转写 happy+审计行/413 双路径/415/429 桶+闸/key#1 失效轮换 key#2/全失败 502/无 key 503/tts happy+chars_in/超长 413/日字符限 429/超时 502 且闸归还
- E2E `.e2e-qa-fixtures/voice-e2e.mjs`(playwright 1.52 手写,against 已起的 5173+8787):chromium `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`;**ASR/TTS 用 page.route 拦截桩**(零生产代码面);V1-V14 场景表(球渲染拖动/按住V自动发含「语音提问」标签/SSE 请求体含【当前屏幕上的正文】/打断不断流/连续模式重臂/权限拒绝/502 文案/降级触发 speechSynthesis/敏感论文/textarea 焦点吞 V/移动端 390px 锚位/PDF 页上下文/面板听写不自动发/播报中切论文);截图+QA-REPORT-voice.md 沿仓库惯例;球加 `data-voice-phase` 供断言
- 门:`npm run typecheck`、双端 vitest、**双构建**(`npm run build` + `VITE_ENABLE_PAPER_COPILOT= npm run build`)+ flag-off 产物 grep 无 voice 痕迹

## 交付与部署
1. 获批后先把本计划另存为项目内 `PLAN-voice-copilot.md`(新文件,不覆盖旧计划文档)
2. 实施走专属 subagent,P0→P1 顺序;E2E QA 按仓库流程用 codex CLI(浏览器+API)跑轮次,P0/P1 修到 0 或 3 轮
3. 部署:`scripts/deploy.sh --all`(server 先行:003 迁移随启动执行——实现时确认迁移机制;web 后行);**手工步骤**:正式机 server/.env 增 `VOICE_PROVIDER=siliconflow`、`SERVER_SILICONFLOW_KEYS=<用户已有 key>`、`SILICONFLOW_BASE_URL`(并将本地 .env 中用户手写的小写条目改名);nginx 零改动;health check 照旧
4. 上线后用 voice_call_log 观察 chars_in/latency,必要时设 VOICE_DAILY_CHAR_LIMIT

## 主要风险
autoplay(手势内解锁+降级)/ Safari mp4(mime 阶梯+服务端扩展名)/ SenseVoice 容器兼容(WAV 转码兜底已设计)/ 回声(严格半双工+300ms 守卫+echoCancellation)/ 限流互扰(语音自带桶,不碰 LLM 3/10s 桶;首句不合并保 TTFA)/ 首音延迟 2.5-6s(状态行如实显示"思考中…",P2 流式 TTS 再压)/ 隐私反转(独立 voice 授权+三层敏感拦截+服务端不存音频文本+修正仓内旧承诺文案)/ 双无 selector 订阅的 re-render(粗粒度写+电平走 CSS 变量)

## P2(本次不做)
按用户 key 的语音计费、上游 stream:true 流式 TTS 透传、zhipu 适配器备选、音色样本缓存、voice_call_log 管理页

## 附:实施期确认事实(获批后核实)
- 迁移机制:`server/src/db/migrate.ts` 启动时按文件名序号执行 `server/src/db/migrations/*.sql`(事务内,失败即起不来;build 拷贝 .sql 进 dist)→ 新增 `003_voice.sql` 即可
- Config 惯例:`loadConfig` fail-fast;`parseList`/`parseBool` 可复用;新增 `voice` 配置组(provider/keys/baseUrl/models/defaultVoice/dailyCharLimit),env:`VOICE_PROVIDER`、`SERVER_SILICONFLOW_KEYS`、`SILICONFLOW_BASE_URL`(默认 https://api.siliconflow.cn)、`VOICE_ASR_MODEL`/`VOICE_TTS_MODEL`/`VOICE_TTS_VOICE`/`VOICE_DAILY_CHAR_LIMIT`
- 注入口:`AppDeps.voiceTuning?: { adapter?; rateCapacity?; rateRefillMs?; maxBytes?; timeoutMs?; ttsRateCapacity?; ttsRateRefillMs? }`(测试专用,不进 config——llmTuning/fetchTuning 同理由)
- 挂载:`server/src/app.ts` 的 api 子树加 `api.route('/voice', voiceRoutes(deps))`
- 分工:server 与 shared 由专属代理实施;`src/lib/paper/voice/*` 纯库(无 React/无 store)由第二代理实施;既有文件集成(store/contextBuilder/turnEngine/retrieval/BlockReader/Workbench/CopilotPanel)与 React 层(useVoiceCopilot/VoiceMicBall/弹窗)由主线实施
