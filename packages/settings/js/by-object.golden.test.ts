// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The by-object rules against the engine's own answers: fixtures/by-object-golden.json is written by the engine's test
// (packages/core/src/collide/rules.rs), so the app's check and the engine cannot drift apart.
import { describe, expect, it } from 'vitest'
import golden from '../fixtures/by-object-golden.json'
import { beamCells, byObjectHead, byObjectPlan, byObjectReach, gantryMeets, isDelta, radiusHit, type ByObjectShape, type Pt } from './by-object'

type Span = [number, number]
const box = (id: string, x: number, y: Span, top: number, reachMm = 0): ByObjectShape => {
  const hull: Pt[] = [[x, y[0]], [x + 20, y[0]], [x + 20, y[1]], [x, y[1]]]
  return { id, name: id, hull, top, reachMm }
}

describe('the by-object rules give the engine\'s answers', () => {
  it('the gantry beam, on the 1 mm cells', () => {
    for (const c of golden.gantry) {
      expect(beamCells(c.toRod), c.name).toBe(c.beamCells)
      expect(gantryMeets(c.earlier as Span, c.later as Span, c.toRod), c.name).toBe(c.meets)
      // A tall object prints first and the later one in those rows: the plan names the earlier one under the gantry.
      const cfg = { extruder_clearance_height_to_rod: 34, extruder_clearance_dist_to_rod: c.toRod, extruder_clearance_height_to_lid: 300, extruder_clearance_radius: 1 }
      const plan = byObjectPlan([box('tall', 0, c.earlier as Span, 50), box('later', 200, c.later as Span, 10)], cfg, { estimated: false, columns: [], delta: false })
      expect(plan.tall.map((t) => t.what), c.name).toEqual(c.meets ? ['gantry'] : [])
    }
  })

  it('which printers have no gantry beam', () => {
    for (const c of golden.delta) {
      const cfg = { ...(c.printerStructure ? { printer_structure: c.printerStructure } : {}), ...(c.printerModel ? { printer_model: c.printerModel } : {}) }
      expect(isDelta(cfg, c.printerId ?? undefined), JSON.stringify(c)).toBe(c.delta)
      expect(byObjectHead(cfg, c.printerId ?? undefined).delta, JSON.stringify(c)).toBe(c.delta)
    }
  })

  it('a move inside the clearance radius, what prints round the later object on top of it', () => {
    for (const c of golden.radius) {
      expect(radiusHit(c.distanceMm, c.radiusMm, c.estimated), JSON.stringify(c)).toBe(c.result)
      const cfg = { extruder_clearance_radius: c.radiusMm, extruder_clearance_height_to_rod: 100, extruder_clearance_height_to_lid: 300 }
      const plan = byObjectPlan([box('a', 0, [0, 20], 10), box('b', 20 + c.gapMm, [0, 20], 10, c.reachMm)], cfg, { estimated: c.estimated, columns: [], delta: false })
      expect(plan.pairs.map((p) => p.severity), JSON.stringify(c)).toEqual(c.result ? [c.result] : [])
    }
  })

  it('how far an object\'s own first layer prints past it', () => {
    for (const c of golden.reach) expect(Math.round(byObjectReach(c.config, c.brimMm) * 1e6) / 1e6, c.name).toBe(c.reachMm)
  })
})
