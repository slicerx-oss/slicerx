// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer with a chamber limit (the H3C heats its chamber to 65 C): the filament's Chamber temperature field takes
// no more, says the limit under the field, and says what slicing uses when a value over it came in with a project.
import { describe, expect, it } from 'vitest'
import { chamberLimit, chamberNote, parseChamber } from '../src/plate/chamber-limit'

describe('chamber limit', () => {
  it('comes from the printer profile', () => {
    expect(chamberLimit({ limits: { chamberMaxC: 65 } })).toBe(65)
    expect(chamberLimit({ limits: {} })).toBeUndefined()
    expect(chamberLimit(null)).toBeUndefined()
  })

  it('caps the field at the limit', () => {
    expect(parseChamber('70', 65)).toBe(65)
    expect(parseChamber('50', 65)).toBe(50)
    expect(parseChamber('-5', 65)).toBe(0)
    expect(parseChamber('', 65)).toBeUndefined()
    expect(parseChamber('warm', 65)).toBeNull()
  })

  it('says the limit, and what slicing uses over it, in plain words', () => {
    expect(chamberNote([40], 65)).toBe('This printer heats its chamber to 65 C at most.')
    expect(chamberNote([70], 65)).toBe('70 C is over the 65 C this printer heats its chamber to. Slicing uses 65 C.')
    expect(chamberNote([70, 50], 65)).toBe('70 C is over the 65 C this printer heats its chamber to. Slicing uses 65 C.')
    expect(chamberNote([70], undefined)).toBeUndefined()
  })
})
