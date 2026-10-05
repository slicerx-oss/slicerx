// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { EASY_GOALS, EASY_DEFAULTS } from '@slicerx/contracts/settings'
import type { EasySettings, PrintConfig } from '@slicerx/contracts/settings'
import cases from '../fixtures/easy-cases.json'
import { EASY_MAP, applyEasy, easyControlFor, goalEasy, matchGoal } from './easy'

interface Case {
  name: string
  base: string
  easy: EasySettings
  expect: Record<string, unknown>
}
const bases = cases.bases as unknown as Record<string, PrintConfig>

describe('applyEasy against fixtures/easy-cases.json', () => {
  for (const c of cases.cases as unknown as Case[]) {
    it(c.name, () => {
      const base = bases[c.base]
      expect(base).toBeDefined()
      const out = applyEasy(c.easy, base as PrintConfig)
      for (const [k, v] of Object.entries(c.expect)) expect(out[k], k).toEqual(v)
    })
  }

  it('has at least 20 cases', () => {
    expect(cases.cases.length).toBeGreaterThanOrEqual(20)
  })

  it('does not mutate the base config', () => {
    const base = structuredClone(bases['x1c']) as PrintConfig
    const copy = structuredClone(base)
    applyEasy(EASY_DEFAULTS, base)
    expect(base).toEqual(copy)
  })

  it('leaves keys it does not own alone', () => {
    const out = applyEasy(EASY_DEFAULTS, bases['bare'] as PrintConfig)
    expect(out['sparse_infill_pattern']).toBe('gyroid')
  })
})

describe('goals', () => {
  it('match the contract constants', () => {
    expect(EASY_MAP.goals).toEqual(EASY_GOALS)
  })
  it('round-trip through matchGoal', () => {
    for (const g of Object.keys(EASY_GOALS) as (keyof typeof EASY_GOALS)[]) expect(matchGoal(goalEasy(g))).toBe(g)
    expect(matchGoal({ ...EASY_DEFAULTS, detail: 55 })).toBeNull()
  })
  it('defaults equal the standard goal', () => {
    expect(EASY_DEFAULTS).toEqual(EASY_GOALS.standard)
  })
  it('names the control that writes a key', () => {
    expect(easyControlFor('layer_height')).toBe('detail')
    expect(easyControlFor('outer_wall_speed')).toBe('speed')
    expect(easyControlFor('gyroid')).toBeUndefined()
  })
})
