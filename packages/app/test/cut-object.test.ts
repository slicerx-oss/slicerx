// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { IDENTITY } from '@slicerx/cad-history'
import { setGeomProvider } from '../src/geom/client'
import { cutObject, cutSelected } from '../src/plate/geom-ops'
import type { CutSpec } from '../src/plate/cut-object'
import { history } from '../src/plate/history'
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

it.each(['changed', 'removed'])('refuses a nonintersecting result when the target was %s during geometry work', async (state) => {
  const original = get().plate[0]!
  const changed = state === 'removed' ? [] : [{ ...original, parts: [...original.parts] }]
  const loadParts = vi.fn(async () => handle)
  setGeomProvider({ call: async <T>() => {
    set({ plate: changed })
    return { below: box([0,0,0], [20,20,20]), report: { warnings: [], connectors: [] } } as T
  } })
  await expect(cutObject({ loadParts }, 'cube', { ...spec, atMm: 30 })).rejects.toMatchObject({ code: 'busy' })
  expect(get().plate).toBe(changed)
  expect(loadParts).not.toHaveBeenCalled()
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

it('moves modifiers and brim points into each piece frame and clips height ranges', async () => {
  const src = get().plate[0]!
  const local = [...IDENTITY]
  local[12] = 5; local[13] = 6; local[14] = 9
  set({ plate: [{ ...src, volumes: [{ id: 'blocker', name: 'Blocker', role: 'support_blocker', handle, part: src.parts[0]!, local }], brimPoints: [[5,6,0,2]], layerRanges: [{ minZ: 6, maxZ: 12, settings: { wall_loops: 5 } }] }] })
  await cutSelected(host, spec)
  const [lower, upper] = get().plate
  expect(lower!.volumes?.[0]?.local.slice(12,15)).toEqual([-5,-4,9])
  expect(upper!.volumes?.[0]?.local.slice(12,15)).toEqual([-5,-4,9])
  expect(lower!.volumes?.[0]?.id).not.toBe(upper!.volumes?.[0]?.id)
  expect(lower!.brimPoints).toEqual([[-5,-4,0,2]])
  expect(upper!.brimPoints ?? []).toEqual([])
  expect(lower!.layerRanges).toEqual([{ minZ: 6, maxZ: 8, settings: { wall_loops: 5 } }])
  expect(upper!.layerRanges).toEqual([{ minZ: 0, maxZ: 4, settings: { wall_loops: 5 } }])
})

it('returns actual connector reports and reports cleared paint and affected measurements', async () => {
  const src = get().plate[0]!
  const anchor = { object: 'cube', pick: { triangle: 0, at: [0,0,0] as [number,number,number] }, snapMm: 0, feature: { kind: 'point' as const, at: [0,0,0] as [number,number,number] } }
  const other = { ...entry('other'), dimensions: [{ id: 'across', kind: 'distance' as const, a: anchor, b: { ...anchor, object: 'other' } }] }
  set({ plate: [{ ...src, paint: { 0: { color: { 0: '2' } } } }, other] })
  const report = { connectors: [[4,4,8]], warnings: ['One connector did not fit.'], sectionAreaMm2: 400, seamLengthMm: 80, islands: 1, belowVolumeMm3: 3200, aboveVolumeMm3: 4800, belowEdges: {}, aboveEdges: {} }
  setGeomProvider({ call: async <T>() => ({ below: box([0,0,0], [20,20,8]), above: box([0,0,8], [20,20,20]), report }) as T })
  const result = await cutObject(host, 'cube', spec)
  expect(result).toMatchObject({ changed: true, removed: 'cube', reports: [{ part: 0, report }] })
  expect(result.warnings).toContain('One connector did not fit.')
  expect(result.warnings.some((s) => s.includes('paint'))).toBe(true)
  expect(result.warnings.some((s) => s.includes('measurement'))).toBe(true)
  expect(get().plate.find((e) => e.id === 'other')?.dimensions ?? []).toEqual([])
  expect(get().plate.filter((e) => e.id !== 'other').every((e) => !e.paint)).toBe(true)
})

it('cuts the named object when another object becomes selected during the operation', async () => {
  const original = get().plate[0]!
  const other = entry('other')
  set({ plate: [original, other] })
  const loader = { loadParts: async () => { set({ selection: 'other', selectedIds: ['other'] }); return handle } }
  const result = await cutObject(loader, 'cube', spec)
  expect(result.removed).toBe('cube')
  expect(get().plate.find((e) => e.id === 'other')).toBe(other)
})

it('restores the full original object and print settings with one toolbar Undo', async () => {
  const original = get().plate[0]!
  const settings = get().objectSettings
  const undo = history()
  undo.clear()
  await cutObject(host, 'cube', spec)
  expect(undo.undo()).toBe(true)
  expect(get().plate).toEqual([original])
  expect(get().objectSettings).toEqual(settings)
  expect(undo.canUndo()).toBe(false)
})

it.each([
  { plane: { point: [0,0,0], normal: [0,0,0] } },
  { atMm: Infinity },
  { keep: 'nothing' },
  { connector: { kind: 'pin', diameterMm: 0, depthMm: 6, toleranceMm: 0.2 } },
  { connector: { kind: 'dowel', diameterMm: 5, depthMm: 6, toleranceMm: -1 } },
  { connector: { kind: 'pin', diameterMm: 5, depthMm: 6, toleranceMm: 0.2, count: 0 } },
  { connector: { kind: 'pin', diameterMm: 5, depthMm: 6, toleranceMm: 0.2, positions: [[NaN,0,8]] } },
  { connector: { kind: 'dovetail', diameterMm: 5, depthMm: 6, toleranceMm: 0.2, positions: [[0,0,8]] } },
])('refuses invalid cut input before invoking geometry: %j', async (patch) => {
  const call = vi.fn()
  setGeomProvider({ call })
  const plate = get().plate
  await expect(cutObject(host, 'cube', { ...spec, ...patch } as CutSpec)).rejects.toMatchObject({ code: 'invalid_input' })
  expect(call).not.toHaveBeenCalled()
  expect(get().plate).toBe(plate)
})

it('preserves copies on another plate and restores their measurements with one Undo', async () => {
  const source = get().plate[0]!
  const anchor = (object: string) => ({ object, pick: { triangle: 0, at: [0,0,0] as [number,number,number] }, snapMm: 0, feature: { kind: 'point' as const, at: [0,0,0] as [number,number,number] } })
  const retained = { id: 'local', kind: 'distance' as const, a: anchor('copy-a'), b: anchor('copy-b') }
  const removed = { id: 'source', kind: 'distance' as const, a: anchor('cube'), b: anchor('copy-a') }
  const copyA = { ...source, id: 'copy-a', instanceOf: 'cube', dimensions: [retained, removed] }
  const copyB = { ...source, id: 'copy-b', instanceOf: 'cube' }
  const plates = [{ id: 'other-plate', name: 'Other plate', objects: [copyA,copyB], settings: { sequence: 'by-layer' as const } }]
  set({ plates })
  const settings = get().objectSettings
  const undo = history()
  undo.clear()
  const result = await cutObject(host, 'cube', spec)
  const [a,b] = get().plates[0]!.objects
  expect(a!.instanceOf).toBeUndefined()
  expect(b!.instanceOf).toBe(a!.id)
  expect(a!.parts).toBe(source.parts)
  expect(a!.partSettings).toEqual(source.partSettings)
  expect(get().objectSettings[a!.id]).toEqual(settings['cube'])
  expect(a!.dimensions).toEqual([retained])
  expect(result.warnings.some((message) => message.includes('1 measurement'))).toBe(true)
  expect(undo.undo()).toBe(true)
  expect(get().plate).toEqual([source])
  expect(get().plates).toEqual(plates)
  expect(get().objectSettings).toEqual(settings)
  expect(undo.canUndo()).toBe(false)
})

it('leaves geometry and metadata untouched when loading a cut piece fails', async () => {
  const before = get()
  const undo = history()
  undo.clear()
  await expect(cutObject({ loadParts: async () => { throw new Error('Cannot load mesh') } }, 'cube', spec)).rejects.toThrow('Cannot load mesh')
  expect(get().plate).toBe(before.plate)
  expect(get().plates).toBe(before.plates)
  expect(get().objectSettings).toBe(before.objectSettings)
  expect(undo.canUndo()).toBe(false)
})
