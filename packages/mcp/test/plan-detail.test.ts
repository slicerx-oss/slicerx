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
import { createPlanRegistry, partPlanSchema, type PartPlan } from '../src/design-check'
import { DETAIL_HELP, detailProblem } from '../src/plan-detail'
import { PLAN_GO, type PlanInput } from '../src/tab-tools'
import { createCardPlans, designToolset, tabToolset } from '../src/toolset'
import type { DesignHost } from '@slicerx/cad-history'

const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }

/** A toy boat at display detail: a lofted hull, a cabin, portholes arrayed along the side. */
const boat: PlanInput = {
  part: 'Toy boat',
  units: 'mm',
  detail: 'display',
  curved: ['Hull'],
  flat: ['Cabin'],
  proportions: 'lookup: a 6 m launch, 2.2 m beam, scaled 1:40',
  repeats: ['portholes'],
  features: [
    { name: 'Hull', kind: 'loft', sizes: { length: 150, beam: 55, height: 20, sections: 7 }, kinds: { sections: 'count' } },
    { name: 'Cabin', kind: 'extrude', sizes: { length: 50, width: 35, height: 15 } },
    { name: 'Portholes', kind: 'array cut', sizes: { diameter: 3, pitch: 8, count: 5 }, kinds: { count: 'count' } },
  ],
  assumptions: [],
  questions: [],
}

/** A model car at display detail: a lofted body, wheels arrayed and mirrored. */
const car: PlanInput = {
  part: 'Model car',
  units: 'mm',
  detail: 'display',
  curved: ['Body'],
  proportions: 'stated: a hatchback about 4 m long, 1.8 m wide, 1.5 m tall, scaled 1:43',
  repeats: ['wheels'],
  features: [
    { name: 'Body', kind: 'loft', sizes: { length: 93, width: 42, height: 32, sections: 5 }, kinds: { sections: 'count' } },
    { name: 'Wheels', kind: 'revolve, array and mirror', sizes: { diameter: 14, width: 6, count: 2 }, kinds: { count: 'count' } },
  ],
  assumptions: [],
  questions: [],
}

/** A house at display detail: flat-sided, so its walls and roof are extruded, and its windows arrayed. */
const house: PlanInput = {
  part: 'House',
  units: 'mm',
  detail: 'display',
  flat: ['Walls', 'Roof'],
  proportions: 'stated: a two story house 10 m wide, 8 m deep, scaled 1:100',
  repeats: ['windows'],
  features: [
    { name: 'Walls', kind: 'extrude', sizes: { width: 100, depth: 80, height: 55 } },
    { name: 'Roof', kind: 'extrude', sizes: { width: 104, depth: 84, height: 30 } },
    { name: 'Windows', kind: 'array cut', sizes: { width: 8, height: 12, count: 4 }, kinds: { count: 'count' } },
  ],
  assumptions: [],
  questions: [],
}

const withFeature = (p: PlanInput, name: string, f: Partial<PlanInput['features'][number]>): PlanInput => ({ ...p, features: p.features.map((x) => (x.name === name ? { ...x, ...f } : x)) })

describe('detailProblem: the rules are about the object', () => {
  it('passes a toy boat whose curved hull is lofted through 7 sections, with proportions and arrayed portholes', () => {
    expect(detailProblem(boat)).toBeNull()
  })

  it('passes a model car whose curved body is lofted through 5 sections', () => {
    expect(detailProblem(car)).toBeNull()
  })

  it('passes a house with no loft, since it is flat-sided', () => {
    expect(detailProblem(house)).toBeNull()
  })

  it('refuses a curved hull built as a single extrude, and says to loft it through at least 5 sections instead', () => {
    const p = detailProblem(withFeature(boat, 'Hull', { kind: 'extrude', sizes: { length: 150, beam: 55, height: 20 } }))
    expect(p).toContain('Hull builds a curved body, so do not build it as a single extrude')
    expect(p).toContain('plan it as a loft through 5 or more smooth sections along its length')
  })

  it('refuses a curved car body lofted through 3 sections, and a fine one under 8', () => {
    expect(detailProblem(withFeature(car, 'Body', { sizes: { length: 93, width: 42, height: 32, sections: 3 } }))).toContain('Body goes through 3 sections; a display model plan lofts or sweeps a curved body through at least 5')
    expect(detailProblem({ ...car, detail: 'fine' })).toContain('through at least 8')
    expect(detailProblem(withFeature({ ...car, detail: 'fine' }, 'Body', { sizes: { length: 93, sections: 8 } }))).toBeNull()
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
    expect(detailProblem(noArray)).toContain('repeats: windows repeat on the real object, so plan at least one detail pass that builds one and patterns it')
    expect(detailProblem({ ...noArray, repeats: [] })).toBeNull()
  })

  it('holds a basic plan, or one with no level, to none of it', () => {
    const extruded = withFeature(boat, 'Hull', { kind: 'extrude' })
    expect(detailProblem({ ...extruded, detail: 'basic' })).toBeNull()
    const { detail: _d, ...noLevel } = extruded
    expect(detailProblem(noLevel)).toBeNull()
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
    await expect(t.run(withFeature(boat, 'Hull', { kind: 'extrude' }))).rejects.toThrow('Hull builds a curved body, so do not build it as a single extrude')
    expect(t.shown).toEqual([])
  })

  it('shows a display plan that holds the rules on the card, with its level, bodies, proportions and repeats', async () => {
    const t = tab()
    const out = await t.run(house)
    expect(out.ok).not.toBe(false)
    expect(t.shown[0]).toMatchObject({ detail: 'display', flat: ['Walls', 'Roof'], proportions: house.proportions, repeats: ['windows'] })
  })

  it('tells the model the default, the rules and the general method in its description and in each refusal', async () => {
    const d = tab().tool.description
    expect(d).toContain('display for a model of a real thing named without sizes (the default)')
    expect(d).toContain('a flat-sided one (a house, a bookshelf) can be extruded')
    for (const step of ['a table of sections, each with the same number of points', 'sunk about 0.1 mm into it', 'at least two nozzle widths from edges and from each other', 'a loft between two ellipses, offset for the rake, then arrayed', 'Repeated small parts are one part, then array and mirror', 'Each color band of the real thing (a waterline, a stripe, a trim line) is its own part', 'the top edge rising toward the ends'])
      expect(d).toContain(step)
    await expect(tab().run({ ...car, proportions: undefined })).rejects.toThrow(DETAIL_HELP)
  })

  it('leaves the level out of design.put_plan', () => {
    const put = designToolset({} as DesignHost, {}, { plans: createPlanRegistry() }).find((t) => t.name === 'design.put_plan')!
    const planShape = (put.input as unknown as { shape: { plan: { shape: Record<string, unknown> } } }).shape.plan.shape
    expect(Object.keys(planShape)).not.toContain('detail')
    expect(Object.keys(partPlanSchema.shape)).toContain('detail')
  })
})
