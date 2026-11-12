// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Blind openings on a curved side: a lofted body with a row of slits cut into one side and rows of round
// blind holes in the other, read with count and size and held to the plan's recess rows (recess true). A row the part
// lacks, or has at another size, fails; a recess is never read as less than it is to pass. Engine replies are recorded
// in fixtures/recesses-replies.json.gz.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, type BodyFacts, type PartPlan } from '../src/design-check'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

const geom = useGeomEngine('recesses-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

type Item = { name: string; want: string; got: string; pass: boolean }
type Check = { pass: boolean; items: Item[]; body: BodyFacts }

// The numbers below are written out, not computed: Math.cos, Math.sin and Math.pow may differ in the last bit from one
// platform's build to another's, which changes the engine requests the recordings are keyed by. These are the values
// the recordings were made with; a test checks them against Math.
/** (1 - (|x| / A)^4)^(1/4) at each place a cut stands, by |x|. */
const ROOT: Record<number, number> = { 0: 1, 4: 0.9999897598427099, 10: 0.9995997597757533, 12: 0.9991695260421563, 15: 0.9979688198364852, 20: 0.9935376260314681 }
/** Around the rounded, boxy section at 48 even turns: sign(cos t) |cos t|^(1/2), sign(sin t) |sin t|^(1/2). */
const SQUIRCLE: readonly (readonly [number, number])[] = [
  [1, 0], [0.995713242542154, 0.36128408796963585], [0.9828152554214186, 0.5087426118407232], [0.9611865232676157, 0.6186141223453355],
  [0.9306048591020997, 0.7071067811865475], [0.8907038454454068, 0.780231650863204], [0.8408964152537146, 0.8408964152537145], [0.780231650863204, 0.8907038454454068],
  [0.7071067811865476, 0.9306048591020996], [0.6186141223453356, 0.9611865232676157], [0.5087426118407232, 0.9828152554214186], [0.361284087969636, 0.995713242542154],
  [7.825109581173138e-9, 1], [-0.3612840879696359, 0.995713242542154], [-0.5087426118407231, 0.9828152554214186], [-0.6186141223453353, 0.9611865232676158],
  [-0.7071067811865474, 0.9306048591020997], [-0.780231650863204, 0.8907038454454068], [-0.8408964152537145, 0.8408964152537146], [-0.8907038454454067, 0.7802316508632041],
  [-0.9306048591020997, 0.7071067811865475], [-0.9611865232676157, 0.6186141223453356], [-0.9828152554214186, 0.5087426118407234], [-0.995713242542154, 0.3612840879696364],
  [-1, 1.1066376096750703e-8], [-0.995713242542154, -0.3612840879696361], [-0.9828152554214186, -0.5087426118407232], [-0.9611865232676158, -0.6186141223453354],
  [-0.9306048591020997, -0.7071067811865474], [-0.8907038454454068, -0.780231650863204], [-0.8408964152537147, -0.8408964152537143], [-0.7802316508632041, -0.8907038454454067],
  [-0.7071067811865478, -0.9306048591020996], [-0.6186141223453353, -0.9611865232676158], [-0.5087426118407231, -0.9828152554214186], [-0.3612840879696359, -0.995713242542154],
  [-1.3553487369385894e-8, -1], [0.3612840879696354, -0.9957132425421541], [0.5087426118407228, -0.9828152554214187], [0.6186141223453351, -0.9611865232676158],
  [0.7071067811865476, -0.9306048591020996], [0.7802316508632035, -0.8907038454454071], [0.8408964152537144, -0.8408964152537146], [0.8907038454454067, -0.7802316508632041],
  [0.9306048591020994, -0.7071067811865478], [0.9611865232676158, -0.6186141223453354], [0.9828152554214185, -0.508742611840724], [0.995713242542154, -0.361284087969636],
]
/** cos and sin at 24 even turns. */
const AROUND_24: readonly (readonly [number, number])[] = [
  [1, 0], [0.9659258262890683, 0.25881904510252074], [0.8660254037844387, 0.49999999999999994], [0.7071067811865476, 0.7071067811865475],
  [0.5000000000000001, 0.8660254037844386], [0.25881904510252074, 0.9659258262890683], [6.123233995736766e-17, 1], [-0.25881904510252063, 0.9659258262890683],
  [-0.4999999999999998, 0.8660254037844387], [-0.7071067811865475, 0.7071067811865476], [-0.8660254037844387, 0.49999999999999994], [-0.9659258262890682, 0.258819045102521],
  [-1, 1.2246467991473532e-16], [-0.9659258262890683, -0.2588190451025208], [-0.8660254037844388, -0.4999999999999997], [-0.7071067811865479, -0.7071067811865471],
  [-0.5000000000000004, -0.8660254037844385], [-0.25881904510252063, -0.9659258262890683], [-1.8369701987210297e-16, -1], [0.2588190451025203, -0.9659258262890684],
  [0.5000000000000001, -0.8660254037844386], [0.7071067811865474, -0.7071067811865477], [0.8660254037844384, -0.5000000000000004], [0.9659258262890681, -0.25881904510252157],
]

/** The body's half width across (y) at x along it and height z: a rounded, boxy section that swells at mid height. */
const A = 50
const B = [16, 19, 20, 19, 16]
const Z = [0, 8, 15, 22, 30]
const halfWidth = (x: number, z: number): number => {
  // between the sections the loft runs smooth; the slits and holes sit between z 12 and 18, where b is near 20
  const b = z <= 15 ? 19 + ((z - 8) / 7) * 1 : 20 - ((z - 15) / 7) * 1
  return b * ROOT[Math.abs(x)]!
}
const section = (k: number) => ({
  frame: { origin: [0, 0, Z[k]!], normal: [0, 0, 1] },
  loops: [{ points: SQUIRCLE.map(([c, s]) => [A * c, B[k]! * s]) }],
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
const circle = (d: number) => AROUND_24.map(([c, s]) => [(d / 2) * c, (d / 2) * s])

// the inputs every engine request here is made from, as numbers: the sections, the slit and hole outlines, and the
// cut depths at each place
const INPUTS = () => JSON.stringify({ sections: [0, 1, 2, 3, 4].map(section), slit: slit(1.5, 6), holes: [circle(2), circle(0.8)], sides: [...[-20, -12, -4, 4, 12, 20].map((x) => sideCut(1, x, 15, slit(1.5, 6), 1.5)), ...[-20, -10, 0, 10, 20].map((x) => sideCut(-1, x, 17, circle(2), 1.2)), ...[-15, 0, 15].map((x) => sideCut(-1, x, 12.5, circle(0.8), 0.6))] })
const INPUTS_HASH = '6c088ff0e2db562a'

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
  it('builds the body and its cuts from the same numbers on every platform', () => {
    expect(createHash('sha256').update(INPUTS()).digest('hex').slice(0, 16)).toBe(INPUTS_HASH)
    // and the written-out numbers are what they stand for, to within a bit or two
    for (const [x, v] of Object.entries(ROOT)) expect(Math.abs(v - Math.pow(1 - Math.pow(Number(x) / A, 4), 0.25))).toBeLessThan(1e-15)
    SQUIRCLE.forEach(([c, s], i) => {
      const t = (2 * Math.PI * i) / 48
      expect(Math.abs(c - Math.sign(Math.cos(t)) * Math.pow(Math.abs(Math.cos(t)), 0.5))).toBeLessThan(1e-15)
      expect(Math.abs(s - Math.sign(Math.sin(t)) * Math.pow(Math.abs(Math.sin(t)), 0.5))).toBeLessThan(1e-15)
    })
    AROUND_24.forEach(([c, s], i) => {
      expect(Math.abs(c - Math.cos((2 * Math.PI * i) / 24))).toBeLessThan(1e-15)
      expect(Math.abs(s - Math.sin((2 * Math.PI * i) / 24))).toBeLessThan(1e-15)
    })
  })

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
