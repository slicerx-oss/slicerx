// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A failed overall size says where the body ends along each axis that is off: its size against the plan's, and the
// corners at its two ends, with the part each is on when the design has several. design.check gives it beside the
// reading as the item's where. The reading (got) and the check's summary stay as they were.
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, designCheck, fixRoundOpen, SIZE_WHERE, WALL_WHERE, type BodyFacts, type PartPlan } from '../src/design-check'
import { useGeomEngine } from './geom-engine'
import { connect, data, text } from './helpers'

const plan = (overall: PartPlan['overall'], extra: Partial<PartPlan> = {}): PartPlan => ({
  planId: 'stand-1',
  part: 'Stand',
  units: 'mm',
  features: [{ name: 'Base', kind: 'extrude', sizes: { width: 40, depth: 20, thickness: 5 } }],
  overall,
  holes: [],
  assumptions: [],
  questions: [],
  ...extra,
})

const reach: NonNullable<BodyFacts['reach']> = {
  x: { lo: { at: [0, 0, 0] }, hi: { at: [40, 0, 0] } },
  y: { lo: { at: [0, 0, 0] }, hi: { at: [0, 20, 0] } },
  z: { lo: { at: [0, 0, 0] }, hi: { at: [20, 10, 30] } },
}
const body: BodyFacts = { size: { x: 40, y: 20, z: 30 }, reach, holes: [], features: 1, watertight: true, minWallMm: 2 }
const size = (p: PartPlan, b: BodyFacts = body) => designCheck(p, b, 0.4).items.find((i) => i.name === 'overall size')!

describe('design.check says where a failed overall size is off', () => {
  it('keeps the reading as got, and gives each axis that is off with its two ends', () => {
    expect(size(plan({ x: 40, y: 20, z: 20 }))).toEqual({
      name: 'overall size',
      want: '40 x 20 x 20 mm',
      got: '40 x 20 x 30 mm',
      pass: false,
      where: "Along z it is 30 mm against the plan's 20 mm, from (0, 0, 0) mm to (20, 10, 30) mm.",
    })
  })

  it('names the part at each end for a design of several parts, and gives every axis that is off', () => {
    const parts: BodyFacts = { ...body, size: { x: 50, y: 20, z: 30 }, reach: { ...reach, x: { lo: { at: [0, 0, 0], part: 'Base' }, hi: { at: [50, 5, 2], part: 'Arm' } }, z: { lo: { at: [0, 0, 0], part: 'Base' }, hi: { at: [20, 10, 30], part: 'Mast' } } } }
    expect(size(plan({ x: 40, y: 20, z: 20 }), parts).where).toBe(
      `${SIZE_WHERE('x', 50, 40, { at: [0, 0, 0], part: 'Base' }, { at: [50, 5, 2], part: 'Arm' })} ${SIZE_WHERE('z', 30, 20, { at: [0, 0, 0], part: 'Base' }, { at: [20, 10, 30], part: 'Mast' })}`,
    )
  })

  it('adds nothing to a size that passes, one that is only turned, or a display model just off its size', () => {
    expect(size(plan({ x: 40, y: 20, z: 30 })).where).toBeUndefined()
    expect(size(plan({ x: 20, y: 30, z: 40 }))).toMatchObject({ pass: false, got: '40 x 20 x 30 mm (same size, axes swapped: rotate it)' })
    expect(size(plan({ x: 20, y: 30, z: 40 })).where).toBeUndefined()
    expect(size(plan({ x: 40, y: 20, z: 29 }, { detail: 'display' } as Partial<PartPlan>)).where).toBeUndefined()
  })

  it('gives no place when the body facts have no reach', () => {
    const { reach: _r, ...bare } = body
    expect(size(plan({ x: 40, y: 20, z: 20 }), bare)).toEqual({ name: 'overall size', want: '40 x 20 x 20 mm', got: '40 x 20 x 30 mm', pass: false })
  })

  it('writes the sentence from one constant, with a part only at an end that has a named one', () => {
    expect(SIZE_WHERE('x', 80.44, 80, { at: [-0.22, 35, 40] }, { at: [80.22, 35, 40], part: 'Fins' })).toBe("Along x it is 80.44 mm against the plan's 80 mm, from (-0.22, 35, 40) mm to (80.22, 35, 40) mm on Fins.")
    expect(SIZE_WHERE('x', 80.44, 80, { at: [-0.22, 35, 40] }, { at: [80.22, 35, 40] })).toBe("Along x it is 80.44 mm against the plan's 80 mm, from (-0.22, 35, 40) mm to (80.22, 35, 40) mm.")
  })
})

type Check = { pass: boolean; items: { name: string; got: string; pass: boolean; where?: string; fix?: string }[]; body: BodyFacts }

const geom = useGeomEngine('size-place-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

describe('slicerx_design_check on a stand whose thin mast is taller than planned', () => {
  it('names the mast at the top and its thin wall, and leaves out the base, which has the name a new body gets', async () => {
    const plans = createPlanRegistry()
    const h = await connect({ geomEngine: engine, plans })
    const ok = async (name: string, args: Record<string, unknown>) => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return r
    }
    const design = data<{ output: { design: string } }>(await ok('slicerx_design_new', { name: 'Stand' })).output.design
    await ok('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, placement: { center: [20, 10] }, distance_mm: 5, feature: 'Base' })
    await ok('slicerx_geom_build', { design, name: 'Mast', solids: [{ type: 'cylinder', origin: [20, 10, 4.95], axis: [0, 0, 1], diameterMm: 0.6, heightMm: 25.05 }] })
    plans.put(plan({ x: 40, y: 20, z: 20 }), design, 'card')
    const out = data<{ summary: string; output: Check }>(await ok('slicerx_design_check', { planId: 'stand-1' }))
    const item = out.output.items.find((i) => i.name === 'overall size')!
    expect(item.pass).toBe(false)
    expect(item.got).toBe('40 x 20 x 30 mm')
    const z = out.output.body.reach!.z
    expect(z.hi.part).toBe('Mast')
    expect(z.lo.part).toBeUndefined()
    expect(z.hi.at[2]).toBeCloseTo(30, 2)
    expect(item.where).toBe(SIZE_WHERE('z', 30, 20, z.lo, z.hi))
    expect(out.summary).toContain('overall size (want 40 x 20 x 20 mm, got 40 x 20 x 30 mm); minimum wall (want at least 0.8 mm (twice the 0.4 mm nozzle), got 0.58 mm). This is not the last check')
    // the mast is also thinner than the wall check wants, and named there too
    const wall = out.output.items.find((i) => i.name === 'minimum wall')!
    expect(out.output.body.minWallAt?.part).toBe('Mast')
    expect(wall.where).toBe(WALL_WHERE('Mast', out.output.body.minWallAt!.at))
    // the summary is as it was: the places are the items', so the fix round's instruction stays last
    expect(out.summary.endsWith(fixRoundOpen('stand-1'))).toBe(true)
    expect(out.summary).not.toContain('Along z')
  })
})
