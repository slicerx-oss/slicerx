// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project's per-filament override with a nil entry: that filament stays on the printer's value through the project
// open and through a client's set_overrides and read back, instead of copying the filament before it.
import { beforeEach, expect, it } from 'vitest'
import { runCall } from '../src/app-link/methods'
import { resolveConfig } from '../src/adapters/config'
import { projectSettingChanges } from '../src/export/project-settings'
import { get, set } from '../src/state/store'

type Reply = { output: { overrides: Record<string, unknown> } }

beforeEach(() => set({ overrides: {}, plate: [], plates: [], activePlate: 'plate', plateLoading: false, historyEdit: null, rollback: null }))

it('keeps ["0.6", "nil"] as [0.6, nil] after the project open and the app link round trip', async () => {
  const raw = { filament_z_hop: ['0.6', 'nil'], filament_retraction_length: ['nil', '1.2'] }
  const { values } = projectSettingChanges(raw, resolveConfig(get().easy, {}))
  expect(values['filament_z_hop']).toEqual([0.6, 'nil'])
  expect(values['filament_retraction_length']).toEqual(['nil', 1.2])
  await runCall('project.set_overrides', { changes: values })
  const keys = Object.keys(raw)
  const reply = await runCall('settings.get', { keys }) as Reply
  expect(reply.output.overrides).toEqual({ filament_z_hop: [0.6, 'nil'], filament_retraction_length: ['nil', 1.2] })
})
