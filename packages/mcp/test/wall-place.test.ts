// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A failed minimum wall says where the thin wall is and how to fix it. minWall finds the place of its thinnest reading
// (the part, and the middle of the wall the reading crossed), and design.check gives it beside the reading as the
// item's where and fix. The reading (got) and the check's summary stay as they were.
import { describe, expect, it } from 'vitest'
import { minWall, type WallPlace } from '../src/body-facts'
import { createPlanRegistry, designCheck, fixRoundOpen, partNamed, WALL_FIX, WALL_WHERE, type BodyFacts, type PartPlan } from '../src/design-check'
import { useGeomEngine } from './geom-engine'
import { connect, data, text } from './helpers'

type V3 = [number, number, number]
type Tri = [V3, V3, V3]

/** A closed box's twelve facets, facing out. */
function boxTris([x0, y0, z0]: V3, [x1, y1, z1]: V3): Tri[] {
  const p = (x: number, y: number, z: number): V3 => [x, y, z]
  const q = (a: V3, b: V3, c: V3, d: V3): Tri[] => [[a, b, c], [a, c, d]]
  return [
    ...q(p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0)),
    ...q(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)),
    ...q(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)),
    ...q(p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0)),
    ...q(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)),
    ...q(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)),
  ]
}
const meshOf = (tris: readonly Tri[]) => ({ positions: tris.flat(2), indices: tris.flatMap((_, t) => [t * 3, t * 3 + 1, t * 3 + 2]) })
const inBox = (p: V3 | undefined, [x0, y0, z0]: V3, [x1, y1, z1]: V3) => !!p && p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1 && p[2] >= z0 && p[2] <= z1

describe('minWall names the place of the thinnest wall', () => {
  it('finds a thin plate beside a thick block, in the middle of the plate', () => {
    const place: WallPlace = {}
    const m = meshOf([...boxTris([0, 0, 0], [20, 20, 10]), ...boxTris([30, 0, 0], [40, 20, 0.3])])
    expect(minWall([m], undefined, undefined, undefined, undefined, place)).toEqual({ mm: 0.3 })
    expect(place.part).toBe(0)
    expect(inBox(place.point, [30, 0, 0.1], [40, 20, 0.2])).toBe(true)
  })

  it('names the second part when the thin wall is there', () => {
    const place: WallPlace = {}
    const block = meshOf(boxTris([0, 0, 0], [20, 20, 10]))
    const plate = meshOf(boxTris([30, 0, 0], [40, 20, 0.4]))
    expect(minWall([block, plate], undefined, undefined, undefined, undefined, place).mm).toBe(0.4)
    expect(place.part).toBe(1)
    expect(inBox(place.point, [30, 0, 0], [40, 20, 0.4])).toBe(true)
  })

  it('reads a part copied along a row once, and names the first of the row', () => {
    const place: WallPlace = {}
    const fin = (dx: number) => meshOf(boxTris([dx, 0, 0], [dx + 0.5, 10, 10]))
    expect(minWall([meshOf(boxTris([-30, 0, 0], [-10, 20, 10])), fin(0), fin(5), fin(10)], undefined, undefined, undefined, undefined, place).mm).toBe(0.5)
    expect(place.part).toBe(1)
  })

  it('leaves the place empty when nothing is read', () => {
    const place: WallPlace = {}
    expect(minWall([], undefined, undefined, undefined, undefined, place)).toEqual({ mm: null })
    expect(place).toEqual({})
  })
})

const plan: PartPlan = {
  planId: 'shelf-1',
  part: 'Shelf',
  units: 'mm',
  features: [{ name: 'Shelf', kind: 'extrude', sizes: { width: 40, depth: 20, thickness: 0.3 } }],
  overall: { x: 40, y: 20, z: 0.3 },
  holes: [],
  assumptions: [],
  questions: [],
}

describe('design.check says where a failed wall is and how to fix it', () => {
  const body: BodyFacts = { size: { x: 40, y: 20, z: 0.3 }, holes: [], features: 1, watertight: true, minWallMm: 0.3, minWallAt: { part: 'Shelf', at: [20, 10, 0.15] } }
  const wall = (b: BodyFacts, nozzle = 0.4) => designCheck(plan, b, nozzle).items.find((i) => i.name === 'minimum wall')!

  it('keeps the reading as got, and gives the place and the fix beside it', () => {
    expect(wall(body)).toEqual({
      name: 'minimum wall',
      want: 'at least 0.8 mm (twice the 0.4 mm nozzle)',
      got: '0.3 mm',
      pass: false,
      where: 'The thinnest wall is in Shelf, near (20, 10, 0.15) mm.',
      fix: 'Make it at least 0.8 mm thick there. A lip, rim, post or arm needs that thickness too, and a cut must stop at least 0.8 mm short of the far side.',
    })
  })

  it('says the fix for the nozzle given, and the fix alone when the place is not known', () => {
    expect(wall(body, 0.6).fix).toBe(WALL_FIX('1.2 mm'))
    const { minWallAt: _at, ...noPlace } = body
    expect(wall(noPlace)).toMatchObject({ got: '0.3 mm', pass: false, fix: WALL_FIX('0.8 mm') })
    expect(wall(noPlace).where).toBeUndefined()
  })

  it('adds nothing to a wall that passes', () => {
    const ok = wall({ ...body, minWallMm: 2 })
    expect(ok).toEqual({ name: 'minimum wall', want: 'at least 0.8 mm (twice the 0.4 mm nozzle)', got: '2 mm', pass: true })
  })

  it('writes each sentence from one constant, with the part only when it is named', () => {
    expect(WALL_WHERE('Hull', [104.2, 3.1, 12.9])).toBe('The thinnest wall is in Hull, near (104.2, 3.1, 12.9) mm.')
    expect(WALL_WHERE(undefined, [104.2, 3.1, 12.9])).toBe('The thinnest wall is near (104.2, 3.1, 12.9) mm.')
    const { part: _p, ...at } = body.minWallAt!
    expect(wall({ ...body, minWallAt: at }).where).toBe('The thinnest wall is near (20, 10, 0.15) mm.')
  })

  it('names a part only in a design of several parts, and never by the name a new body gets', () => {
    expect(partNamed('Hull', 2)).toBe('Hull')
    expect(partNamed('Hull', 1)).toBeUndefined()
    for (const n of ['Body', 'Body 2', ' Body ', '', undefined]) expect(partNamed(n, 3)).toBeUndefined()
    expect(partNamed('Body panel', 2)).toBe('Body panel')
  })
})

type Check = { pass: boolean; items: { name: string; got: string; pass: boolean; where?: string; fix?: string }[]; body: BodyFacts }

const geom = useGeomEngine('wall-place-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

describe('slicerx_design_check on a part with a thin wall', () => {
  it('gives a point in the thin wall of a one part design in the item, with no part', async () => {
    const plans = createPlanRegistry()
    const h = await connect({ geomEngine: engine, plans })
    const ok = async (name: string, args: Record<string, unknown>) => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return r
    }
    const design = data<{ output: { design: string } }>(await ok('slicerx_design_new', { name: 'Shelf' })).output.design
    await ok('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, placement: { center: [20, 10] }, distance_mm: 0.3, feature: 'Shelf' })
    plans.put(plan, design, 'card')
    const r = await ok('slicerx_design_check', { planId: 'shelf-1' })
    const out = data<{ summary: string; output: Check }>(r)
    const item = out.output.items.find((i) => i.name === 'minimum wall')!
    expect(item.got).toBe('0.3 mm')
    expect(item.pass).toBe(false)
    expect(out.output.body.minWallAt?.part).toBeUndefined()
    const at = out.output.body.minWallAt!.at
    expect(at[2]).toBeCloseTo(0.15, 2)
    expect(item.where).toBe(WALL_WHERE(undefined, at))
    expect(item.fix).toBe(WALL_FIX('0.8 mm'))
    // the summary is as it was: the place and the fix are the item's, so the fix round's instruction stays last
    expect(out.summary).toContain('minimum wall (want at least 0.8 mm (twice the 0.4 mm nozzle), got 0.3 mm). This is not the last check')
    expect(out.summary.endsWith(fixRoundOpen('shelf-1'))).toBe(true)
    expect(out.summary).not.toContain('The thinnest wall')
  })
})
