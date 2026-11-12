// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A new part that lands a hair from another (above 0 and under half the nozzle, the gap a printer keeps open) is seated
// on it as the same step: it moves along that gap only, by the gap and SEAT_OVERLAP_MM. A part further off stays where
// it is; one whose move would run it into a third part is named and left. design.check fails such a gap as loose
// parts, and a plan whose pieces move keeps its gaps for the fit check. Engine replies are recorded in
// fixtures/design-seat.json.gz.
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, type PartPlan } from '../src/design-check'
import { SEAT_OVERLAP_MM } from '../src/seat'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

const geom = useGeomEngine('design-seat')

type V3 = [number, number, number]
type Item = { name: string; want: string; got: string; pass: boolean }
interface Out {
  design: string
  parts: { name: string; minMm: V3; sizeMm: V3 }[]
  steps: number
}

async function start() {
  const plans = createPlanRegistry()
  const h = await connect({ geomEngine: (op, request) => geom.engine(op, request), plans })
  const ok = async <T = Out,>(name: string, args: Record<string, unknown>): Promise<{ summary: string; output: T }> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ summary: string; output: T }>(r)
  }
  const design = (await ok('slicerx_design_new', { name: 'Stack' })).output.design
  const box = (name: string, min: V3, max: V3) => ok('slicerx_geom_build', { design, name, feature: name, solids: [{ type: 'box', min, max }] })
  const check = async (plan: PartPlan) => {
    plans.put(plan, design)
    if (Array.isArray(plan.printInPlace)) await ok('slicerx_geom_fit_check', { design })
    return (await ok<{ pass: boolean; items: Item[] }>('slicerx_design_check', { planId: plan.planId })).output
  }
  return { h, ok, design, box, check, plans }
}

const near = (a: number, b: number, mm = 1e-3) => Math.abs(a - b) <= mm
const planOf = (names: string[], extra: Partial<PartPlan> = {}): PartPlan => ({
  planId: 'stack-1',
  part: 'Stack',
  units: 'mm',
  features: names.map((name) => ({ name, kind: 'extrude', sizes: { size: 10 } })),
  assumptions: [],
  questions: [],
  ...extra,
})
const loose = (c: { items: Item[] }) => c.items.find((i) => i.name === 'loose parts')

describe('a new part a hair from another', () => {
  it('0.1 mm above the block is seated on it, moved down along the gap only', async () => {
    const t = await start()
    await t.box('Block', [0, 0, 0], [20, 20, 10])
    const r = await t.box('Cap', [5, 5, 10.1], [15, 15, 14])
    expect(r.summary).toContain('Cap was 0.1 mm from Block, so it is seated on Block (moved 0.15 mm)')
    const cap = r.output.parts.find((p) => p.name === 'Cap')!
    expect(near(cap.minMm[2], 10.1 - 0.1 - SEAT_OVERLAP_MM)).toBe(true)
    // across the gap only: x and y and every size stay as built
    expect(near(cap.minMm[0], 5) && near(cap.minMm[1], 5)).toBe(true)
    expect(cap.sizeMm.map((v) => Math.round(v * 1000) / 1000)).toEqual([10, 10, 3.9])
    // the same step: one step for the block and one for the cap
    expect(r.output.steps).toBe(2)
  })

  it('0.1 mm above the face another part stands on is seated, not refused as standing in its place', async () => {
    const t = await start()
    await t.box('Base', [0, 0, 0], [40, 20, 10])
    await t.box('Post', [2, 2, 10], [10, 10, 20])
    const r = await t.box('Knob', [20, 5, 10.1], [30, 15, 14])
    expect(r.summary).toContain('Knob was 0.1 mm from Base, so it is seated on Base (moved 0.15 mm)')
    const knob = r.output.parts.find((p) => p.name === 'Knob')!
    expect(near(knob.minMm[2], 10.1 - 0.1 - SEAT_OVERLAP_MM)).toBe(true)
    expect(r.output.steps).toBe(3)
  })

  it('0.1 mm above the face inside a ring standing there is seated on the face, not refused as standing in the ring', async () => {
    const t = await start()
    await t.box('Base', [0, 0, 0], [40, 40, 10])
    await t.ok('slicerx_geom_build', { design: t.design, name: 'Ring', feature: 'Ring', solids: [{ type: 'box', min: [5, 5, 10], max: [25, 25, 30] }], subtract: [{ type: 'box', min: [8, 8, 9], max: [22, 22, 31] }] })
    const r = await t.box('Insert', [10, 10, 10.1], [20, 20, 20])
    expect(r.summary).toContain('Insert was 0.1 mm from Base, so it is seated on Base (moved 0.15 mm)')
    expect(near(r.output.parts.find((p) => p.name === 'Insert')!.minMm[2], 10.1 - 0.1 - SEAT_OVERLAP_MM)).toBe(true)
  })

  it('0.1 mm above the face in the notch of an L standing there is seated on the face, and one in the L itself is refused', async () => {
    const t = await start()
    await t.box('Base', [0, 0, 0], [40, 40, 10])
    // an L: the box [5, 5] to [25, 25] less its corner [12, 12] to [25, 25]
    await t.ok('slicerx_geom_build', { design: t.design, name: 'Ell', feature: 'Ell', solids: [{ type: 'box', min: [5, 5, 10], max: [25, 25, 30] }], subtract: [{ type: 'box', min: [12, 12, 9], max: [26, 26, 31] }] })
    const r = await t.box('Insert', [14, 14, 10.1], [22, 22, 20])
    expect(r.summary).toContain('Insert was 0.1 mm from Base, so it is seated on Base (moved 0.15 mm)')
    const inL = await t.h.call('slicerx_geom_build', { design: t.design, name: 'Block', feature: 'Block', solids: [{ type: 'box', min: [5, 5, 10.1], max: [11, 24, 20] }] })
    expect(inL.isError).toBe(true)
    expect(text(inL)).toMatch(/Nothing was built: solids\[0\] .* stands in Ell/)
  })

  it('0.5 mm above the block stays where it is, and design.check finds nothing loose', async () => {
    const t = await start()
    await t.box('Block', [0, 0, 0], [20, 20, 10])
    const r = await t.box('Cap', [5, 5, 10.5], [15, 15, 14])
    expect(r.summary).not.toContain('seated')
    expect(near(r.output.parts.find((p) => p.name === 'Cap')!.minMm[2], 10.5)).toBe(true)
    // nothing comes within the gap kept open, so nothing is loose and the engine is not asked
    const c = await t.check(planOf(['Block', 'Cap']))
    expect(loose(c)).toBeUndefined()
  })

  it('a move that would run it into a third part is not made, and the part is named', async () => {
    const t = await start()
    await t.box('Block', [0, 0, 0], [10, 10, 10])
    // a ledge past the block's end, 0.5 mm from it
    await t.box('Ledge', [0.04, 10.5, 0], [10, 20, 10])
    // 0.145 mm from the block and 0.185 mm from the ledge, side by side (clear of the gap kept open, within its
    // allowance): the 0.195 mm move onto the block would run it 0.01 mm into the ledge
    const r = await t.box('Cap', [-10.145, 0, 0], [-0.145, 20, 10])
    expect(r.summary).toContain('Cap is 0.14 mm from Block')
    expect(r.summary).toContain('was left where it is: seating it would run it into Ledge')
    expect(near(r.output.parts.find((p) => p.name === 'Cap')!.minMm[0], -10.145)).toBe(true)
  })

  it('a part a hair over two parts that its one move meets both is seated on both', async () => {
    const t = await start()
    await t.box('Block', [0, 0, 0], [10, 20, 10])
    await t.box('Ledge', [10.5, 0, 0], [16, 20, 10.04])
    // 0.06 mm over the ledge and 0.1 mm over the block: 0.11 mm down meets both
    const r = await t.box('Cap', [5, 5, 10.1], [15, 15, 14])
    expect(r.summary).toContain('Cap was 0.06 mm from Ledge and Block, so it is seated on Ledge and Block (moved 0.11 mm)')
    expect(near(r.output.parts.find((p) => p.name === 'Cap')!.minMm[2], 10.1 - 0.11)).toBe(true)
  })
})

describe('design.check loose parts', () => {
  it('fails two parts 0.1 mm apart, with the pair, the gap and where', async () => {
    const t = await start()
    await t.box('Block', [0, 0, 0], [20, 20, 10])
    await t.box('Cap', [5, 5, 10.1], [15, 15, 14])
    // lift the seated cap back off by the move and 0.1 mm: design.edit_step moves without seating
    await t.ok('slicerx_design_edit_step', { design: t.design, step: 2, move: [0, 0, 0.1 + SEAT_OVERLAP_MM] })
    const c = await t.check(planOf(['Block', 'Cap']))
    const item = loose(c)!
    expect(item.pass).toBe(false)
    expect(item.got).toMatch(/^Cap and Block, 0\.1 mm apart at \[5, 5, 10(\.1)?\]: move each onto the other, or at least 0\.2 mm away$/)
  })

  it('passes two parts that touch', async () => {
    const t = await start()
    await t.box('Block', [0, 0, 0], [20, 20, 10])
    await t.box('Cap', [5, 5, 10.1], [15, 15, 14])
    expect(loose(await t.check(planOf(['Block', 'Cap'])))).toMatchObject({ pass: true })
  })
})

describe('pieces planned to move', () => {
  // two leaves of a hinge printed in place, side by side; PLA on a 0.4 mm nozzle keeps 0.3 mm between them
  const hinge = planOf(['Leaf A', 'Leaf B'], { printInPlace: ['Leaf A', 'Leaf B'], features: [{ name: 'Leaf A', kind: 'extrude', sizes: { size: 10 } }, { name: 'Leaf B', kind: 'extrude', sizes: { size: 10, clearance: 0.3 } }] })

  it('a hinge pair at its planned clearance is left alone and passes design.check', async () => {
    const t = await start()
    t.plans.put(hinge, t.design)
    await t.box('Leaf A', [0, 0, 0], [10, 10, 4])
    const r = await t.box('Leaf B', [10.3, 0, 0], [20.3, 10, 4])
    expect(r.summary).not.toContain('seated')
    expect(near(r.output.parts.find((p) => p.name === 'Leaf B')!.minMm[0], 10.3)).toBe(true)
    const c = await t.check(hinge)
    expect(c.items.map((i) => i.name)).not.toContain('loose parts')
    expect(c.pass, JSON.stringify(c.items.filter((i) => !i.pass))).toBe(true)
  })

  it('a hinge leaf a hair from the other is never seated or counted as loose; its gap belongs to the fit check', async () => {
    const t = await start()
    t.plans.put(hinge, t.design)
    await t.box('Leaf A', [0, 0, 0], [10, 10, 4])
    const r = await t.box('Leaf B', [10.1, 0, 0], [20.1, 10, 4])
    expect(r.summary).not.toContain('seated')
    expect(r.summary).not.toContain('left where it is')
    expect(near(r.output.parts.find((p) => p.name === 'Leaf B')!.minMm[0], 10.1)).toBe(true)
    const c = await t.check(hinge)
    expect(c.items.map((i) => i.name)).not.toContain('loose parts')
    expect(c.items.find((i) => i.name === 'gaps')).toMatchObject({ pass: false })
  })
})

describe('a pattern of a part a hair from another', () => {
  it('a mirrored pair 0.1 mm off a center wall seats by moving the source, and both end flush', async () => {
    const t = await start()
    await t.box('Wall', [-1, 0, 0], [1, 20, 10])
    // 0.5 mm off, then moved to 0.1 mm off: design.edit_step moves without seating
    await t.box('Leg', [-11, 5, 0], [-1.5, 15, 4])
    await t.ok('slicerx_design_edit_step', { design: t.design, step: 2, move: [0.4, 0, 0] })
    const r = await t.ok('slicerx_geom_mirror', { design: t.design, part: 1, plane: { axis: 'x', at: 0 } })
    expect(r.summary).toContain('Leg was 0.1 mm from Wall at 2 places, so step 2')
    expect(r.summary).toContain('moved 0.15 mm and every copy is seated on Wall')
    const leg = r.output.parts.find((p) => p.name === 'Leg')!
    // the source moved 0.15 mm to the wall and its mirror image followed: both 0.05 mm into the wall
    expect(near(leg.minMm[0], -10.6 + 0.1 + SEAT_OVERLAP_MM)).toBe(true)
    expect(near(leg.sizeMm[0], 2 * (10.6 - 0.1 - SEAT_OVERLAP_MM))).toBe(true)
    expect(r.output.steps).toBe(3)
    expect(loose(await t.check(planOf(['Wall', 'Leg'])))).toMatchObject({ pass: true })
  })

  it('an array along a wall seats by moving the source, and every copy ends flush', async () => {
    const t = await start()
    await t.box('Wall', [0, -2, 0], [60, 0, 10])
    await t.box('Post', [2, 0.5, 0], [6, 4.5, 8])
    await t.ok('slicerx_design_edit_step', { design: t.design, step: 2, move: [0, -0.4, 0] })
    const r = await t.ok('slicerx_geom_array', { design: t.design, part: 1, spec: { kind: 'linear', count: 4, step: [15, 0, 0] } })
    expect(r.summary).toContain('Post was 0.1 mm from Wall at 4 places')
    expect(r.summary).toContain('every copy is seated on Wall')
    const post = r.output.parts.find((p) => p.name === 'Post')!
    expect(near(post.minMm[1], 0.1 - 0.1 - SEAT_OVERLAP_MM)).toBe(true)
    expect(near(post.sizeMm[0], 49)).toBe(true)
    expect(loose(await t.check(planOf(['Wall', 'Post'])))).toMatchObject({ pass: true })
  })

  it('a part whose gaps point opposite ways is named and not moved', async () => {
    const t = await start()
    await t.box('Left', [0, 0, 0], [2, 10, 10])
    await t.box('Right', [12.2, 0, 0], [14.2, 10, 10])
    const r = await t.box('Middle', [2.1, 0, 0], [12.1, 10, 4])
    expect(r.summary).toContain('Middle has 2 places 0.1 mm to 0.1 mm from Right and Left')
    expect(r.summary).toContain('was left where it is: its gaps point different ways, so no one move seats it')
    expect(r.summary).not.toContain('seated')
    expect(near(r.output.parts.find((p) => p.name === 'Middle')!.minMm[0], 2.1)).toBe(true)
  })

  it('mirror copies that one move of the source cannot all seat are named and not moved', async () => {
    const t = await start()
    await t.box('Wall', [-1, 0, 0], [1, 20, 10])
    await t.box('Leg', [-11, 5, 0], [-1.5, 15, 4])
    await t.ok('slicerx_design_edit_step', { design: t.design, step: 2, move: [0.4, 0, 0] })
    // mirrored through a plane off the wall's middle: the image lands 0.3 mm from the wall, and only the source is loose
    const r = await t.ok('slicerx_geom_mirror', { design: t.design, part: 1, plane: { axis: 'x', at: 0.1 } })
    expect(r.summary).toContain('Leg is 0.1 mm from Wall')
    expect(r.summary).toContain('was left where it is: moving the step that made it does not seat every copy without running into another part')
    expect(r.summary).not.toContain('seated')
    expect(near(r.output.parts.find((p) => p.name === 'Leg')!.minMm[0], -10.6)).toBe(true)
  })
})
