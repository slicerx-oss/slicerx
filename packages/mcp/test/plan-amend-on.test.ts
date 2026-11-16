// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An amend may move a planned feature onto another body (its on): a top planned on the block but built on the stand
// is fixed by saying it stands on the stand, and design.check then holds it to that. Each other field an amend cannot
// carry is still refused.
import type { PilotMachine } from '@slicerx/contracts'
import type { ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, type PartPlan } from '../src/design-check'
import { amendDropProblem, amendedSizes, amendOns } from '../src/plan-amend'
import { createCardPlans, designToolset, tabToolset } from '../src/toolset'
import { STAND_PLAN, standHost } from './stand-host'

const onStand = (p: PartPlan) => p.features.map((f) => (f.name === 'Top' ? { ...f, on: 'Stand' } : f))

const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }
type Item = { name: string; got: string; pass: boolean }

function tab() {
  const plans = createPlanRegistry()
  const card = createCardPlans(plans)
  const tools = tabToolset(standHost().host, card, { nozzleMm: () => machine.nozzle, newPlanId: () => 'plan_1' })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const cards: string[] = []
  const ctx = {
    context: { project: 'creative', machine, objects: [] },
    ask: async (q: { title: string; choices: { id: string }[] }) => {
      cards.push(q.title)
      return { id: q.choices[0]!.id }
    },
  } as unknown as ToolContext
  const run = (name: string, input: unknown) => tool(name).run(tool(name).input.parse(input) as never, ctx)
  plans.put(STAND_PLAN, 'd1', 'card')
  const stands = async () => ((await run('design.check', { planId: 'plan_1' })).output as { items: Item[] }).items.find((i) => i.name === 'stands on')!
  return { plans, run, cards, stands }
}

describe('an amend that moves a feature onto another body', () => {
  it('as the person asked: is taken, and design.check then holds the top to the stand', async () => {
    const { plans, run, cards, stands } = tab()
    const before = await stands()
    expect(before.pass).toBe(false)
    expect(before.got).toMatch(/^Top stands on Block, but its base is 6 mm above its top/)
    const r = await run('design.plan', { amends: 'plan_1', asked: 'the top sits on the stand', features: onStand(STAND_PLAN) })
    expect(r.ok).not.toBe(false)
    // nothing but the link changed: the result lists the move and no size, and the plan it returns has the new link
    expect(r.summary).toBe('Plan changed as asked (revision 2): Top on Stand, not Block. Build to it as changed')
    expect((r.output as { edits: PartPlan }).edits.features.find((f) => f.name === 'Top')!.on).toBe('Stand')
    expect(cards).toEqual([])
    expect(plans.get('plan_1')!.plan.features.map((f) => [f.name, f.on])).toEqual([['Block', undefined], ['Stand', 'Block'], ['Top', 'Stand']])
    expect(await stands()).toMatchObject({ pass: true, got: '2 stacked parts on their supports' })
  })

  it("as the build's amend after a failed check: the card shows, Go takes it, and the check passes", async () => {
    const { run, cards, stands } = tab()
    expect((await stands()).pass).toBe(false)
    const r = await run('design.plan', { amends: 'plan_1', reason: 'The top was built on the stand, so it stands on the stand.', features: onStand(STAND_PLAN) })
    expect(r.ok).not.toBe(false)
    expect(r.summary).toBe('Plan changed (revision 2): Top on Stand, not Block. Build to it as changed')
    expect(cards).toEqual(['Plan change'])
    expect((await stands()).pass).toBe(true)
  })

  it("as a client's amend over design.put_plan: taken, and design.check checks the new link", async () => {
    const plans = createPlanRegistry()
    const tools = designToolset(standHost().host, {}, { plans })
    const tool = (name: string) => tools.find((t) => t.name === name)!
    const run = (name: string, input: unknown) => tool(name).run(tool(name).input.parse(input) as never, {} as ToolContext)
    const { detail: _d, ...client } = STAND_PLAN as PartPlan & { detail?: string }
    await run('design.put_plan', { plan: client, design: 'd1' })
    const stands = async () => ((await run('design.check', { planId: 'plan_1' })).output as { items: Item[] }).items.find((i) => i.name === 'stands on')!
    expect((await stands()).pass).toBe(false)
    const r = await run('design.put_plan', { plan: { ...client, features: onStand(client as PartPlan) }, amends: 'plan_1', reason: 'The top stands on the stand.' })
    expect(r.summary).toMatch(/^Changed plan plan_1 for Stand \(revision 2\): Top on Stand, not Block\. Build to it as changed/)
    expect((await stands()).pass).toBe(true)
    expect(plans.get('plan_1')!.plan.features.find((f) => f.name === 'Top')!.on).toBe('Stand')
  })

  it('keeps a feature restated without its on as the plan has it', () => {
    const next = { ...STAND_PLAN, features: STAND_PLAN.features.map(({ on: _on, ...f }) => f) }
    expect(amendOns(STAND_PLAN, next)).toEqual([])
    expect(amendDropProblem(STAND_PLAN, next)).toBeNull()
    expect(amendedSizes(STAND_PLAN, next).features.map((f) => f.on)).toEqual([undefined, 'Block', 'Block'])
    // a link given in other case is the same link
    expect(amendOns(STAND_PLAN, { ...STAND_PLAN, features: STAND_PLAN.features.map((f) => (f.on ? { ...f, on: f.on.toUpperCase() } : f)) })).toEqual([])
  })
})

describe('what an amend still cannot carry', () => {
  const lidded: PartPlan = { ...STAND_PLAN, holes: [{ name: 'Lid vent', diameter: 3, count: 2 }] } as PartPlan

  it("refuses a row of holes' recess changed, beside a link that is now taken", () => {
    const next = { ...lidded, features: onStand(lidded), holes: [{ name: 'Lid vent', diameter: 3, count: 2, recess: true }] }
    expect(amendDropProblem(lidded, next)).toBe('holes: an amend changes sizes and on only; Lid vent takes no recess')
  })

  it("refuses a client's kept field given otherwise, beside a link that is now taken", () => {
    expect(amendDropProblem(STAND_PLAN, { ...STAND_PLAN, features: onStand(STAND_PLAN), scale: 25 } as PartPlan)).toBe('scale: an amend changes sizes and on only; leave out scale')
  })

  it("refuses a dropped feature, and a build's amend that changes how a feature is made, in the tab, as before", async () => {
    const { run } = tab()
    await expect(run('design.plan', { amends: 'plan_1', asked: 'drop the top', features: STAND_PLAN.features.slice(0, 2) })).rejects.toThrow('features: an amend keeps every planned feature, in order')
    const lofted = onStand(STAND_PLAN).map((f) => (f.name === 'Top' ? { ...f, kind: 'loft' } : f))
    await expect(run('design.plan', { amends: 'plan_1', reason: 'The top is lofted.', features: lofted })).rejects.toThrow('features: an amend changes sizes and on only; feature 3 stays "Top"')
  })
})

describe('the descriptions of an amend that moves a feature', () => {
  it('design.put_plan says an amend changes sizes and what a planned feature stands on, word for word', () => {
    const put = designToolset(standHost().host).find((t) => t.name === 'design.put_plan')!
    expect(put.description).toContain('a size the build cannot keep is changed with amends (its planId) and reason (why, required): sizes, and what a planned feature stands on (on), only once per fix round and never after the stop result')
  })

  it('design.plan says an amend may move a feature onto another planned one, word for word', () => {
    const plan = tabToolset(standHost().host, createCardPlans(createPlanRegistry())).find((t) => t.name === 'design.plan')!
    expect(plan.description).toContain('It keeps every planned feature, may add features, and may move a feature onto another planned one (on) when the part was built on that one; once per fix round')
  })
})
