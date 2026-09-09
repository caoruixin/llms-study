import { afterEach, describe, expect, it } from 'vitest'
import { SYNC_CHANNEL_NAME, onSyncMessage, parseSyncMessage, postSyncMessage, type SyncCrossTabMessage } from './crossTab'

const channels: BroadcastChannel[] = []
const offs: (() => void)[] = []

afterEach(() => {
  for (const c of channels.splice(0)) c.close()
  for (const off of offs.splice(0)) off()
})

function otherTab(): BroadcastChannel {
  const ch = new BroadcastChannel(SYNC_CHANNEL_NAME)
  ;(ch as { unref?: () => void }).unref?.()
  channels.push(ch)
  return ch
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await sleep(5)
  }
}

describe('parseSyncMessage', () => {
  it('三种合法消息原样通过（多余字段丢弃）', () => {
    expect(parseSyncMessage({ kind: 'enqueued', dbName: 'd', op: 'progress', paperId: 'p', extra: 1 })).toEqual({
      kind: 'enqueued',
      dbName: 'd',
      op: 'progress',
      paperId: 'p',
    })
    expect(parseSyncMessage({ kind: 'flushed', dbName: 'd' })).toEqual({ kind: 'flushed', dbName: 'd' })
    expect(parseSyncMessage({ kind: 'pulled', dbName: 'd', paperIds: ['a'], tables: ['blocks'] })).toEqual({
      kind: 'pulled',
      dbName: 'd',
      paperIds: ['a'],
      tables: ['blocks'],
    })
  })

  it('畸形消息一律 null：非对象 / kind、dbName 非字符串 / 未知 kind / op 不在枚举 / 数组含非字符串', () => {
    const bad: unknown[] = [
      null,
      'enqueued',
      42,
      { kind: 'enqueued' },
      { kind: 'enqueued', dbName: 1, op: 'record', paperId: 'p' },
      { kind: 'enqueued', dbName: 'd', op: 'bogus', paperId: 'p' },
      { kind: 'enqueued', dbName: 'd', op: 'record' },
      { kind: 'nope', dbName: 'd' },
      { kind: 'pulled', dbName: 'd', paperIds: 'a', tables: [] },
      { kind: 'pulled', dbName: 'd', paperIds: ['a'], tables: [1] },
      { kind: 'flushed' },
    ]
    for (const b of bad) expect(parseSyncMessage(b)).toBeNull()
  })
})

describe('BroadcastChannel 往返', () => {
  it('另一 tab postMessage → 本模块监听器收到已校验消息；畸形消息不触发', async () => {
    const got: SyncCrossTabMessage[] = []
    offs.push(onSyncMessage((m) => got.push(m)))
    const tab = otherTab()
    tab.postMessage('garbage')
    tab.postMessage({ kind: 'enqueued', dbName: 'd', op: 'nope', paperId: 'p' })
    tab.postMessage({ kind: 'flushed', dbName: 'd' })
    await waitFor(() => got.length >= 1)
    await sleep(20)
    expect(got).toEqual([{ kind: 'flushed', dbName: 'd' }])
  })

  it('postSyncMessage 广播到其它 tab；取消订阅后不再收到', async () => {
    const received: unknown[] = []
    const tab = otherTab()
    tab.addEventListener('message', (ev) => received.push((ev as MessageEvent).data))
    postSyncMessage({ kind: 'pulled', dbName: 'd', paperIds: ['p1'], tables: ['translations'] })
    await waitFor(() => received.length >= 1)
    expect(received[0]).toEqual({ kind: 'pulled', dbName: 'd', paperIds: ['p1'], tables: ['translations'] })

    const got: SyncCrossTabMessage[] = []
    const off = onSyncMessage((m) => got.push(m))
    off()
    tab.postMessage({ kind: 'flushed', dbName: 'd' })
    await sleep(20)
    expect(got).toEqual([])
  })

  it('一个监听器抛错不影响其它监听器', async () => {
    const got: SyncCrossTabMessage[] = []
    offs.push(
      onSyncMessage(() => {
        throw new Error('boom')
      }),
    )
    offs.push(onSyncMessage((m) => got.push(m)))
    const warn = console.warn
    console.warn = () => undefined
    try {
      otherTab().postMessage({ kind: 'flushed', dbName: 'd' })
      await waitFor(() => got.length >= 1)
    } finally {
      console.warn = warn
    }
    expect(got).toHaveLength(1)
  })
})
