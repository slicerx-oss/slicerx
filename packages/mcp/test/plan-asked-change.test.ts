// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A change the person asks for after a part is built (taller pen cups, an added drawer) goes into the approved plan
// with no card: their message is the go. design.plan with amends and asked takes the person's words, may add features
// (every planned feature stays, in order), and is not held to the build's one amend per fix round, so the additions
// stay tagged and design.check holds the part to them.
import type { Design as HostDesign, DesignHost } from '@slicerx/cad-history'
import type { PilotMachine } from '@slicerx/contracts'
import { toolSpec, type ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, type PartPlan } from '../src/design-check'
import { amendShapeProblem } from '../src/plan-amend'
import { PLAN_GO, type PlanAnswer, type PlanInput } from '../src/tab-tools'
import { createCardPlans, tabToolset } from '../src/toolset'

type Tri = [number[], number[], number[]]
function boxTris([x0, y0, z0]: number[], [x1, y1, z1]: number[]): Tri[] {
  const v = (i: number): number[] => [i & 1 ? x1! : x0!, i & 2 ? y1! : y0!, i & 4 ? z1! : z0!]
  const f = (a: number, b: number, c: number): Tri => [v(a), v(b), v(c)]
  return [f(0, 1, 5), f(0, 2, 3), f(0, 5, 4), f(0, 3, 1), f(2, 6, 7), f(4, 5, 7), f(2, 7, 3), f(4, 7, 6), f(0, 4, 6), f(0, 6, 2), f(1, 3, 7), f(1, 7, 5)]
}
const meshOf = (tris: readonly Tri[]) => ({ positions: tris.flat(2), indices: tris.flatMap((_, t) => [t * 3, t * 3 + 1, t * 3 + 2]) })
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** One closed 80 x 50 x 34 mm box design, d1. */
function boxHost(): DesignHost {
  const d = { id: 'd1', name: 'Hinged box', history: { version: 1, base: [], steps: [] }, transform: IDENTITY, parts: [{ name: 'Hinged box', slot: 0, ...meshOf(boxTris([0, 0, 0], [80, 50, 34])) }], status: [], madeBy: {}, redo: [] } as unknown as HostDesign
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

const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }

/** A desk organizer: a tray with three pen cups in a row. */
const organizer: PlanInput = {
  part: 'Desk organizer',
  units: 'mm',
  features: [
    { name: 'Tray', kind: 'extrude', sizes: { length: 80, width: 50, height: 12 } },
    { name: 'Pen cups', kind: 'extrude and array', sizes: { diameter: 20, height: 34, count: 3 }, kinds: { count: 'count' } },
  ],
  overall: { x: 80, y: 50, z: 34 },
  assumptions: [],
  questions: [],
}

const cupsAt = (p: PlanInput, h: number): PlanInput => ({ ...p, features: p.features.map((f) => (f.name === 'Pen cups' ? { ...f, sizes: { ...f.sizes, height: h } } : f)) })
const withDrawer: PlanInput = { ...organizer, features: [...organizer.features, { name: 'Drawer', kind: 'extrude', sizes: { length: 60, width: 40, height: 8 } }] }

function tab() {
  const card = createCardPlans(createPlanRegistry())
  const tools = tabToolset(boxHost(), card, { nozzleMm: () => machine.nozzle, newPlanId: () => 'plan_1' })
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
  const approve = async (input: PlanInput) => {
    const out = await run('design.plan', input)
    card.tieBuiltPart({ name: 'design.new', permission: 'write' }, {}, { summary: 'Started', output: { design: 'd1' } })
    return out
  }
  return { card, run, approve, cards }
}

describe('design.plan with amends for a change the person asked for', () => {
  it('describes asked: the person\'s words, no card, features may be added', () => {
    const plan = tabToolset(boxHost(), createCardPlans(createPlanRegistry()), { nozzleMm: () => machine.nozzle }).find((t) => t.name === 'design.plan')!
    const props = toolSpec(plan).inputSchema.properties as Record<string, { description?: string }>
    expect(props['asked']?.description).toMatch(/the person asked for/i)
    expect(props['asked']?.description).toMatch(/no card/i)
    expect(plan.description).toContain('with asked, the person\'s words for a change they asked for')
  })

  it('changes a size the person asked for with no card, and the plan takes it under its own planId', async () => {
    const t = tab()
    await t.approve(organizer)
    expect(t.cards).toEqual(['Plan'])
    const out = await t.run('design.plan', { ...cupsAt(organizer, 26), amends: 'plan_1', asked: 'make the pen cups shorter' })
    expect(t.cards).toEqual(['Plan'])
    expect(out.ok).not.toBe(false)
    expect(out.output as PlanAnswer).toMatchObject({ planId: 'plan_1', accepted: true, revision: 2 })
    expect(out.summary).toBe('Plan changed as asked (revision 2): Pen cups height 34 mm to 26 mm. Build to it as changed')
    expect(t.card.plans.get('plan_1')!.plan.features[1]!.sizes['height']).toBe(26)
  })

  it('adds a feature the person asked for, keeping every planned feature, and design.check then holds the part to it', async () => {
    const t = tab()
    await t.approve(organizer)
    const out = await t.run('design.plan', { ...withDrawer, amends: 'plan_1', asked: 'add a drawer under the tray' })
    expect(t.cards).toEqual(['Plan'])
    expect(out.summary).toBe('Plan changed as asked (revision 2): added Drawer. Build to it as changed')
    expect(t.card.plans.get('plan_1')!.plan.features.map((f) => f.name)).toEqual(['Tray', 'Pen cups', 'Drawer'])
    const check = await t.run('design.check', { planId: 'plan_1' })
    const items = (check.output as { items: { name: string; want: string }[] }).items
    expect(items.find((x) => x.name === 'feature count')?.want).toBe('3')
  })

  it('takes one asked change after another, unlike the build\'s one amend per fix round', async () => {
    const t = tab()
    await t.approve(organizer)
    await t.run('design.plan', { ...cupsAt(organizer, 26), amends: 'plan_1', asked: 'make the pen cups shorter' })
    const out = await t.run('design.plan', { ...cupsAt(withDrawer, 26), amends: 'plan_1', asked: 'add a drawer under the tray' })
    expect(out.output as PlanAnswer).toMatchObject({ accepted: true, revision: 3 })
    expect(t.cards).toEqual(['Plan'])
  })

  it('refuses an asked change that drops or renames a planned feature', async () => {
    const t = tab()
    await t.approve(organizer)
    await expect(t.run('design.plan', { ...organizer, features: organizer.features.slice(0, 1), amends: 'plan_1', asked: 'add a drawer' })).rejects.toThrow(/keeps every planned feature/)
  })

  it('changes how a planned feature is made when the person asks (a curved tray lofted, not extruded)', async () => {
    const t = tab()
    await t.approve(organizer)
    const lofted = { ...organizer, features: organizer.features.map((f) => (f.name === 'Tray' ? { ...f, kind: 'loft', sizes: { ...f.sizes, sections: 5 }, kinds: { sections: 'count' as const } } : f)) }
    const out = await t.run('design.plan', { ...lofted, amends: 'plan_1', asked: 'make the tray curved' })
    expect(t.cards).toEqual(['Plan'])
    expect(out.summary).toBe('Plan changed as asked (revision 2): Tray made by loft, not extrude. Build to it as changed')
    expect(t.card.plans.get('plan_1')!.plan.features[0]).toMatchObject({ name: 'Tray', kind: 'loft', sizes: { sections: 5 } })
  })

  it('takes the approved plan when an asked change sends only the person\'s words', async () => {
    const t = tab()
    await t.approve(organizer)
    const plan = tabToolset(boxHost(), t.card, { nozzleMm: () => machine.nozzle }).find((x) => x.name === 'design.plan')!
    const filled = plan.fill!({ amends: 'plan_1', asked: 'add more pen cups' }) as PlanInput
    expect(filled.features.map((f) => f.name)).toEqual(['Tray', 'Pen cups'])
    const out = await t.run('design.plan', filled)
    expect(out.ok).not.toBe(false)
    expect(out.summary).toBe('The plan stays as approved; make the change the person asked for in the design, then add any new feature to the plan with amends and asked')
    // a call with a plan body, or a first plan, is left as sent
    expect(plan.fill!({ part: 'Box' })).toEqual({ part: 'Box' })
  })

  it('lets a build amend add a feature too, on its card', async () => {
    const t = tab()
    await t.approve(organizer)
    const out = await t.run('design.plan', { ...withDrawer, amends: 'plan_1', reason: 'The tray needs a drawer to hold the cups up.' })
    expect(t.cards).toEqual(['Plan', 'Plan change'])
    expect(out.output as PlanAnswer).toMatchObject({ accepted: true, revision: 2 })
    expect(amendShapeProblem(organizer, withDrawer)).toBeNull()
    expect(amendShapeProblem(withDrawer, organizer)).toMatch(/keeps every planned feature/)
  })
})
