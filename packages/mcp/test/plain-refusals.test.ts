// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client calls a tool the server doesn't have, or a real tool with arguments its input schema rejects, over stdio
// and over HTTP, the two ways clients reach the server. The refusal is a tool result with isError, as before, and its
// text reads plainly: no "MCP error <code>: " in front, the prefix the MCP SDK puts on its own errors. Requests the
// protocol itself refuses still come back as JSON-RPC errors with their codes.
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema, ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { DEFAULT_POLICY } from '@slicerx/contracts'
import { createContext, createSlicerxServer, startHttp } from '../src/index'

const PKG = resolve(__dirname, '..')
const TOKEN = 'b'.repeat(16) + 'plain-refusals-0123456789'

const textOf = (r: CallToolResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')

/** The process environment of the stdio server: nothing from the caller's own setup, and a home of its own. */
function runEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('SLICERX_') && k !== 'SX_TEST_HUB_PORT') env[k] = v
  env['HOME'] = home
  env['USERPROFILE'] = home
  return env
}

/** The JSON-RPC code a request was refused with, or undefined when it was answered. */
async function rpcCode(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (e: unknown) => (e instanceof McpError ? e.code : -1),
  )
}

function refusals(name: string, client: () => Client): void {
  describe(name, () => {
    it('refuses an unknown tool as a tool result, in plain words', async () => {
      const r = (await client().callTool({ name: 'slicerx_no_such_tool', arguments: {} })) as CallToolResult
      expect(r.isError).toBe(true)
      expect(textOf(r)).toBe('Tool slicerx_no_such_tool not found')
    })

    it('refuses arguments the input schema rejects, in plain words', async () => {
      const r = (await client().callTool({ name: 'slicerx_explain_setting', arguments: { key: 5 } })) as CallToolResult
      expect(r.isError).toBe(true)
      expect(textOf(r)).toMatch(/^Input validation error: Invalid arguments for tool slicerx_explain_setting: /)
      expect(textOf(r)).not.toMatch(/MCP error -?\d+/)
    })

    it('keeps JSON-RPC errors and their codes for what the protocol refuses', async () => {
      // tools/call without a tool name (the SDK answers a request it can't parse with InternalError), and a method the
      // server doesn't have.
      expect(await rpcCode(client().request({ method: 'tools/call', params: { arguments: {} } } as never, CallToolResultSchema))).toBe(ErrorCode.InternalError)
      expect(await rpcCode(client().request({ method: 'slicerx/no_such_method', params: {} } as never, CallToolResultSchema))).toBe(ErrorCode.MethodNotFound)
    })

    it('leaves a tool that works, and our own refusals, as they were', async () => {
      const ok = (await client().callTool({ name: 'slicerx_explain_setting', arguments: { key: 'layer_height' } })) as CallToolResult
      expect(ok.isError).toBeFalsy()
      const own = (await client().callTool({ name: 'slicerx_explain_setting', arguments: { key: 'no_such_setting_here' } })) as CallToolResult
      expect(own.isError).toBe(true)
      expect(textOf(own)).toMatch(/^Error: invalid_settings: Unknown setting "no_such_setting_here"\./)
      expect(own.structuredContent).toMatchObject({ error: { code: 'invalid_settings' } })
    })
  })
}

describe('plain refusals', () => {
  let stdio: Client
  let httpClient: Client
  let http: Server
  let home: string

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'slicerx-plain-refusals-'))
    stdio = new Client({ name: 'plain-refusals-stdio', version: '1' })
    const args = ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', '--printers', 'off', '--out-dir', join(home, 'out'), '--profiles-dir', join(home, 'profiles')]
    await stdio.connect(new StdioClientTransport({ command: process.execPath, args, cwd: PKG, env: runEnv(home), stderr: 'pipe' }))

    const ctx = await createContext({ engine: 'stub', allowDirs: [], policy: DEFAULT_POLICY })
    // Port 0: a free port of the system's choosing, so this never meets another server.
    http = await startHttp(() => createSlicerxServer(ctx, { pending: new Map() }), { host: '127.0.0.1', port: 0, token: TOKEN })
    const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`)
    httpClient = new Client({ name: 'plain-refusals-http', version: '1' })
    await httpClient.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }) as unknown as Transport)
  }, 60_000)

  afterAll(async () => {
    await stdio?.close()
    await httpClient?.close()
    await new Promise<void>((done) => {
      if (!http) return done()
      http.closeAllConnections()
      http.close(() => done())
    })
    if (home) rmSync(home, { recursive: true, force: true })
  })

  refusals('over stdio', () => stdio)
  refusals('over HTTP', () => httpClient)
})
