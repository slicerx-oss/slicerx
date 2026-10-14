// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { boxMesh, bake } from '../src/plate/mesh-ops'
import { splitObject } from '../src/plate/split-edit'
import { compose, identity, multiply, bounds } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { history } from '../src/plate/history'

const handle = (name: string, parts: MeshPart[]): MeshHandle => ({ id: name, hash: name, name, triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0), bboxMm: [30, 10, 10], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: p.indices.length / 3 })) })
const loader = { loadParts: async (name: string, parts: MeshPart[]) => handle(name, parts) }
let source: PlateEntry

beforeEach(() => {
  const a = boxMesh(10, 10, 10)
  const t = identity(); t[12] = 30
  const b = bake(a, t)
  const mesh: MeshPart = { name: 'Body', slot: 1, positions: Float32Array.from([...a.positions, ...b.positions]), indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, (i) => i + a.positions.length / 3)]), paint: { color: { 0: '2', 12: '3' } } }
  source = { id: 'source', name: 'Two boxes', parts: [mesh], colors: ['#abcdef'], handle: handle('source', [mesh]), transform: compose({ position: [100, 100, 0], rotation: [0, 0, 90], scale: [1, 1, 1] }), printable: false, paint: { 0: { seam: { 13: '1' } } }, slotOverrides: { Body: 4 }, partSettings: { Body: { fill_density: '50%' } }, volumes: [{ id: 'v1', name: 'Blocker', role: 'support_blocker', handle: handle('v', [a]), part: a, local: identity() }], brimPoints: [[-4, -4, 0, 2], [34, -4, 0, 2]], history: { version: 1, base: [mesh], steps: [] }, dimensions: [{ id: 'd1', kind: 'length', a: { object: 'source', pick: { triangle: 14, at: [30, 0, 0] }, snapMm: 0.2, feature: { kind: 'edge', a: [30, 0, 0], b: [30, 0, 10] } } }] }
  const { dimensions: _dimensions, ...plain } = source
  const copy = { ...plain, id: 'copy', instanceOf: 'source' }
  set({ plate: [source], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }, { id: 'p2', name: 'Plate 2', objects: [copy], settings: { sequence: 'by-layer' } }], activePlate: 'p1', selection: 'source', selectedIds: ['source'], historyEdit: null, rollback: null, objectSettings: { source: { fill_density: '25%' } } })
  history().clear()
})

it('splits into objects with paint, settings, volumes, dimensions and world geometry preserved in one Undo step', async () => {
  const before = get()
  const result = await splitObject(loader, source.id, 'objects')
  const entries = get().plate
  expect(result.ids).toEqual(entries.map((e) => e.id))
  expect(entries).toHaveLength(2)
  expect(entries.map((e) => e.printable)).toEqual([false, false])
  expect(entries.map((e) => e.parts[0]!.paint?.color?.[0])).toEqual(['2', '3'])
  expect(entries[1]!.paint).toEqual({ 0: { seam: { 1: '1' } } })
  for (const e of entries) {
    expect(get().objectSettings[e.id]).toEqual({ fill_density: '25%' })
    expect(e.partSettings?.[e.parts[0]!.name]).toEqual({ fill_density: '50%' })
    expect(e.slotOverrides?.[e.parts[0]!.name]).toBe(4)
    expect(e.history).toMatchObject({ steps: [], ended: 'History ends here: the object was split into objects.' })
    expect(multiply(e.transform, e.volumes![0]!.local)).toEqual(multiply(source.transform, source.volumes![0]!.local))
  }
  const old = bounds(source.parts, source.transform)!
  const boxes = entries.map((e) => bounds(e.parts, e.transform)!)
  expect(old.min).toEqual(old.min.map((_, k) => Math.min(...boxes.map((b) => b.min[k]!))))
  expect(old.max).toEqual(old.max.map((_, k) => Math.max(...boxes.map((b) => b.max[k]!))))
  expect(entries.reduce((n, e) => n + (e.brimPoints?.length ?? 0), 0)).toBe(2)
  expect(entries[0]!.dimensions![0]!.a).toMatchObject({ object: entries[1]!.id, pick: { triangle: 2, at: [0, 0, 0] } })
  const copy = get().plates[1]!.objects[0]!
  expect(copy.instanceOf).toBeUndefined()
  expect(copy.parts).toBe(source.parts)
  expect(get().objectSettings.copy).toEqual({ fill_density: '25%' })
  expect(history().snapshots()).toHaveLength(1)
  history().undo()
  expect(get().plate).toBe(before.plate)
  expect(get().plates).toBe(before.plates)
  expect(get().objectSettings).toBe(before.objectSettings)
})

it('splits to parts under the same id and preserves per-part state without altering a copy', async () => {
  const result = await splitObject(loader, source.id, 'parts')
  expect(result).toEqual({ ids: ['source'], parts: 2 })
  const e = get().plate[0]!
  expect(e.transform).toBe(source.transform)
  expect(e.paint).toEqual({ 1: { seam: { 1: '1' } } })
  expect(e.parts.map((p) => e.slotOverrides?.[p.name])).toEqual([4, 4])
  expect(e.parts.map((p) => e.partSettings?.[p.name])).toEqual([{ fill_density: '50%' }, { fill_density: '50%' }])
  expect(e.dimensions![0]!.a).toMatchObject({ object: 'source', pick: { triangle: 14 } })
  expect(get().plates[1]!.objects[0]!.parts).toBe(source.parts)
  expect(get().plates[1]!.objects[0]!.instanceOf).toBeUndefined()
})

it('splits a concrete copy without changing its source or linked siblings', async () => {
  const copy = { ...source, id: 'chosen', instanceOf: 'source' }
  set({ plate: [source, copy] })
  const result = await splitObject(loader, copy.id, 'parts')
  expect(result.ids).toEqual(['chosen'])
  expect(get().plate[0]).toBe(source)
  expect(get().plate[1]!.instanceOf).toBeUndefined()
  expect(get().objectSettings.chosen).toEqual({ fill_density: '25%' })
  expect(get().plates[1]!.objects[0]!.instanceOf).toBe('source')
})

it('does not resurrect a target removed during loading or overwrite a newer edit', async () => {
  const changed = { ...source, name: 'Changed' }
  const delayed = { loadParts: async (name: string, parts: MeshPart[]) => { set({ plate: [changed] }); return handle(name, parts) } }
  await expect(splitObject(delayed, source.id, 'objects')).rejects.toMatchObject({ code: 'busy' })
  expect(get().plate).toEqual([changed])
  const removed = { loadParts: async (name: string, parts: MeshPart[]) => { set({ plate: [] }); return handle(name, parts) } }
  await expect(splitObject(removed, source.id, 'objects')).rejects.toMatchObject({ code: 'busy' })
  expect(get().plate).toEqual([])
})

it('refuses changes to shared source settings while a copy is loading', async () => {
  const copy = { ...source, id: 'chosen', instanceOf: 'source' }
  set({ plate: [source, copy] })
  const changed = { ...source, partSettings: { Body: { fill_density: '80%' } } }
  const delayed = { loadParts: async (name: string, parts: MeshPart[]) => { set({ plate: [changed, copy] }); return handle(name, parts) } }
  await expect(splitObject(delayed, copy.id, 'parts')).rejects.toMatchObject({ code: 'busy' })
  expect(get().plate).toEqual([changed, copy])
})

it('refuses locked objects, rolled-back history and an object with no further split', async () => {
  set({ plate: [{ ...source, locked: true }] })
  await expect(splitObject(loader, source.id, 'objects')).rejects.toMatchObject({ code: 'refused' })
  set({ plate: [source], rollback: {} as never })
  await expect(splitObject(loader, source.id, 'parts')).rejects.toMatchObject({ code: 'busy' })
  set({ plate: [{ ...source, parts: [boxMesh(10, 10, 10)] }], rollback: null })
  history().clear()
  await expect(splitObject(loader, source.id, 'parts')).rejects.toMatchObject({ code: 'refused' })
  expect(history().snapshots()).toHaveLength(0)
})
