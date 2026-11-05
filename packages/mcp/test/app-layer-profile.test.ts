// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it, vi } from 'vitest'
import { appLayerProfileTools } from '../src/app-layer-profile'
import type { AppLinkCaller } from '../src/app-route'
import { connect, data, text } from './helpers'

it('routes read, set and reset to the app link and returns what it reads back', async () => {
  const state = { summary: 'Plate 1 slices with its own layer heights, 50 layers.', output: { mode: 'own', profile: [[1, 0.12]] } }
  const call = vi.fn(async () => state)
  const [read, edit] = appLayerProfileTools({ call } as AppLinkCaller, 'SlicerX')
  expect(read!.permission).toBe('read')
  expect(edit!.permission).toBe('slice')
  expect(await read!.run(read!.input.parse({}) as never, {} as never)).toEqual(state)
  expect(call).toHaveBeenLastCalledWith('layers.profile.get', {})
  for (const args of [{ action: 'set', points: [[1, 0.12], [5, 0.24]] }, { plate: 2, action: 'reset' }]) {
    const input = edit!.input.parse(args)
    expect(await edit!.run(input as never, {} as never)).toEqual(state)
    expect(call).toHaveBeenLastCalledWith('layers.profile.edit', input)
  }
})

it('validates through the MCP client before forwarding', async () => {
  const h = await connect()
  try {
    const listed = (await h.client.listTools()).tools.map((t) => t.name)
    expect(listed).toContain('slicerx_app_layer_profile')
    expect(listed).toContain('slicerx_project_layer_profile')
    for (const args of [{ action: 'set' }, { action: 'reset', points: [[0, 0.2]] }, { action: 'set', points: [[-1, 0.2]] }, { action: 'set', points: [[0, 0]] }, { action: 'grow' }]) {
      const out = await h.call('slicerx_project_layer_profile', args)
      expect(out.isError).toBe(true)
      expect(text(out)).toMatch(/^Input validation error: Invalid arguments for tool slicerx_project_layer_profile:/)
    }
    expect(data(await h.call('slicerx_app_layer_profile'))).toMatchObject({ error: { code: 'not_configured' } })
    expect(data(await h.call('slicerx_project_layer_profile', { action: 'reset' }))).toMatchObject({ error: { code: 'not_configured' } })
  } finally {
    await h.client.close()
  }
})

it('keeps busy, missing, refused and closed-app failures apart', async () => {
  for (const [code, expected] of [['busy', 'busy'], ['not_found', 'not_found'], ['invalid_input', 'invalid_input'], ['denied', 'not_supported'], ['app_closed', 'not_configured']]) {
    const call = async () => {
      throw Object.assign(new Error('Unavailable'), { code })
    }
    for (const tool of appLayerProfileTools({ call } as AppLinkCaller, 'SlicerX')) await expect(tool.run({} as never, {} as never)).rejects.toMatchObject({ code: expected })
  }
})
