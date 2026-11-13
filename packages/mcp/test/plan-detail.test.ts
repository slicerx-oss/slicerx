// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plan's detail level: basic, display or fine. A display or fine plan names each main body, curved or flat-sided, and
// the feature that builds it; a curved body is lofted, revolved or swept through smooth sections, never one extrude;
// its proportions come from a lookup or a stated source; and the real object's repeated details get a pass by
// pattern. The rules are about the object: a toy pod's shell and a model car's body are curved, a house is flat-sided
// and passes without a loft.
import type { PilotMachine } from '@slicerx/contracts'
import { type ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { type BodyFacts, colorBands, createPlanRegistry, designCheck, partPlanSchema, type PartPlan } from '../src/design-check'
import { DEFAULT_BED, DETAIL_HELP, detailProblem, displaySize, featuresFloor, loftSections, sectionsProblem, stackItem, STANDS_BASE_OFF, STANDS_FLOATS, STANDS_HEIGHT_OFF, STANDS_OFF, TIER_ON_DISAGREES } from '../src/plan-detail'
import { LocalPlanInputSchema, PLAN_GO, STANDS_ON_HELP, type PlanInput } from '../src/tab-tools'
import { createCardPlans, designToolset, tabToolset } from '../src/toolset'
import type { DesignHost } from '@slicerx/cad-history'

const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }

/** A toy pod at display detail: a lofted shell split at its color line, a canopy, vents and studs arrayed. */
const pod: PlanInput = {
  // these plans test the other rules; the bed fill has its own tests below
  personSize: true,
  part: 'Toy pod',
  units: 'mm',
  detail: 'display',
  curved: ['Lower shell', 'Upper shell'],
  flat: ['Canopy'],
  proportions: 'lookup: a 6 m capsule, 2.2 m wide, scaled 1:40',
  scale: 40,
  real: [{ feature: 'Lower shell', size: 'length', mm: 6000 }, { feature: 'Canopy', size: 'length', mm: 2000 }],
  tiers: { Canopy: ['Canopy', 'Canopy cap'] },
  repeats: ['vents', 'studs'],
  colors: { 'Lower shell': 'red', 'Upper shell': 'white', 'Floor': 'tan', 'Canopy': 'white', 'Canopy cap': 'blue', 'Studs': 'white', 'Antenna': 'brown', 'Fin': 'yellow' },
  features: [
    { name: 'Lower shell', kind: 'loft', sizes: { length: 150, width: 55, height: 10, sections: 7 }, kinds: { sections: 'count' } },
    { name: 'Upper shell', kind: 'loft', sizes: { length: 150, width: 55, height: 10, sections: 7 }, kinds: { sections: 'count' } },
    { name: 'Floor', kind: 'extrude', sizes: { length: 140, width: 50, height: 1 } },
    { name: 'Canopy', kind: 'extrude', sizes: { length: 50, width: 35, height: 15 } },
    { name: 'Canopy cap', kind: 'extrude', sizes: { length: 54, width: 39, height: 3 } },
    { name: 'Vents', kind: 'array cut', sizes: { diameter: 3, pitch: 8, count: 5 }, kinds: { count: 'count' } },
    { name: 'Studs', kind: 'array and mirror', sizes: { diameter: 1, height: 5, count: 12 }, kinds: { count: 'count' } },
    { name: 'Antenna', kind: 'loft', sizes: { height: 40, diameter: 3 } },
    { name: 'Fin', kind: 'extrude', sizes: { width: 8, height: 5, thickness: 1 } },
  ],
  assumptions: [],
  questions: [],
}

/** A model car at display detail: a lofted body, wheels arrayed and mirrored, lights and trim. */
const car: PlanInput = {
  // these plans test the other rules; the bed fill has its own tests below
  personSize: true,
  part: 'Model car',
  units: 'mm',
  detail: 'display',
  curved: ['Body'],
  proportions: 'stated: a hatchback about 4 m long, 1.8 m wide, 1.5 m tall, scaled 1:43',
  scale: 43,
  real: [{ feature: 'Body', size: 'length', mm: 4000 }, { feature: 'Wheels', size: 'diameter', mm: 600 }],
  repeats: ['wheels', 'headlights'],
  colors: { 'Body': 'red', 'Wheels': 'black', 'Bumpers': 'gray', 'Headlights': 'white', 'Tail lights': 'red', 'Mirrors': 'red', 'Spoiler': 'black' },
  features: [
    { name: 'Body', kind: 'loft', sizes: { length: 93, width: 42, height: 32, sections: 5 }, kinds: { sections: 'count' } },
    { name: 'Windows', kind: 'extrude cut', sizes: { depth: 0.6 } },
    { name: 'Wheels', kind: 'revolve, array and mirror', sizes: { diameter: 14, width: 6, count: 2 }, kinds: { count: 'count' } },
    { name: 'Bumpers', kind: 'extrude and mirror', sizes: { width: 40, height: 4, depth: 3 } },
    { name: 'Headlights', kind: 'extrude and mirror', sizes: { width: 6, height: 3, depth: 1 } },
    { name: 'Tail lights', kind: 'extrude and mirror', sizes: { width: 5, height: 3, depth: 1 } },
    { name: 'Mirrors', kind: 'extrude and mirror', sizes: { width: 3, height: 2, depth: 2 } },
    { name: 'Spoiler', kind: 'extrude', sizes: { width: 36, height: 2, depth: 6 } },
  ],
  assumptions: [],
  questions: [],
}

/** A house at display detail: flat-sided, so its walls and roof are extruded, and its windows and steps arrayed. */
const house: PlanInput = {
  // these plans test the other rules; the bed fill has its own tests below
  personSize: true,
  part: 'House',
  units: 'mm',
  detail: 'display',
  flat: ['Walls', 'Roof'],
  proportions: 'stated: a two story house 10 m wide, 8 m deep, scaled 1:100',
  scale: 100,
  real: [{ feature: 'Walls', size: 'width', mm: 10000 }],
  tiers: { Walls: ['Walls'], Roof: ['Roof'] },
  repeats: ['windows', 'steps'],
  colors: { 'Walls': 'white', 'Roof': 'gray', 'Door': 'blue', 'Chimney': 'brick red', 'Porch': 'white', 'Steps': 'gray', 'Window frames': 'white' },
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

const withFeature = (p: PlanInput, name: string, f: Partial<PlanInput['features'][number]>): PlanInput => ({ ...p, features: p.features.map((x) => (x.name === name ? { ...x, ...f } : x)) })

describe('detailProblem: the rules are about the object', () => {
  it('passes a toy pod whose curved shell is lofted through 7 sections at its color line split, with proportions, colors and arrayed vents', () => {
    expect(detailProblem(pod)).toBeNull()
  })

  it('passes a model car whose curved body is lofted through 5 sections', () => {
    expect(detailProblem(car)).toBeNull()
  })

  it('passes a house with no loft, since it is flat-sided', () => {
    expect(detailProblem(house)).toBeNull()
  })

  it('refuses a curved shell built as a single extrude, and says to loft it through at least 5 sections instead', () => {
    const p = detailProblem(withFeature(pod, 'Lower shell', { kind: 'extrude', sizes: { length: 150, width: 55, height: 10 } }))
    expect(p).toContain('Lower shell builds a curved body, so do not build it as a single extrude')
    expect(p).toContain('plan it as a loft through 5 or more smooth sections along its length')
  })

  it('refuses a curved car body lofted through 3 sections, and a fine one under 8', () => {
    expect(detailProblem(withFeature(car, 'Body', { sizes: { length: 93, width: 42, height: 32, sections: 3 } }))).toContain('Body goes through 3 sections; a display model plan lofts or sweeps a curved body through at least 5')
    expect(detailProblem({ ...car, detail: 'fine' })).toContain('through at least 8')
    // a fine plan also has 12 features or more: the car's 8 and four more details pass
    const more = ['Grille', 'Door handles', 'Exhaust', 'Antenna'].map((name) => ({ name, kind: 'extrude', sizes: { width: 2 } }))
    expect(detailProblem(withFeature({ ...car, detail: 'fine', features: [...car.features, ...more] }, 'Body', { sizes: { length: 93, sections: 8 } }))).toBeNull()
  })

  it('refuses a display plan with no bodies, no proportions or no repeats, each in words that say what to plan', () => {
    const { curved: _c, flat: _f, proportions: _p, repeats: _r, ...bare } = pod
    const p = detailProblem(bare)!
    expect(p).toContain('curved, flat: a display model plan names the features that build each main body')
    expect(p).toContain('proportions: say where the proportions come from, a lookup (web.lookup) or a stated source')
    expect(p).toContain("repeats: list the real object's repeated details")
  })

  it('refuses repeated details with no pattern pass, and takes an empty list for an object with none', () => {
    const noArray = withFeature(house, 'Windows', { kind: 'extrude cut' })
    const noArray2 = withFeature(withFeature(noArray, 'Steps', { kind: 'extrude' }), 'Window frames', { kind: 'extrude' })
    expect(detailProblem(noArray2)).toContain('repeats: windows, steps repeat on the real object, so plan at least one detail pass that builds one and patterns it')
    expect(detailProblem({ ...noArray2, repeats: [] })).toBeNull()
  })

  it('holds a basic plan, or one with no level, to none of it', () => {
    const extruded = withFeature(pod, 'Lower shell', { kind: 'extrude' })
    expect(detailProblem({ ...extruded, detail: 'basic' })).toBeNull()
    const { detail: _d, ...noLevel } = extruded
    expect(detailProblem(noLevel)).toBeNull()
  })

  it('refuses a display plan with fewer features than its level, and says what to add', () => {
    const two = { ...car, features: car.features.slice(0, 2), colors: { Body: 'red' } }
    expect(detailProblem(two)).toContain('features: a display model plan of this object has at least 8 features (8 at display model); this one has 2')
    expect(detailProblem({ ...car, detail: 'fine', features: car.features.map((f) => (f.name === 'Body' ? { ...f, sizes: { ...f.sizes, sections: 8 } } : f)) })).toContain('at least 12 features')
  })

  it('asks a long object for more features, and one more for each repeated detail past three', () => {
    // 200 x 30 x 40: five times as long as its next size, so its detail spreads along it
    const long = { ...pod, overall: { x: 200, y: 30, z: 40 } }
    expect(featuresFloor(long, 'display')).toEqual({ count: 10, why: '8 at display model, 2 more for a long object, 5 times as long as its next size' })
    expect(detailProblem(long)).toContain('this one has 9')
    expect(featuresFloor({ ...pod, overall: { x: 150, y: 55, z: 60 } }, 'display').count).toBe(8)
    expect(featuresFloor({ repeats: ['a', 'b', 'c', 'd', 'e'] }, 'display')).toEqual({ count: 10, why: '8 at display model, 2 more for 5 repeated details' })
  })

  it('plans no color unasked, and once color is asked wants each body\'s color, and a body of two colors as its lightest color with the other a band feature', () => {
    // a request that does not ask for color is one default filament: no colors, and nothing asks for them
    expect(detailProblem({ ...house, colors: undefined })).toBeNull()
    expect(detailProblem({ ...house, colors: {} })).toBeNull()
    expect(detailProblem({ ...house, colors: undefined, features: house.features.slice(0, 3) })).not.toMatch(/colors:|each color band/)
    for (const two of ['white and yellow', 'white/yellow', 'white, yellow'])
      expect(detailProblem({ ...house, colors: { ...house.colors, Walls: two } })).toContain(`colors: Walls is ${two}; give it its lightest large color, and each other color its own band feature with its color and its heights as sizes`)
    const { Roof: _roof, ...noRoof } = house.colors!
    expect(detailProblem({ ...house, colors: noRoof })).toContain('colors: say what color Roof is')
    expect(detailProblem({ ...house, colors: { ...house.colors, Garden: 'green' } })).toContain('colors: Garden is not a planned feature')
  })

  it('holds each real size to scale, and refuses a part far off the size its real one gives', () => {
    const big = withFeature(car, 'Wheels', { sizes: { diameter: 30, width: 6, count: 2 } })
    expect(detailProblem(big)).toContain('Wheels diameter is 30 mm, 2.2 times the 14 mm its real 600 mm gives at 1:43; size it from the real one')
    // a third over scale passes: a display model thickens small parts so they print
    expect(detailProblem(withFeature(car, 'Wheels', { sizes: { diameter: 18, width: 6, count: 2 } }))).toBeNull()
    expect(detailProblem({ ...car, scale: undefined })).toContain('scale: give N of the scale 1:N the real sizes are held to')
    expect(detailProblem({ ...car, real: undefined })).toContain('real: list the real sizes the lookup or the stated source gives')
    expect(detailProblem({ ...car, real: [], scale: undefined })).toBeNull()
    expect(detailProblem({ ...house, real: [{ feature: 'Door', size: 'width', mm: 1000 }] })).toContain("real: give a main body's real size too")
    expect(detailProblem({ ...house, real: [{ feature: 'Walls', size: 'span', mm: 10000 }] })).toContain('real: Walls has no size named span')
    expect(partPlanSchema.shape.scale.safeParse('25:1').success).toBe(false)
    expect(detailProblem({ ...car, scale: '1:43' })).toBeNull()
  })

  it('refuses a part wider than the main body or taller than the whole model, with no source to check it against', () => {
    const plan = { ...car, real: [], scale: undefined, overall: { x: 93, y: 42, z: 35 } }
    expect(detailProblem(withFeature(plan, 'Wheels', { sizes: { diameter: 50, width: 6, count: 2 } }))).toContain("Wheels is 50 mm wide, more than the main body's 42 mm")
    expect(detailProblem(withFeature(plan, 'Spoiler', { sizes: { width: 36, height: 40, depth: 6 } }))).toContain("Spoiler is 40 mm tall, more than the whole model's 35 mm height")
    expect(detailProblem(plan)).toBeNull()
  })

  it('wants each flat-sided main body\'s levels, each a planned feature', () => {
    expect(detailProblem({ ...house, tiers: undefined })).toContain('tiers: give the levels of Walls from the bottom up')
    expect(detailProblem({ ...house, tiers: { Walls: ['Ground floor', 'Upper floor'], Roof: ['Roof'] } })).toContain('tiers: Ground floor, a level of Walls, is not a planned feature')
    // a curved body states no levels
    expect(detailProblem(car)).toBeNull()
  })

  it('refuses a level whose on names another feature than the level before it, and takes one that agrees or names none', () => {
    const stacked = (on?: string): PlanInput => ({ ...house, flat: ['Walls'], tiers: { Walls: ['Walls', 'Roof'] }, features: house.features.map((f) => (f.name === 'Roof' ? { ...f, sizes: { width: 96, depth: 76, height: 30 }, ...(on ? { on } : {}) } : f)) })
    expect(TIER_ON_DISAGREES('Roof', 'Chimney', 'Walls', 'Walls')).toBe('on: Roof stands on Chimney, but the tiers of Walls put it on Walls; name Walls in its on, or take it out of the tier list')
    expect(detailProblem(stacked('Chimney'))).toContain('on: Roof stands on Chimney, but the tiers of Walls put it on Walls; name Walls in its on, or take it out of the tier list. ')
    expect(detailProblem(stacked('Walls'))).toBeNull()
    expect(detailProblem(stacked())).toBeNull()
  })

  it('says in its description that a stacked feature names what it stands on', () => {
    expect(STANDS_ON_HELP).toBe('A stacked feature names in on the feature it stands on, its height planned above that one, and each part that makes the outline readable from afar has a real size.')
    expect(createCardPlans(createPlanRegistry()).planTool().description).toContain(`. ${STANDS_ON_HELP} The plan has:`)
  })

  it('reads no stacking from a plan with no on and no tiers', () => {
    expect(stackItem({ ...house, tiers: undefined }, { walls: { lo: 0, hi: 55 }, roof: { lo: 70, hi: 100 } })).toBeNull()
  })

  it('says each way a stacked part is off, word for word', () => {
    const plan = (height?: number) => ({ detail: 'display' as const, features: [{ name: 'Upper deckhouse', sizes: { height: 3 } }, { name: 'Funnel 1', sizes: height === undefined ? { diameter: 4 } : { height }, on: 'Upper deckhouse' }] })
    const got = (height: number | undefined, lo: number, hi: number) => stackItem(plan(height), { 'upper deckhouse': { lo: 18.1, hi: 21.15 }, 'funnel 1': { lo, hi } })!.got
    // sunk, with a height planned
    expect(got(15, 14.5, 29.5)).toBe('Funnel 1 stands on Upper deckhouse, but its base is 6.65 mm below its top, so 8.35 mm of it shows of a planned 15 mm; build it from the top of Upper deckhouse')
    // floating, with a height planned or not
    expect(got(15, 21.95, 36.95)).toBe('Funnel 1 stands on Upper deckhouse, but its base is 0.8 mm above its top, so it floats; build it from the top of Upper deckhouse')
    expect(got(undefined, 21.95, 36.95)).toBe('Funnel 1 stands on Upper deckhouse, but its base is 0.8 mm above its top, so it floats; build it from the top of Upper deckhouse')
    // on the top, its planned height not showing
    expect(got(15, 21.15, 29.5)).toBe('Funnel 1 stands on Upper deckhouse, but 8.35 mm of it shows of a planned 15 mm; make it 15 mm tall above the top of Upper deckhouse')
    // sunk, with no height planned: the base alone
    expect(got(undefined, 14.5, 29.5)).toBe('Funnel 1 stands on Upper deckhouse, but its base is 6.65 mm below its top; build it from the top of Upper deckhouse')
    // on the top with no height planned, and on the top showing its height, both pass
    expect(stackItem(plan(undefined), { 'upper deckhouse': { lo: 18.1, hi: 21.15 }, 'funnel 1': { lo: 21.1, hi: 25 } })!.pass).toBe(true)
    expect(stackItem(plan(15), { 'upper deckhouse': { lo: 18.1, hi: 21.15 }, 'funnel 1': { lo: 21.1, hi: 36.1 } })!.pass).toBe(true)
    expect([STANDS_OFF, STANDS_FLOATS, STANDS_HEIGHT_OFF, STANDS_BASE_OFF].every((f) => typeof f === 'function')).toBe(true)
  })

  it('reads no pair with a loose range on either side, since a bound for a top makes a part placed right look sunk or floating', () => {
    const plan = { detail: 'display' as const, features: [{ name: 'Rail', sizes: { height: 2 } }, { name: 'Post', sizes: { height: 10 }, on: 'Rail' }, { name: 'Deck', sizes: { height: 3 } }, { name: 'Arch', sizes: { height: 8 }, on: 'Deck' }] }
    // a post on a swept rail, and a swept arch on an extruded deck: both a bound, so neither pair is read
    expect(stackItem(plan, { rail: { lo: 0, hi: 4, loose: true }, post: { lo: 2, hi: 12 }, deck: { lo: 0, hi: 3 }, arch: { lo: 1, hi: 13, loose: true } })).toBeNull()
    // the same with exact ranges is read
    expect(stackItem(plan, { rail: { lo: 0, hi: 2 }, post: { lo: 2, hi: 12 }, deck: { lo: 0, hi: 3 }, arch: { lo: 3, hi: 11 } })).toMatchObject({ pass: true, got: '2 stacked parts on their supports' })
  })

  it('names a body built by a feature the plan does not have', () => {
    expect(detailProblem({ ...house, flat: ['Shell'] })).toContain('flat: Shell is not a planned feature')
  })
})

/** The tab's design.plan over no design, answering each card with Go; `local` as a local model calls it. */
function tab(local = false) {
  const card = createCardPlans(createPlanRegistry())
  const tools = tabToolset({ list: () => [], get: () => undefined } as unknown as DesignHost, card, { nozzleMm: () => machine.nozzle, newPlanId: () => 'plan_1' })
  const tool = tools.find((t) => t.name === 'design.plan')!
  const shown: (PartPlan | null)[] = []
  const ctx = {
    context: { project: 'creative', machine, objects: [] },
    ask: async (q: { choices: { id: string }[] }) => {
      shown.push(card.planById(q.choices[0]!.id.slice(PLAN_GO.length + 1)))
      return { id: q.choices[0]!.id }
    },
    ...(local ? { localForm: true } : {}),
  } as unknown as ToolContext
  return { tool, shown, run: (input: unknown) => tool.run(tool.input.parse(input) as never, ctx) }
}

describe('design.plan with a detail level', () => {
  it('is 1.10.0 and refuses a display plan that extrudes a curved body before any card shows', async () => {
    const t = tab()
    expect(t.tool.version).toBe('1.13.0')
    await expect(t.run(withFeature(pod, 'Lower shell', { kind: 'extrude' }))).rejects.toThrow('Lower shell builds a curved body, so do not build it as a single extrude')
    expect(t.shown).toEqual([])
  })

  it('shows a display plan that holds the rules on the card, with its level, bodies, proportions and repeats', async () => {
    const t = tab()
    const out = await t.run(house)
    expect(out.ok).not.toBe(false)
    expect(t.shown[0]).toMatchObject({ detail: 'display', flat: ['Walls', 'Roof'], proportions: house.proportions, repeats: ['windows', 'steps'], colors: house.colors })
  })

  it('tells the model the default, the rules and the general method in its description and in each refusal', async () => {
    const d = tab().tool.description
    expect(d).toContain('display for a model of a real thing named without sizes (the default)')
    expect(d).toContain('a flat-sided one (a house, a bookshelf) can be extruded')
    for (const step of ['a table of sections, each with the same number of points', 'sunk about 0.1 mm into it', 'at least two nozzle widths from edges and from each other', 'a loft between two ellipses, offset for the rake, then arrayed', 'Repeated small parts are one part, then array and mirror', 'is built whole in its lightest large color, and each darker band is its own feature', 'painted by direction top', 'its levels are continuous too', 'gives its lean in degrees as a size named rake', 'Plan the features a person recognizes the real thing by', 'a bottom lifting at the ends', 'each darker band its own feature, with its color and its heights as sizes, painted on by height'])
      expect(d).toContain(step)
    await expect(tab().run({ ...car, proportions: undefined })).rejects.toThrow(DETAIL_HELP)
  })

  it('shows a display plan with no colors, so the part builds in one default filament', async () => {
    const t = tab()
    const { colors: _colors, ...bare } = house
    const out = await t.run(bare)
    expect(out.ok).not.toBe(false)
    expect(t.shown[0]).toMatchObject({ detail: 'display', flat: ['Walls', 'Roof'] })
    expect(t.shown[0]!.colors).toBeUndefined()
    // with no color planned, the check reads no color band to paint
    expect(colorBands(t.shown[0]!)).toEqual([])
  })

  it('still plans colors when the person asks for them, held to the same rules', async () => {
    await expect(tab().run({ ...house, colors: { ...house.colors, Walls: 'white and yellow' } })).rejects.toThrow('colors: Walls is white and yellow')
    const t = tab()
    await t.run(house)
    expect(t.shown[0]!.colors).toEqual(house.colors)
  })

  it('holds a local model\'s display plan only to what its form can say', async () => {
    // the local form keeps detail and leaves out curved, flat, proportions, repeats, colors, scale, real and tiers
    const local = LocalPlanInputSchema.parse({ ...house })
    expect(Object.keys(local)).not.toContain('colors')
    expect(detailProblem(local)).toContain('curved, flat:')
    expect(detailProblem(local, undefined, { local: true })).toBeNull()
    const t = tab(true)
    const out = await t.run(local)
    expect(out.ok).not.toBe(false)
    expect(t.shown[0]).toMatchObject({ detail: 'display' })
    // it is still held to the feature count for its level
    expect(detailProblem({ ...local, features: local.features.slice(0, 2) }, undefined, { local: true })).toContain('features: it has at least 8 features')
    await expect(tab(false).run(local)).rejects.toThrow('curved, flat:')
  })

  it('leaves the level out of design.put_plan', () => {
    const put = designToolset({} as DesignHost, {}, { plans: createPlanRegistry() }).find((t) => t.name === 'design.put_plan')!
    const planShape = (put.input as unknown as { shape: { plan: { shape: Record<string, unknown> } } }).shape.plan.shape
    expect(Object.keys(planShape)).not.toContain('detail')
    for (const k of ['colors', 'scale', 'real', 'tiers']) expect(Object.keys(planShape)).not.toContain(k)
    expect(Object.keys(partPlanSchema.shape)).toContain('detail')
  })
})

/** A loft step along x through these sections, each an outline in the y-z plane (u is y, v is z). */
const loftStep = (feature: string, sections: [number, number[][]][]) => ({
  feature,
  params: { op: 'sketch.loft', profiles: sections.map(([x, pts]) => ({ frame: { origin: [x, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, loops: [{ points: pts }] })) },
})
/** A shell section: flat bottom `b` wide at z `lo`, sides out to `w` at z `lo` + 9, upright to the top at `hi`. */
const shellSection = (b: number, w: number, lo: number, hi: number) => [[-b / 2, lo], [b / 2, lo], [w / 2, lo + 9], [w / 2, hi], [-w / 2, hi], [-w / 2, lo + 9]]

/** A toy pod shell that only narrows toward its ends: every section stands from z 0 to the same top at z 14. */
const boxShell = loftStep('Shell', [0, 15, 40, 100, 170, 195, 210, 220, 224].map((x, k) => [x, shellSection([1, 10, 12, 12, 12, 8, 4, 2, 0.6][k]!, [2, 21, 23.5, 23.5, 23.5, 16, 9, 3.6, 1][k]!, 0, 14)] as [number, number[][]]))
/** The same shell with its bottom rising toward the ends and its top rising toward the front, as the real thing does. */
const shapedShell = loftStep('Shell', [0, 15, 40, 100, 170, 195, 210, 220, 224].map((x, k) => [x, shellSection([1, 10, 12, 12, 12, 8, 4, 2, 0.6][k]!, [2, 21, 23.5, 23.5, 23.5, 16, 9, 3.6, 1][k]!, [3, 1, 0, 0, 0, 0.5, 1.5, 3, 5][k]!, [15, 14.3, 14, 14, 14, 14.4, 15, 15.6, 16][k]!)] as [number, number[][]]))

describe('sectionsProblem: a curved body changes along its length both ways across it', () => {
  it('fails a shell whose sections only narrow toward the ends, and names the size that never changes', () => {
    const [l] = loftSections([boxShell])
    expect(l!.feature).toBe('Shell')
    expect(l!.sections).toHaveLength(9)
    expect(sectionsProblem('Shell', l!)).toBe(
      "Shell: all 9 sections span z 0 to 14 mm; only its size in y changes along its length, so it reads as one outline stretched out. Change the sections' top and bottom along the length as the real thing does (a top line rising toward the ends, a bottom lifting at the ends, a roof sloping down to a hood), then check again",
    )
  })

  it('passes the same shell with its bottom and top rising toward the ends', () => {
    expect(sectionsProblem('Shell', loftSections([shapedShell])[0]!)).toBeNull()
  })

  it('passes a fuselage of circles that taper to its tail, and a raked tube of one circle carried up at a slant', () => {
    const circles = (ds: number[]) => ({ feature: 'Fuselage', params: { op: 'sketch.loft', profiles: ds.map((d, k) => ({ frame: { origin: [k * 20, 0, 10], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, loops: [{ type: 'circle', center: [0, 0], diameterMm: d }] })) } })
    expect(sectionsProblem('Fuselage', loftSections([circles([6, 12, 14, 14, 10, 4])])[0]!)).toBeNull()
    // the same 6 mm circle at five heights, each 0.6 mm further aft: its size never changes, so it is not stretched
    const tube = { feature: 'Tube', params: { op: 'sketch.loft', profiles: [0, 1, 2, 3, 4].map((k) => ({ frame: { origin: [0, 0, 20 + k * 5], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, loops: [{ type: 'circle', center: [100 - k * 0.6, 0], diameterMm: 6 }] })) } }
    expect(sectionsProblem('Tube', loftSections([tube])[0]!)).toBeNull()
  })

  it('reads only loft steps, and leaves a loft of two sections alone', () => {
    expect(loftSections([{ feature: 'Canopy', params: { op: 'sketch.extrude' } }, { ...boxShell, suppressed: true }])).toEqual([])
    const two = loftStep('Antenna', [[0, [[0, 0], [1, 0], [1, 1]]], [10, [[0, 0], [1, 0], [1, 1]]]])
    expect(sectionsProblem('Antenna', loftSections([two])[0]!)).toBeNull()
  })
})

describe('designCheck on a display plan', () => {
  const plan: PartPlan = { planId: 'pod-1', ...pod, curved: ['Shell'], features: [{ name: 'Shell', kind: 'loft', sizes: { length: 224, sections: 9 } }], overall: { x: 224, y: 23.5, z: 16 } }
  const body = (l: ReturnType<typeof loftStep>, y = 23.5): BodyFacts => ({ size: { x: 224, y, z: 16 }, holes: [], features: 1, tags: ['Shell'], watertight: true, minWallMm: 1, lofts: loftSections([l]) })

  it('fails a curved body whose sections only narrow toward the ends, and passes one shaped both ways', () => {
    const box = designCheck(plan, body(boxShell), 0.4)
    expect(box.items.find((i) => i.name === 'curved bodies')).toMatchObject({ pass: false, got: expect.stringContaining('Shell: all 9 sections span z 0 to 14 mm') })
    expect(designCheck(plan, body(shapedShell), 0.4).items.find((i) => i.name === 'curved bodies')).toMatchObject({ pass: true, got: 'its loft is shaped along the length' })
    // a basic plan, or one with no level, is never held to it
    expect(designCheck({ ...plan, detail: 'basic' }, body(boxShell), 0.4).items.map((i) => i.name)).not.toContain('curved bodies')
  })

  it('passes an overall size a display model misses by under 5 percent, with a warning and no plan change', () => {
    const r = designCheck(plan, body(shapedShell, 24.66), 0.4)
    expect(r.items[0]).toMatchObject({ name: 'overall size', pass: true, warning: 'y +1.16 mm from the plan, within the 1 mm or 5 percent a display model is held to; no plan change needed, say it in the reply' })
    expect(designCheck(plan, body(shapedShell, 25.5), 0.4).items[0]!.pass).toBe(false)
    // a basic plan keeps the tight 0.2 mm or 1 percent
    expect(designCheck({ ...plan, detail: 'basic' }, body(shapedShell, 24.66), 0.4).items[0]!.pass).toBe(false)
  })
})

describe('a display model the person gave no size for fills the bed', () => {
  // neutral samples: a figure, a building and a vase, each planned at some size the model picked itself
  const figure: PlanInput = { ...car, personSize: undefined, part: 'Figure', overall: { x: 40, y: 30, z: 120 } }
  const building: PlanInput = { ...house, personSize: undefined, overall: { x: 100, y: 80, z: 85 } }
  const vase: PlanInput = { ...car, personSize: undefined, part: 'Vase', overall: { x: 60, y: 60, z: 150 } }
  const bed180 = { x: 180, y: 180, z: 180 }
  const bed256 = { x: 256, y: 256, z: 256 }

  it('sizes a building by its length to 85% of a 256 mm bed, and a tall figure and vase by their height', () => {
    const b = displaySize(building.overall!, bed256)!
    expect(b.by).toBe('its length')
    expect(Math.round(b.x * 10) / 10).toBe(217.6)
    const f = displaySize(figure.overall!, bed256)!
    expect(f.by).toBe('its height')
    expect(Math.round(f.z * 10) / 10).toBe(217.6)
    expect(Math.round(displaySize({ x: 60, y: 60, z: 120 }, bed180)!.z * 10) / 10).toBe(153)
    // a vase already 150 mm tall on a 180 mm bed is within the fill
    expect(displaySize(vase.overall!, bed180)).toBeNull()
    // within 6 percent of the fill it stands
    expect(displaySize({ x: 210, y: 168, z: 178.5 }, bed256)).toBeNull()
  })

  it('refuses a plan sized by a scale the model picked, naming the size to plan and the printer', () => {
    const why = detailProblem(building, { bed: bed180, printer: 'Bambu Lab A1 mini' })!
    expect(why).toContain("overall: the person gave no size, so a display model is planned to fill about 85% of Bambu Lab A1 mini's usable 180 x 180 x 180 mm, set by its length: plan it 153 x 122.4 x 130.1 mm, not 100 x 80 x 85")
    expect(why).toContain('When the person gave a size, keep theirs and set personSize')
  })

  it('reads 256 mm when no printer is chosen, and says so', () => {
    expect(detailProblem(vase, { bed: DEFAULT_BED })).toContain('a 256 x 256 x 256 mm build volume, as no printer is chosen, set by its height: plan it 87 x 87 x 217.6 mm')
  })

  it('passes a plan at the fill, and keeps a size the person gave', () => {
    const sized = { ...building, overall: { x: 217.6, y: 174.1, z: 184.9 } }
    expect(detailProblem(sized, { bed: bed256 }) ?? '').not.toContain('overall:')
    expect(detailProblem({ ...building, personSize: true }, { bed: bed256 }) ?? '').not.toContain('overall:')
  })

  it('takes the bed from the printer in the tab, and DEFAULT_BED with none', async () => {
    const card = createCardPlans(createPlanRegistry())
    const tools = tabToolset({ list: () => [], get: () => undefined } as unknown as DesignHost, card, { nozzleMm: () => machine.nozzle, newPlanId: () => 'plan_1', bed: () => bed180 })
    const tool = tools.find((t) => t.name === 'design.plan')!
    const ctx = { context: { project: 'creative', machine: { ...machine, printer: 'Bambu Lab A1 mini' }, objects: [] }, ask: async (q: { choices: { id: string }[] }) => ({ id: q.choices[0]!.id }) } as unknown as ToolContext
    await expect(tool.run(tool.input.parse(building) as never, ctx)).rejects.toThrow("Bambu Lab A1 mini's usable 180 x 180 x 180 mm")
    expect(DEFAULT_BED).toEqual({ x: 256, y: 256, z: 256 })
  })
})

describe('a stepped body plans each level tall enough to read', () => {
  it('refuses stories planned as 2 mm slabs, and takes 3 mm levels', () => {
    const stories = (h: number): PlanInput => ({
      ...house,
      flat: ['Walls', 'Roof', 'Tower'],
      tiers: { Walls: ['Walls'], Roof: ['Roof'], Tower: ['Tower', 'Upper story'] },
      colors: { ...house.colors, Tower: 'white', 'Upper story': 'white' },
      features: [...house.features, { name: 'Tower', kind: 'extrude', sizes: { length: 60, width: 30, height: h } }, { name: 'Upper story', kind: 'extrude', sizes: { length: 40, width: 24, height: h } }],
    })
    expect(detailProblem(stories(2))).toContain('tiers: Tower, a level of Tower, is 2 mm tall, which reads as a thin slab at the whole-model view; give each level at least 3 mm')
    expect(detailProblem(stories(3)) ?? '').not.toContain('thin slab')
  })
})

describe('display rules any kind of object can use', () => {
  // a house: white walls with a dark plinth band painted on below 6 mm, and a chimney leaning 8 degrees
  const banded = {
    ...withFeature(house, 'Chimney', { sizes: { width: 8, depth: 8, height: 20, rake: 8 }, kinds: { rake: 'angle' } }),
    colors: { ...house.colors, 'Plinth band': 'dark gray' },
    features: [...withFeature(house, 'Chimney', { sizes: { width: 8, depth: 8, height: 20, rake: 8 }, kinds: { rake: 'angle' } }).features, { name: 'Plinth band', kind: 'paint', sizes: { below: 6 } }],
  } as PlanInput
  // a toy car: a white body with a blue band painted from 4 to 9 mm, and mirrors raked back 15 degrees
  const striped = {
    ...withFeature(car, 'Mirrors', { sizes: { width: 3, height: 2, depth: 2, rake: 15 }, kinds: { rake: 'angle' } }),
    colors: { ...car.colors, Body: 'white', 'Side band': 'blue' },
    features: [...withFeature(car, 'Mirrors', { sizes: { width: 3, height: 2, depth: 2, rake: 15 }, kinds: { rake: 'angle' } }).features, { name: 'Side band', kind: 'paint', sizes: { from: 4, to: 9 } }],
  } as PlanInput

  it('plans a light body with a darker band painted on by height, and an upright raked, on a building and on a vehicle', () => {
    for (const plan of [banded, striped]) expect(detailProblem(plan), plan.part).toBeNull()
    expect(colorBands(banded as unknown as PartPlan)).toEqual([{ name: 'Plinth band', color: 'dark gray', lo: 'bottom', hi: 6 }])
    expect(colorBands(striped as unknown as PartPlan)).toEqual([{ name: 'Side band', color: 'blue', lo: 4, hi: 9 }])
  })

  it('refuses one feature of two colors on either, with the way to plan it', () => {
    expect(detailProblem({ ...house, colors: { ...house.colors, Walls: 'white and gray' } })).toContain('give it its lightest large color, and each other color its own band feature')
    expect(detailProblem({ ...car, colors: { ...car.colors, Body: 'white and blue' } })).toContain('give it its lightest large color, and each other color its own band feature')
  })
})
