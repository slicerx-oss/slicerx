// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { beforeEach, expect, it, vi } from 'vitest'
import { mergeSelected, splitSelectedToObjects } from '../src/plate/edit'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { useObjectAsVolume } from '../src/plate/volumes'
import { get, set, type PlateEntry } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: [] })
const host = { loadParts: vi.fn(async (name: string, _parts: MeshPart[]) => handle(name)) }
const body = (id: string, exact: boolean): PlateEntry => ({
  id, name: id, handle: handle(id), parts: [boxMesh(10, 10, 10)], colors: ['#bd93f9'],
  transform: compose({ position: [id === 'a' ? 60 : 100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
  ...(exact ? { history: { version: 1 as const, exact: true, base: [], steps: [] } } : {}),
})

beforeEach(() => {
  host.loadParts.mockClear()
  set({ plate: [], selection: null, selectedIds: [], historyEdit: null })
})

async function unchanged(action: () => Promise<unknown>) {
  const before = get().plate
  const selected = get().selectedIds
  await expect(action()).rejects.toThrow(/exact/i)
  expect(get().plate).toBe(before)
  expect(get().selectedIds).toBe(selected)
  expect(host.loadParts).not.toHaveBeenCalled()
}

it('refuses splitting a required exact body into mesh-only objects', async () => {
  const exact = body('a', true)
  exact.parts.push(boxMesh(4, 4, 4))
  set({ plate: [exact], selection: 'a', selectedIds: ['a'] })
  await unchanged(() => splitSelectedToObjects(host))
})

it.each(['a', 'b'])('refuses a mesh merge when exact body %s is selected', async exactId => {
  set({ plate: [body('a', exactId === 'a'), body('b', exactId === 'b')], selection: 'a', selectedIds: ['a', 'b'] })
  await unchanged(() => mergeSelected(host))
})

it('refuses consuming an exact body as a mesh-only modifier', async () => {
  set({ plate: [body('a', false), body('b', true)], selection: 'a', selectedIds: ['a'] })
  await unchanged(() => useObjectAsVolume(host, 'modifier', 'b', 'a'))
})
