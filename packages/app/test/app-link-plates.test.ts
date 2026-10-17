// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import { runCall } from '../src/app-link/methods'
import { platesState } from '../src/app-link/plate-state'
import { history } from '../src/plate/history'
import { toolStore } from '../src/plate/tools'
import { get, set, type PlateEntry } from '../src/state/store'

const entry = (id: string, instanceOf?: string): PlateEntry => ({
  id, name: 'Bracket', ...(instanceOf ? { instanceOf } : {}), handle: {} as never, colors: [],
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, id === 'copy' ? 70 : 20, 20, 0, 1],
  parts: [{ name: 'Body', slot: 1, positions: new Float32Array([0, 0, 0, 20, 10, 5]), indices: new Uint32Array() }],
  partSettings: { Body: { sparse_infill_density: '30%' } }, slotOverrides: { Body: 2 },
})
const call = (action: string, args = {}) => runCall(`plates.${action}`, args, { id: 'c1', name: 'Workshop' }) as Promise<ReturnType<typeof platesState> & { changedPlate: string }>
const read = () => call('list')

beforeEach(() => {
  set({
    plate: [entry('body'), entry('copy', 'body')], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-object' } }, { id: 'p2', name: 'Plate 2', objects: [], settings: {} }],
    activePlate: 'p1', selection: 'body', selectedIds: ['body'], objectSettings: { body: { layer_height: 0.1 } },
    bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, workspace: 'prepare', modelMode: 'slice',
    plateLoading: false, historyEdit: null, liveEdit: false, objectTool: null, dragging: false, slice: { status: 'idle' }, preview: null,
  })
  toolStore.setState({ tool: 'move' })
  history().clear()
})

async function undo(before: ReturnType<typeof platesState>) {
  expect(history().canUndo()).toBe(true)
  expect(history().undo()).toBe(true)
  expect(await read()).toEqual(before)
  expect(history().canUndo()).toBe(false)
}

describe('live plate management', () => {
  it('reads concrete copies, bounds and settings without switching or leaking writable references', async () => {
    const out = await read()
    expect(out.plates[0]).toMatchObject({ settings: { sequence: 'by-object' }, entries: [
      { id: 'body', minMm: [20, 20, 0], sizeMm: [20, 10, 5], settings: { layer_height: 0.1 }, partSettings: { Body: { sparse_infill_density: '30%' } } },
      { id: 'copy', instanceOf: 'body', settings: { layer_height: 0.1 }, slotOverrides: { Body: 2 } },
    ] })
    out.plates[0]!.settings.sequence = 'by-layer'
    out.plates[0]!.entries[0]!.settings['layer_height'] = 9
    expect(get().plates[0]!.settings.sequence).toBe('by-object')
    expect(get().objectSettings['body']).toEqual({ layer_height: 0.1 })
    expect(get().activePlate).toBe('p1')
    expect(history().canUndo()).toBe(false)
  })

  it('adds, names and shows a plate with inherited settings in one undo step', async () => {
    const before = await read()
    const out = await call('add', { name: ' Lid ' })
    expect(out).toMatchObject({ count: 3, shown: 3 })
    expect(out.plates[2]).toMatchObject({ id: out.changedPlate, name: 'Lid', settings: { sequence: 'by-object' }, entries: [] })
    expect(get().toast).toMatchObject({ text: 'Workshop changed the project plates.', action: { label: 'Undo' } })
    await undo(before)
    history().redo()
    expect(await read()).toEqual({ shown: out.shown, count: out.count, plates: out.plates })
  })

  it('copies a nonshown plate with new ids and retained copy relationships and settings', async () => {
    await call('show', { plate: 'p2' })
    const before = await read()
    const out = await call('duplicate', { plate: 'p1', name: 'Copy' })
    const p = out.plates[1]!
    expect(p).toMatchObject({ shown: true, name: 'Copy', objects: 2, settings: { sequence: 'by-object' } })
    expect(p.entries[0]!.id).not.toBe('body')
    expect(p.entries[1]!.instanceOf).toBe(p.entries[0]!.id)
    expect(p.entries[0]!.settings).toEqual({ layer_height: 0.1 })
    expect(p.entries[0]!.transform).toEqual(before.plates[0]!.entries[0]!.transform)
    await undo(before)
  })

  it('renames and merges or clears overrides on a nonshown plate', async () => {
    const before = await read()
    await call('rename', { plate: 2, name: 'Spare' })
    expect((await read()).plates[1]!.name).toBe('Spare')
    await undo(before)
    const settings = { bedType: 'textured-pei', filamentOrder: [2, 1], slotMap: { 1: 2 }, nozzleMap: [1, 2] }
    await call('settings', { plate: 'p1', settings })
    expect((await read()).plates[0]!.settings).toEqual({ sequence: 'by-object', ...settings })
    await undo(before)
    await call('settings', { plate: 1, settings: {}, replace: true })
    expect((await read()).plates[0]!.settings).toEqual({})
    await undo(before)
  })

  it('moves one concrete copy, preserves its settings, and leaves its source and the shown plate alone', async () => {
    const before = await read()
    const out = await call('move', { plate: 'p2', objects: ['copy'] })
    expect(out.shown).toBe(1)
    expect(out.plates.map((p) => p.entries.map((o) => o.id))).toEqual([['body'], ['copy']])
    expect(out.plates[1]!.entries[0]).toMatchObject({ instanceOf: 'body', sizeMm: [20, 10, 5], settings: { layer_height: 0.1 }, slotOverrides: { Body: 2 } })
    expect(out.plates[1]!.entries[0]!.minMm![0]).toBeGreaterThanOrEqual(0)
    await undo(before)
  })

  it('refuses an entire move if any object cannot fit', async () => {
    set({ bed: { widthMm: 5, depthMm: 5, heightMm: 256 } })
    const before = await read()
    await expect(call('move', { plate: 2, objects: ['body', 'copy'] })).rejects.toMatchObject({ code: 'refused' })
    expect(await read()).toEqual(before)
    expect(history().canUndo()).toBe(false)
  })

  it('requires explicit deletion of contents and restores the shown plate on one undo', async () => {
    const before = await read()
    await expect(call('remove', { plate: 1 })).rejects.toMatchObject({ code: 'refused' })
    const out = await call('remove', { plate: 1, deleteObjects: true })
    expect(out).toMatchObject({ count: 1, plates: [{ id: 'p2', objects: 0, shown: true }] })
    await expect(call('remove', { plate: 1 })).rejects.toMatchObject({ code: 'refused' })
    await undo(before)
  })

  it('refuses invalid input and missing objects before touching anything', async () => {
    const before = await read()
    for (const [action, args] of [
      ['add', { name: ' ' }], ['rename', { plate: 1, name: 'x'.repeat(41) }], ['add', { name: 'New', surprise: 1 }],
      ['settings', { plate: 1, settings: { sequence: 'guess' } }], ['settings', { plate: 1, settings: { filamentOrder: [1, 1] } }],
      ['settings', { plate: 1, settings: { nozzleMap: [3] } }], ['settings', { plate: 1, settings: { unknown: 1 } }],
      ['move', { plate: 2, objects: [] }], ['move', { plate: 2, objects: ['copy', 'copy'] }], ['move', { plate: 1, objects: ['copy'] }],
    ] as const) await expect(call(action, args)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('duplicate', { plate: 'gone' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(call('move', { plate: 2, objects: ['body', 'gone'] })).rejects.toMatchObject({ code: 'not_found' })
    expect(await read()).toEqual(before)
    expect(history().canUndo()).toBe(false)
  })

  it('refuses locked objects and every edit while a person is busy', async () => {
    set({ plate: get().plate.map((e) => ({ ...e, locked: true })) })
    history().clear()
    await expect(call('move', { plate: 2, objects: ['body'] })).rejects.toMatchObject({ code: 'refused' })
    await expect(call('remove', { plate: 1, deleteObjects: true })).rejects.toMatchObject({ code: 'refused' })
    const before = await read()
    for (const patch of [{ modelMode: 'design' }, { plateLoading: true }, { dragging: true }, { liveEdit: true }, { objectTool: 'cut' }, { historyEdit: { objectId: 'body' } }, { slice: { status: 'running' } }]) {
      set(patch as never)
      await expect(call('add')).rejects.toMatchObject({ code: 'busy' })
      set({ modelMode: 'slice', plateLoading: false, dragging: false, liveEdit: false, objectTool: null, historyEdit: null, slice: { status: 'idle' } })
    }
    toolStore.setState({ tool: 'paint' })
    await expect(call('rename', { plate: 2, name: 'Busy' })).rejects.toMatchObject({ code: 'busy' })
    expect(await read()).toEqual(before)
    expect(history().canUndo()).toBe(false)
  })
})
