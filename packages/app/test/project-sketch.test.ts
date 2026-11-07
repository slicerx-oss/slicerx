// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Projecting into a sketch (cad-history project.ts, cad/project-sketch.ts): the curves sit in the sketch as tagged
// loops, a projection follows its body when that body changes and the bodies drawn on the sketch replay with it, in
// the same undo step; a source that is gone keeps its curves and says why; projections save and open with the
// project; and an agent projects, switches and removes through the MCP tool on the app's host, reading back each time.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { BODY_GONE, featureParams, followProjections, historyOf, withHistory, parseTimeline, projectedOf, timelineFiles, withBodyIds, withProjection, withoutProjection, type FaceFrame, type FeatureItem, type HistoryMesh, type ProjectSource, type SketchItem, type SketchLoop, type StepParams, type Timeline } from '@slicerx/cad-history'
import { designToolset } from '@slicerx/mcp/toolset'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appDesignHost } from '../src/cad/design-host'
import { faceSource, followBodies } from '../src/cad/project-sketch'
import { finishSketch, sketchById } from '../src/cad/sketches'
import { setGeomProvider } from '../src/geom/client'
import { createHistory } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { startTimeline } from '../src/plate/timeline'
import { appStore, get, set, type PlateEntry } from '../src/state/store'

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const BED: FaceFrame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }
const square = (w: number): SketchLoop => ({ start: [0, 0], segments: [{ type: 'line', to: [w, 0] }, { type: 'line', to: [w, w] }, { type: 'line', to: [0, w] }, { type: 'line', to: [0, 0] }] })
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
/** How wide a mesh is along x. */
const widest = (m: { positions: ArrayLike<number> }) => {
  const xs = Array.from(m.positions).filter((_, i) => i % 3 === 0)
  return Math.max(...xs) - Math.min(...xs)
}

/**
 * A stand-in engine: a projection is the square as wide as the source body along x, and an extrude of a sketch is a box as wide as its widest real loop. A body 13 mm wide has lost its face.
 */
const calls: string[] = []
const engine = {
  async call<T>(op: string, request: unknown): Promise<T> {
    calls.push(op)
    const r = request as Record<string, unknown>
    if (op === 'sketch.project') {
      const parts = r['parts'] as { mesh: { positions: number[] }; transform: number[] }[]
      const w = Math.max(...parts.map((p) => widest(p.mesh)))
      if (w === 13) throw new Error('sketch.project: source: The face this projected is gone; project it again or remove it.')
      return { loops: [square(w)] } as T
    }
    if (op === 'shape.extrude') {
      const loops = ((r['shape'] as { loops: SketchLoop[] }).loops).filter((l) => !l.construction)
      const w = Math.max(0, ...loops.flatMap((l) => ('segments' in l ? l.segments.map((s) => ('to' in s && s.to ? s.to[0] : 0)) : [])))
      const box = boxMesh(w || 1, w || 1, (r['spec'] as { distanceMm: number }).distanceMm)
      return { mesh: { positions: Array.from(box.positions), indices: Array.from(box.indices) }, report: { touches: true } } as T
    }
    throw new Error(`${op}: not in the stand-in engine`)
  },
}

const body = (id: string, w: number): PlateEntry => ({ id, name: id === 'b' ? 'Block' : id, handle: handle(id), parts: [boxMesh(w, w, 5)], colors: ['#bd93f9'], transform: [...I] })
const faceOf = (b: string): ProjectSource => ({ kind: 'face', body: b, part: 0, transform: [...I], face: { at: [1, 1, 5], normal: [0, 0, 1] } })

let stop: (() => void) | null = null
beforeEach(() => {
  calls.length = 0
  setGeomProvider(engine)
  set({ plate: [], selection: null, selectedIds: [], historyEdit: null, timeline: { bodies: [], items: [], marker: 0 }, rollback: null, objectTool: null, bed: { widthMm: 256, depthMm: 256, heightMm: 256 } })
  stop = startTimeline()
})
afterEach(() => {
  stop?.()
  stop = null
  setGeomProvider(null)
})

describe('projected curves in a sketch', () => {
  const k: SketchItem = { kind: 'sketch', id: 'k1', name: 'Sketch 1', loops: [square(2)] }

  it('sit after the sketch’s own loops, named, and reference ones are construction', () => {
    const a = withProjection(k, { id: 'p1', source: faceOf('b'), mode: 'reference' }, [square(10)])
    expect(a.loops).toHaveLength(2)
    expect(a.loops[0]).toEqual(square(2))
    expect(a.loops[1]).toMatchObject({ projected: 'p1', construction: true })
    // switched to real, the same curves lose construction and close profiles
    const b = withProjection(a, { id: 'p1', source: faceOf('b'), mode: 'real' }, null)
    expect(b.loops[1]).toEqual({ ...square(10), projected: 'p1' })
    // a feature made with the projection gets every loop, the projected ones last
    const f: FeatureItem = { kind: 'feature', id: 's1', body: 'c', part: 0, transform: I, sketch: 'k1', projected: ['p1'], params: { op: 'shape.extrude', placement: {}, spec: { distanceMm: 3 } } as FeatureItem['params'] }
    const p = featureParams(f, new Map([['k1', b]])) as Extract<StepParams, { op: 'shape.extrude' }>
    expect(p.shape).toMatchObject({ type: 'sketch', loops: b.loops })
    const c = withoutProjection(b, 'p1')
    expect(c.loops).toEqual([square(2)])
    expect(c).not.toHaveProperty('projections')
  })

  it('never change what an extrude made before them takes from the sketch', () => {
    const extrude = (loops: SketchLoop[]): StepParams => ({ op: 'shape.extrude', frame: BED, shape: { type: 'sketch', loops }, placement: {}, spec: { distanceMm: 3, operation: 'new' } })
    // an extrude of the sketch's own square, folded into the timeline as a feature on the sketch
    const t0 = withHistory({ bodies: [], items: [{ ...k, frame: BED }], marker: 1 }, 'c', { version: 1, base: [], steps: [{ id: 's1', part: 0, transform: I, params: extrude([square(2)]), sketch: 'k1' }] })
    // real curves projected into the sketch afterwards
    const withP = withProjection(t0.items[0] as SketchItem, { id: 'p1', source: faceOf('b'), mode: 'real' }, [square(10)])
    const t1: Timeline = { ...t0, items: t0.items.map((i) => (i.kind === 'sketch' ? withP : i)) }
    const old = historyOf(t1, 'c')!.steps[0]!.params as Extract<StepParams, { op: 'shape.extrude' }>
    expect(old.shape).toEqual({ type: 'sketch', loops: [square(2)] })
    // an extrude made after them takes them, and keeps taking them as they follow their source
    const t2 = withHistory(t1, 'd', { version: 1, base: [], steps: [{ id: 's2', part: 0, transform: I, params: extrude(withP.loops), sketch: 'k1' }] })
    expect((historyOf(t2, 'd')!.steps[0]!.params as Extract<StepParams, { op: 'shape.extrude' }>).shape).toMatchObject({ loops: withP.loops })
    const moved = withProjection(withP, { id: 'p1', source: faceOf('b'), mode: 'real' }, [square(12)])
    const t3: Timeline = { ...t2, items: t2.items.map((i) => (i.kind === 'sketch' ? moved : i)) }
    expect((historyOf(t3, 'd')!.steps[0]!.params as Extract<StepParams, { op: 'shape.extrude' }>).shape).toMatchObject({ loops: moved.loops })
    expect((historyOf(t3, 'c')!.steps[0]!.params as Extract<StepParams, { op: 'shape.extrude' }>).shape).toEqual({ type: 'sketch', loops: [square(2)] })
  })

  it('follow their source as it stands at the sketch, and keep their curves with a note when it is gone', async () => {
    const s = withProjection(k, { id: 'p1', source: faceOf('b'), mode: 'real' }, [square(10)])
    const t: Timeline = { bodies: [], items: [s], marker: 1 }
    const call = (op: string, r: unknown) => engine.call(op, r)
    let w = 10
    const partsAt = async (b: string, at: number) => {
      expect(at).toBe(0)
      return b === 'b' ? { parts: [boxMesh(w, w, 5) as HistoryMesh], transform: I } : null
    }
    expect((await followProjections(t, partsAt, call)).changed).toEqual([])
    w = 20
    const moved = await followProjections(t, partsAt, call)
    expect(moved.changed).toEqual(['k1'])
    expect(projectedOf((moved.timeline.items[0] as SketchItem).loops, 'p1')).toEqual([{ ...square(20), projected: 'p1' }])
    w = 13
    const lost = await followProjections(moved.timeline, partsAt, call)
    const lk = lost.timeline.items[0] as SketchItem
    expect(lk.projections![0]!.lost).toBe('The face this projected is gone; project it again or remove it.')
    expect(projectedOf(lk.loops, 'p1')).toEqual([{ ...square(20), projected: 'p1' }])
    // found again, the note goes
    w = 30
    const back = (await followProjections(lost.timeline, partsAt, call)).timeline.items[0] as SketchItem
    expect(back.projections![0]).not.toHaveProperty('lost')
    // a body that left the plate
    const gone = (await followProjections({ ...t, items: [withProjection(s, { id: 'p1', source: faceOf('x'), mode: 'real' }, null)] }, partsAt, call)).timeline.items[0] as SketchItem
    expect(gone.projections![0]!.lost).toBe(BODY_GONE)
    // only the bodies asked about
    expect((await followProjections(t, partsAt, call, new Set(['other']))).changed).toEqual([])
  })

  it('save with the project by file id and open on the plate’s ids', () => {
    const s = withProjection({ ...k, id: 'k9' }, { id: 'p1', source: faceOf('b'), mode: 'real' }, [square(10)])
    const lostOne = withProjection(s, { id: 'p2', source: { kind: 'silhouette', body: 'gone' }, mode: 'reference' }, [square(4)])
    const step = { id: 's1', part: 0, transform: I, params: { op: 'face.push', at: [1, 1, 5], normal: [0, 0, 1], distanceMm: 1 } as StepParams }
    const t: Timeline = { bodies: [{ id: 'b', base: [boxMesh(10, 10, 5)] }], items: [{ ...step, kind: 'feature', body: 'b' }, lostOne], marker: 2 }
    const files = new Map(timelineFiles(t, new Map([['b', 7]])).map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
    const read = parseTimeline(files, new Set(['7']))!
    const k2 = read.items.find((i) => i.kind === 'sketch') as SketchItem
    expect(k2.projections!.map((p) => [p.id, p.source.body, p.mode, p.lost ?? null])).toEqual([
      ['p1', '7', 'real', null],
      ['p2', 'gone', 'reference', BODY_GONE],
    ])
    expect(k2.loops).toEqual(lostOne.loops)
    const opened = withBodyIds(read, (id) => (id === '7' ? 'obj_new' : undefined))
    expect((opened.items.find((i) => i.kind === 'sketch') as SketchItem).projections![0]!.source.body).toBe('obj_new')
  })
})

describe('projections in the app', () => {
  it('follow a body that changes, rebuilding the body drawn on the sketch in the same undo step', async () => {
    set({ plate: [body('b', 10)] })
    const host = appDesignHost(loader)
    const s = finishSketch({ frame: BED, loops: [] })
    const r = await host.project!(s.id, faceOf('b'), 'real')
    expect(r.projection).toBe('p1')
    expect(projectedOf(r.sketch.loops, 'p1')).toEqual([{ ...square(10), projected: 'p1' }])
    // a body extruded from the projected face
    const d = await host.create('Lid', [])
    const extrude: StepParams = { op: 'shape.extrude', frame: BED, shape: { type: 'sketch', loops: r.sketch.loops }, placement: {}, spec: { distanceMm: 2, operation: 'new' } }
    await host.add(d, 0, extrude, undefined, { sketch: s.id })
    const lid = () => get().plate.find((e) => e.id === d.id)!
    expect(widest(lid().parts[0]!)).toBe(10)
    const undo = createHistory(appStore)
    // the block grows: the projection follows it, and the lid rebuilds from the new curves
    set((st) => ({ plate: st.plate.map((e) => (e.id === 'b' ? { ...e, parts: [boxMesh(16, 16, 5)] } : e)) }))
    await followBodies(loader, ['b'])
    expect(projectedOf(sketchById(get().timeline, s.id)!.loops, 'p1')).toEqual([{ ...square(16), projected: 'p1' }])
    expect(widest(lid().parts[0]!)).toBe(16)
    // one undo takes back the change and what followed from it
    expect(undo.state().undo).toBe(1)
    undo.undo()
    expect(widest(get().plate.find((e) => e.id === 'b')!.parts[0]!)).toBe(10)
    expect(projectedOf(sketchById(get().timeline, s.id)!.loops, 'p1')).toEqual([{ ...square(10), projected: 'p1' }])
    expect(widest(lid().parts[0]!)).toBe(10)
    undo.dispose()
  })

  it('leaves a body extruded from the sketch before a projection as it was', async () => {
    set({ plate: [body('b', 10)] })
    const host = appDesignHost(loader)
    const s = finishSketch({ frame: BED, loops: [square(4)] })
    const d = await host.create('Tab', [])
    await host.add(d, 0, { op: 'shape.extrude', frame: BED, shape: { type: 'sketch', loops: [square(4)] }, placement: {}, spec: { distanceMm: 2, operation: 'new' } }, undefined, { sketch: s.id })
    const tab = () => get().plate.find((e) => e.id === d.id)!
    expect(widest(tab().parts[0]!)).toBe(4)
    const r = await host.project!(s.id, faceOf('b'), 'real')
    // the 10 mm outline is in the sketch, and the tab made from the 4 mm square did not grow or rebuild
    expect(projectedOf(r.sketch.loops, 'p1')).toEqual([{ ...square(10), projected: 'p1' }])
    expect(r.replayed).toBe(0)
    expect(widest(tab().parts[0]!)).toBe(4)
  })

  it('takes a picked face with its outward normal and key, in world mm', () => {
    const box = boxMesh(10, 10, 5)
    const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 40, 30, 0, 1]
    const pos = box.positions
    // a triangle of the top: all three corners at the box's highest z
    const top = Math.max(...Array.from(pos).filter((_, i) => i % 3 === 2))
    const t = [...Array(box.indices.length / 3).keys()].find((k) => [0, 1, 2].every((j) => pos[3 * box.indices[3 * k + j]! + 2] === top))!
    const s = faceSource({ id: 'b', parts: [box], transform: moved }, 0, t, [41, 31, top])
    expect(s).toMatchObject({ kind: 'face', body: 'b', part: 0, transform: moved, face: { at: [41, 31, top] } })
    if (s.kind !== 'face') throw new Error('not a face')
    expect(s.face.normal.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 1])
  })

  it('keeps the curves and says why when the source is gone', async () => {
    set({ plate: [body('b', 10)] })
    const host = appDesignHost(loader)
    const s = finishSketch({ frame: BED, loops: [square(3)] })
    await host.project!(s.id, faceOf('b'), 'reference')
    set((st) => ({ plate: st.plate.map((e) => (e.id === 'b' ? { ...e, parts: [boxMesh(13, 13, 5)] } : e)) }))
    await followBodies(loader, ['b'])
    const k = sketchById(get().timeline, s.id)!
    expect(k.projections![0]!.lost).toMatch(/^The face this projected is gone/)
    expect(projectedOf(k.loops, 'p1')).toEqual([{ ...square(10), projected: 'p1', construction: true }])
    set((st) => ({ plate: st.plate.filter((e) => e.id !== 'b') }))
    await followBodies(loader, ['b'])
    expect(sketchById(get().timeline, s.id)!.projections![0]!.lost).toBe(BODY_GONE)
    // the sketch's own loop never moved
    expect(sketchById(get().timeline, s.id)!.loops[0]).toEqual(square(3))
  })

  it('lets an agent project, switch and remove through the MCP tool, reading back each time', async () => {
    set({ plate: [body('b', 10)] })
    const host = appDesignHost(loader)
    const tools = designToolset(host)
    const run = (input: Record<string, unknown>) => tools.find((t) => t.name === 'design.sketch_project')!.run(input as never, {} as never)
    const s = finishSketch({ frame: BED, loops: [] })
    const added = await run({ sketch: s.id, design: 'b', kind: 'face', face: { at: [5, 5, 5], normal: [0, 0, 1] }, mode: 'real' })
    expect(added.summary).toBe(`Projected the face outline of Block into ${s.name} as real curves: 4 lines`)
    expect(added.output).toMatchObject({ sketch: s.id, projection: 'p1', loops: 1, replayed: 0, projections: [{ id: 'p1', kind: 'face', body: 'b', part: 0, mode: 'real', loops: [square(10)] }] })
    // the source keeps the face as picked, world mm at the body's transform
    const src = sketchById(get().timeline, s.id)!.projections![0]!.source
    expect(src).toMatchObject({ kind: 'face', body: 'b', part: 0, transform: I, face: { at: [5, 5, 5], normal: [0, 0, 1] } })
    // real unless asked otherwise
    const outline = await run({ sketch: s.id, design: 'b', kind: 'silhouette' })
    expect(outline.output).toMatchObject({ projection: 'p2', projections: [{ id: 'p1' }, { id: 'p2', kind: 'silhouette', mode: 'real', loops: [square(10)] }] })
    const switched = await run({ sketch: s.id, projection: 'p2', mode: 'reference' })
    expect(switched.summary).toBe(`p2 of ${s.name} is now reference curves`)
    expect(sketchById(get().timeline, s.id)!.loops.map((l) => l.construction ?? false)).toEqual([false, true])
    const removed = await run({ sketch: s.id, projection: 'p1', remove: true })
    expect(removed.output).toMatchObject({ projections: [{ id: 'p2' }], loops: 1 })
    await expect(run({ sketch: s.id, projection: 'p9', mode: 'real' })).rejects.toThrow(/no projection p9/)
    await expect(run({ sketch: s.id, design: 'b', kind: 'face' })).rejects.toThrow(/^face:/)
  })
})
