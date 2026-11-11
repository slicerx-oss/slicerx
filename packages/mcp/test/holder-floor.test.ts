// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A part that holds something keeps its floor: which plans set one (read from their sizes and kinds, over every plan
// the build eval and creative recordings made), where a cavity opens through the bottom (holder-floor.ts) on parts
// built here and on parts mimir built in recorded runs, and the floor item design.check adds for such a plan.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { floorFacts } from '../src/body-facts'
import { designCheck, plannedFloor, plannedHoleMm, type BodyFacts, type PartPlan } from '../src/design-check'
import { allOpenings, floorOpenings, type FloorMesh } from '../src/holder-floor'

type V3 = [number, number, number]

/** A mesh from rings of points: each ring's points counterclockwise seen from above. */
function meshOf(build: (add: (p: V3) => number, tri: (a: number, b: number, c: number) => void) => void): FloorMesh {
  const positions: number[] = []
  const indices: number[] = []
  build(
    (p) => {
      positions.push(...p)
      return positions.length / 3 - 1
    },
    (a, b, c) => void indices.push(a, b, c),
  )
  return { positions, indices }
}

/** A polygon's corners at radius r, turned by `turn` radians, at height z. */
const ring = (sides: number, r: number, turn: number, z: number): V3[] => Array.from({ length: sides }, (_, k) => [r * Math.cos(turn + (2 * Math.PI * k) / sides), r * Math.sin(turn + (2 * Math.PI * k) / sides), z])

/**
 * A twisted polygon vase: corner radius `r`, wall `wall` (as a corner radius less), height `h`, turned `twistDeg` from
 * bottom to top in `layers` steps, open at the top. `floor` mm thick at the bottom, or 0 for an open tube; `foot`, a
 * recess that deep under the floor, `footR` across its corners.
 */
function vase(o: { sides?: number; r?: number; wall?: number; h?: number; twistDeg?: number; layers?: number; floor: number; foot?: number; footR?: number }): FloorMesh {
  const { sides = 6, r = 40, wall = 2.3, h = 160, twistDeg = 60, layers = 16, floor, foot = 0, footR = 30 } = o
  const turn = (z: number): number => ((twistDeg * Math.PI) / 180) * (z / h)
  return meshOf((add, tri) => {
    const rings = (radius: number, zs: number[]): number[][] => zs.map((z) => ring(sides, radius, turn(z), z).map(add))
    const wallOf = (rs: number[][], outward: boolean): void => {
      for (let j = 0; j + 1 < rs.length; j++)
        for (let i = 0; i < sides; i++) {
          const [a, b, c, d] = [rs[j]![i]!, rs[j]![(i + 1) % sides]!, rs[j + 1]![(i + 1) % sides]!, rs[j + 1]![i]!]
          if (outward) {
            tri(a, b, c)
            tri(a, c, d)
          } else {
            tri(a, c, b)
            tri(a, d, c)
          }
        }
    }
    const band = (outer: number[], inner: number[], up: boolean): void => {
      for (let i = 0; i < sides; i++) {
        const [a, b, c, d] = [outer[i]!, outer[(i + 1) % sides]!, inner[(i + 1) % sides]!, inner[i]!]
        if (up) {
          tri(a, b, c)
          tri(a, c, d)
        } else {
          tri(a, c, b)
          tri(a, d, c)
        }
      }
    }
    const cap = (pts: number[], z: number, up: boolean): void => {
      const c = add([0, 0, z])
      for (let i = 0; i < sides; i++) (up ? tri(c, pts[i]!, pts[(i + 1) % sides]!) : tri(c, pts[(i + 1) % sides]!, pts[i]!))
    }
    const steps = (from: number): number[] => Array.from({ length: layers + 1 }, (_, k) => from + ((h - from) * k) / layers)
    const outer = rings(r, steps(0))
    const inner = rings(r - wall, steps(floor))
    wallOf(outer, true)
    wallOf(inner, false)
    band(outer.at(-1)!, inner.at(-1)!, true)
    if (floor === 0) band(outer[0]!, inner[0]!, false)
    else {
      cap(inner[0]!, floor, true)
      if (foot === 0) cap(outer[0]!, 0, false)
      else {
        const recess = rings(footR, [0, foot])
        band(outer[0]!, recess[0]!, false)
        wallOf(recess, false)
        cap(recess[1]!, foot, false)
      }
    }
  })
}

const fixtures = JSON.parse(gunzipSync(readFileSync(join(__dirname, 'fixtures', 'holder-floors.json.gz'))).toString('utf8')) as Record<string, { from: string; plan?: PartPlan; parts: { name: string; positions: number[]; indices: number[] }[] }>
const recordedPlans = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'holder-plans.json'), 'utf8')) as { recording: string; plan: Omit<PartPlan, 'planId'> }[]

/** The square bottle's plan, as the build eval case asks for it (no recording keeps one). */
const BOTTLE_PLAN: PartPlan = {
  planId: 'p-bottle',
  part: 'Square bottle',
  units: 'mm',
  features: [
    { name: 'Square body', kind: 'loft', sizes: { side: 70, height: 150 } },
    { name: 'Round neck', kind: 'loft', sizes: { diameter: 30, height: 25 } },
    { name: 'Hollow', kind: 'shell', sizes: { wall: 2, bottom: 2 } },
  ],
  assumptions: ['Closed bottom, open at the top of the neck'],
  questions: [],
}

describe('the plans that set a floor', () => {
  it('reads a floor from the sizes of every recorded plan that holds something, and from no other', () => {
    const holders = recordedPlans.filter((r) => plannedFloor(r.plan)).map((r) => `${r.recording}: ${plannedFloor(r.plan)!.mm} mm (${plannedFloor(r.plan)!.from})`)
    expect(holders).toEqual([
      'flared-vase: 3 mm (bottom_thickness)',
      'planter-saucer: 3 mm (depth 97 mm under the 100 mm height)',
      'planter-saucer 2: 3 mm (depth 12 mm under the 15 mm height)',
      'twisted-vase: 3 mm (bottom)',
      'knit-vase: 2 mm (base_thickness)',
      'honeycomb-pen-cup: 3 mm (floor)',
      'twisted-vase (open tube): 3 mm (bottom)',
    ])
    expect(plannedFloor(BOTTLE_PLAN)).toEqual({ mm: 2, from: 'bottom' })
  })

  it('reads no floor from a base under a part, a spout open at both ends, a groove depth or a bottom width', () => {
    const plan = (features: PartPlan['features'], overall?: PartPlan['overall']): PartPlan => ({ planId: 'p', part: 'Part', units: 'mm', features, assumptions: [], questions: [], ...(overall ? { overall } : {}) })
    // a fidget spinner's base disk: a base thickness, but nothing hollow
    expect(plannedFloor(plan([{ name: 'Base disk', kind: 'extrude', sizes: { base_diameter: 60, base_thickness: 3 } }]))).toBeNull()
    // a spout's bore: hollow, and no floor
    expect(plannedFloor(plan([{ name: 'Bore', kind: 'cut', sizes: { base_id: 18.8, tip_id: 5.8, wall: 1.6 } }]))).toBeNull()
    // knit grooves cut 1 mm deep into a 160 mm vase are no cavity
    expect(plannedFloor(plan([{ name: 'Body', kind: 'revolve', sizes: { height: 160 } }, { name: 'Grooves', kind: 'cut', sizes: { groove_depth: 1 } }]))).toBeNull()
    // a bottom width is a size across, not a floor
    expect(plannedFloor(plan([{ name: 'Shell', kind: 'shell', sizes: { wall: 2, bottom_width: 60 } }]))).toBeNull()
    // a cavity as deep as the part is a sleeve, open at the bottom too
    expect(plannedFloor(plan([{ name: 'Body', kind: 'extrude', sizes: { height: 40 } }, { name: 'Bore', kind: 'cut', sizes: { depth: 40 } }]))).toBeNull()
    // inches read in mm
    expect(plannedFloor({ ...plan([{ name: 'Body', kind: 'extrude', sizes: { height: 4 } }, { name: 'Well', kind: 'cut', sizes: { depth: 3.875 } }]), units: 'in' })?.mm).toBeCloseTo(3.175, 6)
  })

  it('takes the widest hole a plan puts through its part, from its holes list or a hole diameter size', () => {
    const planter = recordedPlans.find((r) => r.recording === 'planter-saucer')!.plan
    expect(plannedHoleMm(planter)).toBe(6)
    expect(plannedHoleMm(BOTTLE_PLAN)).toBe(0)
    expect(plannedHoleMm({ units: 'mm', features: [{ name: 'Screw', kind: 'countersunk hole', sizes: { diameter: 4, countersink_diameter: 8 } }], holes: [{ name: 'Drain', diameter: 5 }] })).toBe(5)
  })
})

/** Closed upright prisms in one mesh, each `sides` corners at radius `r` around its (x, y), from z 0 to `h`: separate bodies. */
function uprights(at: [number, number][], o: { sides?: number; r?: number; h?: number } = {}): FloorMesh {
  const { sides = 8, r = 3, h = 15 } = o
  return meshOf((add, tri) => {
    for (const [x, y] of at) {
      const lo = ring(sides, r, 0.1, 0).map(([a, b, c]) => add([a + x, b + y, c]))
      const hi = ring(sides, r, 0.1, h).map(([a, b, c]) => add([a + x, b + y, c]))
      const cl = add([x, y, 0])
      const ch = add([x, y, h])
      for (let i = 0; i < sides; i++) {
        const j = (i + 1) % sides
        tri(lo[i]!, lo[j]!, hi[j]!)
        tri(lo[i]!, hi[j]!, hi[i]!)
        tri(cl, lo[j]!, lo[i]!)
        tri(ch, hi[i]!, hi[j]!)
      }
    }
  })
}

describe('where a cavity opens through the bottom', () => {
  it('reads no opening between separate bodies in one part, with nothing either side of the air across the ray', () => {
    // two uprights side by side, and a row of four 22 mm apart: air between them, but no wall around it
    expect(allOpenings(floorOpenings([uprights([[0, 0], [10, 0]])]))).toEqual([])
    expect(allOpenings(floorOpenings([uprights([[0, 0], [22, 0], [44, 0], [66, 0]], { r: 2.75, h: 15.8 })]))).toEqual([])
    // the open tube still reads open: its cavity has walls all round
    expect(allOpenings(floorOpenings([vase({ floor: 0 })])).length).toBe(1)
  })

  it('finds the open bottom of a twisted tube, and none under a floor or a recessed foot', () => {
    const tube = floorOpenings([vase({ floor: 0 })])
    const open = allOpenings(tube)
    expect(open.length).toBe(1)
    // the 2.3 mm wall either side of a 75.4 mm cavity, read at z 0.2, the probe height
    expect(open[0]!.alongMm).toBeGreaterThan(65)
    expect(open[0]!.from[2]).toBeCloseTo(0.2, 3)
    expect(tube.parts[0]!.faceZ).toBe(0)
    expect(allOpenings(floorOpenings([vase({ floor: 3 })]))).toEqual([])
    // air under a raised floor is a foot, not an opening: a vertical line there meets the floor
    expect(allOpenings(floorOpenings([vase({ floor: 6, foot: 3 })]))).toEqual([])
  })

  it('reads a recorded twisted vase built as an open tube as open, and the recorded planter, saucer, pen cup and bottle as closed', () => {
    const tube = fixtures['twisted-vase-open']!
    const open = allOpenings(floorOpenings(tube.parts))
    expect(open.length).toBeGreaterThan(0)
    expect(open[0]!.faceZ).toBeCloseTo(0, 3)
    for (const id of ['planter-saucer', 'honeycomb-pen-cup', 'square-bottle']) {
      const f = fixtures[id]!
      const holes = f.plan ? plannedHoleMm(f.plan) : 0
      expect(allOpenings(floorOpenings(f.parts, holes)), id).toEqual([])
    }
    // the planter's drain holes are openings when the plan has no holes
    expect(allOpenings(floorOpenings(fixtures['planter-saucer']!.parts.slice(0, 1))).length).toBeGreaterThan(0)
  })
})

describe('the floor item of design.check', () => {
  const body = (floor: BodyFacts['floor']): BodyFacts => ({ size: { x: 80, y: 69.28, z: 160 }, holes: [], features: 3, watertight: true, minWallMm: 2, floor })

  it('fails a twisted vase whose cavity runs out through the bottom, naming the bottom face and where the air runs through it', () => {
    const tube = fixtures['twisted-vase-open']!
    const result = designCheck({ ...tube.plan!, planId: 'p-tube' }, body(floorFacts(tube.parts, tube.parts.map((x) => x.name), plannedHoleMm(tube.plan!))), 0.4)
    const item = result.items.find((i) => i.name === 'floor')!
    expect(result.pass).toBe(false)
    expect(item.pass).toBe(false)
    expect(item.want).toBe("closed at the bottom, with the plan's 3 mm floor (bottom): the cavity opens only where the plan opens it")
    expect(item.got).toMatch(/^open at the bottom: Vase body: the cavity runs through the bottom face at z 0, \d+(\.\d+)? mm across, from \(-?\d/)
    expect(item.got).toMatch(/Nothing above or below closes it there; build the floor, or start the cavity 3 mm above the bottom$/)
  })

  it('passes a floored twisted vase and the recorded planter, saucer, pen cup and bottle', () => {
    const plan = { ...fixtures['twisted-vase-open']!.plan!, planId: 'p-floored' }
    const floored = designCheck(plan, body(floorFacts([vase({ floor: 3 })], ['Vase'], 0)), 0.4).items.find((i) => i.name === 'floor')!
    expect(floored).toEqual({ name: 'floor', want: "closed at the bottom, with the plan's 3 mm floor (bottom): the cavity opens only where the plan opens it", got: 'closed: solid across the bottom face at z 0', pass: true })
    for (const id of ['planter-saucer', 'honeycomb-pen-cup', 'square-bottle']) {
      const f = fixtures[id]!
      const p = { ...(f.plan ?? BOTTLE_PLAN), planId: `p-${id}` }
      const item = designCheck(p, body(floorFacts(f.parts, f.parts.map((x) => x.name), plannedHoleMm(p))), 0.4).items.find((i) => i.name === 'floor')
      expect(item?.pass, `${id}: ${item?.got}`).toBe(true)
    }
  })

  it('adds no floor item to a plan that sets no floor, nor when the floor was not read', () => {
    const spout = recordedPlans.find((r) => r.recording === 'watering-spout')!.plan
    expect(designCheck({ ...spout, planId: 'p-spout' }, body(floorFacts([vase({ floor: 0 })], [], 0)), 0.4).items.map((i) => i.name)).not.toContain('floor')
    const vasePlan = { ...fixtures['twisted-vase-open']!.plan!, planId: 'p-unread' }
    expect(designCheck(vasePlan, body(undefined), 0.4).items.map((i) => i.name)).not.toContain('floor')
  })
})

describe('blind cuts into a side set no floor', () => {
  const plan = (features: PartPlan['features'], overall?: PartPlan['overall']): PartPlan => ({ planId: 'p-side', part: 'Part', units: 'mm', features, assumptions: [], questions: [], ...(overall ? { overall } : {}) })
  const body = (floor: BodyFacts['floor'], minWallMm = 2): BodyFacts => ({ size: { x: 80, y: 80, z: 100 }, holes: [], features: 2, watertight: true, minWallMm, floor })
  const slitBox = plan(
    [
      { name: 'Box', kind: 'extrude', sizes: { length: 60, width: 30, height: 20 } },
      { name: 'Window slits', kind: 'cut', sizes: { count: 12, length: 2.5, height: 1.2, depth: 1 }, kinds: { count: 'count' } },
    ],
    { x: 60, y: 30, z: 20 },
  )

  it('reads no floor from a row of slits, round recesses or a slot cut into a side of a box', () => {
    expect(plannedFloor(slitBox)).toBeNull()
    // round recesses 2 mm deep in a 20 mm box: the 18 mm left under them is no floor
    expect(plannedFloor(plan([{ name: 'Box', kind: 'extrude', sizes: { length: 60, width: 30, height: 20 } }, { name: 'Recesses', kind: 'pocket', sizes: { diameter: 6, depth: 2, count: 4 }, kinds: { count: 'count' } }], { x: 60, y: 30, z: 20 }))).toBeNull()
    // a slot with its own height runs into the side: its 12 mm depth goes across the box, not down into it
    expect(plannedFloor(plan([{ name: 'Box', kind: 'extrude', sizes: { length: 60, width: 30, height: 20 } }, { name: 'Side slot', kind: 'cut', sizes: { width: 3, height: 8, depth: 12 } }], { x: 60, y: 30, z: 20 }))).toBeNull()
    // no overall size, so the part's height is its tallest feature's: 1 mm slits beside a 15.8 mm post
    expect(plannedFloor(plan([{ name: 'Hull', kind: 'loft', sizes: { length: 200, beam: 23, depth: 23.8 } }, { name: 'Post', kind: 'extrude', sizes: { diameter: 5.5, height: 15.8 } }, { name: 'Window slits', kind: 'cut', sizes: { count: 30, length: 2.5, height: 1.2, depth: 1 }, kinds: { count: 'count' } }]))).toBeNull()
  })

  it('adds no floor item to the slit box, even where its bottom reads open', () => {
    const open = floorFacts([vase({ floor: 0, h: 20 })], ['Box'], 0)
    expect(open.parts[0]!.openings.length).toBeGreaterThan(0)
    const result = designCheck(slitBox, { ...body(open), size: { x: 60, y: 30, z: 20 } }, 0.4)
    expect(result.items.map((i) => i.name)).not.toContain('floor')
    expect(result.items.filter((i) => !i.pass)).toEqual([])
  })

  it('still fails a cup whose cavity runs out through the bottom, and one with no bottom', () => {
    const cup = plan([{ name: 'Body', kind: 'extrude', sizes: { outer_diameter: 80, height: 100 } }, { name: 'Cavity', kind: 'cut', sizes: { inner_diameter: 75, depth: 97 } }])
    expect(plannedFloor(cup)).toEqual({ mm: 3, from: 'depth 97 mm under the 100 mm height' })
    const tube = floorFacts([vase({ floor: 0, h: 100 })], ['Cup'], 0)
    const item = designCheck(cup, body(tube), 0.4).items.find((i) => i.name === 'floor')!
    expect(item.pass).toBe(false)
    expect(item.got).toMatch(/^open at the bottom: Cup: the cavity runs through the bottom face at z 0/)
    // a shallow tray keeps its floor too: a 12 mm well in a 15 mm body
    expect(plannedFloor(plan([{ name: 'Tray', kind: 'extrude', sizes: { outer_diameter: 140, height: 15 } }, { name: 'Well', kind: 'cut', sizes: { inner_diameter: 134, depth: 12 } }]))?.mm).toBe(3)
    // a cup with no bottom: walls and a bottom size, built as an open tube
    const shell = plan([{ name: 'Body', kind: 'revolve', sizes: { outer_diameter: 80, height: 100 } }, { name: 'Hollow', kind: 'shell', sizes: { wall: 2, bottom: 2 } }])
    expect(designCheck(shell, body(tube), 0.4).items.find((i) => i.name === 'floor')?.pass).toBe(false)
  })

  it('still fails a cup with a floor too thin to print under its cavity', () => {
    const cup = plan([{ name: 'Body', kind: 'extrude', sizes: { outer_diameter: 80, height: 100 } }, { name: 'Cavity', kind: 'cut', sizes: { inner_diameter: 75, depth: 99.7 } }])
    expect(plannedFloor(cup)?.mm).toBeCloseTo(0.3, 6)
    // the floor is closed, so the floor item passes, and the 0.3 mm floor is the thinnest wall, under two nozzle lines
    const result = designCheck(cup, body(floorFacts([vase({ floor: 0.3, h: 100 })], ['Cup'], 0), 0.3), 0.4)
    expect(result.items.find((i) => i.name === 'floor')?.pass).toBe(true)
    expect(result.items.find((i) => i.name === 'minimum wall')?.pass).toBe(false)
    expect(result.pass).toBe(false)
  })
})
