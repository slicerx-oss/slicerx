// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer with a chamber limit (the H3C heats its chamber to 65 C): the Chamber temperature field takes no more,
// says the limit under the field, and says what slicing uses when a value over it came in with a project.
import { describe, expect, it } from 'vitest'
import { settingDef } from '@slicerx/settings'
import { chamberDef, chamberLimit, chamberNote } from '../src/plate/chamber-limit'

describe('chamber limit', () => {
  const def = settingDef('chamber_temperature')!

  it('comes from the printer profile', () => {
    expect(chamberLimit({ limits: { chamberMaxC: 65 } })).toBe(65)
    expect(chamberLimit({ limits: {} })).toBeUndefined()
    expect(chamberLimit(null)).toBeUndefined()
  })

  it('caps the field at the limit and leaves it alone without one', () => {
    const capped = chamberDef(def, 65)
    expect(capped.max).toBe(65)
    expect(capped.orcaMax).toBe(65)
    expect(chamberDef(def, undefined)).toBe(def)
  })

  it('says the limit, and what slicing uses over it, in plain words', () => {
    expect(chamberNote([40], 65)).toBe('This printer heats its chamber to 65 C at most.')
    expect(chamberNote([70], 65)).toBe('70 C is over the 65 C this printer heats its chamber to. Slicing uses 65 C.')
    expect(chamberNote([70, 50], 65)).toBe('70 C is over the 65 C this printer heats its chamber to. Slicing uses 65 C.')
    expect(chamberNote([70], undefined)).toBeUndefined()
  })
})
