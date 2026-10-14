// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Filament pick F1: which spool a part with no filament of its own starts on, what a click on a spool moves, the
// move itself after the plate's color swaps, the words under the spools, and the agent bridge's read and move.
import { beforeEach, describe, expect, it } from 'vitest'
import type { FilamentSlot, MeshHandle } from '@slicerx/contracts'
import { createPageBridge, installCapture } from '../src/agent-bridge'
import { autoSpool, currentTarget, fileSlotFor, lastSpool, moveToSpool, noteLastSpool, spoolParts, spoolPicks, targetSlot, withAutoSpools } from '../src/filament/pick'
import { pickNote, targetWords } from '../src/filament/slot-rail'
import { get, set, type PlateEntry } from '../src/state/store'

const AMS: FilamentSlot[] = [
  { id: 'A1', material: 'PLA Basic', color: '#f2f2f0' },
  { id: 'A2', material: 'PLA Basic', color: '#2b2b2e' },
  { id: 'A3', material: 'PETG HF', color: '#f0913a' },
  { id: 'A4', material: 'PLA Matte', color: '#8fc6e8' },
]
const handle = (id: string, parts: { name: string; slot: number }[] = [{ name: 'body', slot: 1 }]): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 10], openEdges: 0, parts: parts.map((p) => ({ ...p, triangles: 12 })) })
const entry = (id: string, parts?: { name: string; slot: number }[], extra: Partial<PlateEntry> = {}): PlateEntry => ({ id, name: id, handle: handle(id, parts), parts: [], colors: [], transform: [], ...extra })
const slotOf = (id: string, part = 'body') => {
  const e = get().plate.find((x) => x.id === id)!
  return e.slotOverrides?.[part] ?? e.handle.parts.find((p) => p.name === part)!.slot
}

beforeEach(() => {
  localStorage.clear()
  spoolPicks.setState({ why: {} })
  set({ printerSlots: AMS, slotSetup: {}, printerId: 'bay-1', profile: null, selection: null, selectedIds: [], plate: [] })
  set((s) => ({ plates: s.plates.map((p) => (p.id === s.activePlate ? { ...p, settings: {} } : p)) }))
})

describe('auto-pick for a part with no filament of its own', () => {
  const spools = AMS.map((a, i) => ({ index: i + 1, type: a.material!.split(' ')[0]!, color: a.color! }))

  it('takes the profile material first, then the nearest color', () => {
    // a blue lid on PLA: Ice Blue A4, never A2 Black, and never the orange PETG
    expect(autoSpool(spools, { material: 'PLA', color: '#4a8fd6' })).toEqual({ slot: 4, why: 'color' })
    expect(autoSpool(spools, { material: 'PLA', color: '#dddddd' })).toEqual({ slot: 1, why: 'color' })
    expect(autoSpool(spools, { material: 'PETG', color: '#ffffff' })).toEqual({ slot: 3, why: 'color' })
  })

  it('gives a plain STL the spool used last, else the first of the material', () => {
    expect(autoSpool(spools, { material: 'PLA', last: 2 })).toEqual({ slot: 2, why: 'last' })
    // the last spool holds another material: the profile's material wins
    expect(autoSpool(spools, { material: 'PLA', last: 3 })).toEqual({ slot: 1, why: 'material' })
    expect(autoSpool([], { material: 'PLA' })).toBeNull()
  })

  it('falls back to any spool when none holds the profile material', () => {
    expect(autoSpool(spools, { material: 'ABS' })).toEqual({ slot: 1, why: 'material' })
  })

  it('remembers the spool used last per printer', () => {
    expect(lastSpool('bay-1')).toBeUndefined()
    noteLastSpool('bay-1', 3)
    expect(lastSpool('bay-1')).toBe(3)
    expect(lastSpool('bay-2')).toBeUndefined()
  })

  it('puts new parts on the picked spool and leaves parts with their own filament', () => {
    noteLastSpool('bay-1', 2)
    const [plain, own] = withAutoSpools([entry('stl'), entry('3mf', [{ name: 'base', slot: 1 }, { name: 'lid', slot: 2 }])], { own: (e) => e.id === '3mf' })
    expect(plain!.slotOverrides).toEqual({ body: 2 })
    expect(own!.slotOverrides).toBeUndefined()
    expect(spoolPicks.getState().why).toEqual({ stl: 'last' })
  })

  it('uses the model color when the file has one', () => {
    const [e] = withAutoSpools([entry('obj', [{ name: 'lid', slot: 1 }], { colors: ['#4a8fd6'] })], { color: (x, i) => x.colors[i] })
    expect(e!.slotOverrides).toEqual({ lid: 4 })
  })

  it('changes nothing without loaded spools', () => {
    set({ printerSlots: [] })
    const [e] = withAutoSpools([entry('stl')], {})
    expect(e!.slotOverrides).toBeUndefined()
  })
})

describe('a click on a spool', () => {
  it('moves the whole plate when nothing is selected and one filament is in use', () => {
    set({ plate: [entry('a'), entry('b')] })
    expect(currentTarget(get(), null)).toEqual({ kind: 'plate' })
    expect(moveToSpool({ kind: 'plate' }, 3)).toBe(2)
    expect([slotOf('a'), slotOf('b')]).toEqual([3, 3])
    expect(spoolParts(get().plate, undefined).get(3)).toEqual({ parts: 2, names: ['a', 'b'] })
    expect(lastSpool('bay-1')).toBe(3)
    expect(spoolPicks.getState().why).toEqual({ a: 'manual', b: 'manual' })
    // back to the file's own slot drops the override
    moveToSpool({ kind: 'plate' }, 1)
    expect(get().plate.every((e) => e.slotOverrides === undefined)).toBe(true)
  })

  it('moves only the selection when something is selected', () => {
    set({ plate: [entry('a'), entry('b')], selection: 'b', selectedIds: ['b'] })
    const t = currentTarget(get(), null)
    expect(t).toEqual({ kind: 'objects', ids: ['b'] })
    moveToSpool(t, 4)
    expect([slotOf('a'), slotOf('b')]).toEqual([1, 4])
    expect(targetSlot(get(), t)).toBe(4)
  })

  it('with two filaments in use and nothing selected, moves the parts on the one picked', () => {
    set({ plate: [entry('box', [{ name: 'base', slot: 1 }, { name: 'lid', slot: 2 }])] })
    expect(currentTarget(get(), null)).toEqual({ kind: 'filament', from: 1 })
    const t = currentTarget(get(), 2)
    expect(t).toEqual({ kind: 'filament', from: 2 })
    moveToSpool(t, 4)
    expect([slotOf('box', 'base'), slotOf('box', 'lid')]).toEqual([1, 4])
  })

  it('lands on the spool clicked after the plate swapped colors', () => {
    set({ plate: [entry('a')] })
    set((s) => ({ plates: s.plates.map((p) => (p.id === s.activePlate ? { ...p, settings: { slotMap: { 1: 2, 2: 1 } } } : p)) }))
    expect(fileSlotFor({ settings: { slotMap: { 1: 2, 2: 1 } } }, 1)).toBe(2)
    moveToSpool({ kind: 'plate' }, 1)
    // set to file slot 2, which the swap prints as 1
    expect(slotOf('a')).toBe(2)
  })
})

describe('the words under the spools', () => {
  it('names the target', () => {
    const plate = [{ id: 'a', name: 'Cube' }, { id: 'b', name: 'Lid' }]
    expect(targetWords({ kind: 'plate' }, plate, () => [])).toBe('the plate')
    expect(targetWords({ kind: 'objects', ids: ['a'] }, plate, () => [])).toBe('Cube')
    expect(targetWords({ kind: 'objects', ids: ['a', 'b'] }, plate, () => [])).toBe('2 objects')
    expect(targetWords({ kind: 'filament', from: 2 }, plate, () => ['Lid'])).toBe('Lid')
  })

  it('says why, and says so when the spool holds another material than the profile', () => {
    expect(pickNote({ spool: { label: 'A3', type: 'PETG' }, material: 'PLA', why: 'manual', what: 'Lid' })).toEqual({ text: 'PETG on a PLA profile: the slice uses PETG settings for Lid.', other: true })
    expect(pickNote({ spool: { label: 'A2', type: 'PLA' }, material: 'PLA', why: 'manual', what: 'Lid' }).text).toBe('You picked A2.')
    expect(pickNote({ spool: { label: 'A4', type: 'PLA' }, material: 'PLA', why: 'color', what: 'Lid' }).text).toBe("Picked automatically: the closest PLA to the model's color.")
    expect(pickNote({ spool: { label: 'A1', type: 'PLA' }, material: 'PLA', why: 'last', what: 'Cube' }).text).toMatch(/spool used last on this printer/)
    expect(pickNote({ spool: undefined, material: 'PLA', why: undefined, what: '' }).text).toBe('')
    // nothing to say about the target: what a click does, unless another spool in use holds another material
    expect(pickNote({ spool: { label: 'A1', type: 'PLA' }, material: 'PLA', why: undefined, what: 'Plinth' }).text).toBe('Click a spool to print Plinth with it.')
    expect(pickNote({ spool: { label: 'A1', type: 'PLA' }, material: 'PLA', why: undefined, what: 'Plinth', inUse: [{ type: 'PLA', what: 'Plinth' }, { type: 'PETG', what: 'X' }] })).toEqual({ text: 'PETG on a PLA profile: the slice uses PETG settings for X.', other: true })
  })
})

describe('the agent bridge', () => {
  it('reads the spools and moves an object the way a click does, with read-back in state', async () => {
    const capture = installCapture(window)
    const bridge = createPageBridge(capture)
    set({ plate: [entry('cube'), entry('box', [{ name: 'base', slot: 1 }, { name: 'lid', slot: 2 }])] })
    const view = (await bridge.handle('spools', {})) as { spools: { label: string; inUse: number; loaded: boolean }[]; target: { kind: string } }
    expect(view.spools.map((s) => [s.label, s.inUse, s.loaded])).toEqual([['A1', 2, true], ['A2', 1, true], ['A3', 0, true], ['A4', 0, true]])
    expect(view.target.kind).toBe('filament')
    // two filaments in use and no target: the bridge asks which
    await expect(bridge.handle('move_to_spool', { spool: 'A3' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(bridge.handle('move_to_spool', { spool: 'B9', object: 'cube' })).rejects.toMatchObject({ code: 'not_found' })
    const moved = (await bridge.handle('move_to_spool', { spool: 'A3', object: 'cube' })) as { moved: number; spools: { label: string; inUse: number }[]; picks: Record<string, string> }
    expect(moved.moved).toBe(1)
    expect(moved.spools.find((s) => s.label === 'A3')?.inUse).toBe(1)
    expect(moved.picks).toEqual({ cube: 'manual' })
    await bridge.handle('move_to_spool', { spool: 4, object: 'box', part: 'lid' })
    await bridge.handle('move_to_spool', { spool: 'A2', from: 'A1' })
    const state = (await bridge.handle('state', {})) as { plate: { objects: { id: string; parts: { name: string; slot: number }[] }[] }; filament: { label: string; inUse: number }[] }
    expect(state.plate.objects.map((o) => o.parts.map((p) => p.slot))).toEqual([[3], [2, 4]])
    expect(state.filament.map((f) => f.inUse)).toEqual([0, 1, 1, 1])
    await bridge.handle('move_to_spool', { spool: 'A1', plate: true })
    expect(((await bridge.handle('state', {})) as typeof state).filament.map((f) => f.inUse)).toEqual([3, 0, 0, 0])
    capture.stop()
  })
})
