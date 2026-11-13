// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A build that finds an approved size it cannot keep changes the plan with the person's Go: design.plan with amends
// shows the changed sizes beside the old ones on a card of their own, raised to the printer's floors as a new plan's
// are, and keeps the plan's planId, design tie and fix round; design.put_plan with amends does the same for a client's
// plan with no card. An amend changes sizes only, once per fix round, and never after the stop result.
import type { Design as HostDesign, DesignHost } from '@slicerx/cad-history'
import type { PilotMachine } from '@slicerx/contracts'
import { toolSpec, type ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, type PartPlan } from '../src/design-check'
import { amendChanges, amendProblem, amendShapeProblem, changeText } from '../src/plan-amend'
import { amendId, PLAN_CHANGE, PLAN_GO, planChoiceId, type PlanAnswer, type PlanInput } from '../src/tab-tools'
import { createCardPlans, designToolset, tabToolset } from '../src/toolset'

type Tri = [number[], number[], number[]]
function boxTris([x0, y0, z0]: number[], [x1, y1, z1]: number[]): Tri[] {
  const v = (i: number): number[] => [i & 1 ? x1! : x0!, i & 2 ? y1! : y0!, i & 4 ? z1! : z0!]
  const f = (a: number, b: number, c: number): Tri => [v(a), v(b), v(c)]
  return [f(0, 1, 5), f(0, 2, 3), f(0, 5, 4), f(0, 3, 1), f(2, 6, 7), f(4, 5, 7), f(2, 7, 3), f(4, 7, 6), f(0, 4, 6), f(0, 6, 2), f(1, 3, 7), f(1, 7, 5)]
}
const meshOf = (tris: readonly Tri[]) => ({ positions: tris.flat(2), indices: tris.flatMap((_, t) => [t * 3, t * 3 + 1, t * 3 + 2]) })
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** One closed 80 x 50 x 34 mm box design, d1: the hinged box as built, 34 mm tall where its plan said 30. */
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

/** A hinged box laid apart: base, lid and a pin beside them, 30 mm tall overall, with a 0.3 mm hinge clearance. */
const box: PlanInput = {
  part: 'Hinged box',
  units: 'mm',
  features: [
    { name: 'Base', kind: 'extrude', sizes: { height: 30, wall: 2 } },
    { name: 'Hinge', kind: 'hole', sizes: { hinge_pin_diameter: 2, hinge_clearance: 0.3 } },
  ],
  overall: { x: 80, y: 50, z: 30 },
  assumptions: ['The lid prints laid apart beside the box.'],
  questions: [],
}

/** A chain of 6 links that print together, with a 0.5 mm link gap. */
const chain: PlanInput = {
  part: 'Chain',
  units: 'mm',
  features: [
    { name: 'Link', kind: 'extrude', sizes: { length: 15, width: 8 } },
    { name: 'Links', kind: 'pattern', sizes: { link_count: 6, link_gap: 0.5 } },
  ],
  assumptions: ['Links are 15 mm long.'],
  questions: [],
}

/** The tab's tools over the box design: answers each card with `answers` in turn (go, or not yet), recording what each showed. */
function tab(answers: ('go' | 'not yet')[] = [], newPlanId: () => string = () => 'plan_1') {
  const card = createCardPlans(createPlanRegistry())
  const tools = tabToolset(boxHost(), card, { nozzleMm: () => machine.nozzle, newPlanId })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const cards: { title: string; question: string; id: string; plan: PartPlan | null }[] = []
  // cards the person answers: ones that wait for their Go (sizes that fit something)
  const ctx = {
    context: { project: 'creative', machine, objects: [] },
    confirmsPlan: () => true,
    ask: async (q: { title: string; question: string; choices: { id: string }[] }) => {
      const id = q.choices[0]!.id.slice(PLAN_GO.length + 1)
      cards.push({ title: q.title, question: q.question, id, plan: card.planById(id) })
      return { id: (answers.shift() ?? 'go') === 'go' ? q.choices[0]!.id : q.choices[1]!.id }
    },
  } as unknown as ToolContext
  const run = (name: string, input: unknown) => tool(name).run(tool(name).input.parse(input) as never, ctx)
  /** design.plan approved with Go, its part built as d1 and tied to the plan as the tab ties it. */
  const approve = async (input: PlanInput) => {
    const out = await run('design.plan', input)
    card.tieBuiltPart({ name: 'design.new', permission: 'write' }, {}, { summary: 'Started', output: { design: 'd1' } })
    return out
  }
  const check = async () => {
    const out = await run('design.check', { planId: 'plan_1' })
    const items = (out.output as { items: { name: string; got: string; pass: boolean }[] }).items
    return { out, item: (name: string) => items.find((i) => i.name === name) }
  }
  return { card, run, approve, check, cards }
}

const taller = (p: PlanInput, z: number): PlanInput => ({ ...p, features: p.features.map((f) => (f.name === 'Base' ? { ...f, sizes: { ...f.sizes, height: z } } : f)), overall: { ...p.overall!, z } })

describe('design.plan with amends', () => {
  it('tells the model a first plan takes no reason: amends and reason are for changing an approved plan', () => {
    const plan = tabToolset(boxHost(), createCardPlans(createPlanRegistry()), { nozzleMm: () => machine.nozzle }).find((t) => t.name === 'design.plan')!
    expect(plan.version).toBe('1.12.0')
    const props = toolSpec(plan).inputSchema.properties as Record<string, { description?: string }>
    expect(props['amends']?.description).toMatch(/only to change a plan the person approved/i)
    expect(props['reason']?.description).toMatch(/only with amends/i)
    expect(props['reason']?.description).toMatch(/a first plan takes none/i)
  })

  it('changes a built part plan to the height the build made with the person\'s Go, keeping its planId, tie and fix round', async () => {
    const t = tab()
    await t.approve(box)
    const first = await t.check()
    expect(first.item('overall size')?.pass).toBe(false)
    expect(t.card.plans.get('plan_1')?.failedChecks).toBe(1)

    const out = await t.run('design.plan', { ...taller(box, 34), amends: 'plan_1', reason: 'The lid adds 4 mm over the rim, so the box closes at 34 mm.' })
    // the card is the amend's own, titled as a change, with the new sizes; the approved plan waits unchanged behind it
    expect(t.cards.at(-1)).toMatchObject({ title: 'Plan change', question: 'Change the plan for Hinged box?', id: amendId('plan_1', 2) })
    expect(t.cards.at(-1)!.plan?.overall?.z).toBe(34)
    expect(t.card.amendOf(amendId('plan_1', 2))).toMatchObject({ planId: 'plan_1', why: 'The lid adds 4 mm over the rim, so the box closes at 34 mm.', revision: 2 })
    expect(t.card.amendOf(amendId('plan_1', 2))!.was.overall?.z).toBe(30)

    const answer = out.output as PlanAnswer
    expect(answer).toMatchObject({ planId: 'plan_1', accepted: true, revision: 2 })
    expect(answer.changes).toEqual([
      { where: 'feature', feature: 'Base', size: 'height', from: 30, to: 34 },
      { where: 'overall', feature: null, size: 'z', from: 30, to: 34 },
    ])
    expect(out.summary).toBe('Plan changed (revision 2): Base height 30 mm to 34 mm, Overall height 30 mm to 34 mm. Build to it as changed')
    const kept = t.card.plans.get('plan_1')!
    expect(kept).toMatchObject({ design: 'd1', failedChecks: 1, revision: 2, amendWhy: 'The lid adds 4 mm over the rim, so the box closes at 34 mm.' })
    expect(kept.plan.planId).toBe('plan_1')
    expect(kept.plan.assumptions).toEqual(box.assumptions)

    const second = await t.check()
    expect(second.item('overall size')?.pass).toBe(true)
    expect(second.out.output).toMatchObject({ planId: 'plan_1', revision: 2 })
    expect(second.out.summary).toContain('(plan revision 2)')
  })

  it('leaves the plan as approved on Not yet, and the check fails as before', async () => {
    const t = tab(['go', 'not yet'])
    await t.approve(box)
    await t.check()
    const out = await t.run('design.plan', { ...taller(box, 34), amends: 'plan_1', reason: 'The box closes at 34 mm.' })
    expect(out.ok).toBe(false)
    expect(out.summary).toBe('Not approved; the plan stays as approved. Build to it, or stop and tell the person what is off')
    expect(out.output).toEqual({ planId: 'plan_1', accepted: false })
    expect(t.card.plans.get('plan_1')).toMatchObject({ failedChecks: 1 })
    expect(t.card.plans.get('plan_1')!.revision).toBeUndefined()
    expect(t.card.planById('plan_1')!.overall?.z).toBe(30)
    expect((await t.check()).item('overall size')?.pass).toBe(false)
  })

  it('raises an amended print-in-place gap under the printer\'s limit, and the check holds the raised gap', async () => {
    const t = tab()
    await t.approve(chain)
    const asked = { ...chain, features: chain.features.map((f) => (f.name === 'Links' ? { ...f, sizes: { ...f.sizes, link_gap: 0.3 } } : f)), amends: 'plan_1', reason: 'A tighter gap keeps the links from rattling.' }
    const out = await t.run('design.plan', asked)
    // the card shows 0.4 mm, the limit above or below on a 0.4 mm nozzle in PLA, with its line first among the assumptions
    const shown = t.cards.at(-1)!.plan!
    expect(shown.features[1]!.sizes['link_gap']).toBe(0.4)
    expect(shown.assumptions[0]).toBe('Links link gap raised from 0.3 mm to 0.4 mm on each side, the smallest gap for parts printed in place with a 0.4 mm nozzle in PLA.')
    const answer = out.output as PlanAnswer
    expect(answer.changes).toEqual([{ where: 'feature', feature: 'Links', size: 'link_gap', from: 0.5, to: 0.4 }])
    expect(answer.raised).toEqual([{ feature: 'Links', size: 'link_gap', from: 0.3, to: 0.4, why: 'the smallest gap for parts printed in place with a 0.4 mm nozzle in PLA' }])
    expect(out.summary).toContain('The card raised Links link gap to 0.4 mm on each side')
    const { item } = await t.check()
    expect(item('planned gaps')).toMatchObject({ got: 'link_gap 0.4 mm (vertical)', pass: true })
  })

  it('changes nothing when every asked size is raised back to what the plan has', async () => {
    const t = tab()
    await t.approve({ ...chain, features: chain.features.map((f) => (f.name === 'Links' ? { ...f, sizes: { ...f.sizes, link_gap: 0.4 } } : f)) })
    const out = await t.run('design.plan', { ...chain, features: chain.features.map((f) => (f.name === 'Links' ? { ...f, sizes: { ...f.sizes, link_gap: 0.2 } } : f)), amends: 'plan_1', reason: 'Tighter links.' })
    expect(out.ok).toBe(false)
    expect(out.summary).toBe('Nothing changed: Links link gap stays 0.4 mm on each side, the smallest gap for parts printed in place with a 0.4 mm nozzle in PLA. Build to the plan as approved')
    expect(t.cards).toHaveLength(1)
    expect(t.card.plans.get('plan_1')!.revision).toBeUndefined()
  })

  it('takes one amend per fix round, and none after the stop result', async () => {
    const t = tab()
    await t.approve(box)
    // before any check: one amend, then no other until a check fails
    await t.run('design.plan', { ...taller(box, 32), amends: 'plan_1', reason: 'The rim is 2 mm taller.' })
    await expect(t.run('design.plan', { ...taller(box, 33), amends: 'plan_1', reason: 'Again.' })).rejects.toThrow('amends: the plan was changed once already since its last failed check; build to it as changed')
    // the check fails at 32 mm: one more amend is taken, and it buys no second round
    expect((await t.check()).item('overall size')?.pass).toBe(false)
    await t.run('design.plan', { ...taller(box, 33), amends: 'plan_1', reason: 'The lid adds a millimeter more.' })
    expect(t.card.plans.get('plan_1')).toMatchObject({ failedChecks: 1, revision: 3 })
    const stopped = await t.check()
    expect(stopped.out.output).toHaveProperty('stop')
    await expect(t.run('design.plan', { ...taller(box, 34), amends: 'plan_1', reason: 'The box closes at 34 mm.' })).rejects.toThrow('amends: the plan has used its fix round; stop and tell the person exactly what is off')
  })

  it('refuses an amend without a reason, of a part not built yet, of no such plan, or that drops a feature', async () => {
    const t = tab()
    await t.run('design.plan', box)
    await expect(t.run('design.plan', { ...taller(box, 34), amends: 'plan_1', reason: 'Taller.' })).rejects.toThrow("amends: the plan's part is not built yet; build to the plan, or make a new plan")
    t.card.tieBuiltPart({ name: 'design.new', permission: 'write' }, {}, { summary: 'Started', output: { design: 'd1' } })
    await expect(t.run('design.plan', { ...taller(box, 34), amends: 'plan_1' })).rejects.toThrow('reason: say why the build changes the plan')
    await expect(t.run('design.plan', { ...taller(box, 34), amends: 'plan_1', reason: '   ' })).rejects.toThrow('reason: say why the build changes the plan')
    await expect(t.run('design.plan', { ...taller(box, 34), reason: 'Taller.' })).rejects.toThrow('reason: give a reason only with amends')
    await expect(t.run('design.plan', { ...taller(box, 34), amends: 'plan_9', reason: 'Taller.' })).rejects.toThrow('amends: there is no plan the person approved with planId plan_9')
    await expect(t.run('design.plan', { ...box, part: 'Hinged chest', amends: 'plan_1', reason: 'Renamed.' })).rejects.toThrow('part: an amend changes sizes only; the part stays "Hinged box"')
    // a planned feature dropped is refused; one added is taken (plan-asked-change.test.ts)
    const fewer = { ...box, features: box.features.slice(1), amends: 'plan_1', reason: 'No base.' }
    await expect(t.run('design.plan', fewer)).rejects.toThrow('features: an amend keeps every planned feature, in order, and may add features under new names; the plan has Base, Hinge')
    await expect(t.run('design.plan', { ...box, amends: 'plan_1', reason: 'Same.' })).rejects.toThrow('amends: no size differs from the approved plan plan_1')
  })

  it('lets the person edit the amended sizes on its card, and keeps the approved plan apart until Go', async () => {
    const t = tab(['go', 'not yet'])
    await t.approve(box)
    t.cards.length = 0
    const id = amendId('plan_1', 2)
    await t.run('design.plan', { ...taller(box, 34), amends: 'plan_1', reason: 'The box closes at 34 mm.' })
    const shown = t.card.planById(id)!
    // an edit of a size is kept on the amend's card; one that changes more than sizes is turned down
    expect(t.card.editPlan(id, { ...shown, overall: { ...shown.overall!, z: 35 } })).toBe(true)
    expect(t.card.planById(id)!.overall?.z).toBe(35)
    expect(t.card.editPlan(id, { ...shown, part: 'Chest' })).toBe(false)
    expect(t.card.planById('plan_1')!.overall?.z).toBe(30)
    expect(t.card.shownPlan(id)!.overall?.z).toBe(34)
    expect(t.card.planOfChoices([{ id: planChoiceId(PLAN_GO, id) }, { id: planChoiceId(PLAN_CHANGE, id) }])).toBe(id)
  })
})

describe('design.put_plan with amends', () => {
  const tools = () => {
    const plans = createPlanRegistry()
    const set = designToolset(boxHost(), {}, { plans, nozzleMm: () => 0.4 })
    const tool = (name: string) => set.find((t) => t.name === name)!
    const run = (name: string, input: unknown) => tool(name).run(tool(name).input.parse(input) as never, { context: { machine } } as unknown as ToolContext)
    return { plans, run, tool }
  }
  const mine: PartPlan = { planId: 'box-1', ...box }

  it('is 1.6.0, and changes a client plan of a built part with the same rules and no card', async () => {
    const t = tools()
    expect(t.tool('design.put_plan').version).toBe('1.7.0')
    expect(t.tool('design.check').version).toBe('1.20.0')
    await t.run('design.put_plan', { plan: mine, design: 'd1' })
    const out = await t.run('design.put_plan', { plan: { ...mine, ...taller(box, 34) }, amends: 'box-1', reason: 'The lid adds 4 mm.' })
    expect(out.summary).toBe('Changed plan box-1 for Hinged box (revision 2): Base height 30 mm to 34 mm, Overall height 30 mm to 34 mm. Build to it as changed, then check it with design.check and planId box-1.')
    expect(out.output).toEqual({ planId: 'box-1', part: 'Hinged box', design: 'd1', revision: 2, changes: [{ where: 'feature', feature: 'Base', size: 'height', from: 30, to: 34 }, { where: 'overall', feature: null, size: 'z', from: 30, to: 34 }], underFloors: [] })
    await expect(t.run('design.put_plan', { plan: { ...mine, ...taller(box, 35) }, amends: 'box-1', reason: 'Again.' })).rejects.toThrow('amends: the plan was changed once already since its last failed check')
    const checked = await t.run('design.check', { planId: 'box-1' })
    expect(checked.output).toMatchObject({ revision: 2 })
  })

  it('names an amended size under the floors and keeps it as given, as a new client plan is kept', async () => {
    const t = tools()
    await t.run('design.put_plan', { plan: mine, design: 'd1' })
    const thin = { ...mine, features: mine.features.map((f) => (f.name === 'Base' ? { ...f, sizes: { ...f.sizes, wall: 0.5 } } : f)) }
    const out = await t.run('design.put_plan', { plan: thin, amends: 'box-1', reason: 'A lighter box.' })
    expect((out.output as { underFloors: { size: string; planned: number; floor: number }[] }).underFloors).toMatchObject([{ size: 'wall', planned: 0.5, floor: 0.8 }])
    expect(out.summary).toContain('Base wall 0.5 mm is under the 0.8 mm this printer needs')
    expect(t.plans.get('box-1')!.plan.features[0]!.sizes['wall']).toBe(0.5)
  })

  it('refuses an amend of a plan made in the mimir tab, of an unbuilt plan, without a reason, or with another planId', async () => {
    const t = tools()
    t.plans.put({ planId: 'plan_1', ...box }, 'd1', 'card')
    await expect(t.run('design.put_plan', { plan: { planId: 'plan_1', ...taller(box, 34) }, amends: 'plan_1', reason: 'Taller.' })).rejects.toThrow('is a plan the person made in the mimir tab')
    await t.run('design.put_plan', { plan: mine })
    await expect(t.run('design.put_plan', { plan: { ...mine, ...taller(box, 34) }, amends: 'box-1', reason: 'Taller.' })).rejects.toThrow("amends: the plan's part is not built yet; build to the plan, or put the plan again")
    await t.run('design.put_plan', { plan: mine, design: 'd1' })
    await expect(t.run('design.put_plan', { plan: { ...mine, ...taller(box, 34) }, amends: 'box-1' })).rejects.toThrow('reason: say why the build changes the plan')
    await expect(t.run('design.put_plan', { plan: { ...mine, ...taller(box, 34) }, amends: 'box-2', reason: 'Taller.' })).rejects.toThrow('amends: give the plan with the planId it amends; plan.planId is box-1, amends is box-2')
    await expect(t.run('design.put_plan', { plan: { ...mine, ...taller(box, 34) }, design: 'd2', amends: 'box-1', reason: 'Taller.' })).rejects.toThrow("design: an amend keeps the plan's design, d1")
  })
})

describe('amend helpers', () => {
  const was: PartPlan = { planId: 'p', ...box, holes: [{ name: 'Vent', diameter: 3, count: 4 }] }
  it('reads the changed sizes, and what keeps a plan from being an amend', () => {
    const next = { ...was, holes: [{ name: 'Vent', diameter: 3.4, count: 4 }] }
    expect(amendChanges(was, next).map((c) => changeText(c, 'mm'))).toEqual(['Vent diameter 3 mm to 3.4 mm'])
    expect(amendShapeProblem(was, { ...was, units: 'in' })).toBe('units: an amend changes sizes only; the plan stays in mm')
    expect(amendShapeProblem(was, { ...was, holes: [{ name: 'Vent', diameter: 3, count: 5 }] })).toBe('holes: an amend changes sizes only; the plan keeps its rows of holes, by name and count')
    expect(amendShapeProblem(was, { ...was, overall: undefined })).toBe('overall: an amend changes sizes only; keep the overall size')
    expect(amendShapeProblem(was, { ...was, features: was.features.map((f, i) => (i === 0 ? { ...f, sizes: { height: 30 } } : f)) })).toBe('features: an amend changes sizes only; Base keeps the sizes height, wall')
    expect(amendShapeProblem(was, next)).toBeNull()
    expect(amendProblem('p', { plan: was, origin: 'card', design: 'd1', stale: true }, 'card')).toBe('amends: the person changed sizes since that plan was approved; make a new plan with the sizes they set')
  })
})

describe('design.plan for a part already built from an approved plan', () => {
  const numbered = () => {
    let n = 0
    return () => `plan_${++n}`
  }

  it('refuses a new plan for the built part after a failed check, pointing at undo, edit_step and amends', async () => {
    const t = tab([], numbered())
    await t.approve(box)
    expect((await t.check()).item('overall size')?.pass).toBe(false)
    await expect(t.run('design.plan', taller(box, 34))).rejects.toThrow(
      'Hinged box is already built from the approved plan plan_1 in the open design Hinged box. Fix it there rather than planning it again: design.undo or design.edit_step for a step that went wrong, design.plan with amends plan_1 and a reason for a planned size the build cannot keep, and with amends and asked for a change the person asked for. If the person asked for a second part, give it another name.',
    )
    // no card was shown for it, and the approved plan keeps its design and fix round
    expect(t.cards).toHaveLength(1)
    expect(t.card.plans.get('plan_1')).toMatchObject({ design: 'd1', failedChecks: 1 })
    expect(t.card.plans.get('plan_2')).toBeUndefined()
  })

  it('refuses it by the part name whatever its case, and says to stop once the fix round is used', async () => {
    const t = tab([], numbered())
    await t.approve(box)
    await t.check()
    await t.check()
    await expect(t.run('design.plan', { ...box, part: ' hinged BOX ' })).rejects.toThrow(
      'is already built from the approved plan plan_1 in the open design Hinged box, and its check used the fix round. Make no new plan: stop and tell the person exactly what is off.',
    )
  })

  it('still plans the built part again when the new plan changes its shape, which amends cannot, until the fix round is used', async () => {
    const t = tab([], numbered())
    await t.approve(box)
    await t.check()
    const withBore = { ...box, holes: [{ name: 'Lid bore', diameter: 21 }] }
    expect((await t.run('design.plan', withBore)).output).toMatchObject({ planId: 'plan_2', accepted: true })

    const stopped = tab([], numbered())
    await stopped.approve(box)
    await stopped.check()
    await stopped.check()
    await expect(stopped.run('design.plan', withBore)).rejects.toThrow('Make no new plan: stop and tell the person exactly what is off.')
  })

  it('still plans a second part under another name, a part not built yet, and a part whose sizes the person changed', async () => {
    const t = tab([], numbered())
    await t.approve(box)
    const lid = await t.run('design.plan', { ...box, part: 'Lid' })
    expect(lid.output).toMatchObject({ planId: 'plan_2', accepted: true })

    const unbuilt = tab([], numbered())
    await unbuilt.run('design.plan', box)
    expect((await unbuilt.run('design.plan', taller(box, 34))).output).toMatchObject({ planId: 'plan_2', accepted: true })

    const changed = tab([], numbered())
    await changed.approve(box)
    changed.card.plans.stale('plan_1')
    expect((await changed.run('design.plan', taller(box, 34))).output).toMatchObject({ planId: 'plan_2', accepted: true })
  })
})
