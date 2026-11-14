// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A display plan of a real thing takes its real sizes from a lookup mimir ran (design.lookup_sizes), the person's own
// words, or, where no lookup can run, from memory with an assumption that says so. The plan is held to the looked-up
// figure, so a guessed size multiplied back by the scale no longer passes as a real one.
import type { PilotMachine } from '@slicerx/contracts'
import { type ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, type PartPlan } from '../src/design-check'
import { PLAN_GO, type PlanInput } from '../src/tab-tools'
import { createCardPlans, tabToolset } from '../src/toolset'
import type { DesignHost } from '@slicerx/cad-history'

const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }

/** A suspension bridge at display detail, 1:2000: a flat deck, two towers patterned at the main span, cables. */
const bridge: PlanInput = {
  personSize: true,
  part: 'Suspension bridge',
  units: 'mm',
  detail: 'display',
  flat: ['Deck'],
  tiers: { Deck: ['Deck'] },
  proportions: 'lookup: deck 280 m long, towers 180 m tall, 128 m apart, scaled 1:2000',
  scale: 2000,
  repeats: ['towers'],
  real: [
    { feature: 'Deck', size: 'length', mm: 280000 },
    { feature: 'Main tower', size: 'height', mm: 180000 },
    { feature: 'Towers (array)', size: 'spacing', mm: 128000 },
  ],
  features: [
    { name: 'Deck', kind: 'extrude', sizes: { length: 140, width: 14, height: 3 } },
    { name: 'Main tower', kind: 'extrude', sizes: { width: 6, depth: 6, height: 90 } },
    { name: 'Towers (array)', kind: 'array', sizes: { count: 2, spacing: 64 }, kinds: { count: 'count' } },
    { name: 'Main cable', kind: 'sweep', sizes: { diameter: 1 } },
    { name: 'Suspenders', kind: 'array', sizes: { width: 0.8, count: 20 }, kinds: { count: 'count' } },
    { name: 'Anchorage', kind: 'extrude', sizes: { width: 10, depth: 14, height: 6 } },
    { name: 'Approach', kind: 'extrude', sizes: { length: 20, width: 14, height: 3 } },
    { name: 'Railings', kind: 'extrude', sizes: { length: 140, width: 0.8, height: 1.2 } },
  ],
  assumptions: [],
  questions: [],
}

type Web = NonNullable<ToolContext['web']>

/** The tab's tools over a fresh card, with a web lookup that answers `answer` (none when `web` is false). */
function tab(opts: { web?: false; answer?: string; said?: string[] } = {}) {
  const card = createCardPlans(createPlanRegistry())
  const tools = tabToolset({ list: () => [], get: () => undefined } as unknown as DesignHost, card, { nozzleMm: () => machine.nozzle, newPlanId: () => 'plan_1' })
  const plan = tools.find((t) => t.name === 'design.plan')!
  const lookup = tools.find((t) => t.name === 'design.lookup_sizes')
  const shown: (PartPlan | null)[] = []
  const queries: string[] = []
  const web: Web = async (query) => {
    queries.push(query)
    return { text: opts.answer ?? '', citations: [{ id: 'https://example.org/bridge', title: 'Bridge facts', url: 'https://example.org/bridge', kind: 'web' }] }
  }
  const ctx = {
    sessionId: 's1',
    context: { project: 'creative', machine, objects: [] },
    ask: async (q: { choices: { id: string }[] }) => {
      shown.push(card.planById(q.choices[0]!.id.slice(PLAN_GO.length + 1)))
      return { id: q.choices[0]!.id }
    },
    ...(opts.web === false ? {} : { web }),
    ...(opts.said ? { said: () => opts.said! } : {}),
  } as unknown as ToolContext
  return {
    card,
    shown,
    queries,
    plan: (input: unknown) => plan.run(plan.input.parse(input) as never, ctx),
    lookup: (input: unknown) => lookup!.run(lookup!.input.parse(input) as never, ctx),
  }
}

const withReal = (p: PlanInput, real: NonNullable<PlanInput['real']>): PlanInput => ({ ...p, real })

describe('a display plan of a real thing takes its real sizes from a lookup', () => {
  it('refuses real sizes that are the planned sizes times the scale when no lookup ran', async () => {
    // each real size here is its planned size times 2000: nothing but the plan's own numbers stands behind them
    const t = tab()
    await expect(t.plan(bridge)).rejects.toThrow('real: Deck length, Main tower height and Towers (array) spacing have no lookupId, so they are not from a lookup; call design.lookup_sizes first, then give each found size with its lookupId')
    expect(t.shown).toEqual([])
  })

  it('holds each size to the looked-up figure, not the plan\'s own', async () => {
    const t = tab({ answer: 'Deck length: 280 m\nTower height: 227 m\nMain span: 128 m' })
    const found = (await t.lookup({ subject: 'a suspension bridge', sizes: ['Deck length', 'Tower height', 'Main span'] })).output as { lookupId: string }
    // the tower's 180000 mm is its planned 90 mm times the scale; the lookup found 227 m
    const guessed = withReal(bridge, bridge.real!.map((r) => ({ ...r, lookup: found.lookupId })))
    await expect(t.plan(guessed)).rejects.toThrow(`real: Main tower height is 180000 mm, but ${found.lookupId} found no size within 1% of that (it found Deck length 280000 mm, Tower height 227000 mm, Main span 128000 mm); give the size it found`)
  })
})
