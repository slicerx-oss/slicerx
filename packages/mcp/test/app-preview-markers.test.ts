// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { appPreviewMarkerTools } from '../src/app-preview-markers'
import type { AppLinkCaller } from '../src/app-route'
import { createContext, createSlicerxServer } from '../src/index'

it('lists both marker commands over the official SDK and reads changes back independently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-marker-client-'))
  const state = { sliced: true, toolpaths: true, markers: [{ kind: 'wipes', label: 'Wipes', shown: false, available: true, source: 'gcode' }] }
  const call = vi.fn(async (method: string, args: Record<string, unknown>) => {
    if (method === 'preview.markers_set') state.markers[0]!.shown = args['wipes'] as boolean
    return structuredClone(state)
  })
  const ctx = await createContext({ printers: 'off', outDir: dir, profilesDir: join(dir, 'profiles') })
  expect(ctx.tools.filter((t) => t.name.startsWith('app.preview_markers'))).toHaveLength(2)
  ctx.tools = appPreviewMarkerTools({ call } as AppLinkCaller, 'SlicerX')
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'marker-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    expect((await client.listTools()).tools.filter((t) => t.name.startsWith('slicerx_app_preview_markers')).map((t) => t.name)).toEqual(['slicerx_app_preview_markers', 'slicerx_app_preview_markers_set'])
    expect(await client.callTool({ name: 'slicerx_app_preview_markers_set', arguments: { wipes: true } })).toMatchObject({ structuredContent: { output: { markers: [expect.objectContaining({ shown: true })] } } })
    expect(call).toHaveBeenLastCalledWith('preview.markers_set', { wipes: true })
    expect(await client.callTool({ name: 'slicerx_app_preview_markers', arguments: {} })).toMatchObject({ structuredContent: { output: state } })
    const before = call.mock.calls.length
    for (const args of [{}, { wipes: 'yes' }, { wipes: true, other: true }]) expect(await client.callTool({ name: 'slicerx_app_preview_markers_set', arguments: args })).toMatchObject({ isError: true })
    expect(call).toHaveBeenCalledTimes(before)
  } finally { await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('keeps view commands read-only and preserves setup and app refusals', async () => {
  expect(appPreviewMarkerTools(undefined, 'SlicerX').map((t) => t.permission)).toEqual(['read', 'read'])
  for (const [code, expected] of [['not_ready', 'busy'], ['busy', 'busy'], ['refused', 'not_supported'], ['invalid_input', 'invalid_input'], ['unauthorized', 'not_configured']] as const) {
    const tools = appPreviewMarkerTools({ call: async () => { throw Object.assign(new Error('Unavailable'), { code }) } }, 'SlicerX')
    await expect(tools[1]!.run({ wipes: true } as never, {} as never)).rejects.toMatchObject({ code: expected })
  }
})
