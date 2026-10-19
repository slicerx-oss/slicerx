// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A built part checked against its plan: first the comparison on fixture bodies (the size tolerance, each named
// hole, the feature count, a closed body, the thinnest wall for the nozzle, an inch plan), then slicerx_design_check
// on real designs, whose facts are read from the body the steps made.
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, designCheck, partPlanSchema, type BodyFacts, type PartPlan } from '../src/design-check'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

const bracket: PartPlan = {
  planId: 'bracket-1',
  part: 'Bracket',
  units: 'mm',
  features: [
    { name: 'base', kind: 'extrude', sizes: { width: 60, depth: 30, thickness: 4 } },
    { name: 'upright', kind: 'extrude', sizes: { height: 40, thickness: 4 } },
    { name: 'mount holes', kind: 'hole', sizes: { diameter: 6 } },
  ],
  overall: { x: 60, y: 30, z: 40 },
  holes: [
    { name: 'mount hole', diameter: 6 },
    { name: 'cable hole', diameter: 4 },
  ],
  assumptions: ['M5 screws'],
  questions: [],
}

const built: BodyFacts = { size: { x: 60.05, y: 29.9, z: 40.3 }, holes: [{ diameterMm: 4.02 }, { diameterMm: 6.04 }], features: 3, watertight: true, minWallMm: 4 }

const failed = (r: ReturnType<typeof designCheck>) => r.items.filter((i) => !i.pass).map((i) => i.name)

describe('designCheck', () => {
  it('a matching bracket passes', () => {
    const r = designCheck(bracket, built, 0.4)
    expect(r.pass).toBe(true)
    expect(r.items.map((i) => i.name)).toEqual(['overall size', 'mount hole', 'cable hole', 'feature count', 'watertight', 'minimum wall'])
    expect(r.items.every((i) => i.pass)).toBe(true)
  })

  it('a 6 mm hole built at 5 mm fails that item only', () => {
    const r = designCheck(bracket, { ...built, holes: [{ diameterMm: 4 }, { diameterMm: 5 }] }, 0.4)
    expect(r.pass).toBe(false)
    expect(failed(r)).toEqual(['mount hole'])
    expect(r.items.find((i) => i.name === 'mount hole')).toEqual({ name: 'mount hole', want: '6 mm diameter', got: '5 mm diameter', pass: false })
  })

  it('a 0.6 mm wall fails for a 0.4 nozzle', () => {
    const r = designCheck(bracket, { ...built, minWallMm: 0.6 }, 0.4)
    expect(failed(r)).toEqual(['minimum wall'])
    expect(r.items.at(-1)).toMatchObject({ want: 'at least 0.8 mm (twice the 0.4 mm nozzle)', got: '0.6 mm' })
    // the same wall passes for a 0.25 nozzle
    expect(designCheck(bracket, { ...built, minWallMm: 0.6 }, 0.25).pass).toBe(true)
  })

  it('an open mesh fails watertight', () => {
    const r = designCheck(bracket, { ...built, watertight: false }, 0.4)
    expect(failed(r)).toEqual(['watertight'])
    expect(r.items.find((i) => i.name === 'watertight')).toMatchObject({ want: 'closed', got: 'open' })
  })

  it('holds sizes to 0.2 mm or 1 percent, whichever is larger, holes to 0.1 mm and the feature count exactly', () => {
    const small: PartPlan = { ...bracket, overall: { x: 10, y: 10, z: 10 }, holes: [{ name: 'pin', diameter: 3 }] }
    const body = (size: BodyFacts['size'], d = 3): BodyFacts => ({ ...built, size, holes: [{ diameterMm: d }] })
    expect(designCheck(small, body({ x: 10.2, y: 9.8, z: 10 }), 0.4).pass).toBe(true)
    expect(failed(designCheck(small, body({ x: 10.25, y: 10, z: 10 }), 0.4))).toEqual(['overall size'])
    // 1 percent of 60 is 0.6 mm
    expect(designCheck(bracket, { ...built, size: { x: 60.55, y: 30, z: 40 } }, 0.4).pass).toBe(true)
    expect(failed(designCheck(bracket, { ...built, size: { x: 60.65, y: 30, z: 40 } }, 0.4))).toEqual(['overall size'])
    expect(designCheck(small, body({ x: 10, y: 10, z: 10 }, 3.09), 0.4).pass).toBe(true)
    expect(failed(designCheck(small, body({ x: 10, y: 10, z: 10 }, 3.15), 0.4))).toEqual(['pin'])
    expect(failed(designCheck(bracket, { ...built, features: 4 }, 0.4))).toEqual(['feature count'])
  })

  it('a planned hole the body lacks fails as no hole, and a hole of the same name is matched first', () => {
    const r = designCheck(bracket, { ...built, holes: [{ diameterMm: 6 }] }, 0.4)
    expect(r.items.find((i) => i.name === 'cable hole')).toMatchObject({ got: 'no hole', pass: false })
    const named = designCheck(bracket, { ...built, holes: [{ name: 'Mount hole', diameterMm: 4 }, { diameterMm: 6 }] }, 0.4)
    expect(failed(named)).toEqual(['mount hole', 'cable hole'])
  })

  it('an inch plan passes against a body measured in mm, and fails a size off past the mm tolerance', () => {
    const plate: PartPlan = { planId: 'plate-in', part: 'Plate', units: 'in', features: [{ name: 'plate', sizes: { width: 2, depth: 1, thickness: 0.25 } }], overall: { x: 2, y: 1, z: 0.25 }, holes: [{ name: 'hole', diameter: 0.25 }], assumptions: [], questions: [] }
    const mm: BodyFacts = { size: { x: 50.8, y: 25.4, z: 6.35 }, holes: [{ diameterMm: 6.35 }], features: 1, watertight: true, minWallMm: 6.35 }
    const r = designCheck(plate, mm, 0.4)
    expect(r.pass).toBe(true)
    expect(r.items[0]).toMatchObject({ name: 'overall size', want: '50.8 x 25.4 x 6.35 mm (2 x 1 x 0.25 in)' })
    // 0.6 mm over on 50.8 mm is past 1 percent (0.508 mm); a hole 0.15 mm wide of 6.35 mm is past 0.1 mm
    expect(failed(designCheck(plate, { ...mm, size: { x: 51.4, y: 25.4, z: 6.35 } }, 0.4))).toEqual(['overall size'])
    expect(failed(designCheck(plate, { ...mm, holes: [{ diameterMm: 6.5 }] }, 0.4))).toEqual(['hole'])
    // read as mm, the same numbers fail
    expect(designCheck({ ...plate, units: 'mm' }, mm, 0.4).pass).toBe(false)
  })

  it('takes plans by planId, checked against the plan shape', () => {
    const plans = createPlanRegistry()
    expect(plans.latest()).toBeUndefined()
    plans.put(bracket)
    plans.put({ ...bracket, planId: 'bracket-2' }, 'd1')
    expect(plans.get('bracket-1')).toEqual({ plan: bracket })
    expect(plans.get('bracket-2')?.design).toBe('d1')
    expect(plans.latest()?.planId).toBe('bracket-2')
    expect(() => plans.put({ ...bracket, units: 'cm' } as unknown as PartPlan)).toThrow()
    expect(partPlanSchema.safeParse({ ...bracket, holes: [{ name: 'x', diameterMm: 3 }] }).success).toBe(false)
  })

  it('rejects a plan with a size, hole or overall value of zero or less', () => {
    expect(partPlanSchema.safeParse(bracket).success).toBe(true)
    for (const v of [0, -1]) {
      expect(partPlanSchema.safeParse({ ...bracket, features: [{ name: 'base', sizes: { width: v } }] }).success).toBe(false)
      expect(partPlanSchema.safeParse({ ...bracket, holes: [{ name: 'mount hole', diameter: v }] }).success).toBe(false)
      for (const axis of ['x', 'y', 'z'] as const) expect(partPlanSchema.safeParse({ ...bracket, overall: { ...bracket.overall!, [axis]: v } }).success).toBe(false)
    }
    expect(() => createPlanRegistry().put({ ...bracket, features: [{ name: 'base', sizes: { width: 0 } }] })).toThrow()
  })
})

type Check = { pass: boolean; planId: string; design: string; items: { name: string; want: string; got: string; pass: boolean }[]; body: BodyFacts }

const geom = useGeomEngine('design-check-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)
const top = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1] })

/** A 40 x 20 plate `t` mm thick with one through hole of `d` mm, planned with a 6 mm hole. */
async function plate(t: number, d: number, plan: Partial<PartPlan> = {}) {
  const plans = createPlanRegistry()
  const h = await connect({ geomEngine: engine, plans })
  const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: T }>(r).output
  }
  const design = (await ok<{ design: string }>('slicerx_design_new', { name: 'Plate' })).design
  await ok('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, placement: { center: [20, 10] }, distance_mm: t })
  await ok('slicerx_geom_extrude', { design, shape: { type: 'circle', diameterMm: d }, frame: top(t), placement: { center: [12, 10] }, distance_mm: t, operation: 'cut' })
  plans.put({ planId: 'plate-1', part: 'Plate', units: 'mm', features: [{ name: 'plate', kind: 'extrude', sizes: { width: 40, depth: 20, thickness: t } }, { name: 'hole', kind: 'cut', sizes: { diameter: 6 } }], overall: { x: 40, y: 20, z: t }, holes: [{ name: 'mount hole', diameter: 6 }], assumptions: [], questions: [], ...plan })
  return { h, ok, design }
}

describe('slicerx_design_check', () => {
  it('reads the body a plate was built to and passes it against its plan', async () => {
    const { ok, design } = await plate(5, 6)
    const r = await ok<Check>('slicerx_design_check', { planId: 'plate-1' })
    expect(r.design).toBe(design)
    expect(r.body.size).toEqual({ x: 40, y: 20, z: 5 })
    expect(r.body.features).toBe(2)
    expect(r.body.watertight).toBe(true)
    expect(r.body.holes).toHaveLength(1)
    expect(Math.abs(r.body.holes[0]!.diameterMm - 6)).toBeLessThan(0.05)
    // the thinnest wall is from the hole to the near edge, 12 - 3 = 9 mm, or the plate's 5 mm thickness
    expect(r.body.minWallMm).toBeCloseTo(5, 2)
    expect(r.items.filter((i) => !i.pass)).toEqual([])
    expect(r.pass).toBe(true)
  })

  it('a 6 mm hole built at 5 mm fails that item only', async () => {
    const { h } = await plate(5, 5)
    const res = await h.call('slicerx_design_check', { planId: 'plate-1' })
    const r = data<{ output: Check; summary: string }>(res)
    expect(r.output.pass).toBe(false)
    expect(r.output.items.filter((i) => !i.pass).map((i) => i.name)).toEqual(['mount hole'])
    expect(r.output.items.find((i) => i.name === 'mount hole')?.got).toMatch(/^4\.9\d mm diameter$|^5 mm diameter$/)
    expect(text(res)).toContain('mount hole')
  })

  it('a 0.6 mm plate fails the wall for a 0.4 nozzle', async () => {
    const { ok } = await plate(0.6, 6)
    const r = await ok<Check>('slicerx_design_check', { planId: 'plate-1' })
    expect(r.body.minWallMm).toBeCloseTo(0.6, 2)
    expect(r.items.filter((i) => !i.pass).map((i) => i.name)).toEqual(['minimum wall'])
  })

  it('refuses a plan it does not have', async () => {
    const { h } = await plate(5, 6)
    const r = await h.call('slicerx_design_check', { planId: 'nope' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('there is no plan nope')
  })
})
