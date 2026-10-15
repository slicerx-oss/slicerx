// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { AppObjectSettings } from '@slicerx/mcp/toolset'
import { APP_LINK_METHODS, runCall } from '../src/app-link/methods'
import { history } from '../src/plate/history'
import { plateObjects } from '../src/state/slice-plate'
import { get, set, type PlateEntry } from '../src/state/store'
import { scopeValue } from '../src/plate/scope'
import { useSettingsObjects } from '../src/workspaces/prepare/scope-bar'

const entry = (id: string, extra: Partial<PlateEntry> = {}): PlateEntry => ({
  id, name: id, parts: [{ name: 'body', slot: 1, positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]), indices: new Uint32Array([0, 1, 2]) }],
  colors: ['#ff0000'], handle: { id, hash: id, name: id, triangles: 1, bboxMm: [10, 10, 0], openEdges: 3, parts: [{ name: 'body', slot: 1, triangles: 1 }] },
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], ...extra,
})
const call = (method: string, args: Record<string, unknown>) => runCall(method, args, { id: 'client', name: 'Test client' }) as Promise<AppObjectSettings>

beforeEach(() => {
  set({ activePlate: 'shown', plates: [{ id: 'shown', name: 'Shown', objects: [], settings: {} }], plate: [entry('source'), entry('copy', { instanceOf: 'source' })], objectSettings: {}, overrides: { wall_loops: 2 }, rollback: null, historyEdit: null, liveEdit: null, dragging: null, plateLoading: false } as never)
  history().clear()
})

it('reads effective values and applies object and part overrides through the same shared scopes as the UI', async () => {
  expect(APP_LINK_METHODS['object.settings']).toBe('read')
  expect(APP_LINK_METHODS['object.settings_set']).toBe('edit')
  const read = await call('object.settings', { object: 'copy', keys: ['wall_loops'] })
  expect(read.object).toMatchObject({ id: 'copy', source: 'source', effective: { wall_loops: 2 } })
  expect(read.affected.map((o) => o.id)).toEqual(['source', 'copy'])
  const own = await call('object.settings_set', { object: 'copy', set: { wall_loops: 4 } })
  expect(own.object.settings).toEqual({ wall_loops: 4 })
  expect(get().objectSettings).toEqual({ source: { wall_loops: 4 } })
  const part = await call('object.settings_set', { object: 'copy', part: 'body', set: { wall_loops: 6 } })
  expect(part.parts[0]).toMatchObject({ name: 'body', settings: { wall_loops: 6 }, effective: { wall_loops: 6 } })
  expect((await call('object.settings', { object: 'source', keys: ['wall_loops'] })).parts[0]?.effective).toEqual({ wall_loops: 6 })
  history().undo()
  expect((await call('object.settings', { object: 'copy', keys: ['wall_loops'] })).parts[0]?.effective).toEqual({ wall_loops: 4 })
  history().redo()
  const cleared = await call('object.settings_set', { object: 'copy', part: 'body', clear: ['wall_loops'] })
  expect(cleared.parts[0]).toMatchObject({ settings: {}, effective: { wall_loops: 4 } })
})

it('validates the entire patch before mutation and keeps connection settings outside read-back', async () => {
  for (const args of [
    { set: { wall_loops: 4, unknown_setting: 1 } },
    { set: { wall_loops: -2 } },
    { set: { machine_start_gcode: 'G28' } },
    { set: { nozzle_temperature: 240 } },
    { set: { wall_loops: 4 }, part: 'missing' },
    { clear: ['print_sequence'] },
  ]) {
    await expect(call('object.settings_set', { object: 'source', ...args })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(get().objectSettings).toEqual({})
    expect(history().canUndo()).toBe(false)
  }
  await expect(call('object.settings', { object: 'source', keys: ['print_host'] })).rejects.toMatchObject({ code: 'invalid_input' })
})

it('reports copies on other plates and refuses while their source is being edited', async () => {
  set({ plate: [entry('copy', { instanceOf: 'source' })], plates: [
    { id: 'shown', name: 'Shown', objects: [], settings: {} },
    { id: 'other', name: 'Other', objects: [entry('source', { partSettings: { body: { wall_loops: 3 } } })], settings: {} },
  ] })
  history().clear()
  const read = await call('object.settings', { object: 'copy', keys: ['wall_loops'] })
  expect(read.parts[0]?.effective).toEqual({ wall_loops: 3 })
  const before = await plateObjects({ loadModel: async () => { throw new Error('An unpainted object already has its mesh') } }, get(), get().plates[0], get().plate)
  expect(before[0]?.partSettings).toEqual({ body: { wall_loops: 3 } })
  expect(read.affected).toContainEqual({ id: 'source', name: 'source', plate: 'other' })
  set({ historyEdit: { objectId: 'source', original: entry('source') } as never })
  await expect(call('object.settings_set', { object: 'copy', set: { wall_loops: 4 } })).rejects.toMatchObject({ code: 'busy' })
  set({ historyEdit: null })
  await call('object.settings_set', { object: 'copy', part: 'body', set: { wall_loops: 5 } })
  expect(get().plates.find((p) => p.id === 'other')?.objects[0]?.partSettings).toEqual({ body: { wall_loops: 5 } })
  const input = await plateObjects({ loadModel: async () => { throw new Error('An unpainted object already has its mesh') } }, get(), get().plates[0], get().plate)
  expect(input[0]?.partSettings).toEqual({ body: { wall_loops: 5 } })
})

it('keeps no-op requests out of history and exposes the legacy project command with read-back', async () => {
  await call('object.settings_set', { object: 'source' })
  expect(history().canUndo()).toBe(false)
  const result = await runCall('project.object_settings', { object: 'source', set: { wall_loops: 4 } }) as { output: AppObjectSettings }
  expect(result.output.object.effective.wall_loops).toBe(4)
  const count = history().snapshots().length
  await call('object.settings_set', { object: 'source', set: { wall_loops: 4 } })
  expect(history().snapshots()).toHaveLength(count)
})

it('refreshes the visible settings when only the source on another plate changes', () => {
  const other = (walls: number) => ({ id: 'other', name: 'Other', settings: {}, objects: [entry('source', { partSettings: { body: { wall_loops: walls } } })] })
  set({ plate: [entry('copy', { instanceOf: 'source' })], plates: [get().plates[0]!, other(3)] })
  const { result, unmount } = renderHook(() => scopeValue({ plate: useSettingsObjects(), objectSettings: get().objectSettings }, { wall_loops: 2 }, 'wall_loops', { kind: 'part', id: 'copy', part: 'body' }).value)
  expect(result.current).toBe(3)
  act(() => set({ plates: [get().plates[0]!, other(5)] }))
  expect(result.current).toBe(5)
  unmount()
})
