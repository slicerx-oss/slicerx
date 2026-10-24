// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { byObjectPlan, convexHull, grownHull, hullDistance, type ByObjectShape, type Pt } from './by-object'

/** A `w` by `d` box footprint with its front left corner at `x`, `y`. */
const rect = (x: number, y: number, w: number, d: number): Pt[] => [[x, y], [x + w, y], [x + w, y + d], [x, y + d]]
const shape = (id: string, x: number, y: number, top: number, w = 20, d = 20): ByObjectShape => ({ id, name: id.toUpperCase(), hull: rect(x, y, w, d), top })

// A Bambu Lab P1S: the 68 mm max radius, the rod 34 mm up and 40 mm deep, the lid at 250 mm.
const P1S = { printer_model: 'Bambu Lab P1S', extruder_clearance_radius: 68, extruder_clearance_max_radius: 68, extruder_clearance_height_to_rod: 34, extruder_clearance_dist_to_rod: 40, extruder_clearance_height_to_lid: 250, nozzle_height: 4 }

describe('hulls', () => {
  it('takes the convex hull counterclockwise and drops inside points', () => {
    const h = convexHull([[0, 0], [10, 0], [5, 5], [10, 10], [0, 10], [5, 0]])
    expect(h).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]])
  })

  it('grows a footprint by the distance all round', () => {
    const g = grownHull(rect(0, 0, 20, 20), 34)
    // every grown corner lies 34 mm from the box, and the zone reaches 34 mm past each side
    const fromBox = ([x, y]: Pt) => Math.hypot(Math.max(0, -x, x - 20), Math.max(0, -y, y - 20))
    for (const p of g) expect(fromBox(p)).toBeCloseTo(34, 6)
    expect(Math.max(...g.map((p) => p[0]))).toBeCloseTo(54, 6)
    expect(grownHull(rect(0, 0, 20, 20), 0)).toEqual(rect(0, 0, 20, 20))
  })

  it('measures the gap between footprints, 0 when they overlap', () => {
    expect(hullDistance(rect(0, 0, 20, 20), rect(50, 0, 20, 20))).toBeCloseTo(30, 9)
    expect(hullDistance(rect(0, 0, 20, 20), rect(10, 10, 20, 20))).toBe(0)
    // corner to corner on a diagonal
    expect(hullDistance(rect(0, 0, 10, 10), rect(13, 14, 10, 10))).toBeCloseTo(5, 9)
  })
})

describe('the by-object plan', () => {
  it('names the pairs closer than the radius in print order with their gap', () => {
    const plan = byObjectPlan([shape('a', 0, 100, 10), shape('b', 67, 100, 10), shape('c', 160, 100, 10)], P1S)
    expect(plan.needMm).toBe(68)
    expect(plan.pairs).toEqual([{ a: { id: 'a', name: 'A' }, b: { id: 'b', name: 'B' }, gapMm: 47 }])
    expect(plan.tall).toEqual([])
  })

  it('draws zones that overlap exactly when the objects are too close', () => {
    const zones = (gap: number) => byObjectPlan([shape('a', 0, 100, 10), shape('b', 20 + gap, 100, 10)], P1S).zones
    const touching = zones(68)
    expect(hullDistance(touching[0]!.zone, touching[1]!.zone)).toBeLessThan(0.1)
    expect(hullDistance(zones(69)[0]!.zone, zones(69)[1]!.zone)).toBeGreaterThan(0.5)
    expect(hullDistance(zones(60)[0]!.zone, zones(60)[1]!.zone)).toBe(0)
    expect(zones(68)[0]!.topMm).toBe(10)
  })

  it('holds objects under the nozzle to the nozzle width only', () => {
    const plan = byObjectPlan([shape('a', 0, 100, 2), shape('b', 25, 100, 2)], P1S)
    expect(plan.needMm).toBeCloseTo(3.8, 9)
    expect(plan.pairs).toEqual([])
  })

  it('holds a tall object that prints first to the rod where a later one is in its band, else the lid', () => {
    const under = byObjectPlan([shape('tall', 0, 100, 45), shape('b', 120, 110, 10)], P1S)
    expect(under.tall).toEqual([{ id: 'tall', name: 'TALL', topMm: 45, what: 'gantry', limitMm: 34 }])
    expect(under.gantry).toEqual({ rodMm: 34, reachMm: 20 })
    // 100 mm further back the rod never reaches it
    expect(byObjectPlan([shape('tall', 0, 10, 45), shape('b', 120, 200, 10)], P1S).tall).toEqual([])
    // printed last it is fine
    expect(byObjectPlan([shape('b', 120, 110, 10), shape('tall', 0, 100, 45)], P1S).tall).toEqual([])
    // over the lid anywhere
    expect(byObjectPlan([shape('tall', 0, 10, 260), shape('b', 120, 200, 10)], P1S).tall[0]).toMatchObject({ what: 'lid', limitMm: 250 })
  })
})
