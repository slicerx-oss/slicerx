// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A follow-up is not told its change broke an item that was failing before it. design.check keeps the items each
// check failed (failing) and, when the person's change begins, the ones failing then (failingBefore): a check after
// the change that fails only on those says so in failedBefore and is never told to fix or undo the change, while one
// that breaks an item that passed still is. The bridge case replays a recorded chat: its first build stopped on a deck
// planned on the base, and every follow-up after it was told its change broke that.
import type { Design as HostDesign, DesignHost } from '@slicerx/cad-history'
import type { PilotMachine } from '@slicerx/contracts'
import type { ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, type PartPlan } from '../src/design-check'
import { createCardPlans, tabToolset } from '../src/toolset'
import { boxTris, IDENTITY, meshOf, STAND_PLAN, standHost } from './stand-host'

const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }
type Out = { pass: boolean; stop?: string; brokenByChange?: boolean; failedBefore?: string[]; items: { name: string; pass: boolean; got: string }[] }

const BROKE = 'so the change broke it'
const UNDO = 'undo the change that broke it'

function tab(host: DesignHost, plan: PartPlan, registry = createPlanRegistry()) {
  const card = createCardPlans(registry)
  const tools = tabToolset(host, card, { nozzleMm: () => machine.nozzle, newPlanId: () => plan.planId })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const ctx = { context: { project: 'creative', machine, objects: [] }, ask: async (q: { choices: { id: string }[] }) => ({ id: q.choices[0]!.id }) } as unknown as ToolContext
  const run = (name: string, input: unknown) => tool(name).run(tool(name).input.parse(input) as never, ctx)
  registry.put(plan, 'd1', 'card')
  const check = async () => {
    const r = await run('design.check', { planId: plan.planId })
    return { summary: r.summary, out: r.output as Out }
  }
  return { plans: registry, run, check }
}

/** The plan's last checks used its fix round, each failing on the top planned on the block. */
async function closed(t: ReturnType<typeof tab>) {
  await t.check()
  expect((await t.check()).out.stop).toMatch(/fix round is used/)
}

describe('a follow-up on a design whose check already failed', () => {
  it('that changes something else is not told its change broke the old failing item, however often it checks', async () => {
    const t = tab(standHost().host, STAND_PLAN)
    await closed(t)
    await t.run('design.plan', { amends: 'plan_1', asked: 'make the block a little longer', changes: [{ feature: 'Block', size: 'length', to: 42 }] })
    for (const _ of [1, 2, 3]) {
      const { summary, out } = await t.check()
      expect(out.pass).toBe(false)
      expect(out.stop).toBeUndefined()
      expect(out.brokenByChange).toBeUndefined()
      expect(out.failedBefore).toEqual(['stands on'])
      expect(summary).not.toContain(BROKE)
      expect(summary).not.toContain(UNDO)
      // the result lists the failed item as any failed check does
      expect(summary).toMatch(/^Stand \(d1, tied to the plan\): 1 of \d+ checks against plan plan_1 failed: stands on \(want .*, got Top stands on Block, but its base is 6 mm above its top[^)]*\) \(plan revision 2\)$/)
    }
  })

  it('that breaks an item that passed is still told so, then to undo it', async () => {
    const sized = { ...STAND_PLAN, overall: { x: 40, y: 20, z: 12 } } as PartPlan
    const t = tab(standHost().host, sized)
    await closed(t)
    // the change asks for a taller part than the one built: its overall size now fails, beside the old stands on
    await t.run('design.plan', { amends: 'plan_1', asked: 'make it 15 mm tall', changes: [{ feature: 'overall', size: 'z', to: 15 }] })
    const first = await t.check()
    expect(first.out.items.filter((i) => !i.pass).map((i) => i.name)).toEqual(['overall size', 'stands on'])
    expect(first.out.brokenByChange).toBe(true)
    expect(first.out.failedBefore).toBeUndefined()
    expect(first.summary).toContain(BROKE)
    expect((await t.check()).summary).toContain(UNDO)
  })

  it('reads the old failures from the check that used the fix round when a later request changed the part with no amend', async () => {
    const { host, design } = standHost()
    const t = tab(host, STAND_PLAN)
    await closed(t)
    // the next request builds a step on the part and checks: the plan reopens as a change after the build
    design.history = { ...design.history, steps: [...design.history.steps, { id: 's4', part: 0, transform: IDENTITY, params: { op: 'repair' } } as never] }
    const after = await t.check()
    expect(after.out.stop).toBeUndefined()
    expect(after.out.failedBefore).toEqual(['stands on'])
    expect(after.summary).not.toContain(BROKE)
  })

  it('after the project is opened again: the failing items come back with the plan, and the change is not blamed', async () => {
    const t1 = tab(standHost().host, STAND_PLAN)
    await t1.check()
    expect(t1.plans.get('plan_1')!.failing).toEqual(['stands on'])
    // a reopened project puts the plan back with its failed checks and failing items (app plan-state restorePlans)
    const registry = createPlanRegistry()
    const t2 = tab(standHost().host, STAND_PLAN, registry)
    registry.get('plan_1')!.failedChecks = 1
    registry.get('plan_1')!.failing = [...t1.plans.get('plan_1')!.failing!]
    await t2.run('design.plan', { amends: 'plan_1', asked: 'make the block a little longer', changes: [{ feature: 'Block', size: 'length', to: 42 }] })
    const { summary, out } = await t2.check()
    expect(out.failedBefore).toEqual(['stands on'])
    expect(summary).not.toContain(BROKE)
  })

  it('a pass in between empties what failed before: a later break is the change\'s', async () => {
    const t = tab(standHost().host, STAND_PLAN)
    await closed(t)
    // the person's change moves the top onto the stand, and it passes
    await t.run('design.plan', { amends: 'plan_1', asked: 'the top sits on the stand', features: STAND_PLAN.features.map((f) => (f.name === 'Top' ? { ...f, on: 'Stand' } : f)) })
    expect((await t.check()).out.pass).toBe(true)
    expect(t.plans.get('plan_1')!.failingBefore).toEqual([])
    // a later change puts it back on the block: that change broke it
    await t.run('design.plan', { amends: 'plan_1', asked: 'put the top on the block', features: STAND_PLAN.features })
    const broke = await t.check()
    expect(broke.out.brokenByChange).toBe(true)
    expect(broke.summary).toContain(BROKE)
  })
})

// The bridge chat recorded 2026-11-15, its names made plain: a base plate, piers on it and a deck carried by the piers
// but planned on the base plate. Its first build used the fix round on that link; the follow-up "Add a row of openings
// along both sides of the deck" sent the whole plan with amends and asked, with the openings added, cut them, and was
// told "the change broke it". A third request then moves the deck onto the piers, which an amend now takes.
describe('the recorded bridge follow-up, replayed', () => {
  const frame = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })
  const step = (id: string, feature: string, z: number, mm: number, operation = 'new') => ({ id, part: 0, feature, transform: IDENTITY, params: { op: 'shape.extrude', frame: frame(z), shape: { type: 'rectangle', widthMm: 100, heightMm: 16 }, placement: { center: [50, 8] }, spec: { distanceMm: mm, operation } } })
  function bridge(): { host: DesignHost; design: HostDesign } {
    const design = {
      id: 'd1',
      name: 'Bridge',
      history: { version: 1, base: [], steps: [step('s1', 'Base plate', 0, 2), step('s2', 'Piers', 2, 4.5), step('s3', 'Deck', 6.4, 1)] },
      transform: IDENTITY,
      parts: [{ name: 'Bridge', slot: 0, ...meshOf(boxTris([0, 0, 0], [100, 16, 7.4])) }],
      status: [],
      madeBy: {},
      redo: [],
    } as unknown as HostDesign
    const host = { get: () => design, list: () => [design], create: async () => Promise.reject(new Error('not here')), add: async () => Promise.reject(new Error('not here')), replay: async () => {}, call: async (op: string) => (op === 'info' ? { watertight: true } : Promise.reject(new Error('no hole there'))) } as unknown as DesignHost
    return { host, design }
  }
  const features = [
    { name: 'Base plate', kind: 'extrude', sizes: { length: 100, width: 16, thickness: 2 } },
    { name: 'Deck', kind: 'extrude', on: 'Base plate', sizes: { length: 100, width: 2.8, thickness: 1, 'height above base': 5.4 } },
    { name: 'Piers', kind: 'extrude', on: 'Base plate', sizes: { width_x: 5, width_y: 7, height: 4.5 } },
  ]
  const plan = { planId: 'plan_1', part: 'Bridge', units: 'mm', detail: 'display', features, assumptions: [], questions: [] } as unknown as PartPlan

  it('the openings are no longer blamed for the deck link, and moving the deck onto the piers clears it', async () => {
    const { host, design } = bridge()
    const t = tab(host, plan)
    const first = await t.check()
    expect(first.out.items.find((i) => i.name === 'stands on')!.got).toMatch(/^Deck stands on Base plate, but its base is 4\.4 mm above its top/)
    expect((await t.check()).out.stop).toMatch(/fix round is used/)
    // the follow-up's request as recorded: the whole plan with amends and asked, the openings added
    const asked = await t.run('design.plan', {
      part: 'Bridge',
      units: 'mm',
      amends: 'plan_1',
      asked: 'Add a row of openings along both sides of the deck.',
      assumptions: ['Openings are 3 mm long, 2.4 mm tall, cut 1 mm deep into each side of the deck, 6 mm apart, 12 per side'],
      features: [...features, { name: 'Deck openings', kind: 'cut', on: 'Deck', sizes: { count: 24, width: 3, height: 2.4, depth: 1 }, kinds: { count: 'count' } }],
      questions: [],
    })
    expect(asked.summary).toBe('Plan changed as asked (revision 2): added Deck openings. Build to it as changed')
    design.history = { ...design.history, steps: [...design.history.steps, step('s4', 'Deck openings', 6.4, 1, 'cut') as never] }
    const after = await t.check()
    expect(after.out.failedBefore).toEqual(['stands on'])
    expect(after.out.brokenByChange).toBeUndefined()
    expect(after.summary).not.toContain(BROKE)
    // the person then says the deck rests on the piers: the link changes, and the check passes
    await t.run('design.plan', { amends: 'plan_1', asked: 'The deck rests on the piers.', features: [...features.map((f) => (f.name === 'Deck' ? { ...f, on: 'Piers' } : f)), { name: 'Deck openings', kind: 'cut', on: 'Deck', sizes: { count: 24, width: 3, height: 2.4, depth: 1 }, kinds: { count: 'count' } }] })
    const fixed = await t.check()
    expect(fixed.out.items.find((i) => i.name === 'stands on')!.pass).toBe(true)
  })
})
