// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { appPreviewGcodeTools } from '../src/app-preview-gcode'
import type { AppLinkCaller } from '../src/app-route'
import { createContext, createSlicerxServer } from '../src/index'

it('forwards line reads, continuations and jumps through the official SDK and returns independent read-back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-gcode-client-'))
  const output = { source: { kind: 'slice', id: 's1' }, totalLines: 100, panelOpen: true, mapped: true, requestedLine: 8, currentLine: 8, fromLine: 8, byteOffset: 0, layer: 1, moveShare: 0.25, lines: [{ number: 8, text: 'G1 X1', byteOffset: 0, truncated: false }], next: { fromLine: 9, byteOffset: 0 }, bytesRead: 6, maxBytes: 65536 }
  const call = vi.fn(async () => structuredClone(output))
  const ctx = await createContext({ printers: 'off', outDir: dir, profilesDir: join(dir, 'profiles') })
  expect(ctx.tools.filter((t) => t.name.startsWith('app.preview_gcode'))).toHaveLength(2)
  ctx.tools = appPreviewGcodeTools({ call } as AppLinkCaller, 'SlicerX')
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'gcode-reader', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    expect((await client.listTools()).tools.filter((t) => t.name.startsWith('slicerx_app_preview_gcode')).map((t) => t.name)).toEqual(['slicerx_app_preview_gcode', 'slicerx_app_preview_gcode_jump'])
    for (const [name, method, args] of [
      ['slicerx_app_preview_gcode_jump', 'preview.gcode_jump', { line: 8, count: 1 }],
      ['slicerx_app_preview_gcode', 'preview.gcode', { fromLine: 8, byteOffset: 65532, count: 2 }],
      ['slicerx_app_preview_gcode', 'preview.gcode', {}],
    ] as const) {
      expect(await client.callTool({ name, arguments: args })).toMatchObject({ structuredContent: { output } })
      expect(call).toHaveBeenLastCalledWith(method, args)
    }
    const before = call.mock.calls.length
    for (const args of [{ fromLine: 0 }, { count: 201 }, { byteOffset: 1 }, { fromLine: 1, byteOffset: -1 }, { path: 'anything.gcode' }]) expect(await client.callTool({ name: 'slicerx_app_preview_gcode', arguments: args })).toMatchObject({ isError: true })
    for (const args of [{}, { line: 1.5 }, { line: 0 }, { line: 1, count: 0 }]) expect(await client.callTool({ name: 'slicerx_app_preview_gcode_jump', arguments: args })).toMatchObject({ isError: true })
    expect(call).toHaveBeenCalledTimes(before)
  } finally { await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('uses read grants and maps unsupported, stale, input and connection refusals', async () => {
  expect(appPreviewGcodeTools(undefined, 'SlicerX').map((t) => t.permission)).toEqual(['read', 'read'])
  for (const [code, expected] of [['refused', 'not_supported'], ['busy', 'busy'], ['not_ready', 'busy'], ['invalid_input', 'invalid_input'], ['unauthorized', 'not_configured']] as const) {
    const tools = appPreviewGcodeTools({ call: async () => { throw Object.assign(new Error('Unavailable'), { code }) } }, 'SlicerX')
    await expect(tools[0]!.run({} as never, {} as never)).rejects.toMatchObject({ code: expected })
  }
})
