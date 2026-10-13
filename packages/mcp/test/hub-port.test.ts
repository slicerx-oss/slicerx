// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// `slicerx-mcp --printers link` with no hub address goes to the port a test or dev run names in SX_TEST_HUB_PORT, the
// variable the app's test and dev builds and sx-link read, so a run on its own port never reaches the hub on 47615.
// --link-url and SLICERX_MCP_LINK_URL still win. A listener stands in for the hub and records who knocked.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const stateDir = mkdtempSync(join(tmpdir(), 'sx-mcp-hub-port-'))

/** A listener that counts WebSocket upgrades, then drops them, so the client fails fast after knocking. */
async function knockCounter(): Promise<{ server: Server; port: number; knocks: () => number }> {
  let n = 0
  const server = createServer((_req, res) => res.writeHead(404).end())
  server.on('upgrade', (_req, socket) => {
    n += 1
    socket.destroy()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { server, port: (server.address() as AddressInfo).port, knocks: () => n }
}

/** Runs the CLI as a client would, with only the link variables this test sets. */
function cli(args: string[], env: Record<string, string>) {
  const base = { ...process.env }
  for (const k of ['SX_TEST_HUB_PORT', 'SLICERX_MCP_LINK_URL', 'SLICERX_MCP_LINK_KEY', 'SLICERX_MCP_LINK_KEY_REF', 'SLICERX_MCP_LINK_HUB_KEY']) delete base[k]
  return run(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', '--printers', 'link', ...args, 'call', 'design_list'], {
    cwd: resolve(__dirname, '..'),
    env: { ...base, SLICERX_MCP_LINK_CODE: 'AGNT-CODE', SLICERX_MCP_LINK_STATE_DIR: stateDir, ...env },
  }).then(
    () => ({ code: 0, stderr: '' }),
    (e: { code: number; stderr: string }) => ({ code: e.code, stderr: e.stderr }),
  )
}

describe('the hub port of a test or dev run', () => {
  let a: Awaited<ReturnType<typeof knockCounter>>
  let b: Awaited<ReturnType<typeof knockCounter>>
  beforeAll(async () => {
    a = await knockCounter()
    b = await knockCounter()
  })
  afterAll(() => {
    a.server.close()
    b.server.close()
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('takes the client to the port SX_TEST_HUB_PORT names', async () => {
    const before = a.knocks()
    const out = await cli([], { SX_TEST_HUB_PORT: String(a.port) })
    expect(out.code).not.toBe(0)
    expect(a.knocks()).toBeGreaterThan(before)
  }, 30_000)

  it('lets --link-url and SLICERX_MCP_LINK_URL win over it', async () => {
    const [beforeA, beforeB] = [a.knocks(), b.knocks()]
    await cli(['--link-url', `ws://127.0.0.1:${b.port}`], { SX_TEST_HUB_PORT: String(a.port) })
    await cli([], { SX_TEST_HUB_PORT: String(a.port), SLICERX_MCP_LINK_URL: `ws://127.0.0.1:${b.port}` })
    expect(a.knocks()).toBe(beforeA)
    expect(b.knocks()).toBe(beforeB + 2)
  }, 60_000)
})
