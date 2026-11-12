// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print-in-place parts: design.check's pieces and gaps items on a plan marked printInPlace (a lid resting on its tray,
// a pin 0.2 mm from its arm, a tail joined to its body, a clean 0.4 mm pin), and slicerx_geom_fit_check read back
// after a fix. Engine replies are recorded in fixtures/design-fit-check-replies.json.gz.
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, designCheck, partPlanSchema, type BodyFacts, type PartPlan } from '../src/design-check'
import { fitLimits } from '../src/fit-facts'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

const geom = useGeomEngine('design-fit-check-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

type Item = { name: string; want: string; got: string; pass: boolean }
type Check = { pass: boolean; items: Item[]; body: BodyFacts }

const planOf = (pieces: string[], extra: Partial<PartPlan> = {}): PartPlan => ({
  planId: 'pip-1',
  part: 'Mechanism',
  units: 'mm',
  features: pieces.map((name) => ({ name, kind: 'extrude', sizes: { size: 10 } })),
  assumptions: [],
  questions: [],
  printInPlace: pieces,
  ...extra,
})

const rect = (w: number, h: number, cx: number, cy: number) => ({ shape: { type: 'rectangle', widthMm: w, heightMm: h }, placement: { center: [cx, cy] } })
const circle = (d: number, cx: number, cy: number) => ({ shape: { type: 'circle', diameterMm: d }, placement: { center: [cx, cy] } })
const top = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1] })

async function harness() {
  const plans = createPlanRegistry()
  const h = await connect({ geomEngine: engine, plans })
  const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: T }>(r).output
  }
  const design = (await ok<{ design: string }>('slicerx_design_new', { name: 'Mechanism' })).design
  // a print-in-place plan is checked after a fit check of the part as built, as design.check asks
  const check = async (plan: PartPlan) => {
    plans.put(plan, design)
    if (plan.printInPlace) await ok('slicerx_geom_fit_check', { design })
    const r = await h.call('slicerx_design_check', { planId: plan.planId })
    expect(r.isError, text(r)).toBeFalsy()
    return { out: data<{ output: Check }>(r).output, summary: text(r) }
  }
  return { h, ok, design, check }
}

/**
 * A 30 x 20 x 6 mm arm with a round hole of `hole` mm, and a pin of `pin` mm through it, each its own body. Each step
 * names the planned feature it builds (Arm, Bore, Pin), as a plan's steps do.
 */
async function pinInArm(hole: number, pin: number) {
  const t = await harness()
  await t.ok('slicerx_geom_extrude', { design: t.design, ...rect(30, 20, 60, 60), distance_mm: 6, name: 'Arm', feature: 'Arm' })
  await t.ok('slicerx_geom_extrude', { design: t.design, ...circle(hole, 60, 60), frame: top(6), distance_mm: 6, operation: 'cut', feature: 'Bore' })
  await t.ok('slicerx_geom_extrude', { design: t.design, ...circle(pin, 60, 60), distance_mm: 6, name: 'Pin', feature: 'Pin' })
  return t
}

const item = (c: Check, name: string): Item => c.items.find((i) => i.name === name)!

describe('design.check on a print-in-place plan', () => {
  it('a lid resting on its tray is one piece, touching on the top face, 0.0 mm', async () => {
    const t = await harness()
    await t.ok('slicerx_geom_extrude', { design: t.design, ...rect(40, 30, 60, 60), distance_mm: 10, name: 'Tray' })
    await t.ok('slicerx_geom_extrude', { design: t.design, ...rect(40, 30, 60, 60), frame: top(10), distance_mm: 3, name: 'Lid' })
    const { out, summary } = await t.check(planOf(['Lid', 'Tray']))
    expect(out.pass).toBe(false)
    expect(item(out, 'pieces')).toMatchObject({ want: '2 separate pieces (Lid, Tray)', pass: false })
    expect(item(out, 'pieces').got).toBe('1 piece: Lid and Tray touch on the top face of Tray, so they print as one piece; leave the planned gap between them')
    // PLA on a 0.4 mm nozzle at 0.2 mm layers: 0.3 mm side by side, 0.4 mm (two layers) above or below
    expect(item(out, 'gaps')).toEqual({
      name: 'gaps',
      want: 'at least 0.3 mm side by side and 0.4 mm above or below between moving pieces (PLA, 0.4 mm nozzle, 0.2 mm layers)',
      got: 'Lid and Tray touch on the top face of Tray, 0.0 mm; this print-in-place plan needs 0.4 mm or more',
      pass: false,
    })
    expect(summary).toContain('Lid and Tray touch on the top face of Tray, 0.0 mm; this print-in-place plan needs 0.4 mm or more')
  })

  it('a lid touching its box side by side says where and across which faces, so the touch can be found', async () => {
    // a 40 mm tray and a 20 mm block against its +x side, face to face at x = 80: a pin's end flush on a box's end wall
    const t = await harness()
    await t.ok('slicerx_geom_extrude', { design: t.design, ...rect(40, 30, 60, 60), distance_mm: 10, name: 'Tray' })
    await t.ok('slicerx_geom_extrude', { design: t.design, ...rect(20, 10, 90, 60), distance_mm: 6, name: 'Lid' })
    const { out, summary } = await t.check(planOf(['Lid', 'Tray']))
    expect(item(out, 'pieces').got).toMatch(/^1 piece: (Lid and Tray|Tray and Lid) touch at \(80, [\d.]+, [\d.]+\), where faces square to x meet, so they print as one piece; leave the planned gap between them$/)
    expect(item(out, 'gaps').got).toMatch(/touch at \(80, [\d.]+, [\d.]+\), where faces square to x meet, 0\.0 mm; this print-in-place plan needs 0\.3 mm or more/)
    expect(summary).toMatch(/where faces square to x meet/)
  })

  it('a pin 0.2 mm from its arm fails the gaps item with where it is', async () => {
    const t = await pinInArm(3.4, 3)
    const { out } = await t.check(planOf(['Arm', 'Pin']))
    expect(item(out, 'pieces')).toMatchObject({ got: '2 pieces', pass: true })
    const gaps = item(out, 'gaps')
    expect(gaps.pass).toBe(false)
    expect(gaps.got).toMatch(/^Arm and Pin are 0\.2 mm apart side by side at \(.+\); this print-in-place plan needs 0\.3 mm or more$/)
    // the gap is not a wall: the arm's thinnest wall is its 6 mm thickness or the 8.3 mm beside the hole
    expect(item(out, 'minimum wall').pass).toBe(true)
  })

  it('a tail joined to the body is one piece: keep them as separate bodies', async () => {
    const t = await harness()
    await t.ok('slicerx_geom_extrude', { design: t.design, ...rect(30, 20, 60, 60), distance_mm: 6, name: 'Body' })
    await t.ok('slicerx_geom_extrude', { design: t.design, ...rect(20, 10, 84, 60), distance_mm: 6, operation: 'join', name: 'Tail' })
    const { out } = await t.check(planOf(['Body', 'Tail']))
    expect(item(out, 'pieces')).toEqual({ name: 'pieces', want: '2 separate pieces (Body, Tail)', got: '1 piece: Tail and Body are one piece; keep them as separate bodies', pass: false })
    expect(item(out, 'gaps')).toMatchObject({ got: 'no gaps: the part is one piece', pass: false })
  })

  it('a pin with 0.4 mm all round passes both items', async () => {
    const t = await pinInArm(3.8, 3)
    const { out } = await t.check(planOf(['Arm', 'Pin'], { features: ['Arm', 'Bore', 'Pin'].map((name) => ({ name, sizes: { size: 6 } })) }))
    expect(item(out, 'pieces')).toMatchObject({ got: '2 pieces', pass: true })
    expect(item(out, 'gaps')).toMatchObject({ got: 'smallest gap 0.4 mm, between Arm and Pin', pass: true })
    expect(out.items.filter((i) => !i.pass)).toEqual([])
    expect(out.pass).toBe(true)
  })

  it('a pin 0.35 mm from its socket all round fails above and below, though the side gap clears', async () => {
    // a 3.7 mm pocket 5.65 mm deep in the arm, and a 3 mm pin from 0.7 mm up: 0.35 mm a side and 0.35 mm under the pin
    const t = await harness()
    await t.ok('slicerx_geom_extrude', { design: t.design, ...rect(30, 20, 60, 60), distance_mm: 6, name: 'Arm' })
    await t.ok('slicerx_geom_extrude', { design: t.design, ...circle(3.7, 60, 60), frame: top(6), distance_mm: 5.65, operation: 'cut' })
    await t.ok('slicerx_geom_extrude', { design: t.design, ...circle(3, 60, 60), frame: top(0.7), distance_mm: 5.3, name: 'Pin' })
    const { out } = await t.check(planOf(['Arm', 'Pin']))
    expect(item(out, 'pieces')).toMatchObject({ got: '2 pieces', pass: true })
    const gaps = item(out, 'gaps')
    expect(gaps.pass).toBe(false)
    expect(gaps.got).toMatch(/^Pin and Arm are 0\.35 mm apart .+; this print-in-place plan needs 0\.4 mm or more$/)
    expect(gaps.got).not.toContain('side by side')
  })

  it('a round pin modeled at exactly 0.3 mm a side passes; at 0.25 mm it fails', async () => {
    // the bore's facets sit inside its circle, so the measured gap is a little under 0.3 mm
    const exact = await pinInArm(3.6, 3)
    const fit = (await exact.check(planOf(['Arm', 'Pin'], { features: ['Arm', 'Bore', 'Pin'].map((name) => ({ name, sizes: { size: 6 } })) }))).out
    expect(fit.body.fit!.gaps.find((g) => g.kind === 'apart')!.gapMm).toBeLessThan(0.3)
    expect(item(fit, 'gaps')).toMatchObject({ got: 'smallest gap 0.3 mm, between Arm and Pin', pass: true })
    expect(fit.pass).toBe(true)
    const read = await exact.ok<{ gaps: { kind: string; limit_mm: number; verdict: string }[]; warnings: string[] }>('slicerx_geom_fit_check', { design: exact.design })
    expect(read.warnings).toEqual([])
    expect(read.gaps).toEqual([expect.objectContaining({ kind: 'apart', limit_mm: 0.3, verdict: 'slides' })])
    const tight = await pinInArm(3.5, 3)
    const gaps = item((await tight.check(planOf(['Arm', 'Pin']))).out, 'gaps')
    expect(gaps.pass).toBe(false)
    expect(gaps.got).toMatch(/^Arm and Pin are 0\.25 mm apart side by side at .+; this print-in-place plan needs 0\.3 mm or more$/)
  })

  it('a pin capped 0.2 mm over the arm has a side gap in the bore and a gap above and below under the cap', async () => {
    // the cap rests over the arm's top face; the bore gap beside it is still a side gap, held to 0.3 mm
    const t = await harness()
    await t.ok('slicerx_geom_extrude', { design: t.design, ...rect(30, 20, 60, 60), distance_mm: 6, name: 'Arm' })
    await t.ok('slicerx_geom_extrude', { design: t.design, ...circle(3.4, 60, 60), frame: top(6), distance_mm: 6, operation: 'cut' })
    await t.ok('slicerx_geom_extrude', { design: t.design, ...circle(3, 60, 60), distance_mm: 7, name: 'Pin' })
    await t.ok('slicerx_geom_extrude', { design: t.design, ...circle(6, 60, 60), frame: top(6.2), distance_mm: 1, operation: 'join', part: 1 })
    const r = await t.ok<{ gaps: { names: string[]; kind: string; direction: string; limit_mm: number; where?: string }[] }>('slicerx_geom_fit_check', { design: t.design })
    const side = r.gaps.find((g) => g.kind === 'horizontal')!
    expect(side).toMatchObject({ names: ['Arm', 'Pin'], direction: 'xy', limit_mm: 0.3 })
    expect(side.where).toBeUndefined()
    expect(r.gaps.find((g) => g.kind === 'vertical')).toMatchObject({ names: ['Pin', 'Arm'], direction: 'z', limit_mm: 0.4, where: 'on the top face of Arm' })
  })

  it('pieces fail when the plan names pieces the design does not have', async () => {
    const t = await pinInArm(3.8, 3)
    const { out } = await t.check(planOf(['Lid', 'Tray']))
    expect(item(out, 'pieces')).toEqual({ name: 'pieces', want: '2 separate pieces (Lid, Tray)', got: "2 pieces, but Lid and Tray are not among them: the pieces left over are Arm and Pin. Each is a piece of its own, so only the names are off: give each part one of the plan's names and check again, without changing its shape", pass: false })
    // names match without regard to case
    expect(item((await t.check(planOf(['arm', 'PIN'], { planId: 'pip-2' }))).out, 'pieces')).toMatchObject({ got: '2 pieces', pass: true })
  })

  it('a plan without printInPlace gets no pieces or gaps item, and no print-in-place gaps are read', async () => {
    const t = await pinInArm(3.4, 3)
    const { out } = await t.check(planOf(['Arm', 'Pin'], { printInPlace: undefined }))
    expect(out.items.map((i) => i.name)).not.toContain('gaps')
    expect(out.items.map((i) => i.name)).not.toContain('pieces')
    expect(out.body.fit).toBeUndefined()
  })
})

describe('slicerx_geom_fit_check', () => {
  it('reads the pin gap with its verdict, and reads it back after the pin is made thinner', async () => {
    const t = await pinInArm(3.4, 3)
    type Fit = { pieces: number; limits: { side_mm: number; vertical_mm: number; material: string }; bodies: { name: string; part: number }[]; gaps: { names: string[]; kind: string; gap_mm: number; limit_mm: number; verdict: string }[]; warnings: string[] }
    const r = await t.h.call('slicerx_geom_fit_check', { design: t.design })
    expect(r.isError, text(r)).toBeFalsy()
    const before = data<{ output: Fit }>(r).output
    expect(before.limits).toMatchObject({ side_mm: 0.3, vertical_mm: 0.4, material: 'pla' })
    expect(before.pieces).toBe(2)
    expect(before.bodies.map((b) => b.name)).toEqual(['Arm', 'Pin'])
    expect(before.gaps).toHaveLength(1)
    expect(before.gaps[0]).toMatchObject({ names: ['Arm', 'Pin'], kind: 'horizontal', limit_mm: 0.3, verdict: 'binds' })
    expect(before.gaps[0]!.gap_mm).toBeCloseTo(0.2, 2)
    expect(before.warnings[0]).toMatch(/^Arm and Pin are 0\.2 mm apart side by side at .+; moving pieces need 0\.3 mm or more$/)
    expect(text(r)).toContain('2 pieces; 1 gap under the limit: Arm and Pin are 0.2 mm apart')
    // the fix: the pin again at 2.6 mm, 0.4 mm a side
    await t.ok('slicerx_design_undo', { design: t.design })
    await t.ok('slicerx_geom_extrude', { design: t.design, ...circle(2.6, 60, 60), distance_mm: 6, name: 'Pin' })
    const after = await t.ok<Fit>('slicerx_geom_fit_check', { design: t.design })
    expect(after.warnings).toEqual([])
    expect(after.gaps).toHaveLength(1)
    expect(after.gaps[0]).toMatchObject({ names: ['Arm', 'Pin'], kind: 'apart', verdict: 'slides' })
    expect(after.gaps[0]!.gap_mm).toBeCloseTo(0.4, 2)
    // PETG needs more: the same gap now binds against 0.4 mm side by side
    const petg = await t.ok<Fit>('slicerx_geom_fit_check', { design: t.design, material: 'PETG' })
    expect(petg.limits).toMatchObject({ side_mm: 0.4, vertical_mm: 0.6 })
  })

  it('refuses parts listed twice or out of range, and layer heights and materials it cannot use', async () => {
    const t = await pinInArm(3.4, 3)
    const refused = async (args: Record<string, unknown>, why: string) => {
      const r = await t.h.call('slicerx_geom_fit_check', { design: t.design, ...args })
      expect(r.isError, JSON.stringify(args)).toBe(true)
      expect(text(r)).toContain(why)
    }
    await refused({ part: [] }, 'part')
    await refused({ part: [0, 0] }, 'part: part 0 is listed twice')
    await refused({ part: [-1] }, 'part')
    await refused({ part: Array.from({ length: 65 }, (_, k) => k) }, 'part')
    await refused({ layer_height_mm: 0.03 }, 'layer_height_mm')
    await refused({ layer_height_mm: 0.9 }, 'layer_height_mm')
    await refused({ material: 'x'.repeat(41) }, 'material')
    await refused({ material: '   ' }, 'material')
    await refused({ material: 'PLA; drop' }, 'material')
    type Lim = { limits: { layer_height_mm: number; vertical_mm: number; material: string } }
    expect((await t.ok<Lim>('slicerx_geom_fit_check', { design: t.design, layer_height_mm: 0.04 })).limits.layer_height_mm).toBe(0.04)
    expect((await t.ok<Lim>('slicerx_geom_fit_check', { design: t.design, layer_height_mm: 0.8 })).limits.layer_height_mm).toBe(0.8)
    expect((await t.ok<Lim>('slicerx_geom_fit_check', { design: t.design, layer_height_mm: 0.3 })).limits.vertical_mm).toBe(0.6)
    expect((await t.ok<Lim>('slicerx_geom_fit_check', { design: t.design, material: 'PLA-CF', part: [1, 0] })).limits.material).toBe('PLA-CF')
  })

  it('refuses a part the design does not have', async () => {
    const t = await pinInArm(3.4, 3)
    const r = await t.h.call('slicerx_geom_fit_check', { design: t.design, part: [5] })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('the design has 2 parts')
  })
})

describe('the fit rule limits', () => {
  it('match the fit rule per material and nozzle', () => {
    expect(fitLimits()).toMatchObject({ sideMm: 0.3, verticalMm: 0.4, material: 'pla', nozzleMm: 0.4, layerHeightMm: 0.2 })
    expect(fitLimits({ material: 'PETG' })).toMatchObject({ sideMm: 0.4, verticalMm: 0.6 })
    expect(fitLimits({ nozzleMm: 0.6 })).toMatchObject({ sideMm: 0.3, verticalMm: 0.6, layerHeightMm: 0.3 })
  })

  it('printInPlace is part of the plan, at least two named pieces', () => {
    expect(partPlanSchema.parse(planOf(['Lid', 'Tray'])).printInPlace).toEqual(['Lid', 'Tray'])
    expect(partPlanSchema.safeParse(planOf(['Lid'])).success).toBe(false)
    // a fit that could not be measured says so on both items, plainly; the engine's words stay in the body read back
    const r = designCheck(planOf(['Lid', 'Tray']), { size: { x: 1, y: 1, z: 1 }, holes: [], features: 2, watertight: true, minWallMm: 1, fitWhy: 'engine down' }, 0.4)
    expect(r.items.filter((i) => i.name === 'pieces' || i.name === 'gaps').map((i) => i.got)).toEqual(['not measured (the gap check could not run)', 'not measured (the gap check could not run)'])
  })
})
