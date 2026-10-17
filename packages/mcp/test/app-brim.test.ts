// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it, vi } from 'vitest'
import { appBrimTools } from '../src/app-brim'
import type { AppLinkCaller } from '../src/app-route'
import { connect, data, text } from './helpers'

it('routes every brim action with its revision and keeps the independent reader read-only', async () => {
  const state = { summary: 'Ears', output: { revision: 'r1', objects: [{ id: 'body', enabled: true, ears: [{ index: 0, bedMm: [56, 60, 0], diameterMm: 10, connected: true }] }] } }
  const call = vi.fn(async () => state)
  const [read, edit] = appBrimTools({ call } as AppLinkCaller, 'SlicerX')
  expect(read!.permission).toBe('read')
  expect(edit!.permission).toBe('slice')
  expect(await read!.run({} as never, {} as never)).toEqual(state)
  expect(call).toHaveBeenLastCalledWith('brim.get', {})
  for (const args of [
    { action: 'add', x_mm: 56, y_mm: 60 }, { action: 'move', indices: [0], x_mm: 57, y_mm: 60 },
    { action: 'resize', indices: [0], diameter_mm: 12 }, { action: 'remove', indices: [0] }, { action: 'clear' }, { action: 'generate' },
  ]) {
    const input = edit!.input.parse({ object: 'body', revision: 'r1', ...args })
    expect(await edit!.run(input as never, {} as never)).toEqual(state)
    expect(call).toHaveBeenLastCalledWith('brim.edit', input)
  }
})

it('validates through the MCP client before forwarding an edit', async () => {
  const h = await connect()
  try {
    const listed = (await h.client.listTools()).tools.map((t) => t.name)
    expect(listed).toContain('slicerx_app_brim_ears')
    expect(listed).toContain('slicerx_project_brim_ears')
    for (const args of [
      { action: 'add', x_mm: 0 }, { action: 'remove', indices: [-1] },
      { action: 'clear', diameter_mm: 10 }, { action: 'move', x_mm: 0, y_mm: 0, indices: [0, 1] },
      { action: 'resize', indices: [0], diameter_mm: 21 }, { action: 'generate', max_angle: 181 },
    ]) {
      const out = await h.call('slicerx_project_brim_ears', { object: 'body', revision: 'r1', ...args })
      expect(out.isError).toBe(true)
      expect(text(out)).toMatch(/^Input validation error: Invalid arguments for tool slicerx_project_brim_ears:/)
    }
    expect(data(await h.call('slicerx_app_brim_ears'))).toMatchObject({ error: { code: 'not_configured' } })
    expect(data(await h.call('slicerx_project_brim_ears', { object: 'body', revision: 'r1', action: 'clear' }))).toMatchObject({ error: { code: 'not_configured' } })
  } finally { await h.client.close() }
})

it('preserves stale, missing, denied and closed-app failures', async () => {
  for (const [code, expected] of [['busy', 'busy'], ['not_found', 'not_found'], ['denied', 'not_supported'], ['app_closed', 'not_configured']]) {
    const call = async () => { throw Object.assign(new Error('Unavailable'), { code }) }
    const [read, edit] = appBrimTools({ call } as AppLinkCaller, 'SlicerX')
    for (const tool of [read, edit]) await expect(tool!.run({} as never, {} as never)).rejects.toMatchObject({ code: expected })
  }
})
