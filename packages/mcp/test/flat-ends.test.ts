// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A flat body's ends in its plan (round unless the plan says square) and the note design.check gives a display plan
// whose flat body was built with every level square: read from the steps that built each level, never a failure.
import { describe, expect, it } from 'vitest'
import { designCheck, partPlanSchema, type BodyFacts, type PartPlan } from '../src/design-check'
import { bodyEnds, ENDS_HELP, featureOutlines, flatInput, flatLevels, SQUARE_ENDS_NOTE, squareEndsNotes } from '../src/plan-detail'
import { PlanInputSchema, PlanToolInputSchema } from '../src/tab-tools'
import { createPlanRegistry } from '../src/design-check'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

const geom = useGeomEngine('flat-ends')

const features = [{ name: 'Lower story' }, { name: 'Upper story' }]

describe("a flat body's ends in the plan", () => {
  it('takes ends with a body in flat and keeps them by the body, in the saved plan too', () => {
    const sent = flatInput.parse([{ feature: 'Lower story', levels: ['Lower story', 'Upper story'], ends: { front: 'round', back: 'square' } }, { feature: 'Shed', levels: ['Shed'], ends: 'square' }])
    const read = flatLevels({ flat: sent, detail: 'display' as const }, [...features, { name: 'Shed' }])
    expect(read).toMatchObject({ flat: ['Lower story', 'Shed'], tiers: { 'Lower story': ['Lower story', 'Upper story'], Shed: ['Shed'] }, ends: { 'Lower story': { front: 'round', back: 'square' }, Shed: 'square' } })
    const saved = partPlanSchema.parse({ planId: 'cabin-1', part: 'Cabin', units: 'mm', features: [], assumptions: [], questions: [], ...read })
    expect(saved.ends).toEqual({ 'Lower story': { front: 'round', back: 'square' }, Shed: 'square' })
    // a body sent with no ends adds none
    expect(flatLevels({ flat: flatInput.parse([{ feature: 'Lower story', levels: ['Lower story'] }]) }, features)).not.toHaveProperty('ends')
  })

  it('reads a body left without ends as round at display and fine, and as none at basic', () => {
    expect(bodyEnds({ detail: 'display' }, 'Lower story')).toBe('round')
    expect(bodyEnds({ detail: 'fine' }, 'Lower story')).toBe('round')
    expect(bodyEnds({ detail: 'basic' }, 'Lower story')).toBeNull()
    expect(bodyEnds({}, 'Lower story')).toBeNull()
  })

  it('reads square, and one shape each for front and back, as the plan gives them, by the body in any case', () => {
    expect(bodyEnds({ detail: 'display', ends: { 'Lower story': 'square' } }, 'lower story')).toBe('square')
    expect(bodyEnds({ detail: 'fine', ends: { 'Lower story': { front: 'round', back: 'square' } } }, 'Lower story')).toEqual({ front: 'round', back: 'square' })
    expect(flatInput.safeParse([{ feature: 'Block', levels: ['Block'], ends: 'pointed' }]).success).toBe(false)
    expect(flatInput.safeParse([{ feature: 'Block', levels: ['Block'], ends: { front: 'round' } }]).success).toBe(false)
  })

  it('describes ends in its words on each flat body, and asks for it nowhere else', () => {
    expect(ENDS_HELP).toBe(
      'Display and fine: how each level\'s ends and corners are shaped, as the real thing\'s are: "round" (a curved front or end, rounded corners), "square" (sharp corners, as on a box or a modern block), or one each for front and back such as {"front": "round", "back": "square"}. Left out at display and fine: round.',
    )
    const body = (flatInput.unwrap().options[0] as unknown as { element: { shape: { ends: { description?: string } } } }).element.shape.ends
    expect(body.description).toBe(ENDS_HELP)
    expect(PlanInputSchema.shape).not.toHaveProperty('ends')
    expect(PlanToolInputSchema.safeParse({ part: 'Cabin', units: 'mm', features: [{ name: 'Cabin', sizes: { height: 6 } }], ends: { Cabin: 'round' } }).data).not.toHaveProperty('ends')
  })
})

/** A shaping step tagged with a feature. */
const step = (feature: string, params: Record<string, unknown>) => ({ feature, params })
const rect = (extra: Record<string, unknown> = {}) => ({ op: 'shape.extrude', shape: { type: 'rectangle', widthMm: 40, heightMm: 20, ...extra }, spec: { distanceMm: 6, operation: 'new' } })

describe("each level's outline from its steps", () => {
  it('reads plain rectangles, straight sketches and boxes as square, and any round, curve or fillet as rounded', () => {
    expect(
      featureOutlines([
        step('Lower story', rect()),
        step('Upper story', rect({ frontRadiusMm: 10 })),
        step('Shed', { op: 'shape.extrude', shape: { type: 'sketch', loops: [{ points: [[0, 0], [9, 0], [9, 5], [0, 5]] }] }, spec: { distanceMm: 3 } }),
        step('Porch', { op: 'shape.extrude', shape: { type: 'sketch', loops: [{ start: [0, 0], segments: [{ type: 'line', to: [9, 0] }, { type: 'arc', to: [0, 0], through: [4, 4] }] }] }, spec: { distanceMm: 3 } }),
        step('Block', { op: 'parts.add', parts: [{ primitive: { type: 'box', sizeMm: [5, 5, 5] } }] }),
        step('Tank', { op: 'parts.add', parts: [{ primitive: { type: 'cylinder', diameterMm: 5, heightMm: 5 } }] }),
        step('Roof', { op: 'sketch.loft', profiles: [] }),
      ]),
    ).toEqual({ 'lower story': 'square', 'upper story': 'rounded', shed: 'square', porch: 'rounded', block: 'square', tank: 'rounded', roof: 'other' })
  })

  it('leaves cuts, copies and paint out, and a fillet on a square level rounds it', () => {
    const cut = { op: 'shape.extrude', shape: { type: 'circle', diameterMm: 2 }, spec: { distanceMm: 1, operation: 'cut' } }
    expect(featureOutlines([step('Lower story', rect()), step('Lower story', cut), step('Lower story', { op: 'pattern', steps: [], spec: {} }), step('Lower story', { op: 'paint' })])).toEqual({ 'lower story': 'square' })
    expect(featureOutlines([step('Lower story', rect()), step('Lower story', { op: 'edge.fillet', edges: [], radiusMm: 1 })])).toEqual({ 'lower story': 'rounded' })
    expect(featureOutlines([{ params: rect() }, { feature: 'Lower story', suppressed: true, params: rect({ cornerRadiusMm: 2 }) }])).toEqual({})
  })
})

describe('the note on a flat body built square', () => {
  const plan = { detail: 'display' as const, flat: ['Lower story'], tiers: { 'Lower story': ['Lower story', 'Upper story'] } }

  it('says it in its words when every level of a round-ended body is square', () => {
    expect(SQUARE_ENDS_NOTE('Lower story')).toBe(
      "Every level of Lower story has square ends. A display model rounds the corners and ends a viewer sees unless the real thing is sharp there. If Lower story's are rounded, round them with cornerRadiusMm, frontRadiusMm or backRadiusMm.",
    )
    expect(squareEndsNotes(plan, { 'lower story': 'square', 'upper story': 'square' })).toEqual([SQUARE_ENDS_NOTE('Lower story')])
    // one end planned round is enough
    expect(squareEndsNotes({ ...plan, ends: { 'Lower story': { front: 'round', back: 'square' } } }, { 'lower story': 'square', 'upper story': 'square' })).toEqual([SQUARE_ENDS_NOTE('Lower story')])
    // a single block lists only itself
    expect(squareEndsNotes({ detail: 'fine', flat: ['Block'] }, { block: 'square' })).toEqual([SQUARE_ENDS_NOTE('Block')])
  })

  it('says nothing when one level is rounded, one is not built or built another way, or the plan has its ends square', () => {
    expect(squareEndsNotes(plan, { 'lower story': 'square', 'upper story': 'rounded' })).toEqual([])
    expect(squareEndsNotes(plan, { 'lower story': 'square' })).toEqual([])
    expect(squareEndsNotes(plan, { 'lower story': 'square', 'upper story': 'other' })).toEqual([])
    expect(squareEndsNotes({ ...plan, ends: { 'Lower story': 'square' } }, { 'lower story': 'square', 'upper story': 'square' })).toEqual([])
    expect(squareEndsNotes({ ...plan, ends: { 'Lower story': { front: 'square', back: 'square' } } }, { 'lower story': 'square', 'upper story': 'square' })).toEqual([])
    expect(squareEndsNotes({ ...plan, detail: 'basic' as const }, { 'lower story': 'square', 'upper story': 'square' })).toEqual([])
    expect(squareEndsNotes(plan, undefined)).toEqual([])
  })

  it('is a note beside the check, never a failed item', () => {
    const cabin: PartPlan = { planId: 'cabin-1', part: 'Cabin', units: 'mm', assumptions: [], questions: [], features: [{ name: 'Lower story', sizes: { height: 6 } }, { name: 'Upper story', sizes: { height: 6 }, on: 'Lower story' }], ...plan }
    const body: BodyFacts = { size: { x: 40, y: 20, z: 12 }, holes: [], features: 2, steps: ['Lower story', 'Upper story'], tags: ['Lower story', 'Upper story'], watertight: true, minWallMm: 6, outlines: { 'lower story': 'square', 'upper story': 'square' } }
    const r = designCheck(cabin, body, 0.4)
    expect(r.pass).toBe(true)
    expect(r.notes).toEqual([SQUARE_ENDS_NOTE('Lower story')])
    expect(designCheck(cabin, { ...body, outlines: { 'lower story': 'square', 'upper story': 'rounded' } }, 0.4).notes).toBeUndefined()
  })
})

describe('design.check on a cabin of two levels', () => {
  async function cabin(upper: Record<string, unknown>) {
    const plans = createPlanRegistry()
    const h = await connect({ geomEngine: (op, request) => geom.engine(op, request), plans })
    const ok = async <T,>(tool: string, args: Record<string, unknown>): Promise<T> => {
      const r = await h.call(tool, args)
      expect(r.isError, `${tool}: ${text(r)}`).toBeFalsy()
      return data<{ output: T }>(r).output
    }
    const design = (await ok<{ design: string }>('slicerx_design_new', { name: 'Cabin' })).design
    await ok('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, placement: { center: [20, 10] }, distance_mm: 6, feature: 'Lower story' })
    await ok('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 30, heightMm: 16, ...upper }, frame: { origin: [0, 0, 5.9], normal: [0, 0, 1] }, placement: { center: [18, 10] }, distance_mm: 4.1, operation: 'join', feature: 'Upper story' })
    plans.put({
      planId: 'cabin-1', part: 'Cabin', units: 'mm', detail: 'display', assumptions: [], questions: [], overall: { x: 40, y: 20, z: 10 },
      features: [{ name: 'Lower story', kind: 'extrude', sizes: { height: 6 } }, { name: 'Upper story', kind: 'extrude', sizes: { height: 4 }, on: 'Lower story' }],
      flat: ['Lower story'], tiers: { 'Lower story': ['Lower story', 'Upper story'] },
    })
    return ok<{ pass: boolean; notes?: string[]; items: { name: string; pass: boolean }[] }>('slicerx_design_check', { planId: 'cabin-1', design })
  }

  it('notes square ends when both levels are plain rectangles', async () => {
    const r = await cabin({})
    expect(r.notes).toEqual([SQUARE_ENDS_NOTE('Lower story')])
  })

  it('has no such note once the upper level has a round front', async () => {
    const r = await cabin({ frontRadiusMm: 8 })
    expect(r.notes ?? []).not.toContain(SQUARE_ENDS_NOTE('Lower story'))
  })
})
