// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { boxMesh } from '../src/plate/mesh-ops'
import { clearClipboard, clipboard, copySelection, copyVolume, cutSelection, duplicateSelection, nearestFreeShift, pasteClipboard } from '../src/plate/clipboard'
import { createHistory } from '../src/plate/history'
import { bounds, compose } from '../src/plate/transform'
import { appStore, get, set, type PlateEntry } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const at = (x: number, y: number) => compose({ position: [x, y, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })

function obj(id: string, x: number, y: number, size = 20): PlateEntry {
  return { id, name: id, handle: handle(id), parts: [boxMesh(size, size, size)], colors: ['#bd93f9'], transform: at(x, y) }
}

const overlap = (a: PlateEntry, b: PlateEntry) => {
  const A = bounds(a.parts, a.transform)!
  const B = bounds(b.parts, b.transform)!
  return A.min[0]! < B.max[0]! && B.min[0]! < A.max[0]! && A.min[1]! < B.max[1]! && B.min[1]! < A.max[1]!
}

beforeEach(() => {
  set({ plate: [obj('a', 100, 100)], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }, { id: 'plate-2', name: 'Plate 2', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', selection: 'a', selectedIds: ['a'], objectSettings: {} })
  clearClipboard()
})

describe('nearest free shift', () => {
  const bed = { widthMm: 100, depthMm: 100 }
  const box = (x0: number, y0: number, x1: number, y1: number) => ({ min: [x0, y0, 0] as [number, number, number], max: [x1, y1, 10] as [number, number, number] })

  it('stays put when the spot is free and moves the least when it is not', () => {
    expect(nearestFreeShift(box(10, 10, 30, 30), [], bed)).toEqual([0, 0])
    const s = nearestFreeShift(box(10, 10, 30, 30), [box(10, 10, 30, 30)], bed)!
    // Clear of the other by the gap, in one direction, nothing farther than needed.
    expect(Math.max(Math.abs(s[0]), Math.abs(s[1]))).toBeLessThanOrEqual(24)
    expect(s[0] !== 0 || s[1] !== 0).toBe(true)
  })

  it('returns null when it cannot fit', () => {
    expect(nearestFreeShift(box(0, 0, 200, 20), [], bed)).toBeNull()
    expect(nearestFreeShift(box(0, 0, 90, 90), [box(0, 0, 100, 100)], bed)).toBeNull()
  })
})

describe('copy, cut, paste and duplicate', () => {
  it('pastes beside the original, with its own id, keeping settings, paint, volumes and slots', () => {
    const a = get().plate[0]!
    const part = { ...a.parts[0]!, slot: 2 }
    set({
      plate: [{ ...a, parts: [part], paint: { 0: { color: { 1: '8' } } }, volumes: [{ id: 'v1', name: 'Negative volume 1', role: 'negative', handle: handle('v1'), part: boxMesh(4, 4, 4), local: at(0, 0) }] }],
      objectSettings: { a: { wall_loops: 5 } },
    })
    expect(copySelection()).toBe(1)
    const ids = pasteClipboard()
    expect(ids).toHaveLength(1)
    const [orig, copy] = get().plate
    expect(copy!.id).not.toBe('a')
    expect(overlap(orig!, copy!)).toBe(false)
    expect(copy!.parts[0]!.slot).toBe(2)
    expect(copy!.paint).toEqual({ 0: { color: { 1: '8' } } })
    expect(copy!.volumes).toHaveLength(1)
    expect(copy!.volumes![0]!.id).not.toBe('v1')
    expect(get().objectSettings[copy!.id]).toEqual({ wall_loops: 5 })
    expect(get().selection).toBe(copy!.id)
  })

  it('a paste is one undo step, and several pastes do not stack on one spot', () => {
    const h = createHistory(appStore)
    copySelection()
    pasteClipboard()
    pasteClipboard()
    const [, b, c] = get().plate
    expect(get().plate).toHaveLength(3)
    expect(overlap(b!, c!)).toBe(false)
    h.undo()
    expect(get().plate).toHaveLength(2)
    h.undo()
    expect(get().plate).toHaveLength(1)
    h.dispose()
  })

  it('cut removes the originals in one step and pastes them back where they were', () => {
    const h = createHistory(appStore)
    expect(cutSelection()).toBe(1)
    expect(get().plate).toHaveLength(0)
    pasteClipboard()
    const back = get().plate[0]!
    expect(back.transform[12]).toBeCloseTo(100)
    expect(back.transform[13]).toBeCloseTo(100)
    h.undo()
    expect(get().plate).toHaveLength(0)
    h.undo()
    expect(get().plate).toHaveLength(1)
    h.dispose()
  })

  it('pastes on another plate, in free space there', () => {
    copySelection()
    set({ plate: [], selection: null, selectedIds: [], activePlate: 'plate-2' })
    pasteClipboard()
    expect(get().plate).toHaveLength(1)
    expect(get().plate[0]!.transform[12]).toBeCloseTo(100)
  })

  it('a group pastes as a whole, beside itself', () => {
    set({ plate: [obj('a', 60, 60), obj('b', 90, 60)], selection: 'a', selectedIds: ['a', 'b'] })
    copySelection()
    pasteClipboard()
    const [a, b, a2, b2] = get().plate
    expect(get().plate).toHaveLength(4)
    for (const x of [a, b]) for (const y of [a2, b2]) expect(overlap(x!, y!)).toBe(false)
    // Their positions relative to each other are kept.
    expect(b2!.transform[12]! - a2!.transform[12]!).toBeCloseTo(b!.transform[12]! - a!.transform[12]!)
  })

  it('duplicate adds a copy and leaves the clipboard alone', () => {
    expect(clipboard()).toBeNull()
    const ids = duplicateSelection()
    expect(ids).toHaveLength(1)
    expect(get().plate).toHaveLength(2)
    expect(clipboard()).toBeNull()
  })

  it('pastes a copied volume into another object, beside it', () => {
    const a = get().plate[0]!
    const v = { id: 'v1', name: 'Modifier 1', role: 'modifier' as const, handle: handle('v1'), part: boxMesh(4, 4, 4), local: at(0, 0), settings: { wall_loops: 4 } }
    set({ plate: [{ ...a, volumes: [v] }, obj('b', 160, 160)], selection: 'b', selectedIds: ['b'] })
    expect(copyVolume('a', 'v1')).toBe(true)
    const ids = pasteClipboard()
    expect(ids).toHaveLength(1)
    const b = get().plate.find((p) => p.id === 'b')!
    expect(b.volumes).toHaveLength(1)
    expect(b.volumes![0]!.settings).toEqual({ wall_loops: 4 })
    expect(b.volumes![0]!.id).not.toBe('v1')
  })
})
