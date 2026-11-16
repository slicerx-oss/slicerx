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
import { amendBody, amendShapeProblem } from '../src/plan-amend'
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
    const out = await t.run('design.plan', { amends: 'plan_1', asked: 'add more pen cups' })
    expect(out.ok).not.toBe(false)
    expect(out.summary).toBe('The plan stays as approved; make the change the person asked for in the design, then add any new feature to the plan with amends and asked')
    expect(t.card.plans.get('plan_1')!.plan.features.map((f) => f.name)).toEqual(['Tray', 'Pen cups'])
  })

  // shaped like a live call: the person asked to angle three features back, and the plan came back with every feature
  // and a tilt on three of them, but no overall size
  const hall: PlanInput = {
    part: 'Exhibition hall model',
    units: 'mm',
    detail: 'display',
    scale: '1233',
    proportions: 'lookup: 269 m long, 28.2 m wide, four towers about 18.8 m tall, scaled 1:1233',
    curved: ['Base'],
    flat: ['Lower tier'],
    tiers: { 'Lower tier': ['Lower tier', 'Upper tier', 'Top tier'] },
    repeats: ['Towers'],
    features: [
      { name: 'Base', kind: 'loft', sizes: { length: 218, width: 23, height: 15, sections: 8 }, kinds: { sections: 'count' } },
      { name: 'Lower tier', kind: 'extrude', on: 'Base', sizes: { length: 120, width: 17, height: 4.5 } },
      { name: 'Upper tier', kind: 'extrude', on: 'Lower tier', sizes: { length: 100, width: 14, height: 3.5 } },
      { name: 'Top tier', kind: 'extrude', on: 'Upper tier', sizes: { length: 10, width: 13, height: 3 } },
      { name: 'Tower', kind: 'extrude', on: 'Upper tier', sizes: { diameter: 5.5, height: 15 } },
      { name: 'Tower array', kind: 'array', on: 'Upper tier', sizes: { count: 4, spacing: 14 }, kinds: { count: 'count' } },
      { name: 'Front block', kind: 'extrude', on: 'Base', sizes: { length: 20, width: 10, height: 3 } },
      { name: 'Back block', kind: 'extrude', on: 'Base', sizes: { length: 22, width: 12, height: 3 } },
      { name: 'Front post', kind: 'extrude', on: 'Base', sizes: { diameter: 1.6, height: 25 } },
      { name: 'Back post', kind: 'extrude', on: 'Base', sizes: { diameter: 1.6, height: 21 } },
    ],
    real: [
      { feature: 'Base', size: 'length', mm: 269000 },
      { feature: 'Base', size: 'width', mm: 28200 },
      { feature: 'Tower', size: 'height', mm: 18800 },
      { feature: 'Tower array', size: 'spacing', mm: 17262 },
      { feature: 'Lower tier', size: 'length', mm: 148000 },
      { feature: 'Upper tier', size: 'length', mm: 123000 },
      { feature: 'Top tier', size: 'length', mm: 12000 },
    ],
    overall: { x: 218, y: 23, z: 40 },
    assumptions: ['Front points toward +X, base bottom at z 0', 'One filament, no color', 'Railings, doors and windows are too small to print and are left out', 'Towers stand upright, not tilted'],
    questions: [],
  } as PlanInput
  const tilted = (p: PlanInput) => ({
    amends: 'plan_1',
    asked: 'Tilt the towers and posts back a few degrees.',
    part: p.part,
    units: p.units,
    features: p.features.map((f) =>
      ['Tower', 'Front post', 'Back post'].includes(f.name)
        ? { ...f, sizes: { ...f.sizes, tilt: 4 }, kinds: { tilt: 'angle' as const } }
        : f.name === 'Tower array'
          ? { ...f, sizes: { ...f.sizes, spacing: 18 } }
          : f,
    ),
    assumptions: ['Tilt 4 degrees toward the back (-X)'],
    questions: [],
  })
  /** design.plan as a call reaches it: read, then run. */
  const sent = (t: ReturnType<typeof tab>, input: unknown) => t.run('design.plan', input)

  it('keeps the approved overall size when an asked change with every feature leaves it out', async () => {
    const t = tab()
    await t.approve(hall)
    const out = await sent(t, tilted(hall))
    expect(t.cards).toEqual(['Plan'])
    expect(out.ok).not.toBe(false)
    expect(out.output as PlanAnswer).toMatchObject({ planId: 'plan_1', accepted: true, revision: 2 })
    const kept = t.card.plans.get('plan_1')!.plan
    expect(kept.overall).toEqual({ x: 218, y: 23, z: 40 })
    for (const name of ['Tower', 'Front post', 'Back post']) expect(kept.features.find((f) => f.name === name)).toMatchObject({ sizes: { tilt: 4 }, kinds: { tilt: 'angle' } })
    expect(kept.features.find((f) => f.name === 'Tower array')!.sizes['spacing']).toBe(18)
  })

  it('takes the overall size, rows of holes and open faces an asked change sends, and fills only those it leaves out', async () => {
    const t = tab()
    await t.approve(organizer)
    const body = { ...cupsAt(organizer, 26), amends: 'plan_1', asked: 'make the pen cups shorter' }
    const { overall: _o, ...noOverall } = body
    const was = t.card.plans.get('plan_1')!.plan
    expect(amendBody(was, noOverall as PlanInput).next.overall).toEqual({ x: 80, y: 50, z: 34 })
    expect(amendBody(was, { ...body, overall: { x: 80, y: 50, z: 30 } } as PlanInput).next.overall).toEqual({ x: 80, y: 50, z: 30 })
    // the plan has no holes or open faces, so there are none to fill
    expect(amendBody(was, body as PlanInput).next).not.toHaveProperty('holes')
    const out = await sent(t, { ...body, overall: { x: 80, y: 50, z: 30 } })
    expect(out.summary).toMatch(/Overall \w+ 34 mm to 30 mm/)
    // a plan with rows of holes and open faces: those left out are the plan's own, those sent stay as sent
    const holes = [{ name: 'Vent', diameter: 3, count: 4 }]
    const openFaces = [{ piece: 'Pen cups', faces: ['top' as const] }]
    const two = { ...organizer, holes, openFaces, planId: 'plan_2' } as PartPlan
    const sentTwo = cupsAt(organizer, 26)
    expect(amendBody(two, sentTwo).next).toMatchObject({ holes, openFaces })
    const wider = [{ name: 'Vent', diameter: 4, count: 4 }]
    expect(amendBody(two, { ...sentTwo, holes: wider }).next).toMatchObject({ holes: wider, openFaces })
  })

  it('still refuses an asked change that gives an overall size the plan does not have', async () => {
    const t = tab()
    const { overall: _o, ...bare } = organizer
    await t.approve(bare as PlanInput)
    await expect(sent(t, { ...cupsAt(bare as PlanInput, 26), overall: { x: 80, y: 50, z: 30 }, amends: 'plan_1', asked: 'make the pen cups shorter' })).rejects.toThrow('overall: an amend changes sizes and on only; leave out the overall size')
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
