// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client shells a design over stdio with the real geometry engine. A shell that would not store cleanly is refused at
// the shell step, in words about its wall, and the design keeps its body; a shell that stores goes through.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { built, GEOM_BUILD } from './helpers'

const PKG = resolve(__dirname, '..')
const bin = process.env['SLICERX_SX_GEOM_BIN'] ?? resolve(__dirname, '../../../target/release', process.platform === 'win32' ? 'sx-geom.exe' : 'sx-geom')

const textOf = (r: CallToolResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')

describe.skipIf(!built(bin, GEOM_BUILD))('shell refusals over stdio', () => {
  let client: Client
  let home: string

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'slicerx-shell-refusal-'))
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('SLICERX_')) env[k] = v
    env['HOME'] = home
    env['USERPROFILE'] = home
    const args = ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', '--no-app', '--printers', 'off', '--sx-geom-bin', bin, '--out-dir', join(home, 'out'), '--profiles-dir', join(home, 'profiles')]
    client = new Client({ name: 'shell-refusal', version: '1' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args, cwd: PKG, env, stderr: 'pipe' }))
  }, 60_000)

  afterAll(async () => {
    await client?.close()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult

  it('refuses at the shell a wall that would not store, and keeps the body', async () => {
    expect((await call('slicerx_design_new', { name: 'Far can' })).isError).toBeFalsy()
    // a cylinder a kilometer out along x, where stored positions step by 0.0625 mm
    const can = { type: 'cylinder', origin: [1e6, 0, 0], diameterMm: 30, heightMm: 30 }
    const built1 = await call('slicerx_geom_build', { design: 'd1', solids: [can] })
    expect(built1.isError, textOf(built1)).toBeFalsy()
    const r = await call('slicerx_geom_shell', { design: 'd1', open: [{ at: [1e6, 0, 30], normal: [0, 0, 1] }], wall_mm: 2 })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('Error: invalid_input: The step did not go through: A 2 mm wall does not work on this body, since its inner faces would cross once stored; try a wall a little thinner or thicker. The design is unchanged.')
    expect(textOf(r)).not.toMatch(/storage precision|cut or placement/)
    const steps = await call('slicerx_design_steps', { design: 'd1' })
    expect(steps.isError).toBeFalsy()
    expect(JSON.stringify(steps.structuredContent ?? textOf(steps))).not.toMatch(/Shell/)
  }, 120_000)

  it('shells a round body near the origin', async () => {
    expect((await call('slicerx_design_new', { name: 'Can' })).isError).toBeFalsy()
    const can = { type: 'cylinder', origin: [0, 0, 0], diameterMm: 30, heightMm: 30 }
    const built2 = await call('slicerx_geom_build', { design: 'd2', solids: [can] })
    expect(built2.isError, textOf(built2)).toBeFalsy()
    const r = await call('slicerx_geom_shell', { design: 'd2', open: [{ at: [0, 0, 30], normal: [0, 0, 1] }], wall_mm: 2 })
    expect(r.isError, textOf(r)).toBeFalsy()
  }, 120_000)
})
