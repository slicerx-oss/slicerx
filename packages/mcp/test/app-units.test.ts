// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { appUnitTools, type AppUnits } from '../src/app-units'
import type { AppLinkCaller } from '../src/app-route'
import { createContext, createSlicerxServer } from '../src/index'

it('lists and calls display preferences through the official SDK and reads back independently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-unit-client-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  let state: AppUnits = { available: true, length: 'mm', mmDigits: 2, inchDigits: 3, inchFraction: 0, precision: { decimals: 2 }, millimetersPerUnit: 1, dataUnit: 'mm' }
  const call = vi.fn(async (method: string) => {
    if (method === 'units.set') state = { ...state, length: 'in', inchFraction: 32, precision: { fraction: 32 }, millimetersPerUnit: 25.4 }
    return state
  })
  const ctx = await createContext({ printers: 'off', outDir: dir, profilesDir: join(dir, 'profiles'), policyFile })
  expect(ctx.tools.filter((t) => t.name === 'app.units' || t.name === 'app.units_set')).toHaveLength(2)
  ctx.tools = appUnitTools({ call } as AppLinkCaller, 'SlicerX')
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'display-client', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(['slicerx_app_units', 'slicerx_app_units_set']))
    const input = { length: 'in', precision: { fraction: 32 } }
    const result = await client.callTool({ name: 'slicerx_app_units_set', arguments: input })
    expect(result.isError).not.toBe(true)
    expect(call).toHaveBeenLastCalledWith('units.set', input)
    const read = await client.callTool({ name: 'slicerx_app_units', arguments: {} })
    expect(read.structuredContent).toMatchObject({ output: { length: 'in', precision: { fraction: 32 }, dataUnit: 'mm' } })
    const count = call.mock.calls.length
    for (const bad of [{}, { length: 'ft' }, { precision: { fraction: 8 } }, { precision: { decimals: 2, fraction: 16 } }, { length: 'in', printer: 'external' }]) expect(await client.callTool({ name: 'slicerx_app_units_set', arguments: bad })).toMatchObject({ isError: true })
    expect(call).toHaveBeenCalledTimes(count)
  } finally { await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('uses the existing read grant and preserves unavailable and invalid-input refusals', async () => {
  expect(appUnitTools(undefined, 'SlicerX').map((t) => t.permission)).toEqual(['read', 'read'])
  await expect(appUnitTools(undefined, 'SlicerX')[0]!.run({} as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
  for (const [code, expected] of [['invalid_input', 'invalid_input'], ['refused', 'not_supported'], ['unauthorized', 'not_configured'], ['app_closed', 'not_configured']] as const) {
    const tools = appUnitTools({ call: async () => { throw Object.assign(new Error(code), { code }) } }, 'SlicerX')
    await expect(tools[1]!.run({ length: 'in' } as never, {} as never)).rejects.toMatchObject({ code: expected })
  }
})
