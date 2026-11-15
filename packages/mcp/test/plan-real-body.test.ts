// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A display plan that gives real sizes names its main body's real size in realBody: the feature, the size, its mm and
// where it came from (a lookup, with its lookupId, or the person's words). It is read as that size's row in real, so
// the plan keeps one list of real sizes and every rule holds the body's size as it holds any other: to its lookup, to
// the person's words, and to scale. A plan whose real sizes leave every main body out is refused, naming realBody; a
// row for a main body in real, the older form, still counts.
import type { DesignHost } from '@slicerx/cad-history'
import type { PilotMachine } from '@slicerx/contracts'
import { toolSpec, type ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry } from '../src/design-check'
import { NO_REAL_BODY } from '../src/plan-detail'
import { PLAN_GO, type PlanInput } from '../src/tab-tools'
import { createCardPlans, tabToolset } from '../src/toolset'

const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }

/** A stone house at display detail, 1:100, its size the person's; its real sizes come next. */
const house: Omit<PlanInput, 'real'> = {
  personSize: true,
  part: 'Stone house',
  units: 'mm',
  detail: 'display',
  flat: ['Walls', 'Roof'],
  tiers: { Walls: ['Walls'], Roof: ['Roof'] },
  proportions: 'stated: a house 10 m wide, scaled 1:100',
  scale: 100,
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
const door = { feature: 'Door', size: 'width', mm: 1000 }

/** The tab's design.plan in one chat, with a web lookup when `web`, every card answered Go. */
function tab(web = false) {
  const card = createCardPlans(createPlanRegistry())
  if (web) card.lookups.add({ session: 's1', subject: 'Stone house', asked: ['House width', 'Door width'], found: [{ size: 'House width', mm: 10000, said: '10 m' }, { size: 'Door width', mm: 1000, said: '1 m' }], missing: [], sources: [{ title: 'House facts', url: 'https://example.org/house' }], searched: true })
  const tool = tabToolset({ list: () => [], get: () => undefined } as unknown as DesignHost, card, { nozzleMm: () => machine.nozzle, newPlanId: () => 'plan_1' }).find((t) => t.name === 'design.plan')!
  const ctx = {
    sessionId: 's1',
    ...(web ? { web: async () => ({ text: '', citations: [] }) } : {}),
    context: { project: 'creative', machine, objects: [] },
    ask: async (q: { choices: { id: string }[] }) => ({ id: q.choices.find((c) => c.id.startsWith(`${PLAN_GO}:`))!.id }),
  } as unknown as ToolContext
  return { card, tool, run: (input: unknown) => tool.run(tool.input.parse(input) as never, ctx), real: () => card.plans.get('plan_1')!.plan.real }
}

describe('a display plan names its main body\'s real size in realBody', () => {
  it('takes the body from a lookup as its row in real, first, with each part\'s row after it', async () => {
    const t = tab(true)
    const out = await t.run({ ...house, realBody: { feature: 'Walls', size: 'width', mm: 10000, source: 'lookup', lookupId: 'lookup_1' }, real: [{ ...door, lookup: 'lookup_1' }] })
    expect(out.output).toMatchObject({ planId: 'plan_1', accepted: true })
    expect(t.real()).toEqual([{ feature: 'Walls', size: 'width', mm: 10000, lookup: 'lookup_1' }, { ...door, lookup: 'lookup_1' }])
  })

  it('takes the body alone, and in place of a row real gives for the same size', async () => {
    const t = tab()
    await t.run({ ...house, realBody: { feature: 'Walls', size: 'Width', mm: 10000, source: 'stated', stated: 'a house 10 m wide' }, real: [{ feature: 'Walls', size: 'width', mm: 9000 }] })
    expect(t.real()).toEqual([{ feature: 'Walls', size: 'Width', mm: 10000, stated: 'a house 10 m wide' }])
    const alone = tab()
    await alone.run({ ...house, realBody: { feature: 'Walls', size: 'width', mm: 10000, source: 'stated', stated: 'a house 10 m wide' } })
    expect(alone.real()).toEqual([{ feature: 'Walls', size: 'width', mm: 10000, stated: 'a house 10 m wide' }])
  })

  it('refuses real sizes that leave every main body out, naming realBody; a body row in real still counts', async () => {
    await expect(tab().run({ ...house, real: [door] })).rejects.toThrow(NO_REAL_BODY)
    // a realBody that is no main body leaves the bodies out too
    await expect(tab().run({ ...house, realBody: { ...door, source: 'stated', stated: '1 m door' }, real: [] })).rejects.toThrow(NO_REAL_BODY)
    const older = await tab().run({ ...house, real: [{ feature: 'Walls', size: 'width', mm: 10000 }, door] })
    expect(older.output).toMatchObject({ accepted: true })
    // a made-up thing gives no real sizes and needs none
    expect((await tab().run({ ...house, real: [] })).output).toMatchObject({ accepted: true })
  })

  it('holds the body to its lookup and to scale, as any real row', async () => {
    await expect(tab(true).run({ ...house, realBody: { feature: 'Walls', size: 'width', mm: 12000, source: 'lookup', lookupId: 'lookup_1' }, real: [{ ...door, lookup: 'lookup_1' }] })).rejects.toThrow('real: Walls width is 12000 mm, but lookup_1 found no size within 1% of that')
    await expect(tab(true).run({ ...house, realBody: { feature: 'Walls', size: 'width', mm: 10000, source: 'lookup', lookupId: 'lookup_9' } })).rejects.toThrow('real: lookup_9 is not a lookup in this chat')
    await expect(tab().run({ ...house, realBody: { feature: 'Walls', size: 'width', mm: 20000, source: 'stated', stated: 'a house 20 m wide' } })).rejects.toThrow('Walls width is 100 mm, 0.5 times the 200 mm its real 20000 mm gives at 1:100')
  })

  it('takes source lookup only with its lookupId', () => {
    const read = tab().tool.input.safeParse({ ...house, realBody: { feature: 'Walls', size: 'width', mm: 10000, source: 'lookup' } })
    expect(read.success).toBe(false)
    expect(read.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual(['realBody.lookupId: source lookup takes the lookupId design.lookup_sizes returned with this size'])
  })

  it('shows the model realBody with its source', () => {
    const spec = toolSpec(tab().tool) as unknown as { inputSchema: { properties: Record<string, { description?: string; properties?: Record<string, { enum?: string[] }> }> } }
    const body = spec.inputSchema.properties['realBody']!
    expect(body.description).toMatch(/^Display and fine, needed when the plan gives real sizes: the main body's real size/)
    expect(body.properties!['source']!.enum).toEqual(['lookup', 'stated'])
  })
})
