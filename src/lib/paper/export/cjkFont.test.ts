import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MISSING_GLYPH, sanitizeForFont } from './cjkFont'

/**
 * 字体字符清洗 sanitizeForFont：制表 / 换行 / 回车单独处理且与删除类互不依赖顺序，控制符 / 零宽 / BOM 删除，
 * NBSP 变空格，缺字换 □（代理对按一个字符）。另有一条源码卫生：cjkFont.ts 里不得出现原始控制字符。
 */

/** 只收 ASCII 与 CJK 统一表意（不含 □ 以外的符号）的假 hasGlyph */
const asciiAndHan = (cp: number): boolean => (cp >= 0x20 && cp < 0x7f) || (cp >= 0x4e00 && cp <= 0x9fff) || cp === 0x25a1

describe('sanitizeForFont', () => {
  it('制表 → 两空格；NBSP → 空格；\\r\\n / \\r → \\n，\\n 保留', () => {
    expect(sanitizeForFont('a\tb')).toBe('a  b')
    expect(sanitizeForFont('a b')).toBe('a b')
    expect(sanitizeForFont('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })

  it('删控制符（NUL / C0 / DEL / C1）、零宽 / 方向控制、变体选择符、BOM', () => {
    expect(sanitizeForFont('a\u0000b')).toBe('ab')
    expect(sanitizeForFont('a\u0007\u000b\u000c\u001fb')).toBe('ab')
    expect(sanitizeForFont('a\u007fb')).toBe('ab')
    expect(sanitizeForFont('a\u0085\u009fb')).toBe('ab')
    expect(sanitizeForFont('a​b‍c‮d⁠e')).toBe('abcde')
    expect(sanitizeForFont('﻿a️b')).toBe('ab')
  })

  it('与步骤顺序无关：制表 / 换行 / 回车不会被删除类吞掉，夹在控制符中间也照样转换', () => {
    expect(sanitizeForFont('\u0000\t\u0000')).toBe('  ')
    expect(sanitizeForFont('\u0001\r\u0001')).toBe('\n')
    expect(sanitizeForFont('\u0002\n\u0002')).toBe('\n')
  })

  it('缺字 → □（emoji 代理对算一个字）；\\n 不查字形；NFC 先合并再查', () => {
    expect(sanitizeForFont('中文 abc', asciiAndHan)).toBe('中文 abc')
    expect(sanitizeForFont('x😀y', asciiAndHan)).toBe(`x${MISSING_GLYPH}y`)
    expect(sanitizeForFont('α→β', asciiAndHan)).toBe(MISSING_GLYPH.repeat(3))
    expect(sanitizeForFont('a\nb', asciiAndHan)).toBe('a\nb')
    // e + 组合重音 → é（单码点），按合并后的字查字形
    expect(sanitizeForFont('é', (cp) => cp === 0xe9)).toBe('é')
    // 制表 / NBSP 先变空格，再查字形（空格有字形 → 不变成 □）
    expect(sanitizeForFont('a\t b', asciiAndHan)).toBe('a   b')
  })

  it('幂等（执行器落笔前会再洗一次）', () => {
    const raw = 'x\t\u0000y\r\n z​😀中'
    const once = sanitizeForFont(raw, asciiAndHan)
    expect(sanitizeForFont(once, asciiAndHan)).toBe(once)
  })

  it('源码卫生：cjkFont.ts 不含制表 / 换行 / 回车以外的原始控制字符', () => {
    const src = fs.readFileSync(new URL('./cjkFont.ts', import.meta.url), 'utf8')
    expect(new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]').test(src)).toBe(false)
  })
})
