// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An amend that is off in more than one way is refused once, naming each way, so a plan resent with three fields off
// is fixed in one round, not three. The texts are the ones each check wrote alone, joined in the order they were
// checked: the shape (part, units, features, overall, holes, open faces), then a plan with no size changed, then a
// field the amend would not keep. design.plan and design.put_plan refuse alike.
import type { Design as HostDesign, DesignHost } from '@slicerx/cad-history'
import type { PilotMachine } from '@slicerx/contracts'
import type { ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, type PartPlan } from '../src/design-check'
import { amendDropProblem, amendShapeProblem } from '../src/plan-amend'
import { PLAN_GO, type PlanInput } from '../src/tab-tools'
import { createCardPlans, designToolset, tabToolset } from '../src/toolset'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** One design, d1, with a part, so a plan can be tied to it as built. */
function host(): DesignHost {
  const d = { id: 'd1', name: 'Stone block', history: { version: 1, base: [], steps: [] }, transform: IDENTITY, parts: [{ name: 'Stone block', slot: 0, positions: [], indices: [] }], status: [], madeBy: {}, redo: [] } as unknown as HostDesign
  return { get: () => d, list: () => [d] } as unknown as DesignHost
}

const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }

/** A stone block with a cap on it and a row of drain holes. */
const block: PlanInput = {
  part: 'Stone block',
  units: 'mm',
  features: [
    { name: 'Block', kind: 'extrude', sizes: { length: 60, width: 40, height: 30 } },
    { name: 'Cap', kind: 'extrude', on: 'Block', sizes: { length: 60, width: 40, height: 4 } },
  ],
  overall: { x: 60, y: 40, z: 34 },
  holes: [{ name: 'Drain', diameter: 4, count: 3 }],
  assumptions: ['The cap sits flush on the block.'],
  questions: [],
}

const SHAPE = {
  units: 'units: an amend changes sizes only; the plan stays in mm',
  sizes: 'features: an amend changes sizes only; Block keeps the sizes length, width, height',
  overall: 'overall: an amend changes sizes only; keep the overall size',
  holes: 'holes: an amend changes sizes only; the plan keeps its rows of holes, by name and count',
  recess: 'holes: an amend changes sizes only; Drain takes no recess',
}

describe('the amend checks name every mismatch', () => {
  const was: PartPlan = { planId: 'p', ...block }

  it('amendShapeProblem joins each one, in the order it checks them', () => {
    const next = { ...was, units: 'in' as const, features: [{ ...was.features[0]!, sizes: { length: 62, height: 30 } }, was.features[1]!], overall: undefined, holes: [{ name: 'Drain', diameter: 4, count: 4 }] }
    expect(amendShapeProblem(was, next)).toBe([SHAPE.units, SHAPE.sizes, SHAPE.overall, SHAPE.holes].join('. '))
    // one mismatch reads as it did alone
    expect(amendShapeProblem(was, { ...was, overall: undefined })).toBe(SHAPE.overall)
    expect(amendShapeProblem(was, was)).toBeNull()
  })

  it('amendDropProblem joins each field it would not keep', () => {
    const next = { ...was, holes: [{ name: 'Drain', diameter: 4, count: 3, recess: true }], proportions: 'stated: a 60 cm block', scale: 10 }
    expect(amendDropProblem(was, next)).toBe(`${SHAPE.recess}. proportions: an amend changes sizes only; leave out proportions. scale: an amend changes sizes only; leave out scale`)
  })
})

/** The tab's design.plan over d1, every card answered Go. */
function tab() {
  const card = createCardPlans(createPlanRegistry())
  const tools = tabToolset(host(), card, { nozzleMm: () => machine.nozzle, newPlanId: () => 'plan_1' })
  const tool = tools.find((t) => t.name === 'design.plan')!
  const ctx = { context: { project: 'creative', machine, objects: [] }, confirmsPlan: () => true, ask: async (q: { choices: { id: string }[] }) => ({ id: q.choices.find((c) => c.id.startsWith(`${PLAN_GO}:`))!.id }) } as unknown as ToolContext
  const run = (input: unknown) => tool.run(tool.input.parse(input) as never, ctx)
  return { card, run }
}

describe('design.plan with amends', () => {
  it('refuses a build amend off in three ways once, naming all three', async () => {
    const t = tab()
    await t.run(block)
    t.card.tieBuiltPart({ name: 'design.new', permission: 'write' }, {}, { summary: 'Started', output: { design: 'd1' } })
    const off = { ...block, units: 'in', holes: [{ name: 'Drain', diameter: 4, count: 4, recess: true }], features: [block.features[0]!, { ...block.features[1]!, sizes: { ...block.features[1]!.sizes, height: 5 } }] }
    await expect(t.run({ ...off, amends: 'plan_1', reason: 'The cap is thicker.' })).rejects.toThrow(`${SHAPE.units}. ${SHAPE.holes}. ${SHAPE.recess}`)
  })

  it('names a recess it would not keep beside a plan with no size changed', async () => {
    const t = tab()
    await t.run(block)
    t.card.tieBuiltPart({ name: 'design.new', permission: 'write' }, {}, { summary: 'Started', output: { design: 'd1' } })
    const recessed = { ...block, holes: [{ name: 'Drain', diameter: 4, count: 3, recess: true }] }
    await expect(t.run({ ...recessed, amends: 'plan_1', reason: 'The cap is thicker.' })).rejects.toThrow(`amends: no size differs from the approved plan plan_1. ${SHAPE.recess}`)
  })

  it('refuses a change the person asked for once, naming each field it would not keep', async () => {
    const t = tab()
    await t.run(block)
    t.card.tieBuiltPart({ name: 'design.new', permission: 'write' }, {}, { summary: 'Started', output: { design: 'd1' } })
    const asked = { ...block, holes: [{ name: 'Drain', diameter: 4, count: 4, recess: true }], amends: 'plan_1', asked: 'one more drain hole' }
    await expect(t.run(asked)).rejects.toThrow(`${SHAPE.holes}. ${SHAPE.recess}`)
  })
})

describe('design.put_plan with amends', () => {
  it('refuses a client amend off in two ways once, naming both', async () => {
    const plans = createPlanRegistry()
    const put = designToolset(host(), {}, { plans, nozzleMm: () => 0.4 }).find((x) => x.name === 'design.put_plan')!
    const run = (input: unknown) => put.run(put.input.parse(input) as never, { context: { machine } } as unknown as ToolContext)
    const mine: PartPlan = { planId: 'block-1', ...block }
    await run({ plan: mine, design: 'd1' })
    await expect(run({ plan: { ...mine, overall: undefined, holes: [] }, amends: 'block-1', reason: 'No drains.' })).rejects.toThrow(`${SHAPE.overall}. ${SHAPE.holes}`)
  })
})
