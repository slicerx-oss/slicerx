// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.plan's flat takes each flat-sided main body with its levels, {feature, levels}, in place of a list of names
// and a separate tiers map. A body given that way always states its levels, so "give the levels of" cannot happen, and
// a name over levels that are all features reads as one body keyed by its lowest level, so the group-key refusal
// cannot happen either. The older names-and-tiers form is still taken, with its refusals as before. The card keeps the
// older form, so a saved plan reads back as it did.
import type { DesignHost } from '@slicerx/cad-history'
import type { PilotMachine } from '@slicerx/contracts'
import { toolSpec, type ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry } from '../src/design-check'
import { flatLevels, TIER_GROUP_KEY } from '../src/plan-detail'
import { PLAN_GO, type PlanInput } from '../src/tab-tools'
import { createCardPlans, tabToolset } from '../src/toolset'

const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }

/** A two-level stone house at display detail, its size the person's, in the older form. */
const house: PlanInput = {
  personSize: true,
  part: 'Stone house',
  units: 'mm',
  detail: 'display',
  flat: ['Walls', 'Roof'],
  tiers: { Walls: ['Walls'], Roof: ['Roof'] },
  proportions: 'stated: a two story house 10 m wide, 8 m deep, scaled 1:100',
  scale: 100,
  real: [{ feature: 'Walls', size: 'width', mm: 10000 }],
  repeats: ['windows', 'steps'],
  features: [
    { name: 'Walls', kind: 'extrude', sizes: { width: 100, depth: 80, height: 55 } },
    { name: 'Roof', kind: 'extrude', sizes: { width: 104, depth: 84, height: 30 } },
    { name: 'Windows', kind: 'array cut', sizes: { width: 8, height: 12, count: 4 }, kinds: { count: 'count' } },
    { name: 'Window frames', kind: 'array', sizes: { width: 10, height: 14, count: 4 }, kinds: { count: 'count' } },
    { name: 'Door', kind: 'extrude', sizes: { width: 10, height: 20, depth: 1 } },
    { name: 'Chimney', kind: 'extrude', sizes: { width: 8, depth: 8, height: 20 } },
    { name: 'Porch', kind: 'extrude', sizes: { width: 30, depth: 12, height: 2 } },
    { name: 'Steps', kind: 'array', sizes: { width: 14, depth: 3, height: 2, count: 3 }, kinds: { count: 'count' } },
  ],
  assumptions: [],
  questions: [],
}
const { flat: _f, tiers: _t, ...bare } = house

function tab() {
  const card = createCardPlans(createPlanRegistry())
  const tool = tabToolset({ list: () => [], get: () => undefined } as unknown as DesignHost, card, { nozzleMm: () => machine.nozzle, newPlanId: () => 'plan_1' }).find((t) => t.name === 'design.plan')!
  const ctx = { context: { project: 'creative', machine, objects: [] }, ask: async (q: { choices: { id: string }[] }) => ({ id: q.choices.find((c) => c.id.startsWith(`${PLAN_GO}:`))!.id }) } as unknown as ToolContext
  return { card, tool, run: (input: unknown) => tool.run(tool.input.parse(input) as never, ctx) }
}

describe('flat bodies with their levels', () => {
  it('takes each body with its levels, and the card keeps the names and tiers it always kept', async () => {
    const t = tab()
    const out = await t.run({ ...bare, flat: [{ feature: 'Walls', levels: ['Walls'] }, { feature: 'Roof', levels: ['Roof'] }] })
    expect(out.output).toMatchObject({ planId: 'plan_1', accepted: true })
    expect(t.card.plans.get('plan_1')!.plan).toMatchObject({ flat: ['Walls', 'Roof'], tiers: { Walls: ['Walls'], Roof: ['Roof'] } })
  })

  it('reads a name over levels that are all features as one body keyed by its lowest, where the older form is refused', async () => {
    const stacked = { ...bare, assumptions: ['real: Roof width not given by the source'] }
    // the older form: a key that is no feature
    await expect(tab().run({ ...stacked, flat: ['Walls'], tiers: { 'House body': ['Walls', 'Roof'] } })).rejects.toThrow(TIER_GROUP_KEY('House body', ['Walls', 'Roof']))
    // the same body with its levels is taken, as the levels of one body
    const t = tab()
    const out = await t.run({ ...stacked, flat: [{ feature: 'House body', levels: ['Walls', 'Roof'] }] })
    expect(out.output).toMatchObject({ accepted: true })
    expect(t.card.plans.get('plan_1')!.plan).toMatchObject({ flat: ['Walls'], tiers: { Walls: ['Walls', 'Roof'] } })
  })

  it('cannot leave a body\'s levels out: the schema refuses a body with none', () => {
    const t = tab()
    expect(t.tool.input.safeParse({ ...bare, flat: [{ feature: 'Walls', levels: [] }] }).success).toBe(false)
    expect(t.tool.input.safeParse({ ...bare, flat: [{ feature: 'Walls' }] }).success).toBe(false)
    // the older form still says when a flat body states no levels
    return expect(t.run({ ...bare, flat: ['Walls', 'Roof'], tiers: { Walls: ['Walls'] } })).rejects.toThrow('tiers: give the levels of Roof from the bottom up')
  })

  it('names a body that is no feature, over levels that are not all features, as before', async () => {
    await expect(tab().run({ ...bare, flat: [{ feature: 'Annex', levels: ['Annex', 'Walls'] }, { feature: 'Roof', levels: ['Roof'] }] })).rejects.toThrow('flat: Annex is not a planned feature; name the feature that builds the body')
  })

  it('keeps tiers given for another body beside the bodies given with their levels', () => {
    expect(flatLevels({ flat: [{ feature: 'Walls', levels: ['Walls'] }], tiers: { Roof: ['Roof'] } }, house.features)).toEqual({ flat: ['Walls'], tiers: { Roof: ['Roof'], Walls: ['Walls'] } })
    // the older form comes back as it is
    expect(flatLevels({ flat: ['Walls'], tiers: { Walls: ['Walls'] } }, house.features)).toEqual({ flat: ['Walls'], tiers: { Walls: ['Walls'] } })
  })

  it('shows the model the form with levels first, and tiers as the older form', () => {
    const spec = toolSpec(tab().tool) as unknown as { inputSchema: { properties: Record<string, { description?: string; anyOf?: { items?: { properties?: Record<string, unknown>; required?: string[] } }[] }> } }
    const flat = spec.inputSchema.properties['flat']!
    expect(flat.description).toMatch(/^Display and fine: each main body whose real thing is flat-sided/)
    expect(flat.anyOf![0]!.items!.required).toEqual(['feature', 'levels'])
    expect(spec.inputSchema.properties['tiers']!.description).toMatch(/^The older form of flat's levels/)
  })
})
