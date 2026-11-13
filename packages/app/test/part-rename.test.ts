// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Renaming a part inside its object: the name taken plain, the refusals for an empty name, one too long and one another
// part has, the filament choice, settings, paint and the part picked for settings that go with it, one undo step, the
// parts.name step a CAD history records (it replays with no engine call, exact or not), and the app link's two ways to
// do it: parts.rename on any object, and the design tool design.rename_part, whose step moves the same choices as it
// lands and back when it is undone.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { clearReplayCache, IDENTITY, partNameProblem, replayHistory, stepName, type Step } from '@slicerx/cad-history'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { APP_LINK_METHODS, runCall, useDesignHost } from '../src/app-link/methods'
import { partAction } from '../src/app-link/parts'
import { effectiveSlot } from '../src/filament/slots'
import { setGeomProvider } from '../src/geom/client'
import { history } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { renamedParts } from '../src/plate/part-renames'
import { renamePart } from '../src/plate/parts'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const loader = {
  loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({
    id: name, hash: name, name, triangles: 12 * parts.length, bboxMm: [10, 10, 10], openEdges: 0,
    parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: p.indices.length / 3 })),
  }),
}

const named = (name: string, slot: number, w: number): MeshPart => ({ ...boxMesh(w, 10, 10), name, slot })

async function ship(extra: Partial<PlateEntry> = {}): Promise<PlateEntry> {
  const parts = [named('Hull', 3, 30), named('Hull top', 1, 30), { ...named('Hull top top', 2, 30), paint: { color: { 0: '4' } } }]
  return {
    id: 'obj', name: 'Ship', parts, handle: await loader.loadParts('Ship', parts), colors: ['#aa0000', '#222222', '#ffffff'],
    transform: compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
    slotOverrides: { 'Hull top top': 4 },
    partSettings: { 'Hull top top': { wall_loops: 5 }, Hull: { sparse_infill_density: '40%' } },
    paint: { 2: { seam: { 2: '8' } } },
    ...extra,
  }
}

const entry = () => get().plate.find((p) => p.id === 'obj')!
const names = () => entry().parts.map((p) => p.name)
const noEngine = async (): Promise<never> => {
  throw new Error('no engine call expected')
}

beforeEach(async () => {
  clearReplayCache()
  set({ plate: [await ship()], activePlate: 'shown', plates: [{ id: 'shown', name: 'Shown', objects: [], settings: {} }], selection: null, selectedIds: [], scopePart: null, objectSettings: {}, rollback: null, historyEdit: null, dragging: false, liveEdit: false, plateLoading: false })
  history().clear()
})

describe('a part name', () => {
  it('is taken plain, and refused empty, too long or the name of another part in any case', () => {
    const now = ['Hull', 'Hull top', 'Hull top top']
    expect(partNameProblem('  Decks ', now, 2)).toBeNull()
    expect(partNameProblem('hull TOP top', now, 2)).toBeNull()
    expect(partNameProblem(' \n\t ', now, 2)).toBe('give the part a name')
    expect(partNameProblem('x'.repeat(121), now, 2)).toBe('keep the name to 120 characters (this one has 121)')
    expect(partNameProblem('x'.repeat(120), now, 2)).toBeNull()
    expect(partNameProblem('  hull   top ', now, 2)).toBe('part 1 is already called Hull top; give this one a name no other part has')
  })

  it('moves the choices kept by name only for a part whose old name is gone and whose new one is new', () => {
    expect([...renamedParts(['A', 'B', 'C'], ['A', 'D', 'C'])]).toEqual([['B', 'D']])
    // a new order keeps every name: nothing is renamed
    expect([...renamedParts(['A', 'B', 'C'], ['C', 'A', 'B'])]).toEqual([])
    // parts added or taken away are not compared
    expect([...renamedParts(['A', 'B'], ['A', 'B', 'B top'])]).toEqual([])
  })
})

describe('rename part', () => {
  it('renames the part with its filament choice, settings, paint and the pick for settings, in one undo step', async () => {
    set({ scopePart: { id: 'obj', part: 'Hull top top' } })
    const before = get().plate
    expect(await renamePart(loader, 'obj', 2, '  Decks\n')).toBe(true)
    const e = entry()
    expect(names()).toEqual(['Hull', 'Hull top', 'Decks'])
    expect(e.handle.parts.map((p) => p.name)).toEqual(names())
    expect(e.slotOverrides).toEqual({ Decks: 4 })
    expect(effectiveSlot(e, e.parts[2]!)).toBe(4)
    expect(e.partSettings).toEqual({ Decks: { wall_loops: 5 }, Hull: { sparse_infill_density: '40%' } })
    expect(e.parts[2]!.paint).toEqual({ color: { 0: '4' } })
    expect(e.paint).toEqual({ 2: { seam: { 2: '8' } } })
    expect(get().scopePart).toEqual({ id: 'obj', part: 'Decks' })
    expect(e.history).toBeUndefined()
    expect(history().state().undo).toBe(1)
    await history().undo()
    expect(get().plate).toEqual(before)
  })

  it('does nothing for the name the part has, and refuses the rest in words, changing nothing', async () => {
    const before = get().plate
    expect(await renamePart(loader, 'obj', 1, ' Hull  top ')).toBe(false)
    await expect(renamePart(loader, 'obj', 2, '   ')).rejects.toThrow('Give the part a name.')
    await expect(renamePart(loader, 'obj', 2, 'HULL')).rejects.toThrow('Part 0 is already called Hull; give this one a name no other part has.')
    await expect(renamePart(loader, 'obj', 2, 'x'.repeat(130))).rejects.toThrow('Keep the name to 120 characters (this one has 130).')
    expect(get().plate).toBe(before)
    expect(history().state().undo).toBe(0)
  })

  it('records a parts.name step in a CAD history, which replays to the same names with no engine call, and undoes', async () => {
    set({ plate: [{ ...entry(), history: { version: 1, base: entry().parts, steps: [] } }] })
    await renamePart(loader, 'obj', 2, 'Decks')
    const h = entry().history!
    expect(h.steps.map((s) => [s.part, s.params])).toEqual([[2, { op: 'parts.name', name: 'Decks', was: 'Hull top top' }]])
    expect(stepName(h.steps[0]!)).toBe('Rename Hull top top to Decks')
    const r = await replayHistory(noEngine, { history: h })
    expect(r.status).toEqual([{ state: 'done' }])
    expect(r.parts.map((p) => p.name)).toEqual(['Hull', 'Hull top', 'Decks'])
    expect(Array.from(r.parts[2]!.positions)).toEqual(Array.from(entry().parts[2]!.positions))
    await history().undo()
    expect(names()).toEqual(['Hull', 'Hull top', 'Hull top top'])
    expect(entry().history!.steps).toEqual([])
  })

  it('renames in a history that must replay exactly, since no geometry changes, and keeps it exact', async () => {
    set({ plate: [{ ...entry(), history: { version: 1, exact: true, base: entry().parts, steps: [] } }] })
    expect(await renamePart(loader, 'obj', 0, 'Lower hull')).toBe(true)
    expect(entry().history!.exact).toBe(true)
    expect(names()[0]).toBe('Lower hull')
  })

  it('refuses while the timeline is rolled back or a step is being edited, and changes nothing', async () => {
    set({ plate: [{ ...entry(), history: { version: 1, base: entry().parts, steps: [] } }], rollback: { objectId: 'obj', marker: 0 } as never })
    const before = get().plate
    await expect(renamePart(loader, 'obj', 2, 'Decks')).rejects.toThrow('Return to the end of the timeline before changing parts.')
    expect(get().plate).toBe(before)
  })
})

describe('the step', () => {
  const step = (part: number, name: string, was: string): Step => ({ id: 'n', part, transform: [...IDENTITY], params: { op: 'parts.name', name, was } })
  it('breaks on a part that is gone, as any step on a missing part does', async () => {
    const r = await replayHistory(noEngine, { history: { version: 1, base: [named('Hull', 1, 10)], steps: [step(2, 'Decks', 'Hull top top')] } })
    expect(r.status).toEqual([{ state: 'broken', message: 'The part this step works on is gone.' }])
  })
})

describe('app link', () => {
  // a rename replays with no engine call: a stand-in engine that is never asked
  const asked: string[] = []
  beforeAll(() => {
    setGeomProvider({ call: async (op: string) => { asked.push(op); throw new Error(`no engine call expected, got ${op}`) } })
    return useDesignHost(loader)
  })

  it('classes the methods', () => {
    expect(APP_LINK_METHODS['parts.rename']).toBe('edit')
    expect(APP_LINK_METHODS['design.rename_part']).toBe('edit')
  })

  it('renames by name or index through parts.rename, names the client, undoes from the toast and refuses in the tool words', async () => {
    const out = (await runCall('parts.rename', { object: 'Ship', part: 'Hull top top', name: 'Decks' }, { id: 'c', name: 'Test client' })) as { changed: boolean; parts: { name: string; slot: number; settings: unknown }[] }
    expect(out.changed).toBe(true)
    expect(out.parts.map((p) => [p.name, p.slot])).toEqual([['Hull', 3], ['Hull top', 1], ['Decks', 4]])
    expect(out.parts[2]!.settings).toEqual({ wall_loops: 5 })
    expect(get().toast?.text).toBe('Test client renamed Hull top top to Decks in Ship.')
    get().toast!.action!.run()
    await Promise.resolve()
    expect(names()).toEqual(['Hull', 'Hull top', 'Hull top top'])
    const same = await partAction('rename', { object: 'obj', part: 1, name: 'Hull top' }, 'Test client', loader)
    expect(same.changed).toBe(false)
    await expect(partAction('rename', { object: 'obj', part: 2, name: '' }, 'Test client', loader)).rejects.toMatchObject({ code: 'invalid_input', message: 'name: give the part a name' })
    await expect(partAction('rename', { object: 'obj', part: 2, name: 'hull top' }, 'Test client', loader)).rejects.toMatchObject({ code: 'invalid_input', message: 'name: part 1 is already called Hull top; give this one a name no other part has' })
    await expect(partAction('rename', { object: 'obj', part: 7, name: 'Decks' }, 'Test client', loader)).rejects.toMatchObject({ code: 'not_found' })
    set({ plate: [{ ...entry(), locked: true }] })
    await expect(partAction('rename', { object: 'obj', part: 2, name: 'Decks' }, 'Test client', loader)).rejects.toMatchObject({ code: 'refused' })
  })

  it('takes the filament choice and settings along when design.rename_part lands on a design, and back when it is undone', async () => {
    set({ plate: [{ ...entry(), history: { version: 1, base: entry().parts, steps: [] } }], scopePart: { id: 'obj', part: 'Hull top top' } })
    const out = (await runCall('design.rename_part', { design: 'obj', part: 2, name: 'Decks' }, { id: 'c', name: 'Test client' })) as { summary: string }
    expect(out.summary).toBe('Renamed Hull top top to Decks: step 1')
    expect(names()).toEqual(['Hull', 'Hull top', 'Decks'])
    expect(entry().slotOverrides).toEqual({ Decks: 4 })
    expect(entry().partSettings).toEqual({ Decks: { wall_loops: 5 }, Hull: { sparse_infill_density: '40%' } })
    expect(get().scopePart).toEqual({ id: 'obj', part: 'Decks' })
    await runCall('design.undo', { design: 'obj' }, { id: 'c', name: 'Test client' })
    expect(names()).toEqual(['Hull', 'Hull top', 'Hull top top'])
    expect(entry().slotOverrides).toEqual({ 'Hull top top': 4 })
    expect(entry().partSettings).toEqual({ 'Hull top top': { wall_loops: 5 }, Hull: { sparse_infill_density: '40%' } })
    expect(asked).toEqual([])
    await expect(runCall('design.rename_part', { design: 'obj', part: 2, name: 'hull' }, { id: 'c', name: 'Test client' })).rejects.toMatchObject({ message: expect.stringContaining('name: part 0 is already called Hull') })
  })
})
