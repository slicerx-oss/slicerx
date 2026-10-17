// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PreviewBuffers, SliceResult } from '@slicerx/contracts'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runCall } from '../src/app-link/methods'
import { tuneKey } from '../src/calibration/tuned'
import { boxMesh } from '../src/plate/mesh-ops'
import { switchPlate } from '../src/plate/plates'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { forgetPlateSlices, keptSlice, trackPlateSlices } from '../src/workspaces/preview/plate-slices'

const result = { id: 'slice-before', stats: { timeS: 1, filamentG: [1] } } as SliceResult
const preview = { segmentCount: 1, layerCount: 3 } as PreviewBuffers
const entry = (id: string): PlateEntry => ({
  id, name: id,
  handle: { id, hash: id, name: id, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: [] },
  parts: [{ ...boxMesh(10, 10, 10), name: 'Body', slot: 1 }],
  colors: ['#ffffff'], transform: compose({ position: [50, 50, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
})
let stop: (() => void) | undefined

beforeEach(() => {
  forgetPlateSlices()
  set({
    overrides: { wall_loops: 3 }, plateLoading: false, historyEdit: null, rollback: null, dragging: false, liveEdit: false,
    plate: [entry('first')], activePlate: 'p1',
    plates: [{ id: 'p1', name: 'First', objects: [], settings: {} }, { id: 'p2', name: 'Second', objects: [entry('second')], settings: {} }],
    slice: { status: 'done', result, stale: false }, preview, userPresets: [], slotSetup: {}, printerSlots: [], profile: null, printerId: null,
  })
  stop = trackPlateSlices()
})
afterEach(() => { stop?.(); forgetPlateSlices() })

it('a live global edit invalidates both the shown slice and a cached slice on another plate', async () => {
  switchPlate('p2')
  set({ slice: { status: 'done', result: { ...result, id: 'second-slice' }, stale: false }, preview })
  const shown = get().slice
  expect(keptSlice('p1')).toEqual({ stale: false })
  await runCall('project.set_overrides', { changes: { wall_loops: 3 } })
  expect(get().slice).toBe(shown)
  expect(keptSlice('p1')).toEqual({ stale: false })
  await runCall('project.set_overrides', { changes: { wall_loops: 5 } })
  expect(get().slice).toMatchObject({ status: 'done', stale: true })
  expect(keptSlice('p1')).toEqual({ stale: true })
  switchPlate('p1')
  expect(get().slice).toMatchObject({ status: 'done', result: { id: 'slice-before' }, stale: true })
})

it('a refused patch leaves completed slices current on every plate', async () => {
  switchPlate('p2')
  set({ slice: { status: 'done', result, stale: false }, preview })
  const shown = get().slice
  await expect(runCall('project.set_overrides', { changes: { wall_loops: 6, layer_height: 'invalid' } })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get().slice).toBe(shown)
  expect(keptSlice('p1')).toEqual({ stale: false })
})

it('clearing an override also marks the shown slice stale', async () => {
  await runCall('project.set_overrides', { clear: ['wall_loops'] })
  expect(get().overrides).not.toHaveProperty('wall_loops')
  expect(get().slice).toMatchObject({ status: 'done', stale: true })
})

it('reads calibrated filament values over global overrides and preserves calibration when clearing', async () => {
  const slot = { type: 'PLA', brand: 'Example', color: '#ffffff' }
  const preset = {
    id: 'tuned', kind: 'filament' as const, name: 'Tuned spool', values: { filament_flow_ratio: [0.93] }, createdAt: 0, updatedAt: 0,
    tuned: { key: tuneKey(slot, 'printer', 0.4), filament: 'PLA', printerId: 'printer', nozzleMm: 0.4, results: {} },
  }
  set({ slotSetup: { 1: slot }, userPresets: [preset], overrides: { filament_flow_ratio: [1.1] } })
  type Reply = { output: { overrides: Record<string, unknown>; effective: Record<string, unknown>; shadowed: string[] } }
  const read = async () => await runCall('settings.get', { keys: ['filament_flow_ratio'] }) as Reply
  expect((await read()).output).toMatchObject({ overrides: { filament_flow_ratio: [1.1] }, effective: { filament_flow_ratio: [0.93] }, shadowed: ['filament_flow_ratio'] })
  await runCall('project.set_overrides', { clear: ['filament_flow_ratio'] })
  expect((await read()).output).toMatchObject({ overrides: {}, effective: { filament_flow_ratio: [0.93] }, shadowed: [] })
  expect(get().userPresets).toEqual([preset])
})

it('reports plate-only engine keys without offering them as global edits', async () => {
  set({
    overrides: { curr_bed_type: 'Cool Plate' },
    plates: [{ id: 'p1', name: 'First', objects: [], settings: { bedType: 'textured-pei', nozzleMap: [2, 1], filamentOrder: [2, 1] } }],
  })
  const keys = ['curr_bed_type', 'filament_map', 'filament_map_mode', 'first_layer_print_sequence', 'other_layers_print_sequence', 'other_layers_print_sequence_nums']
  const reply = await runCall('settings.get', { keys }) as { output: { overrides: unknown; effective: unknown; supported: string[]; readOnly: string[]; shadowed: string[] } }
  expect(reply.output.overrides).toEqual({ curr_bed_type: 'Cool Plate' })
  expect(reply.output.effective).toEqual({ curr_bed_type: 'Textured PEI Plate', filament_map: [2, 1], filament_map_mode: 'Manual', first_layer_print_sequence: [2, 1], other_layers_print_sequence: [1, 9999, 2, 1], other_layers_print_sequence_nums: 1 })
  expect(reply.output.shadowed).toContain('curr_bed_type')
  for (const key of keys) {
    expect(reply.output.readOnly).toContain(key)
    expect(reply.output.supported).not.toContain(key)
  }
  const before = get().overrides
  await expect(runCall('project.set_overrides', { changes: { wall_loops: 4, curr_bed_type: 'High Temp Plate' } })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get().overrides).toBe(before)
})
