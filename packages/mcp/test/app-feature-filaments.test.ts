// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The open app's feature filament table for clients: read it, set rows, and read the table back, over the official SDK
// and from the CLI.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { appFeatureFilamentTools } from '../src/app-feature-filaments'
import type { AppLinkCaller } from '../src/app-route'
import { createContext, createSlicerxServer } from '../src/index'

const FEATURES = ['outerWall', 'innerWall', 'sparseInfill', 'internalSolid', 'topSurface', 'bottomSurface', 'support', 'supportInterface']

it('reads the table, sets a row and reads it back over the official SDK', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-ff-client-'))
  // The app's answer: the table for the scope asked, with what the set changed.
  const values: Record<string, number> = {}
  const call = vi.fn(async (method: string, args: Record<string, unknown>) => {
    if (method === 'feature_filaments.set') Object.assign(values, args['filaments'])
    const scope = Array.isArray(args['objects']) ? { kind: 'objects', objects: args['objects'] } : { kind: 'plate' }
    return { summary: 'table', output: { scope, rows: FEATURES.map((feature) => ({ feature, value: values[feature] ?? 0, source: feature in values ? 'own' : 'plate', changed: feature in values, printedWith: null })) } }
  })
  const ctx = await createContext({ printers: 'off', outDir: dir, profilesDir: join(dir, 'profiles') })
  expect(ctx.tools.filter((t) => t.name.startsWith('app.feature_filaments')).map((t) => [t.name, t.permission])).toEqual([['app.feature_filaments', 'read'], ['app.feature_filaments_set', 'slice']])
  ctx.tools = appFeatureFilamentTools({ call } as AppLinkCaller, 'SlicerX')
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'feature-filament-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    expect((await client.listTools()).tools.map((t) => t.name).filter((n) => n.includes('feature_filaments'))).toEqual(['slicerx_app_feature_filaments', 'slicerx_app_feature_filaments_set'])
    const set = await client.callTool({ name: 'slicerx_app_feature_filaments_set', arguments: { objects: ['obj-1'], filaments: { sparseInfill: 2 } } })
    expect(call).toHaveBeenLastCalledWith('feature_filaments.set', { objects: ['obj-1'], filaments: { sparseInfill: 2 } })
    expect(set).toMatchObject({ structuredContent: { output: { scope: { kind: 'objects', objects: ['obj-1'] }, rows: expect.arrayContaining([{ feature: 'sparseInfill', value: 2, source: 'own', changed: true, printedWith: null }]) } } })
    const read = await client.callTool({ name: 'slicerx_app_feature_filaments', arguments: {} })
    expect(call).toHaveBeenLastCalledWith('feature_filaments.get', {})
    expect(read).toMatchObject({ structuredContent: { output: { scope: { kind: 'plate' } } } })
    // Bad input never reaches the app.
    const before = call.mock.calls.length
    for (const args of [{}, { filaments: {} }, { filaments: { outerWall: -1 } }, { filaments: { outerWall: 1.5 } }, { filaments: { outerWall: 1 }, other: true }]) {
      expect(await client.callTool({ name: 'slicerx_app_feature_filaments_set', arguments: args })).toMatchObject({ isError: true })
    }
    expect(call).toHaveBeenCalledTimes(before)
  } finally {
    await client.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it("keeps the app's refusals and says how to reach the app", async () => {
  for (const [code, expected] of [['not_found', 'not_found'], ['busy', 'busy'], ['invalid_input', 'invalid_input'], ['unauthorized', 'not_configured'], ['app_closed', 'not_configured']] as const) {
    const tools = appFeatureFilamentTools({ call: async () => { throw Object.assign(new Error('No'), { code }) } }, 'SlicerX')
    await expect(tools[1]!.run({ filaments: { outerWall: 1 } } as never, {} as never)).rejects.toMatchObject({ code: expected })
  }
  await expect(appFeatureFilamentTools(undefined, 'SlicerX')[0]!.run({} as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
})

it('reaches both commands from the CLI, which refuses them while no app is linked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-ff-cli-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SLICERX_')))
  try {
    for (const [tool, args] of [['app_feature_filaments', {}], ['app_feature_filaments_set', { filaments: { support: 2 } }]] as const) {
      const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--printers', 'off', '--out-dir', dir, '--profiles-dir', join(dir, 'profiles'), 'call', tool, JSON.stringify(args)], { cwd: join(__dirname, '..'), env: { ...env, HOME: dir, USERPROFILE: dir } }).then(
        () => { throw new Error('The missing app must fail') },
        (e: unknown) => e as { code: number; stdout: string },
      )
      expect(result.code).toBe(1)
      expect(JSON.parse(result.stdout.trim())).toMatchObject({ tool: `slicerx_${tool}`, ok: false, output: { error: { code: 'not_configured' } } })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
