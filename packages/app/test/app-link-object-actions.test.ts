// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, expect, it } from 'vitest'
import { runCall } from '../src/app-link/methods'
import { clipboard, clearClipboard, copySelection } from '../src/plate/clipboard'
import { history } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose, bounds } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const entry = (id: string, x = 40): PlateEntry => {
  const part = boxMesh(10, 20, 30)
  return { id, name: id, parts: [part], colors: ['#ff0000'], transform: compose({ position: [x, 40, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }), handle: { id, hash: id, name: id, triangles: 12, bboxMm: [10, 20, 30], openEdges: 0, parts: [{ name: part.name, triangles: 12, slot: 1 }] } }
}
type Row = { id: string; name: string; instanceOf?: string; settings: Record<string, unknown>; transform: number[]; partDetails: { settings: Record<string, unknown> }[] }
type Result = { output: { objects: Row[]; ids: string[]; removed: string[]; requested?: number; created?: number } }
const call = (name: string, args: Record<string, unknown>) => runCall(`project.${name}`, args, { id: 'client', name: 'Print helper' }) as Promise<Result>

beforeEach(() => {
  set({ plate: [entry('source'), entry('other', 100)], plates: [{ id: 'one', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'one', bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, selection: 'other', selectedIds: ['other'], objectSettings: {}, historyEdit: null, rollback: null, toast: null })
  clearClipboard()
  history().clear()
})

it('renames a concrete object, reads the normalized name and leaves selection and no-op undo alone', async () => {
  expect((await call('rename', { object: 'source', name: '  New name  ' })).output.objects[0]!.name).toBe('New name')
  expect(get().selection).toBe('other')
  expect(history().snapshots()).toHaveLength(1)
  await call('rename', { object: 'source', name: 'New name' })
  expect(history().snapshots()).toHaveLength(1)
  history().undo()
  expect(get().plate[0]!.name).toBe('source')
})

it('duplicates a linked copy with inherited settings, independent ids, spacing, and one undo step', async () => {
  const src = entry('source')
  src.partSettings = { [src.parts[0]!.name]: { wall_loops: 5 } }
  const copy = { ...entry('copy', 80), instanceOf: 'source' }
  set({ plate: [src, copy], objectSettings: { source: { fill_density: '30%' } }, selection: 'source', selectedIds: ['source'] })
  copySelection()
  const kept = clipboard()
  history().clear()
  const before = get()
  const result = await call('duplicate', { object: 'copy', count: 2 })
  expect(result.output).toMatchObject({ requested: 2, created: 2 })
  expect(result.output.objects).toHaveLength(2)
  for (const row of result.output.objects) {
    expect(row.instanceOf).toBeUndefined()
    expect(row.settings).toEqual({ fill_density: '30%' })
    expect(row.partDetails[0]!.settings).toEqual({ wall_loops: 5 })
  }
  expect(new Set(get().plate.map((p) => p.id)).size).toBe(4)
  const a = get().plate[2]!, b = get().plate[3]!
  const x = bounds(a.parts, a.transform)!, y = bounds(b.parts, b.transform)!
  expect(x.max[0] <= y.min[0] || y.max[0] <= x.min[0] || x.max[1] <= y.min[1] || y.max[1] <= x.min[1]).toBe(true)
  expect(clipboard()).toBe(kept)
  expect(history().snapshots()).toHaveLength(1)
  history().undo()
  expect(get().plate).toBe(before.plate)
  expect(get().objectSettings).toBe(before.objectSettings)
  expect(get().selection).toBe('source')
})

it('removes only the named object, reparents copies across plates, removes dangling measurements and undoes all of it', async () => {
  const src = entry('source')
  src.partSettings = { [src.parts[0]!.name]: { wall_loops: 4 } }
  const copy = { ...entry('copy'), instanceOf: 'source' }
  const later = { ...entry('later'), instanceOf: 'source' }
  const other: PlateEntry = { ...entry('other'), dimensions: [{ id: 'measure', kind: 'length', a: { object: 'source', pick: { triangle: 0, at: [0, 0, 0] }, snapMm: 0, feature: { kind: 'edge', a: [0, 0, 0], b: [1, 0, 0] } } }] }
  set({ plate: [src, other], plates: [{ id: 'one', name: 'Plate 1', objects: [], settings: {} }, { id: 'two', name: 'Plate 2', objects: [copy, later], settings: {} }], objectSettings: { source: { wall_loops: 3 } } })
  history().clear()
  const before = get()
  const result = await call('remove_object', { object: 'source' })
  expect(result.output.removed).toEqual(['source'])
  expect(result.output.objects.map((r) => r.id)).toEqual(['other'])
  expect(get().plate[0]!.dimensions).toEqual([])
  expect(get().plates[1]!.objects[0]!.instanceOf).toBeUndefined()
  expect(get().plates[1]!.objects[1]!.instanceOf).toBe('copy')
  expect(get().plates[1]!.objects[0]!.partSettings).toEqual(src.partSettings)
  expect(get().objectSettings).toEqual({ copy: { wall_loops: 3 } })
  expect(get().selection).toBe('other')
  expect(history().snapshots()).toHaveLength(1)
  history().undo()
  expect(get().plate).toBe(before.plate)
  expect(get().plates).toBe(before.plates)
  expect(get().objectSettings).toBe(before.objectSettings)
})

it('lays a model face down with absolute orientation, retaining scale, footprint center and other copies', async () => {
  const src = entry('source')
  src.transform = compose({ position: [50, 60, 20], rotation: [10, 20, 30], scale: [2, 3, 4] })
  const other = entry('other')
  set({ plate: [src, other] })
  history().clear()
  const before = bounds(src.parts, src.transform)!
  const out = await call('lay_on_face', { object: 'source', normal: [1, 0, 0] })
  const placed = get().plate[0]!
  const after = bounds(placed.parts, placed.transform)!
  expect(after.min[2]).toBeCloseTo(0)
  expect(after.max[2] - after.min[2]).toBeCloseTo(20)
  for (const k of [0, 1]) expect(after.min[k]! + after.max[k]!).toBeCloseTo(before.min[k]! + before.max[k]!)
  expect(placed.transform[2]! / 2).toBeCloseTo(-1)
  expect(out.output.objects[0]!.id).toBe('source')
  expect(get().plate[1]).toBe(other)
  history().undo()
  expect(get().plate[0]).toBe(src)
})

it('refuses ambiguous names, invalid counts/normals, locked removal and edits during rollback', async () => {
  set({ plate: [{ ...entry('one'), name: 'same' }, { ...entry('two'), name: 'same' }] })
  await expect(call('rename', { object: 'same', name: 'name' })).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(call('duplicate', { object: 'one', count: 0 })).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(call('lay_on_face', { object: 'one', normal: [0, 0, 0] })).rejects.toMatchObject({ code: 'invalid_input' })
  set({ plate: [{ ...entry('one'), locked: true }] })
  await expect(call('remove_object', { object: 'one' })).rejects.toMatchObject({ code: 'refused' })
  set({ rollback: {} as never })
  await expect(call('rename', { object: 'one', name: 'new' })).rejects.toMatchObject({ code: 'busy' })
})

it('keeps surviving selection and refuses removal while a surviving copy has an open history edit', async () => {
  const src = entry('source'), other = entry('other')
  const copy = { ...entry('copy'), instanceOf: 'source' }
  set({ plate: [src, other, copy], selection: 'source', selectedIds: ['source', 'other'], historyEdit: { objectId: 'copy' } as never })
  await expect(call('remove_object', { object: 'source' })).rejects.toMatchObject({ code: 'busy' })
  expect(get().plate).toEqual([src, other, copy])
  set({ historyEdit: null })
  await call('remove_object', { object: 'source' })
  expect(get().selection).toBe('other')
  expect(get().selectedIds).toEqual(['other'])
})
