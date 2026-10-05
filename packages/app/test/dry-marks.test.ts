// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { DRY_FOR_MS, dryKey, isDryingNote, pruneMarks, spoolOf, stillDry } from '../src/filament/dry-marks'
import { markDry } from '../src/filament/setup-plan'
import { get } from '../src/state/store'

describe("It's dry", () => {
  const pla = { type: 'PLA', brand: 'Bambu', color: '#000000' }
  it('answers the drying note and the drying question only', () => {
    expect(isDryingNote('Dry PLA before printing (recommended).')).toBe(true)
    expect(isDryingNote('Has the PA spool been dried in the last day? PA is marked drying required.')).toBe(true)
    expect(isDryingNote('PLA needs a nozzle of at least 0.4 mm.')).toBe(false)
  })

  it('tells spools apart by their tag, else by what the printer reports, else by the slot setup', () => {
    expect(spoolOf(pla, { spoolUid: 'A1B2', material: 'PLA Basic', color: '#000000' })).toBe('tag:A1B2')
    expect(spoolOf(pla, { material: 'PLA Basic', color: '#000000' })).toBe('tray:pla basic|#000000')
    expect(spoolOf(pla)).toBe('set:pla|bambu|#000000')
  })

  it('holds for the same spool for seven days, and not for a swapped one', () => {
    const now = 1_000_000_000
    const mark = { at: now, spool: 'tag:A1B2' }
    expect(stillDry(mark, 'tag:A1B2', now + DRY_FOR_MS - 1)).toBe(true)
    expect(stillDry(mark, 'tag:A1B2', now + DRY_FOR_MS)).toBe(false)
    expect(stillDry(mark, 'tag:FFEE', now + 1000)).toBe(false)
    expect(stillDry(undefined, 'tag:A1B2', now)).toBe(false)
    expect(pruneMarks({ old: { at: now - DRY_FOR_MS, spool: 'x' }, fresh: mark }, now)).toEqual({ fresh: mark })
  })

  it('keeps the answer per printer and slot', () => {
    markDry('h2d', { label: 'A1', spool: 'tag:A1B2' }, 5000)
    markDry('a1', { label: 'A1', spool: 'tag:C3D4' }, 6000)
    expect(get().dryMarks[dryKey('h2d', 'A1')]).toEqual({ at: 5000, spool: 'tag:A1B2' })
    expect(get().dryMarks[dryKey('a1', 'A1')]).toEqual({ at: 6000, spool: 'tag:C3D4' })
  })
})
