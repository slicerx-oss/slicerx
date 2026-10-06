// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A round edge (a corner on a circle and its center) is drawn as the circle and measured to the circle, so the
// fillet tool shows a hole's rim whole and a pointer near any part of it finds it.
import { describe, expect, it } from 'vitest'
import { edgeDistance, edgeLines } from '../src/cad/edges'

const rim = { a: [103, 100, 10] as [number, number, number], b: [103, 100, 10] as [number, number, number], face: [0, 0, 1] as [number, number, number], center: [100, 100, 10] as [number, number, number] }

describe('a round edge in the fillet tool', () => {
  it('is drawn as its whole circle', () => {
    const lines = edgeLines(rim)
    expect(lines.length).toBe(64)
    for (const { from, to } of lines) {
      for (const p of [from, to]) {
        expect(Math.hypot(p[0] - 100, p[1] - 100)).toBeCloseTo(3, 9)
        expect(p[2]).toBeCloseTo(10, 9)
      }
    }
    expect(lines[63]!.to).toEqual(lines[0]!.from)
  })

  it('is near a pointer anywhere along the circle', () => {
    expect(edgeDistance([97, 100, 10], rim)).toBeCloseTo(0, 9)
    expect(edgeDistance([100, 104, 10], rim)).toBeCloseTo(1, 9)
    expect(edgeDistance([100, 103, 12], rim)).toBeCloseTo(2, 9)
  })

  it('leaves a straight edge as it was', () => {
    const e = { a: [0, 0, 0] as [number, number, number], b: [10, 0, 0] as [number, number, number], face: [0, 0, 1] as [number, number, number] }
    expect(edgeLines(e)).toEqual([{ from: [0, 0, 0], to: [10, 0, 0] }])
    expect(edgeDistance([5, 2, 0], e)).toBeCloseTo(2, 9)
  })
})
