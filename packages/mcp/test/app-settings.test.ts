// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it, vi } from 'vitest'
import { appSettingsTools } from '../src/app-settings'
import { routeToApp, type AppLinkCaller } from '../src/app-route'
import { connect, data, text } from './helpers'

it('reads actual app settings through the read tool and preserves the effective values', async () => {
  const reply = { summary: 'read', output: { overrides: { print_sequence: 'by layer' }, effective: { print_sequence: 'by object' }, shadowed: ['print_sequence'] } }
  const call = vi.fn(async () => reply)
  const [tool] = appSettingsTools({ call: call as AppLinkCaller['call'] }, 'Workshop')
  expect(tool!.permission).toBe('read')
  expect(await tool!.run({ keys: ['print_sequence'] } as never, {} as never)).toEqual(reply)
  expect(call).toHaveBeenCalledWith('settings.get', { keys: ['print_sequence'] })
})

it('reports an unavailable app instead of presenting server settings as live', async () => {
  for (const link of [undefined, { call: async () => { throw Object.assign(new Error('closed'), { code: 'app_closed' }) } }]) {
    const [tool] = appSettingsTools(link, 'Workshop')
    await expect(tool!.run({} as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
  }
})

it.each([false, true])('automatic routing preserves server project precedence: server project %s', async (serverProject) => {
  const local = vi.fn(async () => ({ summary: 'local' }))
  const call = vi.fn(async () => ({ summary: 'app', output: {} }))
  const [tool] = routeToApp([{ name: 'project.set_overrides', run: local }] as never, { call: call as AppLinkCaller['call'] }, 'Workshop', { serverProject: () => serverProject, serverHas: () => false })
  await tool!.run({ changes: { wall_loops: 5 } } as never, {} as never)
  expect(local).toHaveBeenCalledTimes(serverProject ? 1 : 0)
  expect(call).toHaveBeenCalledTimes(serverProject ? 0 : 1)
})

it('clears server overrides over MCP, preserves unrelated values and refuses an invalid mixed reset', async () => {
  const h = await connect()
  try {
    await h.call('slicerx_project_open', { filament: 'pla' })
    expect((await h.call('slicerx_project_set_overrides', { changes: { wall_loops: 4, layer_height: 0.12 } })).isError).not.toBe(true)
    const cleared = await h.call('slicerx_project_set_overrides', { clear: ['layer_height'] })
    expect(cleared.isError, text(cleared)).not.toBe(true)
    const read = async () => data<{ output: { overrides: Record<string, unknown> } }>(await h.call('slicerx_project_show')).output.overrides
    expect(await read()).toEqual({ wall_loops: 4 })
    expect((await h.call('slicerx_project_set_overrides', { changes: { wall_loops: 7 }, clear: ['unknown_key'] })).isError).toBe(true)
    expect(await read()).toEqual({ wall_loops: 4 })
    expect((await h.call('slicerx_project_set_overrides', { changes: { wall_loops: 7 }, clear: ['wall_loops'] })).isError).toBe(true)
    expect(await read()).toEqual({ wall_loops: 4 })
  } finally { await h.client.close() }
})
