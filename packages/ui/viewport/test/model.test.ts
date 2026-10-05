// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { creasedGeometry } from '../src/model'
import { displayHex } from '../src/palette'

// Unit cube, 8 shared corners, 12 outward-wound triangles.
const P = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1])
const I = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])

describe('creasedGeometry', () => {
  it('keeps cube faces flat: every normal is a unit axis vector', () => {
    const g = creasedGeometry(P, I)
    const n = g.getAttribute('normal').array
    expect(g.getAttribute('position').count).toBe(36)
    for (let i = 0; i < n.length; i += 3) {
      const v = [n[i] ?? 0, n[i + 1] ?? 0, n[i + 2] ?? 0].map((x) => Math.abs(x)).sort()
      expect(v[0]).toBeCloseTo(0)
      expect(v[1]).toBeCloseTo(0)
      expect(v[2]).toBeCloseTo(1)
    }
  })
})

describe('displayHex', () => {
  it('lifts pure black and tames pure white so shading still reads', () => {
    expect(displayHex('#000000')).toBe('#1d1d21')
    expect(displayHex('#ffffff')).toBe('#ebebe6')
    expect(displayHex('#ff9016')).toBe('#ff9016')
  })
})
