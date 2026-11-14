// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An amend changes sizes only. A field it does not keep (a feature's on, a hole row's recess, the plan's detail and its
// lists) that it gives otherwise than the approved plan is refused, naming the field, and the plan stays as approved:
// never "Plan changed" with the change dropped. design.plan in the mimir tab and design.put_plan over MCP share the rule
// (plan-amend.ts). The plan here is a recorded display plan: a 1:1250 liner whose funnel row stands on the first funnel.
import type { DesignHost } from '@slicerx/cad-history'
import type { PilotMachine } from '@slicerx/contracts'
import type { ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, type PartPlan } from '../src/design-check'
import { amendDropProblem } from '../src/plan-amend'
import { amendId, type PlanAnswer, type PlanInput } from '../src/tab-tools'
import { createCardPlans, designToolset, tabToolset } from '../src/toolset'
import { connect, data, text } from './helpers'

const host = { get: (id: string) => { throw new Error(`no design ${id}`) }, list: () => [] } as unknown as DesignHost
const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }
const ID = 'plan_mwfpyyad165w3'

/** The approved plan, as design.plan took it. */
const liner = {
  part: 'Titanic 1:1250 display model',
  units: 'mm',
  features: [
    { name: 'Hull', kind: 'loft', sizes: { length: 215, beam: 22.6, height: 15, sections: 6 }, kinds: { sections: 'count' } },
    { name: 'Forecastle deck', kind: 'extrude', sizes: { length: 20, width: 10, height: 1.5 }, on: 'Hull' },
    { name: 'Poop deck', kind: 'extrude', sizes: { length: 20, width: 12, height: 1.5 }, on: 'Hull' },
    { name: 'Lower deck house', kind: 'extrude', sizes: { length: 120, width: 17, height: 2.5 }, on: 'Hull' },
    { name: 'Upper deck house', kind: 'extrude', sizes: { length: 104, width: 15, height: 2.5 }, on: 'Lower deck house' },
    { name: 'Bridge', kind: 'extrude', sizes: { length: 10, width: 18, height: 3 }, on: 'Upper deck house' },
    { name: 'Officers quarters', kind: 'extrude', sizes: { length: 14, width: 10, height: 2.5 }, on: 'Upper deck house' },
    { name: 'Funnel', kind: 'loft', sizes: { height: 15, base_width: 5.5, top_width: 4.5, sections: 5 }, kinds: { sections: 'count' }, on: 'Upper deck house' },
    { name: 'Funnel cap', kind: 'extrude', sizes: { height: 1, width: 5 }, on: 'Funnel' },
    { name: 'Funnel array', kind: 'array', sizes: { count: 4, spacing: 21 }, kinds: { count: 'count' }, on: 'Funnel' },
    { name: 'Foremast', kind: 'extrude', sizes: { diameter: 1.4, height: 18 }, on: 'Hull' },
    { name: 'Mainmast', kind: 'extrude', sizes: { diameter: 1.4, height: 15 }, on: 'Hull' },
  ],
  overall: { x: 215, y: 22.6, z: 35 },
  assumptions: ['Funnels all one color; no colors requested', 'Lifeboats, portholes and rigging are too small at this scale and are left out', 'Hull is a lofted stack of waterline sections with a pointed bow and rounded stern'],
  questions: [],
  detail: 'display',
  curved: ['Hull'],
  flat: ['Lower deck house', 'Upper deck house'],
  proportions: 'lookup: RMS Titanic 269.1 m long, 28.2 m beam, funnels 18.9 m above boat deck, scaled 1:1250',
  repeats: ['Funnels'],
  scale: '1250',
  real: [
    { feature: 'Hull', size: 'length', mm: 269100 },
    { feature: 'Hull', size: 'beam', mm: 28200 },
  ],
  tiers: { 'Lower deck house': ['Lower deck house'], 'Upper deck house': ['Upper deck house'] },
  personSize: false,
} satisfies PlanInput

type Feature = PlanInput['features'][number]
/** The plan restated whole, with Funnel array changed by `f`. */
const row = (f: (r: Feature) => Feature): PlanInput => structuredClone({ ...liner, features: liner.features.map((x) => (x.name === 'Funnel array' ? f(structuredClone(x)) : x)) }) as PlanInput
const spaced = (r: Feature): Feature => ({ ...r, sizes: { ...r.sizes, spacing: 22 } })
const onDeck = (r: Feature): Feature => ({ ...r, on: 'Upper deck house' })
/** The plan as the registry keeps it: personSize is read only when a new plan is checked, and is not kept. */
const { personSize: _personSize, ...kept } = liner
const approved = { planId: ID, ...kept }
const reason = 'The array repeats the whole funnel and cap, so it stands on the deck house like the first funnel.'

/** The tab's tools with the liner approved and built as d1, answering every card with Go. */
function tab() {
  const card = createCardPlans(createPlanRegistry())
  card.plans.put(structuredClone({ planId: ID, ...liner }) as PartPlan, 'd1', 'card')
  const tools = tabToolset(host, card, { nozzleMm: () => machine.nozzle })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const cards: string[] = []
  const ctx = {
    context: { project: 'creative', machine, objects: [] },
    confirmsPlan: () => true,
    ask: async (q: { title: string; choices: { id: string }[] }) => {
      cards.push(q.title)
      return { id: q.choices[0]!.id }
    },
  } as unknown as ToolContext
  const run = (input: unknown) => tool('design.plan').run(tool('design.plan').input.parse(input) as never, ctx)
  /** The stored plan reads as approved: revision 1, no amend counted, the row at 21 mm on the first funnel. */
  const unchanged = () => {
    const e = card.plans.get(ID)!
    expect(e.revision).toBeUndefined()
    expect(e.amendedAt).toBeUndefined()
    expect(e.plan).toEqual(approved)
    expect(card.amendOf(amendId(ID, 2))).toBeNull()
    expect(cards).toEqual([])
  }
  return { card, run, cards, unchanged, version: tool('design.plan').version }
}

describe('design.plan with amends, for a field an amend does not keep', () => {
  it('is 1.15.0', () => {
    expect(tab().version).toBe('1.15.0')
  })

  it('refuses an amend that only moves the row onto another feature, as no size differs', async () => {
    const t = tab()
    await expect(t.run({ ...row(onDeck), amends: ID, reason })).rejects.toThrow(`amends: no size differs from the approved plan ${ID}`)
    t.unchanged()
  })

  it('refuses one that moves the row and adds a size, as it keeps its sizes', async () => {
    const t = tab()
    await expect(t.run({ ...row((r) => ({ ...onDeck(r), sizes: { ...r.sizes, height: 15 } })), amends: ID, reason })).rejects.toThrow('features: an amend changes sizes only; Funnel array keeps the sizes count, spacing')
    t.unchanged()
  })

  it('refuses one that moves the row with a spacing change, naming on, and the plan stays at 21 mm on the first funnel', async () => {
    const t = tab()
    await expect(t.run({ ...row((r) => onDeck(spaced(r))), amends: ID, reason })).rejects.toThrow('features: an amend changes sizes only; Funnel array keeps on: "Funnel"')
    t.unchanged()
  })

  it('refuses a row restated without its on, and a feature given an on it did not have', async () => {
    const t = tab()
    await expect(t.run({ ...row(({ on: _on, ...r }) => spaced(r)), amends: ID, reason: 'Wider spacing.' })).rejects.toThrow('features: an amend changes sizes only; Funnel array keeps on: "Funnel"')
    const hull = { ...row(spaced), features: row(spaced).features.map((f) => (f.name === 'Hull' ? { ...f, on: 'Funnel' } : f)) }
    await expect(t.run({ ...hull, amends: ID, reason: 'Wider spacing.' })).rejects.toThrow('features: an amend changes sizes only; Hull takes no on')
    t.unchanged()
  })

  it.each([
    ['printInPlace', false, 'leave out printInPlace'],
    ['detail', 'fine', 'the plan keeps detail: "display"'],
    ['curved', ['Hull', 'Funnel'], 'the plan keeps curved: ["Hull"]'],
    ['flat', ['Lower deck house'], 'the plan keeps flat: ["Lower deck house","Upper deck house"]'],
    ['proportions', 'lookup: 269 m long', 'the plan keeps proportions: "lookup: RMS Titanic 269.1 m long, 28.2 m beam, funnels 18.9 m above boat deck, scaled 1:1250"'],
    ['repeats', ['Funnels', 'Masts'], 'the plan keeps repeats: ["Funnels"]'],
    ['colors', { Hull: 'black' }, 'leave out colors'],
    ['scale', '1300', 'the plan keeps scale: "1250"'],
    ['real', [{ feature: 'Hull', size: 'length', mm: 270000 }], 'the plan keeps real: [{"feature":"Hull","size":"length","mm":269100},{"feature":"Hull","size":"beam","mm":28200}]'],
    ['tiers', { 'Lower deck house': ['Lower deck house', 'Upper deck house'] }, 'the plan keeps tiers: {"Lower deck house":["Lower deck house"],"Upper deck house":["Upper deck house"]}'],
  ])('refuses an amend that changes %s with a size, naming it, and changes nothing', async (field, value, keeps) => {
    const t = tab()
    await expect(t.run({ ...row(spaced), [field]: value, amends: ID, reason: 'Wider spacing.' })).rejects.toThrow(`${field}: an amend changes sizes only; ${keeps}`)
    t.unchanged()
  })

  it('refuses a hole row whose recess changes with its diameter', async () => {
    const t = tab()
    const vented = { ...liner, holes: [{ name: 'Vent', diameter: 3, count: 4, recess: true }] } as PlanInput
    t.card.plans.put(structuredClone({ planId: ID, ...vented }) as PartPlan, 'd1', 'card')
    await expect(t.run({ ...vented, holes: [{ name: 'Vent', diameter: 3.4, count: 4 }], amends: ID, reason: 'Wider vents.' })).rejects.toThrow('holes: an amend changes sizes only; Vent keeps recess: true')
    expect(t.card.plans.get(ID)!.plan.holes).toEqual([{ name: 'Vent', diameter: 3, count: 4, recess: true }])
  })

  it('refuses a change the person asked for that moves the row, naming on, and changes nothing', async () => {
    const t = tab()
    await expect(t.run({ ...row((r) => onDeck(spaced(r))), amends: ID, asked: 'put the funnels on the deck house, 22 mm apart' })).rejects.toThrow('features: an amend changes sizes only; Funnel array keeps on: "Funnel"')
    t.unchanged()
  })

  it('still takes a size amend, and the stored plan reads back the new spacing with every other field as approved', async () => {
    const t = tab()
    // the scale written as 1:1250 and fields left out are the plan's own, not a change
    const { proportions: _p, real: _r, ...rest } = row(spaced)
    const out = await t.run({ ...rest, scale: '1:1250', amends: ID, reason: 'The funnels sit 22 mm apart on the deck house.' })
    expect(out.summary).toBe('Plan changed (revision 2): Funnel array spacing 21 mm to 22 mm. Build to it as changed')
    expect((out.output as PlanAnswer).changes).toEqual([{ where: 'feature', feature: 'Funnel array', size: 'spacing', from: 21, to: 22 }])
    expect(t.cards).toEqual(['Plan change'])
    const entry = t.card.plans.get(ID)!
    expect(entry.revision).toBe(2)
    const { personSize: _s, ...restated } = row(spaced)
    expect(entry.plan).toEqual({ planId: ID, ...restated })
  })
})

describe('design.put_plan with amends, for a field an amend does not keep', () => {
  const mine = { planId: 'liner-1', ...kept } as unknown as PartPlan
  const moved = { ...mine, ...row((r) => onDeck(spaced(r))) } as PartPlan

  it('is 1.8.0, refuses the moved row naming on, and keeps the plan as it was', async () => {
    const plans = createPlanRegistry()
    const set = designToolset(host, {}, { plans, nozzleMm: () => 0.4 })
    const put = set.find((t) => t.name === 'design.put_plan')!
    expect(put.version).toBe('1.8.0')
    plans.put(structuredClone(mine), 'd1', 'client')
    const run = (input: unknown) => put.run(put.input.parse(input) as never, { context: { machine } } as unknown as ToolContext)
    await expect(run({ plan: moved, amends: 'liner-1', reason })).rejects.toThrow('features: an amend changes sizes only; Funnel array keeps on: "Funnel"')
    // its plan takes no detail fields; printInPlace is the plan field it takes and an amend keeps
    await expect(run({ plan: { ...mine, ...row(spaced), printInPlace: false }, amends: 'liner-1', reason })).rejects.toThrow('printInPlace: an amend changes sizes only; leave out printInPlace')
    const vented = { ...mine, holes: [{ name: 'Vent', diameter: 3, count: 4, recess: true }] }
    plans.put(structuredClone(vented), 'd1', 'client')
    await expect(run({ plan: { ...vented, holes: [{ name: 'Vent', diameter: 3.4, count: 4 }] }, amends: 'liner-1', reason: 'Wider vents.' })).rejects.toThrow('holes: an amend changes sizes only; Vent keeps recess: true')
    expect(plans.get('liner-1')!.plan).toEqual(vented)
    expect(plans.get('liner-1')!.revision).toBeUndefined()
  })

  it('refuses it over the MCP server as a client sees it, and the next size amend reads back from 21 mm as revision 2', async () => {
    const h = await connect({ geomEngine: async () => ({ mesh: { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 5], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] } }) })
    const design = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Titanic' })).output.design
    const put = await h.call('slicerx_design_put_plan', { plan: mine, design })
    expect(put.isError, text(put)).toBeFalsy()
    const bad = await h.call('slicerx_design_put_plan', { plan: moved, amends: 'liner-1', reason })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toContain('features: an amend changes sizes only; Funnel array keeps on: "Funnel"')
    // the refused amend changed nothing and used no amend: a size amend is still taken, from the approved 21 mm
    const ok = await h.call('slicerx_design_put_plan', { plan: { ...mine, ...row(spaced) }, amends: 'liner-1', reason: 'The funnels sit 22 mm apart.' })
    expect(ok.isError, text(ok)).toBeFalsy()
    expect(data<{ output: { revision: number; changes: unknown[] } }>(ok).output).toMatchObject({ revision: 2, changes: [{ where: 'feature', feature: 'Funnel array', size: 'spacing', from: 21, to: 22 }] })
  })
})

describe('amendDropProblem', () => {
  it('is null for a plan that changes sizes only, and for fields left out', () => {
    const was = approved as unknown as PartPlan
    expect(amendDropProblem(was, { ...was, ...row(spaced) } as PartPlan)).toBeNull()
    const { detail: _d, tiers: _t, ...rest } = was
    expect(amendDropProblem(was, rest as PartPlan)).toBeNull()
    expect(amendDropProblem(was, { ...was, scale: 1250 } as PartPlan)).toBeNull()
  })
})
