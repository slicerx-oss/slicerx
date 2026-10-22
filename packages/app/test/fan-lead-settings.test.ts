// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The fan lead time (`pre_start_fan_time`, seconds per filament) over the app link: a client reads it, sets it and
// reads it back the way the settings panel stores it, and a value outside 0 to 5 s is refused with nothing changed.
import { beforeEach, expect, it } from 'vitest'
import { settingDef } from '@slicerx/settings'
import { runCall } from '../src/app-link/methods'
import { get, set } from '../src/state/store'

type Reply = { output: { overrides: Record<string, unknown>; effective: Record<string, unknown>; supported: string[] } }

beforeEach(() => set({ overrides: {}, plate: [], plates: [], activePlate: 'plate', plateLoading: false, historyEdit: null, rollback: null, dragging: false, liveEdit: false, slice: { status: 'idle' } }))

it('is a filament setting in seconds, 0 to 5, off by default', () => {
  expect(settingDef('pre_start_fan_time')).toMatchObject({ section: 'filament', type: 'floats', unit: 's', min: 0, max: 5, default: [0], group: 'cooling', invalidates: 'gcode' })
})

it('reads back what a client sets, and is offered as an edit', async () => {
  const read = async () => await runCall('settings.get', { keys: ['pre_start_fan_time'] }) as Reply
  expect((await read()).output.supported).toContain('pre_start_fan_time')
  await runCall('project.set_overrides', { changes: { pre_start_fan_time: [2] } })
  expect(get().overrides).toEqual({ pre_start_fan_time: [2] })
  const back = (await read()).output
  expect(back.overrides).toEqual({ pre_start_fan_time: [2] })
  expect(back.effective['pre_start_fan_time']).toEqual([2])
  await runCall('project.set_overrides', { clear: ['pre_start_fan_time'] })
  expect((await read()).output.overrides).toEqual({})
})

it.each([[5.5], [-1], ['soon']])('refuses %j and changes nothing', async (bad) => {
  const before = get().overrides
  await expect(runCall('project.set_overrides', { changes: { pre_start_fan_time: [bad] } })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get().overrides).toBe(before)
})
