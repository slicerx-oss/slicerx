// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plan whose pieces print together without saying so in printInPlace. Recorded runs of a flexi fish and an
// articulated lizard (test/fixtures/print-together-plans.json) planned a piece count (segment_count) and a joint gap, but no printInPlace, so neither the plan's
// gaps nor the check's planned gaps item looked at them. design.plan now reads such a plan as print-in-place, says so on
// the card, and design.check holds its planned gaps to the fit rule for the run's own material.
import { readFileSync } from 'node:fs'
import type { Design as HostDesign, DesignHost } from '@slicerx/cad-history'
import type { PilotMachine } from '@slicerx/contracts'
import { printInPlaceClearance, type ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { CREATIVE_PROMPTS } from '../evals/creative/prompts'
import { gapWay, type PartPlan } from '../src/design-check'
import { createCardPlans, createPlanRegistry, tabToolset } from '../src/toolset'

const LINE = 'These pieces print together, so their gaps follow the fit rule'

/**
 * The design.plan arguments recorded runs sent (the 11-07 captures of these prompts, kept here since the recordings were
 * captured again), and the machine each prompt runs on.
 */
const RECORDED_PLANS = JSON.parse(readFileSync(new URL('./fixtures/print-together-plans.json', import.meta.url), 'utf8')) as Record<string, Omit<PartPlan, 'planId'>>
function recorded(id: string): { input: Omit<PartPlan, 'planId'>; machine: PilotMachine } {
  const input = RECORDED_PLANS[id]
  if (!input) throw new Error(`${id} has no recorded plan`)
  const prompt = CREATIVE_PROMPTS.find((p) => p.id === id)
  if (!prompt) throw new Error(`${id} has no prompt`)
  return { input: structuredClone(input), machine: prompt.machine }
}

type Tri = [number[], number[], number[]]
function boxTris([x0, y0, z0]: number[], [x1, y1, z1]: number[]): Tri[] {
  const v = (i: number): number[] => [i & 1 ? x1! : x0!, i & 2 ? y1! : y0!, i & 4 ? z1! : z0!]
  const f = (a: number, b: number, c: number): Tri => [v(a), v(b), v(c)]
  return [f(0, 1, 5), f(0, 2, 3), f(0, 5, 4), f(0, 3, 1), f(2, 6, 7), f(4, 5, 7), f(2, 7, 3), f(4, 7, 6), f(0, 4, 6), f(0, 6, 2), f(1, 3, 7), f(1, 7, 5)]
}
const meshOf = (tris: readonly Tri[]) => ({ positions: tris.flat(2), indices: tris.flatMap((_, t) => [t * 3, t * 3 + 1, t * 3 + 2]) })
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** One closed box design on a host whose engine says it is closed and finds no holes: only the plan's sizes can fail. */
function boxHost(): DesignHost {
  const d = { id: 'd1', name: 'Part', history: { version: 1, base: [], steps: [] }, transform: IDENTITY, parts: [{ name: 'Part', slot: 0, ...meshOf(boxTris([0, 0, 0], [120, 12, 26])) }], status: [], madeBy: {}, redo: [] } as unknown as HostDesign
  return {
    get: (id: string) => {
      if (id !== d.id) throw new Error(`no design ${id}`)
      return d
    },
    list: () => [d],
    create: async () => Promise.reject(new Error('not here')),
    add: async () => Promise.reject(new Error('not here')),
    replay: async () => {},
    call: async (op: string) => (op === 'info' ? { watertight: true } : Promise.reject(new Error('no hole there'))),
  } as unknown as DesignHost
}

/**
 * The tab's tools as the creative eval makes them, over one box design: design.plan approved with Go (and the card's
 * edits, when given), the part tied to design d1 as the tab ties it, then design.check, both in a run on `machine`.
 */
async function planAndCheck(input: Omit<PartPlan, 'planId'>, machine: PilotMachine, edit?: (p: PartPlan) => PartPlan) {
  const card = createCardPlans(createPlanRegistry())
  const tools = tabToolset(boxHost(), card, { nozzleMm: () => machine.nozzle, newPlanId: () => 'plan_1' })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  // a card the person answers: one that waits for their Go (sizes that fit something)
  const ctx = {
    context: { project: 'creative', machine, objects: [] },
    confirmsPlan: () => true,
    ask: async (q: { choices: { id: string }[] }) => {
      const shown = card.planById('plan_1')!
      if (edit) card.editPlan('plan_1', edit(shown))
      return { id: q.choices[0]!.id }
    },
  } as unknown as ToolContext
  const plan = tool('design.plan')
  const planned = await plan.run(plan.input.parse(input), ctx)
  card.tieBuiltPart({ name: 'design.new', permission: 'write' }, {}, { summary: 'Started', output: { design: 'd1' } })
  const check = tool('design.check')
  const checked = await check.run(check.input.parse({ planId: 'plan_1' }), ctx)
  const items = (checked.output as { items: { name: string; want: string; got: string; pass: boolean }[] }).items
  return { planned, shown: card.shownPlan('plan_1'), stored: card.planById('plan_1'), gaps: items.find((i) => i.name === 'planned gaps'), checked }
}

describe('a recorded plan whose pieces print together', () => {
  it('the flexi fish (segment_count 5, joint_gap 0.4 mm, on an A1 mini in PLA) prints in place, and the card says so', async () => {
    const { input, machine } = recorded('flexi-fish')
    expect(input.printInPlace).toBeUndefined()
    expect(machine).toMatchObject({ material: 'pla', nozzle: 0.4 })
    const r = await planAndCheck(input, machine)
    expect(r.shown?.assumptions[0]).toBe(LINE)
    expect(r.stored?.assumptions[0]).toBe(LINE)
    expect(r.planned.summary).toBe(`Approved as shown. ${LINE}. Moving pieces need gaps of at least 0.3 mm side by side and 0.4 mm above or below (PLA, 0.4 mm nozzle, 0.2 mm layers) on this printer.`)
    expect(r.planned.output).toMatchObject({ accepted: true, gaps: { sideMm: 0.3, verticalMm: 0.4 } })
    // joint_gap names no way, so it is on every face and held to the larger gap; 0.4 mm clears it
    expect(r.gaps).toEqual({ name: 'planned gaps', want: 'every gap the plan sets at least 0.3 mm side by side and 0.4 mm above or below (PLA, 0.4 mm nozzle, 0.2 mm layers)', got: 'joint_gap 0.4 mm (vertical)', pass: true })
  })

  it('the flexi fish with the 0.2 mm joint it built typed on the card fails the planned gap and gives the gap to use', async () => {
    const { input, machine } = recorded('flexi-fish')
    const r = await planAndCheck(input, machine, (p) => ({ ...p, features: p.features.map((f) => (f.sizes['joint_gap'] ? { ...f, sizes: { ...f.sizes, joint_gap: 0.2 } } : f)) }))
    expect(r.planned.summary).toBe(`Approved with changes. ${LINE}. Moving pieces need gaps of at least 0.3 mm side by side and 0.4 mm above or below (PLA, 0.4 mm nozzle, 0.2 mm layers) on this printer. joint_gap of Segments and joint gaps: gap 0.2 mm (vertical) is under the 0.4 mm this printer needs between moving parts; use 0.4 mm`)
    expect(r.gaps).toMatchObject({ got: 'joint_gap of Segments and joint gaps: gap 0.2 mm (vertical) is under the 0.4 mm this printer needs between moving parts; use 0.4 mm', pass: false })
  })

  it('the articulated lizard (segment_count 9, joint_clearance 0.4 mm) prints in place too', async () => {
    const { input, machine } = recorded('articulated-lizard')
    expect(input.printInPlace).toBeUndefined()
    const r = await planAndCheck(input, machine)
    expect(r.shown?.assumptions[0]).toBe(LINE)
    expect(r.gaps?.pass).toBe(true)
  })

  it('the fidget spinner plan names no gap size (its 0.3 mm gap was on the sheet only), so it is left alone', async () => {
    const { input, machine } = recorded('fidget-spinner')
    expect(input.features.flatMap((f) => Object.keys(f.sizes)).filter((k) => /gap|clearance/i.test(k))).toEqual([])
    const r = await planAndCheck(input, machine)
    expect(r.planned.summary).toBe('Approved as shown')
    expect(r.shown?.assumptions).toEqual(input.assumptions)
    expect(r.gaps).toBeUndefined()
  })

  it('holds the planned gaps to the run machine material, as the plan does', async () => {
    const { input } = recorded('flexi-fish')
    const petg: PilotMachine = { printer: 'prusa_mk4s', material: 'petg', nozzle: 0.4 }
    const rule = printInPlaceClearance({ material: 'petg' })
    expect([rule.sideMm, rule.verticalMm]).toEqual([0.4, 0.6])
    const r = await planAndCheck(input, petg)
    expect(r.planned.summary).toContain('at least 0.4 mm side by side and 0.6 mm above or below (PETG, 0.4 mm nozzle, 0.2 mm layers) on this printer')
    // the card raised the 0.4 mm joint to 0.05 mm over PETG's 0.6 mm before Go, so the part built from the plan clears it
    expect(r.planned.summary).toContain('The card raised Segments and joint gaps joint gap to 0.65 mm on each side')
    expect(r.gaps).toEqual({ name: 'planned gaps', want: 'every gap the plan sets at least 0.4 mm side by side and 0.6 mm above or below (PETG, 0.4 mm nozzle, 0.2 mm layers)', got: 'joint_gap 0.65 mm (vertical)', pass: true })
  })
})

describe('a plan left alone', () => {
  const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }
  const chain = (extra: Partial<PartPlan> = {}, sizes: Record<string, number> = { link_count: 6, link_gap: 0.2 }): Omit<PartPlan, 'planId'> => ({
    part: 'Chain',
    units: 'mm',
    features: [
      { name: 'Link', kind: 'extrude', sizes: { length: 15, width: 8 } },
      { name: 'Links', kind: 'pattern', sizes },
    ],
    assumptions: ['Links are 15 mm long.'],
    questions: [],
    ...extra,
  })
  const alone = async (plan: Omit<PartPlan, 'planId'>) => {
    const r = await planAndCheck(plan, machine)
    expect(r.planned.summary, JSON.stringify(plan)).toBe('Approved as shown')
    expect(r.shown?.assumptions, JSON.stringify(plan)).toEqual(plan.assumptions)
    expect(r.gaps).toBeUndefined()
  }

  it('reads a chain of 6 links with a 0.2 mm link gap as print-in-place', async () => {
    const r = await planAndCheck(chain(), machine)
    // the card says so first, then raises the 0.2 mm link gap to 0.05 mm over the 0.4 mm it needs
    expect(r.shown?.assumptions).toEqual([LINE, 'Links link gap raised from 0.2 mm to 0.45 mm on each side, 0.05 mm over the smallest gap for parts printed in place with a 0.4 mm nozzle in PLA.', 'Links are 15 mm long.'])
    expect(r.gaps).toMatchObject({ got: 'link_gap 0.45 mm (vertical)', pass: true })
  })

  it('leaves a plan with printInPlace false alone', async () => {
    await alone(chain({ printInPlace: false }))
  })

  it('leaves a plan that says its pieces print separately alone', async () => {
    for (const said of ['The links are printed separately and joined after.', 'Each link is printed separately.', 'Print them separately, then snap them together.', 'All pieces print as separate pieces.']) await alone(chain({ assumptions: [said] }))
    await alone(chain({ part: 'Chain, links printed separately' }))
  })

  it('still reads the near misses of print separately as print-in-place', async () => {
    for (const said of ['The links are not printed separately.', "The links aren't printed separately.", 'The links could be printed separately if wanted.', 'The end cap is printed separately.', 'Each link is a separate piece joined by a pin.']) {
      const r = await planAndCheck(chain({ assumptions: [said] }, { link_count: 6, link_gap: 0.4 }), machine)
      expect(r.shown?.assumptions, said).toEqual([LINE, said])
    }
    // a question is not what the plan says: the fish asked whether to print the segments as separate pieces
    const asked = 'Should the links print in place, or as separate pieces to assemble?'
    expect((await planAndCheck(chain({ questions: [asked] }), machine)).shown?.assumptions[0]).toBe(LINE)
  })

  it('a single piece with a clearance size is no print-in-place part', async () => {
    await alone({ part: 'Lid', units: 'mm', features: [{ name: 'Lid', kind: 'extrude', sizes: { width: 40, lid_clearance: 0.3 } }, { name: 'Rim', kind: 'extrude', sizes: { height: 3 } }], assumptions: [], questions: [] })
    // a count of features on one piece is no count of pieces
    await alone(chain({}, { count: 6, arm_gap: 0.3 }))
    await alone(chain({}, { fin_count: 3, fin_gap: 0.3 }))
    await alone(chain({}, { segment_count: 1, segment_gap: 0.3 }))
    // a screw's clearance hole is a hole, not a gap
    await alone(chain({}, { link_count: 4, hole_clearance: 4.5 }))
    // pieces with no gap
    await alone(chain({}, { link_count: 6, link_length: 15 }))
  })
})

describe('which way a planned gap runs, by its key', () => {
  it('counts any key with gap or clearance in it, and reads its way', () => {
    // no way in the name: on every face, held to the larger gap
    for (const k of ['print_gap', 'printgap', 'jointGap', 'joint_clearance', 'gap']) expect(gapWay(k), k).toBe('both')
    for (const k of ['clearance_vertical', 'verticalgap', 'gapZ', 'cap_gap', 'gap_above']) expect(gapWay(k), k).toBe('z')
    for (const k of ['clearance', 'side_gap', 'radialclearance', 'xy_clearance']) expect(gapWay(k), k).toBe('xy')
    // a hole sized for a screw, a bore or a count is no gap
    for (const k of ['hole_clearance', 'clearance_hole_diameter', 'bore_diameter', 'gap_count', 'span']) expect(gapWay(k), k).toBeNull()
  })
})
