// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// `slicerx-mcp call --app`: the flags that cannot work together are refused before anything runs.
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const cli = (args: string[], env: Record<string, string> = {}) =>
  run(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', ...args], { cwd: resolve(__dirname, '..'), env: { ...process.env, ...env } }).then(
    () => null,
    (e: { code: number; stdout: string; stderr: string }) => e,
  )

describe('slicerx-mcp call --app', () => {
  it('refuses printers other than sx-link', async () => {
    const e = await cli(['--printers', 'demo', 'call', '--app', 'design_new', '{"name":"Clip"}'])
    expect(e?.code).toBe(1)
    expect(e?.stdout).toBe('')
    expect(e?.stderr).toMatch(/--app works through sx-link, so --printers must be link, not demo/)
  }, 30_000)

  it('refuses --app with --no-app, from flags or the environment', async () => {
    for (const [args, env] of [
      [['call', '--app', '--no-app', 'design_list'], {}],
      [['call', 'design_list'], { SLICERX_MCP_APP: '1', SLICERX_MCP_NO_APP: '1' }],
    ] as const) {
      const e = await cli([...args], env)
      expect(e?.code).toBe(1)
      expect(e?.stderr).toMatch(/--app and --no-app cannot both be set/)
    }
  }, 30_000)

  it('lists --app in the help', async () => {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--help'], { cwd: resolve(__dirname, '..') })
    expect(stdout).toMatch(/--app {2,}run the design tools only in the project open in the app/)
    expect(stdout).toContain(`slicerx-mcp call --app design_new '{"name":"Clip"}' design_list`)
  }, 30_000)
})

describe('slicerx-mcp call design_timeline and design_roll', () => {
  // the design tools need the geometry engine binary (SLICERX_SX_GEOM_BIN); without it they are not listed
  const bin = process.env['SLICERX_SX_GEOM_BIN']
  it.skipIf(!bin)('reads the timeline here, and says rolling back needs the app', async () => {
    const env = { SLICERX_SX_GEOM_BIN: bin ?? '' }
    const out = await run(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', '--no-app', 'call', 'design_timeline'], { cwd: resolve(__dirname, '..'), env: { ...process.env, ...env } })
    const line = JSON.parse(out.stdout.trim().split('\n').at(-1)!) as { ok: boolean; output: { output: { marker: number; end: number } } }
    expect(line).toMatchObject({ ok: true, output: { output: { marker: 0, end: 0 } } })
    const e = await cli(['--no-app', 'call', 'design_roll', '{"marker":0}'], env)
    expect(e?.code).toBe(1)
    expect(e?.stdout).toMatch(/turn on the app link/)
  }, 30_000)
})
