// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A swatch whose color is close to the panel behind it gets a contrast edge, on dark and light themes alike; the
// distance is OKLab against the panel's resolved color, not a list of colors. The ring's data-edge in a browser is
// checked in apps/web/e2e/filament-rail.spec.ts.
import { describe, expect, it } from 'vitest'
import { colorDistance, NEAR_PANEL, nearPanel, parseColor } from '../src/components/swatch-contrast'
import { subban } from '../src/theme'
import { subbanLight } from '../src/themes'

const dark = subban.colors.ink1
const light = subbanLight.colors.ink1

describe('the contrast edge on a swatch', () => {
  it('goes on colors close to the panel, on the dark theme', () => {
    for (const c of ['#282a36', '#2c2e3c', '#1a1a1a', '#44475a']) expect(nearPanel(c, dark), c).toBe(true)
    for (const c of ['#555555', '#808080', '#ffffff', '#ff5555', '#bd93f9', '#50fa7b']) expect(nearPanel(c, dark), c).toBe(false)
  })

  it('goes on colors close to the panel, on the light theme', () => {
    for (const c of ['#ffffff', '#f8f8f2', '#e0e0e0', light]) expect(nearPanel(c, light), c).toBe(true)
    for (const c of ['#282a36', '#808080', '#ff5555', '#bd93f9', '#f1fa8c']) expect(nearPanel(c, light), c).toBe(false)
  })

  it('reads the forms a browser resolves a background to', () => {
    expect(colorDistance('rgb(44, 46, 60)', '#2c2e3c')).toBeCloseTo(0, 6)
    expect(colorDistance('rgba(44, 46, 60, 0.9)', 'color(srgb 0.1725 0.1804 0.2353)')).toBeLessThan(0.001)
    expect(colorDistance('oklab(0.5 0 0)', 'oklch(0.5 0 120)')).toBeCloseTo(0, 6)
    expect(parseColor('rgba(0, 0, 0, 0)')?.alpha).toBe(0)
    expect(parseColor('transparent')).toBeNull()
    expect(nearPanel('#ffffff', 'not a color')).toBe(false)
    expect(NEAR_PANEL).toBeGreaterThan(0)
  })
})
