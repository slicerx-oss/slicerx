// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { IDENTITY } from '@slicerx/cad-history'
import { setGeomProvider } from '../src/geom/client'
import { cutSelected } from '../src/plate/geom-ops'
import { get, set, type PlateEntry } from '../src/state/store'

function box(min: number[], max: number[]) {
  const [x, y, z] = min as [number, number, number]
  const [a, b, c] = max as [number, number, number]
  return {
    positions: [x,y,z,a,y,z,a,b,z,x,b,z,x,y,c,a,y,c,a,b,c,x,b,c],
    indices: [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7],
  }
}
const handle: MeshHandle = { id: 'cube', name: 'cube', hash: 'cube', triangles: 12, bboxMm: [20,20,20], openEdges: 0, parts: [] }
const host = { loadParts: async () => handle }
const spec = { axis: 'z' as const, atMm: 8, keep: 'both' as const }
function entry(id = 'cube'): PlateEntry {
  const mesh = box([0,0,0], [20,20,20])
  const part: MeshPart = { name: 'body', slot: 1, positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices) }
  return { id, name: id, handle, parts: [part], colors: ['#ffffff'], transform: [...IDENTITY], printable: false, slotOverrides: { body: 3 }, partSettings: { body: { wall_loops: 4 } } }
}
beforeEach(() => {
  setGeomProvider({ call: async <T>() => ({ below: box([0,0,0], [20,20,8]), above: box([0,0,8], [20,20,20]), report: { warnings: [], connectors: [] } }) as T })
  set({ plate: [entry()], plates: [], activePlate: 'plate', objectSettings: { cube: { sparse_infill_density: '27%' } }, selection: 'cube', selectedIds: ['cube'], historyEdit: null, rollback: null })
})
afterEach(() => setGeomProvider(null))

it('keeps print inclusion and effective object and part settings on both cut pieces', async () => {
  expect(await cutSelected(host, spec)).toBe(2)
  for (const piece of get().plate) {
    expect(piece.printable).toBe(false)
    expect(piece.slotOverrides).toEqual({ body: 3 })
    expect(piece.partSettings).toEqual({ body: { wall_loops: 4 } })
    expect(get().objectSettings[piece.id]).toEqual({ sparse_infill_density: '27%' })
  }
  expect(get().objectSettings['cube']).toBeUndefined()
})

it('refuses a stale cut when the geometry changes without moving the object', async () => {
  const original = get().plate[0]!
  const changed = { ...original, parts: [...original.parts] }
  const delayed = { loadParts: async () => { set({ plate: [changed] }); return handle } }
  await expect(cutSelected(delayed, spec)).rejects.toThrow(/changed/)
  expect(get().plate).toEqual([changed])
})

it('refuses a stale cut when print settings change while loading its pieces', async () => {
  const original = get().plate[0]!
  const delayed = { loadParts: async () => { set({ objectSettings: { cube: { wall_loops: 9 } } }); return handle } }
  await expect(cutSelected(delayed, spec)).rejects.toThrow(/changed/)
  expect(get().plate).toEqual([original])
  expect(get().objectSettings).toEqual({ cube: { wall_loops: 9 } })
})

it('keeps surviving copies attached to their original geometry and settings', async () => {
  const source = get().plate[0]!
  const copy = { ...source, id: 'copy', instanceOf: source.id }
  set({ plate: [source, copy] })
  expect(await cutSelected(host, spec)).toBe(2)
  const survivor = get().plate.find((e) => e.id === copy.id)!
  expect(survivor.instanceOf).toBeUndefined()
  expect(survivor.parts).toBe(source.parts)
  expect(survivor.partSettings).toEqual(source.partSettings)
  expect(get().objectSettings[survivor.id]).toEqual({ sparse_infill_density: '27%' })
})
