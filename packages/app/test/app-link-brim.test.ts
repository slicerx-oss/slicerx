// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { runCall } from '../src/app-link/methods'
import { readBrim } from '../src/app-link/brim'
import { history } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { selectedEars, selectEars } from '../src/plate/brim-ears'
import { toolStore } from '../src/plate/tools'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const entry = (id: string, x = 50): PlateEntry => ({
  id, name: 'Box', handle: { id, hash: id, name: id, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: [] } as MeshHandle,
  parts: [{ ...boxMesh(10, 10, 10), name: 'Body', slot: 1 }], colors: ['#fff'],
  transform: compose({ position: [x, 60, 5], rotation: [0, 0, 0], scale: [1, 1, 1] }),
})
const read = () => readBrim({ object: 'body' }).output
const edit = (args: Record<string, unknown>) => runCall('brim.edit', { object: 'body', revision: read().revision, ...args }, { id: 'client', name: 'Test client' })

beforeEach(() => {
  set({ plate: [entry('body')], plates: [{ id: 'shown', name: 'Shown', objects: [], settings: {} }], activePlate: 'shown', selection: 'body', selectedIds: ['body'], objectSettings: {}, overrides: { brim_type: 'painted' }, plateLoading: false, rollback: null, historyEdit: null, liveEdit: false, objectTool: null, dragging: false, slice: { status: 'idle' } })
  toolStore.setState({ tool: 'move' })
  history().clear()
})

it('edits ears by explicit index, reads actual local and bed coordinates, and uses toolbar Undo', async () => {
  const initial = read().objects[0]!
  expect(initial).toMatchObject({ enabled: true, ears: [] })
  await edit({ action: 'add', x_mm: 56, y_mm: 60, diameter_mm: 10 })
  await edit({ action: 'add', x_mm: 90, y_mm: 60, diameter_mm: 6 })
  expect(read().objects[0]!.ears).toEqual([
    { index: 0, localMm: [6, 0, -5.0001], bedMm: [56, 60, expect.closeTo(-0.0001, 6)], diameterMm: 10, connected: true },
    { index: 1, localMm: [40, 0, -5.0001], bedMm: [90, 60, expect.closeTo(-0.0001, 6)], diameterMm: 6, connected: false },
  ])
  selectEars('body', [0])
  await edit({ action: 'move', indices: [1], x_mm: 61, y_mm: 60 })
  expect(read().objects[0]!.ears[1]).toMatchObject({ connected: true, localMm: [11, 0, -5.0001] })
  await edit({ action: 'resize', indices: [1], diameter_mm: 12.14 })
  expect(read().objects[0]!.ears[1]!.diameterMm).toBe(12.1)
  expect(selectedEars('body')).toEqual([0])
  const before = read().objects
  await edit({ action: 'remove', indices: [0] })
  expect(read().objects[0]!.ears).toHaveLength(1)
  expect(history().undo()).toBe(true)
  expect(read().objects).toEqual(before)
  await edit({ action: 'clear' })
  expect(read().objects[0]!.ears).toEqual([])
  await edit({ action: 'generate', diameter_mm: 10 })
  expect(read().objects[0]!.ears).toHaveLength(4)
  expect(read().objects[0]!.ears.every((e) => e.connected)).toBe(true)
  const revision = read().revision
  expect(await edit({ action: 'generate', diameter_mm: 10 })).toMatchObject({ output: { changed: false, added: 0, revision } })
  expect(read().revision).toBe(revision)
})

it('refuses stale indices, invalid calls and ambiguous names without partial edits', async () => {
  const stale = read().revision
  await edit({ action: 'add', x_mm: 56, y_mm: 60, diameter_mm: 10 })
  const before = get().plate
  await expect(edit({ action: 'remove', indices: [0], revision: stale })).rejects.toMatchObject({ code: 'busy' })
  for (const args of [
    { action: 'remove', indices: [0, 5] }, { action: 'move', indices: [0, 1], x_mm: 0, y_mm: 0 },
    { action: 'add', x_mm: NaN, y_mm: 0 }, { action: 'resize', indices: [0], diameter_mm: 21 },
    { action: 'clear', x_mm: 1 }, { action: 'generate', detection_mm: read().objects[0]!.detectionMaxMm + 1 },
  ]) await expect(edit(args)).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get().plate).toBe(before)
  set({ plate: [...before, entry('other')] })
  await expect(edit({ action: 'clear', object: 'Box' })).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(edit({ action: 'clear', object: 'missing' })).rejects.toMatchObject({ code: 'not_found' })
})

it('keeps no-op edits out of history and reports disabled painted brim without changing it', async () => {
  set({ overrides: { brim_type: 'no_brim' } })
  await edit({ action: 'add', x_mm: 56, y_mm: 60, diameter_mm: 10 })
  const before = get().plate
  const revision = read().revision
  for (const args of [{ action: 'add', x_mm: 56, y_mm: 60 }, { action: 'move', indices: [0], x_mm: 56, y_mm: 60 }, { action: 'resize', indices: [0], diameter_mm: 10 }]) expect(await edit(args)).toMatchObject({ output: { changed: false, revision } })
  expect(get().plate).toBe(before)
  expect(read().objects[0]).toMatchObject({ enabled: false, brimType: 'no_brim' })
})

it('updates a linked family across plates in one Undo step and respects a locked remote copy', async () => {
  const copy = { ...entry('copy', 100), instanceOf: 'body' }
  set({ plates: [...get().plates, { id: 'other', name: 'Other', objects: [copy], settings: {} }] })
  history().clear()
  await edit({ action: 'add', x_mm: 56, y_mm: 60 })
  expect(get().plates[1]!.objects[0]!.brimPoints).toEqual(get().plate[0]!.brimPoints)
  expect(read().objects[0]!.linked).toEqual([{ plate: 'shown', id: 'body' }, { plate: 'other', id: 'copy' }])
  expect(history().state().undo).toBe(1)
  history().undo()
  expect(get().plates[1]!.objects[0]!.brimPoints).toBeUndefined()
  set({ plates: [get().plates[0]!, { ...get().plates[1]!, objects: [{ ...copy, locked: true }] }] })
  await expect(edit({ action: 'add', x_mm: 56, y_mm: 60 })).rejects.toMatchObject({ code: 'refused' })
})

it('leaves an active viewport brim gesture alone', async () => {
  toolStore.setState({ tool: 'brim' })
  await expect(edit({ action: 'add', x_mm: 56, y_mm: 60 })).rejects.toMatchObject({ code: 'busy' })
  expect(read().objects[0]!.ears).toEqual([])
  expect(history().canUndo()).toBe(false)
})
