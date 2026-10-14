// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import { runCall } from '../src/app-link/methods'
import { historyState } from '../src/app-link/history'
import { history, inStep, quietly } from '../src/plate/history'
import { addPlate, renamePlate, switchPlate } from '../src/plate/plates'
import { identity } from '../src/plate/transform'
import { toolStore } from '../src/plate/tools'
import { get, set, type PlateEntry } from '../src/state/store'

const box = { positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 5]), indices: new Uint32Array([0, 1, 2, 0, 1, 3]), name: 'Box', slot: 1 }
const read = async () => await runCall('history.get', {}) as ReturnType<typeof historyState>
const act = async (action: 'undo' | 'redo', revision = history().state().revision) => await runCall(`history.${action}`, { revision }, { id: 'c1', name: 'Print Helper' }) as ReturnType<typeof historyState> & { changed: boolean }

beforeEach(() => {
  set({ plate: [{ id: 'box', name: 'Box', parts: [box], transform: identity() } as PlateEntry], plates: [{ id: 'p1', name: 'Plate 1', settings: {}, objects: [] }], activePlate: 'p1', selection: 'box', selectedIds: ['box'], plateLoading: false, liveEdit: false, historyEdit: null, objectTool: null, objectSettings: {}, slotSetup: {}, timeline: { items: [], bodies: [], marker: 0 }, rollback: null })
  toolStore.setState({ tool: 'move' })
  history().clear()
})

describe('project history over the app link', () => {
  it('reverses a plate transform and redoes it, with counts and actual object bounds', async () => {
    const before = await read()
    expect(before).toMatchObject({ undo: 0, redo: 0 })
    await runCall('project.move', { object: 'box', x: 50, y: 60 })
    const moved = await read()
    expect(moved).toMatchObject({ undo: 1, redo: 0, plates: [{ objects: [{ minMm: [45, 50, 0] }] }] })
    expect(await act('undo', moved.revision)).toMatchObject({ changed: true, undo: 0, redo: 1, plates: [{ objects: [{ minMm: [0, 0, 0], sizeMm: [10, 20, 5] }] }] })
    expect(get().toast?.text).toBe('Print Helper undid the last project edit.')
    expect(await act('redo')).toMatchObject({ changed: true, undo: 1, redo: 0, plates: [{ objects: [{ minMm: [45, 50, 0] }] }] })
    expect(history().state().revision).not.toBe(moved.revision)
    expect(JSON.stringify(await read())).not.toMatch(/positions|indices/)
  })

  it('refuses intervening edits, including a coalesced edit, without touching history', async () => {
    const token = {}
    inStep(token, () => renamePlate('p1', 'First'))
    const stale = await read()
    inStep(token, () => renamePlate('p1', 'Second'))
    expect(history().state().undo).toBe(1)
    await expect(act('undo', stale.revision)).rejects.toMatchObject({ code: 'busy' })
    expect((await read()).plates[0]?.name).toBe('Second')
    expect(history().state().undo).toBe(1)
    expect((await act('undo')).plates[0]?.name).toBe('Plate 1')
  })

  it('restores plate and filament edits as the toolbar does, and a new edit clears redo', async () => {
    const second = addPlate()
    expect((await act('undo')).plates).toHaveLength(1)
    expect(await act('redo')).toMatchObject({ activePlate: second, plates: [{ id: 'p1' }, { id: second }] })
    set({ slotSetup: { 1: { type: 'PETG', brand: 'Generic', color: '#123456' } } })
    expect((await act('undo')).filaments).toEqual({})
    expect((await act('redo')).filaments).toMatchObject({ 1: { type: 'PETG' } })
    await act('undo')
    renamePlate(second, 'Brackets')
    const current = await read()
    expect(current.redo).toBe(0)
    expect(await act('redo', current.revision)).toMatchObject({ changed: false, revision: current.revision })
  })

  it('does not record reads or navigation, and clear invalidates old revisions', async () => {
    addPlate()
    const before = history().state()
    switchPlate('p1')
    await read()
    set({ selection: null, selectedIds: [] })
    expect(history().state()).toEqual(before)
    history().clear()
    await expect(act('undo', before.revision)).rejects.toMatchObject({ code: 'busy' })
    expect(await act('undo')).toMatchObject({ changed: false, undo: 0, redo: 0 })
  })

  it('refuses malformed revisions and active edits without removing a step', async () => {
    renamePlate('p1', 'New name')
    for (const args of [{}, { revision: 1 }, { revision: '' }, { revision: history().state().revision, steps: 2 }]) await expect(runCall('history.undo', args)).rejects.toMatchObject({ code: 'invalid_input' })
    for (const field of ['plateLoading', 'liveEdit'] as const) {
      quietly(() => set({ [field]: true }))
      await expect(act('undo')).rejects.toMatchObject({ code: 'busy' })
      quietly(() => set({ [field]: false }))
    }
    set({ objectTool: 'sketch' })
    await expect(act('undo')).rejects.toMatchObject({ code: 'busy' })
    expect(history().state().undo).toBe(1)
    expect((await read()).plates[0]?.name).toBe('New name')
  })
})
