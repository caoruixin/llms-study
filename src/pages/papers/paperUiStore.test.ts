import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  allowedCopilotWidths,
  effectiveCopilotWidth,
  nextCopilotWidth,
  sanitizeLayoutPrefs,
  type CopilotWidth,
} from './paperUiStore'

/**
 * 布局偏好的纯函数与持久化不变量。
 * 持久化用例走 vi.resetModules() + window.localStorage 桩重新导入模块：
 * zustand persist 在 create 时就同步 hydrate，必须先挂桩再 import 才测得到恢复路径。
 */

const STORAGE_KEY = 'paper-ui-layout'

class MemoryStorage {
  readonly map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

async function loadStore(seed?: string) {
  vi.resetModules()
  const storage = new MemoryStorage()
  if (seed !== undefined) storage.setItem(STORAGE_KEY, seed)
  vi.stubGlobal('window', { localStorage: storage })
  const { usePaperUi } = await import('./paperUiStore')
  return { store: usePaperUi, storage }
}

const seedOf = (state: unknown, version = 1) => JSON.stringify({ state, version })

const persisted = (storage: MemoryStorage) =>
  JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as { state?: Record<string, unknown>; version?: number }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('宽度档位纯函数', () => {
  it('平板没有超宽档，桌面三档齐全', () => {
    expect(allowedCopilotWidths(true)).toEqual(['standard', 'wide', 'max'])
    expect(allowedCopilotWidths(false)).toEqual(['standard', 'wide'])
  })

  it('平板残留的 max 偏好被钳到最宽可选档', () => {
    expect(effectiveCopilotWidth('max', allowedCopilotWidths(false))).toBe('wide')
    expect(effectiveCopilotWidth('max', allowedCopilotWidths(true))).toBe('max')
    expect(effectiveCopilotWidth('standard', allowedCopilotWidths(false))).toBe('standard')
  })

  it('循环切档到末档回绕首档', () => {
    const desktop = allowedCopilotWidths(true)
    expect(nextCopilotWidth('standard', desktop)).toBe('wide')
    expect(nextCopilotWidth('wide', desktop)).toBe('max')
    expect(nextCopilotWidth('max', desktop)).toBe('standard')
  })

  it('平板下从被钳位的 max 继续循环，回到 standard 而不是卡死', () => {
    const tablet = allowedCopilotWidths(false)
    expect(nextCopilotWidth('max', tablet)).toBe('standard')
    expect(nextCopilotWidth('wide', tablet)).toBe('standard')
    expect(nextCopilotWidth('standard', tablet)).toBe('wide')
  })

  it('循环遍历可选集后必然回到起点', () => {
    for (const isDesktop of [true, false]) {
      const allowed = allowedCopilotWidths(isDesktop)
      let cur: CopilotWidth = 'standard'
      for (let i = 0; i < allowed.length; i++) cur = nextCopilotWidth(cur, allowed)
      expect(cur).toBe('standard')
    }
  })
})

describe('sanitizeLayoutPrefs（localStorage 视为不可信输入）', () => {
  const DEFAULTS = { copilotOpen: false, outlineOpen: true, copilotWidth: 'standard', readerCollapsed: false }

  it('非对象一律回默认值', () => {
    for (const bad of [null, undefined, 42, 'x', [], true]) expect(sanitizeLayoutPrefs(bad)).toEqual(DEFAULTS)
  })

  it('逐字段类型白名单：坏值只污染自己那一格', () => {
    expect(sanitizeLayoutPrefs({ copilotOpen: 'yes', outlineOpen: false, copilotWidth: 'huge' })).toEqual({
      ...DEFAULTS,
      outlineOpen: false,
    })
    expect(sanitizeLayoutPrefs({ copilotWidth: 'max' })).toEqual({ ...DEFAULTS, copilotWidth: 'max' })
  })

  it('非法组合就地修复：Copilot 收起时不可能留在专注陪读', () => {
    expect(sanitizeLayoutPrefs({ copilotOpen: false, readerCollapsed: true }).readerCollapsed).toBe(false)
    expect(sanitizeLayoutPrefs({ copilotOpen: true, readerCollapsed: true })).toEqual({
      ...DEFAULTS,
      copilotOpen: true,
      readerCollapsed: true,
    })
  })

  it('多余字段不会被带出来', () => {
    const out = sanitizeLayoutPrefs({ copilotOpen: true, pendingAsks: [{ id: 'x' }], briefData: {} })
    expect(Object.keys(out).sort()).toEqual(['copilotOpen', 'copilotWidth', 'outlineOpen', 'readerCollapsed'])
  })
})

describe('store 不变量联动', () => {
  it('收起 Copilot 会顺带退出专注陪读', async () => {
    const { store } = await loadStore()
    store.getState().setReaderCollapsed(true)
    expect(store.getState()).toMatchObject({ readerCollapsed: true, copilotOpen: true })
    store.getState().setCopilotOpen(false)
    expect(store.getState()).toMatchObject({ readerCollapsed: false, copilotOpen: false })
  })

  it('进入专注陪读必然带上 Copilot', async () => {
    const { store } = await loadStore()
    expect(store.getState().copilotOpen).toBe(false)
    store.getState().setReaderCollapsed(true)
    expect(store.getState().copilotOpen).toBe(true)
  })

  it('展开 Copilot 不会擅自把正文收起来', async () => {
    const { store } = await loadStore()
    store.getState().setCopilotOpen(true)
    expect(store.getState().readerCollapsed).toBe(false)
  })
})

describe('persist：白名单落盘与恢复', () => {
  it('只有四个布局键落盘，运行时状态一个不进', async () => {
    const { store, storage } = await loadStore()
    store.getState().setCopilotWidth('max')
    store.getState().addPendingAsk({
      paperId: 'p1',
      action: 'explain',
      label: '解释这段',
      text: 'hello',
      anchor: { kind: 'pdf', blockIndex: 3 },
    })
    store.getState().setBriefUi({ paperId: 'p1', status: 'running', done: 1, total: 4 })

    const raw = persisted(storage)
    expect(raw.version).toBe(1)
    expect(Object.keys(raw.state ?? {}).sort()).toEqual([
      'copilotOpen',
      'copilotWidth',
      'outlineOpen',
      'readerCollapsed',
    ])
    expect(raw.state?.copilotWidth).toBe('max')
    // 运行时状态仍在内存里，只是不落盘
    expect(store.getState().pendingAsks).toHaveLength(1)
  })

  it('三项偏好都能从 localStorage 恢复', async () => {
    const { store } = await loadStore(
      seedOf({ copilotOpen: true, outlineOpen: false, copilotWidth: 'wide', readerCollapsed: true }),
    )
    expect(store.getState()).toMatchObject({
      copilotOpen: true,
      outlineOpen: false,
      copilotWidth: 'wide',
      readerCollapsed: true,
    })
  })

  it('手工塞坏值不崩，退回默认布局', async () => {
    const { store } = await loadStore(seedOf({ copilotOpen: 1, copilotWidth: 'gigantic', readerCollapsed: 'yes' }))
    expect(store.getState()).toMatchObject({
      copilotOpen: false,
      outlineOpen: true,
      copilotWidth: 'standard',
      readerCollapsed: false,
    })
    // 恢复后仍可正常操作
    store.getState().setCopilotWidth('wide')
    expect(store.getState().copilotWidth).toBe('wide')
  })

  it('整条记录不是 JSON 也不崩', async () => {
    const { store } = await loadStore('}{ not json')
    expect(store.getState()).toMatchObject({ copilotOpen: false, copilotWidth: 'standard' })
  })

  it('恢复不会覆盖 action：hydrate 后 setter 仍在', async () => {
    const { store } = await loadStore(seedOf({ copilotOpen: true }))
    expect(typeof store.getState().setReaderCollapsed).toBe('function')
    expect(typeof store.getState().requestBrief).toBe('function')
  })
})
