// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAPER_TASKS } from '../../data/paperPolicy'
import type { ExportInput, ExportResult } from '../../lib/paper/export/exportPaper'
import { estimateTranslationCost } from '../../lib/paper/translate/translateBatch'
import type { TranslateAllOptions, TranslateAllResult } from '../../lib/paper/translate/useTranslations'
import type { PaperBlock, PaperRecord } from '../../lib/paper/types'
import { formatUsd } from '../../lib/paper/usage'
import ExportDialog, { type ExportDialogProps } from './ExportDialog'

/**
 * 导出对话框的阶段机（PLAN A.7）：confirm 文案带缺译数与预估、无缺译直接生成、完成页报未译与回退、
 * 补译停机给「仍然导出」、取消 / 卸载即 abort、Esc 只在静止阶段生效。导出内核整体 mock（动态 import 同样生效）。
 */

const exportMock = vi.hoisted(() => ({
  exportPaperPdf: vi.fn<(input: ExportInput) => Promise<ExportResult>>(),
  downloadBytes: vi.fn<(bytes: Uint8Array, fileName: string) => void>(),
}))
vi.mock('../../lib/paper/export/exportPaper', () => exportMock)

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
  exportMock.exportPaperPdf.mockReset()
  exportMock.downloadBytes.mockReset()
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

const blk = (index: number, text: string, kind: PaperBlock['kind'] = 'paragraph'): PaperBlock => ({
  id: `p1:${index}`,
  paperId: 'p1',
  index,
  kind,
  text,
  anchor: { kind: 'pdf', blockIndex: index, page: 1 },
})

const PAPER = { id: 'p1', title: 'Attention', fileName: 'a.pdf', byteSize: 1000, status: 'ready' } as PaperRecord
const BLOCKS = [blk(0, 'Intro', 'heading'), blk(1, 'Alpha beta.'), blk(2, 'x = y', 'formula'), blk(3, 'Gamma delta.')]

const result = (patch: Partial<ExportResult> = {}): ExportResult => ({
  bytes: new Uint8Array([1, 2, 3]),
  fileName: 'Attention.中文.pdf',
  pageCount: 3,
  untranslated: 0,
  flavor: 'pdf-zh-overlay',
  ...patch,
})

const allResult = (patch: Partial<TranslateAllResult> = {}): TranslateAllResult => ({
  outcome: 'done',
  texts: new Map(),
  translated: 3,
  failed: [],
  total: 3,
  ...patch,
})

/** 动态 import + 多段 await：多转几轮宏任务让流程走到底 */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
  })

function render(patch: Partial<ExportDialogProps> = {}) {
  const props: ExportDialogProps = {
    paper: PAPER,
    blocks: BLOCKS,
    flavor: 'pdf-zh-overlay',
    texts: new Map(),
    translateAll: vi.fn(async () => allResult()),
    getBytes: vi.fn(async () => new ArrayBuffer(0)),
    onClose: vi.fn(),
    onDone: vi.fn(),
    ...patch,
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root?.render(createElement(ExportDialog, props)))
  const buttons = () => Array.from(container?.querySelectorAll('button') ?? [])
  return {
    props,
    button: (label: string) => buttons().find((b) => b.textContent?.trim() === label),
    labels: () => buttons().map((b) => b.textContent?.trim()),
    text: () => container?.textContent ?? '',
    title: () => container?.querySelector('[role="dialog"] h3')?.textContent ?? '',
    phase: () => container?.querySelector('[role="dialog"]')?.getAttribute('data-export-phase'),
    click: (label: string) => {
      const b = buttons().find((x) => x.textContent?.trim() === label)
      if (!b) throw new Error(`没有按钮「${label}」：${buttons().map((x) => x.textContent).join(' | ')}`)
      act(() => b.click())
    },
    key: (key: string) => act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key }))),
  }
}

describe('ExportDialog confirm', () => {
  it('有缺译：标题带版本，文案带剩余段数 / 预估 / 包数，三个按钮齐全', () => {
    const texts = new Map([[0, '引言']])
    const ui = render({ texts })
    const pending = [BLOCKS[1], BLOCKS[3]]
    const est = estimateTranslationCost(pending, PAPER_TASKS.translate.cap.pricing)
    expect(ui.phase()).toBe('confirm')
    expect(ui.title()).toBe('导出 PDF · 中文覆盖版')
    expect(ui.text()).toContain(`导出前先翻译剩余 2 段（预计 ${formatUsd(est.cost)}，约 ${est.batches} 包）`)
    expect(ui.text()).toContain('已译段落本地复用不重复计费')
    expect(ui.labels()).toEqual(expect.arrayContaining(['直接导出（未译段保留原文）', '取消', '翻译并导出']))
    expect(container?.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true')
    expect(exportMock.exportPaperPdf).not.toHaveBeenCalled()
  })

  it('Esc 在 confirm 关闭；取消按钮走 onClose', () => {
    const ui = render()
    ui.key('Escape')
    expect(ui.props.onClose).toHaveBeenCalledTimes(1)
    ui.click('取消')
    expect(ui.props.onClose).toHaveBeenCalledTimes(2)
  })

  it('「直接导出」不补译，用当前译文生成', async () => {
    exportMock.exportPaperPdf.mockResolvedValue(result({ untranslated: 2 }))
    const texts = new Map([[0, '引言']])
    const ui = render({ texts })
    ui.click('直接导出（未译段保留原文）')
    await flush()
    expect(ui.props.translateAll).not.toHaveBeenCalled()
    expect(exportMock.exportPaperPdf).toHaveBeenCalledTimes(1)
    expect(exportMock.exportPaperPdf.mock.calls[0][0].texts).toBe(texts)
    expect(ui.phase()).toBe('done')
  })
})

describe('ExportDialog 生成与完成', () => {
  it('无缺译：跳过 confirm 直接生成 → 下载 → 完成页（未译 / 回退提示）→ onDone', async () => {
    const texts = new Map([
      [0, '引言'],
      [1, '甲乙。'],
      [3, '丙丁。'],
    ])
    let release!: () => void
    exportMock.exportPaperPdf.mockImplementation(async (input) => {
      input.onProgress?.({ phase: 'font', bytes: 3 * 1024 * 1024, total: 2 * 1024 * 1024 })
      await new Promise<void>((r) => {
        release = r
      })
      return result({ untranslated: 2, flavor: 'text-zh', fellBackToText: '原始文件不在本机，已改为导出文本排版版（中文）' })
    })
    const ui = render({ texts })
    await flush()
    // 字体阶段只报 KB：已下载字节超过 gzip Content-Length 也不出百分比
    expect(ui.phase()).toBe('generating')
    expect(ui.title()).toBe('正在生成 PDF')
    expect(ui.text()).toContain('下载中文字体 3072 KB')
    expect(ui.text()).not.toContain('%')
    expect(ui.labels()).toEqual(['取消'])

    await act(async () => release())
    await flush()
    const input = exportMock.exportPaperPdf.mock.calls[0][0]
    expect(input.flavor).toBe('pdf-zh-overlay')
    expect(input.texts).toBe(texts)
    expect(input.getBytes).toBe(ui.props.getBytes)
    expect(exportMock.downloadBytes).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 'Attention.中文.pdf')
    expect(ui.phase()).toBe('done')
    expect(ui.title()).toBe('导出完成')
    expect(ui.text()).toContain('已开始下载 Attention.中文.pdf')
    expect(ui.text()).toContain('2 段未译，已保留原文')
    // 回退提示是内核拼好的整句，原样显示（不再外包「原版 PDF 无法直接改写（…）」）
    expect(ui.text()).toContain('原始文件不在本机，已改为导出文本排版版（中文）')
    expect(ui.text()).not.toContain('无法直接改写')
    expect(ui.text()).toContain('文本排版版（中文） · 共 3 页')
    expect(ui.props.onDone).toHaveBeenCalledTimes(1)

    ui.click('再次下载')
    expect(exportMock.downloadBytes).toHaveBeenCalledTimes(2)
    ui.key('Escape')
    expect(ui.props.onClose).toHaveBeenCalledTimes(1)
  })

  it('全译完成页不提未译', async () => {
    exportMock.exportPaperPdf.mockResolvedValue(result())
    const ui = render({ texts: new Map([[0, 'a'], [1, 'b'], [3, 'c']]) })
    await flush()
    expect(ui.phase()).toBe('done')
    expect(ui.text()).not.toContain('段未译')
  })

  it('生成失败 → 导出失败（带 cause）→ 重试从生成阶段重来', async () => {
    exportMock.exportPaperPdf
      .mockRejectedValueOnce(Object.assign(new Error('拿不到原始 PDF 文件'), { cause: new Error('原始文件不在本机且无法从服务端拉取') }))
      .mockResolvedValueOnce(result())
    const ui = render({ texts: new Map([[0, 'a'], [1, 'b'], [3, 'c']]) })
    await flush()
    expect(ui.phase()).toBe('error')
    expect(ui.title()).toBe('导出失败')
    expect(ui.text()).toContain('拿不到原始 PDF 文件：原始文件不在本机且无法从服务端拉取')
    expect(ui.labels()).toEqual(['关闭', '重试'])
    ui.click('重试')
    await flush()
    expect(exportMock.exportPaperPdf).toHaveBeenCalledTimes(2)
    expect(ui.phase()).toBe('done')
  })
})

describe('ExportDialog 补译', () => {
  it('翻译并导出：进度 / 失败数 / 熔断倒计时；完成后用补译快照导出（不是 React 态）', async () => {
    let finish!: (r: TranslateAllResult) => void
    let opts: TranslateAllOptions | undefined
    const translateAll = vi.fn((o?: TranslateAllOptions) => {
      opts = o
      return new Promise<TranslateAllResult>((r) => {
        finish = r
      })
    })
    exportMock.exportPaperPdf.mockResolvedValue(result({ untranslated: 1 }))
    const ui = render({ translateAll })
    ui.click('翻译并导出')
    expect(ui.phase()).toBe('translating')
    expect(ui.title()).toBe('正在补译剩余段落')

    act(() => opts?.onProgress?.({ done: 1, total: 3, failed: 1, pausedUntil: Date.now() + 9_500 }))
    expect(ui.text()).toContain('已译 1/3 段 · 失败 1 段')
    expect(ui.text()).toMatch(/熔断冷却中，(9|10) 秒后自动继续/)
    expect(container?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('33')
    // 进行中 Esc 不关
    ui.key('Escape')
    expect(ui.props.onClose).not.toHaveBeenCalled()

    const snapshot = new Map([
      [0, '引言'],
      [1, '甲乙。'],
    ])
    await act(async () => finish(allResult({ texts: snapshot, translated: 2, failed: [3] })))
    await flush()
    expect(exportMock.exportPaperPdf).toHaveBeenCalledTimes(1)
    expect([...exportMock.exportPaperPdf.mock.calls[0][0].texts]).toEqual([...snapshot])
    expect(ui.phase()).toBe('done')
    expect(ui.text()).toContain('1 段未译，已保留原文')
  })

  it('停机（未授权）→ 补译未完成 + 「仍然导出」用快照生成；「重试」再补译', async () => {
    const snapshot = new Map([[0, '引言']])
    const translateAll = vi
      .fn<(o?: TranslateAllOptions) => Promise<TranslateAllResult>>()
      .mockResolvedValue(allResult({ outcome: 'halted', halt: 'consent', texts: snapshot, translated: 1 }))
    exportMock.exportPaperPdf.mockResolvedValue(result({ untranslated: 2 }))
    const ui = render({ translateAll })
    ui.click('翻译并导出')
    await flush()
    expect(ui.phase()).toBe('error')
    expect(ui.title()).toBe('补译未完成')
    expect(ui.text()).toContain('未授权 DeepSeek 翻译')
    expect(ui.text()).toContain('已译 1/3 段')
    expect(ui.labels()).toEqual(['关闭', '重试', '仍然导出（未译段保留原文）'])

    ui.click('重试')
    await flush()
    expect(translateAll).toHaveBeenCalledTimes(2)
    expect(ui.phase()).toBe('error')

    ui.click('仍然导出（未译段保留原文）')
    await flush()
    expect(exportMock.exportPaperPdf).toHaveBeenCalledTimes(1)
    expect([...exportMock.exportPaperPdf.mock.calls[0][0].texts]).toEqual([...snapshot])
    expect(ui.phase()).toBe('done')
  })

  it('补译中取消：abort 信号并关闭；迟到的结果不再推进', async () => {
    let finish!: (r: TranslateAllResult) => void
    let signal: AbortSignal | undefined
    const translateAll = vi.fn((o?: TranslateAllOptions) => {
      signal = o?.signal
      return new Promise<TranslateAllResult>((r) => {
        finish = r
      })
    })
    const ui = render({ translateAll })
    ui.click('翻译并导出')
    expect(signal?.aborted).toBe(false)
    ui.click('取消')
    expect(signal?.aborted).toBe(true)
    expect(ui.props.onClose).toHaveBeenCalledTimes(1)
    await act(async () => finish(allResult({ outcome: 'aborted' })))
    await flush()
    expect(exportMock.exportPaperPdf).not.toHaveBeenCalled()
  })

  it('卸载即 abort（生成中）', async () => {
    let signal: AbortSignal | undefined
    exportMock.exportPaperPdf.mockImplementation((input) => {
      signal = input.signal
      return new Promise<ExportResult>(() => undefined)
    })
    render({ texts: new Map([[0, 'a'], [1, 'b'], [3, 'c']]) })
    await flush()
    expect(signal?.aborted).toBe(false)
    act(() => root?.unmount())
    root = null
    expect(signal?.aborted).toBe(true)
  })
})
