// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { appPaintTools } from '../src/app-paint'
import type { AppLinkCaller } from '../src/app-route'
import { createContext, createSlicerxServer } from '../src/index'

it('exposes all four live paint calls to an SDK client and preserves refusal codes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-paint-client-'))
  const call = vi.fn(async (method: string, args: Record<string, unknown>) => {
    if (args['preview'] === 'stale') throw Object.assign(new Error('Preview changed'), { code: 'busy' })
    return { summary: 'Paint state', output: { method, args, revision: 'r1', parts: [] } }
  })
  const ctx = await createContext({ engine: 'sx', printers: 'off', outDir: dir, profilesDir: join(dir, 'profiles') })
  expect(ctx.tools.filter((t) => t.name.startsWith('app.paint'))).toHaveLength(4)
  ctx.tools = appPaintTools({ call } as AppLinkCaller, 'SlicerX')
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'paint-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    expect((await client.listTools()).tools.filter((t) => t.name.startsWith('slicerx_app_paint'))).toHaveLength(4)
    for (const [name, method, args] of [
      ['app_paint', 'paint.get', { object: 'body', layer: 'color' }],
      ['app_paint_preview', 'paint.preview', { object: 'body', layer: 'seam', state: 1, target: { kind: 'part' } }],
      ['app_paint_apply', 'paint.apply', { preview: 'p1' }],
      ['app_paint_clear', 'paint.clear', { object: 'body', layer: 'seam', revision: 'r1' }],
    ] as const) {
      expect(await client.callTool({ name: `slicerx_${name}`, arguments: args })).toMatchObject({ structuredContent: { output: { method, args } } })
      expect(call).toHaveBeenLastCalledWith(method, args)
    }
    expect(await client.callTool({ name: 'slicerx_app_paint_apply', arguments: { preview: 'stale' } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
  } finally { await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('requires the live link and preserves read-only grants', async () => {
  const missing = appPaintTools(undefined, 'SlicerX')
  for (const tool of missing) await expect(tool.run({} as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
  const denied = appPaintTools({ call: async () => { throw Object.assign(new Error('Read only'), { code: 'read_only' }) } }, 'SlicerX')
  expect(denied.map((t) => t.permission)).toEqual(['read', 'read', 'slice', 'slice'])
  await expect(denied[2]!.run({ preview: 'p1' } as never, {} as never)).rejects.toMatchObject({ code: 'not_supported' })
})
