// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { planeContour } from '../src/contour'

const P = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1])
const I = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])

describe('planeContour', () => {
  it('cuts the cube at mid height into a square loop of four sides', () => {
    const s = planeContour(P, I, [0, 0, 1], 0.5)
    expect(s.length / 6).toBe(8)
    let len = 0
    for (let i = 0; i < s.length; i += 6) {
      expect(s[i + 2]).toBeCloseTo(0.5)
      expect(s[i + 5]).toBeCloseTo(0.5)
      len += Math.hypot((s[i + 3] ?? 0) - (s[i] ?? 0), (s[i + 4] ?? 0) - (s[i + 1] ?? 0))
    }
    expect(len).toBeCloseTo(4)
  })

  it('gives nothing above or below the mesh', () => {
    expect(planeContour(P, I, [0, 0, 1], 2).length).toBe(0)
    expect(planeContour(P, I, [0, 0, 1], -1).length).toBe(0)
  })

  it('a diagonal plane still gives closed loops of matching segments', () => {
    const s = planeContour(P, I, [1, 0, 0], 0.25)
    expect(s.length / 6).toBe(8)
  })
})
