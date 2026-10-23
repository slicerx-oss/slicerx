// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The floating vertical shell settings from a 3MF project and over the app link: the project's values become setting
// changes, and a client reads them, sets them and reads them back.
import { beforeEach, expect, it } from 'vitest'
import { projectReport } from '@slicerx/settings'
import { runCall } from '../src/app-link/methods'
import { resolveConfig } from '../src/adapters/config'
import { projectSettingChanges } from '../src/export/project-settings'
import { get, set } from '../src/state/store'

type Reply = { output: { overrides: Record<string, unknown>; effective: Record<string, unknown>; supported: string[] } }
const KEYS = ['detect_floating_vertical_shell', 'vertical_shell_speed']

beforeEach(() => set({ overrides: {}, plate: [], plates: [], activePlate: 'plate', plateLoading: false, historyEdit: null, rollback: null, dragging: false, liveEdit: false, slice: { status: 'idle' } }))

it("takes a project's values as setting changes, and its import report does not call them unsupported", () => {
  const current = resolveConfig(get().easy, {})
  expect(projectSettingChanges({ detect_floating_vertical_shell: '0', vertical_shell_speed: ['60%'] }, current).values).toEqual({ detect_floating_vertical_shell: false, vertical_shell_speed: ['60%'] })
  const report = projectReport('shell.3mf', { detect_floating_vertical_shell: '0', vertical_shell_speed: ['60%'] })
  expect(JSON.stringify(report)).not.toMatch(/(detect_floating_vertical_shell|vertical_shell_speed)[^}]*unsupported/)
})

it('reads back what a client sets', async () => {
  const read = async () => await runCall('settings.get', { keys: KEYS }) as Reply
  const before = await read()
  for (const k of KEYS) expect(before.output.supported).toContain(k)
  expect(before.output.effective).toMatchObject({ detect_floating_vertical_shell: true, vertical_shell_speed: ['80%'] })
  await runCall('project.set_overrides', { changes: { detect_floating_vertical_shell: false, vertical_shell_speed: ['150'] } })
  expect(get().overrides).toEqual({ detect_floating_vertical_shell: false, vertical_shell_speed: ['150'] })
  expect((await read()).output.effective).toMatchObject({ detect_floating_vertical_shell: false, vertical_shell_speed: ['150'] })
  await runCall('project.set_overrides', { clear: KEYS })
  expect((await read()).output.overrides).toEqual({})
})
