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

const cases: [string, Record<string, unknown>][] = [
  ['cut', { plane: { axis: 'z', at: 4 } }],
  ['split', { build_volume_mm: [12, 12, 12] }],
  ['mirror', { plane: { axis: 'x', at: 20 } }],
  ['array', { spec: { kind: 'linear', count: 3, step: [25, 0, 0] } }],
  ['repair', {}],
  ['hollow', { wall_mm: 1 }],
  ['emboss', { text: 'X', point: [0, 0, 8], size_mm: 3, depth_mm: 1 }],
  ['build', { solids: [{ type: 'box', min: [0, 0, 0], max: [10, 10, 10] }] }],
  ['subtract', { solids: [{ type: 'box', min: [0, 0, 0], max: [2, 2, 2] }] }],
]

it('serves every live modeling command to an MCP client without a local engine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-modeling-client-'))
  const call = vi.fn(async () => ({ summary: 'Updated body', output: { design: 'body', steps: 2, volumeMm3: 800 } }))
  const ctx = await createContext({ engine: 'sx', printers: 'off', outDir: dir, profilesDir: join(dir, 'profiles') })
  ctx.tools = routeToApp(designToolset(NO_ENGINE_HOST), { call } as AppLinkCaller, 'SlicerX', { required: true })
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'modeling-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    for (const [name, args] of cases) {
      expect(await client.callTool({ name: `slicerx_geom_${name}`, arguments: { ...args, design: 'body' } })).toMatchObject({ structuredContent: { output: { in: 'app', design: 'body', steps: 2, volumeMm3: 800 } } })
      expect(call).toHaveBeenLastCalledWith(`geom.${name}`, expect.objectContaining({ ...args, design: 'body' }))
    }
    call.mockImplementation(async () => { throw Object.assign(new Error('read-only grant'), { code: 'read_only' }) })
    for (const [name, args] of cases) expect(await client.callTool({ name: `slicerx_geom_${name}`, arguments: { ...args, design: 'body' } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
    call.mockClear()
    for (const [name, args] of cases.filter(([name]) => name !== 'mirror')) await client.callTool({ name: `slicerx_geom_${name}`, arguments: { ...args, ...(name === 'build' ? {} : { model: 'part.stl' }) } })
    expect(call).not.toHaveBeenCalled()
  } finally { await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }) }
})
