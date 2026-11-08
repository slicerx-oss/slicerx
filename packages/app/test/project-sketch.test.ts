// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Projecting into a sketch (cad-history project.ts, cad/project-sketch.ts): the curves sit in the sketch as tagged
// loops, a projection follows its body when that body changes and the bodies drawn on the sketch replay with it, in
// the same undo step; a source that is gone keeps its curves and says why; projections save and open with the
// project; an MCP client projects, switches and removes through the MCP tool on the app's host, reading back each time;
// an Extrude of a new sketch with a projection leaves no sketch behind when it fails and undoes in one step when it
// lands; and an SVG sketch keeps its own loops in order with the projected ones last.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { BODY_GONE, clearReplayCache, featureParams, followProjections, historyOf, MAX_PROJECTION, nextProjectionId, TOO_MANY_PROJECTIONS, projectRequest, withHistory, parseTimeline, projectedOf, timelineFiles, withBodyIds, withProjection, withoutProjection, type FaceFrame, type FeatureItem, type HistoryMesh, type ProjectSource, type SketchItem, type SketchLoop, type StepParams, type Timeline } from '@slicerx/cad-history'
import { designToolset } from '@slicerx/mcp/toolset'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appDesignHost } from '../src/cad/design-host'
import { addsTo, bodyOf, changeProjection, faceSource, followBodies, projectNow } from '../src/cad/project-sketch'
import { afterSolid, finishSketch, oneAtATime, sketchById, solidOnNewSketch, updateSketch } from '../src/cad/sketches'
import { applyExtrude, applyRevolve, type ExtrudeInput } from '../src/cad/cad-ops'
import { setGeomProvider } from '../src/geom/client'
import { createHistory, history, quietly, type UndoStep } from '../src/plate/history'
import { stepWords } from '../src/workspaces/mimir/step-words'
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

// what design.sketch_svg answers for a square, a round hole and a leaf of a line, an arc and a spline
const ART: SketchLoop[] = [
  { start: [80, 120], segments: [{ type: 'line', to: [120, 120] }, { type: 'line', to: [120, 80] }, { type: 'line', to: [80, 80] }, { type: 'line', to: [80, 120] }] },
  { type: 'circle', center: [100, 100], diameterMm: 16 },
  { start: [130, 80], segments: [{ type: 'line', to: [150, 80] }, { type: 'arc', to: [150, 100], through: [160, 90] }, { type: 'spline', points: [[140, 104], [133, 95]], to: [130, 80] }] },
]

/**
 * A stand-in engine: a projection is the square as wide as the source body along x, and an extrude of a sketch is a box as wide as its widest real loop (none is an error). A body 13 mm wide has lost its face.
 */
const calls: string[] = []
/** While set, sketch.project waits for it: a follow still running when another edit lands. */
let hold: Promise<void> | null = null
/** The next shape.extrude refuses with this message, misses the body it joins, or lands on it changing this much volume; used once. */
let nextExtrude: { refuse: string } | 'miss' | { hit: number } | null = null
/** While set, sketch.revolve makes a body as an extrude of the sketch would; otherwise it is not in the stand-in engine. */
let revolves = false
/** How wide the exact kernel's join leaves a body. */
const JOINED = 14
/** A box as the engine sends it. */
const boxOf = (w: number, h: number) => {
  const box = boxMesh(w, w, h)
  return { positions: Array.from(box.positions), indices: Array.from(box.indices) }
}
/** How wide a sketch's real loops make a solid: the furthest x any of them reaches. */
const reach = (loops: SketchLoop[]) => Math.max(0, ...loops.filter((l) => !l.construction).flatMap((l) => ('segments' in l ? l.segments.map((s) => ('to' in s && s.to ? s.to[0] : 0)) : [])))
/** While set, shape.extrude waits for it: the engine still working when another edit or a second Enter comes. */
let holdExtrude: Promise<void> | null = null
const engine = {
  async call<T>(op: string, request: unknown): Promise<T> {
    calls.push(op)
    const r = request as Record<string, unknown>
    if (op === 'sketch.project') {
      if (hold) await hold
      const parts = r['parts'] as { mesh: { positions: number[] }; transform: number[] }[]
      const w = Math.max(...parts.map((p) => widest(p.mesh)))
      if (w === 13) throw new Error('sketch.project: source: The face this projected is gone; project it again or remove it.')
      return { loops: [square(w)] } as T
    }
    if (op === 'shape.extrude') {
      if (holdExtrude) await holdExtrude
      const next = nextExtrude
      nextExtrude = null
      if (next && next !== 'miss' && 'refuse' in next) throw new Error(next.refuse)
      if (next === 'miss') return { mesh: { positions: [], indices: [] }, frame: 'target', report: { touches: false, volumeChangeMm3: 0 } } as T
      const loops = ((r['shape'] as { loops: SketchLoop[] }).loops).filter((l) => !l.construction)
      if (!loops.length) throw new Error('shape.extrude: shape: the sketch has no closed profile')
      const w = reach(loops)
      // a join or cut answers in the body's frame, the body as it is after
      if (next) return { mesh: boxOf(12, 5), frame: 'target', report: { touches: true, volumeChangeMm3: next.hit, watertight: true } } as T
      return { mesh: boxOf(w || 1, (r['spec'] as { distanceMm: number }).distanceMm), report: { touches: true } } as T
    }
    if (op === 'sketch.revolve' && revolves) return { mesh: boxOf(reach(r['loops'] as SketchLoop[]) || 1, 8), frame: 'world', report: { touches: true, volumeChangeMm3: 800, watertight: true } } as T
    // the exact kernel: a solid is named for its width, and its faces are one plane
    if (op === 'sketch.curves') return (r['loops'] as SketchLoop[]).filter((l) => !l.construction && 'segments' in l).map((l) => ({ outer: { points: [(l as { start: [number, number] }).start, ...(l as { segments: { to: [number, number] }[] }).segments.map((s) => s.to)] }, holes: [] })) as T
    if (op === 'brep.extrude') {
      const polygons = r['polygons'] as { outer: { points: [number, number][] } }[]
      return { bodySmb: `w${r['target'] ? JOINED : Math.max(...polygons.flatMap((p) => p.outer.points.map((q) => q[0])))}`, touches: true } as T
    }
    if (op === 'brep.tessellate') {
      const box = boxOf(Number(((r['body'] as { smb: string }).smb).slice(1)), 5)
      return { ...box, faceIds: box.indices.filter((_, i) => i % 3 === 0).map(() => 0), faces: [{ surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 1 }] } as T
    }
    if (op === 'sketch.svg') return { loops: ART, counts: { lines: 5, arcs: 1, splines: 1, circles: 1 }, sizeMm: [80, 40], mmPerUnit: 1, check: { ok: true, loops: [], issues: [] }, warnings: [] } as T
    throw new Error(`${op}: not in the stand-in engine`)
  },
}

const body = (id: string, w: number): PlateEntry => ({ id, name: id === 'b' ? 'Block' : id, handle: handle(id), parts: [boxMesh(w, w, 5)], colors: ['#bd93f9'], transform: [...I] })
const faceOf = (b: string): ProjectSource => ({ kind: 'face', body: b, part: 0, transform: [...I], face: { at: [1, 1, 5], normal: [0, 0, 1] } })

let stop: (() => void) | null = null
beforeEach(() => {
  calls.length = 0
  hold = null
  nextExtrude = null
  holdExtrude = null
  revolves = false
  clearReplayCache()
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

  it('projects, switches and removes through the MCP tool, reading back each time', async () => {
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

const extrudeOf = (loops: SketchLoop[], distanceMm = 2): StepParams => ({ op: 'shape.extrude', frame: BED, shape: { type: 'sketch', loops }, placement: {}, spec: { distanceMm, operation: 'new' } })
const featureOn = (t: Timeline, b: string) => t.items.find((i) => i.kind === 'feature' && i.body === b) as FeatureItem
const fileMap = (t: Timeline, ids: [string, number][]) => new Map(timelineFiles(t, new Map(ids)).map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
const loopsOf = (h: ReturnType<typeof historyOf>, i = 0) => (h!.steps[i]!.params as Extract<StepParams, { op: 'shape.extrude' }>).shape as { loops: SketchLoop[] }
const round = (v: readonly number[]) => v.map((x) => Math.round(x * 1e9) / 1e9 + 0)

describe('projection ids', () => {
  it('are never handed out again after a removal, so an extrude never takes a later projection', async () => {
    set({ plate: [body('b', 10), body('e', 20)] })
    const host = appDesignHost(loader)
    const s = finishSketch({ frame: BED, loops: [square(4)] })
    const r1 = await host.project!(s.id, faceOf('b'), 'real')
    const d = await host.create('Tab', [])
    await host.add(d, 0, extrudeOf(r1.sketch.loops), undefined, { sketch: s.id })
    const tab = () => get().plate.find((e) => e.id === d.id)!
    expect(widest(tab().parts[0]!)).toBe(10)
    expect(featureOn(get().timeline, d.id).projected).toEqual(['p1'])
    // removing p1 takes it out of the tab, and out of the list of what the tab takes
    await host.changeProjection!(s.id, 'p1', { remove: true })
    expect(widest(tab().parts[0]!)).toBe(4)
    expect(featureOn(get().timeline, d.id).projected).toBeUndefined()
    // a later projection gets a new id, and the tab stays as it is
    const r2 = await host.project!(s.id, faceOf('e'), 'real')
    expect(r2.projection).toBe('p2')
    expect(r2.replayed).toBe(0)
    expect(widest(tab().parts[0]!)).toBe(4)
    expect(loopsOf(historyOf(get().timeline, d.id)).loops).toEqual([square(4)])
  })

  it('keep counting through save and open, and in files saved before the count was kept', () => {
    const k: SketchItem = { kind: 'sketch', id: 'k1', name: 'Sketch 1', frame: BED, loops: [square(4)] }
    const t0 = withHistory({ bodies: [], items: [k], marker: 1 }, 'c', { version: 1, base: [], steps: [{ id: 's1', part: 0, transform: I, params: extrudeOf([square(4)]), sketch: 'k1' }] })
    // p1 and p2 came and went
    const gone = withoutProjection(withoutProjection(withProjection(withProjection(t0.items[0] as SketchItem, { id: 'p1', source: faceOf('c'), mode: 'real' }, [square(10)]), { id: 'p2', source: faceOf('c'), mode: 'real' }, [square(12)]), 'p1'), 'p2')
    expect(nextProjectionId(gone)).toBe('p3')
    const t1: Timeline = { ...t0, items: t0.items.map((i) => (i.kind === 'sketch' ? gone : i)) }
    const read = parseTimeline(fileMap(t1, [['c', 7]]), new Set(['7']))!
    expect(nextProjectionId(read.items.find((i) => i.kind === 'sketch') as SketchItem)).toBe('p3')
    // an older file: no count, but the extrude still names p2
    const old: Timeline = { ...t1, items: t1.items.map((i) => (i.kind === 'sketch' ? { ...k } : { ...i, projected: ['p2'] })) }
    const files = fileMap(old, [['c', 7]])
    const j = JSON.parse(new TextDecoder().decode(files.get('Metadata/slicerx_history.json')!)) as { items: Record<string, unknown>[] }
    for (const it of j.items) if (it['kind'] === 'sketch') delete it['nextProjection']
    files.set('Metadata/slicerx_history.json', new TextEncoder().encode(JSON.stringify(j)))
    const read2 = parseTimeline(files, new Set(['7']))!
    expect(nextProjectionId(read2.items.find((i) => i.kind === 'sketch') as SketchItem)).toBe('p3')
  })
})

describe('projections in a saved project', () => {
  const k: SketchItem = { kind: 'sketch', id: 'k1', name: 'Sketch 1', frame: BED, loops: [square(2)] }
  // c extruded from the sketch's own square, then p1 projected, then d extruded with it
  const saved = () => {
    const t0 = withHistory({ bodies: [], items: [k], marker: 1 }, 'c', { version: 1, base: [], steps: [{ id: 's1', part: 0, transform: I, params: extrudeOf([square(2)]), sketch: 'k1' }] })
    const withP = withProjection(t0.items[0] as SketchItem, { id: 'p1', source: faceOf('c'), mode: 'real' }, [square(10)])
    const t1: Timeline = { ...t0, items: t0.items.map((i) => (i.kind === 'sketch' ? withP : i)) }
    return { t: withHistory(t1, 'd', { version: 1, base: [], steps: [{ id: 's2', part: 0, transform: I, params: extrudeOf(withP.loops), sketch: 'k1' }] }), withP }
  }

  it('open with each extrude taking only the projections it was made with', () => {
    const { t, withP } = saved()
    const read = parseTimeline(fileMap(t, [['c', 7], ['d', 8]]), new Set(['7', '8']))!
    expect(loopsOf(historyOf(read, '7')).loops).toEqual([square(2)])
    expect(loopsOf(historyOf(read, '8')).loops).toEqual(withP.loops)
    expect(featureOn(read, '7').projected).toBeUndefined()
    expect(featureOn(read, '8').projected).toEqual(['p1'])
  })

  it('drop a projection a hostile file gets wrong, keeping its curves where they were', () => {
    const { t } = saved()
    const files = fileMap(t, [['c', 7], ['d', 8]])
    const j = JSON.parse(new TextDecoder().decode(files.get('Metadata/slicerx_history.json')!)) as { items: Record<string, unknown>[] }
    const sk = j.items.find((i) => i['kind'] === 'sketch')!
    const good = (sk['projections'] as Record<string, unknown>[])[0]!
    const src = good['source'] as Record<string, unknown>
    const edge = { a: [0, 0, 5], b: [1, 0, 5], face: [0, 0, 1] }
    const bad = [
      { id: 'p2', mode: 'sideways', source: src },
      { id: 'p3', mode: 'real', source: { ...src, part: -1 } },
      { id: 'p4', mode: 'real', source: { ...src, transform: [1, 0, 0] } },
      { id: 'p5', mode: 'real', source: { kind: 'edges', body: '7', part: 0, transform: I, edges: Array.from({ length: 300 }, () => edge) } },
      { id: 'p6', mode: 'real', source: src, lost: 'x'.repeat(5000) },
    ]
    sk['projections'] = [good, ...bad]
    sk['loops'] = [...(sk['loops'] as unknown[]), ...bad.map((p) => ({ ...square(1), projected: p.id }))]
    files.set('Metadata/slicerx_history.json', new TextEncoder().encode(JSON.stringify(j)))
    const read = parseTimeline(files, new Set(['7', '8']))!
    const rk = read.items.find((i) => i.kind === 'sketch') as SketchItem
    expect(rk.projections!.map((p) => p.id)).toEqual(['p1', 'p6'])
    expect(rk.projections![1]!.lost).toHaveLength(300)
    expect(rk.loops).toHaveLength(2 + bad.length)
    // their ids stay taken
    expect(nextProjectionId(rk)).toBe('p7')
  })
})

describe('projection counts in a hostile file', () => {
  it('stay small whole numbers whatever the file says', () => {
    const k: SketchItem = { kind: 'sketch', id: 'k1', name: 'Sketch 1', frame: BED, loops: [square(4)] }
    const t0 = withHistory({ bodies: [], items: [k], marker: 1 }, 'c', { version: 1, base: [], steps: [{ id: 's1', part: 0, transform: I, params: extrudeOf([square(4)]), sketch: 'k1' }] })
    for (const bad of [1e308, -3, 2.5, 'p9', 'NaN', 2e6, null, { n: 3 }]) {
      const files = fileMap(t0, [['c', 7]])
      const j = JSON.parse(new TextDecoder().decode(files.get('Metadata/slicerx_history.json')!)) as { items: Record<string, unknown>[] }
      for (const it of j.items) {
        if (it['kind'] === 'sketch') {
          it['nextProjection'] = bad
          it['loops'] = [...(it['loops'] as unknown[]), { ...square(1), projected: 'p99999999999' }, { ...square(1), projected: 'pNaN' }]
        } else it['projected'] = ['p99999999999', ...Array.from({ length: 300 }, (_, i) => `p${i + 1}`)]
      }
      files.set('Metadata/slicerx_history.json', new TextEncoder().encode(JSON.stringify(j)))
      const read = parseTimeline(files, new Set(['7']))!
      const rk = read.items.find((i) => i.kind === 'sketch') as SketchItem
      const n = rk.nextProjection ?? 0
      expect(Number.isInteger(n) && n >= 0 && n <= 1_000_000, String(bad)).toBe(true)
      // the first 256 ids a feature names count (p255 the highest of them), and nothing past the cap does
      expect(n, String(bad)).toBe(255)
      expect(nextProjectionId(rk), String(bad)).toBe('p256')
    }
  })

  // a sketch whose saved count and projected loops say `count` and `ids`, read back from a file
  const readBack = (count: unknown, ids: string[]): SketchItem => {
    const k: SketchItem = { kind: 'sketch', id: 'k1', name: 'Sketch 1', frame: BED, loops: [square(4)] }
    const t0 = withHistory({ bodies: [], items: [k], marker: 1 }, 'c', { version: 1, base: [], steps: [{ id: 's1', part: 0, transform: I, params: extrudeOf([square(4)]), sketch: 'k1' }] })
    const files = fileMap(t0, [['c', 7]])
    const j = JSON.parse(new TextDecoder().decode(files.get('Metadata/slicerx_history.json')!)) as { items: Record<string, unknown>[] }
    const sk = j.items.find((i) => i['kind'] === 'sketch')!
    sk['nextProjection'] = count
    sk['loops'] = [...(sk['loops'] as unknown[]), ...ids.map((id) => ({ ...square(1), projected: id }))]
    files.set('Metadata/slicerx_history.json', new TextEncoder().encode(JSON.stringify(j)))
    return parseTimeline(files, new Set(['7']))!.items.find((i) => i.kind === 'sketch') as SketchItem
  }

  it('count ids up to the cap, never past it, and refuse a projection once every id is used', () => {
    expect(MAX_PROJECTION).toBe(1_000_000)
    // ids at or past the cap, p0 and eight digits count for nothing; leading zeros count as the number
    for (const [ids, next] of [
      [['p999998'], 'p999999'],
      [['p1000000'], 'p1'],
      [['p1000001'], 'p1'],
      [['p0'], 'p1'],
      [['p01'], 'p2'],
      [['p0000007'], 'p8'],
      [['p00000001'], 'p1'],
    ] as [string[], string][]) {
      const rk = readBack(undefined, ids)
      const id = nextProjectionId(rk)
      expect(id, ids.join()).toBe(next)
      expect([...(rk.projections ?? []).map((p) => p.id), ...rk.loops.map((l) => l.projected)], ids.join()).not.toContain(id)
    }
    // a saved count at the cap is not read; one under it is
    expect(readBack(MAX_PROJECTION, []).nextProjection).toBeUndefined()
    expect(readBack(MAX_PROJECTION - 1, []).nextProjection).toBe(MAX_PROJECTION - 1)
    // the last id is handed out once, then the sketch refuses
    let k = readBack(MAX_PROJECTION - 2, ['p1000000', 'p1000001'])
    expect(nextProjectionId(k)).toBe('p999999')
    k = withProjection(k, { id: 'p999999', source: { kind: 'silhouette', body: '7' }, mode: 'real' }, [square(2)])
    expect(k.nextProjection).toBe(MAX_PROJECTION - 1)
    expect(() => nextProjectionId(k)).toThrow(TOO_MANY_PROJECTIONS)
    expect(() => nextProjectionId(readBack(MAX_PROJECTION - 1, ['p1000001']))).toThrow(TOO_MANY_PROJECTIONS)
  })
})

describe('the engine request for a projection', () => {
  // picked with the body turned a quarter about z and moved 10 mm along x; it stands 5 mm along y now
  const A = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1]
  const B = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 5, 0, 1]
  const mesh = boxMesh(10, 10, 5) as HistoryMesh

  it('takes a face back into the part’s own frame, its normal made unit, with its key, at where the body stands now', () => {
    const r = projectRequest({ kind: 'face', body: 'b', part: 0, transform: A, face: { at: [8, 1, 5], normal: [0, 2, 0], key: 42 } }, [mesh, mesh], B, BED) as { parts: { transform: number[] }[]; frame: FaceFrame; source: { kind: string; part: number; face: { at: number[]; normal: number[]; key: number } } }
    expect(r.parts.map((p) => p.transform)).toEqual([B, B])
    expect(r.frame).toEqual(BED)
    expect(r.source.kind).toBe('face')
    expect(r.source.part).toBe(0)
    expect(round(r.source.face.at)).toEqual([1, 2, 5])
    expect(round(r.source.face.normal)).toEqual([1, 0, 0])
    expect(r.source.face.key).toBe(42)
  })

  it('takes edges back the same way, with their centers and keys', () => {
    const r = projectRequest({ kind: 'edges', body: 'b', part: 1, transform: A, edges: [{ a: [10, 0, 5], b: [10, 3, 5], face: [0, 0, 3], center: [9, 1, 5], keys: [7, 9] }] }, [mesh, mesh], B, undefined) as { frame: FaceFrame; source: { part: number; edges: { a: number[]; b: number[]; face: number[]; center: number[]; keys: number[] }[] } }
    expect(r.frame).toEqual(BED)
    expect(r.source.part).toBe(1)
    const e = r.source.edges[0]!
    expect([round(e.a), round(e.b), round(e.face), round(e.center)]).toEqual([[0, 0, 5], [3, 0, 5], [0, 0, 1], [1, 1, 5]])
    expect(e.keys).toEqual([7, 9])
    // a body outline needs no source points
    expect(projectRequest({ kind: 'silhouette', body: 'b' }, [mesh], B, BED)['source']).toEqual({ kind: 'silhouette' })
  })
})

describe('projecting from the panel', () => {
  it('reads a finished sketch’s source where the sketch is in the timeline, as the MCP and replay do', async () => {
    set({ plate: [body('b', 10)] })
    const host = appDesignHost(loader)
    const s = finishSketch({ frame: BED, loops: [] })
    // after the sketch, the block gets a 20 mm part
    const b = host.get('b')!
    await host.add(b, 1, extrudeOf([square(20)]))
    expect(widest(get().plate.find((e) => e.id === 'b')!.parts[1]!)).toBe(20)
    expect(await projectNow(faceOf('b'), BED, s.id)).toEqual([square(10)])
    // a new sketch reads the model as it stands
    expect(await projectNow(faceOf('b'), BED)).toEqual([square(20)])
    // the MCP path and replay give the panel's curves
    const r = await host.project!(s.id, faceOf('b'), 'real')
    expect(projectedOf(r.sketch.loops, 'p1')).toEqual([{ ...square(10), projected: 'p1' }])
    await followBodies(loader, ['b'])
    expect(projectedOf(sketchById(get().timeline, s.id)!.loops, 'p1')).toEqual([{ ...square(10), projected: 'p1' }])
  })

  it('starts a new edges projection for an edge of another body or part', () => {
    const open = { kind: 'edges', body: 'b', part: 0, transform: I, edges: [] } as ProjectSource
    expect(addsTo(open, { ...open })).toBe(true)
    expect(addsTo(open, { ...open, body: 'c' } as ProjectSource)).toBe(false)
    expect(addsTo(open, { ...open, part: 1 } as ProjectSource)).toBe(false)
    expect(addsTo(undefined, open)).toBe(false)
  })
})

describe('following, with other edits about', () => {
  it('keeps an edit made while a follow ran', async () => {
    set({ plate: [body('b', 10)] })
    const host = appDesignHost(loader)
    const s = finishSketch({ frame: BED, loops: [square(3)] })
    await host.project!(s.id, faceOf('b'), 'real')
    let release!: () => void
    hold = new Promise((r) => (release = r))
    set((st) => ({ plate: st.plate.map((e) => (e.id === 'b' ? { ...e, parts: [boxMesh(16, 16, 5)] } : e)) }))
    const following = followBodies(loader, ['b'])
    // the sketch's own square changes while the engine works
    const k = sketchById(get().timeline, s.id)!
    await updateSketch(loader, s.id, { ...bodyOf(k), loops: [square(5), ...projectedOf(k.loops, 'p1')] })
    hold = null
    release()
    await following
    const now = sketchById(get().timeline, s.id)!
    expect(now.loops[0]).toEqual(square(5))
    expect(projectedOf(now.loops, 'p1')).toEqual([{ ...square(16), projected: 'p1' }])
  })

  const midFollow = async (edit: (sketch: string) => Promise<void>) => {
    set({ plate: [body('b', 10)] })
    const host = appDesignHost(loader)
    const s = finishSketch({ frame: BED, loops: [square(3)] })
    await host.project!(s.id, faceOf('b'), 'real')
    let release!: () => void
    hold = new Promise((r) => (release = r))
    set((st) => ({ plate: st.plate.map((e) => (e.id === 'b' ? { ...e, parts: [boxMesh(16, 16, 5)] } : e)) }))
    const following = followBodies(loader, ['b'])
    await edit(s.id)
    hold = null
    release()
    await following
    return { host, k: () => sketchById(get().timeline, s.id)! }
  }

  it('keeps a projection removed while a follow ran removed', async () => {
    const { k } = await midFollow(async (id) => void (await changeProjection(loader, id, 'p1', { remove: true })))
    expect(k().projections).toBeUndefined()
    expect(projectedOf(k().loops, 'p1')).toEqual([])
    expect(nextProjectionId(k())).toBe('p2')
  })

  it('keeps a switch to reference made while a follow ran, with the followed curves', async () => {
    const { k } = await midFollow(async (id) => void (await changeProjection(loader, id, 'p1', { mode: 'reference' })))
    expect(k().projections![0]!.mode).toBe('reference')
    expect(projectedOf(k().loops, 'p1')).toEqual([{ ...square(16), projected: 'p1', construction: true }])
  })

  it('keeps a source changed while a follow ran, and leaves the follow’s curves out', async () => {
    const other: ProjectSource = { kind: 'silhouette', body: 'b' }
    const { k } = await midFollow(async (id) => {
      const now = sketchById(get().timeline, id)!
      await updateSketch(loader, id, bodyOf(withProjection(now, { ...now.projections![0]!, source: other }, [square(7)])))
    })
    expect(k().projections![0]!.source).toEqual(other)
    expect(projectedOf(k().loops, 'p1')).toEqual([{ ...square(7), projected: 'p1' }])
  })

  it('clears a note once a later follow goes through', async () => {
    set({ plate: [body('b', 10)] })
    const host = appDesignHost(loader)
    const s = finishSketch({ frame: BED, loops: [square(3)] })
    await host.project!(s.id, faceOf('b'), 'real')
    const k = sketchById(get().timeline, s.id)!
    set((st) => ({ timeline: { ...st.timeline, items: st.timeline.items.map((i) => (i === k ? withProjection(k, { ...k.projections![0]!, lost: 'Not followed: Lid would have no solid left with this sketch.' }, null) : i)) } }))
    set((st) => ({ plate: st.plate.map((e) => (e.id === 'b' ? { ...e, parts: [boxMesh(12, 12, 5)] } : e)) }))
    await followBodies(loader, ['b'])
    const after = sketchById(get().timeline, s.id)!
    expect(after.projections![0]).not.toHaveProperty('lost')
    expect(projectedOf(after.loops, 'p1')).toEqual([{ ...square(12), projected: 'p1' }])
  })

  it('says so on the projection when the body drawn on it cannot follow', async () => {
    set({ plate: [body('b', 10)] })
    const host = appDesignHost(loader)
    const s = finishSketch({ frame: BED, loops: [] })
    const r = await host.project!(s.id, faceOf('b'), 'real')
    const d = await host.create('Lid', [])
    await host.add(d, 0, extrudeOf(r.sketch.loops), undefined, { sketch: s.id })
    // the projection turns reference behind the follow's back: the lid's only profile would go
    const k = sketchById(get().timeline, s.id)!
    set((st) => ({ timeline: { ...st.timeline, items: st.timeline.items.map((i) => (i === k ? withProjection(k, { ...k.projections![0]!, mode: 'reference' }, null) : i)) } }))
    set((st) => ({ plate: st.plate.map((e) => (e.id === 'b' ? { ...e, parts: [boxMesh(16, 16, 5)] } : e)) }))
    await followBodies(loader, ['b'])
    const after = sketchById(get().timeline, s.id)!
    expect(after.projections![0]!.lost).toMatch(/Lid would have no solid left/)
    // the curves stay as they were, and the lid with them
    expect(projectedOf(after.loops, 'p1')[0]).toMatchObject(square(10))
    expect(widest(get().plate.find((e) => e.id === d.id)!.parts[0]!)).toBe(10)
  })

  it('carries a change down a chain of sketches', async () => {
    set({ plate: [body('b', 10)] })
    const host = appDesignHost(loader)
    const s1 = finishSketch({ frame: BED, loops: [] })
    const r1 = await host.project!(s1.id, faceOf('b'), 'real')
    const c = await host.create('Mid', [])
    await host.add(c, 0, extrudeOf(r1.sketch.loops), undefined, { sketch: s1.id })
    const s2 = finishSketch({ frame: BED, loops: [] })
    const r2 = await host.project!(s2.id, faceOf(c.id), 'real')
    const d = await host.create('Top', [])
    await host.add(d, 0, extrudeOf(r2.sketch.loops), undefined, { sketch: s2.id })
    const w = (id: string) => widest(get().plate.find((e) => e.id === id)!.parts[0]!)
    expect([w(c.id), w(d.id)]).toEqual([10, 10])
    set((st) => ({ plate: st.plate.map((e) => (e.id === 'b' ? { ...e, parts: [boxMesh(16, 16, 5)] } : e)) }))
    await followBodies(loader, ['b'])
    expect([w(c.id), w(d.id)]).toEqual([16, 16])
  })
})

describe('changing a projection a body is drawn on', () => {
  it('rebuilds that body, and refuses a change that leaves it nothing', async () => {
    set({ plate: [body('b', 10)] })
    const host = appDesignHost(loader)
    const s = finishSketch({ frame: BED, loops: [square(4)] })
    const r = await host.project!(s.id, faceOf('b'), 'real')
    const d = await host.create('Tab', [])
    await host.add(d, 0, extrudeOf(r.sketch.loops), undefined, { sketch: s.id })
    const tab = () => widest(get().plate.find((e) => e.id === d.id)!.parts[0]!)
    expect(tab()).toBe(10)
    // the tab took p1, so switching it to reference changes the tab, like any edit of its sketch
    const off = await host.changeProjection!(s.id, 'p1', { mode: 'reference' })
    expect(off.replayed).toBe(1)
    expect(tab()).toBe(4)
    await host.changeProjection!(s.id, 'p1', { mode: 'real' })
    expect(tab()).toBe(10)
    // with no square of its own, reference would leave a second body with nothing
    const s2 = finishSketch({ frame: BED, loops: [] })
    const r2 = await host.project!(s2.id, faceOf('b'), 'real')
    const e = await host.create('Lid', [])
    await host.add(e, 0, extrudeOf(r2.sketch.loops), undefined, { sketch: s2.id })
    const before = sketchById(get().timeline, s2.id)
    await expect(host.changeProjection!(s2.id, 'p1', { mode: 'reference' })).rejects.toThrow(/Lid would have no solid left/)
    expect(sketchById(get().timeline, s2.id)).toEqual(before)
  })

  it('runs through the MCP tools: project real, then extrude the sketch', async () => {
    set({ plate: [body('b', 10)] })
    const host = appDesignHost(loader)
    const tools = designToolset(host)
    const run = (name: string, input: Record<string, unknown>) => tools.find((t) => t.name === name)!.run(input as never, {} as never)
    const s = finishSketch({ frame: BED, loops: [] })
    await run('design.sketch_project', { sketch: s.id, design: 'b', kind: 'silhouette' })
    const d = await host.create('Lid', [])
    await run('geom.extrude', { design: d.id, sketch: s.id, distance_mm: 3, operation: 'new' })
    expect(widest(get().plate.find((e) => e.id === d.id)!.parts[0]!)).toBe(10)
    expect(featureOn(get().timeline, d.id).projected).toEqual(['p1'])
    // what it cannot do, in words
    await expect(run('design.sketch_project', { sketch: 'nope', design: 'b', kind: 'silhouette' })).rejects.toThrow(/No finished sketch nope/)
    await expect(run('design.sketch_project', { sketch: s.id, design: 'nope', kind: 'silhouette' })).rejects.toThrow(/nope/)
    await expect(run('design.sketch_project', { sketch: s.id, design: 'b', kind: 'face', face: { triangle: 100000 } })).rejects.toThrow()
    // the schema caps the edges of one projection
    const schema = tools.find((t) => t.name === 'design.sketch_project')!.input as unknown as { safeParse(v: unknown): { success: boolean } }
    const edges = (n: number) => Array.from({ length: n }, () => ({ a: [0, 0, 5], b: [1, 0, 5], face: [0, 0, 1] }))
    expect(schema.safeParse({ sketch: s.id, design: 'b', kind: 'edges', edges: edges(256) }).success).toBe(true)
    expect(schema.safeParse({ sketch: s.id, design: 'b', kind: 'edges', edges: edges(257) }).success).toBe(false)
    expect(stepWords({ tool: 'design.sketch_project' } as never)).toMatchObject({ doing: 'Projecting into the sketch', done: 'Projected into the sketch' })
  })
})

describe('a body replayed onto its sketch', () => {
  const k: SketchItem = { kind: 'sketch', id: 'k1', name: 'Sketch 1', frame: BED, loops: [square(2)] }
  const setup = () => {
    const t0 = withHistory({ bodies: [], items: [k], marker: 1 }, 'c', { version: 1, base: [], steps: [{ id: 's1', part: 0, transform: I, params: extrudeOf([square(2)]), sketch: 'k1' }] })
    const withP = withProjection(t0.items[0] as SketchItem, { id: 'p1', source: faceOf('b'), mode: 'real' }, [square(10)])
    return { t1: { ...t0, items: t0.items.map((i) => (i.kind === 'sketch' ? withP : i)) } as Timeline, withP }
  }

  it('keeps the projections a step made before them never had', () => {
    const { t1, withP } = setup()
    const t2 = withHistory(t1, 'c', historyOf(t1, 'c')!)
    const k2 = t2.items.find((i) => i.kind === 'sketch') as SketchItem
    expect(k2.loops).toEqual(withP.loops)
    expect(k2.projections).toEqual(withP.projections)
    expect(featureOn(t2, 'c').projected).toBeUndefined()
    // its own square, changed in the step, changes in the sketch; p1 stays
    const h = historyOf(t1, 'c')!
    const moved = { ...h, steps: [{ ...h.steps[0]!, params: extrudeOf([square(3)]) }] }
    const k3 = withHistory(t1, 'c', moved).items.find((i) => i.kind === 'sketch') as SketchItem
    expect(k3.loops).toEqual([square(3), ...projectedOf(withP.loops, 'p1')])
  })

  it('takes a step’s own copy of a projection it was made with', () => {
    const { t1, withP } = setup()
    const t2 = withHistory(t1, 'd', { version: 1, base: [], steps: [{ id: 's2', part: 0, transform: I, params: extrudeOf(withP.loops), sketch: 'k1' }] })
    const h = historyOf(t2, 'd')!
    const stale = [square(2), { ...square(7), projected: 'p1' }]
    const t3 = withHistory(t2, 'd', { ...h, steps: [{ ...h.steps[0]!, params: extrudeOf(stale) }] })
    expect((t3.items.find((i) => i.kind === 'sketch') as SketchItem).loops).toEqual(stale)
  })

  it('makes a sketch of its own from a step with no sketch, its curves plain', () => {
    const t = withHistory({ bodies: [], items: [], marker: 0 }, 'c', { version: 1, base: [], steps: [{ id: 's1', part: 0, transform: I, params: extrudeOf([square(2), { ...square(9), projected: 'p4' }]) }] })
    const nk = t.items.find((i) => i.kind === 'sketch') as SketchItem
    expect(nk.loops).toEqual([square(2), square(9)])
    expect(featureOn(t, 'c').projected).toBeUndefined()
  })
})

describe('a solid from a new sketch with a projection', () => {
  // the panel's Extrude or Revolve of a sketch that is not in the timeline yet: its own square and a projected face
  const drawn = () => ({ frame: BED, loops: [square(4), { ...square(10), projected: 'p1' }], projections: [{ id: 'p1', source: faceOf('b'), mode: 'real' as const }], nextProjection: 1 })
  const input = (loops: SketchLoop[], over: Partial<ExtrudeInput['spec']> = {}, onto?: string): ExtrudeInput => ({ frame: BED, shape: { type: 'sketch', loops }, placement: {}, spec: { distanceMm: 3, operation: 'new', ...over }, name: 'Sketch body', ...(onto ? { target: { objectId: onto, partIndex: 0 } } : {}) })
  const kinds = () => get().timeline.items.map((i) => i.kind)
  const undo = history()

  it('leaves no sketch behind when the engine refuses, and the retry makes one sketch the solid names', async () => {
    set({ plate: [body('b', 10)] })
    undo.clear()
    const s = drawn()
    nextExtrude = { refuse: 'shape.extrude: the extrusion does not make one body' }
    await expect(solidOnNewSketch(s, (step, sketch) => applyExtrude(loader, input(s.loops), { step, sketch }))).rejects.toThrow(/one body/)
    expect(get().timeline).toEqual({ bodies: [], items: [], marker: 0 })
    expect(get().plate.map((e) => e.id)).toEqual(['b'])
    expect(undo.state().undo).toBe(0)
    await solidOnNewSketch(s, (step, sketch) => applyExtrude(loader, input(s.loops), { step, sketch }))
    const t = get().timeline
    expect(kinds()).toEqual(['sketch', 'feature'])
    const k = t.items[0] as SketchItem
    expect(k).toMatchObject({ name: 'Sketch 1', projections: [{ id: 'p1', mode: 'real' }] })
    expect(t.items[1]).toMatchObject({ sketch: k.id, projected: ['p1'] })
    // one undo takes the solid and its sketch together, as a plain extrude and its sketch go
    expect(undo.state().undo).toBe(1)
    expect(t.marker).toBe(2)
    undo.undo()
    expect(get().timeline.items).toEqual([])
    expect(get().plate.map((e) => e.id)).toEqual(['b'])
    // the step is closed: the next edits are steps of their own
    set((st) => ({ plate: [...st.plate, body('x', 4)] }))
    set((st) => ({ plate: [...st.plate, body('y', 4)] }))
    expect(undo.state().undo).toBe(2)
  })

  it('leaves no sketch when a revolve is refused or a join misses the body, and the body as it was', async () => {
    const b = body('b', 10)
    set({ plate: [b] })
    undo.clear()
    const s = drawn()
    // the stand-in engine has no revolve, so it refuses as a revolve whose axis crosses the profile does
    const axis = { point: [2, 0] as [number, number], direction: [0, 1] as [number, number] }
    await expect(solidOnNewSketch(s, (step, sketch) => applyRevolve(loader, { frame: BED, loops: s.loops, axis, angleDeg: 360, operation: 'new', name: 'Revolved body' }, { step, sketch }))).rejects.toThrow(/sketch.revolve/)
    expect(kinds()).toEqual([])
    nextExtrude = 'miss'
    const r = await solidOnNewSketch(s, (step, sketch) => applyExtrude(loader, input(s.loops, { operation: 'join' }, 'b'), { step, sketch }))
    expect(r.warn).toBe(true)
    expect(get().timeline).toEqual({ bodies: [], items: [], marker: 0 })
    expect(get().plate).toEqual([b])
    expect(undo.state().undo).toBe(0)
    set((st) => ({ plate: [...st.plate, body('x', 4)] }))
    expect(undo.state().undo).toBe(1)
  })

  it('puts the sketch in at the marker beside a finished one, named next, when the timeline is rolled back', async () => {
    set({ plate: [body('b', 10)] })
    const before = finishSketch({ frame: BED, loops: [square(2)] })
    const after = finishSketch({ frame: BED, loops: [square(3)] })
    set((st) => ({ timeline: { ...st.timeline, marker: 1 } }))
    undo.clear()
    const s = drawn()
    nextExtrude = { refuse: 'shape.extrude: the extrusion does not make one body' }
    await expect(solidOnNewSketch(s, (step, sketch) => applyExtrude(loader, input(s.loops), { step, sketch }))).rejects.toThrow(/one body/)
    expect(get().timeline.items.map((i) => i.id)).toEqual([before.id, after.id])
    expect(get().timeline.marker).toBe(1)
    await solidOnNewSketch(s, (step, sketch) => applyExtrude(loader, input(s.loops), { step, sketch }))
    const t = get().timeline
    expect(t.items.slice(0, 3).map((i) => [i.kind, i.kind === 'sketch' ? i.name : null])).toEqual([['sketch', 'Sketch 1'], ['sketch', 'Sketch 3'], ['feature', null]])
    expect(t.items.at(-1)!.id).toBe(after.id)
    expect(t.marker).toBe(3)
    expect(undo.state().undo).toBe(1)
    undo.undo()
    expect(get().timeline.items.map((i) => i.id)).toEqual([before.id, after.id])
    expect(get().timeline.marker).toBe(1)
  })

  /** Holds every shape.extrude until the returned release runs. */
  const holding = () => {
    let release!: () => void
    holdExtrude = new Promise<void>((done) => (release = done))
    return () => {
      holdExtrude = null
      release()
    }
  }
  const extrudeOf = (s: ReturnType<typeof drawn>, over: Partial<ExtrudeInput['spec']> = {}, onto?: string) => (step?: UndoStep, sketch?: string) => applyExtrude(loader, input(s.loops, over, onto), { step, sketch })
  const ids = () => get().plate.map((e) => e.id)
  const tick = () => new Promise<void>((done) => setTimeout(done, 0))
  const sketches = () => get().timeline.items.filter((i): i is SketchItem => i.kind === 'sketch')
  const features = () => get().timeline.items.filter((i): i is FeatureItem => i.kind === 'feature')
  /** The sketch drawn in the panel, the one with a projection. */
  const lead = () => sketches().find((k) => k.projections?.length)!
  /** Every sketch in the timeline has a feature drawn on it. */
  const noOrphans = () => {
    for (const k of sketches()) expect(features().some((f) => f.sketch === k.id)).toBe(true)
  }
  const now = () => ({ plate: get().plate, timeline: get().timeline })
  /** The solid and its sketch are one undo step: undo takes both back to `before`, and redo brings both again. */
  const undoesAsOne = (before: ReturnType<typeof now>) => {
    const after = now()
    expect(undo.state().undo).toBe(1)
    undo.undo()
    expect(now()).toEqual(before)
    undo.redo()
    expect(now()).toEqual(after)
    expect(undo.state()).toMatchObject({ undo: 1, redo: 0 })
  }

  it('keeps an edit made while the engine works as its own undo step', async () => {
    set({ plate: [body('b', 10)] })
    undo.clear()
    const s = drawn()
    const release = holding()
    const solid = solidOnNewSketch(s, extrudeOf(s))
    await tick()
    set((st) => ({ plate: [...st.plate, body('c', 4)] }))
    release()
    await solid
    expect(kinds()).toEqual(['sketch', 'feature'])
    expect(undo.state().undo).toBe(2)
    // the solid and its sketch go first, in one step; the other edit stays until its own undo
    undo.undo()
    expect(kinds()).toEqual([])
    expect(ids()).toEqual(['b', 'c'])
    undo.undo()
    expect(ids()).toEqual(['b'])
  })

  it('leaves no sketch and adds no step when the engine refuses after another edit, and that edit keeps its own step', async () => {
    set({ plate: [body('b', 10)] })
    undo.clear()
    const s = drawn()
    const release = holding()
    nextExtrude = { refuse: 'shape.extrude: the extrusion does not make one body' }
    const solid = solidOnNewSketch(s, extrudeOf(s))
    await tick()
    set((st) => ({ plate: [...st.plate, body('c', 4)] }))
    release()
    await expect(solid).rejects.toThrow(/one body/)
    expect(get().timeline.items.filter((i) => i.kind === 'sketch')).toEqual([])
    expect(get().timeline.marker).toBe(get().timeline.items.length)
    expect(ids()).toEqual(['b', 'c'])
    expect(undo.state().undo).toBe(1)
    // neither undo nor redo brings a stray sketch back
    undo.undo()
    expect(ids()).toEqual(['b'])
    expect(kinds()).toEqual([])
    undo.redo()
    expect(ids()).toEqual(['b', 'c'])
    expect(get().timeline.items.filter((i) => i.kind === 'sketch')).toEqual([])
    // and the next edit is a step of its own
    set((st) => ({ plate: [...st.plate, body('d', 4)] }))
    expect(undo.state().undo).toBe(2)
  })

  it('keeps one step each for two solids made at once, each naming its own sketch, and later edits make their own', async () => {
    set({ plate: [body('b', 10)] })
    undo.clear()
    // two drawings whose solids differ in width, so each solid tells which sketch it came from
    const s1 = drawn()
    const s2 = { ...drawn(), loops: [square(4), { ...square(12), projected: 'p1' }] }
    const release = holding()
    const first = solidOnNewSketch(s1, extrudeOf(s1))
    const second = solidOnNewSketch(s2, extrudeOf(s2))
    await tick()
    release()
    await Promise.all([first, second])
    expect(sketches()).toHaveLength(2)
    expect(features()).toHaveLength(2)
    for (const f of features()) {
      const k = sketchById(get().timeline, f.sketch!)!
      expect(k.projections).toHaveLength(1)
      expect(widest(get().plate.find((e) => e.id === f.body)!.parts[0]!)).toBe(reach(k.loops))
    }
    expect(new Set(features().map((f) => f.sketch)).size).toBe(2)
    noOrphans()
    const n = undo.state().undo
    expect(n).toBe(2)
    set((st) => ({ plate: [...st.plate, body('x', 4)] }))
    expect(undo.state().undo).toBe(n + 1)
    set((st) => ({ plate: [...st.plate, body('y', 4)] }))
    expect(undo.state().undo).toBe(n + 2)
    undo.undo()
    expect(ids()).not.toContain('y')
    expect(ids()).toContain('x')
  })

  it('makes one sketch and one solid from a second Enter while the first still works', async () => {
    set({ plate: [body('b', 10)] })
    undo.clear()
    const s = drawn()
    const gate = oneAtATime()
    const release = holding()
    const first = gate(() => solidOnNewSketch(s, extrudeOf(s)))
    const second = gate(() => solidOnNewSketch(s, extrudeOf(s)))
    await tick()
    release()
    await expect(second).resolves.toBeUndefined()
    await first
    expect(kinds()).toEqual(['sketch', 'feature'])
    expect(get().plate).toHaveLength(2)
    expect(calls.filter((c) => c === 'shape.extrude')).toHaveLength(1)
    expect(undo.state().undo).toBe(1)
    // once it is done, the next press runs
    await gate(() => solidOnNewSketch(s, extrudeOf(s)))
    expect(get().plate).toHaveLength(3)
  })

  it('drops Finish sketch pressed while Extrude still works, as the panel runs both through one guard', async () => {
    set({ plate: [body('b', 10)] })
    undo.clear()
    const s = drawn()
    const press = oneAtATime()
    const release = holding()
    const extrude = press(() => solidOnNewSketch(s, extrudeOf(s)))
    const finish = press(async () => finishSketch(s))
    await tick()
    release()
    await expect(finish).resolves.toBeUndefined()
    await extrude
    expect(kinds()).toEqual(['sketch', 'feature'])
    noOrphans()
    expect(undo.state().undo).toBe(1)
  })

  it('says why in a toast when a join misses after the editor was left', async () => {
    set({ plate: [body('b', 10)], objectTool: 'sketch', toast: null })
    undo.clear()
    const s = drawn()
    const release = holding()
    nextExtrude = 'miss'
    const solid = solidOnNewSketch(s, extrudeOf(s, { operation: 'join' }, 'b'))
    await tick()
    // the person switches tool while the engine works
    set({ objectTool: null })
    release()
    const r = await solid
    const notes: string[] = []
    afterSolid(r, (text) => notes.push(text))
    expect(notes).toEqual([])
    expect(get().toast).toMatchObject({ text: r.message, tone: 'warn' })
    expect(kinds()).toEqual([])
    expect(undo.state().undo).toBe(0)
  })

  it('keeps the editor open with why when a join misses, the drawing kept and nothing in the timeline or the undo history', async () => {
    set({ plate: [body('b', 10)], objectTool: 'sketch' })
    undo.clear()
    const s = drawn()
    nextExtrude = 'miss'
    const r = await solidOnNewSketch(s, extrudeOf(s, { operation: 'join' }, 'b'))
    expect(r).toMatchObject({ missed: true, warn: true, message: expect.stringMatching(/does not reach the body/) })
    const notes: string[] = []
    afterSolid(r, (text) => notes.push(text))
    expect(notes).toEqual([r.message])
    expect(get().objectTool).toBe('sketch')
    expect(kinds()).toEqual([])
    expect(undo.state().undo).toBe(0)
    // pressed again the right way, the same drawing makes the sketch and the solid as one step
    const done = await solidOnNewSketch(s, extrudeOf(s))
    afterSolid(done, (text) => notes.push(text))
    expect(notes).toHaveLength(1)
    expect(get().objectTool).toBeNull()
    expect(kinds()).toEqual(['sketch', 'feature'])
    expect(get().timeline.items[0]).toMatchObject({ name: 'Sketch 1' })
    expect(undo.state().undo).toBe(1)
    set((st) => ({ plate: [...st.plate, body('x', 4)] }))
    expect(undo.state().undo).toBe(2)
  })
  it('never gives the new sketch to another tool’s solid that lands while the engine works', async () => {
    set({ plate: [body('b', 10)] })
    undo.clear()
    const s = drawn()
    const release = holding()
    const solid = solidOnNewSketch(s, extrudeOf(s))
    await tick()
    // the Shape tool's extrude goes past the held one and lands first
    holdExtrude = null
    await applyExtrude(loader, input([square(3)]))
    release()
    await solid
    const users = features().filter((f) => f.sketch === lead().id)
    expect(users).toHaveLength(1)
    expect(widest(get().plate.find((e) => e.id === users[0]!.body)!.parts[0]!)).toBe(10)
    const other = get().plate.find((e) => widest(e.parts[0]!) === 3)!
    expect(other.history!.steps[0]!.sketch).not.toBe(lead().id)
    noOrphans()
    expect(undo.state().undo).toBe(2)
  })

  it.each([
    ['join', 50, 'Joined 0.05 cm³ to Block.'],
    ['cut', -50, 'Cut 0.05 cm³ out of Block.'],
  ] as const)('lands a %s into the body with its sketch as one undo step', async (operation, hit, said) => {
    set({ plate: [body('b', 10)] })
    undo.clear()
    const before = now()
    const s = drawn()
    nextExtrude = { hit }
    const r = await solidOnNewSketch(s, extrudeOf(s, { operation }, 'b'))
    expect(r).toEqual({ message: said, warn: false })
    expect(features().map((f) => [f.body, f.sketch])).toEqual([['b', lead().id]])
    expect(get().plate.map((e) => [e.id, widest(e.parts[0]!)])).toEqual([['b', 12]])
    noOrphans()
    undoesAsOne(before)
  })

  it('lands a revolve with its sketch as one undo step', async () => {
    set({ plate: [body('b', 10)] })
    undo.clear()
    const before = now()
    const s = drawn()
    revolves = true
    const axis = { point: [0, 0] as [number, number], direction: [0, 1] as [number, number] }
    const r = await solidOnNewSketch(s, (step, sketch) => applyRevolve(loader, { frame: BED, loops: s.loops, axis, angleDeg: 360, operation: 'new', name: 'Revolved body' }, { step, sketch }))
    expect(r.message).toMatch(/^Added Revolved body/)
    const made = get().plate.find((e) => e.id !== 'b')!
    expect(made.history!.steps[0]).toMatchObject({ sketch: lead().id, params: { op: 'sketch.revolve' } })
    expect(features().map((f) => [f.body, f.sketch])).toEqual([[made.id, lead().id]])
    noOrphans()
    undoesAsOne(before)
  })

  it('leaves no sketch and adds no step when the body takes an exact history while the solid loads', async () => {
    set({ plate: [body('b', 10)] })
    undo.clear()
    const s = drawn()
    nextExtrude = { hit: 50 }
    let kept: ReturnType<typeof now> | null = null
    // the block takes an exact history while the joined mesh loads, after the step was built from the block as it was
    const turning = {
      loadParts: async (name: string, _parts: MeshPart[]) => {
        quietly(() => set((st) => ({ plate: st.plate.map((e) => (e.id === 'b' ? { ...e, history: { version: 1, exact: true, base: [{ ...boxOf(10, 5), name: 'b', slot: 1 }], steps: [] } } : e)) })))
        kept = now()
        return handle(name)
      },
    }
    const solid = solidOnNewSketch(s, (step, sketch) => applyExtrude(turning, input(s.loops, { operation: 'join' }, 'b'), { step, sketch }))
    await expect(solid).rejects.toThrow(/exact history/)
    expect(sketches()).toEqual([])
    expect(now()).toEqual(kept)
    expect(undo.state().undo).toBe(0)
  })

  describe('on exact solids', () => {
    beforeEach(() => {
      vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'sx.exactSolids' ? '1' : null), setItem: () => {}, removeItem: () => {} })
      set({ settingsMode: 'developer' })
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      set({ settingsMode: 'simple' })
    })
    /** A block whose history is exact: one new-body extrude of a 10 mm square on the bed. */
    const exactBlock = (): PlateEntry => ({ ...body('b', 10), history: { version: 1, exact: true, base: [], steps: [{ id: 's0', part: 0, transform: [...I], params: { op: 'shape.extrude', frame: BED, shape: { type: 'sketch', loops: [square(10)] }, placement: {}, spec: { distanceMm: 5, operation: 'new' } } }] } })

    it('joins into a body with an exact history as one undo step, the projections then read again', async () => {
      set({ plate: [exactBlock()] })
      undo.clear()
      const before = now()
      const s = drawn()
      calls.length = 0
      const r = await solidOnNewSketch(s, extrudeOf(s, { operation: 'join' }, 'b'))
      expect(r.message).toBe('Joined Sketch body to Block.')
      const b = get().plate[0]!
      expect(b.history).toMatchObject({ exact: true })
      expect(b.history!.steps.at(-1)).toMatchObject({ sketch: lead().id, params: { op: 'shape.extrude', spec: { operation: 'join' } } })
      expect(widest(b.parts[0]!)).toBe(JOINED)
      expect(features().filter((f) => f.sketch === lead().id).map((f) => f.body)).toEqual(['b'])
      // the sketch's projection was read again after the join; it reads the block where the sketch sits, before the
      // join drawn on it, so its curves stay as drawn
      expect(calls).toContain('sketch.project')
      expect(projectedOf(lead().loops, 'p1')).toEqual([{ ...square(10), projected: 'p1' }])
      noOrphans()
      undoesAsOne(before)
    })

    it('makes an exact new body with its sketch as one undo step', async () => {
      set({ plate: [body('b', 10)] })
      undo.clear()
      const before = now()
      const s = drawn()
      const r = await solidOnNewSketch(s, extrudeOf(s))
      expect(r.message).toBe('Added Sketch body.')
      const made = get().plate.find((e) => e.id !== 'b')!
      expect(made.history).toMatchObject({ exact: true, steps: [{ sketch: lead().id }] })
      expect(features().map((f) => [f.body, f.sketch])).toEqual([[made.id, lead().id]])
      noOrphans()
      undoesAsOne(before)
    })
  })
})

describe('projections in a sketch made from SVG', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect width="40" height="40"/></svg>'
  const tools = (host = appDesignHost(loader)) => designToolset(host)
  const run = (t: ReturnType<typeof tools>, name: string, input: Record<string, unknown>) => t.find((x) => x.name === name)!.run(input as never, {} as never)

  it('keeps a body whose first step opens for editing while a client’s step lands on it', async () => {
    set({ plate: [], historyEdit: null })
    // while set, loading the result opens the body's first step, as beginEdit does: the body leaves the plate
    let open = false
    const opening = {
      loadParts: async (name: string, parts: MeshPart[]) => {
        if (open) {
          open = false
          const e = get().plate.find((p) => p.name === name)!
          quietly(() => set((st) => ({ historyEdit: { objectId: e.id, index: 0, original: e, hidden: true }, plate: st.plate.filter((p) => p.id !== e.id) })))
        }
        return loader.loadParts(name, parts)
      },
    }
    const host = appDesignHost(opening)
    const t = tools(host)
    const id = ((await run(t, 'design.sketch_svg', { svg })).output as { id: string }).id
    const d = await host.create('Tab', [])
    await run(t, 'geom.extrude', { design: d.id, sketch: id, distance_mm: 3, operation: 'new' })
    open = true
    await run(t, 'geom.extrude', { design: d.id, sketch: id, distance_mm: 5, operation: 'new' })
    expect(get().historyEdit).toBeNull()
    expect(get().plate.find((e) => e.id === d.id)?.history?.steps).toHaveLength(2)
  })

  it('projects into the id design.sketch_svg returns, through the app host', async () => {
    set({ plate: [body('b', 10)] })
    const t = tools()
    const made = await run(t, 'design.sketch_svg', { svg })
    const id = (made.output as { id: string }).id
    const r = await run(t, 'design.sketch_project', { sketch: id, design: 'b', kind: 'silhouette' })
    expect(r.output).toMatchObject({ sketch: id, projection: 'p1', projections: [{ id: 'p1', kind: 'silhouette', mode: 'real', loops: [square(10)] }] })
    expect(sketchById(get().timeline, id)!.loops).toEqual([...ART, { ...square(10), projected: 'p1' }])
  })

  it('keeps the artwork loops as they were and in order, the projected ones last, through project, follow, switch, remove, save and open', async () => {
    set({ plate: [body('b', 10)] })
    const host = appDesignHost(loader)
    const t = tools(host)
    const id = ((await run(t, 'design.sketch_svg', { svg })).output as { id: string }).id
    const k = () => sketchById(get().timeline, id)!
    const own = () => k().loops.filter((l) => l.projected === undefined)
    const tags = () => k().loops.map((l) => l.projected ?? null)
    const kept = () => {
      expect(own()).toEqual(ART)
      expect(k().loops.slice(0, ART.length)).toEqual(ART)
    }
    kept()
    await run(t, 'design.sketch_project', { sketch: id, design: 'b', kind: 'silhouette' })
    await run(t, 'design.sketch_project', { sketch: id, design: 'b', kind: 'face', face: { at: [5, 5, 5], normal: [0, 0, 1] }, mode: 'reference' })
    kept()
    expect(tags()).toEqual([null, null, null, 'p1', 'p2'])
    expect(k().loops.map((l) => l.construction ?? false)).toEqual([false, false, false, false, true])
    // the block grows: both projections follow it, the artwork stays put
    set((st) => ({ plate: st.plate.map((e) => (e.id === 'b' ? { ...e, parts: [boxMesh(16, 16, 5)] } : e)) }))
    await followBodies(loader, ['b'])
    kept()
    expect(projectedOf(k().loops, 'p1')).toEqual([{ ...square(16), projected: 'p1' }])
    expect(tags()).toEqual([null, null, null, 'p1', 'p2'])
    // switched each way, nothing moves
    await run(t, 'design.sketch_project', { sketch: id, projection: 'p1', mode: 'reference' })
    await run(t, 'design.sketch_project', { sketch: id, projection: 'p2', mode: 'real' })
    kept()
    expect(tags()).toEqual([null, null, null, 'p1', 'p2'])
    expect(k().loops.map((l) => l.construction ?? false)).toEqual([false, false, false, true, false])
    await run(t, 'design.sketch_project', { sketch: id, projection: 'p1', remove: true })
    kept()
    expect(tags()).toEqual([null, null, null, 'p2'])
    // a body made from it, then saved and opened: the sketch comes back the same, its projection on the plate's id
    const d = await host.create('Tab', [])
    await run(t, 'geom.extrude', { design: d.id, sketch: id, distance_mm: 3, operation: 'new' })
    kept()
    const read = withBodyIds(parseTimeline(fileMap(get().timeline, [['b', 7], [d.id, 8]]), new Set(['7', '8']))!, (b) => (b === '7' ? 'b' : b === '8' ? d.id : undefined))
    const back = read.items.find((i) => i.kind === 'sketch') as SketchItem
    expect(back.loops).toEqual(k().loops)
    expect(back.loops.slice(0, ART.length)).toEqual(ART)
    expect(back.projections!.map((p) => [p.id, p.source.kind, p.source.body, p.mode])).toEqual([['p2', 'face', 'b', 'real']])
    expect(back.nextProjection).toBe(2)
  })
})
