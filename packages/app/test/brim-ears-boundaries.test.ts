// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { addEar, resizeSelectedEars, selectEars } from '../src/plate/brim-ears'
import { history } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const entry = (id: string, x = 50): PlateEntry => ({
  id, name: id,
  handle: { id, hash: id, name: id, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: [] } as MeshHandle,
  parts: [{ ...boxMesh(10, 10, 10), name: 'Body', slot: 1 }], colors: ['#fff'],
  transform: compose({ position: [x, 60, 5], rotation: [0, 0, 0], scale: [1, 1, 1] }),
})

beforeEach(() => {
  set({ plate: [entry('body')], plates: [{ id: 'shown', name: 'Shown', objects: [], settings: {} }], activePlate: 'shown', selection: 'body', selectedIds: ['body'], objectSettings: {}, plateLoading: false, rollback: null, historyEdit: null })
  history().clear()
})

it('updates linked ears across plates and restores the whole family with one Undo', () => {
  const source = entry('source')
  const copy = { ...entry('copy', 100), instanceOf: source.id }
  const unrelated = entry('other', 150)
  set({ plate: [copy], plates: [get().plates[0]!, { id: 'other-plate', name: 'Other', objects: [source, unrelated], settings: {} }] })
  history().clear()
  expect(addEar('copy', 108, 60, 10)).toBe(true)
  const points = get().plate[0]!.brimPoints
  expect(points).toHaveLength(1)
  expect(get().plates[1]!.objects[0]!.brimPoints).toEqual(points)
  expect(get().plates[1]!.objects[1]).toBe(unrelated)
  expect(history().state().undo).toBe(1)
  expect(history().undo()).toBe(true)
  expect(get().plate[0]!.brimPoints).toBeUndefined()
  expect(get().plates[1]!.objects[0]!.brimPoints).toBeUndefined()
})

it.each([[NaN, 60, 10], [50, Infinity, 10], [50, 60, NaN]])('refuses nonfinite ear values without changing state or history: %j', (x, y, diameter) => {
  const before = get().plate
  expect(addEar('body', x, y, diameter)).toBe(false)
  expect(get().plate).toBe(before)
  expect(history().canUndo()).toBe(false)
})

it('keeps an unchanged ear size out of toolbar history', () => {
  expect(addEar('body', 56, 60, 10)).toBe(true)
  selectEars('body', [0])
  history().clear()
  const before = get().plate
  expect(resizeSelectedEars('body', 10)).toBe(false)
  expect(get().plate).toBe(before)
  expect(history().canUndo()).toBe(false)
})
