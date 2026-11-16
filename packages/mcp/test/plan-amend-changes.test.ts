// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An amend sends only what changes: each size as {feature, size, to} in changes, and new features in add. The part,
// units, features, assumptions and questions it leaves out are the approved plan's, and the changes apply onto it. A
// plan field it sends that an amend does not keep is left as approved and named in the result. The whole plan, sent as
// before, still amends it.
import type { Design as HostDesign, DesignHost } from '@slicerx/cad-history'
import type { PilotMachine } from '@slicerx/contracts'
import { toolSpec, type ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry } from '../src/design-check'
import { PLAN_GO, type PlanAnswer, type PlanInput } from '../src/tab-tools'
import { createCardPlans, tabToolset } from '../src/toolset'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }

function host(): DesignHost {
  const d = { id: 'd1', name: 'Stone tower', history: { version: 1, base: [], steps: [] }, transform: IDENTITY, parts: [{ name: 'Stone tower', slot: 0, positions: [], indices: [] }], status: [], madeBy: {}, redo: [] } as unknown as HostDesign
  return { get: () => d, list: () => [d] } as unknown as DesignHost
}

/** A stone tower on a base, with a row of window holes. */
const tower: PlanInput = {
  part: 'Stone tower',
  units: 'mm',
  features: [
    { name: 'Base', kind: 'extrude', sizes: { width: 40, depth: 40, height: 8 } },
    { name: 'Tower', kind: 'extrude', on: 'Base', sizes: { width: 30, depth: 30, height: 90 } },
  ],
  overall: { x: 40, y: 40, z: 98 },
  holes: [{ name: 'Window', diameter: 4, count: 6 }],
  assumptions: ['The tower stands centered on its base.'],
  questions: [],
}

/** The tab's design.plan over d1 with the tower approved and built, every card answered Go. */
async function built() {
  const card = createCardPlans(createPlanRegistry())
  const tools = tabToolset(host(), card, { nozzleMm: () => machine.nozzle, newPlanId: () => 'plan_1' })
  const tool = tools.find((t) => t.name === 'design.plan')!
  const cards: string[] = []
  const ctx = {
    context: { project: 'creative', machine, objects: [] },
    confirmsPlan: () => true,
    ask: async (q: { title: string; choices: { id: string }[] }) => {
      cards.push(q.title)
      return { id: q.choices.find((c) => c.id.startsWith(`${PLAN_GO}:`))!.id }
    },
  } as unknown as ToolContext
  const run = (input: unknown) => tool.run(tool.input.parse(input) as never, ctx)
  await run(tower)
  card.tieBuiltPart({ name: 'design.new', permission: 'write' }, {}, { summary: 'Started', output: { design: 'd1' } })
  return { card, tool, run, cards, plan: () => card.plans.get('plan_1')!.plan }
}

describe('design.plan with amends and changes', () => {
  it('takes an amend of changes only, onto the approved plan', async () => {
    const t = await built()
    const out = await t.run({ amends: 'plan_1', reason: 'The tower needs room for its roof.', changes: [{ feature: 'Tower', size: 'height', to: 84 }, { feature: 'overall', size: 'z', to: 92 }, { feature: 'Window', size: 'diameter', to: 4.5 }] })
    expect(t.cards).toEqual(['Plan', 'Plan change'])
    expect(out.summary).toBe('Plan changed (revision 2): Tower height 90 mm to 84 mm, Overall height 98 mm to 92 mm, Window diameter 4 mm to 4.5 mm. Build to it as changed')
    expect((out.output as PlanAnswer).ignored).toBeUndefined()
    expect(t.plan()).toMatchObject({ part: 'Stone tower', units: 'mm', overall: { x: 40, y: 40, z: 92 }, holes: [{ name: 'Window', diameter: 4.5, count: 6 }], assumptions: tower.assumptions, questions: [] })
    expect(t.plan().features.map((f) => [f.name, f.sizes['height']])).toEqual([['Base', 8], ['Tower', 84]])
  })

  it('takes a feature added with add, after the planned ones, on a change the person asked for', async () => {
    const t = await built()
    const out = await t.run({ amends: 'plan_1', asked: 'put a parapet on top', add: [{ name: 'Parapet', kind: 'extrude', on: 'Tower', sizes: { width: 32, depth: 32, height: 4 } }], changes: [{ feature: 'overall', size: 'height', to: 102 }] })
    expect(out.summary).toBe('Plan changed as asked (revision 2): Overall height 98 mm to 102 mm, added Parapet. Build to it as changed')
    expect(t.plan().features.map((f) => f.name)).toEqual(['Base', 'Tower', 'Parapet'])
  })

  it('names a plan field sent with the amend, keeps it as approved, and still changes the sizes', async () => {
    const t = await built()
    const out = await t.run({ amends: 'plan_1', reason: 'A shorter tower.', part: 'Tall tower', colors: { Tower: 'gray' }, proportions: 'stated: about 1 m tall', changes: [{ feature: 'Tower', size: 'height', to: 84 }] })
    expect(out.summary).toBe('Plan changed (revision 2): Tower height 90 mm to 84 mm. Build to it as changed. Ignored proportions, colors and part: an amend changes sizes and on only, so the plan keeps them as approved')
    expect((out.output as PlanAnswer).ignored).toEqual(['proportions', 'colors', 'part'])
    expect(t.plan()).not.toHaveProperty('colors')
    expect(t.plan().part).toBe('Stone tower')
  })

  it('still takes the whole plan sent as before, with changes on top of it', async () => {
    const t = await built()
    const taller = { ...tower, features: tower.features.map((f) => (f.name === 'Tower' ? { ...f, sizes: { ...f.sizes, height: 96 } } : f)) }
    const out = await t.run({ ...taller, amends: 'plan_1', reason: 'A taller tower.', changes: [{ feature: 'overall', size: 'z', to: 104 }] })
    expect(out.summary).toBe('Plan changed (revision 2): Tower height 90 mm to 96 mm, Overall height 98 mm to 104 mm. Build to it as changed')
  })

  it('refuses a change that sets no planned size, naming each one, with the shape problems', async () => {
    const t = await built()
    await expect(t.run({ amends: 'plan_1', reason: 'Wider.', changes: [{ feature: 'Tower', size: 'radius', to: 16 }, { feature: 'Roof', size: 'height', to: 6 }] })).rejects.toThrow(
      'changes: Tower has no size named radius; change one of its sizes (width, depth, height). changes: Roof is not a planned feature, the overall size or a row of holes; name one the plan has (Base, Tower, overall, Window)',
    )
    await expect(t.run({ amends: 'plan_1', reason: 'Inches.', units: 'in', changes: [{ feature: 'Tower', size: 'height', to: 3 }] })).rejects.toThrow('units: an amend changes sizes and on only; the plan stays in mm')
    // a change to the value the plan has already is no change
    await expect(t.run({ amends: 'plan_1', reason: 'Same.', changes: [{ feature: 'Tower', size: 'height', to: 90 }] })).rejects.toThrow('amends: no size differs from the approved plan plan_1')
    expect(t.plan()).toMatchObject({ features: tower.features })
  })

  it('refuses changes or add on a first plan, and a first plan with no part, units or features', async () => {
    const t = await built()
    await expect(t.run({ ...tower, part: 'Gate house', changes: [{ feature: 'Tower', size: 'height', to: 84 }] })).rejects.toThrow('changes: only with amends, to change a plan already built')
    await expect(t.run({ ...tower, part: 'Gate house', add: [{ name: 'Roof', sizes: { height: 4 } }] })).rejects.toThrow('add: only with amends, to change a plan already built')
    const { part: _p, units: _u, features: _f, assumptions: _a, questions: _q, ...bare } = tower
    const read = t.tool.input.safeParse(bare)
    expect(read.success).toBe(false)
    expect(read.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([
      'part: Invalid input: expected string, received undefined',
      'units: Invalid option: expected one of "mm"|"in"',
      'features: Invalid input: expected array, received undefined',
    ])
  })

  it('shows the model changes and add, with part, units and features no longer required', async () => {
    const t = await built()
    const spec = toolSpec(t.tool) as unknown as { inputSchema: { required?: string[]; properties: Record<string, { description?: string }> } }
    expect(spec.inputSchema.required ?? []).not.toContain('part')
    expect(spec.inputSchema.required ?? []).not.toContain('features')
    expect(spec.inputSchema.properties['changes']!.description).toMatch(/^Only with amends: each size to change/)
    expect(spec.inputSchema.properties['add']!.description).toMatch(/^Only with amends: features to add/)
  })
})
