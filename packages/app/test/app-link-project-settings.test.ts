// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, expect, it } from 'vitest'
import { runCall } from '../src/app-link/methods'
import { resolveConfig } from '../src/adapters/config'
import { get, set } from '../src/state/store'

type SettingsReply = { output: { overrides: Record<string, unknown>; effective: Record<string, unknown> } }
const read = async () => await runCall('settings.get', {}) as SettingsReply

beforeEach(() => set({ overrides: { wall_loops: 3 }, plate: [], plates: [], activePlate: 'plate', plateLoading: false, historyEdit: null, rollback: null }))

it('reads explicit overrides and effective print settings without exposing scripts', async () => {
  set({ overrides: { wall_loops: 3, machine_start_gcode: 'private start script' } })
  const reply = await read()
  expect(reply.output.overrides).toEqual({ wall_loops: 3 })
  expect(reply.output.effective.wall_loops).toBe(3)
  expect(JSON.stringify(reply)).not.toContain('private start script')
})

it('sets live overrides and clears them back to the current profile and Easy values', async () => {
  const inherited = resolveConfig(get().easy, {}).layer_height
  const result = await runCall('project.set_overrides', { changes: { layer_height: 0.12, brim_type: 'painted' } }) as SettingsReply
  expect(result.output.overrides).toEqual({ wall_loops: 3, layer_height: 0.12, brim_type: 'painted' })
  expect(get().overrides).toEqual(result.output.overrides)
  expect((await read()).output.effective).toMatchObject({ layer_height: 0.12, brim_type: 'painted' })
  await runCall('project.set_overrides', { clear: ['layer_height'] })
  expect(get().overrides).toEqual({ wall_loops: 3, brim_type: 'painted' })
  expect((await read()).output.effective.layer_height).toEqual(inherited)
})

it('refuses an invalid mixed patch atomically', async () => {
  const before = get().overrides
  await expect(runCall('project.set_overrides', { changes: { wall_loops: 5, no_such_setting: 1 } })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get().overrides).toBe(before)
})

it('refuses script settings without applying the other values', async () => {
  const before = get().overrides
  await expect(runCall('project.set_overrides', { changes: { wall_loops: 5, machine_start_gcode: 'G28' } })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get().overrides).toBe(before)
})

it('reports the shown plate effective setting when its own choice overrides the project', async () => {
  set({ overrides: { print_sequence: 'by layer' }, plates: [{ id: 'plate', name: 'Plate', objects: [], settings: { sequence: 'by-object' } }] })
  const reply = await read()
  expect(reply.output.overrides.print_sequence).toBe('by layer')
  expect(reply.output.effective.print_sequence).toBe('by object')
})
