// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { appPreviewPlaybackTools } from '../src/app-preview-playback'
import type { AppLinkCaller } from '../src/app-route'
import { createContext, createSlicerxServer } from '../src/index'

it('exposes playback over the official SDK and validates the full request before forwarding it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-playback-client-'))
  const state = { available: true, sliced: true, playing: false, timeS: 0, durationS: 120, speed: 1, followNozzle: false }
  const call = vi.fn(async (method: string, args: Record<string, unknown>) => {
    if (method === 'preview.playback_set') Object.assign(state, args)
    return structuredClone(state)
  })
  const ctx = await createContext({ printers: 'off', outDir: dir, profilesDir: join(dir, 'profiles') })
  expect(ctx.tools.filter((t) => t.name.startsWith('app.preview_playback'))).toHaveLength(2)
  ctx.tools = appPreviewPlaybackTools({ call } as AppLinkCaller, 'SlicerX')
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'playback-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    expect((await client.listTools()).tools.filter((t) => t.name.startsWith('slicerx_app_preview_playback')).map((t) => t.name)).toEqual(['slicerx_app_preview_playback', 'slicerx_app_preview_playback_set'])
    const args = { timeS: 30, playing: true, speed: 2, followNozzle: true }
    expect(await client.callTool({ name: 'slicerx_app_preview_playback_set', arguments: args })).toMatchObject({ structuredContent: { output: { ...state, ...args } } })
    expect(call).toHaveBeenLastCalledWith('preview.playback_set', args)
    expect(await client.callTool({ name: 'slicerx_app_preview_playback', arguments: {} })).toMatchObject({ structuredContent: { output: state } })
    const before = call.mock.calls.length
    for (const args of [{}, { speed: 3 }, { playing: 'yes' }, { timeS: -1 }, { playing: true, unknown: true }]) expect(await client.callTool({ name: 'slicerx_app_preview_playback_set', arguments: args })).toMatchObject({ isError: true })
    expect(call).toHaveBeenCalledTimes(before)
  } finally { await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('uses read grants and preserves missing-preview, busy, input and setup refusals', async () => {
  expect(appPreviewPlaybackTools(undefined, 'SlicerX').map((t) => t.permission)).toEqual(['read', 'read'])
  for (const [code, expected] of [['not_ready', 'busy'], ['busy', 'busy'], ['invalid_input', 'invalid_input'], ['unauthorized', 'not_configured']] as const) {
    const tools = appPreviewPlaybackTools({ call: async () => { throw Object.assign(new Error('Unavailable'), { code }) } }, 'SlicerX')
    await expect(tools[1]!.run({ playing: true } as never, {} as never)).rejects.toMatchObject({ code: expected })
  }
})
