// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Blind openings on a curved side: a lofted body with a row of slits cut into one side and rows of round
// blind holes in the other, read with count and size and held to the plan's recess rows (recess true). A row the part
// lacks, or has at another size, fails; a recess is never read as less than it is to pass. Engine replies are recorded
// in fixtures/recesses-replies.json.gz.
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, type BodyFacts, type PartPlan } from '../src/design-check'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

const geom = useGeomEngine('recesses-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

type Item = { name: string; want: string; got: string; pass: boolean }
type Check = { pass: boolean; items: Item[]; body: BodyFacts }

/** The body's half width across (y) at x along it and height z: a rounded, boxy section that swells at mid height. */
const A = 50
const B = [16, 19, 20, 19, 16]
const Z = [0, 8, 15, 22, 30]
const halfWidth = (x: number, z: number): number => {
  // between the sections the loft runs smooth; the slits and holes sit between z 12 and 18, where b is near 20
  const b = z <= 15 ? 19 + ((z - 8) / 7) * 1 : 20 - ((z - 15) / 7) * 1
  return b * Math.pow(1 - Math.pow(Math.abs(x) / A, 4), 0.25)
}
const section = (k: number) => ({
  frame: { origin: [0, 0, Z[k]!], normal: [0, 0, 1] },
  loops: [{ points: Array.from({ length: 48 }, (_, i) => {
    const t = (2 * Math.PI * i) / 48
    const c = Math.cos(t)
    const s = Math.sin(t)
    return [A * Math.sign(c) * Math.pow(Math.abs(c), 0.5), B[k]! * Math.sign(s) * Math.pow(Math.abs(s), 0.5)]
  }) }],
})

/** A cut from a plane outside the body's side (y > 0 or y < 0), so its floor lies `depth` under the side at its middle. A
 * cut runs from its frame against the frame's normal, so the normal looks out of the side. */
function sideCut(side: 1 | -1, x: number, z: number, loop: number[][], depth: number) {
  const outside = 30
  const floor = halfWidth(x, z) - depth
  return {
    frame: { origin: [0, side * outside, 0], normal: [0, side, 0], u: [-side, 0, 0], v: [0, 0, 1] },
    shape: { type: 'sketch', loops: [{ points: loop.map(([u, v]) => [-side * (x + u!), z + v!]) }] },
    distance_mm: outside - floor,
    operation: 'cut',
    part: 0,
  }
}
const slit = (w: number, h: number) => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
const circle = (d: number) => Array.from({ length: 24 }, (_, i) => [(d / 2) * Math.cos((2 * Math.PI * i) / 24), (d / 2) * Math.sin((2 * Math.PI * i) / 24)])

async function body() {
  const plans = createPlanRegistry()
  const h = await connect({ geomEngine: engine, plans })
  const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: T }>(r).output
  }
  const design = (await ok<{ design: string }>('slicerx_design_new', { name: 'Body' })).design
  await ok('slicerx_geom_loft', { design, smooth: true, profiles: [0, 1, 2, 3, 4].map(section), name: 'Body', feature: 'Body' })
  // six slits 1.5 mm wide, 6 mm tall, on the +y side
  for (const x of [-20, -12, -4, 4, 12, 20]) await ok('slicerx_geom_extrude', { design, ...sideCut(1, x, 15, slit(1.5, 6), 1.5), feature: 'Slits' })
  // five 2 mm round blind holes and three 0.8 mm ones on the -y side
  for (const x of [-20, -10, 0, 10, 20]) await ok('slicerx_geom_extrude', { design, ...sideCut(-1, x, 17, circle(2), 1.2), feature: 'Round holes' })
  for (const x of [-15, 0, 15]) await ok('slicerx_geom_extrude', { design, ...sideCut(-1, x, 12.5, circle(0.8), 0.6), feature: 'Vents' })
  let n = 0
  const check = async (holes: NonNullable<PartPlan['holes']>) => {
    const plan: PartPlan = { planId: `body-${++n}`, part: 'Body', units: 'mm', features: [{ name: 'Body', kind: 'loft', sizes: { length: 100, width: 40, height: 30 } }, { name: 'Slits', kind: 'cut', sizes: { width: 1.5 } }, { name: 'Round holes', kind: 'cut', sizes: { diameter: 2 } }, { name: 'Vents', kind: 'cut', sizes: { diameter: 0.8 } }], holes, assumptions: [], questions: [] }
    plans.put(plan, design)
    const r = await h.call('slicerx_design_check', { planId: plan.planId })
    expect(r.isError, text(r)).toBeFalsy()
    return data<{ output: Check }>(r).output
  }
  return { check }
}

const item = (c: Check, name: string): Item => c.items.find((i) => i.name === name)!

describe('recesses on a curved lofted side', () => {
  it('reads a row of slits and two rows of round blind holes with their count and size, and holds the plan to them', async () => {
    const t = await body()
    const good = await t.check([
      { name: 'Slits', diameter: 1.5, count: 6, recess: true },
      { name: 'Round holes', diameter: 2, count: 5, recess: true },
      { name: 'Vents', diameter: 0.8, count: 3, recess: true },
    ])
    expect(item(good, 'Slits'), JSON.stringify(good.body.recesses)).toMatchObject({ pass: true, want: '6 x 1.5 mm recess' })
    // the end slits sit where the side turns away, so their rim on the skin reads a little wider
    expect(item(good, 'Slits').got).toMatch(/^(?:\d x )?1\.[56] mm by 6 mm slit(?:, (?:\d x )?1\.[56] mm by 6 mm slit)?$/)
    expect(item(good, 'Round holes').got, JSON.stringify(good.body.recesses)).toBe('5 x 2 mm round')
    expect(item(good, 'Vents').got).toBe('3 x 0.8 mm round')
    expect(item(good, 'Round holes')).toMatchObject({ pass: true, want: '5 x 2 mm recess' })
    expect(item(good, 'Vents')).toMatchObject({ pass: true, want: '3 x 0.8 mm recess' })
    // nothing read but the fourteen openings
    expect(good.body.recesses).toHaveLength(14)
    expect(good.body.recesses!.filter((r) => !r.round)).toHaveLength(6)
    expect(good.body.recesses!.every((r) => r.depthMm > 0.3)).toBe(true)
  }, 120_000)

  it('fails a row the part lacks or has at another size, or more than it has', async () => {
    const t = await body()
    const wrong = await t.check([
      { name: 'Slits', diameter: 2.5, count: 6, recess: true },
      { name: 'Round holes', diameter: 2, count: 7, recess: true },
      { name: 'Wide holes', diameter: 3, count: 2, recess: true },
    ])
    expect(item(wrong, 'Slits')).toMatchObject({ pass: false })
    expect(item(wrong, 'Slits').got).toContain('none at that size; read')
    expect(item(wrong, 'Round holes')).toMatchObject({ pass: false })
    expect(item(wrong, 'Round holes').got).toMatch(/\(2 short\)$/)
    expect(item(wrong, 'Wide holes')).toMatchObject({ pass: false })
  }, 120_000)
})
