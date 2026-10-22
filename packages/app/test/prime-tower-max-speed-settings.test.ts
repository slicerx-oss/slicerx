// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// `prime_tower_max_speed` from a 3MF project and over the app link: the project's value becomes a setting change,
// and a client reads it, sets it and reads it back.
import { beforeEach, expect, it } from 'vitest'
import { projectReport } from '@slicerx/settings'
import { runCall } from '../src/app-link/methods'
import { resolveConfig } from '../src/adapters/config'
import { projectSettingChanges } from '../src/export/project-settings'
import { get, set } from '../src/state/store'

type Reply = { output: { overrides: Record<string, unknown>; effective: Record<string, unknown>; supported: string[] } }

beforeEach(() => set({ overrides: {}, plate: [], plates: [], activePlate: 'plate', plateLoading: false, historyEdit: null, rollback: null, dragging: false, liveEdit: false, slice: { status: 'idle' } }))

it("takes a project's value as a setting change, and its import report does not call it unsupported", () => {
  const current = resolveConfig(get().easy, {})
  expect(projectSettingChanges({ prime_tower_max_speed: '50' }, current).values).toEqual({ prime_tower_max_speed: 50 })
  const report = projectReport('tower.3mf', { prime_tower_max_speed: '50' })
  expect(JSON.stringify(report)).not.toMatch(/prime_tower_max_speed[^}]*unsupported/)
})

it('reads back what a client sets', async () => {
  const read = async () => await runCall('settings.get', { keys: ['prime_tower_max_speed'] }) as Reply
  expect((await read()).output.supported).toContain('prime_tower_max_speed')
  await runCall('project.set_overrides', { changes: { prime_tower_max_speed: 120 } })
  expect(get().overrides).toEqual({ prime_tower_max_speed: 120 })
  expect((await read()).output.effective['prime_tower_max_speed']).toBe(120)
  await runCall('project.set_overrides', { clear: ['prime_tower_max_speed'] })
  expect((await read()).output.overrides).toEqual({})
})
