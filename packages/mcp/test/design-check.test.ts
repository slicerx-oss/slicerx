// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A built part checked against its plan: first the comparison on fixture bodies (the size tolerance, each named
// hole, the feature count, a closed body, the thinnest wall for the nozzle, an inch plan), then slicerx_design_check
// on real designs, whose facts are read from the body the steps made.
import type { Design as HostDesign, DesignHost } from '@slicerx/cad-history'
import type { ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { minWall } from '../src/body-facts'
import { createPlanRegistry, designCheck, FIX_ROUNDS, MAX_PLANS, partPlanSchema, PlanOwnedError, type BodyFacts, type PartPlan } from '../src/design-check'
import { designToolset } from '../src/toolset'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

const bracket: PartPlan = {
  planId: 'bracket-1',
  part: 'Bracket',
  units: 'mm',
  features: [
    { name: 'base', kind: 'extrude', sizes: { width: 60, depth: 30, thickness: 4 } },
    { name: 'upright', kind: 'extrude', sizes: { height: 40, thickness: 4 } },
    { name: 'mount holes', kind: 'hole', sizes: { diameter: 6 } },
  ],
  overall: { x: 60, y: 30, z: 40 },
  holes: [
    { name: 'mount hole', diameter: 6 },
    { name: 'cable hole', diameter: 4 },
  ],
  assumptions: ['M5 screws'],
  questions: [],
}

const built: BodyFacts = { size: { x: 60.05, y: 29.9, z: 40.3 }, holes: [{ diameterMm: 4.02 }, { diameterMm: 6.04 }], features: 3, watertight: true, minWallMm: 4 }

const failed = (r: ReturnType<typeof designCheck>) => r.items.filter((i) => !i.pass).map((i) => i.name)

describe('designCheck', () => {
  it('a matching bracket passes', () => {
    const r = designCheck(bracket, built, 0.4)
    expect(r.pass).toBe(true)
    expect(r.items.map((i) => i.name)).toEqual(['overall size', 'mount hole', 'cable hole', 'feature count', 'watertight', 'minimum wall'])
    expect(r.items.every((i) => i.pass)).toBe(true)
  })

  it('a 6 mm hole built at 5 mm fails that item only', () => {
    const r = designCheck(bracket, { ...built, holes: [{ diameterMm: 4 }, { diameterMm: 5 }] }, 0.4)
    expect(r.pass).toBe(false)
    expect(failed(r)).toEqual(['mount hole'])
    expect(r.items.find((i) => i.name === 'mount hole')).toEqual({ name: 'mount hole', want: '6 mm diameter', got: '5 mm diameter', pass: false })
  })

  it('a 0.6 mm wall fails for a 0.4 nozzle', () => {
    const r = designCheck(bracket, { ...built, minWallMm: 0.6 }, 0.4)
    expect(failed(r)).toEqual(['minimum wall'])
    expect(r.items.at(-1)).toMatchObject({ want: 'at least 0.8 mm (twice the 0.4 mm nozzle)', got: '0.6 mm' })
    // the same wall passes for a 0.25 nozzle
    expect(designCheck(bracket, { ...built, minWallMm: 0.6 }, 0.25).pass).toBe(true)
  })

  it('an open mesh fails watertight', () => {
    const r = designCheck(bracket, { ...built, watertight: false }, 0.4)
    expect(failed(r)).toEqual(['watertight'])
    expect(r.items.find((i) => i.name === 'watertight')).toMatchObject({ want: 'closed', got: 'open' })
  })

  it('holds sizes to 0.2 mm or 1 percent, whichever is larger, holes to 0.1 mm and the feature count exactly', () => {
    const small: PartPlan = { ...bracket, overall: { x: 10, y: 10, z: 10 }, holes: [{ name: 'pin', diameter: 3 }] }
    const body = (size: BodyFacts['size'], d = 3): BodyFacts => ({ ...built, size, holes: [{ diameterMm: d }] })
    expect(designCheck(small, body({ x: 10.2, y: 9.8, z: 10 }), 0.4).pass).toBe(true)
    expect(failed(designCheck(small, body({ x: 10.25, y: 10, z: 10 }), 0.4))).toEqual(['overall size'])
    // 1 percent of 60 is 0.6 mm
    expect(designCheck(bracket, { ...built, size: { x: 60.55, y: 30, z: 40 } }, 0.4).pass).toBe(true)
    expect(failed(designCheck(bracket, { ...built, size: { x: 60.65, y: 30, z: 40 } }, 0.4))).toEqual(['overall size'])
    expect(designCheck(small, body({ x: 10, y: 10, z: 10 }, 3.09), 0.4).pass).toBe(true)
    expect(failed(designCheck(small, body({ x: 10, y: 10, z: 10 }, 3.15), 0.4))).toEqual(['pin'])
    expect(failed(designCheck(bracket, { ...built, features: 4 }, 0.4))).toEqual(['feature count'])
  })

  it('a planned hole the body lacks fails as no hole', () => {
    const r = designCheck(bracket, { ...built, holes: [{ diameterMm: 6 }] }, 0.4)
    expect(r.items.find((i) => i.name === 'cable hole')).toMatchObject({ got: 'no hole', pass: false })
  })

  it('a hole the plan does not list fails as an extra hole; a plan without a hole list says nothing about holes', () => {
    const r = designCheck(bracket, { ...built, holes: [{ diameterMm: 4.02 }, { diameterMm: 5 }, { diameterMm: 6.04 }] }, 0.4)
    expect(failed(r)).toEqual(['extra hole, 5 mm'])
    expect(r.items.find((i) => !i.pass)).toEqual({ name: 'extra hole, 5 mm', want: 'no hole (not in the plan)', got: '5 mm diameter', pass: false })
    expect(failed(designCheck({ ...bracket, holes: [] }, built, 0.4))).toEqual(['extra hole, 4.02 mm', 'extra hole, 6.04 mm'])
    const { holes: _, ...noList } = bracket
    expect(designCheck(noList, built, 0.4).pass).toBe(true)
  })

  it('a row with a count stands for that many holes: four 3.4 mm holes pass as one row', () => {
    const motor: PartPlan = { ...bracket, holes: [{ name: 'motor screw holes', diameter: 3.4, count: 4 }, { name: 'pilot', diameter: 22 }] }
    const four = { ...built, holes: [{ diameterMm: 3.42 }, { diameterMm: 22 }, { diameterMm: 3.4 }, { diameterMm: 3.38 }, { diameterMm: 3.41 }] }
    const r = designCheck(motor, four, 0.4)
    expect(r.pass).toBe(true)
    expect(r.items.map((i) => i.name)).toEqual(['overall size', 'motor screw holes', 'pilot', 'feature count', 'watertight', 'minimum wall'])
    expect(r.items[1]).toEqual({ name: 'motor screw holes', want: '4 x 3.4 mm diameter', got: '3.38 mm, 3.4 mm, 3.41 mm, 3.42 mm diameter', pass: true })
    expect(designCheck(motor, { ...four, holes: [{ diameterMm: 22 }, ...Array(4).fill({ diameterMm: 3.4 })] }, 0.4).items[1]!.got).toBe('4 x 3.4 mm diameter')
  })

  it('a row of four with one missing fails that row with how many are short', () => {
    const motor: PartPlan = { ...bracket, holes: [{ name: 'motor screw holes', diameter: 3.4, count: 4 }] }
    const r = designCheck(motor, { ...built, holes: Array(3).fill({ diameterMm: 3.4 }) }, 0.4)
    expect(failed(r)).toEqual(['motor screw holes'])
    expect(r.items[1]).toEqual({ name: 'motor screw holes', want: '4 x 3.4 mm diameter', got: '3 x 3.4 mm diameter (1 short)', pass: false })
    expect(designCheck(motor, { ...built, holes: [] }, 0.4).items[1]).toMatchObject({ got: 'no holes', pass: false })
  })

  it('a row of four with one more of its size fails that row as a surplus, not as an extra hole', () => {
    const motor: PartPlan = { ...bracket, holes: [{ name: 'motor screw holes', diameter: 3.4, count: 4 }] }
    const r = designCheck(motor, { ...built, holes: [...Array(5).fill({ diameterMm: 3.4 }), { diameterMm: 8 }] }, 0.4)
    expect(failed(r)).toEqual(['motor screw holes', 'extra hole, 8 mm'])
    expect(r.items[1]).toEqual({ name: 'motor screw holes', want: '4 x 3.4 mm diameter', got: '5 x 3.4 mm diameter (1 more than planned)', pass: false })
    // a wrong size in the row shows among its diameters
    const wrong = designCheck(motor, { ...built, holes: [...Array(3).fill({ diameterMm: 3.4 }), { diameterMm: 4 }] }, 0.4)
    expect(wrong.items[1]).toMatchObject({ got: '3 x 3.4 mm, 4 mm diameter', pass: false })
  })

  it('a hole count is a positive whole number, 1 when left out', () => {
    const row = (count: unknown) => partPlanSchema.safeParse({ ...bracket, holes: [{ name: 'h', diameter: 3, count }] }).success
    expect(row(4)).toBe(true)
    expect(row(undefined)).toBe(true)
    for (const bad of [0, -1, 1.5, 61, '4']) expect(row(bad), String(bad)).toBe(false)
  })

  it('a wall that was not measured fails, and says why when it was on purpose', () => {
    const r = designCheck(bracket, { ...built, minWallMm: null }, 0.4)
    expect(failed(r)).toEqual(['minimum wall'])
    expect(r.items.at(-1)).toMatchObject({ name: 'minimum wall', got: 'not measured', pass: false })
    const dense = designCheck(bracket, { ...built, minWallMm: null, minWallWhy: 'part too dense' }, 0.4)
    expect(dense.items.at(-1)).toMatchObject({ got: 'not measured (part too dense)', pass: false })
  })

  it('compares the size axis by axis: an x and y swap passes, a swap with z fails and says to rotate it', () => {
    const turned = designCheck(bracket, { ...built, size: { x: 30, y: 60, z: 40 } }, 0.4)
    expect(turned.pass).toBe(true)
    expect(turned.items[0]!.got).toBe('30 x 60 x 40 mm (x and y swapped: turned on the bed, it prints the same)')
    const lying = designCheck(bracket, { ...built, size: { x: 60, y: 40, z: 30 } }, 0.4)
    expect(failed(lying)).toEqual(['overall size'])
    expect(lying.items[0]!.got).toBe('60 x 40 x 30 mm (same size, axes swapped: rotate it)')
    // a different size altogether gets no note
    expect(designCheck(bracket, { ...built, size: { x: 60, y: 41, z: 30 } }, 0.4).items[0]!.got).toBe('60 x 41 x 30 mm')
  })

  it('a nozzle that is not a positive finite number counts as 0.4 mm', () => {
    for (const n of [Number.NaN, 0, -0.4, Number.POSITIVE_INFINITY]) {
      const r = designCheck(bracket, { ...built, minWallMm: 0.6 }, n)
      expect(r.items.at(-1)).toMatchObject({ want: 'at least 0.8 mm (twice the 0.4 mm nozzle)', pass: false })
    }
  })

  it('an inch plan passes against a body measured in mm, and fails a size off past the mm tolerance', () => {
    const plate: PartPlan = { planId: 'plate-in', part: 'Plate', units: 'in', features: [{ name: 'plate', sizes: { width: 2, depth: 1, thickness: 0.25 } }], overall: { x: 2, y: 1, z: 0.25 }, holes: [{ name: 'hole', diameter: 0.25 }], assumptions: [], questions: [] }
    const mm: BodyFacts = { size: { x: 50.8, y: 25.4, z: 6.35 }, holes: [{ diameterMm: 6.35 }], features: 1, watertight: true, minWallMm: 6.35 }
    const r = designCheck(plate, mm, 0.4)
    expect(r.pass).toBe(true)
    expect(r.items[0]).toMatchObject({ name: 'overall size', want: '50.8 x 25.4 x 6.35 mm (2 x 1 x 0.25 in)' })
    // 0.6 mm over on 50.8 mm is past 1 percent (0.508 mm); a hole 0.15 mm wide of 6.35 mm is past 0.1 mm
    expect(failed(designCheck(plate, { ...mm, size: { x: 51.4, y: 25.4, z: 6.35 } }, 0.4))).toEqual(['overall size'])
    expect(failed(designCheck(plate, { ...mm, holes: [{ diameterMm: 6.5 }] }, 0.4))).toEqual(['hole'])
    // read as mm, the same numbers fail
    expect(designCheck({ ...plate, units: 'mm' }, mm, 0.4).pass).toBe(false)
  })

  it('takes plans by planId, checked against the plan shape', () => {
    const plans = createPlanRegistry()
    expect(plans.latest()).toBeUndefined()
    plans.put(bracket)
    plans.put({ ...bracket, planId: 'bracket-2' }, 'd1')
    expect(plans.get('bracket-1')).toEqual({ plan: bracket, origin: 'client' })
    expect(plans.get('bracket-2')?.design).toBe('d1')
    expect(plans.latest()?.planId).toBe('bracket-2')
    expect(() => plans.put({ ...bracket, units: 'cm' } as unknown as PartPlan)).toThrow()
    expect(partPlanSchema.safeParse({ ...bracket, holes: [{ name: 'x', diameterMm: 3 }] }).success).toBe(false)
  })

  it('ties a plan made before its design, and keeps the last 50 plans', () => {
    const plans = createPlanRegistry()
    plans.put(bracket)
    expect(plans.tie('bracket-1', 'd7')).toBe(true)
    expect(plans.get('bracket-1')).toEqual({ plan: bracket, origin: 'client', design: 'd7' })
    expect(plans.tie('nope', 'd7')).toBe(false)
    for (let k = 0; k < MAX_PLANS; k++) plans.put({ ...bracket, planId: `p${k}` })
    expect(MAX_PLANS).toBe(50)
    expect(plans.get('bracket-1')).toBeUndefined()
    expect(plans.get('p0')).toBeDefined()
    plans.put({ ...bracket, planId: 'one more' })
    expect(plans.get('p0')).toBeUndefined()
    expect(plans.get('p1')).toBeDefined()
    expect(plans.latest()?.planId).toBe('one more')
  })

  it('keeps card plans apart from client plans: a client never replaces or pushes out a card plan', () => {
    const plans = createPlanRegistry()
    plans.put(bracket, undefined, 'card')
    expect(() => plans.put({ ...bracket, part: 'Other' })).toThrow(PlanOwnedError)
    expect(plans.get('bracket-1')).toEqual({ plan: bracket, origin: 'card' })
    for (let k = 0; k < 60; k++) plans.put({ ...bracket, planId: `c${k}` }, undefined, 'client')
    expect(plans.get('bracket-1')?.origin).toBe('card')
    expect(plans.get('c9')).toBeUndefined()
    expect(plans.get('c10')?.origin).toBe('client')
    // a card plan may take over a client's id
    plans.put({ ...bracket, planId: 'c59' }, undefined, 'card')
    expect(plans.get('c59')?.origin).toBe('card')
  })

  it('reads the latest plan of one origin', () => {
    const plans = createPlanRegistry()
    expect(plans.latest('card')).toBeUndefined()
    plans.put(bracket, undefined, 'card')
    plans.put({ ...bracket, planId: 'client-1' })
    expect(plans.latest()?.planId).toBe('client-1')
    expect(plans.latest('card')?.planId).toBe('bracket-1')
    expect(plans.latest('client')?.planId).toBe('client-1')
  })

  it('rejects a plan with a size, hole or overall value of zero or less', () => {
    expect(partPlanSchema.safeParse(bracket).success).toBe(true)
    for (const v of [0, -1]) {
      expect(partPlanSchema.safeParse({ ...bracket, features: [{ name: 'base', sizes: { width: v } }] }).success).toBe(false)
      expect(partPlanSchema.safeParse({ ...bracket, holes: [{ name: 'mount hole', diameter: v }] }).success).toBe(false)
      for (const axis of ['x', 'y', 'z'] as const) expect(partPlanSchema.safeParse({ ...bracket, overall: { ...bracket.overall!, [axis]: v } }).success).toBe(false)
    }
    expect(() => createPlanRegistry().put({ ...bracket, features: [{ name: 'base', sizes: { width: 0 } }] })).toThrow()
  })
})

type Tri = [number[], number[], number[]]

/** A closed box's 12 facets, outward, as [-y, -z, -y, -z, +y, +z, +y, +z, -x, -x, +x, +x]: its z faces at odd places. */
function boxTris([x0, y0, z0]: number[], [x1, y1, z1]: number[]): Tri[] {
  const v = (i: number): number[] => [i & 1 ? x1! : x0!, i & 2 ? y1! : y0!, i & 4 ? z1! : z0!]
  const f = (a: number, b: number, c: number): Tri => [v(a), v(b), v(c)]
  return [f(0, 1, 5), f(0, 2, 3), f(0, 5, 4), f(0, 3, 1), f(2, 6, 7), f(4, 5, 7), f(2, 7, 3), f(4, 7, 6), f(0, 4, 6), f(0, 6, 2), f(1, 3, 7), f(1, 7, 5)]
}

const meshOf = (tris: readonly Tri[]) => ({ positions: tris.flat(2), indices: tris.flatMap((_, t) => [t * 3, t * 3 + 1, t * 3 + 2]) })

/**
 * One part of 7222 facets: a 100 x 100 x 10 mm slab whose top is 7200 small facets, and apart from it a 20 x 20 mm plate
 * 0.5 mm thick from facet 7210 on, whose top and bottom facets sit at odd places. Casting from every second facet (as
 * a cap of 6000 casts by index stride did) never casts from those four, and reads 10 mm.
 */
function denseWithThinPlate(thick = 0.5) {
  const tris: Tri[] = []
  const cells = 60
  const s = 100 / cells
  for (let i = 0; i < cells; i++)
    for (let j = 0; j < cells; j++) {
      const [a, b, c, d] = [[i * s, j * s, 10], [(i + 1) * s, j * s, 10], [(i + 1) * s, (j + 1) * s, 10], [i * s, (j + 1) * s, 10]]
      tris.push([a!, b!, c!], [a!, c!, d!])
    }
  // the slab's bottom and sides: the box's facets but its top
  tris.push(...boxTris([0, 0, 0], [100, 100, 10]).filter((_, k) => k !== 5 && k !== 7))
  expect(tris.length).toBe(7210)
  tris.push(...boxTris([200, 0, 0], [220, 20, thick]))
  return meshOf(tris)
}

describe('minWall', () => {
  it('reads a thin plate among more than 6000 facets that casting from every second facet misses', () => {
    const m = denseWithThinPlate()
    expect(m.indices.length / 3).toBeGreaterThan(6000)
    expect(minWall([m])).toEqual({ mm: 0.5 })
    // the same mesh with the plate 0.6 mm thick: the reading follows it
    expect(minWall([denseWithThinPlate(0.6)])).toEqual({ mm: 0.6 })
  })

  it('reads a closed box from its nearest faces, and nothing for no facets', () => {
    expect(minWall([meshOf(boxTris([0, 0, 0], [40, 20, 5]))])).toEqual({ mm: 5 })
    expect(minWall([])).toEqual({ mm: null })
  })

  it('over the budget, says not measured (part too dense) and never a number', () => {
    const m = denseWithThinPlate()
    expect(minWall([m], { maxFacets: 1000, maxMs: 60_000 })).toEqual({ mm: null, why: 'part too dense' })
    // out of time: a clock that jumps a minute at every look
    let t = 0
    expect(minWall([m], { maxFacets: 1_000_000, maxMs: 1000 }, () => (t += 60_000))).toEqual({ mm: null, why: 'part too dense' })
    expect(designCheck(bracket, { ...built, minWallMm: null, minWallWhy: 'part too dense' }, 0.4).pass).toBe(false)
  })
})

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** A design of one closed box part, no steps, on a host whose engine says every mesh is closed and finds no holes. */
const boxDesign = (id: string, name: string): HostDesign => {
  const m = meshOf(boxTris([0, 0, 0], [40, 20, 5]))
  return { id, name, history: { version: 1, base: [], steps: [] }, transform: IDENTITY, parts: [{ name, slot: 0, ...m }], status: [], madeBy: {}, redo: [] } as unknown as HostDesign
}
const hostOf = (all: HostDesign[]): DesignHost =>
  ({
    get: (id: string) => {
      const d = all.find((x) => x.id === id)
      if (!d) throw new Error(`no design ${id}`)
      return d
    },
    list: () => all,
    create: async () => Promise.reject(new Error('not here')),
    add: async () => Promise.reject(new Error('not here')),
    replay: async () => {},
    call: async (op: string) => (op === 'info' ? { watertight: true } : Promise.reject(new Error('no hole there'))),
  }) as unknown as DesignHost

const boxPlan: PartPlan = { planId: 'box-1', part: 'Spacer', units: 'mm', features: [], overall: { x: 40, y: 20, z: 5 }, assumptions: [], questions: [] }

/** design.check on a host of these designs; nozzle as given. */
async function checkOn(all: HostDesign[], setup: (plans: ReturnType<typeof createPlanRegistry>) => void, args: Record<string, unknown> = { planId: 'box-1' }, nozzleMm?: () => number | undefined, cardSide?: boolean) {
  const plans = createPlanRegistry()
  setup(plans)
  const tool = designToolset(hostOf(all), {}, { plans, nozzleMm, cardSide }).find((t) => t.name === 'design.check')!
  const r = await tool.run(tool.input.parse(args), {} as ToolContext)
  return { r, out: r.output as { design: string; designName: string; chosen: string; nozzleMm: number; pass: boolean }, plans }
}

describe('design.check picks the design it checks', () => {
  const a = boxDesign('d1', 'Bracket')
  const b = boxDesign('d2', 'Clip')

  it('refuses with two designs open and the plan neither tied nor named, asking which', async () => {
    await expect(checkOn([a, b], (p) => p.put(boxPlan))).rejects.toThrow(/not tied to a design.*Which design is it\? Open: Bracket \(d1\), Clip \(d2\)/)
  })

  it('checks the tied design once the plan is tied after it was made', async () => {
    const { r, out } = await checkOn([a, b], (p) => {
      p.put(boxPlan)
      p.tie('box-1', 'd1')
    })
    expect(out).toMatchObject({ design: 'd1', designName: 'Bracket', chosen: 'tied to the plan', pass: true })
    expect(r.summary).toContain('Bracket (d1, tied to the plan) matches plan box-1')
  })

  it('a design given in the call is checked and the plan tied to it', async () => {
    const { out, plans } = await checkOn([a, b], (p) => p.put(boxPlan), { planId: 'box-1', design: 'd2' })
    expect(out).toMatchObject({ design: 'd2', chosen: 'tied to the plan' })
    expect(plans.get('box-1')?.design).toBe('d2')
  })

  it("never ties a card plan again: a client's other design is refused, its tied design is checked", async () => {
    const card = (p: ReturnType<typeof createPlanRegistry>) => p.put(boxPlan, 'd1', 'card')
    // a read-class client (no cardSide) naming another design for a tied card plan
    await expect(checkOn([a, b], card, { planId: 'box-1', design: 'd2' })).rejects.toThrow(/made in the mimir tab and is already tied to design d1\. It is not tied again/)
    // nor on the card's own side
    await expect(checkOn([a, b], card, { planId: 'box-1', design: 'd2' }, undefined, true)).rejects.toThrow(/already tied to design d1/)
    // naming the design it is tied to checks it and changes nothing
    const { out, plans } = await checkOn([a, b], card, { planId: 'box-1', design: 'd1' })
    expect(out).toMatchObject({ design: 'd1', chosen: 'tied to the plan' })
    expect(plans.get('box-1')?.design).toBe('d1')
  })

  it("checks a client's given design for an untied card plan without tying it; the card side ties it", async () => {
    const card = (p: ReturnType<typeof createPlanRegistry>) => p.put(boxPlan, undefined, 'card')
    const client = await checkOn([a, b], card, { planId: 'box-1', design: 'd2' })
    expect(client.out).toMatchObject({ design: 'd2', chosen: 'given' })
    expect(client.plans.get('box-1')?.design).toBeUndefined()
    const tab = await checkOn([a, b], card, { planId: 'box-1', design: 'd2' }, undefined, true)
    expect(tab.out).toMatchObject({ design: 'd2', chosen: 'tied to the plan' })
    expect(tab.plans.get('box-1')?.design).toBe('d2')
  })

  it('still ties a client plan to a design given again', async () => {
    const { plans } = await checkOn([a, b], (p) => p.put(boxPlan, 'd1'), { planId: 'box-1', design: 'd2' })
    expect(plans.get('box-1')?.design).toBe('d2')
  })

  it('a design named as the part beats the latest one', async () => {
    const { r, out } = await checkOn([boxDesign('d1', 'Spacer'), b], (p) => p.put(boxPlan))
    expect(out).toMatchObject({ design: 'd1', designName: 'Spacer', chosen: 'matched by name' })
    expect(r.summary).toContain('Spacer (d1, matched by name)')
  })

  it('two open designs named as the part refuse and ask which', async () => {
    await expect(checkOn([boxDesign('d1', 'Spacer'), boxDesign('d2', 'spacer '), b], (p) => p.put(boxPlan))).rejects.toThrow(/2 open designs are named Spacer\. Which design is it\? Spacer \(d1\), spacer  \(d2\)/)
  })

  it('with one design open, checks it and says latest', async () => {
    const { r, out } = await checkOn([b], (p) => p.put(boxPlan))
    expect(out).toMatchObject({ design: 'd2', designName: 'Clip', chosen: 'latest' })
    expect(r.summary).toContain('Clip (d2, latest)')
  })

  it('a nozzle that is not a positive finite number counts as 0.4 mm', async () => {
    for (const n of [Number.NaN, 0, -1, undefined]) {
      const { out } = await checkOn([b], (p) => p.put(boxPlan), undefined, () => n)
      expect(out.nozzleMm).toBe(0.4)
    }
    expect((await checkOn([b], (p) => p.put(boxPlan), undefined, () => 0.6)).out.nozzleMm).toBe(0.6)
  })
})

describe('design.check gives a plan one fix round', () => {
  // a spacer built 5 mm tall, planned 6 mm: every check of it fails on the overall size
  const tall: PartPlan = { ...boxPlan, overall: { x: 40, y: 20, z: 6 } }
  type Out = { pass: boolean; stop?: string; repeated?: boolean; items: { name: string; pass: boolean }[] }

  /** A scripted run: design.check called again and again on one host, counting the geometry calls it makes. */
  function run(designs: HostDesign[] = [boxDesign('d1', 'Spacer')]) {
    const plans = createPlanRegistry()
    const host = hostOf(designs)
    let calls = 0
    const counted = { ...host, call: async (op: string, req: unknown) => (calls++, host.call(op as never, req as never)) } as unknown as DesignHost
    const tool = designToolset(counted, {}, { plans }).find((t) => t.name === 'design.check')!
    const check = async (planId = 'box-1') => {
      const r = await tool.run(tool.input.parse({ planId }), {} as ToolContext)
      return { summary: r.summary, out: r.output as Out }
    }
    return { plans, check, calls: () => calls }
  }

  it('is one round, as the prompt says', () => {
    expect(FIX_ROUNDS).toBe(1)
  })

  it('two failed checks stop after the second, and a third call does no new geometry work', async () => {
    const { plans, check, calls } = run()
    plans.put(tall, 'd1', 'card')
    const first = await check()
    expect(first.out.pass).toBe(false)
    expect(first.out.stop).toBeUndefined()
    expect(first.summary).not.toMatch(/fix round/)
    const second = await check()
    expect(second.out.pass).toBe(false)
    expect(second.out.items.filter((i) => !i.pass).map((i) => i.name)).toEqual(['overall size'])
    expect(second.out.stop).toMatch(/^The fix round is used: stop building, and tell the person exactly what is off/)
    expect(second.summary).toContain('overall size (want 40 x 20 x 6 mm')
    expect(second.summary).toContain(second.out.stop!)
    expect(plans.get('box-1')?.failedChecks).toBe(2)
    const measured = calls()
    expect(measured).toBeGreaterThan(0)
    // the third call: the same result, said to be the last one, with no geometry calls and no further count
    const third = await check()
    expect(calls()).toBe(measured)
    expect(third.out).toEqual({ ...second.out, repeated: true })
    expect(third.summary).toMatch(/^Plan box-1 has had its fix round, so the part was not checked again\. Its last check: /)
    expect(third.summary).toContain(second.summary)
    expect(plans.get('box-1')?.failedChecks).toBe(2)
  })

  it('a check that passes after one miss ends it as usual', async () => {
    const { plans, check } = run()
    plans.put(tall, 'd1')
    await check()
    plans.put(boxPlan, 'd1')
    const fixed = await check()
    expect(fixed.out.pass).toBe(true)
    expect(fixed.out.stop).toBeUndefined()
    // the same planId put again kept its one miss
    expect(plans.get('box-1')?.failedChecks).toBe(1)
  })

  it('a new plan, with a new planId, starts over', async () => {
    const { plans, check } = run()
    plans.put(tall, 'd1')
    await check()
    await check()
    plans.put({ ...tall, planId: 'box-2' }, 'd1')
    const fresh = await check('box-2')
    expect(fresh.out.stop).toBeUndefined()
    expect(fresh.out.repeated).toBeUndefined()
    expect((await check('box-2')).out.stop).toMatch(/fix round is used/)
    // the old plan still answers with its closed result
    expect((await check('box-1')).out.repeated).toBe(true)
  })
})

type Check = { pass: boolean; planId: string; design: string; items: { name: string; want: string; got: string; pass: boolean }[]; body: BodyFacts }

const geom = useGeomEngine('design-check-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)
const top = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1] })

/** A 40 x 20 plate `t` mm thick with one through hole of `d` mm, planned with a 6 mm hole. */
async function plate(t: number, d: number, plan: Partial<PartPlan> = {}) {
  const plans = createPlanRegistry()
  const h = await connect({ geomEngine: engine, plans })
  const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: T }>(r).output
  }
  const design = (await ok<{ design: string }>('slicerx_design_new', { name: 'Plate' })).design
  await ok('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, placement: { center: [20, 10] }, distance_mm: t })
  await ok('slicerx_geom_extrude', { design, shape: { type: 'circle', diameterMm: d }, frame: top(t), placement: { center: [12, 10] }, distance_mm: t, operation: 'cut' })
  plans.put({ planId: 'plate-1', part: 'Plate', units: 'mm', features: [{ name: 'plate', kind: 'extrude', sizes: { width: 40, depth: 20, thickness: t } }, { name: 'hole', kind: 'cut', sizes: { diameter: 6 } }], overall: { x: 40, y: 20, z: t }, holes: [{ name: 'mount hole', diameter: 6 }], assumptions: [], questions: [], ...plan })
  return { h, ok, design }
}

describe('slicerx_design_check', () => {
  it('reads the body a plate was built to and passes it against its plan', async () => {
    const { ok, design } = await plate(5, 6)
    const r = await ok<Check>('slicerx_design_check', { planId: 'plate-1' })
    expect(r.design).toBe(design)
    expect(r.body.size).toEqual({ x: 40, y: 20, z: 5 })
    expect(r.body.features).toBe(2)
    expect(r.body.watertight).toBe(true)
    expect(r.body.holes).toHaveLength(1)
    expect(Math.abs(r.body.holes[0]!.diameterMm - 6)).toBeLessThan(0.05)
    // the hole sits 10 - 3 = 7 mm from the long edges and 12 - 3 = 9 mm from the near end, so the thinnest wall is the
    // plate's 5 mm thickness
    expect(r.body.minWallMm).toBeCloseTo(5, 2)
    expect(r.items.filter((i) => !i.pass)).toEqual([])
    expect(r.pass).toBe(true)
  })

  it('a 6 mm hole built at 5 mm fails that item only', async () => {
    const { h } = await plate(5, 5)
    const res = await h.call('slicerx_design_check', { planId: 'plate-1' })
    const r = data<{ output: Check; summary: string }>(res)
    expect(r.output.pass).toBe(false)
    expect(r.output.items.filter((i) => !i.pass).map((i) => i.name)).toEqual(['mount hole'])
    expect(r.output.items.find((i) => i.name === 'mount hole')?.got).toMatch(/^4\.9\d mm diameter$|^5 mm diameter$/)
    expect(text(res)).toContain('mount hole')
  })

  it('a 0.6 mm plate fails the wall for a 0.4 nozzle', async () => {
    const { ok } = await plate(0.6, 6)
    const r = await ok<Check>('slicerx_design_check', { planId: 'plate-1' })
    expect(r.body.minWallMm).toBeCloseTo(0.6, 2)
    expect(r.items.filter((i) => !i.pass).map((i) => i.name)).toEqual(['minimum wall'])
  })

  it('refuses a plan it does not have', async () => {
    const { h } = await plate(5, 6)
    const r = await h.call('slicerx_design_check', { planId: 'nope' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('there is no plan nope')
  })
})

describe('design.put_plan', () => {
  const tools = (all: HostDesign[], plans = createPlanRegistry()) => {
    const set = designToolset(hostOf(all), {}, { plans })
    const run = async (name: string, args: Record<string, unknown>) => {
      const t = set.find((x) => x.name === name)!
      return t.run(t.input.parse(args), {} as ToolContext)
    }
    return { plans, run, set }
  }

  it('keeps a plan design.check then checks the built part against, tied to its design', async () => {
    // two designs open, neither named as the part: the tie picks the right one
    const { plans, run } = tools([boxDesign('d1', 'Other'), boxDesign('d2', 'Clip')])
    const kept = await run('design.put_plan', { plan: boxPlan, design: 'd1' })
    expect(kept.output).toEqual({ planId: 'box-1', part: 'Spacer', design: 'd1', features: 0, holes: 0 })
    expect(kept.summary).toContain('Kept plan box-1 for Spacer (0 features, 40 x 20 x 5 mm overall), tied to Other (d1)')
    expect(plans.get('box-1')).toEqual({ plan: boxPlan, origin: 'client', design: 'd1' })
    const r = await run('design.check', { planId: 'box-1' })
    expect(r.output).toMatchObject({ design: 'd1', chosen: 'tied to the plan', pass: true })
    // the same planId again replaces it, untied
    await run('design.put_plan', { plan: { ...boxPlan, overall: { x: 50, y: 20, z: 5 } } })
    expect(plans.get('box-1')?.plan.overall?.x).toBe(50)
    expect(plans.get('box-1')?.design).toBeUndefined()
  })

  it('counts a row of several holes as that many holes', async () => {
    const { run } = tools([boxDesign('d1', 'Spacer')])
    const kept = await run('design.put_plan', { plan: { ...boxPlan, holes: [{ name: 'corner holes', diameter: 3.4, count: 4 }, { name: 'center', diameter: 8 }] } })
    expect(kept.output).toMatchObject({ holes: 5 })
    expect(kept.summary).toContain('(0 features, 5 holes, 40 x 20 x 5 mm overall)')
  })

  it('refuses a plan off the schema or tied to a design that is not open, and keeps nothing', async () => {
    const { plans, run, set } = tools([boxDesign('d1', 'Spacer')])
    const input = set.find((t) => t.name === 'design.put_plan')!.input
    expect(input.safeParse({ plan: { ...boxPlan, overall: { x: 0, y: 20, z: 5 } } }).success).toBe(false)
    expect(input.safeParse({ plan: { ...boxPlan, units: 'cm' } }).success).toBe(false)
    await expect(run('design.put_plan', { plan: boxPlan, design: 'nope' })).rejects.toThrow(/no design nope/)
    expect(plans.get('box-1')).toBeUndefined()
  })

  it("refuses a card plan's planId, leaves every card plan in place after many client plans, and says it only adds the client's own", async () => {
    const { plans, run, set } = tools([boxDesign('d1', 'Spacer')])
    expect(set.find((t) => t.name === 'design.put_plan')!.description).toContain('only adds plans you make here')
    for (let k = 0; k < 5; k++) plans.put({ ...boxPlan, planId: `card-${k}` }, undefined, 'card')
    await expect(run('design.put_plan', { plan: { ...boxPlan, planId: 'card-0', part: 'Hijack' } })).rejects.toThrow(/plan the person made/)
    expect(plans.get('card-0')).toEqual({ plan: { ...boxPlan, planId: 'card-0' }, origin: 'card' })
    for (let k = 0; k < 60; k++) await run('design.put_plan', { plan: { ...boxPlan, planId: `client-${k}` } })
    for (let k = 0; k < 5; k++) expect(plans.get(`card-${k}`)?.origin).toBe('card')
    expect(plans.get('client-59')?.origin).toBe('client')
  })

  it('is read class, and is on the MCP server as slicerx_design_put_plan', async () => {
    const { set } = tools([])
    expect(set.find((t) => t.name === 'design.put_plan')?.permission).toBe('read')
    const h = await connect({ geomEngine: engine })
    const r = await h.call('slicerx_design_put_plan', { plan: { ...boxPlan, planId: 'mcp-1' } })
    expect(r.isError, text(r)).toBeFalsy()
    expect(data<{ output: { planId: string } }>(r).output.planId).toBe('mcp-1')
  })
})
