// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A paint step tagged with the plan feature it paints: slicerx_paint_apply takes the feature, the step carries it, and
// slicerx_design_check counts that feature as painted by the step, as a tagged shaping step counts as built.
import { describe, expect, it } from 'vitest'
import { paintTools } from '../src/paint'
import { NO_ENGINE_HOST } from '../src/toolset'
import { createPlanRegistry, designCheck, type BodyFacts, type PartPlan } from '../src/design-check'
import { useGeomEngine } from './geom-engine'
import { connect, data, text } from './helpers'

type Check = { pass: boolean; items: { name: string; want: string; got: string; pass: boolean }[]; body: BodyFacts }

const geom = useGeomEngine('paint-feature-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

// a hull, and a hull paint the plan names with no color or heights (a color the person picks), as the kink's plan did
const plan: PartPlan = {
  planId: 'hull-1',
  part: 'Hull',
  units: 'mm',
  features: [
    { name: 'Hull', kind: 'extrude', sizes: { width: 40, depth: 20, height: 5 } },
    { name: 'Hull paint', kind: 'paint', sizes: {} },
  ],
  overall: { x: 40, y: 20, z: 5 },
  holes: [],
  assumptions: [],
  questions: [],
}

/** A 40 x 20 x 5 hull tagged Hull with its top painted in filament 2, the paint applied with `feature`. */
async function hull(feature?: string) {
  const plans = createPlanRegistry()
  const h = await connect({ geomEngine: engine, plans })
  const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: T }>(r).output
  }
  const design = (await ok<{ design: string }>('slicerx_design_new', { name: 'Hull' })).design
  await ok('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, placement: { center: [20, 10] }, distance_mm: 5, feature: 'Hull' })
  const pv = await ok<{ preview: string }>('slicerx_paint_preview', { design, state: 2, target: { kind: 'direction', direction: 'top' } })
  const applied = await ok<{ step: { id: string; name: string } }>('slicerx_paint_apply', { preview: pv.preview, ...(feature !== undefined ? { feature } : {}) })
  plans.put(plan, design, 'card')
  return { h, ok, design, applied }
}

describe('a paint step tagged with its plan feature', () => {
  it('carries the feature on the step, and design.check counts the feature as painted by it', async () => {
    const { ok, design, applied } = await hull('Hull paint')
    expect(applied.step.name).toBe('Paint the top filament 2')
    const steps = await ok<{ steps: { name: string; feature?: string }[] }>('slicerx_design_steps', { design })
    expect(steps.steps.map((s) => [s.name, s.feature])).toEqual([
      ['Rectangle extrude 5 mm', 'Hull'],
      ['Paint the top filament 2', 'Hull paint'],
    ])
    const r = await ok<Check>('slicerx_design_check', { planId: 'hull-1' })
    const count = r.items.find((i) => i.name === 'feature count')!
    expect(count.pass, count.got).toBe(true)
    expect(count.got).toContain('Hull paint painted by "Paint the top filament 2"')
    expect(r.body.paintTags).toEqual([{ feature: 'Hull paint', step: 'Paint the top filament 2' }])
    expect(r.body.paintUntagged).toEqual([])
  })

  it('fails the feature by name when the paint is applied without it, as before', async () => {
    const { ok, applied } = await hull()
    const r = await ok<Check>('slicerx_design_check', { planId: 'hull-1' })
    const count = r.items.find((i) => i.name === 'feature count')!
    expect(count.pass).toBe(false)
    expect(r.body.paintUntagged).toEqual([{ id: applied.step.id, step: 'Paint the top filament 2' }])
    expect(count.got).toBe(`1 step for 2 planned features; Hull paint: the plan gives it no color; step "${applied.step.id}" ("Paint the top filament 2") is untagged: set its feature to "Hull paint" with slicerx_design_edit_step`)
  })

  it('matches the tag as other tags are matched, case and plurals aside, and a blank one tags nothing', async () => {
    const { ok } = await hull('  hull PAINTS ')
    const r = await ok<Check>('slicerx_design_check', { planId: 'hull-1' })
    expect(r.items.find((i) => i.name === 'feature count')!.pass).toBe(true)
    const blank = await hull('  ')
    const b = await blank.ok<Check>('slicerx_design_check', { planId: 'hull-1' })
    expect(b.body.paintTags).toEqual([])
    expect(b.items.find((i) => i.name === 'feature count')!.pass).toBe(false)
  })

  it('is paint.apply 1.2.0, which takes feature', () => {
    const t = paintTools(NO_ENGINE_HOST).find((x) => x.name === 'paint.apply')!
    expect(t.version).toBe('1.2.0')
    expect(t.input.parse({ preview: 'p1', feature: 'Hull paint' })).toEqual({ preview: 'p1', feature: 'Hull paint' })
  })
})

describe('design.check with paint steps tagged for features', () => {
  const body: BodyFacts = { size: { x: 40, y: 20, z: 5 }, holes: [], features: 2, steps: ['Rectangle extrude 5 mm', 'Fillet 1 mm'], tags: ['Hull', 'Hull'], stepIds: ['s1', 's2'], watertight: true, minWallMm: 5 }
  const item = (b: BodyFacts) => designCheck(plan, b, 0.4).items.find((i) => i.name === 'feature count')!

  it('counts a feature painted by a tagged paint step, and names the step', () => {
    const got = item({ ...body, paintTags: [{ feature: 'Hull paint', step: 'Paint the top filament 2' }] })
    expect(got.pass).toBe(true)
    expect(got.got).toBe('2 steps for 2 features (Hull 2); Hull paint painted by "Paint the top filament 2"')
  })

  it('names every paint step tagged for one feature', () => {
    const got = item({ ...body, paintTags: [{ feature: 'Hull paint', step: 'Paint the top filament 2' }, { feature: 'Hull paint', step: 'Paint the bottom filament 2' }] })
    expect(got.got).toContain('Hull paint painted by "Paint the top filament 2", "Paint the bottom filament 2"')
  })

  it('leaves a paint step tagged for a feature the plan does not have out of the count', () => {
    const got = item({ ...body, paintTags: [{ feature: 'Deck paint', step: 'Paint the top filament 2' }] })
    expect(got.pass).toBe(false)
    expect(got.got).toContain('none tagged for Hull paint')
  })
})

describe('design.check names an untagged paint step for the feature it could paint', () => {
  const body: BodyFacts = { size: { x: 40, y: 20, z: 5 }, holes: [], features: 2, steps: ['Rectangle extrude 5 mm', 'Fillet 1 mm'], tags: ['Hull', 'Hull'], stepIds: ['s1', 's2'], watertight: true, minWallMm: 5 }
  const item = (b: BodyFacts) => designCheck(plan, b, 0.4).items.find((i) => i.name === 'feature count')!
  const hint = 'step "s3" ("Paint the top filament 2") is untagged: set its feature to "Hull paint" with slicerx_design_edit_step'

  it('hints the edit that tags the paint step for the missing paint feature', () => {
    const got = item({ ...body, paintUntagged: [{ id: 's3', step: 'Paint the top filament 2' }] })
    expect(got.pass).toBe(false)
    expect(got.got).toContain(hint)
  })

  it('gives the same hint when there are too few shaping steps', () => {
    const got = item({ ...body, steps: ['Rectangle extrude 5 mm'], tags: [''], stepIds: ['s1'], features: 1, paintUntagged: [{ id: 's3', step: 'Paint the top filament 2' }] })
    expect(got.pass).toBe(false)
    expect(got.got).toContain(hint)
  })

  it('gives no paint hint with no untagged paint step, so the reply is as before', () => {
    expect(item(body).got).not.toContain('is untagged')
    expect(item({ ...body, paintUntagged: [] }).got).toBe(item(body).got)
  })

})
