// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it, vi } from 'vitest'
import { appObjectSettingsTools, type AppObjectSettings } from '../src/app-object-settings'
import type { AppLinkCaller } from '../src/app-route'

const state: AppObjectSettings = {
  object: { id: 'copy', name: 'Copy', source: 'source', settings: { wall_loops: 4 }, effective: { wall_loops: 4 } },
  parts: [{ name: 'body', settings: { wall_loops: 6 }, effective: { wall_loops: 6 } }],
  plate: { id: 'plate-1', settings: { wall_loops: 2 } },
  affected: [{ id: 'copy', name: 'Copy', plate: 'plate-1' }, { id: 'source', name: 'Source', plate: 'plate-2' }],
  warnings: [],
}

it('preserves effective part values and the cross-plate family in read-back', async () => {
  const call = vi.fn(async () => state)
  const [read, write] = appObjectSettingsTools({ call } as AppLinkCaller, 'SlicerX')
  expect(read!.permission).toBe('read')
  expect(write!.permission).toBe('slice')
  const args = write!.input.parse({ object: 'copy', part: 'body', set: { wall_loops: 6 } })
  expect((await write!.run(args, {} as never)).output).toEqual(state)
  expect(call).toHaveBeenCalledWith('object.settings_set', { object: 'copy', part: 'body', set: { wall_loops: 6 }, clear: [] })
  expect((await read!.run({ object: 'copy', keys: ['wall_loops'] } as never, {} as never)).output).toEqual(state)
})

it('rejects malformed patches, empty selectors, extra connection fields and non-finite values', () => {
  const [read, write] = appObjectSettingsTools(undefined, 'SlicerX')
  for (const bad of [{ object: '' }, { object: 'copy', keys: [] }, { object: 'copy', host: 'other' }]) expect(read!.input.safeParse(bad).success).toBe(false)
  for (const bad of [{ object: 'copy', part: '' }, { object: 'copy', set: { wall_loops: Infinity } }, { object: 'copy', set: { wall_loops: null } }, { object: 'copy', clear: [42] }, { object: 'copy', credentials: {} }]) expect(write!.input.safeParse(bad).success).toBe(false)
})

it('requires the app link and preserves edit refusals instead of applying settings elsewhere', async () => {
  const [, missing] = appObjectSettingsTools(undefined, 'SlicerX')
  await expect(missing!.run({ object: 'copy', set: {}, clear: [] } as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
  for (const [code, expected] of [['app_closed', 'not_configured'], ['unauthorized', 'not_configured'], ['read_only', 'not_supported'], ['busy', 'busy'], ['invalid_input', 'invalid_input']]) {
    const call = async () => { throw Object.assign(new Error(code), { code }) }
    const [, write] = appObjectSettingsTools({ call }, 'SlicerX')
    await expect(write!.run({ object: 'copy', set: { wall_loops: 4 }, clear: [] } as never, {} as never)).rejects.toMatchObject({ code: expected })
  }
})
