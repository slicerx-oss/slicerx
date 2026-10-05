// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { effectiveSlot, resolveSlots, slotOverridesFor, swapPlateSlots, usedSlots } from '../src/filament/slots'
import { createHistory } from '../src/plate/history'
import { renameObject, searchObjects, setPartSlot, togglePrintable } from '../src/plate/object-list'
import { appStore, get, set, type PlateEntry } from '../src/state/store'

const handle = (id: string, slots: number[]): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: slots.map((slot, i) => ({ name: `p${i}`, slot, triangles: 4 })) })
const entry = (id: string, slots = [1]): PlateEntry => ({ id, name: id, handle: handle(id, slots), parts: [], colors: [], transform: [] })

beforeEach(() => set({ plate: [entry('a', [1, 2]), entry('b')], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', selection: 'a', selectedIds: ['a'], slotSetup: {}, printerSlots: [] }))

describe('object list edits', () => {
  it('renames, trims, and ignores an empty or unchanged name', () => {
    expect(renameObject('a', '  Hook  ')).toBe(true)
    expect(get().plate[0]!.name).toBe('Hook')
    expect(renameObject('a', '   ')).toBe(false)
    expect(renameObject('a', 'Hook')).toBe(false)
    expect(renameObject('nope', 'x')).toBe(false)
    expect(renameObject('a', 'x'.repeat(300))).toBe(true)
    expect(get().plate[0]!.name).toHaveLength(100)
  })

  it('toggles printable for the selection in one undo step', () => {
    const h = createHistory(appStore)
    set({ selectedIds: ['a', 'b'] })
    expect(togglePrintable()).toBe(false)
    expect(get().plate.every((p) => p.printable === false)).toBe(true)
    expect(togglePrintable()).toBe(true)
    expect(get().plate.some((p) => 'printable' in p)).toBe(false)
    h.undo()
    expect(get().plate.every((p) => p.printable === false)).toBe(true)
    h.dispose()
    expect(togglePrintable(['missing'])).toBeNull()
  })

  it('a part goes to another filament, and the file slot drops the override', () => {
    setPartSlot('a', 'p1', 3)
    expect(get().plate[0]!.slotOverrides).toEqual({ p1: 3 })
    expect(effectiveSlot(get().plate[0]!, { name: 'p1', slot: 2 })).toBe(3)
    setPartSlot('a', 'p1', 2)
    expect(get().plate[0]!.slotOverrides).toBeUndefined()
    setPartSlot('a', 'p1', 99)
    expect(get().plate[0]!.slotOverrides).toBeUndefined()
  })

  it('slot overrides reach the request, combined with the plate swap, and slots grow to fit', () => {
    setPartSlot('a', 'p0', 4)
    expect(resolveSlots(get()).length).toBe(4)
    expect(slotOverridesFor(get().plates[0], get().plate[0]!)).toEqual({ p0: 4 })
    swapPlateSlots('plate-1', 4, 2)
    // p0 is on 4 by the override, the swap turns that into 2; p1 is on 2 and becomes 4.
    expect(slotOverridesFor(get().plates[0], get().plate[0]!)).toEqual({ p0: 2, p1: 4 })
  })

  it('an object that does not print does not count for the filaments used', () => {
    expect([...usedSlots(get())].sort()).toEqual([1, 2])
    set({ plate: [{ ...get().plate[0]!, printable: false }, get().plate[1]!] })
    expect([...usedSlots(get())]).toEqual([1])
  })
})

describe('object order and lock', () => {
  it('moves an object to a place, clamps the place, and steps back in one undo', async () => {
    const { moveObject } = await import('../src/plate/object-list')
    set({ plate: [entry('a'), entry('b'), entry('c')] })
    const h = createHistory(appStore)
    expect(moveObject('c', 0)).toBe(true)
    expect(get().plate.map((p) => p.id)).toEqual(['c', 'a', 'b'])
    expect(moveObject('c', 0)).toBe(false)
    expect(moveObject('c', 99)).toBe(true)
    expect(get().plate.map((p) => p.id)).toEqual(['a', 'b', 'c'])
    expect(moveObject('missing', 1)).toBe(false)
    h.undo()
    expect(get().plate.map((p) => p.id)).toEqual(['c', 'a', 'b'])
    h.dispose()
  })

  it('a locked object cannot be moved by the fields, a drag or arrange, and unlocks again', async () => {
    const { toggleLock } = await import('../src/plate/object-list')
    const { setTrs, commitTransforms, arrangePlate } = await import('../src/plate/edit')
    const at = (x: number, y: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]
    set({ plate: [{ ...entry('a'), transform: at(50, 50) }, { ...entry('b'), transform: at(50, 50) }], selection: 'a', selectedIds: ['a'] })
    expect(toggleLock(['a'])).toBe(true)
    expect(get().plate[0]!.locked).toBe(true)
    expect(setTrs({ position: [120, 120, 0] }, 'a')).toBe(false)
    commitTransforms({ a: at(200, 200), b: at(90, 90) })
    expect(get().plate[0]!.transform[12]).toBe(50)
    expect(get().plate[1]!.transform[12]).toBe(90)
    await arrangePlate('all')
    expect(get().plate[0]!.transform[12]).toBe(50)
    expect(toggleLock(['a'])).toBe(false)
    expect('locked' in get().plate[0]!).toBe(false)
    expect(setTrs({ position: [120, 120, 0] }, 'a')).toBe(true)
  })

  it('flags an object off the bed and a filament the printer does not have', async () => {
    const { objectWarnings } = await import('../src/plate/object-list')
    const { boxMesh } = await import('../src/plate/mesh-ops')
    const at = (x: number, y: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]
    const bed = { widthMm: 256, depthMm: 256, heightMm: 256 }
    const on: PlateEntry = { ...entry('a', [1, 3]), parts: [boxMesh(20, 20, 20)], transform: at(100, 100) }
    expect(objectWarnings(on, { bed, printerSlots: [] })).toEqual([])
    expect(objectWarnings(on, { bed, printerSlots: [{ id: 'A1' }, { id: 'A2' }] }).map((w) => w.kind)).toEqual(['filament'])
    expect(objectWarnings({ ...on, transform: at(250, 100) }, { bed, printerSlots: [] }).map((w) => w.kind)).toEqual(['off-bed'])
  })
})

describe('object search', () => {
  it('matches everything on an empty query', () => {
    expect(searchObjects(get().plate, '  ').map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('matches an object by name, case and word order aside, and shows all of its parts', () => {
    set({ plate: [{ ...entry('Wall hook', [1, 2]) }, entry('Spool holder')] })
    const m = searchObjects(get().plate, 'HOOK wall')
    expect(m).toEqual([{ id: 'Wall hook', self: true, parts: [0, 1], volumes: [] }])
  })

  it('keeps an object whose part matches and lists only that part', () => {
    const m = searchObjects(get().plate, 'p1')
    expect(m).toEqual([{ id: 'a', self: false, parts: [1], volumes: [] }])
  })

  it('looks at modifiers and volumes by name and by kind', () => {
    const vol = { id: 'v1', name: 'Hole 1', role: 'negative', handle: handle('v1', [1]), part: {} as never, local: [] }
    set({ plate: [{ ...entry('a'), volumes: [vol] as never }, entry('b')] })
    expect(searchObjects(get().plate, 'negative volume')).toEqual([{ id: 'a', self: false, parts: [], volumes: ['v1'] }])
    expect(searchObjects(get().plate, 'hole')).toEqual([{ id: 'a', self: false, parts: [], volumes: ['v1'] }])
    expect(searchObjects(get().plate, 'zzz')).toEqual([])
  })
})
