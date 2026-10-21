// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's design host: an empty design waits off the plate until its first step makes a body; each step lands in
// the object's history like a person's edit; a step that fails leaves the design as it was; undone steps come back.
// Runs against the geometry engine (live wasm when built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import type { HistoryMesh, StepParams } from '@slicerx/cad-history'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appDesignHost, DesignNotFound } from '../src/cad/design-host'
import { toPart } from '../src/cad/history/ops'
import { NO_MARGINS, placedOnBed, printsOnBed, setAvoidAreas, setMarginSource, type PrintMargins } from '../src/plate/arrange'
import { createHistory } from '../src/plate/history'
import { bounds } from '../src/plate/transform'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('design-host-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }

const BED = { normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] }
/** The backplate: a 150.4 by 110.4 mm plate, 3 mm thick, on the bed at (128, 128). */
const plate: StepParams = { op: 'shape.extrude', frame: { origin: [128, 128, 0], ...BED }, shape: { type: 'rectangle', widthMm: 150.4, heightMm: 110.4 }, placement: {}, spec: { distanceMm: 3, operation: 'new' }, name: 'Backplate' }
/** A hole through it, `d` mm across, at (x, y) on the plate. */
const hole = (d: number, x = 0, y = 0): StepParams => ({ op: 'shape.extrude', frame: { origin: [128, 128, 3], ...BED }, shape: { type: 'circle', diameterMm: d }, placement: { center: [x, y] }, spec: { distanceMm: 3, operation: 'cut' } })

function volume(parts: readonly Pick<HistoryMesh, 'positions' | 'indices'>[]): number {
  let v = 0
  for (const m of parts) {
    const p = m.positions
    for (let k = 0; k + 2 < m.indices.length; k += 3) {
      const [a, b, c] = [3 * m.indices[k]!, 3 * m.indices[k + 1]!, 3 * m.indices[k + 2]!]
      v += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6
    }
  }
  return Math.abs(v)
}

/** A closed box from `min` to `max`, as a design's base part. */
function box(min: [number, number, number], max: [number, number, number]): HistoryMesh {
  const [a, b] = [min, max]
  const positions = [a[0], a[1], a[2], b[0], a[1], a[2], b[0], b[1], a[2], a[0], b[1], a[2], a[0], a[1], b[2], b[0], a[1], b[2], b[0], b[1], b[2], a[0], b[1], b[2]]
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  return { name: 'Box', slot: 1, positions, indices }
}

const GENERIC = { widthMm: 256, depthMm: 256, heightMm: 256 }

beforeEach(() => set({ plate: [], selection: null, selectedIds: [], historyEdit: null, bed: { ...GENERIC } }))

describe('the app design host', () => {
  it('keeps an empty design off the plate until its first step makes a body', async () => {
    const host = appDesignHost(loader)
    const d = await host.create('Backplate', [])
    expect(get().plate).toHaveLength(0)
    expect(host.list().map((x) => x.id)).toEqual([d.id])
    await host.add(d, 0, plate)
    const e = get().plate.find((p) => p.id === d.id)!
    expect(e.history?.steps).toHaveLength(1)
    expect(volume(e.parts)).toBeCloseTo(150.4 * 110.4 * 3, -1)
    expect(d.history.steps).toHaveLength(1)
  })

  it('lands each step in the object\'s history, as a person\'s edit does', async () => {
    const host = appDesignHost(loader)
    const d = await host.create('Backplate', [])
    await host.add(d, 0, plate)
    await host.add(d, 0, hole(30))
    await host.add(d, 0, hole(4.5, 0, 30))
    await host.add(d, 0, hole(4.5, 0, -30))
    const e = get().plate.find((p) => p.id === d.id)!
    expect(e.history?.steps.map((s) => s.params.op)).toEqual(['shape.extrude', 'shape.extrude', 'shape.extrude', 'shape.extrude'])
    const holes = Math.PI * (15 * 15 + 2 * 2.25 * 2.25) * 3
    expect(volume(e.parts)).toBeCloseTo(150.4 * 110.4 * 3 - holes, -2)
  })

  it('leaves the design as it was when a step fails, and says why', async () => {
    const host = appDesignHost(loader)
    const d = await host.create('Backplate', [])
    await host.add(d, 0, plate)
    const before = volume(get().plate[0]!.parts)
    // a hole far off the plate cuts nothing
    await expect(host.add(d, 0, hole(10, 400, 400))).rejects.toThrow(/did not go through|nothing/i)
    expect(get().plate[0]!.history?.steps).toHaveLength(1)
    expect(volume(get().plate[0]!.parts)).toBeCloseTo(before, 3)
  })

  it('undoes and redoes through the history, and undoing every step takes the body off the plate', async () => {
    const host = appDesignHost(loader)
    const d = await host.create('Backplate', [])
    await host.add(d, 0, plate)
    await host.add(d, 0, hole(30))
    const last = d.history.steps.at(-1)!
    const first = d.history.steps[0]!
    d.history = { ...d.history, steps: d.history.steps.slice(0, -1) }
    d.redo = [...d.redo, last]
    await host.replay(d)
    expect(get().plate[0]!.history?.steps).toHaveLength(1)
    expect(host.get(d.id).redo.map((s) => s.id)).toEqual([last.id])
    d.history = { ...d.history, steps: [] }
    await host.replay(d)
    expect(get().plate).toHaveLength(0)
    expect(host.get(d.id).parts).toEqual([])
    d.history = { ...d.history, steps: [first] }
    d.redo = [last]
    await host.replay(d)
    expect(get().plate).toHaveLength(1)
    expect(host.get(d.id).history.steps).toHaveLength(1)
    expect(host.get(d.id).redo).toEqual([last])
    expect(volume(get().plate[0]!.parts)).toBeCloseTo(150.4 * 110.4 * 3, -1)
  })

  it('moves a part built by the bed\'s corner to the middle of the plate once, and says so; from then on its coordinates are the plate\'s', async () => {
    const host = appDesignHost(loader)
    // built around the origin, as a model sketches it: 7.5 mm past the bed's front left edges
    const d = await host.create('Peg', [box([-7.5, -7.5, 0], [7.5, 7.5, 20])])
    const e = get().plate.find((p) => p.id === d.id)!
    const b = bounds(e.parts, e.transform)!
    expect(placedOnBed(e, get().bed)).toBe(true)
    expect([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]]).toEqual([128, 128, 0])
    expect(d.landed).toEqual({ dxMm: 128, dyMm: 128 })
    // one frame: the design reports the plate's transform, and only the call that moved it says so
    const seen = host.get(d.id)
    expect(seen.transform).toEqual(e.transform)
    expect(bounds(seen.parts.map(toPart), seen.transform)).toEqual({ min: [120.5, 120.5, 0], max: [135.5, 135.5, 20] })
    expect(seen.landed).toBeUndefined()
    expect(host.list().find((x) => x.id === d.id)!.transform).toEqual(e.transform)
  })

  it('lands it beside what is on the plate when the middle is taken, and leaves a part built on the bed where it is', async () => {
    const host = appDesignHost(loader)
    const middle = await host.create('Middle', [box([108, 108, 0], [148, 148, 10])])
    expect(middle.landed).toBeUndefined()
    expect(bounds(get().plate[0]!.parts, get().plate[0]!.transform)).toEqual({ min: [108, 108, 0], max: [148, 148, 10] })
    expect(host.get(middle.id).transform).toEqual(get().plate[0]!.transform)
    const peg = await host.create('Peg', [box([-5, -5, 0], [5, 5, 10])])
    const e = get().plate.find((p) => p.id === peg.id)!
    const b = bounds(e.parts, e.transform)!
    expect(placedOnBed(e, get().bed)).toBe(true)
    // clear of the middle box
    expect(b.max[0] <= 108 || b.min[0] >= 148 || b.max[1] <= 108 || b.min[1] >= 148).toBe(true)
  })

  it('keeps a landed part 5 mm in from the bed edge when the plate gives no brim or skirt', async () => {
    set({ bed: { widthMm: 40, depthMm: 40, heightMm: 40 } })
    const host = appDesignHost(loader)
    // 32 mm wide: the middle leaves 4 mm a side, less than the 5 mm kept, and arrange keeps 6 mm, so it fits nowhere
    const d = await host.create('Wide', [box([-16, -16, 0], [16, 16, 5])])
    expect(d.landed).toEqual({ offBed: true })
    const e = get().plate.find((p) => p.id === d.id)!
    expect(bounds(e.parts, e.transform)).toEqual({ min: [-16, -16, 0], max: [16, 16, 5] })
    // 28 mm wide leaves 6 mm a side: the middle
    set({ plate: [] })
    expect((await host.create('Narrower', [box([-14, -14, 0], [14, 14, 5])])).landed).toEqual({ dxMm: 20, dyMm: 20 })
  })

  it('says when a part fits nowhere on the bed and stays where it was built', async () => {
    const host = appDesignHost(loader)
    const d = await host.create('Huge', [box([-150, -150, 0], [150, 150, 5])])
    expect(d.landed).toEqual({ offBed: true })
    expect(placedOnBed(get().plate.find((p) => p.id === d.id)!, get().bed)).toBe(false)
  })

  /** The origin of a timeline sketch's frame, or null when it has none. */
  const sketchAt = (id: string) => {
    const k = get().timeline.items.find((i) => i.id === id)
    return k?.kind === 'sketch' ? (k.frame?.origin ?? null) : undefined
  }
  /** A first body for an empty design: a box around the origin, added as parts (no engine call). */
  const firstBody = (host: ReturnType<typeof appDesignHost>, d: Parameters<ReturnType<typeof appDesignHost>['add']>[0], half = 7.5) =>
    host.add(d, -1, { op: 'parts.add', label: 'Add part', parts: [box([-half, -half, 0], [half, half, 10])] })
  const circle = { loops: [{ type: 'circle' as const, center: [0, 0] as [number, number], diameterMm: 4 }] }

  it('takes a sketch drawn for a waiting design along with its body, so it draws where the body is', async () => {
    set({ timeline: { bodies: [], items: [], marker: 0 } })
    const host = appDesignHost(loader)
    const d = await host.create('Peg', [])
    const k = host.addSketch!(circle)
    await firstBody(host, d)
    expect(d.landed).toEqual({ dxMm: 128, dyMm: 128 })
    expect(get().timeline.items.find((i) => i.id === k.id)).toMatchObject({ kind: 'sketch', frame: { origin: [128, 128, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] } })
  })

  it('moves a kept sketch once: a later design landing leaves it, and a sketch drawn in plate coordinates', async () => {
    set({ timeline: { bodies: [], items: [], marker: 0 } })
    const host = appDesignHost(loader)
    const a = await host.create('A', [])
    const kept = host.addSketch!(circle)
    await firstBody(host, a)
    expect(sketchAt(kept.id)).toEqual([128, 128, 0])
    // drawn with no design waiting: already in the plate's coordinates
    const after = host.addSketch!({ frame: { origin: [60, 60, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, loops: circle.loops })
    const b = await host.create('B', [])
    await firstBody(host, b, 5)
    expect(b.landed).toBeDefined()
    expect(sketchAt(kept.id)).toEqual([128, 128, 0])
    expect(sketchAt(after.id)).toEqual([60, 60, 0])
  })

  it('an undo and rebuild of a first body does not move its sketch a second time', async () => {
    set({ timeline: { bodies: [], items: [], marker: 0 } })
    const host = appDesignHost(loader)
    const d = await host.create('Peg', [])
    const k = host.addSketch!(circle)
    await firstBody(host, d)
    expect(sketchAt(k.id)).toEqual([128, 128, 0])
    const first = d.history.steps[0]!
    d.history = { ...d.history, steps: [] }
    d.redo = [first]
    await host.replay(d)
    expect(get().plate).toHaveLength(0)
    // a sketch drawn while it waits again, then the body back: it is already on the bed, so nothing moves
    const again = host.addSketch!(circle)
    d.history = { ...d.history, steps: [first] }
    d.redo = []
    await host.replay(d)
    expect(d.landed).toBeUndefined()
    expect(placedOnBed(get().plate[0]!, get().bed)).toBe(true)
    expect(sketchAt(k.id)).toEqual([128, 128, 0])
    expect(sketchAt(again.id)).toBeNull()
  })

  it('says a design id names nothing', () => {
    expect(() => appDesignHost(loader).get('obj_nope')).toThrow(DesignNotFound)
  })

})

describe('an edit that leaves a design off the bed', () => {
  /** A skirt `reach` mm out from every part, as the plate's margins would give it. */
  const skirt = (reach: number): PrintMargins => ({ grow: () => 0, reach: () => reach, skirt: true, keepOut: [] })
  /** A step that adds a box to the design, as a feature that grows the body would (no engine call). */
  const grow = (min: [number, number, number], max: [number, number, number]): StepParams => ({ op: 'parts.add', label: 'Tab', parts: [box(min, max)] })
  const entry = (id: string) => get().plate.find((p) => p.id === id)!
  const footprint = (id: string) => bounds(entry(id).parts, entry(id).transform)!

  afterEach(() => {
    setMarginSource(() => NO_MARGINS)
    setAvoidAreas([])
  })

  it('lands a part again when an edit pushes its skirt past the bed edge, in the same undo step, and says how far it moved', async () => {
    setMarginSource(() => skirt(10))
    const host = appDesignHost(loader)
    // built on the bed near its right edge: 26 mm to the edge, the 10 mm skirt fits
    const d = await host.create('Clip', [box([200, 100, 0], [230, 130, 10])])
    expect(d.landed).toBeUndefined()
    const was = [...entry(d.id).transform]
    const history = createHistory()
    try {
      // a tab out to 250 mm: the skirt now reaches 260 mm on a 256 mm bed
      await host.add(d, -1, grow([230, 100, 0], [250, 130, 10]))
      const b = footprint(d.id)
      expect(b.max[0] - b.min[0]).toBeCloseTo(50)
      expect(printsOnBed(entry(d.id), get().bed)).toBe(true)
      // the landing a new part gets: the middle of the bed
      expect([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]).toEqual([128, 128])
      expect(d.landed).toEqual({ dxMm: -97, dyMm: 13, edit: true })
      expect(d.transform).toEqual(entry(d.id).transform)
      // one undo takes back the edit and the move together
      history.undo()
      expect(entry(d.id).transform).toEqual(was)
      expect(entry(d.id).parts).toHaveLength(1)
    } finally {
      history.dispose()
    }
  })

  it('lands a part again when an edit grows it into an excluded area', async () => {
    setAvoidAreas([{ x: 0, y: 0, w: 40, h: 40 }])
    const host = appDesignHost(loader)
    const d = await host.create('Bracket', [box([45, 45, 0], [75, 75, 10])])
    expect(d.landed).toBeUndefined()
    // a foot out to (30, 30): inside the excluded corner
    await host.add(d, -1, grow([30, 30, 0], [45, 45, 2]))
    expect(placedOnBed(entry(d.id), get().bed)).toBe(true)
    expect(d.landed).toMatchObject({ edit: true })
    const b = footprint(d.id)
    expect(b.min[0] >= 40 || b.min[1] >= 40).toBe(true)
  })

  it('lands a new part built on the bed whose skirt reaches past the edge, as one built off the bed', async () => {
    setMarginSource(() => skirt(10))
    const host = appDesignHost(loader)
    // on the bed, but 6 mm from its right edge: the 10 mm skirt would not fit
    const d = await host.create('Clip', [box([220, 100, 0], [250, 130, 10])])
    expect(d.landed).toEqual({ dxMm: -107, dyMm: 13 })
    expect(printsOnBed(entry(d.id), get().bed)).toBe(true)
  })

  it('leaves a part that still prints where it stands after the edit', async () => {
    setMarginSource(() => skirt(10))
    const host = appDesignHost(loader)
    const d = await host.create('Clip', [box([200, 100, 0], [230, 130, 10])])
    const was = [...entry(d.id).transform]
    // out to 240 mm: the skirt reaches 250 mm, still on the bed
    await host.add(d, -1, grow([230, 100, 0], [240, 130, 10]))
    expect(entry(d.id).transform).toEqual(was)
    expect(footprint(d.id).max[0]).toBe(240)
    expect(d.landed).toBeUndefined()
  })

  it('lands it again when a replay of an edited step grows it off the bed', async () => {
    setMarginSource(() => skirt(10))
    const host = appDesignHost(loader)
    const d = await host.create('Clip', [box([200, 100, 0], [230, 130, 10])])
    await host.add(d, -1, grow([230, 100, 0], [240, 130, 10]))
    expect(d.landed).toBeUndefined()
    // the tab's step edited to reach 250 mm
    d.history = { ...d.history, steps: d.history.steps.map((s) => ({ ...s, params: grow([230, 100, 0], [250, 130, 10]) })) }
    await host.replay(d)
    expect(printsOnBed(entry(d.id), get().bed)).toBe(true)
    expect(d.landed).toMatchObject({ edit: true })
  })

  it('says so and leaves the part where it is when it fits nowhere after the edit', async () => {
    setMarginSource(() => skirt(10))
    const host = appDesignHost(loader)
    const d = await host.create('Clip', [box([100, 100, 0], [130, 130, 10])])
    const was = [...entry(d.id).transform]
    // 250 mm wide with a 10 mm skirt each side: 270 mm on a 256 mm bed
    await host.add(d, -1, grow([0, 100, 0], [250, 130, 10]))
    expect(d.landed).toEqual({ offBed: true, edit: true })
    expect(entry(d.id).transform).toEqual(was)
    expect(entry(d.id).parts).toHaveLength(2)
  })

  it('leaves a part parked off the bed where it is after an edit, and says it is off the bed', async () => {
    setMarginSource(() => skirt(10))
    const host = appDesignHost(loader)
    const d = await host.create('Clip', [box([100, 100, 0], [130, 130, 10])])
    // the person parks it past the right edge, as a drag would
    set((s) => ({ plate: s.plate.map((p) => (p.id === d.id ? { ...p, transform: p.transform.map((v, k) => (k === 12 ? v + 200 : v)) } : p)) }))
    const parked = [...entry(d.id).transform]
    expect(printsOnBed(entry(d.id), get().bed)).toBe(false)
    await host.add(d, -1, grow([130, 100, 0], [135, 130, 10]))
    expect(entry(d.id).transform).toEqual(parked)
    expect(entry(d.id).parts).toHaveLength(2)
    expect(d.landed).toEqual({ offBed: true, edit: true, parked: true })
  })

  it('never moves a locked part, and says it stays', async () => {
    setMarginSource(() => skirt(10))
    const host = appDesignHost(loader)
    const d = await host.create('Clip', [box([200, 100, 0], [230, 130, 10])])
    set((s) => ({ plate: s.plate.map((p) => (p.id === d.id ? { ...p, locked: true } : p)) }))
    const was = [...entry(d.id).transform]
    await host.add(d, -1, grow([230, 100, 0], [250, 130, 10]))
    expect(entry(d.id).transform).toEqual(was)
    expect(d.landed).toEqual({ offBed: true, edit: true, locked: true })
  })
})
