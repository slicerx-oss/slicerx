// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every place that asks how loose a fit should be starts from one number: half the clearance the hole tolerance
// test measured for this filament, printer and nozzle, or half the nozzle when the test was never printed, and
// says which it is. Cut connectors use it until a tolerance is typed.
import { describe, expect, it } from 'vitest'
import { tuneContext, tuneKey } from '../src/calibration/tuned'
import { resolveSlots } from '../src/filament/slots'
import { clearanceFor } from '../src/plate/clearance'
import { connectorTolerance, NO_CONNECTORS } from '../src/plate/cut-plane'
import { minGapFor } from '../src/plate/fit-check'
import type { UserPreset } from '../src/presets/store'
import { get } from '../src/state/store'

function measured(mm: number): UserPreset[] {
  const s = get()
  const { printerId, nozzleMm } = tuneContext(s)
  const slot = resolveSlots(s)[0]
  return [
    {
      id: 'p1',
      kind: 'process',
      name: 'Tuned',
      values: {},
      tuned: { key: tuneKey(slot, printerId, nozzleMm), filament: 'PETG', printerId, nozzleMm, results: { tolerance: { label: 'Smallest clearance the peg fits', value: `${mm} mm`, at: 5, raw: mm } } },
      createdAt: 1,
      updatedAt: 1,
    } as UserPreset,
  ]
}

describe('the clearance for a fit', () => {
  it('comes from the hole test when it was printed, and says so', () => {
    const s = { ...get(), userPresets: measured(0.3) }
    const c = clearanceFor(s)
    expect(c.mm).toBeCloseTo(0.15)
    expect(c.measured).toBe(true)
    expect(c.words).toMatch(/^0\.15 mm a side, from your hole test/)
    expect(minGapFor(s)).toBeCloseTo(c.mm)
  })

  it('falls back to half the nozzle and asks for the test', () => {
    const s = { ...get(), userPresets: [] }
    const { nozzleMm } = tuneContext(s)
    const c = clearanceFor(s)
    expect(c.mm).toBeCloseTo(Math.max(0.1, nozzleMm / 2))
    expect(c.measured).toBe(false)
    expect(c.words).toMatch(/half the .* nozzle/)
    expect(c.words).toMatch(/hole tolerance test/)
    expect(minGapFor(s)).toBeCloseTo(c.mm)
  })

  it('sets the cut connectors until a tolerance is typed', () => {
    const s = { ...get(), userPresets: measured(0.3) }
    expect(connectorTolerance(NO_CONNECTORS, s)).toBeCloseTo(0.15)
    expect(connectorTolerance({ ...NO_CONNECTORS, toleranceMm: 0.25, toleranceSet: true }, s)).toBe(0.25)
  })
})
