// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it, vi } from 'vitest'
import { appObjectsTool } from '../src/app-objects'
import type { AppLinkCaller } from '../src/app-route'

it('reads concrete objects through a read grant and preserves their complete state', async () => {
  const state = {
    bed: { shape: 'rectangle', widthMm: 220, depthMm: 220, heightMm: 250 },
    objects: [{ id: 'body', name: 'Body', parts: 1, partDetails: [{ name: 'Shell', triangles: 12, slot: 2, settings: { wall_loops: 5 } }], locked: false, printable: true, settings: { sparse_infill_density: '25%' }, transform: [1, 0, 0], minMm: [0, 0, 0], maxMm: [20, 10, 3], sizeMm: [20, 10, 3], volumes: [{ id: 'cut', role: 'negative' }], layerRanges: [], brimPoints: [], measurements: 1, steps: 2 }],
  }
  const call = vi.fn(async () => state)
  const tool = appObjectsTool({ call } as AppLinkCaller, 'SlicerX')
  expect(tool.name).toBe('app.objects')
  expect(tool.permission).toBe('read')
  const out = await tool.run({} as never, {} as never)
  expect(out.output).toEqual(state)
  expect(call).toHaveBeenCalledExactlyOnceWith('plate.list', {})
  state.objects.length = 0
  expect((await tool.run({} as never, {} as never)).output).toEqual({ ...state, objects: [] })
})

it('rejects editing or server-project fields in its read input', () => {
  const tool = appObjectsTool(undefined, 'SlicerX')
  expect(tool.input.safeParse({}).success).toBe(true)
  for (const input of [{ project: 'local' }, { object: 'body' }, { remove: ['body'] }]) expect(tool.input.safeParse(input).success).toBe(false)
})

it('refuses a missing or closed link and preserves meaningful app failures', async () => {
  await expect(appObjectsTool(undefined, 'SlicerX').run({} as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
  for (const [code, expected] of [['app_closed', 'not_configured'], ['app_link_off', 'not_configured'], ['unauthorized', 'not_configured'], ['busy', 'busy'], ['not_found', 'not_found'], ['denied', 'not_supported']]) {
    const call = async () => { throw Object.assign(new Error('Unavailable'), { code }) }
    await expect(appObjectsTool({ call } as AppLinkCaller, 'SlicerX').run({} as never, {} as never)).rejects.toMatchObject({ code: expected })
  }
})
