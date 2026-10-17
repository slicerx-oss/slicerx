// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, expect, it } from 'vitest'
import { SETTINGS } from '@slicerx/settings'
import { APP_LINK_METHODS, runCall } from '../src/app-link/methods'
import { get, set } from '../src/state/store'

beforeEach(() => set({ overrides: { wall_loops: 3 }, plate: [], plates: [], activePlate: 'plate', plateLoading: false, historyEdit: null, rollback: null, dragging: false, liveEdit: false, slice: { status: 'idle' } }))

it('coerces supported scalar, vector, percentage and checked template values without editing presets', async () => {
  const presets = get().userPresets
  const easy = get().easy
  await runCall('project.set_overrides', { changes: { slowdown_for_curled_perimeters: true, solid_infill_rotate_template: '0,90', small_perimeter_speed: '40%', internal_bridge_speed: 30, nozzle_temperature: [210, 220] } })
  expect(get().overrides).toEqual({ wall_loops: 3, slowdown_for_curled_perimeters: [true], solid_infill_rotate_template: '0,90', small_perimeter_speed: ['40%'], internal_bridge_speed: ['30'], nozzle_temperature: [210, 220] })
  expect(get().userPresets).toBe(presets)
  expect(get().easy).toBe(easy)
})

it.each([
  { wall_loops: 2.5 }, { wall_loops: '2.5' }, { wall_loops: [2, 3] }, { layer_height: NaN }, { layer_height: Infinity },
  { layer_height: '1e999' }, { nozzle_temperature: [210, {}] }, { small_perimeter_speed: '-5%' },
  { small_perimeter_speed: '1e999%' }, { enable_support: 'maybe' }, { brim_type: 'unknown' },
  { nozzle_temperature: [] }, { solid_infill_rotate_template: 'G28' }, { post_process: 'a script' }, { nozzle_diameter: 0.6 },
])('refuses invalid or person-only values atomically: %j', async (changes) => {
  const before = get().overrides
  await expect(runCall('project.set_overrides', { changes: { wall_loops: 4, ...changes } })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get().overrides).toBe(before)
})

it.each([{ clear: ['no_such_setting'] }, { clear: ['machine_start_gcode'] }, { clear: ['wall_loops'], changes: { wall_loops: 4 } }, {}])('refuses invalid reset without edits: %j', async (args) => {
  const before = get().overrides
  await expect(runCall('project.set_overrides', args)).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get().overrides).toBe(before)
})

it('rejects known enum choices that the engine cannot honor', async () => {
  const def = SETTINGS.find((d) => d.section === 'process' && d.type === 'enum' && d.unavailableValues?.length)!
  expect(def).toBeDefined()
  const before = get().overrides
  await expect(runCall('project.set_overrides', { changes: { [def.key]: def.unavailableValues![0] } })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get().overrides).toBe(before)
})

it.each([{ plateLoading: true }, { liveEdit: true }, { dragging: true }, { slice: { status: 'running', progress: null, startedAt: 0 } }])('waits for active work: %j', async (state) => {
  set(state as never)
  const before = get().overrides
  await expect(runCall('project.set_overrides', { changes: { wall_loops: 5 } })).rejects.toMatchObject({ code: 'busy' })
  expect(get().overrides).toBe(before)
})

it('reads only requested keys and keeps scripts out even when specifically requested', async () => {
  const result = await runCall('settings.get', { keys: ['wall_loops'] }) as { output: { overrides: unknown; effective: unknown } }
  expect(result.output.overrides).toEqual({ wall_loops: 3 })
  expect(result.output.effective).toEqual({ wall_loops: 3 })
  await expect(runCall('settings.get', { keys: ['machine_start_gcode'] })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(APP_LINK_METHODS['settings.get']).toBe('read')
  expect(APP_LINK_METHODS['project.set_overrides']).toBe('edit')
})

it('does not replace override state for a no-op or an already clear key', async () => {
  const before = get().overrides
  await runCall('project.set_overrides', { changes: { wall_loops: 3 }, clear: ['brim_type'] })
  expect(get().overrides).toBe(before)
})
