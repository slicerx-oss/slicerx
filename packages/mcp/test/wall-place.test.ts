// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A failed minimum wall says where the thin wall is and how to fix it. minWall finds the place of its thinnest reading
// (the part, and the middle of the wall the reading crossed), and design.check gives it beside the reading as the
// item's where and fix. The reading (got) and the check's summary stay as they were.
import { describe, expect, it } from 'vitest'
import { minWall, type WallPlace } from '../src/body-facts'
import { createPlanRegistry, designCheck, fixRoundOpen, partNamed, WALL_ALSO, WALL_ALSO_PLACE, WALL_FIX, WALL_FIX_ALL, WALL_PLACES_MAX, WALL_WHERE, type BodyFacts, type PartPlan } from '../src/design-check'
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

  it('lists every other part under the floor, thinnest first, read before or after the thinnest, a copied part once', () => {
    const place: WallPlace = {}
    const plate = (x: number, t: number) => meshOf(boxTris([x, 0, 0], [x + 10, 20, t]))
    // 0.6 read before the thinnest (0.3) and 0.5 after it, which the thinnest wall alone would not have read down to
    const parts = [plate(0, 0.6), meshOf(boxTris([-30, 0, 0], [-10, 20, 10])), plate(20, 0.3), plate(40, 0.5), plate(60, 0.5), plate(80, 1)]
    expect(minWall(parts, undefined, undefined, undefined, undefined, place)).toEqual({ mm: 0.3 })
    expect(place.part).toBe(2)
    expect(place.others?.map((o) => [o.part, o.mm])).toEqual([[3, 0.5], [0, 0.6]])
    expect(inBox(place.others?.[0]?.point, [40, 0, 0], [50, 20, 0.5])).toBe(true)
  })

  it('lists no other part when the thinnest wall is not under the floor, or is the only one', () => {
    const plate = (x: number, t: number) => meshOf(boxTris([x, 0, 0], [x + 10, 20, t]))
    const thick: WallPlace = {}
    expect(minWall([plate(0, 1), plate(20, 0.9)], undefined, undefined, undefined, undefined, thick)).toEqual({ mm: 0.9 })
    expect(thick.others).toBeUndefined()
    const one: WallPlace = {}
    // 0.79996 reads 0.8, which the item passes, so it is not listed either
    expect(minWall([plate(0, 1), plate(20, 0.3), plate(40, 0.79996)], undefined, undefined, undefined, undefined, one)).toEqual({ mm: 0.3 })
    expect(one.others).toBeUndefined()
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

  it('says the three wall sentences word for word', () => {
    expect(WALL_ALSO_PLACE('Superstructure', '0.2 mm', [161, 126.67, 15.1])).toBe('Superstructure, 0.2 mm near (161, 126.67, 15.1) mm')
    expect(WALL_ALSO('0.8 mm', [WALL_ALSO_PLACE('Superstructure', '0.2 mm', [161, 126.67, 15.1]), WALL_ALSO_PLACE('Davits', '0.24 mm', [144.5, 121.73, 14.15])], 2)).toBe('Also under 0.8 mm: Superstructure, 0.2 mm near (161, 126.67, 15.1) mm; Davits, 0.24 mm near (144.5, 121.73, 14.15) mm; and 2 more.')
    expect(WALL_FIX_ALL('0.8 mm')).toBe('Make every place listed at least 0.8 mm thick, all in this one fix round. A lip, rim, post or arm needs that thickness too, and a cut must stop at least 0.8 mm short of the far side.')
    expect(WALL_FIX('0.8 mm')).toBe('Make it at least 0.8 mm thick there. A lip, rim, post or arm needs that thickness too, and a cut must stop at least 0.8 mm short of the far side.')
  })

  it('lists the other thin parts after the thinnest, and fixes them all in the one round', () => {
    const others = [{ part: 'Rails', mm: 0.398, at: [10, 2, 14] as V3 }, { mm: 0.6, at: [30, 2, 1] as V3 }]
    const item = wall({ ...body, minWallOthers: others })
    expect(item.got).toBe('0.3 mm')
    expect(item.pass).toBe(false)
    expect(item.where).toBe(`${WALL_WHERE('Shelf', [20, 10, 0.15])} ${WALL_ALSO('0.8 mm', [WALL_ALSO_PLACE('Rails', '0.4 mm', [10, 2, 14]), WALL_ALSO_PLACE(undefined, '0.6 mm', [30, 2, 1])], 0)}`)
    expect(item.fix).toBe(WALL_FIX_ALL('0.8 mm'))
    // past the list, the rest by their count
    const many = Array.from({ length: WALL_PLACES_MAX + 1 }, (_, k) => ({ part: `Vent ${k + 1}`, mm: 0.5, at: [k, 0, 0] as V3 }))
    const listed = wall({ ...body, minWallOthers: many }).where!
    expect(listed).toContain(`Vent ${WALL_PLACES_MAX - 1}, `)
    expect(listed).not.toContain(`Vent ${WALL_PLACES_MAX}, `)
    expect(listed.endsWith('; and 2 more.')).toBe(true)
    // a wall that passes says nothing of them
    expect(wall({ ...body, minWallMm: 2, minWallOthers: others })).toEqual({ name: 'minimum wall', want: 'at least 0.8 mm (twice the 0.4 mm nozzle)', got: '2 mm', pass: true })
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

  it('lists every part with a thin wall in a design of several, thinnest first', async () => {
    const plans = createPlanRegistry()
    const h = await connect({ geomEngine: engine, plans })
    const ok = async (name: string, args: Record<string, unknown>) => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return r
    }
    const design = data<{ output: { design: string } }>(await ok('slicerx_design_new', { name: 'Shelf' })).output.design
    await ok('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, placement: { center: [20, 10] }, distance_mm: 0.5, feature: 'Shelf', name: 'Shelf' })
    await ok('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 10, heightMm: 20 }, placement: { center: [55, 10] }, distance_mm: 10, feature: 'Shelf', name: 'Block' })
    await ok('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 10, heightMm: 20 }, placement: { center: [75, 10] }, distance_mm: 0.3, feature: 'Shelf', name: 'Tab' })
    await ok('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 10, heightMm: 20 }, placement: { center: [95, 10] }, distance_mm: 0.7, feature: 'Shelf', name: 'Lip' })
    plans.put(plan, design, 'card')
    const out = data<{ summary: string; output: Check }>(await ok('slicerx_design_check', { planId: 'shelf-1' }))
    const item = out.output.items.find((i) => i.name === 'minimum wall')!
    expect(item).toMatchObject({ got: '0.3 mm', pass: false, fix: WALL_FIX_ALL('0.8 mm') })
    const b = out.output.body
    expect(b.minWallAt?.part).toBe('Tab')
    expect(b.minWallOthers?.map((o) => [o.part, o.mm])).toEqual([['Shelf', 0.5], ['Lip', 0.7]])
    expect(item.where).toBe(`${WALL_WHERE('Tab', b.minWallAt!.at)} ${WALL_ALSO('0.8 mm', b.minWallOthers!.map((o) => WALL_ALSO_PLACE(o.part, `${o.mm} mm`, o.at)), 0)}`)
  })
})
