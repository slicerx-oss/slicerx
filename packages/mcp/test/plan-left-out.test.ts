// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the reply's part card reads from design.plan: leftOut, the real thing's details the part leaves out, as noun
// phrases, on the cloud form only (a local model's form, the shared plan design.put_plan takes and the local budget
// stay as they were); and underFloors, each size the person kept under this printer's smallest on the card.
import type { DesignHost } from '@slicerx/cad-history'
import type { AskAnswer, ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, LEFT_OUT_HELP, partPlanSchema, type PartPlan } from '../src/design-check'
import { createCardPlans, LocalPlanInputSchema, PLAN_GO, planChoiceId, PlanToolInputSchema, type PlanAnswer, type PlanInput } from '../src/tab-tools'
import { designToolset } from '../src/toolset'

const lighthouse: PlanInput = {
  part: 'Lighthouse',
  units: 'mm',
  features: [
    { name: 'Tower', kind: 'extrude', sizes: { diameter: 40, height: 150 } },
    { name: 'Base', kind: 'extrude', sizes: { width: 64, depth: 64, height: 10 } },
  ],
  assumptions: ['Gallery rail height 3 mm'],
  questions: [],
  leftOut: ['window panes', 'the weather vane'],
}

/** Runs design.plan as the tab does, the person pressing Go after `edit` changes the card, when given. */
async function plan(input: PlanInput, edit?: (p: PartPlan) => PartPlan) {
  const registry = createPlanRegistry()
  const card = createCardPlans(registry)
  const tool = card.planTool({ newId: () => 'plan-1' })
  const ask = async (): Promise<AskAnswer> => {
    if (edit) card.editPlan('plan-1', edit(structuredClone(card.planById('plan-1')!)))
    return { id: planChoiceId(PLAN_GO, 'plan-1') }
  }
  const ctx = { ask, confirmsPlan: () => true, context: { machine: { printer: 'test_printer', material: 'pla', nozzle: 0.4 } } } as unknown as ToolContext
  const out = await tool.run(tool.input.parse(input) as never, ctx)
  return { out, answer: out.output as PlanAnswer, registry, tool }
}

const keys = (schema: unknown): string[] => Object.keys((schema as { shape: Record<string, unknown> }).shape)

describe('leftOut on a plan', () => {
  it('is on the cloud form of design.plan and kept with the plan the card approved', async () => {
    expect(keys(PlanToolInputSchema)).toContain('leftOut')
    const { registry } = await plan(lighthouse)
    expect(registry.get('plan-1')!.plan.leftOut).toEqual(['window panes', 'the weather vane'])
    // the shared plan keeps it, so a saved project brings it back
    expect(partPlanSchema.parse({ planId: 'p', ...lighthouse }).leftOut).toEqual(['window panes', 'the weather vane'])
  })

  it('is not on a local model\'s form, nor on design.put_plan, so neither changes', () => {
    expect(keys(LocalPlanInputSchema)).not.toContain('leftOut')
    expect(Object.keys(LocalPlanInputSchema.parse(lighthouse))).not.toContain('leftOut')
    const put = designToolset({} as DesignHost, {}, { plans: createPlanRegistry() }).find((t) => t.name === 'design.put_plan')!
    const planShape = (put.input as unknown as { shape: { plan: { shape: Record<string, unknown> } } }).shape.plan.shape
    expect(Object.keys(planShape)).not.toContain('leftOut')
    const card = createCardPlans(createPlanRegistry()).planTool()
    expect(card.version).toBe('1.24.0')
    expect(keys(card.localInput)).not.toContain('leftOut')
    expect(card.localDescription).not.toContain('leftOut')
  })

  it('asks for noun phrases with no reason, in these words', () => {
    expect(LEFT_OUT_HELP).toBe(
      'The real thing\'s details this part leaves out (too small to print at this size, or not asked for), each a noun phrase with no reason, such as "window panes" or "the weather vane", never "window panes, too small at this scale"; give the reason, if any, in an assumption. Leave it out when nothing is left out',
    )
    expect(partPlanSchema.shape.leftOut.description).toBe(LEFT_OUT_HELP)
    expect(createCardPlans(createPlanRegistry()).planTool().description).toContain("the real thing's details you left out in leftOut (noun phrases only)")
  })

  it('takes a plan without it, as before', async () => {
    const { leftOut: _l, ...plain } = lighthouse
    const { answer, registry } = await plan(plain)
    expect(answer.accepted).toBe(true)
    expect(registry.get('plan-1')!.plan.leftOut).toBeUndefined()
  })
})

describe('underFloors on an approved plan', () => {
  it('names each size the person kept under this printer\'s smallest, and none for a plan at its floors', async () => {
    const thin = (p: PartPlan): PartPlan => ({ ...p, features: p.features.map((f) => (f.name === 'Tower' ? { ...f, sizes: { ...f.sizes, wall: 0.5 } } : f)) })
    const walled: PlanInput = { ...lighthouse, features: [{ name: 'Tower', kind: 'extrude', sizes: { diameter: 40, height: 150, wall: 1.2 } }, lighthouse.features[1]!] }
    const { answer } = await plan(walled, thin)
    expect(answer.underFloors).toEqual([{ feature: 'Tower', size: 'wall', name: 'Tower wall', planned: 0.5, floor: 0.8, why: expect.stringContaining('0.4 mm nozzle') }])
    expect((await plan(walled)).answer.underFloors).toBeUndefined()
  })
})
