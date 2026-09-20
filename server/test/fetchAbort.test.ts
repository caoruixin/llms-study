/**
 * 调用方放弃(客户端断开)→ 上游抓取立刻中止、并发名额立刻归还。
 *
 * 起因(实测复现):前端上了「取消导入」之后,用户在「抓取中」点取消、马上再导一篇,
 * 新请求被 429「已有抓取任务进行中」拒掉,整次导入失败——浏览器那头的请求是断了,
 * 服务端却还在替它把上游抓完(最长 20s),page 通道并发是 1,名额一直被占着。
 *
 * 和 fetchUrl.test.ts 同一套做法:上游是本机 http.createServer,transport 只改写"连哪儿"、
 * 内部仍是生产的 nodeTransport——被测的正是它对 abort 的真实反应(掐不掐上游连接)。
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FetchFailedError,
  nodeTransport,
  safeFetchHop,
  type FetchLookup,
  type FetchTransport,
  type FetchTransportRequest,
} from '../src/lib/fetchRaw.js'
import { createTestApp, createUser, login, postJson, withSid } from './helpers.js'

const PATH = '/api/app/fetch-url'
const PUBLIC_ADDR = '93.184.216.34'
const publicLookup: FetchLookup = async () => [{ address: PUBLIC_ADDR, family: 4 }]

interface Origin {
  port: number
  /** 抵达上游的请求路径 */
  seen: string[]
  /** 上游观察到连接被对端关掉的路径(= 我们真的掐了这条连接) */
  closed: string[]
  close(): Promise<void>
}

/** `/slow` 挂着不回(模拟慢站点),其余立刻回一段 HTML */
async function startOrigin(): Promise<Origin> {
  const seen: string[] = []
  const closed: string[] = []
  const server: Server = createServer((req, res: ServerResponse) => {
    const url = req.url ?? ''
    seen.push(url)
    req.resume()
    res.on('error', () => {})
    res.on('close', () => {
      if (!res.writableFinished) closed.push(url)
    })
    if (url.startsWith('/slow')) return
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><body>hello</body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    closed,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const origins: Origin[] = []
afterEach(async () => {
  for (const o of origins.splice(0)) await o.close()
})

async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时:${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('safeFetchHop:signal', () => {
  it('进来时已经 abort → FetchFailedError,根本不建连', async () => {
    const calls: FetchTransportRequest[] = []
    const transport: FetchTransport = async (req) => {
      calls.push(req)
      return { status: 200, headers: {}, bytes: Buffer.alloc(0) }
    }
    const ac = new AbortController()
    ac.abort()
    await expect(
      safeFetchHop('https://a.example/x', { transport, lookup: publicLookup, signal: ac.signal }),
    ).rejects.toThrow(FetchFailedError)
    expect(calls).toHaveLength(0)
  })

  it('signal 原样交给 transport;不传就是 undefined(老调用方行为不变)', async () => {
    const calls: FetchTransportRequest[] = []
    const transport: FetchTransport = async (req) => {
      calls.push(req)
      return { status: 200, headers: {}, bytes: Buffer.alloc(0) }
    }
    const ac = new AbortController()
    await safeFetchHop('https://a.example/x', { transport, lookup: publicLookup, signal: ac.signal })
    await safeFetchHop('https://a.example/y', { transport, lookup: publicLookup })
    expect(calls[0].signal).toBe(ac.signal)
    expect(calls[1].signal).toBeUndefined()
  })

  it('真 nodeTransport:抓到一半 abort → 很快以 FetchFailedError 收场,且上游那条连接确实被掐断', async () => {
    const origin = await startOrigin()
    origins.push(origin)
    const transport: FetchTransport = (req) => nodeTransport({ ...req, address: '127.0.0.1', family: 4, port: origin.port })
    const ac = new AbortController()
    const began = Date.now()
    const pending = safeFetchHop('http://a.example/slow', { transport, lookup: publicLookup, timeoutMs: 5000, signal: ac.signal })
    await waitFor(() => origin.seen.includes('/slow'), '请求抵达上游')
    ac.abort()
    await expect(pending).rejects.toThrow('抓取已取消')
    expect(Date.now() - began).toBeLessThan(2000) // 远小于 5s 的超时:是被取消的,不是等超时
    await waitFor(() => origin.closed.includes('/slow'), '上游看到连接被关闭')
  })
})

describe('POST /api/app/fetch-url:客户端断开即归还并发名额', () => {
  it('慢抓取进行中客户端断开 → 同一用户紧接着的下一次抓取成功,而不是 429「已有抓取任务进行中」', async () => {
    const origin = await startOrigin()
    origins.push(origin)
    const transport: FetchTransport = (req) => nodeTransport({ ...req, address: '127.0.0.1', family: 4, port: origin.port })
    const ctx = createTestApp(undefined, { fetchTuning: { timeoutMs: 5000, lookup: publicLookup, transport } })
    await createUser(ctx.db, 'alice', 'password-1')
    const sid = await login(ctx.app, 'alice', 'password-1')

    const ac = new AbortController()
    // app.request 的返回类型是 Response | Promise<Response>;统一成 Promise 才能挂 catch
    const first = Promise.resolve(
      ctx.app.request(PATH, { ...postJson({ url: 'http://a.example/slow' }, withSid(sid)), signal: ac.signal }),
    )
    await waitFor(() => origin.seen.includes('/slow'), '慢请求抵达上游(已占住并发名额)')

    // 对照:名额确实被占着——不取消的话,第二个请求就是用户看到的那个 429
    const blocked = await ctx.app.request(PATH, postJson({ url: 'http://a.example/fast-1' }, withSid(sid)))
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ error: 'rate-limited' })

    ac.abort()
    await first.catch(() => undefined) // 已断开的那次:结果无人接收,怎么收场都行
    await waitFor(() => origin.closed.includes('/slow'), '上游连接被掐断')

    const next = await ctx.app.request(PATH, postJson({ url: 'http://a.example/fast-2' }, withSid(sid)))
    expect(next.status).toBe(200)
    expect(await next.text()).toContain('hello')
  })
})
