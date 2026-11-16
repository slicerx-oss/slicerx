// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A build's amend made in the fix round adds no feature. The fix round is for the items the check failed: a feature
// added then is one more the next check needs a step for, which nothing in the round builds, so the check after it
// failed its feature count (a ship's fix round added "Mainmast base" when the mainmast itself had to stand on the poop
// deck, and its second check failed 10 of 11 features). The refusal says so and names the move onto another feature
// (its on) instead. Before the first failed check, and for a change the person asked for, features are added as before.
import type { PilotMachine } from '@slicerx/contracts'
import type { ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, fixRoundIsOpen, type PartPlan } from '../src/design-check'
import { FIX_ROUND_ADDS } from '../src/plan-amend'
import { createCardPlans, designToolset, tabToolset } from '../src/toolset'
import type { DesignHost } from '@slicerx/cad-history'
import { STAND_PLAN, standHost } from './stand-host'

const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }
const base = { name: 'Top base', kind: 'extrude', on: 'Stand', sizes: { height: 2 } }

function tab() {
  const plans = createPlanRegistry()
  const tools = tabToolset(standHost().host, createCardPlans(plans), { nozzleMm: () => machine.nozzle, newPlanId: () => 'plan_1' })
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
  return { plans, run, cards, check: () => run('design.check', { planId: 'plan_1' }) }
}

describe("a build's amend in the fix round", () => {
  it('is refused when it adds a feature, word for word, and the plan, its revision and its card stay as they were', async () => {
    const { plans, run, cards, check } = tab()
    const first = await check()
    expect(first.summary).toContain('the plan has one fix round, and it is open')
    expect(fixRoundIsOpen(plans.get('plan_1')!)).toBe(true)
    await expect(run('design.plan', { amends: 'plan_1', reason: 'The top stands on its own base.', add: [base] })).rejects.toThrow(
      "add: the plan's fix round is open, and an amend in it adds no feature, since Top base would be one more feature the check needs a step tagged with its name for; fix the failed items on the part as planned, and for a planned feature built on another planned one, send the features with its on changed and no add",
    )
    expect(cards).toEqual([])
    expect(plans.get('plan_1')!.revision).toBeUndefined()
    expect(plans.get('plan_1')!.plan.features.map((f) => f.name)).toEqual(['Block', 'Stand', 'Top'])
  })

  it('names every feature it adds in one refusal, beside any other problem with it', async () => {
    const { run, check } = tab()
    await check()
    const two = [base, { ...base, name: 'Stand foot', on: 'Block' }]
    await expect(run('design.plan', { amends: 'plan_1', reason: 'Two more parts.', add: two })).rejects.toThrow(FIX_ROUND_ADDS(['Top base', 'Stand foot']))
    expect(FIX_ROUND_ADDS(['Top base', 'Stand foot'])).toContain('since Top base and Stand foot would be more features the check needs a step tagged with its name for')
    await expect(run('design.plan', { amends: 'plan_1', reason: 'A base, and a size that is not there.', add: [base], changes: [{ feature: 'Top', size: 'depth', to: 3 }] })).rejects.toThrow(
      /changes: Top has no size named depth; change one of its sizes \(width, height\)\. add: the plan's fix round is open/,
    )
  })

  it('leaves the amend of the round unused: the move onto another feature it names is taken next, and the check passes', async () => {
    const { run, cards, check } = tab()
    await check()
    await expect(run('design.plan', { amends: 'plan_1', reason: 'The top stands on its own base.', add: [base] })).rejects.toThrow("add: the plan's fix round is open")
    const onStand = STAND_PLAN.features.map((f) => (f.name === 'Top' ? { ...f, on: 'Stand' } : f))
    const r = await run('design.plan', { amends: 'plan_1', reason: 'The top was built on the stand, so it stands on the stand.', features: onStand })
    expect(r.summary).toBe('Plan changed (revision 2): Top on Stand, not Block. Build to it as changed')
    expect(cards).toEqual(['Plan change'])
    const second = await check()
    expect(second.summary).toMatch(/matches plan plan_1: all \d+ checks pass/)
  })

  it('still takes a size change in the round, with no feature added', async () => {
    const { run, check } = tab()
    await check()
    const r = await run('design.plan', { amends: 'plan_1', reason: 'The top is a little wider.', changes: [{ feature: 'Top', size: 'width', to: 22 }] })
    expect(r.ok).not.toBe(false)
    expect(r.summary).toMatch(/^Plan changed \(revision 2\): Top width 20 mm to 22 mm/)
  })
})

describe('outside the fix round, features are added as before', () => {
  it("takes a build's amend that adds a feature before any check has failed", async () => {
    const { plans, run } = tab()
    expect(fixRoundIsOpen(plans.get('plan_1')!)).toBe(false)
    const r = await run('design.plan', { amends: 'plan_1', reason: 'The top stands on its own base.', add: [base] })
    expect(r.summary).toBe('Plan changed (revision 2): added Top base. Build to it as changed')
  })

  it('takes a change the person asked for that adds a feature, in the fix round too', async () => {
    const { plans, run, check } = tab()
    await check()
    expect(fixRoundIsOpen(plans.get('plan_1')!)).toBe(true)
    const r = await run('design.plan', { amends: 'plan_1', asked: 'give the top a base', add: [base] })
    expect(r.summary).toBe('Plan changed as asked (revision 2): added Top base. Build to it as changed')
  })
})

describe('fixRoundIsOpen', () => {
  const entry = (o: Partial<Parameters<typeof fixRoundIsOpen>[0]>) => fixRoundIsOpen(o)
  it('is open from the first failed check until the check that ends the round, and never after a pass or a change the person asked for', () => {
    expect(entry({})).toBe(false)
    expect(entry({ failedChecks: 1 })).toBe(true)
    expect(entry({ failedChecks: 2 })).toBe(false)
    expect(entry({ failedChecks: 1, closed: { summary: '', output: {} } })).toBe(false)
    expect(entry({ failedChecks: 1, passed: true })).toBe(false)
    expect(entry({ failedChecks: 1, passedOnce: true })).toBe(false)
    expect(entry({ failedChecks: 1, followUp: true })).toBe(false)
  })

  it('the plan registry opens it on a failed check and the stop result closes it', () => {
    const plans = createPlanRegistry()
    plans.put(STAND_PLAN as PartPlan, 'd1', 'card')
    plans.checked('plan_1', false, [], ['stands on'])
    expect(fixRoundIsOpen(plans.get('plan_1')!)).toBe(true)
    plans.checked('plan_1', false, [], ['stands on'])
    plans.close('plan_1', { summary: 'stop', output: {} })
    expect(fixRoundIsOpen(plans.get('plan_1')!)).toBe(false)
  })
})

describe("a client's own plan amended with design.put_plan in the fix round", () => {
  const client = () => {
    const plans = createPlanRegistry()
    const put = designToolset({} as DesignHost, {}, { plans }).find((t) => t.name === 'design.put_plan')!
    const run = (input: unknown) => put.run(put.input.parse(input) as never, {} as ToolContext)
    plans.put(STAND_PLAN, 'd1', 'client')
    return { plans, run }
  }
  const wider = (plan: PartPlan) => plan.features.map((f) => (f.name === 'Top' ? { ...f, sizes: { ...f.sizes, width: 22 } } : f))

  it('is refused when it adds a feature, with the same words as the card', async () => {
    const { plans, run } = client()
    plans.checked('plan_1', false, [], ['stands on'])
    expect(fixRoundIsOpen(plans.get('plan_1')!)).toBe(true)
    const plan = { ...STAND_PLAN, features: [...wider(STAND_PLAN), base] }
    await expect(run({ plan, amends: 'plan_1', reason: 'The top stands on its own base.' })).rejects.toThrow(FIX_ROUND_ADDS(['Top base']))
    expect(plans.get('plan_1')!.plan.features.map((f) => f.name)).toEqual(['Block', 'Stand', 'Top'])
  })

  it('still adds a feature before any check has failed, and takes a size change in the round', async () => {
    const before = client()
    const added = await before.run({ plan: { ...STAND_PLAN, features: [...wider(STAND_PLAN), base] }, amends: 'plan_1', reason: 'The top stands on its own base.' })
    expect(added.summary).toMatch(/^Changed plan plan_1/)
    const inRound = client()
    inRound.plans.checked('plan_1', false, [], ['stands on'])
    const sized = await inRound.run({ plan: { ...STAND_PLAN, features: wider(STAND_PLAN) }, amends: 'plan_1', reason: 'The top is a little wider.' })
    expect(sized.summary).toMatch(/^Changed plan plan_1/)
  })
})
