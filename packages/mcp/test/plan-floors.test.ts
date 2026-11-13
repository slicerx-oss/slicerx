// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plan's sizes against the printer's floors before Go: design.plan raises a print-in-place gap, a wall, a pin or a
// hole under the smallest this printer makes, with a line on the card saying why, and leaves a plan that is already
// fine as it was; design.put_plan names such sizes and keeps the client's plan as given.
import { readFileSync } from 'node:fs'
import type { DesignHost } from '@slicerx/cad-history'
import type { AskAnswer, ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, type PartPlan } from '../src/design-check'
import { jointProblem, LID_ON_HINGE, LID_ONE_WAY, LID_STATEMENT, planFloors, printsInPlace, raiseToFloors, unstatedJoint, underFloors } from '../src/plan-floors'
import { createCardPlans, PLAN_GO, planChoiceId, type PlanAnswer, type PlanInput } from '../src/tab-tools'
import { designToolset } from '../src/toolset'

/** The hinged box of the build eval as mimir planned it: print-in-place gaps of 0.3 mm, where the printer needs 0.4 mm. */
const hingedBox: PlanInput = {
  part: 'Hinged box',
  units: 'mm',
  features: [
    { name: 'Base', kind: 'extrude', sizes: { length: 80, width: 50, height: 30, wall: 2 } },
    { name: 'Lid', kind: 'extrude', sizes: { length: 80, width: 50, height: 5, wall: 2 } },
    { name: 'Hinge pin', kind: 'build', sizes: { pin_diameter: 3, gap: 0.3, vertical_gap: 0.3 } },
  ],
  overall: { x: 80, y: 50, z: 35 },
  assumptions: ['The lid, base and pin print in place, closed', 'PLA on a 0.4 mm nozzle'],
  questions: [],
}

const p1s = { printer: 'test_printer', material: 'pla', nozzle: 0.4 }

/** Runs design.plan as the tab does, the person pressing Go (after `edit`, when given, changes the card). */
async function plan(input: PlanInput, opts: { nozzleMm?: number; machine?: typeof p1s; edit?: (p: PartPlan) => PartPlan } = {}) {
  const card = createCardPlans(createPlanRegistry())
  let n = 0
  const tool = card.planTool({ newId: () => `plan-${++n}`, ...(opts.nozzleMm ? { fitProfile: () => ({ nozzleMm: opts.nozzleMm }) } : {}) })
  let shown: PartPlan | null = null
  const ask = async (): Promise<AskAnswer> => {
    shown = structuredClone(card.planById('plan-1'))
    if (opts.edit) card.editPlan('plan-1', opts.edit(structuredClone(shown!)))
    return { id: planChoiceId(PLAN_GO, 'plan-1') }
  }
  // a card the person answers: one that waits for their Go (sizes that fit something)
  const ctx = { ask, confirmsPlan: () => true, context: { machine: opts.machine ?? p1s } } as unknown as ToolContext
  const out = await tool.run(tool.input.parse(input) as never, ctx)
  return { out, answer: out.output as PlanAnswer, shown: shown as unknown as PartPlan, card }
}

describe('the floors', () => {
  it('come from the wall rule, the hole tools and the fit rule, for the nozzle and material', () => {
    expect(planFloors()).toEqual({ nozzleMm: 0.4, layerHeightMm: 0.2, material: 'pla', wallMm: 0.8, holeMm: 0.4, gapSideMm: 0.3, gapVerticalMm: 0.4 })
    expect(planFloors({ nozzleMm: 0.6 })).toMatchObject({ wallMm: 1.2, holeMm: 0.6, layerHeightMm: 0.3 })
    // PETG oozes, so its side gap is wider
    expect(planFloors({ material: 'petg' }).gapSideMm).toBeGreaterThan(planFloors().gapSideMm)
  })

  it('read a plan as print in place only when it says so, never from a hinge alone', () => {
    expect(printsInPlace({ ...hingedBox, planId: 'x' } as PartPlan)).toBe(true)
    expect(printsInPlace({ ...hingedBox, assumptions: ['The lid and box print assembled, closed'] })).toBe(true)
    expect(printsInPlace({ ...hingedBox, assumptions: ['A captive pin in the knuckles'] })).toBe(true)
    // a hinge, a hinged part or a question about printing in place states nothing
    expect(printsInPlace({ ...hingedBox, assumptions: ['Lid and base print flat beside each other, 10 mm apart'] })).toBe(false)
    expect(printsInPlace({ ...hingedBox, assumptions: [], questions: ['Keep the pin separate, or print it in place?'] })).toBe(false)
    expect(printsInPlace({ ...hingedBox, assumptions: ['The pieces are printed separately, not in place'] })).toBe(false)
    expect(printsInPlace({ ...hingedBox, assumptions: ['The pieces print in place, though they could be printed separately'] })).toBe(true)
  })
})

/** The live run's hinge, printed apart: a 2 mm pin in knuckles with a 0.3 mm clearance, lid and base beside each other. */
const apart: PlanInput = {
  part: 'Hinged box (base and lid)',
  units: 'mm',
  features: [
    { name: 'Base shell', kind: 'extrude', sizes: { outer_length: 80, outer_width: 50, outer_height: 35, wall: 2 } },
    { name: 'Hinge pin bore', kind: 'hole', sizes: { hinge_pin_diameter: 2, hinge_clearance: 0.3 } },
    { name: 'Lid hinge knuckle', kind: 'extrude', sizes: { hinge_pin_diameter: 2, hinge_clearance: 0.3 } },
    { name: 'Hinge pin', kind: 'extrude', sizes: { hinge_pin_diameter: 2 } },
  ],
  assumptions: ['Lid and base print flat beside each other on the bed, 10 mm apart, not stacked.'],
  questions: ['Keep the hinge pin as a separate printed pin, or leave it integrated as a print-in-place pin?'],
}

describe('design.plan holds sizes to the floors before Go', () => {
  it('raises the hinged box gaps from 0.3 mm to 0.45 mm on each side, 0.05 mm over the 0.4 mm floor, with the bore around the pin and a line on the card saying why', async () => {
    const { out, answer, shown } = await plan(hingedBox)
    const pin = shown.features.find((f) => f.name === 'Hinge pin')!
    // printed in place, a gap named no way is on every face, so it takes the larger floor
    expect(pin.sizes).toEqual({ pin_diameter: 3, gap: 0.45, vertical_gap: 0.45 })
    expect(shown.assumptions).toEqual([
      'Hinge pin gap raised from 0.3 mm to 0.45 mm on each side (3 mm pin, 3.9 mm bore), 0.05 mm over the smallest gap for parts printed in place with a 0.4 mm nozzle in PLA.',
      'Hinge pin vertical gap raised from 0.3 mm to 0.45 mm on each side, 0.05 mm over the smallest gap above or below parts printed in place with a 0.4 mm nozzle in PLA.',
      ...hingedBox.assumptions,
    ])
    // the answer gives the raised plan to build from, and what was raised
    expect(answer.accepted).toBe(true)
    expect(answer.edits?.features[2]?.sizes).toEqual({ pin_diameter: 3, gap: 0.45, vertical_gap: 0.45 })
    expect(answer.raised).toEqual([
      { feature: 'Hinge pin', size: 'gap', from: 0.3, to: 0.45, why: '0.05 mm over the smallest gap for parts printed in place with a 0.4 mm nozzle in PLA', pin: 3, bore: 3.9 },
      { feature: 'Hinge pin', size: 'vertical_gap', from: 0.3, to: 0.45, why: '0.05 mm over the smallest gap above or below parts printed in place with a 0.4 mm nozzle in PLA' },
    ])
    expect(out.summary).toBe("Approved as shown. The card raised Hinge pin gap to 0.45 mm on each side (3 mm pin, 3.9 mm bore), Hinge pin vertical gap to 0.45 mm on each side to this printer's smallest sizes; build from edits")
  })

  it('raises a stated print-in-place hinge clearance to 0.45 mm on each side and gives the bore around its 2 mm pin', async () => {
    const inPlace: PlanInput = { ...apart, assumptions: ['The lid, base and pin print in place, closed.'], questions: [] }
    const { answer, shown } = await plan(inPlace)
    expect(shown.features.map((f) => f.sizes['hinge_clearance'])).toEqual([undefined, 0.45, 0.45, undefined])
    expect(shown.assumptions[0]).toBe('Hinge pin bore hinge clearance raised from 0.3 mm to 0.45 mm on each side (2 mm pin, 2.9 mm bore), 0.05 mm over the smallest gap for parts printed in place with a 0.4 mm nozzle in PLA.')
    expect(answer.raised?.map((r) => [r.feature, r.to, r.pin, r.bore])).toEqual([
      ['Hinge pin bore', 0.45, 2, 2.9],
      ['Lid hinge knuckle', 0.45, 2, 2.9],
    ])
  })

  it('keeps the side by side floor for a hinge printed apart: 0.3 mm stays, less is raised to 0.35 mm', async () => {
    const kept = await plan(apart)
    expect(kept.shown).toEqual({ planId: 'plan-1', ...apart })
    expect(kept.answer).toEqual({ planId: 'plan-1', accepted: true })
    const thin: PlanInput = { ...apart, features: apart.features.map((f) => (f.sizes['hinge_clearance'] ? { ...f, sizes: { ...f.sizes, hinge_clearance: 0.2 } } : f)) }
    const { shown } = await plan(thin)
    expect(shown.features.map((f) => f.sizes['hinge_clearance'])).toEqual([undefined, 0.35, 0.35, undefined])
    expect(shown.assumptions[0]).toBe('Hinge pin bore hinge clearance raised from 0.2 mm to 0.35 mm on each side (2 mm pin, 2.7 mm bore), 0.05 mm over the smallest gap for parts printed side by side with a 0.4 mm nozzle in PLA.')
  })

  it('leaves a gap alone in a part with no hinge or pin that does not print in place, such as a lid that slides on', async () => {
    const lid: PlanInput = { part: 'Pencil box', units: 'mm', features: [{ name: 'Tray', sizes: { length: 180, wall: 2 } }, { name: 'Sliding lid', sizes: { thickness: 2, clearance: 0.2 } }], assumptions: [], questions: [] }
    const { answer, shown } = await plan(lid)
    expect(shown.features[1]!.sizes).toEqual({ thickness: 2, clearance: 0.2 })
    expect(answer.raised).toBeUndefined()
  })

  it('leaves a plan that is already fine as it was', async () => {
    const fine: PlanInput = { ...hingedBox, features: hingedBox.features.map((f) => (f.name === 'Hinge pin' ? { ...f, sizes: { pin_diameter: 3, gap: 0.4, side_gap: 0.3 } } : f)) }
    const { out, answer, shown } = await plan(fine)
    expect(shown).toEqual({ planId: 'plan-1', ...fine })
    expect(answer).toEqual({ planId: 'plan-1', accepted: true })
    expect(out.summary).toBe('Approved as shown')
  })

  it('raises a thin wall, a thin pin and a small hole to the nozzle the printer has now', async () => {
    const thin: PlanInput = {
      part: 'Vent cap',
      units: 'mm',
      features: [
        { name: 'Cap', sizes: { diameter: 30, wall_thickness: 0.8, height: 6 } },
        { name: 'Knob', sizes: { pin_d: 1 } },
        { name: 'Vents', kind: 'hole', sizes: { hole_diameter: 0.5, count: 6 } },
      ],
      holes: [{ name: 'vent', diameter: 0.5, count: 6 }],
      assumptions: [],
      questions: [],
    }
    // fine on a 0.4 mm nozzle
    expect((await plan(thin)).answer).toEqual({ planId: 'plan-1', accepted: true })
    // a 0.6 mm nozzle needs 1.2 mm walls and pins and 0.6 mm holes
    const { answer, shown } = await plan(thin, { nozzleMm: 0.6 })
    expect(shown.features.map((f) => f.sizes)).toEqual([{ diameter: 30, wall_thickness: 1.2, height: 6 }, { pin_d: 1.2 }, { hole_diameter: 0.6, count: 6 }])
    expect(shown.holes).toEqual([{ name: 'vent', diameter: 0.6, count: 6 }])
    expect(shown.assumptions).toEqual([
      'Cap wall thickness raised from 0.8 mm to 1.2 mm, the thinnest wall a 0.6 mm nozzle prints (two lines).',
      'Knob pin d raised from 1 mm to 1.2 mm, the thinnest pin a 0.6 mm nozzle prints (two lines).',
      'Vents hole diameter raised from 0.5 mm to 0.6 mm, the smallest hole a 0.6 mm nozzle prints.',
      'vent diameter raised from 0.5 mm to 0.6 mm, the smallest hole a 0.6 mm nozzle prints.',
    ])
    expect(answer.raised?.map((r) => r.size)).toEqual(['wall_thickness', 'pin_d', 'hole_diameter', 'vent diameter'])
  })

  it('never holds a count or an angle to a floor, and raises an inch plan in inches', async () => {
    const counted = underFloors({ part: 'Hinged gear', units: 'mm', features: [{ name: 'Gear', sizes: { wall: 0.3, gap: 0.2 }, kinds: { wall: 'count', gap: 'angle' } }], assumptions: [] }, planFloors())
    expect(counted).toEqual([])
    const inch = raiseToFloors({ part: 'Hinged box', units: 'in' as const, features: [{ name: 'Base', sizes: { wall: 0.02, gap: 0.01 } }], assumptions: ['Prints in place'] }, planFloors())
    // 0.8 mm is 0.0315 in, and the gap 0.05 mm over its 0.4 mm floor, 0.45 mm, is 0.0177 in, each rounded up
    expect(inch.plan.features[0]!.sizes).toEqual({ wall: 0.032, gap: 0.018 })
  })

  it('says a size the person typed back under its floor, and builds from their plan', async () => {
    const { out, answer } = await plan(hingedBox, { edit: (p) => ({ ...p, features: p.features.map((f) => (f.name === 'Hinge pin' ? { ...f, sizes: { ...f.sizes, gap: 0.3 } } : f)) }) })
    expect(answer.edits?.features[2]?.sizes.gap).toBe(0.3)
    expect(out.summary).toContain('Approved with changes')
    expect(out.summary).toContain('Hinge pin gap 0.3 mm on each side is under the 0.4 mm on each side (3 mm pin, 3.8 mm bore) this printer needs (the smallest gap for parts printed in place with a 0.4 mm nozzle in PLA); the person set it on the card')
  })

  it('puts one line for every raised size when the plan has little room left for lines, and none when it has no room', () => {
    const full = { ...hingedBox, assumptions: ['The pieces print in place', ...Array.from({ length: 10 }, (_, k) => `assumption ${k + 2}`)] }
    const one = raiseToFloors(full, planFloors())
    expect(one.plan.assumptions).toHaveLength(12)
    expect(one.plan.assumptions[0]).toBe("Raised to this printer's smallest sizes: Hinge pin gap 0.45 mm on each side (3 mm pin, 3.9 mm bore), Hinge pin vertical gap 0.45 mm on each side.")
    const none = raiseToFloors({ ...full, assumptions: [...full.assumptions, 'one more, print in place'] }, planFloors())
    expect(none.plan.assumptions).toHaveLength(12)
    expect(none.plan.features[2]!.sizes['gap']).toBe(0.45)
  })
})

describe('a raised gap lands over its floor', () => {
  // the creative hinge box as planned: a 0.5 mm axial gap in PETG, whose floor above or below is 0.6 mm. The card raised
  // it to exactly 0.6 mm, the bore came out of facets, and the gap measured 0.582 mm: it passed only by the check's
  // allowance for facets. A raised gap now lands 0.05 mm over its floor, and the floor itself is where it was.
  const hingeBox: PlanInput = {
    part: 'SD card box',
    units: 'mm',
    features: [
      { name: 'Base', kind: 'extrude', sizes: { length: 60, width: 40, height: 30, wall: 2 } },
      { name: 'Hinge pin', kind: 'extrude', sizes: { pin_diameter: 2.4, gap_side: 0.4, gap_axial: 0.5 } },
    ],
    overall: { x: 60, y: 40, z: 30 },
    printInPlace: ['Base', 'Lid'],
    assumptions: ['PETG on a 0.4 mm nozzle'],
    questions: [],
  }
  const petg = { printer: 'test_printer', material: 'petg', nozzle: 0.4 }

  it('raises the hinge box axial gap from 0.5 mm to 0.65 mm, and keeps the 0.4 mm side gap planned at its floor', async () => {
    const { shown, answer } = await plan(hingeBox, { machine: petg })
    expect(shown.features[1]!.sizes).toEqual({ pin_diameter: 2.4, gap_side: 0.4, gap_axial: 0.65 })
    expect(shown.assumptions[0]).toBe('Hinge pin gap axial raised from 0.5 mm to 0.65 mm on each side (2.4 mm pin, 3.7 mm bore), 0.05 mm over the smallest gap for parts printed in place with a 0.4 mm nozzle in PETG.')
    expect(answer.raised).toEqual([{ feature: 'Hinge pin', size: 'gap_axial', from: 0.5, to: 0.65, why: '0.05 mm over the smallest gap for parts printed in place with a 0.4 mm nozzle in PETG', pin: 2.4, bore: 3.7 }])
  })

  it('holds the floor itself where it was: a size at the floor is not under it, and the floors are the fit rule\'s', () => {
    const f = planFloors({ material: 'petg' })
    expect([f.gapSideMm, f.gapVerticalMm]).toEqual([0.4, 0.6])
    const atFloor = underFloors({ ...hingeBox, features: [hingeBox.features[0]!, { name: 'Hinge pin', kind: 'extrude', sizes: { pin_diameter: 2.4, gap_side: 0.4, gap_axial: 0.6 } }] }, f)
    expect(atFloor).toEqual([])
    const [u] = underFloors(hingeBox, f)
    expect(u).toMatchObject({ floor: 0.6, to: 0.65, bore: 3.6, toBore: 3.7 })
    // a wall, a pin or a hole is raised to its floor, with no margin
    const [wall] = underFloors({ ...hingeBox, features: [{ name: 'Base', sizes: { wall: 0.5 } }] }, f)
    expect(wall).toMatchObject({ floor: 0.8, to: 0.8 })
  })
})

describe('design.put_plan names sizes under the floors', () => {
  const host = { get: () => { throw new Error('none') }, list: () => [] } as unknown as DesignHost

  it('keeps the client plan as given and says which size is too small and what the floor is', async () => {
    const plans = createPlanRegistry()
    const t = designToolset(host, {}, { plans, nozzleMm: () => 0.4 }).find((x) => x.name === 'design.put_plan')!
    expect(t.version).toBe('1.7.0')
    const given = { planId: 'box-1', ...hingedBox }
    const out = await t.run(t.input.parse({ plan: given }) as never, { context: { machine: p1s } } as unknown as ToolContext)
    expect(plans.get('box-1')?.plan.features[2]?.sizes).toEqual({ pin_diameter: 3, gap: 0.3, vertical_gap: 0.3 })
    expect((out.output as { underFloors: unknown[] }).underFloors).toEqual([
      { feature: 'Hinge pin', size: 'gap', planned: 0.3, floor: 0.4, why: 'the smallest gap for parts printed in place with a 0.4 mm nozzle in PLA', pin: 3, bore: 3.8 },
      { feature: 'Hinge pin', size: 'vertical_gap', planned: 0.3, floor: 0.4, why: 'the smallest gap above or below parts printed in place with a 0.4 mm nozzle in PLA' },
    ])
    expect(out.summary).toContain('Hinge pin gap 0.3 mm on each side is under the 0.4 mm on each side (3 mm pin, 3.8 mm bore) this printer needs')
    expect(out.summary).toContain('Put the plan again with those sizes raised for a part that prints.')
    // a plan that is fine names none
    const fine = await t.run(t.input.parse({ plan: { ...given, planId: 'box-2', features: [hingedBox.features[0]!] } }) as never, {} as ToolContext)
    expect((fine.output as { underFloors: unknown[] }).underFloors).toEqual([])
    expect(fine.summary).not.toContain('under the')
  })
})

describe('a hinge or pin plan states how it prints', () => {
  const unsaid: PlanInput = { ...apart, assumptions: ['Base 80 x 50 x 25 mm, 2 mm walls.'], questions: ['Should the lid print assembled or apart?'] }

  it('is refused before the card when it says neither assembled nor apart, with what to say', async () => {
    expect(unstatedJoint(unsaid)).toBe(true)
    const card = createCardPlans(createPlanRegistry())
    const tool = card.planTool({ newId: () => 'plan-1' })
    let asked = false
    const ctx = { ask: async () => ((asked = true), { id: planChoiceId(PLAN_GO, 'plan-1') }), context: { machine: p1s } } as unknown as ToolContext
    await expect(tool.run(tool.input.parse(unsaid) as never, ctx)).rejects.toThrow('assumptions: say whether the lid prints assembled on its hinge (its pieces named in printInPlace) or laid apart beside the box (in an assumption)')
    expect(asked).toBe(false)
    expect(card.planById('plan-1')).toBeNull()
    expect(LID_STATEMENT).toBe('say whether the lid prints assembled on its hinge (its pieces named in printInPlace) or laid apart beside the box (in an assumption)')
  })

  it('goes to the card when it says either one', async () => {
    for (const said of ['The lid prints assembled on its hinge, closed.', 'The lid prints laid apart beside the box.', 'Lid and base print flat beside each other on the bed, 10 mm apart.', 'The pin is printed separately and pushed in.']) {
      const p: PlanInput = { ...unsaid, assumptions: [said] }
      expect(unstatedJoint(p), said).toBe(false)
      expect((await plan(p)).answer.accepted, said).toBe(true)
    }
    // a plan with no hinge or pin needs neither
    expect(unstatedJoint({ part: 'Pencil box', units: 'mm', features: [{ name: 'Tray', sizes: { wall: 2 } }], assumptions: [] })).toBe(false)
  })

  it('leaves a rod with no hinge and no lid alone, and still asks a lid on a pin', async () => {
    // the cable hook build eval's plan (live runs on 11-10, refused with the lid line): a 10 mm round rod bent into a J
    // on a screwed plate, nothing that moves
    const hook: PlanInput = {
      part: 'Cable hook',
      units: 'mm',
      features: [
        { name: 'Base plate', kind: 'extrude', sizes: { length: 40, width: 40, thickness: 5 } },
        { name: 'J rod', kind: 'sweep', sizes: { rod_diameter: 10, rise: 60, bend_radius: 20 } },
        { name: 'Screw holes', kind: 'hole', sizes: { hole_diameter: 4.5, spacing: 24 } },
      ],
      assumptions: ['The rod rises from the middle of the plate and bends over toward +X.'],
      questions: [],
    }
    expect(jointProblem(hook)).toBeNull()
    expect((await plan(hook)).answer.accepted).toBe(true)
    for (const name of ['Hook rod', 'Shaft', 'Axle', 'Dowel', 'Rod']) {
      expect(jointProblem({ ...hook, features: [...hook.features.slice(0, 1), { ...hook.features[1]!, name }] }), name).toBeNull()
    }
    // a pin beside a lid, with no hinge named, still says how it prints; a hinge alone still does too
    const pinnedLid: PlanInput = { part: 'Pill box', units: 'mm', features: [{ name: 'Box', sizes: { wall: 2 } }, { name: 'Lid', sizes: { wall: 2 } }, { name: 'Pin', sizes: { pin_diameter: 3 } }], assumptions: [], questions: [] }
    expect(jointProblem(pinnedLid)).toBe(LID_STATEMENT)
    expect(jointProblem({ ...pinnedLid, part: 'Lidded pill box', features: [pinnedLid.features[0]!, pinnedLid.features[2]!] })).toBe(LID_STATEMENT)
    expect(jointProblem({ ...hook, part: 'Hinged cable hook' })).toBe(LID_STATEMENT)
    expect(jointProblem({ ...hook, features: [...hook.features, { name: 'Hinge knuckle', sizes: { knuckle_length: 8 } }] })).toBe(LID_STATEMENT)
  })

  it('reads printInPlace as the statement, and printed flat as how the part lies, not apart', async () => {
    // pieces named in printInPlace print assembled; printInPlace false says they print apart
    expect(jointProblem({ ...unsaid, printInPlace: ['Box', 'Lid'] })).toBeNull()
    expect(jointProblem({ ...unsaid, printInPlace: false })).toBeNull()
    // named pieces print on their hinge: opened flat beside the box on it is fine, laid apart is refused (option a, owner
    // 2026-11-12); printed separately to put together still says both
    expect(jointProblem({ ...unsaid, printInPlace: ['Box', 'Lid'], assumptions: ['The lid prints opened flat beside the box on its hinge.'] })).toBeNull()
    expect(jointProblem({ ...unsaid, printInPlace: ['Box', 'Lid'], assumptions: ['The lid prints laid apart beside the box.'] })).toBe(LID_ON_HINGE)
    expect(jointProblem({ ...unsaid, printInPlace: ['Box', 'Lid'], assumptions: ['The pin is printed separately and pushed in.'] })).toBe(LID_ONE_WAY)
    // a recorded flexi fish: print in place in its name, a pin per joint, and printed flat on the bed
    const fish: PlanInput = { ...unsaid, part: 'Flexi fish, print in place', features: [{ name: 'Joint pin sockets', sizes: { joint_pin_diameter: 3 } }], assumptions: ['Printed flat on the bed, side profile up, no supports needed.'] }
    expect(jointProblem(fish)).toBeNull()
    expect(jointProblem({ ...unsaid, assumptions: ['The box is laid flat on the bed.'] })).toBe(LID_STATEMENT)
  })

  it('refuses the recorded hinged box, its lid in place and laid 10 mm apart, takes the infinity cube, and refuses one that says both', async () => {
    // both name their pieces in printInPlace (their 11-09 captures' plans). The box lays its lid 10 mm apart: a lid that
    // prints in place prints on its hinge, so it is refused with what to plan instead, and taken with the lid open on
    // the hinge axis (option a, owner 2026-11-12). The cube's pieces lie flat joined by their hinges, with a gap between
    // the cubes, which lays nothing apart
    const recorded = JSON.parse(readFileSync(new URL('./fixtures/open-layout-plans.json', import.meta.url), 'utf8')) as Record<string, PlanInput>
    const box = recorded['hinge-box']!
    expect(Array.isArray(box.printInPlace)).toBe(true)
    expect(jointProblem(box)).toBe(LID_ON_HINGE)
    await expect(plan(box)).rejects.toThrow(`assumptions: ${LID_ON_HINGE}`)
    const onHinge = { ...box, assumptions: box.assumptions.map((a) => (/apart/i.test(a) ? 'Lid prints open flat on the shared hinge axis, its knuckles between the base\'s.' : a)) }
    expect(jointProblem(onHinge)).toBeNull()
    expect((await plan(onHinge)).answer.accepted).toBe(true)
    const cube = recorded['infinity-cube']!
    expect(Array.isArray(cube.printInPlace)).toBe(true)
    expect(jointProblem(cube)).toBeNull()
    expect((await plan(cube)).answer.accepted).toBe(true)
    const card = createCardPlans(createPlanRegistry())
    const tool = card.planTool({ newId: () => 'plan-1' })
    const ctx = { ask: async () => ({ id: planChoiceId(PLAN_GO, 'plan-1') }) } as unknown as ToolContext
    const both: PlanInput = { ...unsaid, printInPlace: ['Box', 'Lid'], assumptions: ['The lid prints on its hinge, and the hinge pin is printed separately to push in after.'] }
    await expect(tool.run(tool.input.parse(both) as never, ctx)).rejects.toThrow(`assumptions: ${LID_ONE_WAY}`)
  })

  it('design.put_plan keeps such a plan and names the missing statement', async () => {
    const plans = createPlanRegistry()
    const t = designToolset({ get: () => { throw new Error('none') }, list: () => [] } as unknown as DesignHost, {}, { plans }).find((x) => x.name === 'design.put_plan')!
    const out = await t.run(t.input.parse({ plan: { planId: 'lid-1', ...unsaid } }) as never, {} as ToolContext)
    expect(plans.get('lid-1')).toBeDefined()
    expect((out.output as { unstated?: string }).unstated).toBe(LID_STATEMENT)
    expect(out.summary).toContain('The plan has a hinge or pin but does not say how it prints: say whether the lid prints assembled on its hinge (its pieces named in printInPlace) or laid apart beside the box (in an assumption).')
    const said = await t.run(t.input.parse({ plan: { planId: 'lid-2', ...unsaid, assumptions: ['The lid prints laid apart beside the box.'] } }) as never, {} as ToolContext)
    expect((said.output as { unstated?: string }).unstated).toBeUndefined()
  })
})

/** Live run 3's plan: it says the lid prints in place and also that it prints flat beside the base. */
const run3: PlanInput = {
  part: 'Hinged box',
  units: 'mm',
  features: [
    { name: 'Base', kind: 'extrude', sizes: { outer_length: 80, outer_width: 50, base_height: 27 } },
    { name: 'Lid', kind: 'extrude', sizes: { outer_length: 80, outer_width: 50, lid_height: 8, wall: 2 } },
    { name: 'Hinge knuckles', kind: 'extrude', sizes: { hinge_pin_diameter: 2, hinge_clearance: 0.3 } },
    { name: 'Hinge pin', kind: 'extrude', sizes: { hinge_pin_diameter: 2 } },
  ],
  assumptions: [
    'Base is 80 x 50 x 27 mm, open top, 2 mm walls and floor',
    'Lid is 80 x 50 x 8 mm, 2 mm top and walls, printed flat beside the base, 10 mm apart',
    'Pin hinge along the back edge (Y = 50 side): alternating knuckles on base and lid, 2 mm pin, 0.3 mm clearance',
    'Lid and base print in place as separate pieces; no supports needed',
  ],
  questions: ['Should the lid wrap the base edge or sit flush on top?'],
}

describe('a hinged plan says one way it prints', () => {
  it('is refused when it says both assembled and apart, told to say one', async () => {
    expect(jointProblem(run3)).toBe(LID_ONE_WAY)
    expect(LID_ONE_WAY).toBe('say one way the lid prints, assembled on its hinge or laid apart beside the box; the plan says both, in its assumptions')
    const card = createCardPlans(createPlanRegistry())
    const tool = card.planTool({ newId: () => 'plan-1' })
    const ctx = { ask: async () => ({ id: planChoiceId(PLAN_GO, 'plan-1') }), context: { machine: p1s } } as unknown as ToolContext
    await expect(tool.run(tool.input.parse(run3) as never, ctx)).rejects.toThrow(`assumptions: ${LID_ONE_WAY}`)
    expect(card.planById('plan-1')).toBeNull()
    // either way alone goes on; an in-place plan may still name its pieces as separate and its gaps in mm apart
    const inPlace = { ...run3, assumptions: run3.assumptions.filter((a) => !a.includes('beside')) }
    expect(jointProblem(inPlace)).toBeNull()
    expect(jointProblem({ ...inPlace, assumptions: [...inPlace.assumptions, 'Knuckles 0.4 mm apart where they meet'] })).toBeNull()
    expect(jointProblem({ ...run3, assumptions: run3.assumptions.filter((a) => !a.includes('in place')) })).toBeNull()
  })

  it('rewrites the plan\'s own line that names the old gap, so the plan the build reads says the new one with the bore', async () => {
    const inPlace: PlanInput = { ...run3, assumptions: run3.assumptions.filter((a) => !a.includes('beside')) }
    const { shown, answer } = await plan(inPlace)
    expect(shown.features[2]!.sizes).toEqual({ hinge_pin_diameter: 2, hinge_clearance: 0.45 })
    expect(shown.assumptions).toEqual([
      'Hinge knuckles hinge clearance raised from 0.3 mm to 0.45 mm on each side (2 mm pin, 2.9 mm bore), 0.05 mm over the smallest gap for parts printed in place with a 0.4 mm nozzle in PLA.',
      'Base is 80 x 50 x 27 mm, open top, 2 mm walls and floor',
      'Pin hinge along the back edge (Y = 50 side): alternating knuckles on base and lid, 2 mm pin, 0.45 mm clearance on each side (2.9 mm bore)',
      'Lid and base print in place as separate pieces; no supports needed',
    ])
    expect(answer.edits?.assumptions).toEqual(shown.assumptions)
    // a line naming the old value as something else, or another number, is left alone
    const other = raiseToFloors({ ...inPlace, assumptions: ['The pieces print in place', 'A 0.3 mm chamfer on the rim', 'Clearance of 0.3 mm on the hinge', 'hinge gap: 0.35 mm'] }, planFloors())
    expect(other.plan.assumptions.slice(2)).toEqual(['A 0.3 mm chamfer on the rim', 'Clearance of 0.45 mm on each side (2.9 mm bore) on the hinge', 'hinge gap: 0.35 mm'])
  })
})
