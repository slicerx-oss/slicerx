// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { appDimensionTools } from '../src/app-dimensions'
import type { AppLinkCaller } from '../src/app-route'
import { createContext, createSlicerxServer } from '../src/index'

it('lists and invokes kept dimension commands through the official SDK with independent read-back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-dimension-client-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  let shown = false
  let kept = false
  const call = vi.fn(async (method: string) => {
    if (method === 'dimensions.keep') kept = true
    if (method === 'dimensions.remove') kept = false
    if (method === 'dimensions.show') shown = true
    return { plate: 'one', showAll: shown, dimensions: kept ? [{ id: 'd1', kind: 'distance', value: 20, status: 'ok' }] : [] }
  })
  const ctx = await createContext({ printers: 'off', outDir: dir, profilesDir: join(dir, 'profiles'), policyFile })
  expect(ctx.tools.filter((t) => /^app\.(dimensions|dimension_)/.test(t.name))).toHaveLength(4)
  ctx.tools = appDimensionTools({ call } as AppLinkCaller, 'SlicerX')
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'dimension-editor', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const pick = { object: 'box', part: 0, triangle: 2, at: [100, 100, 20] }
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    expect((await client.listTools()).tools.filter((t) => t.name.startsWith('slicerx_app_dimension'))).toHaveLength(4)
    const invoke = async (name: string, args = {}) => {
      const result = await client.callTool({ name: `slicerx_app_${name}`, arguments: args })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return result.structuredContent
    }
    await invoke('dimension_keep', { kind: 'distance', a: pick, b: { ...pick, triangle: 0, at: [100, 100, 0] } })
    expect(await invoke('dimensions')).toMatchObject({ output: { dimensions: [{ id: 'd1', value: 20 }] } })
    await invoke('dimensions_show', { showAll: true })
    expect(await invoke('dimensions')).toMatchObject({ output: { showAll: true } })
    await invoke('dimension_remove', { dimension: 'd1' })
    expect(await invoke('dimensions')).toMatchObject({ output: { dimensions: [] } })
    const count = call.mock.calls.length
    for (const args of [{ kind: 'distance', a: pick }, { kind: 'length', a: pick, b: pick }, { kind: 'length', a: pick, value: 10 }, { kind: 'length', a: { ...pick, triangle: -1 } }]) expect(await client.callTool({ name: 'slicerx_app_dimension_keep', arguments: args })).toMatchObject({ isError: true })
    expect(call).toHaveBeenCalledTimes(count)
  } finally { await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('keeps read and edit grants separate and preserves refusal codes', async () => {
  expect(appDimensionTools(undefined, 'SlicerX').map((t) => t.permission)).toEqual(['read', 'slice', 'slice', 'read'])
  for (const [code, expected] of [['read_only', 'not_supported'], ['refused', 'not_supported'], ['busy', 'busy'], ['not_found', 'not_found'], ['unauthorized', 'not_configured']] as const) {
    const tools = appDimensionTools({ call: async () => { throw Object.assign(new Error(code), { code }) } }, 'SlicerX')
    await expect(tools[0]!.run({} as never, {} as never)).rejects.toMatchObject({ code: expected })
  }
})
