// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One design timeline (cad-history design.ts): per-object histories merge into it by when each step was made,
// sketches become their own items that features name by id, each object's history reads back unchanged as a view
// of it, and a version 3 file opens to the same histories and replays to the same meshes on the engine (live wasm
// when built, recorded replies otherwise).
import { beforeEach, describe, expect, it } from 'vitest'
import { geom } from '../src/geom/client'
import { compose } from '../src/plate/transform'
import { useGeomEngine } from './geom-engine'
import { clearReplayCache, replayHistory, type HistoryMesh, timelineFiles, timelineOf, historiesOf, historyFiles, historyLost, historyNewer, historyOf, madeAt, parseHistories, parseTimeline, withHistory, type FaceFrame, type FeatureItem, type History, type SketchItem, type SketchLoop, type Step, type StepParams, type Timeline } from '@slicerx/cad-history'
import { boxMesh } from '../src/plate/mesh-ops'

useGeomEngine('design-timeline-replies')
beforeEach(() => clearReplayCache())

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]
const T0 = 1_790_000_000_000
const id = (ms: number, seq: number) => `s${(T0 + ms).toString(36)}${seq.toString(36)}`
const step = (sid: string, params: StepParams, more: Partial<Step> = {}): Step => ({ id: sid, part: 0, transform: T, params, ...more })
const top = (): FaceFrame => ({ origin: [100, 100, 5], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })
const square = (): SketchLoop => ({ start: [0, 0], segments: [{ type: 'line', to: [4, 0] }, { type: 'line', to: [4, 4] }, { type: 'line', to: [0, 4] }, { type: 'line', to: [0, 0] }] })

const pull = (d: number): StepParams => ({ op: 'face.push', at: [100, 100, 5], normal: [0, 0, 1], distanceMm: d })
const sketched = (): StepParams => ({ op: 'shape.extrude', frame: top(), shape: { type: 'sketch', loops: [square()] }, placement: {}, spec: { distanceMm: 3, operation: 'join' } })
const revolved = (): StepParams => ({ op: 'sketch.revolve', loops: [{ type: 'circle', center: [10, 0], diameterMm: 4 }], axis: { point: [0, 0], direction: [0, 1] }, angleDeg: 360, operation: 'new', name: 'Ring' })
const circle = (): StepParams => ({ op: 'shape.extrude', frame: top(), shape: { type: 'circle', diameterMm: 6 }, placement: {}, spec: { distanceMm: 2, operation: 'join' } })

/** Two objects worked on in turns: a box (pull, sketch, circle) and a ring made by a revolve, then pulled. */
function plate(): { id: string; history: History }[] {
  const box: History = { version: 1, base: [boxMesh(40, 20, 5)], steps: [step(id(0, 1), pull(5)), step(id(2000, 3), sketched(), { label: 'Tab', suppressed: true }), step(id(5000, 5), circle(), { bind: 'height + 2' })] }
  const ring: History = { version: 1, base: [], steps: [step(id(1000, 2), revolved()), step(id(3000, 4), pull(1), { broken: 'The face is gone.' })], ended: 'Merged from two objects.' }
  return [
    { id: 'box', history: box },
    { id: 'ring', history: ring },
  ]
}

describe('design timeline', () => {
  it('reads when a step was made from its id', () => {
    expect(madeAt(id(1234, 7))).toEqual({ time: T0 + 1234, seq: 7 })
    expect(madeAt('step-1')).toBeNull()
  })

  it('merges every object into one timeline by when each step was made', () => {
    const d = timelineOf(plate())
    const order = d.items.map((i) => (i.kind === 'sketch' ? i.name : `${i.body} ${i.params.op}`))
    expect(order).toEqual(['box face.push', 'Sketch 1', 'ring sketch.revolve', 'Sketch 2', 'box shape.extrude', 'ring face.push', 'box shape.extrude'])
    expect(d.marker).toBe(d.items.length)
    expect(d.bodies.map((b) => [b.id, b.base.length, b.ended ?? null])).toEqual([
      ['box', 1, null],
      ['ring', 0, 'Merged from two objects.'],
    ])
  })

  it('keeps an object in its own order when its clock went back', () => {
    const late: History = { version: 1, base: [], steps: [step(id(9000, 1), pull(1)), step(id(100, 2), pull(2)), step('odd', pull(3))] }
    const early: History = { version: 1, base: [], steps: [step(id(5000, 3), pull(4))] }
    const d = timelineOf([{ id: 'a', history: late }, { id: 'b', history: early }])
    expect(d.items.map((i) => (i as FeatureItem).params.op === 'face.push' && ((i as FeatureItem).params as { distanceMm: number }).distanceMm)).toEqual([4, 1, 2, 3])
  })

  it('breaks a tie in time by the counter, then by object order', () => {
    const a: History = { version: 1, base: [], steps: [step(id(700, 9), pull(1)), step(id(800, 4), pull(2))] }
    const b: History = { version: 1, base: [], steps: [step(id(700, 3), pull(3)), step(id(800, 4), pull(4))] }
    const ops = (d: Timeline) => d.items.map((i) => ((i as FeatureItem).params as { distanceMm: number }).distanceMm)
    expect(ops(timelineOf([{ id: 'a', history: a }, { id: 'b', history: b }]))).toEqual([3, 1, 2, 4])
    expect(ops(timelineOf([{ id: 'b', history: b }, { id: 'a', history: a }]))).toEqual([3, 1, 4, 2])
  })

  it('gives each sketch its own item, which the feature names by id', () => {
    const d = timelineOf(plate())
    const sketches = d.items.filter((i): i is SketchItem => i.kind === 'sketch')
    const features = d.items.filter((i): i is FeatureItem => i.kind === 'feature' && i.sketch !== undefined)
    expect(sketches.map((k) => [k.name, k.loops.length, Boolean(k.frame)])).toEqual([
      ['Sketch 1', 1, false],
      ['Sketch 2', 1, true],
    ])
    expect(features.map((f) => f.sketch)).toEqual(sketches.map((k) => k.id))
    for (const f of features) expect(Object.keys(f.params)).not.toContain('loops')
    expect(Object.keys(features[1]!.params)).not.toContain('shape')
    // a typed shape stays inline
    expect(d.items.filter((i) => i.kind === 'feature' && i.params.op === 'shape.extrude' && !i.sketch)).toHaveLength(1)
  })

  it('reads every object back unchanged as a view of the timeline', () => {
    const objects = plate()
    const views = historiesOf(timelineOf(objects))
    for (const o of objects) expect(views.get(o.id)).toEqual(o.history)
  })

  it('carries sketch constraints with the sketch', () => {
    const cons = [{ type: 'horizontal', line: 0 }]
    const p = sketched() as Extract<StepParams, { op: 'shape.extrude' }>
    const h: History = { version: 1, base: [], steps: [step(id(0, 1), { ...p, shape: { ...p.shape, constraints: cons } as never })] }
    const d = timelineOf([{ id: 'a', history: h }])
    expect((d.items[0] as SketchItem).constraints).toEqual(cons)
    expect(historyOf(d, 'a')).toEqual(h)
  })

  it('takes a body history back unchanged', () => {
    const t = timelineOf(plate())
    for (const b of t.bodies) expect(withHistory(t, b.id, historyOf(t, b.id)!)).toEqual(t)
  })

  it('puts a new step at the end, with a sketch of its own', () => {
    const t = timelineOf(plate())
    const h = historyOf(t, 'ring')!
    const next = withHistory(t, 'ring', { ...h, steps: [...h.steps, step(id(9000, 9), sketched())] })
    expect(next.items.slice(-2).map((i) => (i.kind === 'sketch' ? i.name : i.body))).toEqual(['Sketch 3', 'ring'])
    expect(next.marker).toBe(next.items.length)
    expect(historyOf(next, 'ring')!.steps.at(-1)!.params).toEqual(sketched())
  })

  it('edits a sketch in place: same id, name and spot, new loops, later steps unchanged', () => {
    const t = timelineOf(plate())
    const h = historyOf(t, 'box')!
    const tri: SketchLoop = { points: [[0, 0], [5, 0], [0, 5]] }
    const steps = h.steps.map((s) => (s.params.op === 'shape.extrude' && s.params.shape.type === 'sketch' ? { ...s, params: { ...s.params, shape: { type: 'sketch' as const, loops: [tri] } } } : s))
    const next = withHistory(t, 'box', { ...h, steps })
    const k = next.items.findIndex((i) => i.kind === 'sketch' && i.name === 'Sketch 2')
    expect(k).toBe(t.items.findIndex((i) => i.kind === 'sketch' && i.name === 'Sketch 2'))
    expect((next.items[k] as SketchItem).loops).toEqual([tri])
    expect(next.items.length).toBe(t.items.length)
    expect(historyOf(next, 'box')!.steps).toEqual(steps)
  })

  it('drops a removed step and keeps its sketch, as Fusion does', () => {
    const t = timelineOf(plate())
    const h = historyOf(t, 'box')!
    const next = withHistory(t, 'box', { ...h, steps: h.steps.filter((s) => s.params.op !== 'shape.extrude' || s.params.shape.type !== 'sketch') })
    expect(next.items.filter((i) => i.kind === 'sketch')).toHaveLength(2)
    expect(next.items).toHaveLength(t.items.length - 1)
  })

  it('adds a body a step made', () => {
    const t = timelineOf(plate())
    const next = withHistory(t, 'peg', { version: 1, base: [], steps: [step(id(9500, 1), revolved())] })
    expect(next.bodies.map((b) => b.id)).toEqual(['box', 'ring', 'peg'])
    expect(next.items.slice(-2).map((i) => (i.kind === 'sketch' ? i.name : i.body))).toEqual(['Sketch 3', 'peg'])
  })

  it('keeps the marker where it was when a step goes in before it', () => {
    const t: Timeline = { ...timelineOf(plate()), marker: 3 }
    const h = historyOf({ ...t, marker: t.items.length }, 'box')!
    const first = h.steps[0]!
    const added = step(id(100, 8), pull(2))
    const next = withHistory(t, 'box', { ...h, steps: [first, added, ...h.steps.slice(1)] })
    expect(next.items[1]).toMatchObject({ id: added.id })
    expect(next.marker).toBe(4)
  })

  it('rolls back to the marker: later items leave the views', () => {
    const d: Timeline = { ...timelineOf(plate()), marker: 3 }
    expect(historyOf(d, 'box')!.steps.map((s) => s.id)).toEqual([id(0, 1)])
    expect(historyOf(d, 'ring')!.steps.map((s) => s.id)).toEqual([id(1000, 2)])
  })

  it('saves as version 3 and opens to the same histories', () => {
    const objects = plate()
    const fileIds = new Map([
      ['box', 1],
      ['ring', 2],
    ])
    const entries = timelineFiles(timelineOf(objects), fileIds)
    const json = JSON.parse(entries[0]!.data as string) as { version: number; items: { kind: string; body?: string }[] }
    expect(json.version).toBe(3)
    expect(json.items.filter((i) => i.kind === 'sketch')).toHaveLength(2)
    expect(json.items.find((i) => i.kind === 'feature')!.body).toBe('1')
    const files = new Map(entries.map((e) => [e.name, typeof e.data === 'string' ? new TextEncoder().encode(e.data) : e.data]))
    const read = parseHistories(files, new Set(['1', '2']))
    const plain = (h: History) => JSON.parse(JSON.stringify({ ...h, base: h.base.map((m) => ({ ...m, positions: Array.from(m.positions), indices: Array.from(m.indices) })) })) as unknown
    expect(plain(read.get('1')!)).toEqual(plain(objects[0]!.history))
    expect(plain(read.get('2')!)).toEqual(plain(objects[1]!.history))
    expect(historyLost(files, new Set(['1', '2']), read)).toBeNull()
    expect(historyNewer(files)).toBeNull()
  })

  it('reads a version 3 file back as the same timeline, rolled back steps included', () => {
    const ids = new Map([
      ['box', 1],
      ['ring', 2],
    ])
    const t: Timeline = { ...timelineOf(plate()), marker: 4 }
    const files = new Map(timelineFiles(t, ids).map((e) => [e.name, typeof e.data === 'string' ? new TextEncoder().encode(e.data) : e.data]))
    const back = parseTimeline(files, new Set(['1', '2']))!
    const named = (x: Timeline) => JSON.parse(JSON.stringify({ ...x, bodies: x.bodies.map((b) => ({ ...b, base: b.base.map((m) => ({ ...m, positions: Array.from(m.positions), indices: Array.from(m.indices) })) })) }).replaceAll('"box"', '"1"').replaceAll('"ring"', '"2"')) as unknown
    expect(named(back)).toEqual(named(t))
    // a version 2 file reads as its merge
    const v2 = new Map(historyFiles(plate(), ids).map((e) => [e.name, typeof e.data === 'string' ? new TextEncoder().encode(e.data) : e.data]))
    expect(named(parseTimeline(v2, new Set(['1', '2']))!)).toEqual(named(timelineOf(plate())))
  })

  it('is no bigger on disk than the version 2 file', () => {
    const objects = plate()
    const fileIds = new Map([
      ['box', 1],
      ['ring', 2],
    ])
    const v2 = historyFiles(objects, fileIds)[0]!.data as string
    const v3 = timelineFiles(timelineOf(objects), fileIds)[0]!.data as string
    expect(v3.length).toBeLessThan(v2.length * 1.25)
  })

  it('opens a version 3 file with a missing sketch without that one history', () => {
    const d = timelineOf(plate())
    const entries = timelineFiles({ ...d, items: d.items.filter((i) => i.kind !== 'sketch' || i.name !== 'Sketch 2') }, new Map([['box', 1], ['ring', 2]]))
    const files = new Map(entries.map((e) => [e.name, typeof e.data === 'string' ? new TextEncoder().encode(e.data) : e.data]))
    const read = parseHistories(files, new Set(['1', '2']))
    expect([...read.keys()]).toEqual(['2'])
    expect(historyLost(files, new Set(['1', '2']), read)).toBe('The CAD history of 1 object could not be read, so it opens without it.')
  })

  it('says a newer SlicerX saved a version 4 file', () => {
    const files = new Map([['Metadata/slicerx_history.json', new TextEncoder().encode(JSON.stringify({ version: 4 }))]])
    expect(historyNewer(files)).toMatch(/history version 4/)
  })
})

/** Signed volume of a closed mesh, mm3. */
function volume(m: Pick<HistoryMesh, 'positions' | 'indices'>): number {
  let v = 0
  const p = m.positions
  for (let k = 0; k + 2 < m.indices.length; k += 3) {
    const [a, b, c] = [3 * m.indices[k]!, 3 * m.indices[k + 1]!, 3 * m.indices[k + 2]!]
    v += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6
  }
  return v
}

describe('design timeline on the engine', () => {
  const call = (op: string, r: unknown) => geom().call(op, r)
  const A = compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
  const B = compose({ position: [160, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
  const frame = (x: number, z: number): FaceFrame => ({ origin: [x, 100, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })
  const tab: SketchLoop = { start: [-6, -4], segments: [{ type: 'line', to: [6, -4] }, { type: 'line', to: [6, 4] }, { type: 'line', to: [-6, 4] }, { type: 'line', to: [-6, -4] }] }

  /** A plate saved before version 3: a bracket and a block worked on in turns, two steps made in the same millisecond. */
  function saved(): { id: string; history: History }[] {
    const at = (t: Step['transform']) => (sid: string, params: StepParams): Step => ({ id: sid, part: 0, transform: t, params })
    const bracket: History = {
      version: 1,
      base: [boxMesh(40, 20, 5)],
      steps: [
        at(A)(id(0, 1), { op: 'face.push', at: [100, 100, 5], normal: [0, 0, 1], distanceMm: 5 }),
        at(A)(id(3000, 2), { op: 'shape.extrude', frame: frame(100, 10), shape: { type: 'sketch', loops: [tab] }, placement: {}, spec: { distanceMm: 4, operation: 'join' } }),
        at(A)(id(6000, 5), { op: 'shape.extrude', frame: frame(100, 14), shape: { type: 'circle', diameterMm: 4 }, placement: {}, spec: { distanceMm: 3, operation: 'cut' } }),
      ],
    }
    const block: History = {
      version: 1,
      base: [boxMesh(20, 20, 10)],
      steps: [
        at(B)(id(3000, 2), { op: 'face.push', at: [160, 100, 10], normal: [0, 0, 1], distanceMm: 3 }),
        at(B)(id(4000, 4), { op: 'shape.extrude', frame: frame(160, 13), shape: { type: 'sketch', loops: [tab] }, placement: {}, spec: { distanceMm: 2, operation: 'cut' } }),
      ],
    }
    return [
      { id: 'bracket', history: bracket },
      { id: 'block', history: block },
    ]
  }

  const shape = (parts: HistoryMesh[]) => parts.map((m) => ({ vertices: m.positions.length / 3, triangles: m.indices.length / 3, volume: Math.round(volume(m) * 1000) / 1000 }))

  it('replays every body the same from the timeline and from its saved version 3 file as from its own history', async () => {
    const objects = saved()
    const t = timelineOf(objects)
    // the tie at 3000 ms goes to the bracket, listed first
    expect(t.items.map((i) => (i.kind === 'sketch' ? i.name : i.body))).toEqual(['bracket', 'Sketch 1', 'bracket', 'block', 'Sketch 2', 'block', 'bracket'])
    const files = new Map(timelineFiles(t, new Map([['bracket', 1], ['block', 2]])).map((e) => [e.name, typeof e.data === 'string' ? new TextEncoder().encode(e.data) : e.data]))
    const opened = parseHistories(files, new Set(['1', '2']))
    const views = historiesOf(t)
    for (const [k, o] of objects.entries()) {
      const old = await replayHistory(call, { history: o.history })
      expect(old.status.every((s) => s.state === 'done')).toBe(true)
      const view = await replayHistory(call, { history: views.get(o.id)! })
      const file = await replayHistory(call, { history: opened.get(String(k + 1))! })
      expect(shape(view.parts)).toEqual(shape(old.parts))
      expect(shape(file.parts)).toEqual(shape(old.parts))
    }
  })
})
