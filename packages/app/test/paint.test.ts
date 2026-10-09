// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { readProject } from '../src/export/import3mf'
import { projectFiles, writeProject } from '../src/export/threemf'
import { boxMesh } from '../src/plate/mesh-ops'
import { clearPaint, commitStroke, hasPaint } from '../src/plate/paint'
import { hasEnginePaint, paintedParts, sliceHandle } from '../src/plate/painted'
import { createHistory } from '../src/plate/history'
import { appStore, get, set, type PlateEntry } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const bed = { widthMm: 256, depthMm: 256 }

function entry(): PlateEntry {
  return { id: 'a', name: 'Widget', handle: handle('h1'), parts: [boxMesh(20, 20, 20)], colors: ['#bd93f9'], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1] }
}

beforeEach(() => set({ plate: [entry()], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', selection: 'a' }))

describe('paint on objects', () => {
  it('a stroke paints triangles, an erase removes them, and undo steps back', () => {
    const h = createHistory(appStore)
    commitStroke({ objectId: 'a', partIndex: 0, layer: 'color', edits: [{ triangle: 3, after: '8' }, { triangle: 4, after: '4' }] })
    expect(get().plate[0]!.paint).toEqual({ 0: { color: { 3: '8', 4: '4' } } })
    commitStroke({ objectId: 'a', partIndex: 0, layer: 'color', edits: [{ triangle: 3, after: null }] })
    expect(get().plate[0]!.paint).toEqual({ 0: { color: { 4: '4' } } })
    h.undo()
    expect(get().plate[0]!.paint).toEqual({ 0: { color: { 3: '8', 4: '4' } } })
    h.undo()
    expect(get().plate[0]!.paint).toBeUndefined()
    h.dispose()
  })

  it('keeps layers apart and clears one or all', () => {
    commitStroke({ objectId: 'a', partIndex: 0, layer: 'color', edits: [{ triangle: 1, after: '8' }] })
    commitStroke({ objectId: 'a', partIndex: 0, layer: 'seam', edits: [{ triangle: 2, after: '4' }] })
    expect(hasPaint(get().plate[0]!.paint)).toBe(true)
    clearPaint('a', 'color')
    expect(get().plate[0]!.paint).toEqual({ 0: { seam: { 2: '4' } } })
    expect(hasEnginePaint(get().plate[0]!)).toBe(true)
    clearPaint('a')
    expect(get().plate[0]!.paint).toBeUndefined()
  })

  it('writes the paint into the 3MF triangles and reads it back per part and layer', async () => {
    commitStroke({ objectId: 'a', partIndex: 0, layer: 'color', edits: [{ triangle: 5, after: '8' }] })
    commitStroke({ objectId: 'a', partIndex: 0, layer: 'support', edits: [{ triangle: 7, after: '4' }] })
    const plate = { id: 'p', name: 'Plate 1', settings: { sequence: 'by-layer' as const }, objects: get().plate }
    const xml = projectFiles({ plates: [plate], bed, settings: {} }).map((f) => String(f.data)).join('\n')
    expect(xml).toContain('paint_color="8"')
    expect(xml).toContain('paint_supports="4"')
    const back = await readProject(writeProject({ plates: [plate], bed, settings: {} }), bed)
    expect(back.plates[0]!.objects[0]!.paint).toEqual({ 0: { color: { 5: '8' }, support: { 7: '4' } } })
  })

  it('paints fuzzy skin, turns it on for the object when it was off, and carries it through the 3MF', async () => {
    set({ objectSettings: {}, overrides: {} })
    commitStroke({ objectId: 'a', partIndex: 0, layer: 'fuzzy', edits: [{ triangle: 2, after: '4' }] })
    expect(get().plate[0]!.paint).toEqual({ 0: { fuzzy: { 2: '4' } } })
    // Fuzzy skin was Disabled (the default), so painting set the object to Painted only.
    expect(get().objectSettings['a']).toEqual({ fuzzy_skin: 'none' })
    expect(hasEnginePaint(get().plate[0]!)).toBe(true)
    // A setting of its own is left alone.
    set({ objectSettings: { a: { fuzzy_skin: 'external' } } })
    commitStroke({ objectId: 'a', partIndex: 0, layer: 'fuzzy', edits: [{ triangle: 3, after: '4' }] })
    expect(get().objectSettings['a']).toEqual({ fuzzy_skin: 'external' })
    const plate = { id: 'p', name: 'Plate 1', settings: { sequence: 'by-layer' as const }, objects: get().plate }
    const xml = projectFiles({ plates: [plate], bed, settings: {} }).map((f) => String(f.data)).join('\n')
    expect(xml).toContain('paint_fuzzy_skin="4"')
    const back = await readProject(writeProject({ plates: [plate], bed, settings: {} }), bed)
    expect(back.plates[0]!.objects[0]!.paint).toEqual({ 0: { fuzzy: { 2: '4', 3: '4' } } })
  })

  it('an unpainted object slices with its own handle; a painted one with a handle loaded from its parts and paint', async () => {
    const loads: string[] = []
    const sent: MeshPart[][] = []
    const slicer = { loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => (loads.push(name), sent.push(parts), handle(`painted-${loads.length}`)) }
    expect((await sliceHandle(slicer, get().plate[0]!)).id).toBe('h1')
    expect(loads).toEqual([])
    commitStroke({ objectId: 'a', partIndex: 0, layer: 'color', edits: [{ triangle: 2, after: '8' }] })
    const a = await sliceHandle(slicer, get().plate[0]!)
    const b = await sliceHandle(slicer, get().plate[0]!)
    expect(a.id).toBe('painted-1')
    expect(b.id).toBe('painted-1')
    expect(loads).toEqual(['Widget (painted)'])
    // The parts go as they are, with the paint texts as the store holds them.
    expect(sent[0]![0]!.positions).toBe(get().plate[0]!.parts[0]!.positions)
    expect(sent[0]![0]!.paint).toEqual({ color: { 2: '8' } })
    // Seam and support paint reach the engine too, in the same mesh; a new paint text loads a new one.
    clearPaint('a', 'color')
    commitStroke({ objectId: 'a', partIndex: 0, layer: 'seam', edits: [{ triangle: 2, after: '4' }] })
    const seam = await sliceHandle(slicer, get().plate[0]!)
    expect(seam.id).not.toBe('h1')
    expect(seam.id).not.toBe('painted-1')
    commitStroke({ objectId: 'a', partIndex: 0, layer: 'support', edits: [{ triangle: 3, after: '4' }] })
    expect((await sliceHandle(slicer, get().plate[0]!)).id).not.toBe(seam.id)
    clearPaint('a')
    expect((await sliceHandle(slicer, get().plate[0]!)).id).toBe('h1')
  })

  it('a painted part goes with the slot its object sets for it, and a new slot loads a new mesh', async () => {
    const e: PlateEntry = { ...entry(), paint: { 0: { color: { 1: '8' } } }, slotOverrides: { [entry().parts[0]!.name]: 3 } }
    expect(paintedParts(e)[0]!.slot).toBe(3)
    expect(paintedParts({ ...e, slotOverrides: {} })[0]!.slot).toBe(entry().parts[0]!.slot)
    const loads: string[] = []
    const slicer = { loadParts: async (name: string): Promise<MeshHandle> => (loads.push(name), handle(`p${loads.length}`)) }
    const a = await sliceHandle(slicer, e)
    const b = await sliceHandle(slicer, { ...e, slotOverrides: { [entry().parts[0]!.name]: 2 } })
    expect(a.id).not.toBe(b.id)
  })
})
