// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Cloning a part inside its object and putting the parts in a new order: what the copy carries, that paint, filament
// choices and settings follow their part, the history steps they record (which replay to the same parts), one undo
// step each, and the app link methods that do the same for a client.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { replayHistory, stepName, type History } from '@slicerx/cad-history'
import { beforeEach, describe, expect, it } from 'vitest'
import { APP_LINK_METHODS } from '../src/app-link/methods'
import { partAction, readParts } from '../src/app-link/parts'
import { effectiveSlot } from '../src/filament/slots'
import { history } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { clonedName, clonePart, movePart, orderMoving, reorderParts } from '../src/plate/parts'
import { bounds, compose, identity } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const loader = {
  loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({
    id: name, hash: name, name, triangles: 12 * parts.length, bboxMm: [10, 10, 10], openEdges: 0,
    parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: p.indices.length / 3 })),
  }),
}

const named = (name: string, slot: number, w: number): MeshPart => ({ ...boxMesh(w, 10, 10), name, slot })

async function body(extra: Partial<PlateEntry> = {}): Promise<PlateEntry> {
  const parts = [named('Body', 1, 30), { ...named('Lid', 2, 12), paint: { color: { 0: '4' } } }, named('Knob', 3, 8)]
  return {
    id: 'obj', name: 'Box', parts, handle: await loader.loadParts('Box', parts), colors: ['#111111', '#222222', '#333333'],
    transform: compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
    slotOverrides: { Lid: 4 },
    partSettings: { Lid: { wall_loops: 5 }, Knob: { sparse_infill_density: '40%' } },
    paint: { 1: { seam: { 2: '8' } }, 2: { support: { 3: '4' } } },
    ...extra,
  }
}

const entry = () => get().plate.find((p) => p.id === 'obj')!
const names = () => entry().parts.map((p) => p.name)
const noEngine = async (): Promise<never> => {
  throw new Error('no engine call expected')
}

beforeEach(async () => {
  set({ plate: [await body()], activePlate: 'shown', plates: [{ id: 'shown', name: 'Shown', objects: [], settings: {} }], selection: null, selectedIds: [], scopePart: null, objectSettings: {}, rollback: null, historyEdit: null, dragging: false, liveEdit: false, plateLoading: false })
  history().clear()
})

describe('clone part', () => {
  it('names the copy after the original with the next free number', () => {
    expect(clonedName('Body', ['Body'])).toBe('Body 2')
    expect(clonedName('Body', ['Body', 'Body 2', 'Body 3'])).toBe('Body 4')
    expect(clonedName('Body 2', ['Body', 'Body 2'])).toBe('Body 3')
    expect(clonedName('Gear 9', ['Gear 9', 'Gear 10'])).toBe('Gear 11')
  })

  it('copies the part with its slot, filament choice, settings and paint, beside it on X, picked, in one undo step', async () => {
    const before = get().plate
    const made = await clonePart(loader, 'obj', 1)
    expect(made).toEqual({ index: 3, name: 'Lid 2' })
    const e = entry()
    expect(names()).toEqual(['Body', 'Lid', 'Knob', 'Lid 2'])
    expect(e.handle.parts.map((p) => p.name)).toEqual(names())
    const copy = e.parts[3]!
    expect(copy.slot).toBe(2)
    expect(effectiveSlot(e, copy)).toBe(4)
    expect(e.slotOverrides).toEqual({ Lid: 4, 'Lid 2': 4 })
    expect(e.partSettings!['Lid 2']).toEqual({ wall_loops: 5 })
    expect(e.partSettings!['Lid 2']).not.toBe(e.partSettings!['Lid'])
    expect(copy.paint).toEqual({ color: { 0: '4' } })
    expect(e.paint![3]).toEqual({ seam: { 2: '8' } })
    expect(e.colors).toEqual(['#111111', '#222222', '#333333', '#222222'])
    // beside the original: moved along X by its width (12 mm) and a 2 mm gap, nothing else
    const a = bounds([e.parts[1]!], identity())!
    const b = bounds([copy], identity())!
    expect(b.min[0] - a.min[0]).toBeCloseTo(14)
    expect(b.min[1]).toBeCloseTo(a.min[1])
    expect(b.min[2]).toBeCloseTo(a.min[2])
    expect(copy.indices).toEqual(e.parts[1]!.indices)
    expect(get().scopePart).toEqual({ id: 'obj', part: 'Lid 2' })
    expect(get().selection).toBe('obj')
    expect(history().state().undo).toBe(1)
    history().undo()
    expect(get().plate).toBe(before)
  })

  it('moves the faces with the copy, so its surfaces sit where its triangles are', async () => {
    const part: MeshPart = { ...named('Plate', 1, 20), faces: { ids: new Uint32Array(12), table: [{ kind: 'plane', normal: [1, 0, 0], offset: 10 }, { kind: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], radius: 2 }] } }
    const { paint: _p, slotOverrides: _s, partSettings: _ps, ...plain } = entry()
    set({ plate: [{ ...plain, parts: [part], colors: ['#111111'] }] })
    await clonePart(loader, 'obj', 0)
    const faces = entry().parts[1]!.faces!
    expect(faces.table[0]).toEqual({ kind: 'plane', normal: [1, 0, 0], offset: 32 })
    expect(faces.table[1]).toMatchObject({ kind: 'cylinder', origin: [22, 0, 0] })
  })

  it('records a parts.add step in a CAD history, which replays to the same parts', async () => {
    const base = entry().parts
    set({ plate: [{ ...entry(), history: { version: 1, base, steps: [] } }] })
    await clonePart(loader, 'obj', 0)
    const h = entry().history!
    expect(h.steps.map((s) => s.params.op)).toEqual(['parts.add'])
    expect(stepName(h.steps[0]!)).toBe('Clone Body')
    const r = await replayHistory(noEngine, { history: h })
    expect(r.parts.map((p) => p.name)).toEqual(names())
    expect(Array.from(r.parts[3]!.positions)).toEqual(Array.from(entry().parts[3]!.positions))
  })

  it('refuses an object whose history must replay exactly and leaves it as it was', async () => {
    set({ plate: [{ ...entry(), history: { version: 1, exact: true, base: entry().parts, steps: [] } }] })
    const before = get().plate
    await expect(clonePart(loader, 'obj', 0)).rejects.toThrow(/exact/)
    expect(get().plate).toBe(before)
  })
})

describe('reorder parts', () => {
  it('moves colors and paint with their parts; filament choices and settings follow by name; one undo step', async () => {
    const before = get().plate
    expect(await reorderParts(loader, 'obj', [2, 0, 1])).toBe(true)
    const e = entry()
    expect(names()).toEqual(['Knob', 'Body', 'Lid'])
    expect(e.handle.parts.map((p) => p.name)).toEqual(names())
    expect(e.colors).toEqual(['#333333', '#111111', '#222222'])
    expect(e.paint).toEqual({ 0: { support: { 3: '4' } }, 2: { seam: { 2: '8' } } })
    expect(e.parts[2]!.paint).toEqual({ color: { 0: '4' } })
    expect(effectiveSlot(e, e.parts[2]!)).toBe(4)
    expect(e.partSettings).toEqual({ Lid: { wall_loops: 5 }, Knob: { sparse_infill_density: '40%' } })
    expect(history().state().undo).toBe(1)
    history().undo()
    expect(get().plate).toBe(before)
  })

  it('moves one part up or down, and does nothing for the order it already has', async () => {
    expect(orderMoving(3, 2, 0)).toEqual([2, 0, 1])
    expect(orderMoving(3, 0, 1)).toEqual([1, 0, 2])
    expect(await movePart(loader, 'obj', 0, 1)).toBe(true)
    expect(names()).toEqual(['Lid', 'Body', 'Knob'])
    expect(await movePart(loader, 'obj', 1, 1)).toBe(false)
    await expect(reorderParts(loader, 'obj', [0, 0, 1])).rejects.toThrow(/each of the 3 parts/)
  })

  it('records a parts.order step that replays to the same order, after the steps before it and with later ones', async () => {
    const base = entry().parts
    set({ plate: [{ ...entry(), history: { version: 1, base, steps: [] } }] })
    await clonePart(loader, 'obj', 2)
    await reorderParts(loader, 'obj', [3, 0, 1, 2])
    const h = entry().history!
    expect(h.steps.map((s) => s.params.op)).toEqual(['parts.add', 'parts.order'])
    expect(h.steps[1]!.params).toEqual({ op: 'parts.order', order: [3, 0, 1, 2] })
    expect(stepName(h.steps[1]!)).toBe('Reorder parts')
    const r = await replayHistory(noEngine, { history: h })
    expect(r.parts.map((p) => p.name)).toEqual(['Knob 2', 'Body', 'Lid', 'Knob'])
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done'])
  })

  it('reorders a history that must replay exactly, since no geometry changes', async () => {
    set({ plate: [{ ...entry(), history: { version: 1, exact: true, base: entry().parts, steps: [] } }] })
    await reorderParts(loader, 'obj', [1, 0, 2])
    expect(entry().history!.steps.map((s) => s.params.op)).toEqual(['parts.order'])
    const r = await replayHistory(noEngine, { history: entry().history! as History })
    expect(r.parts.map((p) => p.name)).toEqual(['Lid', 'Body', 'Knob'])
  })

  it('marks a parts.order step broken when the part count no longer matches', async () => {
    const h: History = { version: 1, base: entry().parts, steps: [{ id: 's1', part: -1, transform: entry().transform, params: { op: 'parts.order', order: [1, 0] } }] }
    const r = await replayHistory(noEngine, { history: h })
    expect(r.status[0]!.state).toBe('broken')
  })
})

describe('app link', () => {
  it('classes the methods and reads the parts back', () => {
    expect(APP_LINK_METHODS['parts.list']).toBe('read')
    expect(APP_LINK_METHODS['parts.clone']).toBe('edit')
    expect(APP_LINK_METHODS['parts.order']).toBe('edit')
    const r = readParts({ object: 'Box' })
    expect(r.object).toEqual({ id: 'obj', name: 'Box' })
    expect(r.parts.map((p) => [p.index, p.name, p.slot, p.painted])).toEqual([[0, 'Body', 1, []], [1, 'Lid', 4, ['color', 'seam']], [2, 'Knob', 3, ['support']]])
    expect(r.parts[1]!.settings).toEqual({ wall_loops: 5 })
    expect(r.history).toBeNull()
  })

  it('clones by name and moves a part by index, each one undo step, and refuses bad input and locked objects', async () => {
    const cloned = await partAction('clone', { object: 'obj', part: 'Knob' }, 'Test client', loader)
    expect(cloned.cloned).toEqual({ index: 3, name: 'Knob 2' })
    expect(cloned.parts[3]!.settings).toEqual({ sparse_infill_density: '40%' })
    const moved = await partAction('order', { object: 'obj', part: 3, to: 0 }, 'Test client', loader)
    expect(moved.changed).toBe(true)
    expect(moved.parts.map((p) => p.name)).toEqual(['Knob 2', 'Body', 'Lid', 'Knob'])
    expect(history().state().undo).toBe(2)
    const same = await partAction('order', { object: 'obj', order: [0, 1, 2, 3] }, 'Test client', loader)
    expect(same.changed).toBe(false)
    await expect(partAction('order', { object: 'obj', order: [0, 1] }, 'Test client', loader)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(partAction('order', { object: 'obj' }, 'Test client', loader)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(partAction('clone', { object: 'obj', part: 9 }, 'Test client', loader)).rejects.toMatchObject({ code: 'not_found' })
    set({ plate: [{ ...entry(), locked: true }] })
    await expect(partAction('clone', { object: 'obj', part: 0 }, 'Test client', loader)).rejects.toMatchObject({ code: 'refused' })
  })
})
