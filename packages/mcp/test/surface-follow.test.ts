// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A row that follows a curved side: on a tapering body each copy slides onto the surface where it lands and turns to
// the surface's normal there, so every copy keeps the first one's depth into the side. A row past the end of the body
// is refused with the copy named. Neutral sample: a pod turned about x whose radius curves from 10 at x 0 to 5 at x 50.
import { describe, expect, it } from 'vitest'
import { anchorOf, surfaceAlong, surfaceMoves, surfaceNear } from '@slicerx/cad-history/surface-follow'
import type { Mat4, Vec3 } from '@slicerx/cad-history/types'

/** A closed body turned about x through rings at each x in `xs` with radius r(x), `n` sides, as positions and indices. */
function lathe(xs: readonly number[], r: (x: number) => number, n = 96): { positions: number[]; indices: number[] } {
  const positions: number[] = []
  for (const x of xs) for (let k = 0; k < n; k++) positions.push(x, r(x) * Math.cos((2 * Math.PI * k) / n), r(x) * Math.sin((2 * Math.PI * k) / n))
  const indices: number[] = []
  for (let j = 0; j + 1 < xs.length; j++)
    for (let k = 0; k < n; k++) {
      const [a, b, c, d] = [j * n + k, (j + 1) * n + k, (j + 1) * n + ((k + 1) % n), j * n + ((k + 1) % n)]
      indices.push(a, b, c, a, c, d)
    }
  // end caps as fans from the first point of each end ring
  const last = (xs.length - 1) * n
  for (let k = 1; k + 1 < n; k++) indices.push(0, k + 1, k, last, last + k, last + k + 1)
  return { positions, indices }
}
// a pod whose side curves along its length: radius 10 at x 0, 5 at x 50
const radiusAt = (x: number): number => 10 - (x * x) / 500
const { positions, indices } = lathe(Array.from({ length: 41 }, (_, k) => k * 1.25), radiusAt)
const apply = (m: Mat4, p: Vec3): Vec3 => [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!, m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!, m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!]
const shift = (x: number): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]
/** The pod's outward normal on its top line at x. */
const topNormal = (x: number): Vec3 => {
  const v: Vec3 = [(2 * x) / 500, 0, 1]
  const l = Math.hypot(...v)
  return [v[0] / l, v[1] / l, v[2] / l]
}

describe('a row that follows a curved side', () => {
  it('finds the side under a cut and the side along a line', () => {
    const near = surfaceNear(positions, indices, [10, 0, 9])!
    expect(Math.hypot(near.point[1], near.point[2])).toBeCloseTo(radiusAt(near.point[0]), 1)
    const along = surfaceAlong(positions, indices, [20, 0, 0], [0, 0, 1])!
    expect(along.point[2]).toBeCloseTo(radiusAt(20), 1)
  })

  it('slides each copy onto the side where it lands and turns it to the side there, keeping its depth', () => {
    // a slit cut 1 mm into the top of the side at x 10: its middle half in, half out
    const top = radiusAt(10)
    const slit = { op: 'subtract' as const, solids: [{ type: 'box' as const, min: [9, -1, top - 1] as Vec3, max: [11, 1, top] as Vec3 }], label: 'Slit' }
    const placed = anchorOf(slit)!
    const anchor = placed.at
    expect(anchor[0]).toBe(10)
    expect(placed.box).toEqual({ min: [9, -1, top - 1], max: [11, 1, top] })
    const moves = surfaceMoves([shift(10), shift(20), shift(30)], placed, positions, indices)
    if (!Array.isArray(moves)) throw new Error(moves.why)
    const first = surfaceNear(positions, indices, anchor)!
    const depth = Math.hypot(first.point[1], first.point[2]) - anchor[2]
    for (const [k, m] of moves.entries()) {
      const x = 10 + 10 * (k + 1)
      // the copy's surface point is on the side there, and its middle as deep under it as the first one's
      const on = apply(m, first.point)
      expect(on[0]).toBeCloseTo(x, 0)
      expect(on[2]).toBeCloseTo(radiusAt(on[0]), 1)
      const mid = apply(m, anchor)
      const n = topNormal(on[0])
      expect((on[0] - mid[0]) * n[0] + (on[2] - mid[2]) * n[2]).toBeCloseTo(depth, 1)
      // and it turned with the side: the first copy's normal is the side's normal there
      const tip = apply(m, [first.point[0] + first.normal[0], first.point[1] + first.normal[1], first.point[2] + first.normal[2]])
      const turned: Vec3 = [tip[0] - on[0], tip[1] - on[1], tip[2] - on[2]]
      // (on the side the mesh's own normals face: this one's winding gives them pointing in)
      const side = Math.sign(first.normal[2])
      expect(turned[0]).toBeCloseTo(side * n[0], 1)
      expect(turned[2]).toBeCloseTo(side * n[2], 1)
    }
    // a plain row would have stood the last copy's middle more than a millimeter clear of the side, cutting nothing
    expect(anchor[2] - radiusAt(40)).toBeGreaterThan(1)
  })

  it('refuses a copy past the end of the body, naming it', () => {
    const anchor: Vec3 = [10, 0, radiusAt(10) - 0.5]
    const out = surfaceMoves([shift(20), shift(60)], { at: anchor }, positions, indices)
    expect(out).toMatchObject({ copy: 3, why: expect.stringMatching(/^The row runs off the part there/) })
  })

  it('works only from a step with a place: a cut or a shape on a face', () => {
    expect(anchorOf({ op: 'repair' } as never)).toBeNull()
  })
})
