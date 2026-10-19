// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The round holes design.check reads off a body, on the rims a boolean leaves: a bore whose rim has its corners
// bunched along one arc (as a cut through a dense body leaves them) is found at its size, and a bore with a narrower
// shoulder on its axis is two holes, not the shoulder alone. Both were missed on a 608 pillow block built in the mimir
// tab (packages/app/test/mimir-check-holes.test.ts replays that part where the engine is built).
import { describe, expect, it } from 'vitest'
import { holeLoops, sameHoles } from '../src/body-facts'

type V2 = [number, number]
type V3 = [number, number, number]

/**
 * A closed plate `size` mm square and `thick` mm thick with a through bore of `d` mm at the origin. The bore's rim is
 * a 48 sided polygon whose chords between 0 and 60 degrees are each split into `split` pieces, the way a boolean leaves
 * a rim: most of its corners on one arc.
 */
function plate(size: number, thick: number, d: number, split: number): { positions: number[]; indices: number[] } {
  const rim: V2[] = []
  for (let k = 0; k < 48; k++) {
    const [a, b] = [(2 * Math.PI * k) / 48, (2 * Math.PI * (k + 1)) / 48]
    const p: V2 = [(d / 2) * Math.cos(a), (d / 2) * Math.sin(a)]
    const q: V2 = [(d / 2) * Math.cos(b), (d / 2) * Math.sin(b)]
    const pieces = a < Math.PI / 3 ? split : 1
    for (let j = 0; j < pieces; j++) rim.push([p[0] + ((q[0] - p[0]) * j) / pieces, p[1] + ((q[1] - p[1]) * j) / pieces])
  }
  // the outline, a point on the square straight out from each rim corner
  const out = rim.map(([x, y]): V2 => {
    const s = size / 2 / Math.max(Math.abs(x), Math.abs(y))
    return [x * s, y * s]
  })
  const positions: number[] = []
  const at = (p: V2, z: number): number => {
    positions.push(p[0], p[1], z)
    return positions.length / 3 - 1
  }
  const [rt, rb, ot, ob] = [rim.map((p) => at(p, thick)), rim.map((p) => at(p, 0)), out.map((p) => at(p, thick)), out.map((p) => at(p, 0))]
  const indices: number[] = []
  const v = (i: number): V3 => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]
  // a facet turned to face `want` (a direction, or a function of the facet's center)
  const tri = (a: number, b: number, c: number, want: (m: V3) => V3) => {
    const [pa, pb, pc] = [v(a), v(b), v(c)]
    const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]
    const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]]
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
    const w = want([(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3])
    if (n[0]! * w[0] + n[1]! * w[1] + n[2]! * w[2] >= 0) indices.push(a, b, c)
    else indices.push(a, c, b)
  }
  const up = (): V3 => [0, 0, 1]
  const down = (): V3 => [0, 0, -1]
  const inward = (m: V3): V3 => [-m[0], -m[1], 0]
  const outward = (m: V3): V3 => [m[0], m[1], 0]
  for (let i = 0; i < rim.length; i++) {
    const j = (i + 1) % rim.length
    tri(ot[i]!, ot[j]!, rt[j]!, up)
    tri(ot[i]!, rt[j]!, rt[i]!, up)
    tri(ob[i]!, ob[j]!, rb[j]!, down)
    tri(ob[i]!, rb[j]!, rb[i]!, down)
    tri(rt[i]!, rt[j]!, rb[j]!, inward)
    tri(rt[i]!, rb[j]!, rb[i]!, inward)
    tri(ot[i]!, ot[j]!, ob[j]!, outward)
    tri(ot[i]!, ob[j]!, ob[i]!, outward)
  }
  return { positions, indices }
}

describe('round holes on a boolean rim', () => {
  it('finds a 21.9 mm bore whose rim corners bunch on one arc, at its center and size', () => {
    const loops = holeLoops(plate(60, 5, 21.9, 40))
    // once at each end
    expect(loops).toHaveLength(2)
    for (const l of loops) {
      expect(Math.hypot(l.at[0], l.at[1])).toBeLessThan(0.01)
      expect(l.diameterMm).toBeCloseTo(21.9, 3)
    }
    // and the same bore with an even rim, as before
    expect(holeLoops(plate(60, 5, 21.9, 1)).map((l) => Math.round(l.diameterMm * 1000) / 1000)).toEqual([21.9, 21.9])
  })

  it('keeps a bore and the narrower shoulder on its axis as two holes, and the two ends of one hole as one', () => {
    const at = (y: number): V3 => [0, y, 19]
    const axis: V3 = [0, 1, 0]
    const bore = { part: 0, at: at(-7), axis, diameterMm: 21.9 }
    const shoulder = { part: 0, at: at(0), axis, diameterMm: 18 }
    const shoulderBack = { part: 0, at: at(2), axis: [0, -1, 0] as V3, diameterMm: 18 }
    expect(sameHoles([bore, shoulder, shoulderBack]).map((h) => h.diameterMm)).toEqual([21.9, 18])
    // the far end read a little wider (a chamfer the engine did not measure past) is the same hole, the narrower kept
    expect(sameHoles([{ ...bore, diameterMm: 21.95 }, { ...bore, at: at(7) }]).map((h) => h.diameterMm)).toEqual([21.9])
  })
})
