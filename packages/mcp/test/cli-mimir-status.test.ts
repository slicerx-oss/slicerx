// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// `slicerx-mcp --mimir-cloud-status`, run as a client runs it: stdout is always one JSON object, an error included.
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const cli = (args: string[], env: Record<string, string> = {}) =>
  run(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', ...args], { cwd: resolve(__dirname, '..'), env: { ...process.env, SLICERX_MCP_LINK_CODE: 'AGNT-CODE', ...env } }).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => e,
  )

/** A loopback port nothing listens on. */
const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => done(port))
    })
  })

describe('slicerx-mcp --mimir-cloud-status', () => {
  it('prints a JSON error and exits 1 while sx-link does not answer', async () => {
    const e = await cli(['--link-url', `ws://127.0.0.1:${await freePort()}`, '--mimir-cloud-status'])
    expect(e.code).toBe(1)
    const out = JSON.parse(e.stdout.trim()) as { error: { code: string; message: string } }
    expect(out).toEqual({ error: { code: 'not_configured', message: expect.stringMatching(/sx-link/) } })
    expect(e.stdout.trim().split('\n')).toHaveLength(1)
    expect(e.stdout).not.toContain('AGNT-CODE')
  }, 30_000)

  it('reads through sx-link only, and runs on its own', async () => {
    const demo = await cli(['--printers', 'demo', '--mimir-cloud-status'])
    expect(demo.code).toBe(1)
    expect(JSON.parse(demo.stdout.trim())).toEqual({ error: { code: 'not_configured', message: '--mimir-cloud-status reads the open app through sx-link, so --printers must be link, not demo' } })
    const both = await cli(['--mimir-cloud-status', 'call', 'project_show'])
    expect(both.code).toBe(1)
    expect(JSON.parse(both.stdout.trim()).error.message).toMatch(/runs on its own/)
  }, 30_000)

  it('is in the help, with the shape it prints', async () => {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--help'], { cwd: resolve(__dirname, '..') })
    expect(stdout).toContain('slicerx-mcp --mimir-cloud-status prints')
    expect(stdout).toContain('{"cloud", "enabled", "signed_in", "needs_sign_in", "quota", "quota_error"}')
  }, 30_000)
})

describe('slicerx-mcp call mimir_tab', () => {
  it('prints one JSON line a client reads, saying where the tab is read from', async () => {
    const e = await cli(['--printers', 'demo', 'call', 'mimir_tab'])
    expect(e.code).toBe(1)
    const out = JSON.parse(e.stdout.trim()) as { tool: string; ok: boolean; output: { error: { code: string; message: string } } }
    expect(out).toMatchObject({ tool: 'slicerx_mimir_tab', ok: false, output: { error: { code: 'not_configured', message: expect.stringMatching(/--printers link/) } } })
    expect(e.stdout.trim().split('\n')).toHaveLength(1)
  }, 30_000)
})
