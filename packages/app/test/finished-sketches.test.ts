// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Finish sketch (cad/sketches.ts): the sketch goes in the timeline without a solid, undo takes it out, a step made
// from it names it, and Model draws it until a feature uses it or the marker rolls back past it.
import { afterEach, describe, expect, it } from 'vitest'
import { type FaceFrame, type History, type SketchLoop, type StepParams } from '@slicerx/cad-history'
import { finishSketch, sketchById, usersOf } from '../src/cad/sketches'
import { sketchNext, withStep } from '../src/cad/history/record'
import { fromLoops, profileRings } from '../src/cad/sketch-model'
import { createHistory } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { startTimeline } from '../src/plate/timeline'
import { appStore, type PlateEntry } from '../src/state/store'
import { shownSketches, sketchScene } from '../src/workspaces/design/finished-sketches'

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const XZ: FaceFrame = { origin: [0, 0, 0], normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }
const square = (): SketchLoop => ({ start: [0, 0], segments: [{ type: 'line', to: [4, 0] }, { type: 'line', to: [4, 4] }, { type: 'line', to: [0, 4] }, { type: 'line', to: [0, 0] }] })
const open = (): SketchLoop => ({ start: [0, 0], segments: [{ type: 'line', to: [4, 0] }, { type: 'line', to: [4, 4] }] })
const extrude = (frame: FaceFrame): StepParams => ({ op: 'shape.extrude', frame, shape: { type: 'sketch', loops: [square()] }, placement: {}, spec: { distanceMm: 3, operation: 'new' } })

let stop: (() => void) | null = null
afterEach(() => {
  stop?.()
  stop = null
  sketchNext(null)
  appStore.setState({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', timeline: { bodies: [], items: [], marker: 0 }, rollback: null, objectTool: null })
})

describe('Finish sketch', () => {
  it('puts the sketch in the timeline as Sketch N at the marker, and undo takes it out', () => {
    const undo = createHistory(appStore)
    const k = finishSketch({ frame: XZ, loops: [square()] })
    const t = appStore.getState().timeline
    expect(k).toMatchObject({ kind: 'sketch', name: 'Sketch 1', frame: XZ })
    expect(t.items).toHaveLength(1)
    expect(t.marker).toBe(1)
    expect(sketchById(t, k.id)).toBe(k)
    // on the bed the sketch keeps no frame
    expect(finishSketch({ loops: [square()] })).not.toHaveProperty('frame')
    undo.undo()
    undo.undo()
    expect(appStore.getState().timeline.items).toHaveLength(0)
    undo.dispose()
  })

  it('names the sketch in the step a tool records from it, once', () => {
    sketchNext('kx')
    const e = { parts: [boxMesh(5, 5, 5)], transform: T } as Pick<PlateEntry, 'parts' | 'history' | 'transform'>
    const h = withStep(e, 0, extrude(XZ))
    expect(h.steps[0]!.sketch).toBe('kx')
    expect(withStep({ ...e, history: h }, 0, extrude(XZ)).steps[1]!.sketch).toBeUndefined()
    // a step that draws on no sketch never takes one
    sketchNext('ky')
    expect(withStep(e, 0, { op: 'face.push', at: [0, 0, 5], normal: [0, 0, 1], distanceMm: 2 }).steps[0]!.sketch).toBeUndefined()
  })

  it('links the feature to the finished sketch and hides the sketch once a live feature uses it', () => {
    stop = startTimeline()
    const k = finishSketch({ frame: XZ, loops: [square()] })
    expect(shownSketches(appStore.getState().timeline).map((s) => s.id)).toEqual([k.id])
    const h: History = { version: 1, base: [], steps: [{ id: 's9', part: 0, transform: T, params: extrude(XZ), sketch: k.id }] }
    appStore.setState({ plate: [{ id: 'b', name: 'Box', handle: { id: 'b', hash: 'b', name: 'b', triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }, parts: [boxMesh(4, 4, 3)], colors: ['#bd93f9'], transform: T, history: h }] })
    const t = appStore.getState().timeline
    expect(t.items.map((i) => (i.kind === 'sketch' ? i.id : `${i.body}:${i.sketch}`))).toEqual([k.id, `b:${k.id}`])
    expect(usersOf(t, k.id)).toEqual(['b'])
    expect(shownSketches(t)).toEqual([])
    // rolled back past the feature, the sketch shows again; past the sketch, it hides
    expect(shownSketches({ ...t, marker: 1 }).map((s) => s.id)).toEqual([k.id])
    expect(shownSketches({ ...t, marker: 0 })).toEqual([])
  })

  it('draws a finished sketch on its plane, a closed loop shaded and an open one not', () => {
    const k = finishSketch({ frame: XZ, loops: [square(), open()] })
    const scene = sketchScene(k)!
    expect(scene.frame).toEqual(XZ)
    expect(scene.paths.length).toBeGreaterThan(0)
    expect(scene.profiles).toHaveLength(1)
    expect(profileRings(fromLoops([open()])!)).toEqual([])
  })
})
