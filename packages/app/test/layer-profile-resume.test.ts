// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A resume of a plate with its own layer heights when the app has no current slice (a reopened project, a resume from
// the fleet): the plan counts layers in the tops the resumed slice prints, the plate's own, stretched by a Z shrinkage
// as the engine stretches them, not in even layers of layer_height. The plan runs in the real geometry engine.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, SliceRequest } from '@slicerx/contracts'
import { toGeom } from '../src/geom/client'
import { planResume } from '../src/geom/resume'
import { boxMesh } from '../src/plate/mesh-ops'
import { setPlateLayerProfile } from '../src/plate/plates'
import { jobLayerTops, resumePlanTops, stretchTops, zShrinkFactor } from '../src/plate/resume-tops'
import { compose } from '../src/plate/transform'
import { slicePlate } from '../src/state/actions'
import { get, set, type PlateEntry } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('layer-profile-resume-replies')

const part = { ...boxMesh(10, 10, 10), name: 'Body', slot: 1 }
const box: PlateEntry = { id: 'a', name: 'Box', handle: { id: 'a', hash: 'a', name: 'a', triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'Body', slot: 1, triangles: 12 }] }, parts: [part], colors: ['#fff'], transform: compose({ position: [60, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
const parts = () => get().plate.map((p) => ({ mesh: toGeom(p.parts[0]!), transform: p.transform }))
const LIMITS = { layer_height: 0.2, initial_layer_print_height: 0.2, min_layer_height: [0.08], max_layer_height: [0.28] }

/** A host whose slice records the request and then stops, enough to read what the resume sends. */
function capture(): { host: Host; requests: SliceRequest[] } {
  const requests: SliceRequest[] = []
  const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { slice: async (r: SliceRequest) => { requests.push(r); throw new Error('stop') }, loadParts: async () => box.handle } } as unknown as Host
  return { host, requests }
}

beforeEach(() => {
  set({ plate: [box], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', resume: null, slice: { status: 'idle' }, calibration: {}, layerMarks: {}, objectSettings: {}, overrides: { ...LIMITS }, easy: { ...get().easy, varyLayerHeight: false } })
  // 0.1 mm layers drawn on a plate whose layer_height is 0.2 mm.
  setPlateLayerProfile('plate-1', [[0, 0.1]])
})

describe('a resume of a plate with its own layer heights and no current slice', () => {
  it('plans in the tops the slice sends, so 5 mm resumes at 5 mm and not at layer 25 of even layers', async () => {
    expect(jobLayerTops(get())).toBeUndefined()
    const tops = resumePlanTops(get())!
    expect(tops[0]).toBe(0.2)
    expect(tops[1]).toBeCloseTo(0.3, 9)
    expect(tops[tops.length - 1]).toBe(10)

    const plan = await planResume(parts(), { measuredHeightMm: 5, layerHeightMm: 0.2, firstLayerHeightMm: 0.2, layerTopsMm: tops })
    // The last layer on the bed ends at the measured height, within half a layer.
    expect(Math.abs(tops[plan.resumeLayer - 1]! - 5)).toBeLessThanOrEqual(0.05 + 1e-9)
    expect(plan.printedHeightMm).toBeCloseTo(tops[plan.resumeLayer - 1]!, 6)
    // Even layers, the plan before: layer 25 is only 2.6 mm up the plate's own tops.
    const even = await planResume(parts(), { measuredHeightMm: 5, layerHeightMm: 0.2, firstLayerHeightMm: 0.2 })
    expect(Math.abs(tops[even.resumeLayer - 1]! - 5)).toBeGreaterThan(2)

    // The slice sends the plate's own tops, unstretched and not marked as a job's, from that layer.
    set({ resume: { plan: { resumeLayer: plan.resumeLayer, printedHeightMm: plan.printedHeightMm } } })
    const { host, requests } = capture()
    await slicePlate(host)
    expect(requests[0]!.options).toMatchObject({ resumeFromLayer: plan.resumeLayer, layerTopsMm: tops, layerTopsExact: true })
    expect(requests[0]!.options).not.toHaveProperty('layerTopsSliced')
  })

  it('plans in the tops the engine stretches for a Z shrinkage compensation', async () => {
    set({ overrides: { ...LIMITS, filament_shrinkage_compensation_z: ['99.5%'] } })
    const tops = resumePlanTops(get())!
    expect(tops[0]).toBe(0.2)
    expect(tops[tops.length - 1]).toBeCloseTo(10 / 0.995, 9)
    const plan = await planResume(parts(), { measuredHeightMm: 5, layerHeightMm: 0.2, firstLayerHeightMm: 0.2, layerTopsMm: tops })
    expect(Math.abs(tops[plan.resumeLayer - 1]! - 5)).toBeLessThanOrEqual(0.05 + 1e-9)
    // The slice still sends the drawn tops; the engine stretches them to the same layers.
    set({ resume: { plan: { resumeLayer: plan.resumeLayer, printedHeightMm: plan.printedHeightMm } } })
    const { host, requests } = capture()
    await slicePlate(host)
    expect(stretchTops(requests[0]!.options!.layerTopsMm!, 100 / 99.5)).toEqual(tops)
  })

  it("uses the job's own layers whenever the app has them", () => {
    set({ resume: { plan: { resumeLayer: 3, printedHeightMm: 0.6 }, layerTopsMm: [0.2, 0.4, 0.6, 0.8] } })
    expect(resumePlanTops(get())).toEqual([0.2, 0.4, 0.6, 0.8])
  })
})

describe('the Z shrinkage factor', () => {
  it('applies only when every slot shares the same values, as in the engine', () => {
    expect(zShrinkFactor({ filament_shrinkage_compensation_z: ['99.5%', '99.5%'] }, [1, 2])).toBeCloseTo(1 / 0.995, 12)
    expect(zShrinkFactor({ filament_shrinkage_compensation_z: ['99.5%', '100%'] }, [1, 2])).toBe(1)
    expect(zShrinkFactor({ filament_shrinkage_compensation_z: ['99.5%'], filament_shrink: ['99%', '100%'] }, [1, 2])).toBe(1)
    expect(zShrinkFactor({}, [1])).toBe(1)
  })
})
