// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A modeling job reads an object, waits on the engine, then writes. What the person did meanwhile stays: a move or a
// recolor during the wait is kept, and an object deleted meanwhile takes nothing, nor do others get duplicated.
import { afterEach, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { IDENTITY, type HistoryMesh } from '../src/cad/history/model'
import { clearReplayCache } from '../src/cad/history/replay'
import { applyHistory } from '../src/cad/history/ops'
import { setGeomProvider } from '../src/geom/client'
import { cutSelected, repairSelected } from '../src/plate/geom-ops'
import { get, set, type PlateEntry } from '../src/state/store'

const mesh = (): HistoryMesh => ({ name: 'body', slot: 1, positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10], indices: [0, 1, 2, 0, 2, 3, 0, 1, 4] })
const part = (): MeshPart => ({ name: 'body', slot: 1, positions: new Float32Array(mesh().positions), indices: new Uint32Array(mesh().indices) })
const handle: MeshHandle = { id: 'h', name: 'body', hash: 'h', triangles: 3, bboxMm: [10, 10, 10], openEdges: 0, parts: [] }
const entry = (id: string): PlateEntry => ({ id, name: id, parts: [part()], handle, colors: ['#ffffff'], transform: [...IDENTITY] })
const moved = () => {
  const t = [...IDENTITY]
  t[12] = 50
  return t
}

/** A loader whose loadParts waits until `finish` is called, with `atLoad` resolving when the job reaches it. */
function gate() {
  let ready!: () => void
  let finish!: () => void
  const atLoad = new Promise<void>((r) => (ready = r))
  const loaded = new Promise<void>((r) => (finish = r))
  const host = {
    loadParts: async () => {
      ready()
      await loaded
      return handle
    },
  }
  return { host, atLoad, finish }
}

afterEach(() => {
  setGeomProvider(null)
  clearReplayCache()
  set({ plate: [], historyEdit: null, selection: null, selectedIds: [] })
})

it('a history replay that lands late keeps a newer move and recolor', async () => {
  setGeomProvider({ call: async <T>(_op: string, req: unknown) => ({ mesh: (req as { mesh: unknown }).mesh }) as T })
  const original = entry('body')
  set({ plate: [original] })
  const g = gate()
  const task = applyHistory(g.host, original.id, { version: 1, base: [mesh()], steps: [] })
  await g.atLoad
  set({ plate: [{ ...original, transform: moved(), colors: ['#123456'], name: 'Renamed' }] })
  g.finish()
  await task
  const now = get().plate[0]!
  expect(now.transform[12]).toBe(50)
  expect(now.colors).toEqual(['#123456'])
  expect(now.name).toBe('Renamed')
  expect(now.history?.base).toHaveLength(1)
})

it('a history replay for an object deleted meanwhile writes nothing', async () => {
  setGeomProvider({ call: async <T>(_op: string, req: unknown) => ({ mesh: (req as { mesh: unknown }).mesh }) as T })
  const a = entry('a')
  const b = entry('b')
  set({ plate: [a, b] })
  const g = gate()
  const task = applyHistory(g.host, a.id, { version: 1, base: [mesh()], steps: [] })
  await g.atLoad
  set({ plate: [b] })
  g.finish()
  await expect(task).rejects.toThrow()
  expect(get().plate.map((p) => p.id)).toEqual(['b'])
})

it('a repair that lands late keeps a newer move', async () => {
  setGeomProvider({ call: async <T>(_op: string, req: unknown) => ({ mesh: (req as { mesh: unknown }).mesh, report: {} }) as T })
  const original = entry('body')
  set({ plate: [original], selection: original.id, selectedIds: [original.id] })
  const g = gate()
  const task = repairSelected(g.host)
  await g.atLoad
  set({ plate: [{ ...original, transform: moved() }] })
  g.finish()
  await task
  expect(get().plate[0]!.transform[12]).toBe(50)
})

it('a cut of an object deleted meanwhile changes nothing and duplicates nothing', async () => {
  const half = (z: number) => ({ positions: [0, 0, z, 10, 0, z, 0, 10, z], indices: [0, 1, 2] })
  setGeomProvider({ call: async <T>() => ({ below: half(0), above: half(5) }) as T })
  const a = entry('a')
  const b = entry('b')
  const c = entry('c')
  set({ plate: [a, b, c], selection: a.id, selectedIds: [a.id] })
  const g = gate()
  const task = cutSelected(g.host, { axis: 'z', atMm: 5, keep: 'both' })
  await g.atLoad
  set({ plate: [b, c] })
  g.finish()
  expect(await task).toBe(0)
  expect(get().plate.map((p) => p.id)).toEqual(['b', 'c'])
})

it('a cut of an object moved meanwhile changes nothing', async () => {
  const half = (z: number) => ({ positions: [0, 0, z, 10, 0, z, 0, 10, z], indices: [0, 1, 2] })
  setGeomProvider({ call: async <T>() => ({ below: half(0), above: half(5) }) as T })
  const a = entry('a')
  set({ plate: [a], selection: a.id, selectedIds: [a.id] })
  const g = gate()
  const task = cutSelected(g.host, { axis: 'z', atMm: 5, keep: 'both' })
  await g.atLoad
  set({ plate: [{ ...a, transform: moved() }] })
  g.finish()
  expect(await task).toBe(0)
  expect(get().plate.map((p) => [p.id, p.transform[12]])).toEqual([['a', 50]])
})
