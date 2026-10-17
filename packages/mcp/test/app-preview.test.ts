// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { appPreviewTools, type AppPreview } from '../src/app-preview'
import type { AppLinkCaller } from '../src/app-route'
import { createContext, createSlicerxServer } from '../src/index'

it('lists the preview commands to an SDK client, forwards view settings and reads back the result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-preview-client-'))
  let state: AppPreview = { sliced: true, toolpaths: true, camera: 'iso', toolhead: true, gantry: false, rightPane: 'open', drawer: 'shut', layers: 10, range: [1, 10], oneLayer: false, topZMm: 2, colorMode: 'feature' }
  const call = vi.fn(async (method: string, args: Record<string, unknown>) => {
    if (method === 'preview.set') state = { ...state, ...args }
    return state
  })
  const ctx = await createContext({ printers: 'off', outDir: dir, profilesDir: join(dir, 'profiles') })
  expect(ctx.tools.filter((t) => t.name.startsWith('app.preview'))).toHaveLength(2)
  ctx.tools = appPreviewTools({ call } as AppLinkCaller, 'SlicerX')
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'preview-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    expect((await client.listTools()).tools.filter((t) => t.name.startsWith('slicerx_app_preview')).map((t) => t.name)).toEqual(['slicerx_app_preview', 'slicerx_app_preview_set'])
    expect(await client.callTool({ name: 'slicerx_app_preview', arguments: {} })).toMatchObject({ structuredContent: { output: state } })
    const changes = { range: [2, 6], camera: 'front', colorMode: 'speed', toolhead: false, gantry: true }
    expect(await client.callTool({ name: 'slicerx_app_preview_set', arguments: changes })).toMatchObject({ structuredContent: { output: changes } })
    expect(call).toHaveBeenLastCalledWith('preview.set', changes)
    expect(await client.callTool({ name: 'slicerx_app_preview', arguments: {} })).toMatchObject({ structuredContent: { output: changes } })
    const before = call.mock.calls.length
    for (const invalid of [{}, { layer: 0 }, { layer: 1.5 }, { range: [5, 2] }, { range: [1] }, { camera: 'side' }, { oneLayer: 'yes' }, { toolhead: true, extra: true }]) {
      expect(await client.callTool({ name: 'slicerx_app_preview_set', arguments: invalid })).toMatchObject({ isError: true })
    }
    expect(call).toHaveBeenCalledTimes(before)
  } finally { await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('requires the live link, keeps view calls in the read class and preserves app refusals', async () => {
  const missing = appPreviewTools(undefined, 'SlicerX')
  expect(missing.map((t) => t.permission)).toEqual(['read', 'read'])
  for (const tool of missing) await expect(tool.run({ camera: 'top' } as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
  for (const [code, expected] of [['busy', 'busy'], ['not_ready', 'busy'], ['invalid_input', 'invalid_input'], ['app_closed', 'not_configured'], ['forbidden', 'not_configured']] as const) {
    const tools = appPreviewTools({ call: async () => { throw Object.assign(new Error('Preview unavailable'), { code }) } }, 'SlicerX')
    await expect(tools[1]!.run({ camera: 'top' } as never, {} as never)).rejects.toMatchObject({ code: expected })
  }
})
