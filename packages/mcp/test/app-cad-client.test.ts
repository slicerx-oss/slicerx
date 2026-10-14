// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { routeToApp, type AppLinkCaller } from '../src/app-route'
import { createContext, createSlicerxServer } from '../src/index'
import { designToolset, NO_ENGINE_HOST } from '../src/toolset'

it('routes shell and geometry readback through an MCP client without a local engine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-app-cad-'))
  const call = vi.fn(async (name: string) => {
    if (name === 'geom.shell') throw Object.assign(new Error('read-only grant'), { code: 'read_only' })
    return { summary: 'Measured body', output: name === 'geom.info' ? { design: 'body', parts: [{ volumeMm3: 600 }] } : { measurement: { distanceMm: 3 } } }
  })
  const ctx = await createContext({ engine: 'sx', printers: 'off', outDir: dir, profilesDir: join(dir, 'profiles') })
  ctx.tools = routeToApp(designToolset(NO_ENGINE_HOST), { call } as AppLinkCaller, 'SlicerX', { required: true })
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'cad-inspect-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    expect(await client.callTool({ name: 'slicerx_geom_info', arguments: { design: 'body', step: 1 } })).toMatchObject({ structuredContent: { output: { in: 'app', parts: [{ volumeMm3: 600 }] } } })
    expect(call).toHaveBeenLastCalledWith('geom.info', { design: 'body', step: 1 })
    expect(await client.callTool({ name: 'slicerx_geom_measure', arguments: { design: 'body', a: { at: [0, 0, 3], normal: [0, 0, 1] } } })).toMatchObject({ structuredContent: { output: { in: 'app', measurement: { distanceMm: 3 } } } })
    expect(await client.callTool({ name: 'slicerx_geom_shell', arguments: { design: 'body', wall_mm: 1 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
    call.mockClear()
    for (const name of ['info', 'measure', 'shell']) {
      await client.callTool({ name: `slicerx_geom_${name}`, arguments: { model: 'part.stl', a: { at: [0, 0, 3] }, wall_mm: 1 } })
    }
    expect(call).not.toHaveBeenCalled()
  } finally { await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }) }
})
