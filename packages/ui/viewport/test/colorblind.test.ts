// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { COLORBLIND_THEME, FEATURE_COLORS, hexToRgb, resolveTheme, themeProblems } from '../src/palette'

// Machado et al. 2009, severity 1.0, applied to linear RGB.
const SIM = {
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
} as const

const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

function lab(hex: string, m?: readonly (readonly number[])[]): [number, number, number] {
  let [r, g, b] = hexToRgb(hex).map(lin) as [number, number, number]
  if (m) [r, g, b] = [0, 1, 2].map((i) => Math.min(1, Math.max(0, m[i]![0]! * r + m[i]![1]! * g + m[i]![2]! * b))) as [number, number, number]
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))]
}
const dE = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe('color vision friendly toolpath palette', () => {
  it('is a valid viewport theme that colors every feature', () => {
    expect(themeProblems(COLORBLIND_THEME)).toEqual([])
    expect(Object.keys(COLORBLIND_THEME.features).map(Number).sort()).toEqual(FEATURE_COLORS.map((f) => f.id).sort())
    expect(resolveTheme(COLORBLIND_THEME).featureColors).toHaveLength(FEATURE_COLORS.length)
  })

  // The walls, surfaces, infill, bridge and support a person reads a preview by.
  const MAIN = ['Outer wall', 'Inner wall', 'Overhang wall', 'Top surface', 'Bottom surface', 'Internal solid infill', 'Sparse infill', 'Bridge', 'Support']
  for (const [name, m] of Object.entries(SIM)) {
    it(`keeps the main features apart under ${name}`, () => {
      const main = FEATURE_COLORS.filter((f) => MAIN.includes(f.label))
      const worst: string[] = []
      for (let i = 0; i < main.length; i++)
        for (let j = i + 1; j < main.length; j++) {
          const d = dE(lab(COLORBLIND_THEME.features[main[i]!.id]!, m), lab(COLORBLIND_THEME.features[main[j]!.id]!, m))
          if (d < 15) worst.push(`${main[i]!.label} / ${main[j]!.label}: ${d.toFixed(1)}`)
        }
      expect(worst).toEqual([])
    })

    it(`keeps heat ramp stops apart under ${name}`, () => {
      const r = COLORBLIND_THEME.heatRamp
      for (let i = 1; i < r.length; i++) expect(dE(lab(r[i - 1]!, m), lab(r[i]!, m))).toBeGreaterThan(15)
      expect(dE(lab(r[0]!, m), lab(r[r.length - 1]!, m))).toBeGreaterThan(30)
    })
  }

  it('overhang red and amber do not rely on red against green', () => {
    const { overhangRed, overhangAmber } = COLORBLIND_THEME.scene
    for (const m of Object.values(SIM)) expect(dE(lab(overhangRed, m), lab(overhangAmber, m))).toBeGreaterThan(25)
  })
})
