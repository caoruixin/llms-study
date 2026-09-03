import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  allowedCopilotWidths,
  effectiveCopilotWidth,
  nextCopilotWidth,
  sanitizeLayoutPrefs,
  sanitizeVoicePrefs,
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

describe('sanitizeVoicePrefs（语音偏好，localStorage 同样不可信）', () => {
  const DEFAULTS = {
    voiceSpeakAloud: true,
    voiceSpeakTypedTurns: false,
    voiceContinuous: false,
    voiceHotkey: true,
    voiceTtsVoice: '',
    voiceTtsEngine: 'cloud',
    voiceBallHidden: false,
  }

  it('非对象一律回默认值', () => {
    for (const bad of [null, undefined, 42, 'x', [], true]) expect(sanitizeVoicePrefs(bad)).toEqual(DEFAULTS)
  })

  it('逐字段白名单：坏值只污染自己那一格', () => {
    expect(sanitizeVoicePrefs({ voiceSpeakAloud: 'yes', voiceContinuous: true, voiceTtsEngine: 'chip' })).toEqual({
      ...DEFAULTS,
      voiceContinuous: true,
    })
  })

  it('音色 id：超长字符串退回默认，合法枚举引擎保留', () => {
    expect(sanitizeVoicePrefs({ voiceTtsVoice: 'x'.repeat(200) }).voiceTtsVoice).toBe('')
    expect(sanitizeVoicePrefs({ voiceTtsVoice: 'anna', voiceTtsEngine: 'browser' })).toMatchObject({
      voiceTtsVoice: 'anna',
      voiceTtsEngine: 'browser',
    })
  })

  it('运行时状态字段不会被带出来', () => {
    const out = sanitizeVoicePrefs({ voiceAsk: { id: 'x' }, voiceTurnPhase: 'speaking', voiceSpeakAloud: false })
    expect(Object.keys(out).sort()).toEqual(Object.keys(DEFAULTS).sort())
    expect(out.voiceSpeakAloud).toBe(false)
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
  it('只有布局与语音偏好键落盘，运行时状态一个不进', async () => {
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
    store.getState().requestVoiceAsk({
      paperId: 'p1',
      text: '这段怎么理解',
      selection: null,
      viewportContext: '可见正文',
      speak: true,
    })

    const raw = persisted(storage)
    expect(raw.version).toBe(1)
    expect(Object.keys(raw.state ?? {}).sort()).toEqual([
      'copilotOpen',
      'copilotWidth',
      'outlineOpen',
      'readerCollapsed',
      'voiceBallHidden',
      'voiceContinuous',
      'voiceHotkey',
      'voiceSpeakAloud',
      'voiceSpeakTypedTurns',
      'voiceTtsEngine',
      'voiceTtsVoice',
    ])
    expect(raw.state?.copilotWidth).toBe('max')
    // 运行时状态仍在内存里，只是不落盘
    expect(store.getState().pendingAsks).toHaveLength(1)
    expect(store.getState().voiceAsk?.text).toBe('这段怎么理解')
  })

  it('语音提问载荷：requestVoiceAsk 展开面板并复位阶段，consume 后清空', async () => {
    const { store } = await loadStore()
    store.getState().setVoiceTurnPhase('error', '上一轮的错')
    store.getState().requestVoiceAsk({
      paperId: 'p1',
      text: '注意力分数怎么算',
      selection: '选区',
      viewportContext: null,
      speak: false,
    })
    const s = store.getState()
    expect(s.copilotOpen).toBe(true)
    expect(s.voiceTurnPhase).toBe('idle')
    expect(s.voiceTurnError).toBeNull()
    expect(s.voiceAsk).toMatchObject({ paperId: 'p1', text: '注意力分数怎么算', speak: false })
    expect(typeof s.voiceAsk?.id).toBe('string')
    store.getState().consumeVoiceAsk()
    expect(store.getState().voiceAsk).toBeNull()
  })

  it('阶段回写与打断信号：setVoiceTurnPhase 带错误文案，requestStopSpeak 单调递增', async () => {
    const { store } = await loadStore()
    store.getState().setVoiceTurnPhase('speaking')
    expect(store.getState()).toMatchObject({ voiceTurnPhase: 'speaking', voiceTurnError: null })
    store.getState().setVoiceTurnPhase('error', '云端朗读不可用')
    expect(store.getState().voiceTurnError).toBe('云端朗读不可用')
    const before = store.getState().voiceStopSpeakTick
    store.getState().requestStopSpeak()
    store.getState().requestStopSpeak()
    expect(store.getState().voiceStopSpeakTick).toBe(before + 2)
  })

  it('setVoicePrefs 局部更新并落盘', async () => {
    const { store, storage } = await loadStore()
    store.getState().setVoicePrefs({ voiceContinuous: true, voiceTtsVoice: 'anna' })
    expect(store.getState()).toMatchObject({ voiceContinuous: true, voiceTtsVoice: 'anna', voiceSpeakAloud: true })
    const raw = persisted(storage)
    expect(raw.state?.voiceContinuous).toBe(true)
    expect(raw.state?.voiceTtsVoice).toBe('anna')
  })

  it('坏语音偏好从 localStorage 恢复时被净化', async () => {
    const { store } = await loadStore(
      seedOf({ copilotOpen: true, voiceTtsEngine: 'chip', voiceContinuous: 'yes', voiceHotkey: false }),
    )
    expect(store.getState()).toMatchObject({
      copilotOpen: true,
      voiceTtsEngine: 'cloud',
      voiceContinuous: false,
      voiceHotkey: false,
    })
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
