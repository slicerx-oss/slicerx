// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plan groups steps into features ("four standoffs", "port cutouts") and a part may be laid out as several bodies
// (a case and its lid lying flat beside it). design.check matches each planned feature to the steps that build it and
// holds the overall size to the assembled part, not to the bounds of everything on the bed.
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

// A step stands in for a missing feature only when it carries no name of its own and builds shape ("Sketch extrude 5
// mm", "Rectangle extrude 20 mm"). A step named for something else, or a finishing step such as a fillet, does not.
describe('design.check matches steps to the feature they build', () => {
  const noLid = steps.filter((s) => s !== 'Lid')

  it('a step named for nothing in the plan does not stand in for an unbuilt lid', () => {
    const wrong = [...noLid, 'Fillet edges']
    const r = designCheck(piCase, { ...body, steps: wrong, features: wrong.length }, 0.4)
    expect(item(r, 'feature count')).toMatchObject({ pass: false })
    expect(item(r, 'feature count').got).toContain('Snap-fit lid')
    expect(item(r, 'feature count').got).toContain('Fillet edges')
  })

  it("a fillet under the engine's own name does not stand in for the lid either", () => {
    const wrong = [...noLid, 'Fillet 1 mm, 4 edges']
    const free = wrong.map(() => false)
    expect(item(designCheck(piCase, { ...body, steps: wrong, features: wrong.length, free }, 0.4), 'feature count').pass).toBe(false)
  })

  it('a step with no name of its own that builds shape still fills one missing feature', () => {
    const withFree = [...noLid, 'Rectangle extrude 4 mm']
    const free = withFree.map((s) => s === 'Rectangle extrude 4 mm')
    const r = designCheck(piCase, { ...body, steps: withFree, features: withFree.length, free }, 0.4)
    expect(item(r, 'feature count')).toMatchObject({ pass: true })
  })

  it('a step named only by its numbers still fills one missing feature', () => {
    const withFree = [...noLid, 'Sketch extrude 4 mm']
    expect(item(designCheck(piCase, { ...body, steps: withFree, features: withFree.length }, 0.4), 'feature count').pass).toBe(true)
  })

  it('as many steps as features are matched by name too: a lid never built fails', () => {
    const five = ['Base box', 'Standoff 1', 'Standoff 2', 'USB cutout', 'Vent slots']
    const r = designCheck(piCase, { ...body, steps: five, features: 5 }, 0.4)
    expect(item(r, 'feature count')).toMatchObject({ pass: false })
    expect(item(r, 'feature count').got).toContain('Snap-fit lid')
  })

  it('twelve steps all named for the base fail every other feature by name', () => {
    const all = Array.from({ length: 12 }, (_, k) => `Base box ${k + 1}`)
    const got = item(designCheck(piCase, { ...body, steps: all, features: 12 }, 0.4), 'feature count')
    expect(got.pass).toBe(false)
    for (const f of ['Standoffs', 'Port cutouts', 'Vents', 'Snap-fit lid']) expect(got.got).toContain(f)
  })

  it('an extra named step no feature claims passes when every feature is built', () => {
    const extra = [...steps, 'Fillet edges']
    expect(item(designCheck(piCase, { ...body, steps: extra, features: extra.length }, 0.4), 'feature count').pass).toBe(true)
  })

  it('a step sharing only a generic word goes to the feature it shares the most with', () => {
    const plan: PartPlan = { ...piCase, features: [{ name: 'Mounting holes', sizes: {} }, { name: 'Vent holes', sizes: {} }], overall: undefined }
    const r = designCheck(plan, { ...body, steps: ['Mounting hole 1', 'Mounting hole 2', 'Vent hole 1'], features: 3 }, 0.4)
    expect(item(r, 'feature count')).toMatchObject({ pass: true })
  })

  it('a plural feature name matches its singular steps ("holes" and "hole")', () => {
    const plan: PartPlan = { ...piCase, features: [{ name: 'Mounting plate', sizes: {} }, { name: 'Mounting holes', sizes: {} }], overall: undefined }
    const r = designCheck(plan, { ...body, steps: ['Mounting plate', 'Mounting hole', 'Mounting hole', 'Mounting hole', 'Mounting hole'], features: 5 }, 0.4)
    expect(item(r, 'feature count')).toMatchObject({ pass: true })
  })
})
