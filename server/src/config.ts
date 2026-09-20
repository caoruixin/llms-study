/**
 * env → Config 解析,启动时 fail-fast:配置错误宁可起不来,不要带病服务。
 * 生产 env 来自 systemd EnvironmentFile(/etc/llms-study/api.env,0600);
 * 本地开发来自 server/.env(index.ts 里 process.loadEnvFile,已有环境变量优先)。
 */
import path from 'node:path'
import { LLM_PROVIDERS, type LlmProvider } from '../../shared/apiTypes.js'

export interface Config {
  port: number
  /** 仅监听地址;默认 127.0.0.1——公网入口只有 nginx,后端永不直接暴露 */
  host: string
  dataDir: string
  dbPath: string
  filesDir: string
  /** AES-256-GCM 主密钥(32 字节),用于加密用户 LLM key;泄露即可解密全部用户 key,只放 0600 env 文件 */
  llmKeyMaster: Buffer
  adminUsername: string | null
  adminInitialPassword: string | null
  /** 非 GET 请求的 Origin allowlist(CSRF 防线);dev 需含 vite 端口 */
  allowedOrigins: string[]
  /** dev 走 http 时 cookie 不能带 Secure,否则浏览器拒收;默认 true(生产安全默认) */
  cookieSecure: boolean
  /** 服务端各 provider key 列表(P2 LLM 网关注入 admin 请求;逗号列表依序故障转移) */
  serverLlmKeys: Record<LlmProvider, string[]>
  /** LLM 上游 base URL;env 名沿用 vite.config.ts 的同名变量,测试里指向本地 stub */
  llmUpstreams: Record<LlmProvider, string>
  /** admin 走服务端 key 的日调用上限;0 = 不限(账单兜底,防 key 被刷爆) */
  adminDailyCallLimit: number
  /**
   * 【仅本机开发】允许 /api/app/fetch-url 连接解析进保留网段的域名。
   * fake-IP 模式的代理(Surge/Clash 等)会把所有域名解析到 198.18/15,
   * 不开这个开关本机什么都抓不到。生产严禁配置——等于拆掉 SSRF 防线。
   */
  fetchUrlAllowForbiddenDev: boolean
  /** 语音助手(转写/合成);provider='none' = 整体关闭,前端不渲染麦克风球 */
  voice: VoiceConfig
  /**
   * 服务端渲染兜底(网页原貌 Tier 3)的功能开关 = 渲染服务的 unix socket 路径;null = 整体关闭
   * (/api/app/render-url 回 503 render-unavailable,前端回落到如实报错)。
   * 渲染服务是另一个进程、另一个 systemd unit(src/render/,deploy/llms-study-render.service);
   * 这里只存"去哪儿找它"。删掉这一行 env 再重启 API 就是即时生效的总闸。
   */
  renderServiceSocket: string | null
}

/** 语音 provider allowlist;刻意不并进 LLM_PROVIDERS——语音不走 /api/{provider} 网关那套 */
export const VOICE_PROVIDERS = ['none', 'siliconflow'] as const
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number]

export interface VoiceConfig {
  provider: VoiceProvider
  /** 逗号列表,依序故障转移(与 SERVER_*_KEYS 同语义) */
  keys: string[]
  baseUrl: string
  asrModel: string
  ttsModel: string
  /** 用户未选音色时用的音色短 id */
  defaultVoice: string
  /** 每用户每日 TTS 字符上限(账单兜底,按 voice_call_log 当日 SUM 统计);0 = 不限 */
  dailyCharLimit: number
}

/** SiliconFlow 默认模型/音色/上游;env 可逐项覆盖(换模型不必改代码) */
const VOICE_DEFAULTS = {
  baseUrl: 'https://api.siliconflow.cn',
  asrModel: 'FunAudioLLM/SenseVoiceSmall',
  ttsModel: 'FunAudioLLM/CosyVoice2-0.5B',
  voice: 'anna',
} as const

/** 逗号分隔列表解析:空段剔除,顺序即优先级(与 src/lib/keyRotation.ts 的 parseKeyList 同语义) */
function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new Error(`布尔 env 只接受 true/false/1/0,得到:${raw}`)
}

// SERVER_*_KEYS env 名与 provider 的映射(provider 里的连字符不适合做 env 名)
const PROVIDER_ENV: Record<LlmProvider, string> = {
  deepseek: 'SERVER_DEEPSEEK_KEYS',
  moonshot: 'SERVER_MOONSHOT_KEYS',
  zhipu: 'SERVER_ZHIPU_KEYS',
  jina: 'SERVER_JINA_KEYS',
  'openai-compat': 'SERVER_OPENAI_COMPAT_KEYS',
}

// 上游 base URL:env 名/默认值与 vite.config.ts 的 dev 代理保持一致,
// 两处配置同一个变量,dev 拓扑 = 生产拓扑
const UPSTREAM_DEFAULTS: Record<LlmProvider, { env: string; base: string }> = {
  deepseek: { env: 'DEEPSEEK_BASE_URL', base: 'https://api.deepseek.com' },
  moonshot: { env: 'KIMI_BASE_URL', base: 'https://api.moonshot.cn' },
  zhipu: { env: 'ZHIPU_BASE_URL', base: 'https://open.bigmodel.cn' },
  jina: { env: 'JINA_BASE_URL', base: 'https://api.jina.ai' },
  'openai-compat': { env: 'OPENAI_COMPAT_BASE_URL', base: 'https://api.openai.com' },
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const master = env.LLM_KEY_MASTER
  if (!master || !/^[0-9a-fA-F]{64}$/.test(master)) {
    throw new Error('LLM_KEY_MASTER 必须是 64 位 hex(32 字节);生成:openssl rand -hex 32')
  }

  const port = env.PORT ? Number(env.PORT) : 8787
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT 不合法:${env.PORT}`)
  }

  // 默认相对 cwd:dev 从 server/ 目录起服 → server/data;生产 systemd 显式设 DATA_DIR=/var/lib/llms-study
  const dataDir = path.resolve(env.DATA_DIR || 'data')

  const allowedOrigins = parseList(env.ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, ''))
  if (allowedOrigins.length === 0) allowedOrigins.push('https://llm-pro.cn')

  const serverLlmKeys = Object.fromEntries(
    LLM_PROVIDERS.map((p) => [p, parseList(env[PROVIDER_ENV[p]])]),
  ) as Record<LlmProvider, string[]>

  const llmUpstreams = Object.fromEntries(
    LLM_PROVIDERS.map((p) => {
      const { env: envKey, base } = UPSTREAM_DEFAULTS[p]
      return [p, (env[envKey] || base).replace(/\/+$/, '')]
    }),
  ) as Record<LlmProvider, string>

  const adminDailyCallLimit = env.ADMIN_DAILY_CALL_LIMIT ? Number(env.ADMIN_DAILY_CALL_LIMIT) : 0
  if (!Number.isInteger(adminDailyCallLimit) || adminDailyCallLimit < 0) {
    throw new Error(`ADMIN_DAILY_CALL_LIMIT 必须是非负整数:${env.ADMIN_DAILY_CALL_LIMIT}`)
  }

  return {
    port,
    host: env.HOST || '127.0.0.1',
    dataDir,
    dbPath: env.DB_PATH ? path.resolve(env.DB_PATH) : path.join(dataDir, 'data.db'),
    filesDir: env.FILES_DIR ? path.resolve(env.FILES_DIR) : path.join(dataDir, 'files'),
    llmKeyMaster: Buffer.from(master, 'hex'),
    adminUsername: env.ADMIN_USERNAME || null,
    adminInitialPassword: env.ADMIN_INITIAL_PASSWORD || null,
    allowedOrigins,
    cookieSecure: parseBool(env.COOKIE_SECURE, true),
    serverLlmKeys,
    llmUpstreams,
    adminDailyCallLimit,
    fetchUrlAllowForbiddenDev: parseBool(env.FETCH_URL_ALLOW_FORBIDDEN_DEV, false),
    voice: loadVoiceConfig(env),
    renderServiceSocket: loadRenderServiceSocket(env),
  }
}

/**
 * 可选功能,缺省即关(同 VOICE_PROVIDER=none 的先例)。配了就必须是绝对路径:
 * 相对路径会随 cwd 漂移,"以为开了其实连不上"只会在用户导入失败时才暴露,宁可起不来。
 * 不在这里检查 socket 文件是否存在——渲染服务可以晚于 API 启动、也可以随时重启,
 * 连不上由路由按请求如实回 503。
 */
function loadRenderServiceSocket(env: Record<string, string | undefined>): string | null {
  const raw = env.RENDER_SERVICE_SOCKET
  if (!raw) return null
  if (!path.isAbsolute(raw)) {
    throw new Error(`RENDER_SERVICE_SOCKET 必须是绝对路径,得到:${raw}`)
  }
  return raw
}

/**
 * 语音配置解析,同样 fail-fast:配了未知 provider 或配了 provider 却没 key,
 * 都是"以为开了其实没开"的静默失败,宁可起不来。
 */
function loadVoiceConfig(env: Record<string, string | undefined>): VoiceConfig {
  const raw = env.VOICE_PROVIDER || 'none'
  if (!(VOICE_PROVIDERS as readonly string[]).includes(raw)) {
    throw new Error(`VOICE_PROVIDER 只接受 ${VOICE_PROVIDERS.join('/')},得到:${raw}`)
  }
  const provider = raw as VoiceProvider
  const keys = parseList(env.SERVER_SILICONFLOW_KEYS)
  if (provider !== 'none' && keys.length === 0) {
    throw new Error(`VOICE_PROVIDER=${provider} 但 SERVER_SILICONFLOW_KEYS 为空`)
  }

  const dailyCharLimit = env.VOICE_DAILY_CHAR_LIMIT ? Number(env.VOICE_DAILY_CHAR_LIMIT) : 0
  if (!Number.isInteger(dailyCharLimit) || dailyCharLimit < 0) {
    throw new Error(`VOICE_DAILY_CHAR_LIMIT 必须是非负整数:${env.VOICE_DAILY_CHAR_LIMIT}`)
  }

  // 末尾 /v1 一并剥掉:适配器里的路径常量自带 /v1(OpenAI 兼容形状),
  // 而人手写 base URL 时习惯带上,不剥就会拼成 /v1/v1/audio/... 直接 404
  const baseUrl = (env.SILICONFLOW_BASE_URL || VOICE_DEFAULTS.baseUrl)
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '')

  return {
    provider,
    keys,
    baseUrl,
    asrModel: env.VOICE_ASR_MODEL || VOICE_DEFAULTS.asrModel,
    ttsModel: env.VOICE_TTS_MODEL || VOICE_DEFAULTS.ttsModel,
    defaultVoice: env.VOICE_TTS_VOICE || VOICE_DEFAULTS.voice,
    dailyCharLimit,
  }
}
