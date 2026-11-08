// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A timeline sketch's frame is stored once, in plate coordinates, and read where it stands now: moved with the design
// it was drawn for, else with the body of the first feature drawn on it (cad-history design-frame.ts). A step drawn on
// it is recorded where the sketch is stored, so folding the step into the timeline writes the frame the sketch has, and
// nothing a feature's undo, redo, deletion or a change of owner does rewrites it. Plain timelines, no engine.
import { frameNow, historyOf, recordedOn, sketchMove, syncTimeline, withSketch, type DrawnFor, type FaceFrame, type History, type HistoryMesh, type Mat4, type StepParams, type Timeline } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'

const at = (x: number, y: number): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]
const TOP: FaceFrame = { origin: [128, 128, 10], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }
const RING = [{ type: 'circle' as const, center: [0, 0] as [number, number], diameterMm: 6 }]
const BOX: HistoryMesh = { name: 'Box', slot: 1, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3] }

/** A cut on sketch `k`, given on `frame`. */
const cut = (frame: FaceFrame): StepParams => ({ op: 'shape.extrude', frame, shape: { type: 'sketch', loops: RING }, placement: {}, spec: { distanceMm: 2, operation: 'cut' } })
const history = (...steps: History['steps']): History => ({ version: 1, base: [BOX], steps })
const sketchOf = (t: Timeline, id = 'k') => t.items.find((i) => i.kind === 'sketch' && i.id === id)
const frameOf = (t: Timeline, id = 'k') => {
  const k = sketchOf(t, id)
  return k?.kind === 'sketch' ? k.frame : undefined
}
const EMPTY: Timeline = { bodies: [], items: [], marker: 0 }
const plate = (o: Record<string, Mat4>) => (b: string) => o[b]
/** An object on the plate with its history, standing at `transform`. */
const on = (id: string, h: History, transform: Mat4) => ({ id, history: h, transform })

describe('a sketch frame stored once', () => {
  it('stays stored as drawn when its only feature is undone and redone after its body moved, and the feature replays where it was made', () => {
    const t0 = withSketch(EMPTY, { id: 'k', frame: TOP, loops: RING })
    const s1 = { id: 's1', part: 0, transform: at(128, 128), params: cut(TOP), sketch: 'k' }
    const t1 = syncTimeline(t0, [on('D', history(s1), at(128, 128))])
    // the person drags D 30 mm, then its cut is undone and redone
    const t2 = syncTimeline(t1, [on('D', history(), at(158, 128))])
    expect(frameOf(t2)).toEqual(TOP)
    const t3 = syncTimeline(t2, [on('D', history(s1), at(158, 128))])
    expect(frameOf(t3)).toEqual(TOP)
    expect(historyOf(t3, 'D')!.steps[0]).toMatchObject({ transform: at(128, 128), params: { frame: TOP } })
    // carried by the cut, it stands 30 mm over; with the cut undone, where it was drawn
    expect(sketchMove(t3, 'k', plate({ D: at(158, 128) }))).toEqual(at(30, 0))
    expect(sketchMove(t2, 'k', plate({ D: at(158, 128) }))).toEqual(at(0, 0))
  })

  it('records a step on a sketch drawn for a design that moved where the sketch is stored, and reads it the same through undo and redo', () => {
    const drawnFor: DrawnFor[] = [{ design: 'D', transform: at(128, 128) }]
    const t0 = withSketch(EMPTY, { id: 'k', frame: TOP, loops: RING, drawnFor })
    const where = plate({ D: at(158, 128) })
    const now = frameNow(t0, sketchOf(t0) as never, where)!
    expect(now.origin).toEqual([158, 128, 10])
    // the step as given on the plane where the sketch stands now, on D standing where it was dragged
    const r = recordedOn(t0, 'k', at(158, 128), cut(now), where)
    expect(r.transform).toEqual(at(128, 128))
    expect(r.params).toEqual(cut(TOP))
    const s1 = { id: 's1', part: 0, transform: r.transform, params: r.params, sketch: 'k' }
    const t1 = syncTimeline(t0, [on('D', history(s1), at(158, 128))])
    const t2 = syncTimeline(t1, [on('D', history(), at(158, 128))])
    const t3 = syncTimeline(t2, [on('D', history(s1), at(158, 128))])
    for (const t of [t1, t2, t3]) {
      expect(frameOf(t)).toEqual(TOP)
      expect(sketchMove(t, 'k', where)).toEqual(at(30, 0))
    }
  })

  it('keeps another body\'s feature and the sketch as stored when the first feature on a shared sketch goes', () => {
    const t0 = withSketch(EMPTY, { id: 'k', frame: TOP, loops: RING })
    const sD = { id: 's1', part: 0, transform: at(128, 128), params: cut(TOP), sketch: 'k' }
    const t1 = syncTimeline(t0, [on('D', history(sD), at(128, 128))])
    // D dragged 10 mm; then E's cut on the same sketch, given where the sketch stands now, recorded through the rule
    const where = plate({ D: at(138, 128), E: at(50, 128) })
    const now = frameNow(t1, sketchOf(t1) as never, where)!
    const r = recordedOn(t1, 'k', at(50, 128), cut(now), where)
    const sE = { id: 's2', part: 0, transform: r.transform, params: r.params, sketch: 'k' }
    const t2 = syncTimeline(t1, [on('D', history(sD), at(138, 128)), on('E', history(sE), at(50, 128))])
    const e = historyOf(t2, 'E')
    // D's cut undone, then D deleted: E's step and the sketch never change, and the sketch reads where it stood
    const t3 = syncTimeline(t2, [on('D', history(), at(138, 128)), on('E', history(sE), at(50, 128))])
    const t4 = syncTimeline(t3, [on('E', history(sE), at(50, 128))])
    for (const t of [t3, t4]) {
      expect(frameOf(t)).toEqual(TOP)
      expect(historyOf(t, 'E')).toEqual(e)
      expect(frameNow(t, sketchOf(t) as never, where)).toEqual(now)
    }
  })
})
