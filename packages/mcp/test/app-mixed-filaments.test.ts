// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The open app's mixed filaments for clients: read them, set the list and read it back, over the official SDK and from
// the CLI, and the open project's mixes from the CLI with each answer read back.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { appMixTools } from '../src/app-mixes'
import type { AppLinkCaller } from '../src/app-route'
import { createContext, createSlicerxServer } from '../src/index'

type Mix = { id: number; name: string; components: [number, number]; ratio: [number, number] }

const cli = (dir: string, args: string[]) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SLICERX_')))
  return promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--printers', 'off', '--out-dir', dir, '--profiles-dir', join(dir, 'profiles'), 'call', ...args], { cwd: join(__dirname, '..'), env: { ...env, HOME: dir, USERPROFILE: dir } })
}

it('reads the mixes, sets the list and reads it back over the official SDK', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-mix-client-'))
  // The app's answer: its list, which a set replaces.
  let mixes: Mix[] = []
  const call = vi.fn(async (method: string, args: Record<string, unknown>) => {
    if (method === 'mixes.set') mixes = args['mixes'] as Mix[]
    return { mixes }
  })
  const ctx = await createContext({ printers: 'off', outDir: dir, profilesDir: join(dir, 'profiles') })
  expect(ctx.tools.filter((t) => t.name.startsWith('app.mixed_filaments')).map((t) => [t.name, t.permission])).toEqual([['app.mixed_filaments', 'read'], ['app.mixed_filaments_set', 'slice']])
  ctx.tools = appMixTools({ call } as AppLinkCaller, 'SlicerX')
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'mix-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    const sunset: Mix = { id: 32, name: 'Sunset', components: [1, 2], ratio: [2, 1] }
    const set = await client.callTool({ name: 'slicerx_app_mixed_filaments_set', arguments: { mixes: [sunset] } })
    expect(call).toHaveBeenLastCalledWith('mixes.set', { mixes: [sunset] })
    expect(set).toMatchObject({ structuredContent: { output: { mixes: [sunset] } } })
    const read = await client.callTool({ name: 'slicerx_app_mixed_filaments', arguments: {} })
    expect(call).toHaveBeenLastCalledWith('mixes.get', {})
    expect(read).toMatchObject({ structuredContent: { output: { mixes: [sunset] } } })
    // Bad input never reaches the app: a number below the ones mixes take, past 32, a ratio side of 0, five mixes.
    const before = call.mock.calls.length
    for (const list of [[{ ...sunset, id: 28 }], [{ ...sunset, id: 33 }], [{ ...sunset, ratio: [0, 1] }], [32, 31, 30, 29, 28].map((id) => ({ ...sunset, id }))]) {
      expect(await client.callTool({ name: 'slicerx_app_mixed_filaments_set', arguments: { mixes: list } })).toMatchObject({ isError: true })
    }
    expect(call).toHaveBeenCalledTimes(before)
  } finally {
    await client.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('reaches the app commands from the CLI, which refuses them while no app is linked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-mix-cli-'))
  try {
    for (const [tool, args] of [['app_mixed_filaments', {}], ['app_mixed_filaments_set', { mixes: [] }]] as const) {
      const result = await cli(dir, [tool, JSON.stringify(args)]).then(
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

it("adds a mix to the open project and puts an object on it from the CLI, each step read back", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-mix-cli-project-'))
  try {
    const { stdout } = await cli(dir, [
      'project_open', JSON.stringify({ printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' }),
      'project_add_filament', JSON.stringify({ color: '#0000ff' }),
      'project_add_model', JSON.stringify({ model: 'sample:cube-20' }),
      'project_add_mixed_filament', JSON.stringify({ filaments: [1, 2], ratio: [2, 1], name: 'Sunset' }),
      'project_set_object_filament', JSON.stringify({ objectId: 'obj-1', filament: 32 }),
      'project_mixed_filaments', '{}',
    ])
    const answers = stdout.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as { tool: string; ok: boolean; output: Record<string, unknown> })
    const by = (tool: string) => answers.find((r) => r.tool === `slicerx_${tool}`)
    expect(by('project_add_mixed_filament')).toMatchObject({ ok: true, output: { output: { mix: { id: 32, name: 'Sunset', components: [1, 2], ratio: [2, 1] } } } })
    expect(by('project_set_object_filament')).toMatchObject({ ok: true, output: { output: { objectId: 'obj-1', filament: 32, filaments: [32] } } })
    expect(by('project_mixed_filaments')).toMatchObject({ ok: true, output: { output: { mixes: [{ id: 32, name: 'Sunset', cycle: [1, 1, 2] }] } } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
