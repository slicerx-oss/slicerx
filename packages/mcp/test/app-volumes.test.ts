// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it, vi } from 'vitest'
import { appVolumeInputs, appVolumeTools, type AppVolumes } from '../src/app-volumes'
import type { AppLinkCaller } from '../src/app-route'

const state: AppVolumes = { object: { id: 'part', name: 'Part' }, plate: 'plate-1', volumes: [], removed: ['cut'] }

it('forwards each live volume command with separate read and edit permissions and complete read-back', async () => {
  const call = vi.fn(async () => state)
  const tools = appVolumeTools({ call } as AppLinkCaller, 'SlicerX')
  const cases = [
    ['volumes.list', { object: 'part' }],
    ['volumes.add', { object: 'part', role: 'modifier', shape: 'cone', settings: { wall_loops: 4 } }],
    ['volumes.from_object', { object: 'part', source: 'cutter', role: 'negative' }],
    ['volumes.set', { object: 'part', volume: 'cut', sizeMm: [2, 3, 4], clear: ['wall_loops'] }],
    ['volumes.copy', { object: 'part', volume: 'cut', target: 'other' }],
    ['volumes.remove', { object: 'part', volume: 'cut' }],
  ] as const
  for (const [index, [method, input]] of cases.entries()) {
    const tool = tools[index]!
    expect(tool.permission).toBe(index === 0 ? 'read' : 'slice')
    const args = tool.input.parse(input)
    expect((await tool.run(args, {} as never)).output).toEqual(state)
    expect(call).toHaveBeenLastCalledWith(method, args)
  }
})

it('rejects invalid dimensions, roles, selectors, nonfinite coordinates and unrelated fields', () => {
  for (const input of [
    { object: '', role: 'negative', shape: 'box' },
    { object: 'part', role: 'part', shape: 'box' },
    { object: 'part', role: 'negative', shape: 'model' },
    { object: 'part', role: 'negative', shape: 'box', sizeMm: [1, 0, 2] },
    { object: 'part', role: 'negative', shape: 'box', positionMm: [1, Infinity, 2] },
    { object: 'part', role: 'negative', shape: 'box', path: 'some-file.stl' },
  ]) expect(appVolumeInputs.add.safeParse(input).success).toBe(false)
  expect(appVolumeInputs.set.safeParse({ object: 'part', volume: 'cut', set: { wall_loops: null } }).success).toBe(false)
  expect(appVolumeInputs.remove.safeParse({ object: 'part', volume: '' }).success).toBe(false)
})

it('keeps app refusals intact and never falls back to a server project', async () => {
  const missing = appVolumeTools(undefined, 'SlicerX')[0]!
  await expect(missing.run({ object: 'part' } as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
  for (const [code, expected] of [['app_closed', 'not_configured'], ['read_only', 'not_supported'], ['busy', 'busy'], ['not_found', 'not_found']]) {
    const link = { call: async () => { throw Object.assign(new Error(code), { code }) } }
    const tool = appVolumeTools(link, 'SlicerX')[5]!
    await expect(tool.run({ object: 'part', volume: 'cut' } as never, {} as never)).rejects.toMatchObject({ code: expected })
  }
})
