// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { readVolumes, volumeAction } from '../src/app-link/volumes'
import { APP_LINK_METHODS, runCall } from '../src/app-link/methods'
import { history } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { bounds, compose, multiply } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const loader = {
  loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({
    id: name, hash: name, name, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0,
    parts: parts.map((p) => ({ name: p.name, slot: 1, triangles: 12 })),
  }),
}

beforeEach(async () => {
  const part = boxMesh(30, 20, 10)
  const handle = await loader.loadParts('body', [part])
  const entry: PlateEntry = { id: 'body', name: 'Body', parts: [part], handle, colors: ['#ff0000'], transform: compose({ position: [50, 60, 10], rotation: [0, 0, 30], scale: [2, 1, 0.5] }) }
  set({ plate: [entry], activePlate: 'shown', plates: [{ id: 'shown', name: 'Shown', objects: [], settings: {} }], selection: 'body', selectedIds: ['body'], objectSettings: {}, rollback: null, historyEdit: null, dragging: false, liveEdit: false, plateLoading: false })
  history().clear()
})

it('reads local dimensions and world placement beneath a rotated, scaled object without changing history', async () => {
  const part = boxMesh(4, 6, 8)
  const volume = { id: 'region', name: 'Region', role: 'modifier' as const, part, handle: await loader.loadParts('region', [part]), local: compose({ position: [1, 2, 3], rotation: [0, 0, 90], scale: [1, 2, 0.5] }), settings: { wall_loops: 5 } }
  set({ plate: get().plate.map((p) => ({ ...p, volumes: [volume] })) })
  history().clear()
  const before = get().plate
  const result = readVolumes({ object: 'Body' })
  expect(result.object).toEqual({ id: 'body', name: 'Body' })
  expect(result.plate).toBe('shown')
  expect(result.volumes).toHaveLength(1)
  const read = result.volumes[0]!
  expect(read).toMatchObject({ id: 'region', role: 'modifier', triangles: 12, settings: { wall_loops: 5 } })
  read.positionMm.forEach((n, i) => expect(n).toBeCloseTo([1, 2, 3][i]!))
  read.sizeMm.forEach((n, i) => expect(n).toBeCloseTo([4, 12, 4][i]!))
  expect(read.world).toEqual(multiply(before[0]!.transform, volume.local))
  expect(read.boundsMm).toEqual(bounds([part], read.world))
  expect(get().plate).toBe(before)
  expect(history().canUndo()).toBe(false)
})

it('reads an empty volume list and refuses missing or ambiguous objects and unrelated fields', () => {
  expect(readVolumes({ object: 'body' }).volumes).toEqual([])
  expect(() => readVolumes({ object: 'gone' })).toThrow(/shown plate/)
  expect(() => readVolumes({ object: 'body', printer: 'other' })).toThrow()
  set({ plate: [...get().plate, { ...get().plate[0]!, id: 'other' }] })
  expect(() => readVolumes({ object: 'Body' })).toThrow(/More than one/)
  expect(readVolumes({ object: 'body' }).object.id).toBe('body')
})

const call = (action: Parameters<typeof volumeAction>[0], args: Record<string, unknown>) => volumeAction(action, { object: 'body', ...args }, 'Test client', loader)

it('creates and patches a modifier, reads the app method, and restores each change with one Undo', async () => {
  expect(APP_LINK_METHODS['volumes.list']).toBe('read')
  for (const name of ['add', 'from_object', 'set', 'copy', 'remove']) expect(APP_LINK_METHODS[`volumes.${name}`]).toBe('edit')
  const added = await call('add', { role: 'modifier', shape: 'cone', sizeMm: [8, 10, 12], positionMm: [1, 2, 3], settings: { wall_loops: 4 } })
  const id = added.changed![0]!
  expect(added.volumes[0]).toMatchObject({ id, role: 'modifier', settings: { wall_loops: 4 } })
  added.volumes[0]!.sizeMm.forEach((n, i) => expect(n).toBeCloseTo([8, 10, 12][i]!))
  expect(history().snapshots()).toHaveLength(1)
  expect(await runCall('volumes.list', { object: 'body' })).toEqual({ ...added, changed: undefined })
  const changed = await call('set', { volume: id, positionMm: [4, 5, 6], rotationDeg: [0, 0, 45], set: { wall_loops: 6 } })
  expect(changed.volumes[0]).toMatchObject({ positionMm: [4, 5, 6], settings: { wall_loops: 6 } })
  expect(history().snapshots()).toHaveLength(2)
  history().undo()
  expect(readVolumes({ object: 'body' }).volumes[0]).toMatchObject({ positionMm: [1, 2, 3], settings: { wall_loops: 4 } })
  history().redo()
  const role = await call('set', { volume: id, role: 'support_enforcer' })
  expect(role.volumes[0]).toMatchObject({ role: 'support_enforcer', settings: {} })
  const removed = await call('remove', { volume: id })
  expect(removed).toMatchObject({ removed: [id], volumes: [] })
  history().undo()
  expect(readVolumes({ object: 'body' }).volumes[0]?.id).toBe(id)
})

it('validates the whole patch, rejects nonfinite resulting placement, and keeps no-op edits out of history', async () => {
  const added = await call('add', { role: 'modifier', shape: 'box', settings: { wall_loops: 4 } })
  const id = added.changed![0]!
  history().clear()
  const before = get().plate
  for (const patch of [
    { positionMm: [4, 5, 6], set: { wall_loops: -2 } },
    { set: { wall_loops: 5, print_host: 'other' } },
    { clear: ['machine_start_gcode'] },
    { sizeMm: [1e308, 1e308, 1e308] },
    { sizeMm: [1e-20, 1, 1] },
    { role: 'negative', set: { wall_loops: 5 } },
  ]) {
    await expect(call('set', { volume: id, ...patch })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(get().plate).toBe(before)
    expect(history().canUndo()).toBe(false)
  }
  const same = await call('set', { volume: id, set: { wall_loops: 4 } })
  expect(same.changed).toBeUndefined()
  expect(get().plate).toBe(before)
  expect(history().canUndo()).toBe(false)
  const position = added.volumes[0]!.positionMm
  const rounded = await call('set', { volume: id, positionMm: [position[0]! + 1e-7, position[1], position[2]] })
  expect(rounded.changed).toBeUndefined()
  expect(get().plate).toBe(before)
  expect(history().canUndo()).toBe(false)
  await call('set', { volume: id, clear: ['wall_loops'] })
  expect(readVolumes({ object: 'body' }).volumes[0]?.settings).toEqual({})
})

it('copies volumes directly into another object and consumes an object as a volume with read-back', async () => {
  const source = { ...get().plate[0]!, id: 'source', name: 'Source', transform: compose({ position: [10, 20, 5], rotation: [0, 0, 10], scale: [1, 2, 1] }) }
  set({ plate: [...get().plate, source] })
  const added = await call('add', { role: 'negative', shape: 'sphere' })
  const copied = await call('copy', { volume: added.changed![0], target: 'source' })
  expect(copied.object.id).toBe('source')
  expect(copied.changed).toHaveLength(1)
  expect(copied.volumes[0]?.role).toBe('negative')
  expect(readVolumes({ object: 'body' }).volumes).toHaveLength(1)
  history().clear()
  const converted = await call('fromObject', { source: 'source', role: 'support_blocker' })
  expect(converted.consumedObject).toBe('source')
  expect(converted.volumes).toHaveLength(2)
  const actual = converted.volumes.find((v) => v.id === converted.changed![0])!.boundsMm!
  const expected = bounds(source.parts, source.transform)!
  for (let i = 0; i < 3; i++) {
    expect(actual.min[i]).toBeCloseTo(expected.min[i]!, 3)
    expect(actual.max[i]).toBeCloseTo(expected.max[i]!, 3)
  }
  expect(get().plate).toHaveLength(1)
  expect(history().snapshots()).toHaveLength(1)
  history().undo()
  expect(get().plate).toHaveLength(2)
  expect(readVolumes({ object: 'source' }).volumes).toHaveLength(1)
})

it('refuses locked, busy or changed targets without inserting a volume', async () => {
  set({ plate: get().plate.map((p) => ({ ...p, locked: true })) })
  await expect(call('add', { role: 'negative', shape: 'cylinder' })).rejects.toMatchObject({ code: 'refused' })
  set({ plate: get().plate.map((p) => ({ ...p, locked: false })), liveEdit: true })
  await expect(call('add', { role: 'negative', shape: 'cylinder' })).rejects.toMatchObject({ code: 'busy' })
  set({ liveEdit: false })
  const delayed = { loadParts: async (name: string, parts: MeshPart[]) => {
    set({ plate: get().plate.map((p) => ({ ...p, name: 'Changed' })) })
    return loader.loadParts(name, parts)
  } }
  await expect(volumeAction('add', { object: 'body', role: 'negative', shape: 'cylinder' }, 'Test client', delayed)).rejects.toMatchObject({ code: 'busy' })
  expect(get().plate[0]?.volumes).toBeUndefined()
})

it('validates a copied volume in the destination frame before changing either object', async () => {
  const added = await call('add', { role: 'negative', shape: 'box' })
  const target = { ...get().plate[0]!, id: 'target', name: 'Target', volumes: [], transform: compose({ position: [1e100, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
  set({ plate: [...get().plate, target] })
  history().clear()
  const before = get().plate
  await expect(call('copy', { volume: added.changed![0], target: 'target' })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get().plate).toBe(before)
  expect(history().canUndo()).toBe(false)
})
