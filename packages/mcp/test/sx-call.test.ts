// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// the native entry point runs the tool runtime, from source here, and reads the resulting design back.
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { built } from './helpers'

const run = promisify(execFile)
const pkg = resolve(__dirname, '..')
const sx = process.env['SLICERX_TEST_SX_BIN'] ?? resolve(pkg, '../../target/release', process.platform === 'win32' ? 'sx.exe' : 'sx')
// The runtime is the server's source, run through tsx as project-route-parity does: dist is git-ignored and nothing
// builds it here, so a built copy would be whatever an earlier build left behind. tsx is loaded by absolute URL because
// the calls run from temporary directories where a bare `--import tsx` would not resolve.
const runtime = resolve(pkg, 'src/cli.ts')
const tsx = pathToFileURL(createRequire(resolve(pkg, 'package.json')).resolve('tsx/esm')).href
const nodeOptions = `${process.env['NODE_OPTIONS'] ?? ''} --import ${tsx}`.trim()
const dirs: string[] = []
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx call-'))
  dirs.push(dir)
  return dir
}
const environment = (dir: string) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('SLICERX_') && k !== 'SX_TEST_HUB_PORT')) as Record<string, string>
  return { ...env, HOME: dir, USERPROFILE: dir, SLICERX_NODE_BIN: process.execPath, SLICERX_MCP_CLI: runtime, NODE_OPTIONS: nodeOptions }
}
const options = (dir: string) => ['--no-app', '--printers', 'off', '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles')]
type Line = { tool: string; ok: boolean; output: { output?: Record<string, unknown>; error?: { code: string } } }
const lines = (stdout: string) => stdout.trim().split('\n').map((line) => JSON.parse(line) as Line)

afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const ready = built(sx, 'build sx (cargo build -p sx-cli) and name it in SLICERX_TEST_SX_BIN')
describe.skipIf(!ready)('sx call with the tool runtime', () => {
  it('models through native geometry and reads back the same history and solid', async () => {
    const dir = temporary()
    const name = 'Bracket "A" & $(literal)'
    const calls = [
      ['design_new', { name }],
      ['geom_extrude', { design: 'd1', shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 }],
      ['design_edit_step', { design: 'd1', step: 1, value: 5 }],
      ['design_steps', { design: 'd1' }],
      ['geom_info', { design: 'd1' }],
    ] as const
    const { stdout } = await run(sx, ['call', ...options(dir), ...calls.flatMap(([tool, input]) => [tool, JSON.stringify(input)])], { env: environment(dir), cwd: dir })
    const result = lines(stdout)
    expect(result.map((r) => [r.tool, r.ok])).toEqual(calls.map(([tool]) => [`slicerx_${tool}`, true]))
    expect(result[0]!.output.output).toMatchObject({ name })
    expect(result[3]!.output.output).toMatchObject({ name, volumeMm3: 1000, steps: [{ index: 1, state: 'done', value: { value: 5 } }] })
    expect(result[4]!.output.output?.['parts']).toMatchObject([{ watertight: true, volumeMm3: expect.closeTo(1000, 6) }])
  }, 60_000)

  it('preserves a refused call and stops before the next tool', async () => {
    const dir = temporary()
    const result = await run(sx, ['call', ...options(dir), 'design_new', '{}', 'design_steps', '{"design":"missing"}', 'design_list'], { env: environment(dir), cwd: dir }).then(
      () => { throw new Error('The invalid design must fail') },
      (e: unknown) => e as { code: number; stdout: string },
    )
    expect(result.code).toBe(1)
    const output = lines(result.stdout)
    expect(output).toHaveLength(2)
    expect(output[1]).toMatchObject({ tool: 'slicerx_design_steps', ok: false, output: { error: { code: 'not_found' } } })
  }, 30_000)

  it('finds the nearest project package from a nested working directory', async () => {
    const dir = temporary()
    // sx looks for node_modules/@slicerx/mcp/dist/cli.js. This package's dist may be missing or stale, so the project's
    // copy is a stub that hands over to the source runtime; the test is about where sx finds it, not what it runs.
    const installed = join(dir, 'node_modules', '@slicerx', 'mcp')
    mkdirSync(join(installed, 'dist'), { recursive: true })
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: '@slicerx/mcp', type: 'module' }))
    writeFileSync(join(installed, 'dist', 'cli.js'), `await import(${JSON.stringify(pathToFileURL(runtime).href)})\n`)
    const cwd = join(dir, 'models with spaces')
    mkdirSync(cwd)
    const env: Record<string, string> = environment(dir)
    delete env['SLICERX_MCP_CLI']
    const { stdout } = await run(sx, ['call', ...options(dir), 'design_new', '{"name":"Discovered"}', 'design_list'], { cwd, env })
    expect(lines(stdout)[1]!.output.output?.['designs']).toMatchObject([{ name: 'Discovered', steps: 0 }])
  }, 30_000)

  it('reports explicit runtime and Node configuration errors without falling back', async () => {
    const dir = temporary()
    const result = await run(sx, ['call', 'design_list'], { cwd: pkg, env: { ...environment(dir), SLICERX_MCP_CLI: join(dir, 'missing.mjs') } }).then(
      () => { throw new Error('The missing runtime must fail') },
      (e: unknown) => e as { code: number; stdout: string; stderr: string },
    )
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('SLICERX_MCP_CLI is not a file')
    const missingNode = join(dir, 'missing-node')
    const nodeResult = await run(sx, ['call', 'design_list'], { cwd: dir, env: { ...environment(dir), SLICERX_NODE_BIN: missingNode } }).then(
      () => { throw new Error('The missing Node.js must fail') },
      (e: unknown) => e as { code: number; stdout: string; stderr: string },
    )
    expect(nodeResult.code).toBe(1)
    expect(nodeResult.stdout).toBe('')
    expect(nodeResult.stderr).toContain(`could not run Node.js (${missingNode})`)
  })

  it('passes app-only restrictions to the runtime instead of creating a local design', async () => {
    const dir = temporary()
    const result = await run(sx, ['call', '--app', '--printers', 'off', 'design_new', '{}'], { cwd: dir, env: environment(dir) }).then(
      () => { throw new Error('App-only calls must require the app link') },
      (e: unknown) => e as { code: number; stdout: string; stderr: string },
    )
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('--app works through sx-link')
  }, 30_000)

  it('explains usage without needing Node.js or an installed runtime', async () => {
    const dir = temporary()
    const env = { ...environment(dir), SLICERX_MCP_CLI: join(dir, 'missing.mjs'), SLICERX_NODE_BIN: join(dir, 'missing-node') }
    const { stdout } = await run(sx, ['call', '--help'], { cwd: dir, env })
    expect(stdout).toContain('usage: sx call')
    expect(stdout).toContain('SLICERX_MCP_CLI')
    const missing = await run(sx, ['call'], { cwd: dir, env }).then(() => null, (e: unknown) => e as { code: number; stderr: string })
    expect(missing).toMatchObject({ code: 2, stderr: expect.stringContaining('usage: sx call') })
  })
})
