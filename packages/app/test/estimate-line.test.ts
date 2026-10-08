// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { estimateLine, goalEstimate, goalSubtitle } from '../src/lib/estimate-line'

const done = (stats: { timeS: number; filamentG: number[]; cost: number; toolChanges: number }, warnings = 0, stale = false) => ({
  result: { stats: { filamentMm: [], ...stats }, warnings: Array.from({ length: warnings }, () => ({ code: 'thin_wall' as const, message: 'thin' })) },
  stale,
})

describe('the footer line', () => {
  it('reads time, grams and cost, and shows changes only on a multi-color plate', () => {
    expect(estimateLine(done({ timeS: 5760, filamentG: [148], cost: 2.1, toolChanges: 0 }))).toEqual({ time: '1h 36m', grams: '148.0 g', cost: '$2.10', changes: null, warnings: null, stale: false })
    expect(estimateLine(done({ timeS: 600, filamentG: [10, 5, 0], cost: 0, toolChanges: 1 }))).toMatchObject({ cost: null, changes: '1 change' })
    expect(estimateLine(done({ timeS: 600, filamentG: [10, 5], cost: 1, toolChanges: 4 }))?.changes).toBe('4 changes')
  })

  it('hides warnings at zero and counts them otherwise', () => {
    expect(estimateLine(done({ timeS: 60, filamentG: [1], cost: 1, toolChanges: 0 }, 0))?.warnings).toBeNull()
    expect(estimateLine(done({ timeS: 60, filamentG: [1], cost: 1, toolChanges: 0 }, 1))?.warnings).toBe('1 warning')
    expect(estimateLine(done({ timeS: 60, filamentG: [1], cost: 1, toolChanges: 0 }, 3))?.warnings).toBe('3 warnings')
  })

  it('is nothing before a slice', () => {
    expect(estimateLine(null)).toBeNull()
    expect(goalEstimate(null)).toBeNull()
  })
})

describe('the line under the Goal tiles', () => {
  it('says about how long and how much, or Updating while stale', () => {
    expect(goalEstimate(estimateLine(done({ timeS: 5760, filamentG: [148], cost: 2, toolChanges: 0 })))).toBe('About 1h 36m, 148.0 g')
    expect(goalEstimate(estimateLine(done({ timeS: 5760, filamentG: [148], cost: 2, toolChanges: 0 }, 0, true)))).toBe('Updating')
    expect(goalEstimate(estimateLine(done({ timeS: 5760, filamentG: [0], cost: 0, toolChanges: 0 })))).toBe('About 1h 36m')
  })
})

describe('what each goal gives', () => {
  it('shows the layer height, and the walls for Strong', () => {
    expect(goalSubtitle('draft', { layer_height: 0.28 })).toBe('0.28 mm')
    expect(goalSubtitle('fine', { layer_height: [0.12] })).toBe('0.12 mm')
    expect(goalSubtitle('strong', { layer_height: 0.2, wall_loops: 4 })).toBe('4 walls')
    expect(goalSubtitle('standard', {})).toBe('')
  })
})
