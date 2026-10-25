// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { arrangeRules, byObjectHead, byObjectOrder, byObjectPlan, CELL_MM, convexHull, gantryLane, gantryMeets, grownHull, headMeets, hullDistance, LANE_SAFETY_MM, overRod, pairSeverity, type ByObjectShape, type Pt } from './by-object'

/** A `w` by `d` box footprint with its front left corner at `x`, `y`. */
const rect = (x: number, y: number, w: number, d: number): Pt[] => [[x, y], [x + w, y], [x + w, y + d], [x, y + d]]
const shape = (id: string, x: number, y: number, top: number, w = 20, d = 20): ByObjectShape => ({ id, name: id.toUpperCase(), hull: rect(x, y, w, d), top })

// A Bambu Lab P1S: the 68 mm max radius, the rod 34 mm up and 40 mm deep, the lid at 250 mm. The skirt is off, as sx
// would otherwise print its default one round each object, so these cases hold the objects to the clearance alone.
const P1S = { printer_model: 'Bambu Lab P1S', extruder_clearance_radius: 68, extruder_clearance_max_radius: 68, extruder_clearance_height_to_rod: 34, extruder_clearance_dist_to_rod: 40, extruder_clearance_height_to_lid: 250, nozzle_height: 4, skirt_loops: 0 }

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
    expect(plan.pairs).toEqual([{ a: { id: 'a', name: 'A' }, b: { id: 'b', name: 'B' }, gapMm: 47, reachMm: 0, severity: 'soft' }])
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

describe('the head heimdall moves', () => {
  it('is the printer profile\'s, else the printer model\'s, else the generic head, estimated only where it is not measured', () => {
    expect(byObjectHead({ printer_model: 'Bambu Lab A1' }).estimated).toBe(true)
    expect(byObjectHead({}, 'bambu-a1-mini').estimated).toBe(true)
    const p1s = byObjectHead({ printer_model: 'Bambu Lab P1S' })
    expect(p1s.estimated).toBe(false)
    expect(p1s.columns.length).toBeGreaterThan(1)
    // the profile id wins over the model
    expect(byObjectHead({ printer_model: 'Bambu Lab P1S' }, 'bambu-a1').estimated).toBe(true)
    const generic = byObjectHead({ printer_model: 'Some Printer' })
    expect(generic.estimated).toBe(false)
    expect(generic.columns).toEqual(byObjectHead({}).columns)
  })
})

describe('a pair inside the clearance radius', () => {
  const A1 = { ...P1S, printer_model: 'Bambu Lab A1', extruder_clearance_max_radius: 73 }
  it('is a close call on a measured head that clears the earlier object, and blocks on an estimated head', () => {
    const shapes = [shape('a', 0, 100, 10), shape('b', 67, 100, 10)]
    expect(byObjectPlan(shapes, P1S).pairs.map((p) => p.severity)).toEqual(['soft'])
    expect(byObjectPlan(shapes, A1).pairs.map((p) => p.severity)).toEqual(['block'])
  })

  it('blocks when the measured head\'s body would come down on the earlier object', () => {
    const head = byObjectHead(P1S)
    // 15 mm apart, the earlier one 30 mm tall: the P1S head is 26 mm wide either side of the nozzle from 8 mm up
    const [a, b] = [shape('a', 0, 100, 30), shape('b', 35, 100, 10)]
    expect(headMeets(a, b, head)).toBe(true)
    expect(pairSeverity(a, b, head)).toBe('block')
    expect(byObjectPlan([a, b], P1S).pairs.map((p) => p.severity)).toEqual(['block'])
    // the same gap under the head's lowest wide box clears it
    expect(pairSeverity(shape('a', 0, 100, 7), b, head)).toBe('soft')
  })
})

describe('the print order arrange gives a by-object plate', () => {
  it('prints a part taller than the rod last, the rest in the order they had', () => {
    // the z27 plate: a 45 mm bracket listed first, the rod 34 mm up
    const plate = [shape('bracket', 0, 100, 45), shape('a', 100, 100, 10), shape('b', 200, 100, 10)]
    expect(byObjectPlan(plate, P1S).tall.map((t) => t.id)).toEqual(['bracket'])
    const order = byObjectOrder(plate, P1S)
    expect(order).toEqual(['a', 'b', 'bracket'])
    const byId = new Map(plate.map((o) => [o.id, o]))
    expect(byObjectPlan(order.map((id) => byId.get(id)!), P1S).tall).toEqual([])
    expect(overRod(45, P1S)).toBe(true)
    expect(overRod(34, P1S)).toBe(false)
  })

  it('puts tall parts in separate lanes in any order, and side by side keeps the one it can clear', () => {
    // 100 mm apart in y: more than the rod's 40 mm reach, so neither lane holds the other
    const apart = [shape('t', 0, 0, 45), shape('u', 100, 120, 45), shape('a', 200, 0, 10)]
    const order = byObjectOrder(apart, P1S)
    expect(order[0]).toBe('a')
    const byId = new Map(apart.map((o) => [o.id, o]))
    expect(byObjectPlan(order.map((id) => byId.get(id)!), P1S).tall).toEqual([])
    // side by side only the last one clears, and the taller goes last
    const side = [shape('u', 0, 100, 50), shape('t', 100, 100, 45)]
    expect(byObjectOrder(side, P1S)).toEqual(['t', 'u'])
  })

  it('clears the beam one cell past the reach, whatever the reach, and not less, so arrange\'s two clear it', () => {
    for (const toRod of [0, 0.4, 25, 33, 40, 56.5]) {
      for (let i = 0; i < 100; i++) {
        const hi = 120 + i * 0.01 * 1.37
        // after it, and before it
        for (const past of [CELL_MM, LANE_SAFETY_MM]) {
          expect(gantryMeets([100, hi], [hi + toRod + past, hi + toRod + 30], toRod), `${toRod} ${hi}`).toBe(false)
          expect(gantryMeets([100, hi], [100 - toRod - past - 30, 100 - toRod - past], toRod), `${toRod} ${hi}`).toBe(false)
        }
      }
    }
    // 0.3 mm short of it meets the beam, with a reach of a whole number of cells and not
    expect(gantryMeets([100, 120], [120 + 33 + CELL_MM - 0.3, 170], 33)).toBe(true)
    expect(gantryMeets([100, 120], [120 + 56.5 + CELL_MM - 0.3, 200], 56.5)).toBe(true)
  })

  it('takes the lane as the footprint\'s y span grown by the rod\'s reach across the bed', () => {
    expect(gantryLane(rect(30, 100, 20, 20), P1S, 0, 256)).toEqual({ x: 0, y: 60, w: 256, h: 100 })
    // arrange holds itself to 2 mm more, since heimdall counts the bed in 1 mm cells
    expect(LANE_SAFETY_MM).toBe(2)
    expect(gantryLane(rect(30, 100, 20, 20), arrangeRules(P1S), 0, 256)).toEqual({ x: 0, y: 58, w: 256, h: 104 })
    // an arrange that keeps 37 mm from any zone (half the radius apart) gets a lane 37 mm narrower each side
    expect(gantryLane(rect(30, 100, 20, 20), P1S, 0, 256, 37)).toEqual({ x: 0, y: 97, w: 256, h: 26 })
    // past half the span it is a line across the middle
    const line = gantryLane(rect(30, 100, 20, 20), P1S, 0, 256, 60)
    expect(line.y + line.h / 2).toBeCloseTo(110, 9)
    expect(line.h).toBeCloseTo(0.1, 9)
    // an object a cell past it prints after the tall one with no gantry problem; on the lane's edge, the beam still
    // meets the tall one's last row (rows 60 to 160 for one standing on 100 to 120 with a 40 mm reach)
    const plan = byObjectPlan([shape('t', 30, 100, 45), shape('a', 200, 161, 10)], P1S)
    expect(plan.tall).toEqual([])
    expect(byObjectPlan([shape('t', 30, 100, 45), shape('a', 200, 160, 10)], P1S).tall.map((t) => t.what)).toEqual(['gantry'])
  })
})
