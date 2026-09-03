/**
 * 路由前缀与限额常量(前后端共享,零运行时依赖)。
 * 数值改这里,两端同时生效——避免"前端校验放行、服务端 400"的漂移。
 */

/** 新后端业务路由统一前缀;LLM 代理仍走 /api/{provider} 原状(P2 才翻转到后端) */
export const APP_API_PREFIX = '/api/app'

/** session cookie 名:HttpOnly + SameSite=Lax,前端永远读不到,仅作文档 */
export const SESSION_COOKIE = 'sid'

/** session 30 天滑动过期(过半续期) */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export const USERNAME_MIN = 3
export const USERNAME_MAX = 32
/** 用户名字符集:URL/日志安全,大小写不敏感判重(NOCASE) */
export const USERNAME_RE = /^[a-zA-Z0-9_-]+$/

export const PASSWORD_MIN = 8
/** 上限防超长密码打满 argon2 计算(DoS) */
export const PASSWORD_MAX = 128

/** LLM key 长度界限:真实 key 均 ≥8;上限防把整段文本当 key 存进来 */
export const LLM_KEY_MIN = 8
export const LLM_KEY_MAX = 512

export const INVITE_CODE_LENGTH = 16

/** 登录爆破限流:IP 与用户名双维度,失败 10 次/15 分钟 → 429 + Retry-After */
export const LOGIN_MAX_FAILURES = 10
export const LOGIN_WINDOW_MS = 15 * 60 * 1000

/** 每账号默认存储配额 2GB(P3 同步域记账用,schema 默认值与此一致) */
export const DEFAULT_STORAGE_QUOTA_BYTES = 2147483648

// ---- 同步域限额(P3)----

/** push 单批上限:批太大单事务持锁过久,阻塞其它用户请求 */
export const SYNC_PUSH_MAX_CHANGES = 500
export const SYNC_PUSH_MAX_BYTES = 8 * 1024 * 1024
/** changes 拉取单页上限 */
export const SYNC_CHANGES_MAX_LIMIT = 1000
/**
 * 论文原始文件单个上限:与 nginx files location 的 client_max_body_size 60m 对齐。
 * 前端导入本就限 50MB,这里留 10MB 余量吸收元数据/边界差异。
 */
export const FILE_MAX_BYTES = 60 * 1024 * 1024
/**
 * paperId 形状(文件名安全):它会拼进磁盘路径 files/{userId}/{paperId}.bin,
 * 白名单字符集从根上排除路径穿越;前端 paper id 是 uuid/hex,天然满足。
 */
export const FILE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

// ---- LLM 网关限额(P2)----

/** LLM 代理请求体上限:多 key 故障转移需要全量缓冲 body 以便换 key 重发 */
export const LLM_PROXY_MAX_BODY_BYTES = 2 * 1024 * 1024
/**
 * 每用户令牌桶,与前端 PAPER_RATE_LIMIT(src/data/paperPolicy.ts)同参:
 * 前端排队等桶、服务端超限 429 + Retry-After,两端参数一致才不会"前端放行、服务端拒绝"。
 * (不直接 import paperPolicy:它引用 llmClient 等前端模块,会把前端依赖树拖进 server 编译)
 */
export const LLM_RATE_CAPACITY = 3
export const LLM_RATE_REFILL_MS = 10_000
/** 每用户并发 SSE 上限:防单用户占满上游连接/后端内存 */
export const LLM_MAX_CONCURRENT_STREAMS = 3

// ---- URL 抓取代理(Track 1)----

/**
 * 单次抓取字节上限 20MB:白皮书类 PDF 常见 5~15MB,再大也超出"可陪读文档"的范畴。
 * 比 FILE_MAX_BYTES 小得多——抓取字节要整块进内存(不落盘),必须更保守。
 */
export const FETCH_URL_MAX_BYTES = 20 * 1024 * 1024
/** 单次抓取总超时(建连 + 读完 + 全部重定向跳数共用这一个预算) */
export const FETCH_URL_TIMEOUT_MS = 20_000
/** 重定向跟随上限:正常站点 1~2 跳足够,更深多半是跳转陷阱/循环 */
export const FETCH_URL_MAX_REDIRECTS = 3
/**
 * 每用户抓取令牌桶:5 容量、每 10s 回一枚。
 * 比 LLM 桶松一点(批量导入本就要连抓十几个 URL),但仍能挡住"拿服务器当扫描器"。
 */
export const FETCH_URL_RATE_CAPACITY = 5
export const FETCH_URL_RATE_REFILL_MS = 10_000
/** 每用户并发抓取 1:前端逐 URL 串行,多余并发只会放大探测能力与内存峰值 */
export const FETCH_URL_MAX_CONCURRENT = 1
/** 目标 URL 长度上限:超长 URL 多为追踪串/攻击载荷,正常文档链接远低于此 */
export const FETCH_URL_MAX_LENGTH = 2048
/** 单次批量导入的 URL 条数上限(前端闸门,服务端逐条抓) */
export const MAX_URLS_PER_IMPORT = 20
/**
 * 重定向后的最终 URL 回传头:前端做相对链接绝对化必须以最终 URL 为基准,
 * 否则跳转过域名的站点会把相对路径拼到原始域上。
 */
export const FETCH_URL_HEADER_FINAL_URL = 'x-fetch-final-url'

// ---- 语音助手(Voice Copilot)----

/**
 * 单次上传音频字节上限 2MiB:一句提问按 60s 封顶,webm/opus 24kbps 约 180KiB,
 * 最坏情况(浏览器不支持 opus 而退到 16k 单声道 WAV)60s ≈ 1.87MiB,仍在帽内。
 * 比 FETCH_URL_MAX_BYTES 小一个量级——音频要整块进内存再转发,必须更保守。
 */
export const VOICE_ASR_MAX_BYTES = 2 * 1024 * 1024
/** 单次转写总超时:ASR 是"说完才发",上游按音频时长算,20s 覆盖 60s 音频的常见处理耗时 */
export const VOICE_ASR_TIMEOUT_MS = 20_000
/**
 * 每用户转写令牌桶:6 容量、每 10s 回一枚。
 * 连续对话模式一轮一次转写,6 枚够连问 6 句再进入 10s/句的稳态,
 * 而人正常说一句 + 听完回答远超 10s,所以正常使用永远碰不到桶。
 */
export const VOICE_ASR_RATE_CAPACITY = 6
export const VOICE_ASR_RATE_REFILL_MS = 10_000
/** 每用户并发转写 1:半双工语音交互天然串行,多余并发只会放大内存峰值 */
export const VOICE_ASR_MAX_CONCURRENT = 1

/** 单次合成文本上限 400 字:一句成句的播报远低于此,超长多半是整段回答误发 */
export const VOICE_TTS_MAX_CHARS = 400
/** 合成请求体上限 8KiB:400 字 UTF-8 最多 1.2KiB,余量给 voice/format/speed 与 JSON 结构 */
export const VOICE_TTS_BODY_MAX_BYTES = 8 * 1024
/** 单次合成总超时 15s:比 ASR 短——首音延迟直接决定体感,宁可快失败转浏览器朗读 */
export const VOICE_TTS_TIMEOUT_MS = 15_000
/**
 * 每用户合成令牌桶:20 容量、每 1s 回一枚。
 * **刻意不复用 LLM 的 3/10s**:一条回答会被成句切成 4~8 段,每段一次合成,
 * 用 LLM 桶会在第一条回答播到一半时就把用户自己限死。
 */
export const VOICE_TTS_RATE_CAPACITY = 20
export const VOICE_TTS_RATE_REFILL_MS = 1_000
/** 每用户并发合成 2:正好是"播当前句 + 预取下一句"的稳态,再多也没人听 */
export const VOICE_TTS_MAX_CONCURRENT = 2
/**
 * 合成音频字节上限 4MiB:400 字 mp3 约 300KiB、wav 约 2.5MiB,4MiB 留足余量;
 * 上限存在的意义是防上游异常时把无界字节读进单进程内存。
 */
export const VOICE_TTS_MAX_AUDIO_BYTES = 4 * 1024 * 1024

/** 单次录音时长上限:超过 30s 的"一句提问"基本是忘了松手,前端据此自动断句 */
export const VOICE_MAX_UTTERANCE_MS = 30_000

/**
 * 上传音频容器白名单:MediaRecorder 在各浏览器的实际产物(webm/opus、Safari 的 mp4)
 * 加上转码兜底的 wav,以及少数场景的 ogg/mpeg。服务端按此派生 multipart 文件扩展名——
 * 部分 ASR 上游按扩展名分发解码器,扩展名错了会直接 400。
 */
export const VOICE_AUDIO_MIME_ALLOWLIST = [
  'audio/webm',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/mpeg',
] as const

/** 转写语种提示头:zh|en|auto,非法值一律按 auto 处理(提示而非契约) */
export const VOICE_HEADER_LANG = 'x-voice-lang'
