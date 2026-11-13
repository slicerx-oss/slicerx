// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The gaps a print-in-place plan sets, held to the fit rule before and after building: design.plan names the rule's
// smallest gaps in its text and, for an approved plan, the ones this printer needs, saying which planned gap is under;
// design.check fails a planned gap under the rule and gives the gap to use. The values are two live runs' (a fidget
// spinner planned 0.3 mm where the gap above or below needs 0.4 mm, a flexi fish 0.2 mm where the side gap needs 0.3 mm
// on a 0.4 mm nozzle in PLA).
import { printInPlaceClearance, type ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { designCheck, type BodyFacts, type PartPlan } from '../src/design-check'
import { fitLimits } from '../src/fit-facts'
import { createCardPlans, createPlanRegistry } from '../src/toolset'

const limits = fitLimits({ nozzleMm: 0.4, material: 'pla' })

const plan = (sizes: Record<string, number>, printInPlace: string[] | null = ['Hub', 'Spinner']): PartPlan => ({
  planId: 'p1',
  part: 'Fidget spinner',
  units: 'mm',
  features: [
    { name: 'Hub', kind: 'extrude', sizes: { diameter: 16, height: 14.6 } },
    { name: 'Spinner', kind: 'extrude', sizes: { thickness: 8, ...sizes } },
  ],
  assumptions: [],
  questions: [],
  ...(printInPlace ? { printInPlace } : {}),
})

// two pieces built with gaps that clear the rule, so only the planned sizes can fail
const body: BodyFacts = {
  size: { x: 70, y: 61, z: 14.6 },
  holes: [],
  features: 2,
  watertight: true,
  minWallMm: 1.6,
  fit: {
    limits,
    bodies: [
      { part: 0, name: 'Hub' },
      { part: 1, name: 'Spinner' },
    ],
    pieces: 2,
    gaps: [{ bodies: [0, 1], kind: 'apart', gapMm: 0.4, limitMm: limits.sideMm, from: [0, 0, 0], to: [0.4, 0, 0], direction: 'xy' }],
  },
}

const item = (p: PartPlan) => designCheck(p, body, 0.4).items.find((i) => i.name === 'planned gaps')

describe('design.check of the gaps a print-in-place plan sets', () => {
  it('fails a 0.3 mm gap where the gap above or below needs 0.4 mm, and says to use 0.4 mm', () => {
    const got = item(plan({ print_gap: 0.3 }))
    expect(got).toEqual({ name: 'planned gaps', want: 'every gap the plan sets at least 0.3 mm side by side and 0.4 mm above or below (PLA, 0.4 mm nozzle, 0.2 mm layers)', got: 'print_gap of Spinner: gap 0.3 mm (vertical) is under the 0.4 mm this printer needs between moving parts; use 0.4 mm', pass: false })
    expect(designCheck(plan({ print_gap: 0.3 }), body, 0.4).pass).toBe(false)
  })

  it('fails a 0.2 mm side gap where the side gap needs 0.3 mm, and says to use 0.3 mm', () => {
    expect(item(plan({ side_gap: 0.2 }))).toMatchObject({ got: 'side_gap of Spinner: gap 0.2 mm (side) is under the 0.3 mm this printer needs between moving parts; use 0.3 mm', pass: false })
  })

  it('passes gaps at the rule, side by side and above or below, and reads the sheet rows by their keys', () => {
    expect(item(plan({ clearance: 0.3, clearance_vertical: 0.4 }))).toMatchObject({ got: 'clearance 0.3 mm (side), clearance_vertical 0.4 mm (vertical)', pass: true })
    expect(item(plan({ clearance: 0.2 }))?.pass).toBe(false)
  })

  it('has no item for a plan that sets no gap, or one without printInPlace', () => {
    expect(item(plan({}))).toBeUndefined()
    expect(item(plan({ print_gap: 0.2 }, null))).toBeUndefined()
  })

  it('holds the gap in an inch plan in mm', () => {
    expect(item({ ...plan({ print_gap: 0.01 }), units: 'in' })).toMatchObject({ got: 'print_gap of Spinner: gap 0.25 mm (vertical) is under the 0.4 mm this printer needs between moving parts; use 0.4 mm', pass: false })
  })
})

describe('design.plan states the gaps moving pieces need', () => {
  const c = printInPlaceClearance()
  const tool = () => createCardPlans(createPlanRegistry()).planTool({ newId: () => 'plan_1' })

  it('names the fit rule smallest gaps in its text, from the rule itself', () => {
    expect([c.sideMm, c.verticalMm]).toEqual([0.3, 0.4])
    expect(tool().description).toContain('keep the gaps where they meet at least 0.3 mm side by side and 0.4 mm above or below (0.4 mm nozzle, PLA)')
  })

  const approve = async (sizes: Record<string, number>, printInPlace: string[] | null = null) => {
    const p = plan(sizes, printInPlace)
    const { planId: _, ...input } = p
    const ctx = { context: { machine: { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 } }, confirmsPlan: () => true, ask: async (q: { choices: { id: string }[] }) => ({ id: q.choices[0]!.id }) } as unknown as ToolContext
    return tool().run(input as never, ctx)
  }

  it('says the gaps this printer needs once a print-in-place plan is approved, and raises a planned gap under them on the card', async () => {
    const spinner = await approve({ print_gap: 0.3 }, ['Hub', 'Spinner'])
    expect(spinner.summary).toBe("Approved as shown. Moving pieces need gaps of at least 0.3 mm side by side and 0.4 mm above or below (PLA, 0.4 mm nozzle, 0.2 mm layers) on this printer. The card raised Spinner print gap to 0.45 mm on each side to this printer's smallest sizes; build from edits")
    expect(spinner.output).toMatchObject({ accepted: true, gaps: { sideMm: 0.3, verticalMm: 0.4 }, raised: [{ feature: 'Spinner', size: 'print_gap', from: 0.3, to: 0.45 }] })
    const fish = await approve({ side_gap: 0.2 }, ['Hub', 'Spinner'])
    expect(fish.summary).toContain('The card raised Spinner side gap to 0.35 mm on each side')
  })

  it('says nothing of gaps for a plan without printInPlace', async () => {
    const out = await approve({ print_gap: 0.2 })
    expect(out.summary).toBe('Approved as shown')
    expect(out.output).toEqual({ planId: 'plan_1', accepted: true })
  })
})
