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
  appStore.setState({ plate: [], timeline: { bodies: [], items: [], marker: 0 } })
})

describe('design timeline in the app', () => {
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
