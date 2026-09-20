import { describe, expect, it } from 'vitest'
import { ALGORITHM_INFO, PRESETS, QUIZ, RL_STAGES, SOURCES } from './agentRl'
import { DEFAULT_CONFIG, sanitizeConfig } from '../lib/agentRl/engine'

describe('Agent RL learning content contracts', () => {
  it('connects every quiz to a real lifecycle stage with an answer', () => {
    const ids = RL_STAGES.map(stage => stage.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const quiz of QUIZ) { expect(ids).toContain(quiz.stage); expect(quiz.options[quiz.answer]).toBeTruthy() }
  })
  it('records verifiable primary sources and dates for vendor claims', () => {
    for (const source of SOURCES) {
      expect(new URL(source.url).hostname).toMatch(/(^|\.)fireworks\.ai$/)
      expect(source.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    for (const algorithm of Object.values(ALGORITHM_INFO)) expect(new URL(algorithm.url).protocol).toBe('https:')
  })
  it('defines executable presets within supported parameter bounds', () => {
    expect(PRESETS).toHaveLength(6)
    for (const preset of PRESETS) {
      const config = { ...DEFAULT_CONFIG, ...preset.config }
      expect(sanitizeConfig(config)).toEqual(config)
    }
  })
})
