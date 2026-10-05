// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { FitGap, FitReport } from '../src/geom/cad'
import { describeGap, minGapFor, relevantGaps } from '../src/plate/fit-check'
import { measuredHoleClearance, tuneContext, tuneKey } from '../src/calibration/tuned'
import { resolveSlots } from '../src/filament/slots'
import type { UserPreset } from '../src/presets/store'
import { get } from '../src/state/store'
import { fitLines, keepFits, setFit } from '../src/plate/fit-state'

const gap = (kind: FitGap['kind'], parts: [number, number], gapMm = 0.1): FitGap => ({ kind, parts, gapMm, limitMm: 0.2, from: [0, 0, 0], to: [1, 0, 0] })
const report = (gaps: FitGap[]): FitReport => ({ parts: [], gaps, limitMm: 0.2, verticalLimitMm: 0.2, warnings: [] })

describe('fit check', () => {
  it('keeps tight gaps, and touching parts only when they share a filament', () => {
    const r = report([gap('horizontal', [0, 1]), gap('fused', [0, 1], 0), gap('fused', [1, 2], 0)])
    expect(relevantGaps(r, [1, 2, 2]).map((g) => `${g.kind}:${g.parts.join('-')}`)).toEqual(['horizontal:0-1', 'fused:1-2'])
  })

  it('says what to do in one sentence', () => {
    expect(describeGap(gap('horizontal', [0, 1]), ['Peg', 'Ring'], 0.2)).toBe('Peg and Ring are 0.10 mm apart side by side; this printer keeps 0.20 mm open. Add clearance in the model.')
    expect(describeGap(gap('vertical', [0, 1], 0.12), ['Lid', 'Box'], 0.2)).toMatch(/Use a smaller layer height \(0\.12 mm or less\)/)
    expect(describeGap(gap('fused', [0, 1], 0), ['A', 'B'], 0.2)).toMatch(/touch, so they will print as one piece/)
  })

  it('keeps lines for the objects still on the plate', () => {
    setFit('a', { gaps: [gap('horizontal', [0, 1])], warnings: ['x'], limitMm: 0.2, verticalLimitMm: 0.2 })
    setFit('b', { gaps: [gap('fused', [0, 1], 0)], warnings: ['y'], limitMm: 0.2, verticalLimitMm: 0.2 })
    expect(fitLines()).toHaveLength(2)
    keepFits(['a'])
    expect(fitLines().map((l) => l.kind)).toEqual(['horizontal'])
    setFit('a', null)
    expect(fitLines()).toEqual([])
  })

  it('uses the clearance the hole tolerance test measured, whatever the hole compensation setting says now', () => {
    const s = get()
    const { printerId, nozzleMm } = tuneContext(s)
    const slot = resolveSlots(s)[0]
    const preset = (results: NonNullable<UserPreset['tuned']>['results'], values: UserPreset['values'] = {}): UserPreset =>
      ({ id: 'p1', kind: 'process', name: 'Tuned', values, tuned: { key: tuneKey(slot, printerId, nozzleMm), filament: 'PLA', printerId, nozzleMm, results }, createdAt: 1, updatedAt: 1 }) as UserPreset
    expect(minGapFor({ ...s, userPresets: [] })).toBeCloseTo(Math.max(0.1, nozzleMm / 2))
    const measured = [preset({ tolerance: { label: 'Smallest clearance the peg fits', value: '0.3 mm', at: 5, raw: 0.3 } }, { xy_hole_compensation: 0 })]
    expect(measuredHoleClearance(measured, slot, printerId, nozzleMm)).toBe(0.3)
    // Per side, so half the measured extra diameter.
    expect(minGapFor({ ...s, userPresets: measured })).toBeCloseTo(0.15)
    // A result saved before the number was kept is read from its text; another nozzle's result does not count.
    expect(measuredHoleClearance([preset({ tolerance: { label: 'x', value: '0.2 mm', at: 5 } })], slot, printerId, nozzleMm)).toBe(0.2)
    expect(measuredHoleClearance(measured, slot, printerId, nozzleMm + 0.2)).toBeUndefined()
  })
})
