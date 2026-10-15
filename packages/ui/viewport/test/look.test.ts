// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { BASELINE_LOOK, lookProblems, mergeLook } from '../src/look'

describe('viewport look', () => {
  it('the baseline is a valid look', () => {
    expect(lookProblems(BASELINE_LOOK)).toEqual([])
  })

  it('a patch merges key by key and leaves the base alone', () => {
    const l = mergeLook(BASELINE_LOOK, { lighting: { key: { intensity: 0.7 } }, backdrop: { top: '#2a2e3a' } })
    expect(l.lighting.key.intensity).toBe(0.7)
    expect(l.lighting.key.direction).toEqual(BASELINE_LOOK.lighting.key.direction)
    expect(l.backdrop.top).toBe('#2a2e3a')
    expect(BASELINE_LOOK.lighting.key.intensity).toBe(1.6)
    expect(BASELINE_LOOK.backdrop.top).toBeNull()
  })

  it('a filament override can be set and cleared', () => {
    const on = mergeLook(BASELINE_LOOK, { materials: { filament: { roughness: 0.62, specular: 1, clearcoat: 0, sheen: 0.7 } } })
    expect(lookProblems(on)).toEqual([])
    expect(lookProblems(mergeLook(on, { materials: { filament: null } }))).toEqual([])
  })

  it('reports bad colors, numbers and ranges by path', () => {
    const bad = mergeLook(BASELINE_LOOK, { plate: { border: 'purple' }, geometry: { aoStrength: 2 }, lighting: { key: { direction: [1, 2] as unknown as [number, number, number] } } })
    const p = lookProblems(bad)
    expect(p).toContain('plate.border must be a #rrggbb color or null')
    expect(p).toContain('geometry.aoStrength must be between 0 and 1')
    expect(p).toContain('lighting.key.direction must be 3 numbers')
  })
})
