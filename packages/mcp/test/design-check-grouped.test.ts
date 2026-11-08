// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plan groups steps into features ("four standoffs", "port cutouts") and a part may be laid out as several bodies
// (a case and its lid lying flat beside it). design.check ties each planned feature to the steps tagged with its name
// (the modeling tools' feature argument), falls back to step names only when no step is tagged, and holds the overall
// size to the assembled part, not to the bounds of everything on the bed.
import { describe, expect, it } from 'vitest'
import { designCheck, type BodyFacts, type PartPlan } from '../src/design-check'

const piCase: PartPlan = {
  planId: 'pi-case',
  part: 'Raspberry Pi 5 case',
  units: 'mm',
  features: [
    { name: 'Base box', kind: 'extrude', sizes: { length: 96, width: 68, height: 28, wall: 2 } },
    { name: 'Standoffs', kind: 'extrude', sizes: { diameter: 6, height: 5 } },
    { name: 'Port cutouts', kind: 'cut', sizes: { depth: 3 } },
    { name: 'Vents', kind: 'cut', sizes: { width: 2 } },
    { name: 'Snap-fit lid', kind: 'extrude', sizes: { thickness: 2 } },
  ],
  overall: { x: 96, y: 68, z: 28 },
  assumptions: [],
  questions: [],
}

const steps = ['Base box', 'Base hollow', 'Standoff 1', 'Standoff 2', 'Standoff 3', 'Standoff 4', 'USB-C cutout', 'Micro HDMI cutouts', 'USB cutout', 'Ethernet cutout', 'Vent slots', 'Lid']

const base = { x: 96, y: 68, z: 28 }
const lid = { x: 96, y: 68, z: 4 }
const body: BodyFacts = { size: base, holes: [], features: steps.length, steps, watertight: true, minWallMm: 2 }

const item = (r: ReturnType<typeof designCheck>, name: string) => r.items.find((i) => i.name === name)!

describe('design.check with grouped features', () => {
  it('passes 12 steps that build 5 grouped features, and says how they group', () => {
    const r = designCheck(piCase, body, 0.4)
    expect(item(r, 'feature count')).toMatchObject({ pass: true })
    expect(item(r, 'feature count').got).toContain('12 steps')
    expect(r.pass).toBe(true)
  })

  it('fails a planned feature no step builds, by name', () => {
    const noVents = steps.filter((s) => s !== 'Vent slots')
    const r = designCheck(piCase, { ...body, steps: noVents, features: noVents.length }, 0.4)
    expect(item(r, 'feature count')).toMatchObject({ pass: false })
    expect(item(r, 'feature count').got).toContain('Vents')
  })

  it('fails fewer steps than planned features', () => {
    const r = designCheck(piCase, { ...body, steps: steps.slice(0, 3), features: 3 }, 0.4)
    expect(item(r, 'feature count').pass).toBe(false)
  })

  it('with steps named only by their numbers, more steps than features pass as grouped', () => {
    const { steps: _s, ...unnamed } = body
    expect(item(designCheck(piCase, { ...unnamed, features: 12 }, 0.4), 'feature count').pass).toBe(true)
  })

  it('a lid laid flat beside the base is held to the base, not to both bodies together', () => {
    const laidOut: BodyFacts = { ...body, size: { x: 96 + 10 + 96, y: 68, z: 28 }, parts: [base, lid] }
    const r = designCheck(piCase, laidOut, 0.4)
    expect(item(r, 'overall size')).toMatchObject({ pass: true })
    expect(item(r, 'overall size').got).toContain('largest part')
  })

  it('a largest part turned on the bed passes with the swap noted', () => {
    const r = designCheck(piCase, { ...body, size: { x: 68, y: 96 + 10 + 96, z: 28 }, parts: [{ x: 68, y: 96, z: 28 }, { x: 68, y: 96, z: 4 }] }, 0.4)
    expect(item(r, 'overall size')).toMatchObject({ pass: true })
    expect(item(r, 'overall size').got).toContain('x and y swapped')
  })

  it('one part is held to its own bounds, as before', () => {
    const r = designCheck(piCase, { ...body, size: { x: 96, y: 68, z: 20 }, parts: [{ x: 96, y: 68, z: 20 }] }, 0.4)
    expect(item(r, 'overall size').pass).toBe(false)
    expect(item(r, 'overall size').got).not.toContain('largest part')
  })

  it('a base built too short still fails with the lid beside it', () => {
    const r = designCheck(piCase, { ...body, size: { x: 202, y: 68, z: 20 }, parts: [{ ...base, z: 20 }, lid] }, 0.4)
    expect(item(r, 'overall size').pass).toBe(false)
  })
})

// Each modeling tool takes the plan feature its step builds (feature), recorded on the step. A feature with no step
// tagged with its name fails by name; an untagged step is finishing work and never stands in for a missing feature.
describe('design.check ties steps to features by their tag', () => {
  const featureOf: Record<string, string> = { 'Base box': 'Base box', 'Base hollow': 'Base box', 'Vent slots': 'Vents', Lid: 'Snap-fit lid' }
  const tags = steps.map((s) => featureOf[s] ?? (s.startsWith('Standoff') ? 'Standoffs' : 'Port cutouts'))
  const tagged: BodyFacts = { ...body, tags }

  it('passes 12 tagged steps for 5 features and says how they group', () => {
    const got = item(designCheck(piCase, tagged, 0.4), 'feature count')
    expect(got).toMatchObject({ pass: true })
    expect(got.want).toBe('5 features, each built by a step tagged with its name')
    expect(got.got).toContain('Standoffs 4')
  })

  it('fails a feature with no tagged step by name, even when an untagged step is named for it', () => {
    const r = designCheck(piCase, { ...tagged, tags: tags.map((t, k) => (steps[k] === 'Lid' ? null : t)) }, 0.4)
    expect(item(r, 'feature count')).toMatchObject({ pass: false })
    expect(item(r, 'feature count').got).toContain('none tagged for Snap-fit lid')
    expect(item(r, 'feature count').got).toContain('1 untagged step is finishing work')
  })

  it("untagged steps under a tool's own name never stand in for a missing feature", () => {
    const noLid = steps.filter((s) => s !== 'Lid')
    const extra = ['Add Solids 1', 'Mirror copy', 'Cut, keep below', 'Sketch extrude 4 mm']
    const r = designCheck(piCase, { ...body, steps: [...noLid, ...extra], features: noLid.length + extra.length, tags: [...tags.filter((_, k) => steps[k] !== 'Lid'), null, null, null, null] }, 0.4)
    expect(item(r, 'feature count')).toMatchObject({ pass: false })
    expect(item(r, 'feature count').got).toContain('Snap-fit lid')
  })

  it('untagged finishing steps beside a fully tagged plan pass', () => {
    const r = designCheck(piCase, { ...body, steps: [...steps, 'Fillet 1 mm, 4 edges', 'Chamfer 0.5 mm'], features: steps.length + 2, tags: [...tags, null, null] }, 0.4)
    expect(item(r, 'feature count')).toMatchObject({ pass: true })
  })

  it('a tag matches its feature whatever the case, punctuation or plural', () => {
    const r = designCheck(piCase, { ...tagged, tags: tags.map((t) => (t === 'Snap-fit lid' ? 'snap fit lids' : t)) }, 0.4)
    expect(item(r, 'feature count')).toMatchObject({ pass: true })
  })

  it('a tag for something the plan lacks fills nothing and is named', () => {
    const r = designCheck(piCase, { ...tagged, tags: tags.map((t) => (t === 'Snap-fit lid' ? 'Lid' : t)) }, 0.4)
    expect(item(r, 'feature count')).toMatchObject({ pass: false })
    expect(item(r, 'feature count').got).toContain('Snap-fit lid')
    expect(item(r, 'feature count').got).toContain('"Lid"')
  })

  it('ties by tag alone: a step named for one feature but tagged for another counts for its tag', () => {
    const plan: PartPlan = { ...piCase, features: [{ name: 'Base', sizes: {} }, { name: 'Lid', sizes: {} }], overall: undefined }
    const r = designCheck(plan, { ...body, steps: ['Lid', 'Lid 2'], features: 2, tags: ['Base', 'Lid'] }, 0.4)
    expect(item(r, 'feature count')).toMatchObject({ pass: true })
  })
})

// With no step tagged (a client that does not pass feature), steps are matched to features by name alone. A step whose
// name matches no feature never stands in for one, whatever tool made it.
describe('design.check by step names, when no step is tagged', () => {
  const noLid = steps.filter((s) => s !== 'Lid')
  const plain = (plan: PartPlan, names: string[]) => item(designCheck(plan, { ...body, steps: names, features: names.length }, 0.4), 'feature count')
  const plan = (...names: string[]): PartPlan => ({ ...piCase, features: names.map((name) => ({ name, sizes: {} })), overall: undefined })

  it('a step named for nothing in the plan does not stand in for an unbuilt lid', () => {
    const got = plain(piCase, [...noLid, 'Fillet edges'])
    expect(got).toMatchObject({ pass: false })
    expect(got.got).toContain('Snap-fit lid')
    expect(got.got).toContain('Fillet edges')
  })

  for (const stray of ["Fillet 1 mm, 4 edges", 'Rectangle extrude 4 mm', 'Sketch extrude 4 mm', 'Add Solids 1', 'Mirror copy', 'Cut, keep below', 'Hollow, 2 mm walls'])
    it(`"${stray}" does not stand in for an unbuilt lid`, () => {
      expect(plain(piCase, [...noLid, stray]).pass).toBe(false)
    })

  it('says to tag each step with its feature when a feature has no step', () => {
    expect(plain(piCase, noLid).got).toContain('pass feature on each step')
  })

  it('a flip-only mirror does not stand in for a cable notch', () => {
    expect(plain(plan('Base plate', 'Cable notch'), ['Add Solids 1', 'Mirror']).pass).toBe(false)
  })

  it('two steps named for the walls do not stand in for the lid', () => {
    const got = plain(plan('Base', 'Walls', 'Lid'), ['Base', 'Walls', 'Walls 2'])
    expect(got.pass).toBe(false)
    expect(got.got).toContain('none for Lid')
  })

  it('a step the model named "Wall cut" does not stand in for a missing lid', () => {
    expect(plain(plan('Base', 'Lid'), ['Base', 'Wall cut']).pass).toBe(false)
  })

  it('features named for walls or a cut are matched by those words', () => {
    expect(plain(plan('Base', 'Side walls', 'Cable cut'), ['Base', 'Side walls', 'Cable cut']).pass).toBe(true)
    expect(plain(plan('Base', 'Walls'), ['Base', 'Walls']).pass).toBe(true)
  })

  it('as many steps as features are matched by name too: a lid never built fails', () => {
    const got = plain(piCase, ['Base box', 'Standoff 1', 'Standoff 2', 'USB cutout', 'Vent slots'])
    expect(got).toMatchObject({ pass: false })
    expect(got.got).toContain('Snap-fit lid')
  })

  it('twelve steps all named for the base fail every other feature by name', () => {
    const got = plain(piCase, Array.from({ length: 12 }, (_, k) => `Base box ${k + 1}`))
    expect(got.pass).toBe(false)
    for (const f of ['Standoffs', 'Port cutouts', 'Vents', 'Snap-fit lid']) expect(got.got).toContain(f)
  })

  it('an extra named step no feature claims passes when every feature is built', () => {
    expect(plain(piCase, [...steps, 'Fillet edges']).pass).toBe(true)
  })

  it('a step sharing only a generic word goes to the feature it shares the most with', () => {
    expect(plain(plan('Mounting holes', 'Vent holes'), ['Mounting hole 1', 'Mounting hole 2', 'Vent hole 1'])).toMatchObject({ pass: true })
  })

  it('a plural feature name matches its singular steps ("holes" and "hole")', () => {
    expect(plain(plan('Mounting plate', 'Mounting holes'), ['Mounting plate', 'Mounting hole', 'Mounting hole', 'Mounting hole', 'Mounting hole'])).toMatchObject({ pass: true })
  })

  it('on a tie, the feature with fewer words left over takes the step ("Hole" goes to Hole, not Mounting hole)', () => {
    expect(plain(plan('Mounting hole', 'Hole'), ['Mounting hole', 'Hole'])).toMatchObject({ pass: true })
  })

  for (const [feature, step] of [['Boxes', 'Box'], ['Assemblies', 'Assembly'], ['Switches', 'Switch'], ['Glass', 'Glass'], ['Holes', 'Hole'], ['Slots', 'Slot'], ['Bosses', 'Boss'], ['Shelves', 'Shelf'], ['Halves', 'Half'], ['Axes', 'Axis'], ['Chassis', 'Chassis'], ['Curves', 'Curve'], ['Valves', 'Valve']] as const)
    it(`the plural "${feature}" matches a step named "${step}"`, () => {
      expect(plain(plan('Base', feature), ['Base', step])).toMatchObject({ pass: true })
    })
})
