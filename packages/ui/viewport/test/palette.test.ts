// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { FEATURE } from '@slicerx/contracts'
import { DEFAULT_TOOL_COLORS, FEATURE_COLORS, HEAT_RAMP, SCENE, hexToRgb, resolveTheme, themeProblems, type ViewportTheme } from '../src/palette'

function hueSat(hex: string): { h: number; s: number } {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return { h: 0, s: 0 }
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: h * 60, s: d / max }
}

describe('FEATURE_COLORS', () => {
  it('stays off red, cyan and pink so toolpaths never read as a status', () => {
    for (const f of FEATURE_COLORS) {
      const { h, s } = hueSat(f.color)
      if (s < 0.35) continue
      const red = h >= 350 || h < 10
      const cyan = h >= 165 && h <= 205
      const pink = h >= 300 && h < 350
      expect({ id: f.label, red, cyan, pink }).toEqual({ id: f.label, red: false, cyan: false, pink: false })
    }
  })

  it('has one distinct color per feature', () => {
    expect(new Set(FEATURE_COLORS.map((f) => f.color)).size).toBe(FEATURE_COLORS.length)
    expect(new Set(FEATURE_COLORS.map((f) => f.id)).size).toBe(FEATURE_COLORS.length)
  })

  it('keeps the palette entry point free of three.js', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/palette.ts', import.meta.url), 'utf8'))
    expect(src).not.toMatch(/from 'three/)
  })
})

describe('resolveTheme', () => {
  it('returns the defaults for no theme', () => {
    const t = resolveTheme()
    expect(t.scene).toEqual(SCENE)
    expect(t.featureColors).toEqual(FEATURE_COLORS.map((f) => f.color))
    expect(t.heatRamp).toBe(HEAT_RAMP)
    expect(t.toolColors).toBe(DEFAULT_TOOL_COLORS)
  })

  it('merges overrides onto the defaults', () => {
    const t = resolveTheme({ scene: { bgTop: '#101010' }, features: { [FEATURE.support]: '#123456' }, heatRamp: ['#000000', '#ffffff'] })
    expect(t.scene.bgTop).toBe('#101010')
    expect(t.scene.bgBottom).toBe(SCENE.bgBottom)
    const i = FEATURE_COLORS.findIndex((f) => f.id === FEATURE.support)
    expect(t.featureColors[i]).toBe('#123456')
    expect(t.featureColors[0]).toBe(FEATURE_COLORS[0]?.color)
    expect(t.heatRamp).toHaveLength(2)
  })

  it('names every problem and refuses to resolve', () => {
    const bad = { scene: { bgTop: 'red', nope: '#000000' }, features: { 999: '#000000' }, heatRamp: ['#000000'] } as unknown as ViewportTheme
    const p = themeProblems(bad)
    expect(p).toHaveLength(4)
    expect(() => resolveTheme(bad)).toThrow(/Invalid viewport theme/)
  })
})
