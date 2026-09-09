import { describe, expect, it } from 'vitest'
import type { AuthStatus } from '../../lib/auth/authStore'
import type { IngestStage, PaperRecord } from '../../lib/paper/types'
import { isHollow, needsRemotePull } from './workbenchLoad'

/** 只有 status / blockCount 参与判定，其余字段填最小合法值 */
const rec = (patch: { status?: IngestStage; blockCount?: number } = {}): PaperRecord => ({
  id: 'p1',
  title: 't',
  fileName: 't.pdf',
  format: 'pdf',
  mime: 'application/pdf',
  byteSize: 1,
  sha256: 'x',
  status: patch.status ?? 'ready',
  ...(patch.blockCount === undefined ? {} : { blockCount: patch.blockCount }),
  parserVersion: 1,
  sensitive: false,
  createdAt: 0,
  updatedAt: 0,
  progress: { blockIndex: 0, ratio: 0, updatedAt: 0 },
})

describe('needsRemotePull', () => {
  const cases: {
    name: string
    authStatus: AuthStatus
    record: PaperRecord | undefined
    localBlocks: number
    want: boolean
  }[] = [
    // 未登录：没有远端可拉（unknown 时调用方压根不该走到这里，兜底也是 false）
    { name: '游客 · 本地没有这篇', authStatus: 'anon', record: undefined, localBlocks: 0, want: false },
    { name: '登录态未定 · 本地没有这篇', authStatus: 'unknown', record: undefined, localBlocks: 0, want: false },
    // 已登录 · 本地无 papers 行 → 必拉
    { name: '已登录 · 本地没有这篇', authStatus: 'authed', record: undefined, localBlocks: 0, want: true },
    // 已登录 · ready 但块数不足 → 补拉（非锁存：每次打开都重算）
    { name: '空心（blockCount 40，本地 0）', authStatus: 'authed', record: rec({ blockCount: 40 }), localBlocks: 0, want: true },
    { name: '半拉（blockCount 40，本地 12）', authStatus: 'authed', record: rec({ blockCount: 40 }), localBlocks: 12, want: true },
    // 块数到齐 → 不再白跑
    { name: '到齐（blockCount 40，本地 40）', authStatus: 'authed', record: rec({ blockCount: 40 }), localBlocks: 40, want: false },
    { name: '多于声明（旧解析残留，本地 41）', authStatus: 'authed', record: rec({ blockCount: 40 }), localBlocks: 41, want: false },
    // blockCount 缺省 → 按「至少 1 块」算：0 块永远重试，有块就算齐
    { name: 'blockCount 未定义 · 本地 0 块', authStatus: 'authed', record: rec(), localBlocks: 0, want: true },
    { name: 'blockCount 未定义 · 本地 1 块', authStatus: 'authed', record: rec(), localBlocks: 1, want: false },
    { name: 'blockCount 为 0 · 本地 0 块', authStatus: 'authed', record: rec({ blockCount: 0 }), localBlocks: 0, want: false },
    // 非 ready：正文本来就不该存在
    { name: '解析中', authStatus: 'authed', record: rec({ status: 'parsing' }), localBlocks: 0, want: false },
    { name: '解析失败', authStatus: 'authed', record: rec({ status: 'failed' }), localBlocks: 0, want: false },
    // 游客即便空心也不拉
    { name: '游客 · 空心', authStatus: 'anon', record: rec({ blockCount: 40 }), localBlocks: 0, want: false },
  ]

  for (const c of cases) {
    it(`${c.name} → ${c.want}`, () => {
      expect(needsRemotePull({ authStatus: c.authStatus, record: c.record, localBlocks: c.localBlocks })).toBe(c.want)
    })
  }
})

describe('isHollow', () => {
  const cases: { name: string; record: PaperRecord | undefined; localBlocks: number; want: boolean }[] = [
    { name: 'ready 且 0 块', record: rec({ blockCount: 40 }), localBlocks: 0, want: true },
    { name: 'ready 且 0 块（blockCount 未定义）', record: rec(), localBlocks: 0, want: true },
    { name: 'ready 且有块', record: rec({ blockCount: 40 }), localBlocks: 12, want: false },
    { name: '解析中且 0 块（走「还不能阅读」分支，不是空心）', record: rec({ status: 'parsing' }), localBlocks: 0, want: false },
    { name: '本地没有这篇（走「找不到」分支）', record: undefined, localBlocks: 0, want: false },
  ]

  for (const c of cases) {
    it(`${c.name} → ${c.want}`, () => {
      expect(isHollow(c.record, c.localBlocks)).toBe(c.want)
    })
  }
})
