// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { commitTransforms, dropSelectedToBed, layOnPickedFace, scaleSelectedToSize, setTrs } from '../src/plate/edit'
import { createHistory } from '../src/plate/history'
import { bounds, centerOnBed, compose, decompose, dropToBed, identity, layOnFace, mirror, scaleToSize, sizeOf, type Mat4 } from '../src/plate/transform'
import { appStore, get, set, type PlateEntry } from '../src/state/store'

/** A 20 x 10 x 5 mm box centered on the origin. */
function box(): { positions: Float32Array }[] {
  const p: number[] = []
  for (const x of [-10, 10]) for (const y of [-5, 5]) for (const z of [-2.5, 2.5]) p.push(x, y, z)
  return [{ positions: new Float32Array(p) }]
}

const close = (a: readonly number[], b: readonly number[], d = 1e-6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i] ?? 0, -Math.log10(d)))
const BED = { widthMm: 256, depthMm: 256, heightMm: 256 }

describe('transform math', () => {
  it('composes and decomposes position, rotation and scale', () => {
    const t = { position: [10, 20, 30] as [number, number, number], rotation: [15, -30, 45] as [number, number, number], scale: [1, 2, 0.5] as [number, number, number] }
    const d = decompose(compose(t))
    close(d.position, t.position)
    close(d.rotation, t.rotation, 1e-3)
    close(d.scale, t.scale)
  })

  it('keeps a mirror as a negative X scale', () => {
    const d = decompose(mirror(box(), identity(), 0))
    expect(d.scale[0]).toBeLessThan(0)
  })

  it('drops to the bed and centers on it', () => {
    const m = compose({ position: [0, 0, 40], rotation: [0, 0, 0], scale: [1, 1, 1] })
    expect(bounds(box(), dropToBed(box(), m))?.min[2]).toBeCloseTo(0)
    const c = bounds(box(), centerOnBed(box(), m, BED))!
    expect((c.min[0] + c.max[0]) / 2).toBeCloseTo(128)
    expect((c.min[1] + c.max[1]) / 2).toBeCloseTo(128)
  })

  it('scales to a size, uniform or on one axis, keeping the footprint center and the bottom', () => {
    const m = dropToBed(box(), compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }))
    const u = bounds(box(), scaleToSize(box(), m, 0, 40, true))!
    close(sizeOf(u), [40, 20, 10])
    expect(u.min[2]).toBeCloseTo(0)
    expect((u.min[0] + u.max[0]) / 2).toBeCloseTo(100)
    close(sizeOf(bounds(box(), scaleToSize(box(), m, 2, 20, false))!), [20, 10, 20])
  })

  it('lays the picked face down and puts it on the bed', () => {
    const m: Mat4 = dropToBed(box(), identity())
    // The +X face (10 x 5 mm) goes down, so X becomes the height.
    const next = layOnFace(box(), m, [1, 0, 0], [0, 0, 2.5])
    const b = bounds(box(), next)!
    expect(b.min[2]).toBeCloseTo(0)
    expect(sizeOf(b)[2]).toBeCloseTo(20)
  })
})

function entry(id: string, t: Mat4 = identity()): PlateEntry {
  const handle = { id, hash: id, name: id, triangles: 12, bboxMm: [20, 10, 5], openEdges: 0, parts: [] } as MeshHandle
  return { id, name: id, handle, parts: box().map((b) => ({ name: 'p', slot: 1, positions: b.positions, indices: new Uint32Array() })), colors: ['#bd93f9'], transform: t }
}

describe('plate edits and undo', () => {
  beforeEach(() => set({ plate: [entry('a', compose({ position: [50, 50, 10], rotation: [0, 0, 0], scale: [1, 1, 1] }))], selection: 'a', plateLoading: false }))

  it('each edit is one undo step, and redo returns it', () => {
    const h = createHistory(appStore)
    expect(dropSelectedToBed()).toBe(true)
    expect(bounds(get().plate[0]!.parts, get().plate[0]!.transform)?.min[2]).toBeCloseTo(0)
    expect(scaleSelectedToSize(0, 40, true)).toBe(true)
    expect(h.canUndo()).toBe(true)
    h.undo()
    expect(sizeOf(bounds(get().plate[0]!.parts, get().plate[0]!.transform)!)[0]).toBeCloseTo(20)
    h.undo()
    expect(bounds(get().plate[0]!.parts, get().plate[0]!.transform)?.min[2]).toBeCloseTo(7.5)
    expect(h.canUndo()).toBe(false)
    h.redo()
    expect(bounds(get().plate[0]!.parts, get().plate[0]!.transform)?.min[2]).toBeCloseTo(0)
    h.dispose()
  })

  it('a new edit clears redo, and no-op edits add no step', () => {
    const h = createHistory(appStore)
    setTrs({ position: [60, 50, 10] })
    h.undo()
    expect(h.canRedo()).toBe(true)
    setTrs({ position: [70, 50, 10] })
    expect(h.canRedo()).toBe(false)
    const before = get().plate
    commitTransforms({ a: get().plate[0]!.transform })
    expect(get().plate).toBe(before)
    h.dispose()
  })

  it('a batch of final transforms is one step; selection alone is none', () => {
    set({ plate: [...get().plate, entry('b')] })
    const h = createHistory(appStore)
    commitTransforms({ a: compose({ position: [10, 10, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }), b: compose({ position: [90, 10, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
    set({ selection: 'b' })
    h.undo()
    expect(h.canUndo()).toBe(false)
    expect(get().plate[0]!.transform[12]).toBe(50)
    h.dispose()
  })

  it('lay on face from a pick selects the object', () => {
    set({ selection: null })
    expect(layOnPickedFace({ objectId: 'a', normal: [0, 0, 1], centerBed: [50, 50, 10] })).toBe(true)
    expect(get().selection).toBe('a')
  })
})

describe('arrange, fill bed and instances', () => {
  const item = (id: string, x = 0, y = 0) => ({ id, parts: box(), transform: compose({ position: [x, y, 2.5], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
  const rect = (it: { parts: { positions: Float32Array }[] }, t: Mat4) => bounds(it.parts, t)!

  it('packs objects inside the bed without overlaps, with the gap', async () => {
    const { arrange } = await import('../src/plate/arrange')
    const items = ['a', 'b', 'c', 'd'].map((id) => item(id, 128, 128))
    const r = arrange(items, [], BED, { gapMm: 6, rotate: false })
    expect(r.leftOver).toEqual([])
    const boxes = items.map((it) => rect(it, r.transforms[it.id]!))
    for (const b of boxes) {
      expect(b.min[0]).toBeGreaterThanOrEqual(6 - 1e-6)
      expect(b.max[0]).toBeLessThanOrEqual(250 + 1e-6)
      expect(b.min[2]).toBeCloseTo(0)
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, c = boxes[j]!
      const apart = a.max[0] + 6 <= c.min[0] + 1e-6 || c.max[0] + 6 <= a.min[0] + 1e-6 || a.max[1] + 6 <= c.min[1] + 1e-6 || c.max[1] + 6 <= a.min[1] + 1e-6
      expect(apart).toBe(true)
    }
  })

  it('leaves fixed objects in place and reports what does not fit', async () => {
    const { arrange } = await import('../src/plate/arrange')
    const small = { widthMm: 40, depthMm: 40, heightMm: 40 }
    const r = arrange([item('a'), item('b')], [], { widthMm: 24, depthMm: 14, heightMm: 40 }, { gapMm: 2, rotate: false })
    expect(Object.keys(r.transforms)).toHaveLength(1)
    expect(r.leftOver).toHaveLength(1)
    const fixed = item('f', 20, 10)
    const r2 = arrange([item('a')], [fixed], small, { gapMm: 2, rotate: false })
    const fb = rect(fixed, fixed.transform)
    const ab = rect(item('a'), r2.transforms['a']!)
    expect(ab.min[1] >= fb.max[1] + 2 - 1e-6 || ab.max[1] + 2 <= fb.min[1] + 1e-6).toBe(true)
  })

  it('turns objects a quarter when that is the only way they fit', async () => {
    const { arrange } = await import('../src/plate/arrange')
    const narrow = { widthMm: 16, depthMm: 30, heightMm: 40 }
    expect(arrange([item('a')], [], narrow, { gapMm: 2, rotate: false }).leftOver).toEqual(['a'])
    const r = arrange([item('a')], [], narrow, { gapMm: 2, rotate: true })
    expect(sizeOf(rect(item('a'), r.transforms['a']!))[0]).toBeCloseTo(10)
  })

  it('counts how many copies fill the bed', async () => {
    const { fillCount } = await import('../src/plate/arrange')
    const bed = { widthMm: 70, depthMm: 40, heightMm: 40 }
    // 20 x 10 boxes with 2 mm gaps: 3 per row, 3 rows, minus the one already there.
    expect(fillCount(item('a', 12, 7), [], bed, { gapMm: 2, rotate: false })).toBe(8)
  })

  it('instances share the mesh, add and remove from the end, and undo together', async () => {
    const { setInstanceCount, instanceCount } = await import('../src/plate/edit')
    set({ plate: [entry('a', compose({ position: [40, 40, 2.5], rotation: [0, 0, 0], scale: [1, 1, 1] }))], selection: 'a', selectedIds: ['a'] })
    const h = createHistory(appStore)
    expect(setInstanceCount('a', 3)).toBe(true)
    expect(instanceCount('a')).toBe(3)
    const [orig, copy] = get().plate
    expect(copy?.parts).toBe(orig?.parts)
    expect(copy?.instanceOf).toBe('a')
    setInstanceCount('a', 2)
    expect(get().plate.map((p) => p.id)[0]).toBe('a')
    h.undo()
    h.undo()
    expect(get().plate).toHaveLength(1)
    h.dispose()
  })
})

describe('plates', () => {
  it('adds, switches, moves objects between plates, and undo skips plate switches', async () => {
    const { addPlate, switchPlate, moveSelectedToPlate, allPlates, removePlate, setPlateSettings } = await import('../src/plate/plates')
    set({ plate: [entry('a', compose({ position: [40, 40, 2.5], rotation: [0, 0, 0], scale: [1, 1, 1] })), entry('b')], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', selection: 'b', selectedIds: ['b'] })
    const h = createHistory(appStore)
    const second = addPlate()
    expect(get().activePlate).toBe(second)
    expect(get().plate).toEqual([])
    expect(get().plates.map((p) => p.name)).toEqual(['Plate 1', 'Plate 2'])
    switchPlate('plate-1')
    expect(get().plate.map((p) => p.id)).toEqual(['a', 'b'])
    set({ selection: 'b', selectedIds: ['b'] })
    expect(moveSelectedToPlate(second)).toBe(1)
    expect(allPlates().map((p) => p.objects.map((o) => o.id))).toEqual([['a'], ['b']])
    setPlateSettings(second, { sequence: 'by-object' })
    // Undo: the settings change, then the move; the switch itself is not a step.
    h.undo()
    expect(get().plates.find((p) => p.id === second)?.settings.sequence).toBe('by-layer')
    h.undo()
    expect(get().plate.map((p) => p.id)).toEqual(['a', 'b'])
    switchPlate(second)
    expect(removePlate(second)).toBe(true)
    expect(get().plates).toHaveLength(1)
    expect(removePlate('plate-1')).toBe(false)
    h.dispose()
  })
})

describe('object settings', () => {
  it('instances share them, undo covers them, and a layer height mismatch is reported', async () => {
    const { setObjectSetting, layerHeightConflict } = await import('../src/plate/object-settings')
    const inst = { ...entry('a~1'), instanceOf: 'a' }
    set({ plate: [entry('a'), inst, entry('b')], objectSettings: {} })
    const h = createHistory(appStore)
    setObjectSetting('a~1', 'wall_loops', 4)
    expect(get().objectSettings).toEqual({ a: { wall_loops: 4 } })
    // Other settings may differ freely; layer height only when printing by object.
    expect(layerHeightConflict(get(), 'by-layer', 0.2)).toBeNull()
    setObjectSetting('b', 'layer_height', 0.12)
    expect(layerHeightConflict(get(), 'by-layer', 0.2)).toMatch(/different layer heights.*0\.12 mm for b/)
    expect(layerHeightConflict(get(), 'by-object', 0.2)).toBeNull()
    h.undo()
    expect(get().objectSettings).toEqual({ a: { wall_loops: 4 } })
    setObjectSetting('a', 'wall_loops', undefined)
    expect(get().objectSettings).toEqual({})
    h.dispose()
  })
})
