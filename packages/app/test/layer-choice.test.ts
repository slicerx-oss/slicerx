// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

import { describe, expect, it } from 'vitest'
import { OPTION_TIPS } from '../src/lib/tips'
import { choicePatch, chosenFrom, detailForHeight, FIXED_HEIGHTS, SLEIPNIR, SLEIPNIR_LINE } from '../src/lib/layer-choice'

describe('layer height picker', () => {
  it('maps fixed heights onto Detail and turns sleipnir off', () => {
    expect(choicePatch(0.28)).toEqual({ varyLayerHeight: false, detail: 0 })
    expect(choicePatch(0.2)).toEqual({ varyLayerHeight: false, detail: 40 })
    expect(choicePatch(0.08)).toEqual({ varyLayerHeight: false, detail: 100 })
    expect(FIXED_HEIGHTS.map(detailForHeight)).toEqual([100, 80, 60, 40, 20, 0])
  })
  it('turns sleipnir on and keeps the base layer height', () => {
    expect(choicePatch(SLEIPNIR)).toEqual({ varyLayerHeight: true })
  })
  it('shows what is chosen', () => {
    expect(chosenFrom(true, 0.2)).toBe(SLEIPNIR)
    expect(chosenFrom(false, 0.16)).toBe(0.16)
    expect(chosenFrom(false, 0.11)).toBeNull()
  })
  it('carries the brand line and the tooltip', () => {
    expect(SLEIPNIR_LINE).toContain('Thinner layers where steps would show')
    expect(OPTION_TIPS['smart_layer.sleipnir']?.body).toMatch(/^sleipnir changes the layer height as the part goes up/)
  })
})
