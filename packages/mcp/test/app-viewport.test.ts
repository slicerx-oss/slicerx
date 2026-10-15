// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it, vi } from 'vitest'
import type { AppLinkCaller } from '../src/app-route'
import { appViewportTools } from '../src/app-viewport'

const viewport = { pixelRatio: 2, motionScale: 0.75, motionFull: false, degrade: { count: 1, lastAt: '2026-10-15T09:00:00.000Z' }, drawnPlate: 2 }

it('reads current viewport values through the read-only app.info route', async () => {
  const call = vi.fn(async () => ({ viewport }))
  const [tool] = appViewportTools({ call } as AppLinkCaller, 'LayerMate')
  expect(tool!.name).toBe('app.viewport')
  expect(tool!.permission).toBe('read')
  expect((await tool!.run({} as never, {} as never)).output).toEqual({ viewport })
  expect(call).toHaveBeenCalledWith('app.info', {})
})

it('distinguishes an unmounted view from an app that does not support telemetry', async () => {
  const run = (info: unknown) => appViewportTools({ call: async () => info } as AppLinkCaller, 'LayerMate')[0]!.run({} as never, {} as never)
  expect((await run({ viewport: null })).output).toEqual({ viewport: null })
  await expect(run({})).rejects.toMatchObject({ code: 'not_supported' })
  await expect(run({ viewport: { ...viewport, pixelRatio: NaN } })).rejects.toMatchObject({ code: 'not_supported' })
})

it('keeps missing and refused links distinct from unavailable viewport data', async () => {
  await expect(appViewportTools(undefined, 'LayerMate')[0]!.run({} as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
  const call = async () => { throw Object.assign(new Error('off'), { code: 'app_link_off' }) }
  await expect(appViewportTools({ call }, 'LayerMate')[0]!.run({} as never, {} as never)).rejects.toMatchObject({ code: 'not_configured', details: { appLink: 'app_link_off' } })
})
