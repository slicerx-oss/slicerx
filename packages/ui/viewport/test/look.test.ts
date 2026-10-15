// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { BASELINE_LOOK, DARK_PRECISION_LOOK, LIGHT_STUDIO_LOOK, LOOK_PRESETS, STUDIO_PLATE_GLOW, lookForScheme, lookProblems, mergeLook } from '../src/look'

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

  it('the studio presets are valid looks that share one shading', () => {
    for (const l of Object.values(LOOK_PRESETS)) expect(lookProblems(l)).toEqual([])
    expect(DARK_PRECISION_LOOK.lighting).toEqual(LIGHT_STUDIO_LOOK.lighting)
    expect(DARK_PRECISION_LOOK.materials).toEqual(LIGHT_STUDIO_LOOK.materials)
    expect(DARK_PRECISION_LOOK.geometry).toEqual(LIGHT_STUDIO_LOOK.geometry)
  })

  it('the studio presets keep the vignette off the models, quiet the plate glow and keep the outline in the theme color', () => {
    for (const l of [DARK_PRECISION_LOOK, LIGHT_STUDIO_LOOK]) {
      expect(l.backdrop.vignetteOnModels).toBe(false)
      expect(l.plate.borderGlow).toBe(STUDIO_PLATE_GLOW)
      expect(l.plate.border).toBeNull()
      // Studio satin: a basic filament without clearcoat, and CAD edges thinner than the shipped 1.5 px
      expect(l.materials.filament?.clearcoat).toBe(0)
      expect(l.geometry.edgeWidthPx).toBeLessThan(BASELINE_LOOK.geometry.edgeWidthPx)
    }
    expect(STUDIO_PLATE_GLOW).toBeGreaterThan(0)
    expect(STUDIO_PLATE_GLOW).toBeLessThan(BASELINE_LOOK.plate.borderGlow)
  })

  it('a scheme picks its preset, and a theme can keep its own backdrop', () => {
    expect(lookForScheme('dark')).toEqual({ preset: 'dark-precision', look: DARK_PRECISION_LOOK })
    expect(lookForScheme('light')).toEqual({ preset: 'light-studio', look: LIGHT_STUDIO_LOOK })
    const own = lookForScheme('dark', { themeBackdrop: true }).look
    expect(own.backdrop).toMatchObject({ top: null, bottom: null, center: null, vignetteOnModels: false })
    expect(own.lighting).toEqual(DARK_PRECISION_LOOK.lighting)
    expect(lookProblems(own)).toEqual([])
    // the presets themselves are never changed by a pick
    expect(DARK_PRECISION_LOOK.backdrop.top).toBe('#2a2e3a')
  })
})
