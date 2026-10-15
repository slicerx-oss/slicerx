// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design timeline in the app (plate/timeline.ts): it follows the objects' histories as tools change them, undo
// brings it back with the plate, an object that leaves takes its features, and a project saves it as version 3 and
// opens it again with the rolled back steps kept.
import { afterEach, describe, expect, it } from 'vitest'
import { historyOf, joinTimelines, syncTimeline, timelineOf, withBodyIds, type FaceFrame, type History, type SketchLoop, type Step, type StepParams, type Timeline } from '@slicerx/cad-history'
import type { MeshHandle } from '@slicerx/contracts'
import { readProject } from '../src/export/import3mf'
import { writeProject } from '../src/export/threemf'
import { createHistory } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { startTimeline } from '../src/plate/timeline'
import { appStore, type PlateEntry } from '../src/state/store'

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]
const T0 = 1_790_000_000_000
const id = (ms: number, seq: number) => `s${(T0 + ms).toString(36)}${seq.toString(36)}`
const step = (sid: string, params: StepParams): Step => ({ id: sid, part: 0, transform: T, params })
const top = (): FaceFrame => ({ origin: [100, 100, 5], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })
const square = (): SketchLoop => ({ start: [0, 0], segments: [{ type: 'line', to: [4, 0] }, { type: 'line', to: [4, 4] }, { type: 'line', to: [0, 4] }, { type: 'line', to: [0, 0] }] })
const pull = (d: number): StepParams => ({ op: 'face.push', at: [100, 100, 5], normal: [0, 0, 1], distanceMm: d })
const sketched = (): StepParams => ({ op: 'shape.extrude', frame: top(), shape: { type: 'sketch', loops: [square()] }, placement: {}, spec: { distanceMm: 3, operation: 'join' } })

const handle = (h: string): MeshHandle => ({ id: h, hash: h, name: h, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const entry = (oid: string, history: History): PlateEntry => ({ id: oid, name: oid, handle: handle(oid), parts: [boxMesh(10, 10, 5)], colors: ['#bd93f9'], transform: T, history })
const box = (): History => ({ version: 1, base: [boxMesh(40, 20, 5)], steps: [step(id(0, 1), pull(5)), step(id(2000, 3), sketched())] })
const peg = (): History => ({ version: 1, base: [boxMesh(5, 5, 5)], steps: [step(id(1000, 2), pull(2))] })
const bare = (h: History | null) => h?.steps.map(({ sketch: _s, ...st }) => st)
const ids = (t: Timeline) => t.items.map((i) => (i.kind === 'sketch' ? `${i.name}` : `${i.body}:${i.id}`))

let stop: (() => void) | null = null
afterEach(() => {
  stop?.()
  stop = null
  appStore.setState({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', timeline: { bodies: [], items: [], marker: 0 }, rollback: null })
})

describe('design timeline in the app', () => {
  it('keeps a reordered history through timeline read-back, save, reopen and Undo', async () => {
    const undo = createHistory(appStore)
    stop = startTimeline()
    try {
      appStore.setState({ plate: [entry('a', box()), entry('b', peg())] })
      const before = appStore.getState().timeline
      const h = box()
      const steps = [...h.steps].reverse()
      appStore.setState((s) => ({ plate: s.plate.map((e) => e.id === 'a' ? { ...e, history: { ...h, steps } } : e) }))
      const t = appStore.getState().timeline
      expect(bare(historyOf(t, 'a'))).toEqual(steps)
      expect(bare(historyOf(t, 'b'))).toEqual(peg().steps)
      expect(t.items.map((i) => i.id).sort()).toEqual(before.items.map((i) => i.id).sort())
      for (const [n, i] of t.items.entries()) if (i.kind === 'feature' && i.sketch) expect(t.items.findIndex((k) => k.id === i.sketch)).toBeLessThan(n)
      const bed = { widthMm: 256, depthMm: 256 }
      const p = await readProject(writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: appStore.getState().plate, settings: {} }], bed, settings: {}, timeline: t }), bed)
      const fileId = p.plates[0]!.objects[0]!.fileId!
      expect(p.histories.get(fileId)!.steps.map((s) => s.id)).toEqual(steps.map((s) => s.id))
      undo.undo()
      expect(appStore.getState().timeline).toBe(before)
    } finally { undo.dispose() }
  })

  it('follows the objects: merged by time, a new step at the end, undo puts it back, a removed object takes its features', () => {
    const undo = createHistory(appStore)
    stop = startTimeline()
    appStore.setState({ plate: [entry('a', box()), entry('b', peg())] })
    expect(ids(appStore.getState().timeline)).toEqual([`a:${id(0, 1)}`, `b:${id(1000, 2)}`, 'Sketch 1', `a:${id(2000, 3)}`])
    const before = appStore.getState().timeline
    const h = box()
    appStore.setState((s) => ({ plate: s.plate.map((e) => (e.id === 'a' ? { ...e, history: { ...h, steps: [...h.steps, step(id(9000, 9), sketched())] } } : e)) }))
    expect(ids(appStore.getState().timeline).slice(-2)).toEqual(['Sketch 2', `a:${id(9000, 9)}`])
    undo.undo()
    expect(appStore.getState().timeline).toBe(before)
    appStore.setState((s) => ({ plate: s.plate.filter((e) => e.id !== 'a') }))
    expect(ids(appStore.getState().timeline)).toEqual([`b:${id(1000, 2)}`])
    undo.dispose()
  })

  it('gives a pasted copy sketch ids of its own', () => {
    const t = syncTimeline(timelineOf([{ id: 'a', history: box() }]), [entry('a', box()), entry('c', box())])
    const sketches = t.items.filter((i) => i.kind === 'sketch').map((i) => i.id)
    expect(new Set(sketches).size).toBe(2)
    expect(bare(historyOf(t, 'c'))).toEqual(box().steps)
    // a copy of a view (which names its sketches) still gets its own
    const again = syncTimeline(t, [entry('a', historyOf(t, 'a')!), entry('c', historyOf(t, 'c')!), entry('d', historyOf(t, 'a')!)])
    expect(new Set(again.items.filter((i) => i.kind === 'sketch').map((i) => i.id)).size).toBe(3)
  })

  it('joins an opened design at the marker, renaming a sketch id it already has', () => {
    const a: Timeline = { ...timelineOf([{ id: 'a', history: box() }]), marker: 1 }
    const b = withBodyIds(timelineOf([{ id: 'f1', history: box() }]), (x) => (x === 'f1' ? 'b' : undefined))
    const j = joinTimelines(a, b)
    expect(j.marker).toBe(1 + b.items.length)
    expect(new Set(j.items.filter((i) => i.kind === 'sketch').map((i) => i.id)).size).toBe(2)
    expect(bare(historyOf(j, 'b'))).toEqual(box().steps)
  })

  it('saves the timeline and opens it with the rolled back steps kept', async () => {
    const t: Timeline = { ...timelineOf([{ id: 'a', history: box() }, { id: 'b', history: peg() }]), marker: 2 }
    const objects = [entry('a', historyOf(t, 'a')!), entry('b', historyOf(t, 'b')!)]
    const bed = { widthMm: 256, depthMm: 256 }
    const p = await readProject(writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects, settings: {} }], bed, settings: {}, timeline: t }), bed)
    const back = p.timeline!
    expect(back.marker).toBe(2)
    expect(back.items).toHaveLength(t.items.length)
    const [fa, fb] = p.plates[0]!.objects.map((o) => o.fileId)
    expect(p.histories.get(fa!)!.steps.map((s) => s.id)).toEqual([id(0, 1)])
    expect(p.histories.get(fb!)!.steps.map((s) => s.id)).toEqual([id(1000, 2)])
  })
})

describe('rolling the design back', () => {
  const ring = (): History => ({ version: 1, base: [], steps: [step(id(1000, 2), { op: 'sketch.revolve', loops: [{ type: 'circle', center: [10, 0], diameterMm: 4 }], axis: { point: [0, 0], direction: [0, 1] }, angleDeg: 360, operation: 'new', name: 'Ring' })] })
  const plain = (): History => ({ version: 1, base: [boxMesh(10, 10, 5)], steps: [] })
  const loader = { loadParts: () => Promise.reject(new Error('no replay expected')) }

  it('hides a body made after the marker, says so, and brings it back at the end; undo puts the marker back', async () => {
    const { rollTo } = await import('../src/cad/history/rollback')
    const { rolledBackNote } = await import('../src/plate/timeline')
    const undo = createHistory(appStore)
    stop = startTimeline()
    appStore.setState({ plate: [entry('a', plain()), entry('b', ring())], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1' })
    expect(appStore.getState().timeline.items).toHaveLength(2)
    await rollTo(loader, 0)
    expect(appStore.getState().plate.map((e) => e.id)).toEqual(['a'])
    expect(rolledBackNote()).toBe('The timeline is rolled back to step 0. Slicing uses this state.')
    // the body stays in the timeline while it is off the plate
    expect(appStore.getState().timeline.bodies.map((b) => b.id)).toEqual(['a', 'b'])
    undo.undo()
    expect(appStore.getState().plate.map((e) => e.id)).toEqual(['a', 'b'])
    expect(appStore.getState().rollback).toBeNull()
    undo.redo()
    expect(appStore.getState().rollback?.at).toBe(0)
    await rollTo(loader, 2)
    expect(appStore.getState().plate.map((e) => e.id)).toEqual(['a', 'b'])
    expect(appStore.getState().plate[1]!.history!.steps).toHaveLength(1)
    expect(rolledBackNote()).toBeNull()
    undo.dispose()
  })

  it('saves rolled back with the hidden body, and opens rolled back the same way', async () => {
    const { rollTo, settleRollback } = await import('../src/cad/history/rollback')
    stop = startTimeline()
    appStore.setState({ plate: [entry('a', plain()), entry('b', ring())], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1' })
    await rollTo(loader, 0)
    const { heldBodies } = await import('../src/plate/timeline')
    const s = appStore.getState()
    const objects = [...s.plate, ...heldBodies().map((h) => h.entry)]
    const bed = { widthMm: 256, depthMm: 256 }
    const p = await readProject(writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects, settings: {} }], bed, settings: {}, timeline: s.timeline }), bed)
    expect(p.plates[0]!.objects).toHaveLength(2)
    expect(p.timeline!.marker).toBe(0)
    // as open-project lands it: both objects, the file's timeline, then the roll back settles
    stop()
    stop = null
    const [fa, fb] = p.plates[0]!.objects.map((o) => o.fileId)
    appStore.setState({ plate: [entry('a2', p.histories.get(fa!) ?? plain()), entry('b2', ring())], rollback: null, timeline: withBodyIds(p.timeline!, (f) => (f === fa ? 'a2' : f === fb ? 'b2' : undefined)) })
    settleRollback()
    expect(appStore.getState().plate.map((e) => e.id)).toEqual(['a2'])
    expect(appStore.getState().rollback?.ends.find((h) => h.entry.id === 'b2')?.entry.history?.steps).toHaveLength(1)
  })
})

describe('the timeline over the app link', () => {
  it('reads the timeline and checks a marker before moving it', async () => {
    const { runCall } = await import('../src/app-link/methods')
    stop = startTimeline()
    appStore.setState({ plate: [entry('a', box())] })
    const { output: r, summary } = (await runCall('design.timeline', {})) as { summary: string; output: { marker: number; rolledBack: boolean; items: { kind: string; sketch?: string; name?: string }[] } }
    expect(summary).toBe('3 items, at the end')
    expect(r).toMatchObject({ marker: 3, rolledBack: false })
    expect(r.items.map((i) => i.kind)).toEqual(['feature', 'sketch', 'feature'])
    expect(r.items[2]!.sketch).toBe(`${id(2000, 3)}k`)
    expect(((await runCall('design.roll', { marker: 9 }).catch((x: unknown) => x)) as { code: string }).code).toBe('invalid_input')
  })
})
