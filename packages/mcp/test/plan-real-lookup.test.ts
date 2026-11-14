// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A display plan of a real thing takes its real sizes from a lookup mimir ran (design.lookup_sizes), the person's own
// words, or, where no lookup can run, from memory with an assumption that says so. The plan is held to the looked-up
// figure, so a guessed size multiplied back by the scale no longer passes as a real one.
import type { PilotMachine } from '@slicerx/contracts'
import { type ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, type PartPlan } from '../src/design-check'
import { realSaid } from '../src/design-tools'
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

/** Looks up the bridge's three sizes, and returns the lookup's id. */
async function lookedUp(t: ReturnType<typeof tab>): Promise<string> {
  return ((await t.lookup({ subject: 'a suspension bridge', sizes: ['Deck length', 'Tower height', 'Main span'] })).output as { lookupId: string }).lookupId
}

const FOUND = 'Deck length: 280 m\nTower height: 227 m\nMain span: 128 m'

describe('a looked-up real size', () => {
  it('takes the size the lookup found, and refuses a part far off it at scale', async () => {
    const t = tab({ answer: FOUND })
    const id = await lookedUp(t)
    const real = [
      { feature: 'Deck', size: 'length', mm: 280000, lookup: id },
      { feature: 'Main tower', size: 'height', mm: 227000, lookup: id },
      { feature: 'Towers (array)', size: 'spacing', mm: 128000, lookup: id },
    ]
    // the tower's 90 mm is 0.79 times the 113.5 mm the looked-up 227 m gives at 1:2000, inside the slack
    const out = await t.plan(withReal(bridge, real))
    expect(out.ok).not.toBe(false)
    expect(t.shown[0]!.real).toEqual(real)
    expect(t.shown[0]!.assumptions).toEqual([])
    const short = { ...withReal(bridge, real), features: bridge.features.map((f) => (f.name === 'Main tower' ? { ...f, sizes: { ...f.sizes, height: 60 } } : f)) }
    await expect(tab({ answer: FOUND }).plan(short)).rejects.toThrow('real: lookup_1 is not a lookup in this chat')
    await expect(t.plan(short)).rejects.toThrow('Main tower height is 60 mm, 0.5 times the 113.5 mm its real 227000 mm gives at 1:2000; size it from the real one')
  })

  it('takes a size within 1% of the one found, and holds the part to the found figure', async () => {
    const t = tab({ answer: FOUND })
    const id = await lookedUp(t)
    const real = [
      { feature: 'Deck', size: 'length', mm: 281000, lookup: id },
      { feature: 'Main tower', size: 'height', mm: 226000, lookup: id },
      { feature: 'Towers (array)', size: 'spacing', mm: 128500, lookup: id },
    ]
    expect((await t.plan(withReal(bridge, real))).ok).not.toBe(false)
  })

  it('refuses a lookupId that is not in this chat', async () => {
    const t = tab({ answer: FOUND })
    await expect(t.plan(withReal(bridge, bridge.real!.map((r) => ({ ...r, lookup: 'lookup_9' }))))).rejects.toThrow('real: lookup_9 is not a lookup in this chat; give the lookupId design.lookup_sizes returned')
  })

  it('takes "not given by the source" only for a size a lookup asked for and found no source for', async () => {
    const t = tab({ answer: 'Deck length: 280 m\nTower height: 227 m\nMain span: not found' })
    const id = await lookedUp(t)
    const real = [
      { feature: 'Deck', size: 'length', mm: 280000, lookup: id },
      { feature: 'Main tower', size: 'height', mm: 227000, lookup: id },
    ]
    // no lookup asked for the towers' spacing under that name: the note stands only once one did
    const t2 = tab({ answer: FOUND })
    const id2 = await lookedUp(t2)
    await expect(t2.plan({ ...withReal(bridge, real.map((r) => ({ ...r, lookup: id2 }))), assumptions: ['real: Towers spacing not given by the source'] })).rejects.toThrow('real: Towers (array) spacing was not asked for in any lookup, so the source has not been read for it; ask design.lookup_sizes for it first')
    const sp = (await t.lookup({ subject: 'a suspension bridge', sizes: ['Towers spacing'] })).output as { missing: string[] }
    expect(sp.missing).toEqual(['Towers spacing'])
    expect((await t.plan({ ...withReal(bridge, real), assumptions: ['real: Towers spacing not given by the source'] })).ok).not.toBe(false)
  })

  it('goes through when the lookup finds nothing at all, with each size it asked for from memory and said so', async () => {
    // labeled: the lookup ran and no source gave any size, so the plan takes the sizes from memory, never a dead end
    const t = tab({ answer: 'Deck length: not found\nTower height: not found\nTowers spacing: not found' })
    const asked = (await t.lookup({ subject: 'a suspension bridge', sizes: ['Deck length', 'Tower height', 'Towers spacing'] })).output as { found: unknown[]; missing: string[] }
    expect(asked.found).toEqual([])
    const out = await t.plan(bridge)
    expect(out.ok).not.toBe(false)
    expect(t.shown[0]!.assumptions).toEqual(['real: Deck length, Main tower height and Towers (array) spacing are from memory, as the lookup found no source for them'])
  })
})

describe('real sizes with no lookup', () => {
  it('takes them from memory where no web lookup can run, and says so in assumptions', async () => {
    const t = tab({ web: false })
    const out = await t.plan(bridge)
    expect(out.ok).not.toBe(false)
    expect(t.shown[0]!.assumptions).toEqual(['real: not looked up, as no web lookup can run here; Deck length, Main tower height and Towers (array) spacing are from memory'])
  })

  it('takes a size the person stated, held within 1% of the length in their words', async () => {
    const said = ['Make me the suspension bridge near us: its towers are 227 m tall and the deck is 280 m long']
    const t = tab({ said })
    const real = [
      { feature: 'Deck', size: 'length', mm: 280000, stated: 'the deck is 280 m long' },
      { feature: 'Main tower', size: 'height', mm: 227000, stated: 'its towers are 227 m tall' },
      { feature: 'Towers (array)', size: 'spacing', mm: 128000, stated: 'its towers are 227 m tall' },
    ]
    await expect(t.plan(withReal(bridge, real))).rejects.toThrow('real: Towers (array) spacing is 128000 mm, but "its towers are 227 m tall" gives no size within 1% of that; give the size the person\'s words give, in mm')
    await expect(t.plan(withReal(bridge, [real[0]!, { ...real[1]!, stated: 'the towers are 300 m tall' }]))).rejects.toThrow('real: "the towers are 300 m tall" is not in the person\'s messages in this chat; quote their own words in stated, or look the size up with design.lookup_sizes')
    // the spacing is still held to scale, so a plan without it is asked for it
    await expect(t.plan(withReal(bridge, real.slice(0, 2)))).rejects.toThrow('give the real Towers (array) spacing')
    const t2 = tab({ said: [...said, 'and the towers stand 128 m apart'] })
    expect((await t2.plan(withReal(bridge, [...real.slice(0, 2), { ...real[2]!, stated: 'the towers stand 128 m apart' }]))).ok).not.toBe(false)
  })

  it('takes no source page on a plan mimir made: a page it names is not a lookup it ran', async () => {
    const t = tab()
    await expect(t.plan(withReal(bridge, bridge.real!.map((r) => ({ ...r, source: { title: 'Bridge facts', url: 'https://example.org/bridge' } }))))).rejects.toThrow('real: Deck length, Main tower height and Towers (array) spacing have no lookupId')
  })
})

describe('design.lookup_sizes', () => {
  it('reads each size into mm from m, ft, in and mm, lists the ones no source gave, and shows a lookup card', async () => {
    const t = tab({ answer: '- Deck length: 918.5 ft\n**Tower height**: 227 m\nCable diameter: 36.4 in\nRail height: 1,100 mm\nMain span: not found' })
    const out = await t.lookup({ subject: 'a suspension bridge', sizes: ['Deck length', 'Tower height', 'Cable diameter', 'Rail height', 'Main span'] })
    expect(t.queries).toEqual(['a suspension bridge: Deck length; Tower height; Cable diameter; Rail height; Main span'])
    expect(out.output).toEqual({
      lookupId: 'lookup_1',
      subject: 'a suspension bridge',
      found: [
        { size: 'Deck length', mm: 279958.8, said: '918.5 ft' },
        { size: 'Tower height', mm: 227000, said: '227 m' },
        { size: 'Cable diameter', mm: 924.56, said: '36.4 in' },
        { size: 'Rail height', mm: 1100, said: '1,100 mm' },
      ],
      missing: ['Main span'],
      sources: [{ title: 'Bridge facts', url: 'https://example.org/bridge' }],
    })
    expect(out.untrusted).toBe(true)
    expect(out.summary).toBe('lookup_1: found 4 of 5 sizes; no source gave Main span')
    expect(out.lookup).toEqual({
      title: 'a suspension bridge',
      fields: [['Deck length', '918.5 ft'], ['Tower height', '227 m'], ['Cable diameter', '36.4 in'], ['Rail height', '1,100 mm']],
      source: { title: 'Bridge facts', url: 'https://example.org/bridge' },
    })
  })

  it('says a web lookup is not available where none can run', async () => {
    const out = await tab({ web: false }).lookup({ subject: 'a suspension bridge', sizes: ['Deck length'] })
    expect(out).toEqual({ ok: false, summary: 'Web lookup is not available here, so give the real sizes from what you know; the plan says they were not looked up' })
  })
})

describe("design.check's reply on where the real sizes came from", () => {
  it('names the sizes from memory, or the page the lookup read', () => {
    const src = (id: string) => (id === 'lookup_1' ? { title: 'Bridge facts' } : undefined)
    expect(realSaid(bridge.real, src)).toBe(', say Deck length, Main tower height and Towers (array) spacing are from memory, not looked up,')
    expect(realSaid(bridge.real!.map((r) => ({ ...r, lookup: 'lookup_1' })), src)).toBe(', say its real sizes were looked up on Bridge facts,')
    expect(realSaid(bridge.real!.map((r) => ({ ...r, stated: 'the deck is 280 m long' })), src)).toBe('')
    expect(realSaid([], src)).toBe('')
  })
})
