// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The contact shadow fades with height: what touches the bed casts the full shadow, a part lifted off it casts less the
// higher it floats, with no floor that would make a floating part look like it sits on the plate.
import { describe, expect, it } from 'vitest'
import { CONTACT_FALLOFF_MM, contactAlpha } from '../src/stage'

const SHIPPED_DARKNESS = 2.1

describe('the contact shadow', () => {
  it('is full where a part touches the bed', () => {
    expect(contactAlpha(0, SHIPPED_DARKNESS)).toBe(1)
    expect(contactAlpha(1, SHIPPED_DARKNESS)).toBe(1)
  })

  it('fades with height, with no floor under a floating part', () => {
    let last = 1
    for (const h of [2, 4, 6, 10, 15, 21]) {
      const a = contactAlpha(h, SHIPPED_DARKNESS)
      expect(a).toBeLessThanOrEqual(last)
      last = a
    }
    // the old bake kept at least 0.6 under anything up to 22 mm above the bed
    expect(contactAlpha(6, SHIPPED_DARKNESS)).toBeLessThan(0.6)
    expect(contactAlpha(10, SHIPPED_DARKNESS)).toBeLessThan(0.2)
    expect(contactAlpha(21, SHIPPED_DARKNESS)).toBeLessThan(0.02)
  })

  it('a lighter look stays lighter at every height, and nothing below the bed darkens more', () => {
    for (const h of [0, 3, 8]) expect(contactAlpha(h, 1.8)).toBeLessThanOrEqual(contactAlpha(h, SHIPPED_DARKNESS))
    expect(contactAlpha(-5, SHIPPED_DARKNESS)).toBe(contactAlpha(0, SHIPPED_DARKNESS))
    expect(CONTACT_FALLOFF_MM).toBeGreaterThan(0)
  })
})
