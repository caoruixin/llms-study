import { describe, expect, it } from 'vitest'
import type { SyncMetaRow } from '../../lib/paper/repo/db'
import type { IngestStage, PaperRecord } from '../../lib/paper/types'
import { HOLLOW_TITLE, syncBadgeFor, type SyncBadge } from './syncBadge'

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

const meta = (patch: Partial<SyncMetaRow> = {}): SyncMetaRow => ({ paperId: 'p1', ...patch })

const fileError = { step: 'file' as const, code: 'payload-too-large', message: '文件超出配额', status: 413, at: 1 }

describe('syncBadgeFor', () => {
  const cases: { name: string; paper: PaperRecord; meta: SyncMetaRow | undefined; authed: boolean; want: SyncBadge }[] = [
    // 1. 处理中/失败的论文不显示徽标——状态列已经说明
    { name: '解析中 · 不显示', paper: rec({ status: 'parsing' }), meta: undefined, authed: true, want: null },
    { name: '排队中 · 不显示', paper: rec({ status: 'queued' }), meta: undefined, authed: true, want: null },
    { name: '解析失败 · 不显示', paper: rec({ status: 'failed' }), meta: undefined, authed: true, want: null },
    {
      name: '解析中 · 未登录也不显示（优先级高于「仅本地」）',
      paper: rec({ status: 'parsing' }),
      meta: undefined,
      authed: false,
      want: null,
    },
    // 2. 未登录：一律「仅本地」，即便本地残留着上个账号的 syncMeta
    { name: '未登录 · 无 meta', paper: rec(), meta: undefined, authed: false, want: { label: '仅本地', tone: 'dim' } },
    {
      name: '未登录 · 有已推完的 meta 残留',
      paper: rec(),
      meta: meta({ artifactsPushed: true }),
      authed: false,
      want: { label: '仅本地', tone: 'dim' },
    },
    {
      name: '未登录 · 有失败的 meta 残留',
      paper: rec(),
      meta: meta({ lastError: fileError }),
      authed: false,
      want: { label: '仅本地', tone: 'dim' },
    },
    // 3. 推送侧失败：lastError 且制品未推齐
    {
      name: '推送失败 · title 带步骤与原因',
      paper: rec({ blockCount: 40 }),
      meta: meta({ lastError: fileError, blocksPushed: true, filePushed: false, attempts: 3 }),
      authed: true,
      want: { label: '同步失败', tone: 'bad', title: 'file: 文件超出配额' },
    },
    {
      name: '推送失败 · 拉取步骤出错同样标失败',
      paper: rec({ blockCount: 40 }),
      meta: meta({ lastError: { step: 'pull', code: 'network', message: '网络不可用', at: 2 } }),
      authed: true,
      want: { label: '同步失败', tone: 'bad', title: 'pull: 网络不可用' },
    },
    {
      name: '制品已推齐 + 残留 lastError · 仍算已同步（陈旧记录，下一轮成功即清）',
      paper: rec({ blockCount: 40 }),
      meta: meta({ artifactsPushed: true, lastError: fileError }),
      authed: true,
      want: { label: '已同步', tone: 'ok' },
    },
    // 4. 接收侧空心（§1.4）：applyOne 写的是 artifactsPushed:true，只能靠 pulledBlockCount 判定
    {
      name: '接收端空心 · 拉过一轮 0 块而 blockCount>0',
      paper: rec({ blockCount: 40 }),
      meta: meta({ artifactsPushed: true, blocksPushed: true, filePushed: true, pulledBlockCount: 0, blocksPulled: false }),
      authed: true,
      want: { label: '正文未同步', tone: 'warn', title: HOLLOW_TITLE },
    },
    {
      name: '接收端空心 · 制品未推齐时也优先报空心（早于「同步中」）',
      paper: rec({ blockCount: 40 }),
      meta: meta({ pulledBlockCount: 0, blocksPulled: false }),
      authed: true,
      want: { label: '正文未同步', tone: 'warn', title: HOLLOW_TITLE },
    },
    {
      name: '接收端空心 · 同时有 lastError 时先报失败（原因更具体）',
      paper: rec({ blockCount: 40 }),
      meta: meta({ pulledBlockCount: 0, blocksPulled: false, lastError: fileError }),
      authed: true,
      want: { label: '同步失败', tone: 'bad', title: 'file: 文件超出配额' },
    },
    {
      name: '拉到 0 块但 blockCount 也是 0 · 本来就没正文，不算空心',
      paper: rec({ blockCount: 0 }),
      meta: meta({ artifactsPushed: true, pulledBlockCount: 0, blocksPulled: false }),
      authed: true,
      want: { label: '已同步', tone: 'ok' },
    },
    {
      name: '拉到 0 块但 blockCount 缺省 · 不算空心',
      paper: rec(),
      meta: meta({ artifactsPushed: true, pulledBlockCount: 0, blocksPulled: false }),
      authed: true,
      want: { label: '已同步', tone: 'ok' },
    },
    {
      name: '拉齐了（blocksPulled:true）· 不算空心',
      paper: rec({ blockCount: 40 }),
      meta: meta({ artifactsPushed: true, pulledBlockCount: 40, blocksPulled: true }),
      authed: true,
      want: { label: '已同步', tone: 'ok' },
    },
    {
      name: '半拉（pulledBlockCount>0）· 不算空心，按已同步显示',
      paper: rec({ blockCount: 40 }),
      meta: meta({ artifactsPushed: true, pulledBlockCount: 12, blocksPulled: false }),
      authed: true,
      want: { label: '已同步', tone: 'ok' },
    },
    // 5. 常态
    {
      name: '制品推齐 · 已同步',
      paper: rec({ blockCount: 40 }),
      meta: meta({ artifactsPushed: true, blocksPushed: true, filePushed: true }),
      authed: true,
      want: { label: '已同步', tone: 'ok' },
    },
    { name: '刚导入还没有 syncMeta 行 · 同步中', paper: rec({ blockCount: 40 }), meta: undefined, authed: true, want: { label: '同步中', tone: 'pending' } },
    {
      name: '制品推了一半 · 同步中',
      paper: rec({ blockCount: 40 }),
      meta: meta({ artifactsPushed: false, blocksPushed: true, filePushed: false }),
      authed: true,
      want: { label: '同步中', tone: 'pending' },
    },
    // 6. 老库兼容：新字段（blocksPushed / pulledBlockCount / lastError / attempts）全缺
    {
      name: '老 meta（只有 artifactsPushed:true）· 已同步',
      paper: rec({ blockCount: 40 }),
      meta: meta({ artifactsPushed: true, blocksPulled: true }),
      authed: true,
      want: { label: '已同步', tone: 'ok' },
    },
    {
      name: '老 meta（只有 artifactsPushed:false）· 同步中，不误判空心',
      paper: rec({ blockCount: 40 }),
      meta: meta({ artifactsPushed: false }),
      authed: true,
      want: { label: '同步中', tone: 'pending' },
    },
    {
      name: '老 meta（空对象）· 同步中',
      paper: rec({ blockCount: 40 }),
      meta: meta(),
      authed: true,
      want: { label: '同步中', tone: 'pending' },
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      expect(syncBadgeFor(c.paper, c.meta, c.authed)).toEqual(c.want)
    })
  }
})
