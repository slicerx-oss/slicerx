// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { appPickFilterTools } from '../src/app-pick-filter'
import type { AppLinkCaller } from '../src/app-route'
import { createContext, createSlicerxServer } from '../src/index'

it('exposes the filter over the official SDK, forwards commands and independently reads app state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-pick-filter-client-'))
  const output = { available: true, pickFilter: ['edge'], primary: 'part', objects: [{ id: 'part', name: 'Bracket' }], picks: [] }
  const call = vi.fn(async () => structuredClone(output))
  const ctx = await createContext({ printers: 'off', outDir: dir, profilesDir: join(dir, 'profiles') })
  expect(ctx.tools.filter((t) => t.name.startsWith('app.pick_filter'))).toHaveLength(2)
  ctx.tools = appPickFilterTools({ call } as AppLinkCaller, 'SlicerX')
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'pick-filter-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    expect((await client.listTools()).tools.filter((t) => t.name.startsWith('slicerx_app_pick_filter')).map((t) => t.name)).toEqual(['slicerx_app_pick_filter', 'slicerx_app_pick_filter_set'])
    const args = { kind: 'edge', mode: 'only' }
    expect(await client.callTool({ name: 'slicerx_app_pick_filter_set', arguments: args })).toMatchObject({ structuredContent: { output } })
    expect(call).toHaveBeenLastCalledWith('select.filter_set', args)
    expect(await client.callTool({ name: 'slicerx_app_pick_filter', arguments: {} })).toMatchObject({ structuredContent: { output } })
    expect(call).toHaveBeenLastCalledWith('select.filter', {})
    const before = call.mock.calls.length
    for (const args of [{}, { kind: 'body' }, { kind: 'face', mode: 'add' }, { kind: 'edge', unknown: true }]) expect(await client.callTool({ name: 'slicerx_app_pick_filter_set', arguments: args })).toMatchObject({ isError: true })
    expect(call).toHaveBeenCalledTimes(before)
  } finally { await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('uses read grants and preserves busy, invalid-input and setup refusals', async () => {
  expect(appPickFilterTools(undefined, 'SlicerX').map((t) => t.permission)).toEqual(['read', 'read'])
  for (const [code, expected] of [['busy', 'busy'], ['invalid_input', 'invalid_input'], ['unauthorized', 'not_configured']] as const) {
    const tools = appPickFilterTools({ call: async () => { throw Object.assign(new Error('Unavailable'), { code }) } }, 'SlicerX')
    await expect(tools[1]!.run({ kind: 'edge' } as never, {} as never)).rejects.toMatchObject({ code: expected })
  }
})
