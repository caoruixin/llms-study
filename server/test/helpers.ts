/**
 * 测试基建:每个用例独立的内存 DB + app 实例(限流器/session 互不串味)。
 * 全部走 app.request() 打真实 HTTP 形状,不 mock 内部函数。
 */
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/auth/password.js'
import type { Config } from '../src/config.js'
import { openDb, type Db } from '../src/db/db.js'
import { migrate } from '../src/db/migrate.js'

export const TEST_MASTER_HEX = 'ab'.repeat(32)

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir: '/tmp/llms-study-test-unused',
    dbPath: ':memory:',
    filesDir: '/tmp/llms-study-test-unused/files',
    llmKeyMaster: Buffer.from(TEST_MASTER_HEX, 'hex'),
    adminUsername: null,
    adminInitialPassword: null,
    allowedOrigins: ['http://localhost:5173'],
    cookieSecure: false,
    serverLlmKeys: { deepseek: [], moonshot: [], zhipu: [], jina: [], 'openai-compat': [] },
    // 默认指向必失败的本地端口:测试必须显式指到自己的 stub,防止误打真实上游
    llmUpstreams: {
      deepseek: 'http://127.0.0.1:9',
      moonshot: 'http://127.0.0.1:9',
      zhipu: 'http://127.0.0.1:9',
      jina: 'http://127.0.0.1:9',
      'openai-compat': 'http://127.0.0.1:9',
    },
    adminDailyCallLimit: 0,
    fetchUrlAllowForbiddenDev: false,
    ...overrides,
  }
}

export interface TestCtx {
  app: ReturnType<typeof createApp>
  db: Db
  config: Config
}

export function createTestApp(
  overrides?: Partial<Config>,
  depsExtra?: Omit<Parameters<typeof createApp>[0], 'db' | 'config'>,
): TestCtx {
  const db = openDb(':memory:')
  migrate(db)
  const config = testConfig(overrides)
  const app = createApp({ db, config, ...depsExtra })
  return { app, db, config }
}

export async function createUser(
  db: Db,
  username: string,
  password: string,
  role: 'admin' | 'user' = 'user',
): Promise<number> {
  const passwordHash = await hashPassword(password)
  const info = db
    .prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, role, Date.now())
  return Number(info.lastInsertRowid)
}

export function insertInvite(
  db: Db,
  code: string,
  createdBy: number,
  opts: { expiresAt?: number | null } = {},
): void {
  db.prepare(
    'INSERT INTO invite_codes (code, created_by, created_at, expires_at, note) VALUES (?, ?, ?, ?, ?)',
  ).run(code, createdBy, Date.now(), opts.expiresAt ?? null, null)
}

export function postJson(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }
}

/** 从 Set-Cookie 提取 sid;登出的清除头(sid=;)不会匹配 */
export function sidOf(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? ''
  const m = /sid=([^;,\s]+)/.exec(setCookie)
  if (!m) throw new Error(`响应没有 sid cookie:${setCookie || '(无 Set-Cookie)'}`)
  return m[1]
}

export const withSid = (sid: string): Record<string, string> => ({ cookie: `sid=${sid}` })

export async function login(
  app: TestCtx['app'],
  username: string,
  password: string,
): Promise<string> {
  const res = await app.request('/api/app/auth/login', postJson({ username, password }))
  if (res.status !== 200) throw new Error(`login 失败:${res.status} ${await res.text()}`)
  return sidOf(res)
}
