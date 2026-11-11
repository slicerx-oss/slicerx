// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plan's detail level: basic, display or fine. A display or fine plan names each main body, curved or flat-sided, and
// the feature that builds it; a curved body is lofted, revolved or swept through smooth sections, never one extrude;
// its proportions come from a lookup or a stated source; and the real object's repeated details get a pass by
// pattern. The rules are about the object: a toy boat's hull and a model car's body are curved, a house is flat-sided
// and passes without a loft.
import type { PilotMachine } from '@slicerx/contracts'
import { type ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { type BodyFacts, createPlanRegistry, designCheck, partPlanSchema, type PartPlan } from '../src/design-check'
import { DETAIL_HELP, detailProblem, featuresFloor, loftSections, sectionsProblem } from '../src/plan-detail'
import { PLAN_GO, type PlanInput } from '../src/tab-tools'
import { createCardPlans, designToolset, tabToolset } from '../src/toolset'
import type { DesignHost } from '@slicerx/cad-history'

const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }

/** A toy boat at display detail: a lofted hull split at its waterline, a cabin, portholes and rail posts arrayed. */
const boat: PlanInput = {
  part: 'Toy boat',
  units: 'mm',
  detail: 'display',
  curved: ['Lower hull', 'Upper hull'],
  flat: ['Cabin'],
  proportions: 'lookup: a 6 m launch, 2.2 m beam, scaled 1:40',
  scale: '1:40',
  real: [{ feature: 'Lower hull', size: 'length', value: 6, unit: 'm' }, { feature: 'Cabin', size: 'length', value: 2, unit: 'm' }],
  tiers: [{ body: 'Cabin', levels: ['Cabin', 'Cabin roof'] }],
  repeats: ['portholes', 'rail posts'],
  colors: [
    { feature: 'Lower hull', color: 'red' },
    { feature: 'Upper hull', color: 'white' },
    { feature: 'Deck', color: 'tan' },
    { feature: 'Cabin', color: 'white' },
    { feature: 'Cabin roof', color: 'blue' },
    { feature: 'Rail posts', color: 'white' },
    { feature: 'Mast', color: 'brown' },
    { feature: 'Flag', color: 'yellow' },
  ],
  features: [
    { name: 'Lower hull', kind: 'loft', sizes: { length: 150, beam: 55, height: 10, sections: 7 }, kinds: { sections: 'count' } },
    { name: 'Upper hull', kind: 'loft', sizes: { length: 150, beam: 55, height: 10, sections: 7 }, kinds: { sections: 'count' } },
    { name: 'Deck', kind: 'extrude', sizes: { length: 140, width: 50, height: 1 } },
    { name: 'Cabin', kind: 'extrude', sizes: { length: 50, width: 35, height: 15 } },
    { name: 'Cabin roof', kind: 'extrude', sizes: { length: 54, width: 39, height: 2 } },
    { name: 'Portholes', kind: 'array cut', sizes: { diameter: 3, pitch: 8, count: 5 }, kinds: { count: 'count' } },
    { name: 'Rail posts', kind: 'array and mirror', sizes: { diameter: 1, height: 5, count: 12 }, kinds: { count: 'count' } },
    { name: 'Mast', kind: 'loft', sizes: { height: 40, diameter: 3 } },
    { name: 'Flag', kind: 'extrude', sizes: { width: 8, height: 5, thickness: 1 } },
  ],
  assumptions: [],
  questions: [],
}

/** A model car at display detail: a lofted body, wheels arrayed and mirrored, lights and trim. */
const car: PlanInput = {
  part: 'Model car',
  units: 'mm',
  detail: 'display',
  curved: ['Body'],
  proportions: 'stated: a hatchback about 4 m long, 1.8 m wide, 1.5 m tall, scaled 1:43',
  scale: '1:43',
  real: [{ feature: 'Body', size: 'length', value: 4, unit: 'm' }, { feature: 'Wheels', size: 'diameter', value: 0.6, unit: 'm' }],
  repeats: ['wheels', 'headlights'],
  colors: [
    { feature: 'Body', color: 'red' },
    { feature: 'Wheels', color: 'black' },
    { feature: 'Bumpers', color: 'gray' },
    { feature: 'Headlights', color: 'white' },
    { feature: 'Tail lights', color: 'red' },
    { feature: 'Mirrors', color: 'red' },
    { feature: 'Spoiler', color: 'black' },
  ],
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
  part: 'House',
  units: 'mm',
  detail: 'display',
  flat: ['Walls', 'Roof'],
  proportions: 'stated: a two story house 10 m wide, 8 m deep, scaled 1:100',
  scale: '1:100',
  real: [{ feature: 'Walls', size: 'width', value: 10, unit: 'm' }],
  tiers: [{ body: 'Walls', levels: ['Walls'] }, { body: 'Roof', levels: ['Roof'] }],
  repeats: ['windows', 'steps'],
  colors: [
    { feature: 'Walls', color: 'white' },
    { feature: 'Roof', color: 'gray' },
    { feature: 'Door', color: 'blue' },
    { feature: 'Chimney', color: 'brick red' },
    { feature: 'Porch', color: 'white' },
    { feature: 'Steps', color: 'gray' },
    { feature: 'Window frames', color: 'white' },
  ],
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
  it('passes a toy boat whose curved hull is lofted through 7 sections at its waterline split, with proportions, colors and arrayed portholes', () => {
    expect(detailProblem(boat)).toBeNull()
  })

  it('passes a model car whose curved body is lofted through 5 sections', () => {
    expect(detailProblem(car)).toBeNull()
  })

  it('passes a house with no loft, since it is flat-sided', () => {
    expect(detailProblem(house)).toBeNull()
  })

  it('refuses a curved hull built as a single extrude, and says to loft it through at least 5 sections instead', () => {
    const p = detailProblem(withFeature(boat, 'Lower hull', { kind: 'extrude', sizes: { length: 150, beam: 55, height: 10 } }))
    expect(p).toContain('Lower hull builds a curved body, so do not build it as a single extrude')
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
    const { curved: _c, flat: _f, proportions: _p, repeats: _r, ...bare } = boat
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
    const extruded = withFeature(boat, 'Lower hull', { kind: 'extrude' })
    expect(detailProblem({ ...extruded, detail: 'basic' })).toBeNull()
    const { detail: _d, ...noLevel } = extruded
    expect(detailProblem(noLevel)).toBeNull()
  })

  it('refuses a display plan with fewer features than its level, and says what to add', () => {
    const two = { ...car, features: car.features.slice(0, 2), colors: car.colors!.slice(0, 1) }
    expect(detailProblem(two)).toContain('features: a display model plan of this object has at least 8 features (8 at display model); this one has 2')
    expect(detailProblem({ ...car, detail: 'fine', features: car.features.map((f) => (f.name === 'Body' ? { ...f, sizes: { ...f.sizes, sections: 8 } } : f)) })).toContain('at least 12 features')
  })

  it('asks a long object for more features, and one more for each repeated detail past three', () => {
    // 200 x 30 x 40: five times as long as its next size, so its detail spreads along it
    const long = { ...boat, overall: { x: 200, y: 30, z: 40 } }
    expect(featuresFloor(long, 'display')).toEqual({ count: 10, why: '8 at display model, 2 more for a long object, 5 times as long as its next size' })
    expect(detailProblem(long)).toContain('this one has 9')
    expect(featuresFloor({ ...boat, overall: { x: 150, y: 55, z: 60 } }, 'display').count).toBe(8)
    expect(featuresFloor({ repeats: ['a', 'b', 'c', 'd', 'e'] }, 'display')).toEqual({ count: 10, why: '8 at display model, 2 more for 5 repeated details' })
  })

  it('wants each body\'s color, and a body painted in two colors split at its line', () => {
    expect(detailProblem({ ...house, colors: undefined })).toContain("colors: give each feature's color as the real thing is painted")
    const painted = { ...house, colors: [...house.colors!, { feature: 'Walls', color: 'yellow' }] }
    expect(detailProblem(painted)).toContain('colors: Walls is white and yellow; split it at its color line into one feature per color')
    expect(detailProblem({ ...house, colors: house.colors!.filter((c) => c.feature !== 'Roof') })).toContain('colors: say what color Roof is')
    expect(detailProblem({ ...house, colors: [...house.colors!, { feature: 'Garden', color: 'green' }] })).toContain('colors: Garden is not a planned feature')
  })

  it('holds each real size to scale, and refuses a part far off the size its real one gives', () => {
    const big = withFeature(car, 'Wheels', { sizes: { diameter: 30, width: 6, count: 2 } })
    expect(detailProblem(big)).toContain('Wheels diameter is 30 mm, 2.2 times the 14 mm its real 0.6 m gives at 1:43; size it from the real one')
    // a third over scale passes: a display model thickens small parts so they print
    expect(detailProblem(withFeature(car, 'Wheels', { sizes: { diameter: 18, width: 6, count: 2 } }))).toBeNull()
    expect(detailProblem({ ...car, scale: undefined })).toContain('scale: give the scale the real sizes are held to, as 1:N')
    expect(detailProblem({ ...car, real: undefined })).toContain('real: list the real sizes the lookup or the stated source gives')
    expect(detailProblem({ ...car, real: [], scale: undefined })).toBeNull()
    expect(detailProblem({ ...house, real: [{ feature: 'Door', size: 'width', value: 1, unit: 'm' }] })).toContain("real: give a main body's real size too")
    expect(detailProblem({ ...house, real: [{ feature: 'Walls', size: 'span', value: 10, unit: 'm' }] })).toContain('real: Walls has no size named span')
    expect(partPlanSchema.shape.scale.safeParse('25').success).toBe(false)
  })

  it('refuses a part wider than the main body or taller than the whole model, with no source to check it against', () => {
    const plan = { ...car, real: [], scale: undefined, overall: { x: 93, y: 42, z: 35 } }
    expect(detailProblem(withFeature(plan, 'Wheels', { sizes: { diameter: 50, width: 6, count: 2 } }))).toContain("Wheels is 50 mm wide, more than the main body's 42 mm")
    expect(detailProblem(withFeature(plan, 'Spoiler', { sizes: { width: 36, height: 40, depth: 6 } }))).toContain("Spoiler is 40 mm tall, more than the whole model's 35 mm height")
    expect(detailProblem(plan)).toBeNull()
  })

  it('wants each flat-sided main body\'s levels, each a planned feature', () => {
    expect(detailProblem({ ...house, tiers: undefined })).toContain('tiers: give the levels of Walls from the bottom up')
    expect(detailProblem({ ...house, tiers: [{ body: 'Walls', levels: ['Ground floor', 'Upper floor'] }, { body: 'Roof', levels: ['Roof'] }] })).toContain('tiers: Ground floor, a level of Walls, is not a planned feature')
    // a curved body states no levels
    expect(detailProblem(car)).toBeNull()
  })

  it('names a body built by a feature the plan does not have', () => {
    expect(detailProblem({ ...house, flat: ['Shell'] })).toContain('flat: Shell is not a planned feature')
  })
})

/** The tab's design.plan over no design, answering each card with Go. */
function tab() {
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
  } as unknown as ToolContext
  return { tool, shown, run: (input: unknown) => tool.run(tool.input.parse(input) as never, ctx) }
}

describe('design.plan with a detail level', () => {
  it('is 1.6.0 and refuses a display plan that extrudes a curved body before any card shows', async () => {
    const t = tab()
    expect(t.tool.version).toBe('1.6.0')
    await expect(t.run(withFeature(boat, 'Lower hull', { kind: 'extrude' }))).rejects.toThrow('Lower hull builds a curved body, so do not build it as a single extrude')
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
    for (const step of ['a table of sections, each with the same number of points', 'sunk about 0.1 mm into it', 'at least two nozzle widths from edges and from each other', 'a loft between two ellipses, offset for the rake, then arrayed', 'Repeated small parts are one part, then array and mirror', 'Each color band of the real thing (a waterline, a stripe, a trim line) is its own part', 'a keel rising toward the ends', 'split at its line into one feature per color'])
      expect(d).toContain(step)
    await expect(tab().run({ ...car, proportions: undefined })).rejects.toThrow(DETAIL_HELP)
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
/** A hull section: flat bottom `b` wide at z `lo`, sides out to `w` at z `lo` + 9, upright to the deck at `hi`. */
const hullSection = (b: number, w: number, lo: number, hi: number) => [[-b / 2, lo], [b / 2, lo], [w / 2, lo + 9], [w / 2, hi], [-w / 2, hi], [-w / 2, lo + 9]]

/** A toy boat hull that only narrows toward its ends: every section stands from z 0 to the same deck at z 14. */
const boxHull = loftStep('Hull', [0, 15, 40, 100, 170, 195, 210, 220, 224].map((x, k) => [x, hullSection([1, 10, 12, 12, 12, 8, 4, 2, 0.6][k]!, [2, 21, 23.5, 23.5, 23.5, 16, 9, 3.6, 1][k]!, 0, 14)] as [number, number[][]]))
/** The same hull with its keel rising toward the ends and its deck rising toward the bow, as the real thing does. */
const shapedHull = loftStep('Hull', [0, 15, 40, 100, 170, 195, 210, 220, 224].map((x, k) => [x, hullSection([1, 10, 12, 12, 12, 8, 4, 2, 0.6][k]!, [2, 21, 23.5, 23.5, 23.5, 16, 9, 3.6, 1][k]!, [3, 1, 0, 0, 0, 0.5, 1.5, 3, 5][k]!, [15, 14.3, 14, 14, 14, 14.4, 15, 15.6, 16][k]!)] as [number, number[][]]))

describe('sectionsProblem: a curved body changes along its length both ways across it', () => {
  it('fails a hull whose sections only narrow toward the ends, and names the size that never changes', () => {
    const [l] = loftSections([boxHull])
    expect(l!.feature).toBe('Hull')
    expect(l!.sections).toHaveLength(9)
    expect(sectionsProblem('Hull', l!)).toBe(
      "Hull: all 9 sections span z 0 to 14 mm; only its size in y changes along its length, so it reads as one outline stretched out. Change the sections' top and bottom along the length as the real thing does (a deck rising toward the bow, a keel rising at the ends, a roof sloping down to a hood), then check again",
    )
  })

  it('passes the same hull with its keel and deck rising toward the ends', () => {
    expect(sectionsProblem('Hull', loftSections([shapedHull])[0]!)).toBeNull()
  })

  it('passes a fuselage of circles that taper to its tail, and a raked funnel of one circle carried up at a slant', () => {
    const circles = (ds: number[]) => ({ feature: 'Fuselage', params: { op: 'sketch.loft', profiles: ds.map((d, k) => ({ frame: { origin: [k * 20, 0, 10], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, loops: [{ type: 'circle', center: [0, 0], diameterMm: d }] })) } })
    expect(sectionsProblem('Fuselage', loftSections([circles([6, 12, 14, 14, 10, 4])])[0]!)).toBeNull()
    // the same 6 mm circle at five heights, each 0.6 mm further aft: its size never changes, so it is not stretched
    const funnel = { feature: 'Funnel', params: { op: 'sketch.loft', profiles: [0, 1, 2, 3, 4].map((k) => ({ frame: { origin: [0, 0, 20 + k * 5], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, loops: [{ type: 'circle', center: [100 - k * 0.6, 0], diameterMm: 6 }] })) } }
    expect(sectionsProblem('Funnel', loftSections([funnel])[0]!)).toBeNull()
  })

  it('reads only loft steps, and leaves a loft of two sections alone', () => {
    expect(loftSections([{ feature: 'Cabin', params: { op: 'sketch.extrude' } }, { ...boxHull, suppressed: true }])).toEqual([])
    const two = loftStep('Mast', [[0, [[0, 0], [1, 0], [1, 1]]], [10, [[0, 0], [1, 0], [1, 1]]]])
    expect(sectionsProblem('Mast', loftSections([two])[0]!)).toBeNull()
  })
})

describe('designCheck on a display plan', () => {
  const plan: PartPlan = { planId: 'boat-1', ...boat, curved: ['Hull'], features: [{ name: 'Hull', kind: 'loft', sizes: { length: 224, sections: 9 } }], overall: { x: 224, y: 23.5, z: 16 } }
  const body = (l: ReturnType<typeof loftStep>, y = 23.5): BodyFacts => ({ size: { x: 224, y, z: 16 }, holes: [], features: 1, tags: ['Hull'], watertight: true, minWallMm: 1, lofts: loftSections([l]) })

  it('fails a curved body whose sections only narrow toward the ends, and passes one shaped both ways', () => {
    const box = designCheck(plan, body(boxHull), 0.4)
    expect(box.items.find((i) => i.name === 'curved bodies')).toMatchObject({ pass: false, got: expect.stringContaining('Hull: all 9 sections span z 0 to 14 mm') })
    expect(designCheck(plan, body(shapedHull), 0.4).items.find((i) => i.name === 'curved bodies')).toMatchObject({ pass: true, got: 'its loft is shaped along the length' })
    // a basic plan, or one with no level, is never held to it
    expect(designCheck({ ...plan, detail: 'basic' }, body(boxHull), 0.4).items.map((i) => i.name)).not.toContain('curved bodies')
  })

  it('passes an overall size a display model misses by under 5 percent, with a warning and no plan change', () => {
    const r = designCheck(plan, body(shapedHull, 24.66), 0.4)
    expect(r.items[0]).toMatchObject({ name: 'overall size', pass: true, warning: 'y +1.16 mm from the plan, within the 1 mm or 5 percent a display model is held to; no plan change needed, say it in the reply' })
    expect(designCheck(plan, body(shapedHull, 25.5), 0.4).items[0]!.pass).toBe(false)
    // a basic plan keeps the tight 0.2 mm or 1 percent
    expect(designCheck({ ...plan, detail: 'basic' }, body(shapedHull, 24.66), 0.4).items[0]!.pass).toBe(false)
  })
})
