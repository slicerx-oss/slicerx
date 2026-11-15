// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A height a source measures from a reference ("Chimney height above base", "Height keel to chimney top") is where a
// part's top sits, not the part's own height. design.lookup_sizes tags each such size with its reference in `from`,
// and design.plan holds a real size measured from a reference against the planned top of its part where it stands:
// the top of what it stands on plus its own height, at the plan's scale. A part with no on stands on the main body. A
// reference the plan cannot place (a waterline, a part it does not have) is read by the part's own sizes as before.
import type { PilotMachine } from '@slicerx/contracts'
import { type ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, type PartPlan } from '../src/design-check'
import { planDetailFields, REFERENCE_TOP } from '../src/plan-detail'
import { readSizes, sizeReference, type SizeLookup } from '../src/real-lookup'
import { z } from 'zod'
import { PLAN_GO, PlanToolInputSchema } from '../src/tab-tools'
import { createCardPlans, tabToolset } from '../src/toolset'
import type { DesignHost } from '@slicerx/cad-history'

const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }
/** A plan as design.plan's input takes it. */
type PlanInput = z.input<typeof PlanToolInputSchema>
type Features = NonNullable<PlanInput['features']>

const SOURCES = [{ title: 'Stone tower facts', url: 'https://example.org/stone-tower' }]

/**
 * The recorded chat's lookup, made neutral: the same figures under a tower's names, each tagged as design.lookup_sizes
 * now tags it. It also asked for the chimneys' spacing and found none, so a plan may name it as not given.
 */
const LOOKUP: Omit<SizeLookup, 'id' | 'session'> = {
  subject: 'Stone tower',
  asked: ['Overall length', 'Maximum beam', 'Chimney height above base', 'Tower height base to top deck', 'Chimney spacing'],
  found: [
    { size: 'Maximum beam', mm: 28190, said: '28.19 m' },
    { size: 'Chimney height above base', mm: 53300, said: '53.3 m', from: 'base' },
    { size: 'Tower height base to top deck', mm: 18440.4, said: '60.5 ft', from: 'base' },
  ],
  missing: ['Overall length', 'Chimney spacing'],
  sources: SOURCES,
  searched: true,
}

/** The recorded first plan's features with the names changed and every figure as recorded, at 1:1250. */
const FEATURES: Features = [
  { name: 'Tower', kind: 'loft', sizes: { sections: 8, length: 215, beam: 22.5, height: 16.8 }, kinds: { sections: 'count' } },
  { name: 'Terrace house', kind: 'extrude', sizes: { length: 110, width: 14, height: 3 } },
  { name: 'Front house', kind: 'extrude', on: 'Tower', sizes: { length: 22, width: 14, height: 3 } },
  { name: 'Lookout', kind: 'extrude', on: 'Front house', sizes: { length: 6, width: 16, height: 2.5 } },
  { name: 'Chimney', kind: 'extrude', sizes: { diameter: 5.4, height: 14 } },
  { name: 'Chimney array', kind: 'array', sizes: { count: 4, spacing: 17 }, kinds: { count: 'count' } },
  { name: 'Front pole', kind: 'extrude', sizes: { diameter: 1.2, height: 10 } },
  { name: 'Rear pole', kind: 'extrude', sizes: { diameter: 1.2, height: 8 } },
  { name: 'Rear house', kind: 'extrude', sizes: { length: 18, width: 10, height: 2 } },
  { name: 'Bench rows', kind: 'extrude', sizes: { length: 60, width: 1.2, height: 1.5 } },
]

/** The recorded first plan, names changed: its chimney's real row measured from the base, its chimney 14 mm tall with no on. */
const FIRST: PlanInput = {
  part: 'Stone tower',
  units: 'mm',
  detail: 'display',
  scale: '1250',
  proportions: 'lookup_1: beam 28.19 m, chimney top 53.3 m above base, base to top deck 18.44 m; length 269 m, scaled 1:1250',
  realBody: { feature: 'Tower', size: 'beam', mm: 28190, source: 'lookup', lookupId: 'lookup_1' },
  real: [
    { feature: 'Chimney', size: 'height above base', mm: 53300, lookup: 'lookup_1' },
    { feature: 'Tower', size: 'height', mm: 18440, lookup: 'lookup_1' },
  ],
  curved: ['Tower'],
  flat: ['Terrace house'],
  features: FEATURES,
  overall: { x: 215, y: 22.5, z: 43 },
  repeats: ['Chimneys'],
  assumptions: ['Scale 1:1250, 215 mm long so it fits any common bed', 'Single filament, no color', 'Chimneys sit on the terrace house; small details omitted'],
  questions: [],
}

/** A feature of the plan with its fields changed. */
const change = (features: Features, name: string, f: Partial<Features[number]>): Features => features.map((x) => (x.name === name ? { ...x, ...f } : x))

/**
 * The first plan with only its reference row in question: its flat body given with its levels, the chimneys' spacing
 * named as not given, and the chimney standing where its assumption puts it, on the terrace house on the tower.
 */
const TAKEN: PlanInput = {
  ...FIRST,
  flat: [{ feature: 'Terrace house', levels: ['Terrace house'] }],
  features: change(change(FEATURES, 'Terrace house', { on: 'Tower' }), 'Chimney', { on: 'Terrace house' }),
  assumptions: [...FIRST.assumptions!, 'real: Chimney array spacing not given by the source'],
}

/** TAKEN with the chimney's fields and its real row changed. */
const withChimney = (chimney: Partial<Features[number]>, row: Partial<NonNullable<PlanInput['real']>[number]>, base: PlanInput = TAKEN): PlanInput => ({
  ...base,
  features: change(base.features!, 'Chimney', chimney),
  real: [{ ...base.real![0]!, ...row }, base.real![1]!],
})

/** The tab's design.plan in one chat with web lookups, `lookups` already run, every card answered Go. */
function tab(lookups: Omit<SizeLookup, 'id' | 'session'>[] = [LOOKUP]) {
  const card = createCardPlans(createPlanRegistry())
  for (const l of lookups) card.lookups.add({ ...l, session: 's1' })
  const tools = tabToolset({ list: () => [], get: () => undefined } as unknown as DesignHost, card, { nozzleMm: () => machine.nozzle, newPlanId: () => 'plan_1' })
  const plan = tools.find((t) => t.name === 'design.plan')!
  const shown: (PartPlan | null)[] = []
  const web = async () => ({ text: '', citations: [] })
  const ctx = {
    sessionId: 's1',
    web,
    context: { project: 'creative', machine, objects: [] },
    ask: async (q: { choices: { id: string }[] }) => {
      const go = q.choices.find((c) => c.id.startsWith(`${PLAN_GO}:`))!.id
      shown.push(card.planById(go.slice(PLAN_GO.length + 1)))
      return { id: go }
    },
  } as unknown as ToolContext
  return { card, shown, plan: (input: unknown) => plan.run(plan.input.parse(input) as never, ctx) }
}

/** The refusal design.plan gives, as text, or null when it takes the plan. */
async function refusal(t: ReturnType<typeof tab>, input: PlanInput): Promise<string | null> {
  try {
    const out = await t.plan(input)
    return out.ok === false ? out.summary : null
  } catch (e) {
    return (e as Error).message
  }
}

const NO_SIZE_NAMED = 'real: Chimney has no size named'

describe('reading what a size name measures from', () => {
  it('reads the reference after above, over or from, or before to, from a name that measures up', () => {
    expect(sizeReference('Chimney height above base')).toBe('base')
    expect(sizeReference('Funnel height above keel')).toBe('keel')
    expect(sizeReference('Height keel to chimney top')).toBe('keel')
    expect(sizeReference('Tower height base to top deck')).toBe('base')
    expect(sizeReference('Height base to top of chimneys')).toBe('base')
    expect(sizeReference('Spire height from the ground')).toBe('ground')
    expect(sizeReference('Mast height above ground level')).toBe('ground')
    expect(sizeReference('Tower height above mean sea level')).toBe('sea level')
    expect(sizeReference('Chimney height (above the deck)')).toBe('deck')
    expect(sizeReference('Chimney height above top terrace')).toBe('top terrace')
  })

  it('reads no reference from a part\'s own size, or from a size that does not measure up', () => {
    expect(sizeReference('height')).toBeUndefined()
    expect(sizeReference('Chimney height')).toBeUndefined()
    expect(sizeReference('Wall height to the roof')).toBeUndefined()
    expect(sizeReference('Length bow to stern')).toBeUndefined()
    expect(sizeReference('Distance from the shore')).toBeUndefined()
    expect(sizeReference('Overall height')).toBeUndefined()
  })
})

describe('the words for a height measured from a reference', () => {
  it('says a reference row whose top is off scale gives where the top sits', () => {
    expect(REFERENCE_TOP('Funnel', 'height above keel')).toBe("real: Funnel's height above keel is where its top sits, not its own height: keep it as given, and the plan checks it against the top of Funnel where it stands")
  })

  it('says in design.plan\'s real that such a size gives where the part\'s top sits', () => {
    expect(planDetailFields.real.description).toContain("Each is held to scale against the size the lookup found. A real size measured from a reference (above keel, above deck, above ground) gives where the part's top sits, not the part's own height. An empty list for a made-up thing")
  })
})

describe('design.lookup_sizes tags a size measured from a reference', () => {
  it('tags "height above base" with from base, and leaves "height" untagged', () => {
    const { found } = readSizes('Chimney height above base: 53.3 m\nChimney height: 19 m', ['Chimney height above base', 'Chimney height'])
    expect(found).toEqual([
      { size: 'Chimney height above base', mm: 53300, said: '53.3 m', from: 'base' },
      { size: 'Chimney height', mm: 19000, said: '19 m' },
    ])
  })

  it('returns the tag in the lookup it keeps and answers with', async () => {
    const card = createCardPlans(createPlanRegistry())
    const tools = tabToolset({ list: () => [], get: () => undefined } as unknown as DesignHost, card, { nozzleMm: () => machine.nozzle })
    const lookup = tools.find((t) => t.name === 'design.lookup_sizes')!
    const web = async () => ({ text: 'Chimney height above base: 53.3 m\nChimney height: 19 m', citations: [{ id: SOURCES[0]!.url, ...SOURCES[0]!, kind: 'web' }] })
    const ctx = { sessionId: 's1', web, context: { project: 'creative', machine, objects: [] } } as unknown as ToolContext
    const out = await lookup.run(lookup.input.parse({ subject: 'Stone tower', sizes: ['Chimney height above base', 'Chimney height'] }) as never, ctx)
    expect((out.output as { found: unknown[] }).found).toEqual([
      { size: 'Chimney height above base', mm: 53300, said: '53.3 m', from: 'base' },
      { size: 'Chimney height', mm: 19000, said: '19 m' },
    ])
    expect(card.lookups.of('s1')[0]!.found[0]!.from).toBe('base')
  })
})

describe('design.plan holds a height measured from a reference against the part\'s top', () => {
  it('replays the recorded first plan: the reference row is held to the chimney\'s top, not refused for its name', async () => {
    const said = await refusal(tab(), FIRST)
    expect(said).not.toContain(NO_SIZE_NAMED)
    // the reference row holds the chimney's height, so the refusal no longer asks for it
    expect(said).not.toContain('give the real Chimney height')
    // with no on, the chimney stands on the tower, 16.8 mm, and its top is 30.8 mm: just past a third under the
    // 42.6 mm the looked-up 53.3 m gives
    expect(said).toContain("real: Chimney's height above base is where its top sits, not its own height: keep it as given, and the plan checks it against the top of Chimney where it stands. Chimney height above base is 30.8 mm, 0.7 times the 42.6 mm its real 53300 mm gives at 1:1250; size it from the real one")
  })

  it('takes the recorded first plan with only its reference row in question, its 14 mm chimney kept', async () => {
    const t = tab()
    const out = await t.plan(TAKEN)
    expect(out.ok).not.toBe(false)
    expect(out.output).toMatchObject({ planId: 'plan_1', accepted: true })
    expect(t.shown[0]!.features.find((f) => f.name === 'Chimney')!.sizes).toEqual({ diameter: 5.4, height: 14 })
  })

  it('refuses a reference row whose part\'s top is off scale, with the size, its reference, the wanted top and the planned one', async () => {
    // the recorded second plan's chimney: 42.6 mm tall on top of the tower and the terrace house
    const tall = withChimney({ sizes: { diameter: 5.4, height: 42.6 } }, {})
    const said = await refusal(tab(), tall)
    expect(said).toContain("real: Chimney's height above base is where its top sits, not its own height: keep it as given, and the plan checks it against the top of Chimney where it stands. Chimney height above base is 62.4 mm, 1.5 times the 42.6 mm its real 53300 mm gives at 1:1250; size it from the real one")
    expect(said).not.toContain(NO_SIZE_NAMED)
  })

  it('reads the reference from the lookup\'s tag when the row names the part\'s own height', async () => {
    // the recorded second plan tied the looked-up 53.3 m to the chimney's height; the tag says it is measured from the base
    const said = await refusal(tab(), withChimney({ sizes: { diameter: 5.4, height: 42.6 } }, { size: 'height' }))
    expect(said).toContain('Chimney height above base is 62.4 mm, 1.5 times the 42.6 mm its real 53300 mm gives at 1:1250; size it from the real one')
    expect(await refusal(tab(), withChimney({}, { size: 'height' }))).toBeNull()
  })

  it('reads an untagged row by its size name: "height above keel" with a lookup that gave no tag', async () => {
    // an older lookup: its found size has no from
    const older = { ...LOOKUP, asked: [...LOOKUP.asked.slice(0, 2), 'Chimney height above keel', ...LOOKUP.asked.slice(3)], found: [LOOKUP.found[0]!, { size: 'Chimney height above keel', mm: 53300, said: '53.3 m' }, { size: 'Tower height base to top deck', mm: 18440.4, said: '60.5 ft' }] }
    expect(await refusal(tab([older]), withChimney({}, { size: 'height above keel' }))).toBeNull()
    const said = await refusal(tab([older]), withChimney({ sizes: { diameter: 5.4, height: 42.6 } }, { size: 'height above keel' }))
    expect(said).toContain('Chimney height above keel is 62.4 mm, 1.5 times the 42.6 mm its real 53300 mm gives at 1:1250; size it from the real one')
    expect(said).not.toContain(NO_SIZE_NAMED)
  })
})

describe('where a part stands, for its top', () => {
  // a real top of 80 m gives 64 mm at 1:1250, far over each top below, so each refusal says the top the plan gives
  const far = { mm: 80000 }
  const asked = (mm: number) => [{ ...LOOKUP, found: [...LOOKUP.found, { size: 'Chimney height above base', mm, said: `${mm / 1000} m`, from: 'base' }] }]

  it('stands a part with on on what it names: the tower, then the front house on it, then the lookout on that', async () => {
    const at = async (on: string): Promise<string | null> => refusal(tab(asked(80000)), withChimney({ on }, far))
    expect(await at('Tower')).toContain('Chimney height above base is 30.8 mm, 0.5 times the 64 mm its real 80000 mm gives at 1:1250')
    expect(await at('Front house')).toContain('Chimney height above base is 33.8 mm, 0.5 times the 64 mm its real 80000 mm gives at 1:1250')
    expect(await at('Lookout')).toContain('Chimney height above base is 36.3 mm, 0.6 times the 64 mm its real 80000 mm gives at 1:1250')
  })

  it('stands a part with no on on the main body with the most bulk, not on a smaller main body', async () => {
    // the tower, 16.8 mm, not the terrace house, a main body too, which stands on it and is far smaller
    const said = await refusal(tab(asked(80000)), withChimney({ on: undefined }, far))
    expect(said).toContain('Chimney height above base is 30.8 mm, 0.5 times the 64 mm its real 80000 mm gives at 1:1250')
  })

  it('measures from a planned part by its name, and from a deck as the top of what the part stands on', async () => {
    const lookups = [{ ...LOOKUP, found: [...LOOKUP.found, { size: 'Chimney height above front house', mm: 17500, said: '17.5 m', from: 'front house' }, { size: 'Chimney height above deck', mm: 35000, said: '35 m', from: 'deck' }] }]
    // on the front house, the chimney's top is its own 14 mm over the front house's top
    expect(await refusal(tab(lookups), withChimney({ on: 'Front house' }, { size: 'height above front house', mm: 17500 }))).toBeNull()
    expect(await refusal(tab(lookups), withChimney({ on: 'Front house' }, { size: 'height above deck', mm: 35000 }))).toContain('Chimney height above deck is 14 mm, 0.5 times the 28 mm its real 35000 mm gives at 1:1250')
  })
})

describe('a reference the plan cannot place', () => {
  const lookups = [{ ...LOOKUP, found: [...LOOKUP.found, { size: 'Chimney height above waterline', mm: 40000, said: '40 m', from: 'waterline' }, { size: 'Chimney height above belfry', mm: 41000, said: '41 m', from: 'belfry' }] }]

  it('keeps the refusal for a row named for a waterline, or for a part the plan does not have', async () => {
    // a plan gives no height for a waterline or a belfry it does not plan, so the row cannot be checked where it stands
    expect(await refusal(tab(lookups), withChimney({}, { size: 'height above waterline', mm: 40000 }))).toContain('real: Chimney has no size named height above waterline; tie the real size to one of its sizes (diameter, height)')
    expect(await refusal(tab(lookups), withChimney({}, { size: 'height above belfry', mm: 41000 }))).toContain('real: Chimney has no size named height above belfry; tie the real size to one of its sizes (diameter, height)')
  })

  it('holds a row that names the part\'s own height, tagged from a waterline, to that height as before', async () => {
    // 40 m at 1:1250 is 32 mm against the chimney's own 14 mm
    expect(await refusal(tab(lookups), withChimney({}, { size: 'height', mm: 40000 }))).toContain('Chimney height is 14 mm, 0.4 times the 32 mm its real 40000 mm gives at 1:1250; size it from the real one')
  })
})
