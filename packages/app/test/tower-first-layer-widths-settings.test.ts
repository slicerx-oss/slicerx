// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The prime tower line width and the first layer's infill width from a 3MF project and over the app link: the
// project's values become setting changes, and a client reads them, sets them and reads them back.
import { beforeEach, expect, it } from 'vitest'
import { projectReport } from '@slicerx/settings'
import { runCall } from '../src/app-link/methods'
import { resolveConfig } from '../src/adapters/config'
import { projectSettingChanges } from '../src/export/project-settings'
import { get, set } from '../src/state/store'

type Reply = { output: { overrides: Record<string, unknown>; effective: Record<string, unknown>; supported: string[] } }
const KEYS = ['prime_tower_line_width', 'initial_layer_infill_line_width']

beforeEach(() => set({ overrides: {}, plate: [], plates: [], activePlate: 'plate', plateLoading: false, historyEdit: null, rollback: null, dragging: false, liveEdit: false, slice: { status: 'idle' } }))

it("takes a project's values as setting changes, and its import report does not call them unsupported", () => {
  const current = resolveConfig(get().easy, {})
  expect(projectSettingChanges({ prime_tower_line_width: '0.8', initial_layer_infill_line_width: '0.6' }, current).values).toEqual({ prime_tower_line_width: 0.8, initial_layer_infill_line_width: 0.6 })
  const report = projectReport('tower.3mf', { prime_tower_line_width: '0.8', initial_layer_infill_line_width: '0.6' })
  expect(JSON.stringify(report)).not.toMatch(/(prime_tower_line_width|initial_layer_infill_line_width)[^}]*unsupported/)
})

it('reads back what a client sets', async () => {
  const read = async () => await runCall('settings.get', { keys: KEYS }) as Reply
  const before = await read()
  for (const k of KEYS) expect(before.output.supported).toContain(k)
  await runCall('project.set_overrides', { changes: { prime_tower_line_width: 0.8, initial_layer_infill_line_width: 0.6 } })
  expect(get().overrides).toEqual({ prime_tower_line_width: 0.8, initial_layer_infill_line_width: 0.6 })
  expect((await read()).output.effective).toMatchObject({ prime_tower_line_width: 0.8, initial_layer_infill_line_width: 0.6 })
  await runCall('project.set_overrides', { clear: KEYS })
  expect((await read()).output.overrides).toEqual({})
})
