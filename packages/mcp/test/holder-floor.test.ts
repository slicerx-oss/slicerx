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

describe('where a cavity opens through the bottom', () => {
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
