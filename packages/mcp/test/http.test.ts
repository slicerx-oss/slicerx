// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { AddressInfo } from 'node:net'
import { request, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { DEFAULT_POLICY } from '@slicerx/contracts'
import { createContext, createSlicerxServer, startHttp } from '../src/index'

let http: Server
let base: string
const TOKEN = 'a'.repeat(16) + 'test-token-0123456789'

beforeAll(async () => {
  const ctx = await createContext({ engine: 'stub', allowDirs: [], policy: DEFAULT_POLICY })
  // As the CLI does: one pending map per session.
  http = await startHttp(() => createSlicerxServer(ctx, { pending: new Map() }), { host: '127.0.0.1', port: 0, token: TOKEN })
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
})

afterAll(
  () =>
    new Promise<void>((resolve) => {
      http.closeAllConnections()
      http.close(() => resolve())
    }),
)

/** fetch cannot set Host, so the rebinding case uses node:http directly. */
function postWithHost(host: string): Promise<number> {
  const { port } = http.address() as AddressInfo
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { ...headers, host, authorization: `Bearer ${TOKEN}` } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    r.on('error', reject)
    r.end(init)
  })
}

async function session(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } })
  const client = new Client({ name: 'http-test', version: '0.0.0' })
  await client.connect(transport as unknown as Transport)
  return client
}

const structured = <T>(r: unknown): T => (r as CallToolResult).structuredContent as T

const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } })

describe('streamable HTTP', () => {
  it('serves tools to an MCP client with the token', async () => {
    const client = await session()
    const tools = await client.listTools()
    expect(tools.tools.length).toBeGreaterThan(8)
    const r = await client.callTool({ name: 'slicerx_explain_setting', arguments: { key: 'layer_height' } })
    expect(r.isError).toBeFalsy()
    await client.close()
  })

  it('refuses every request without the right token, on loopback too', async () => {
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers, body: init })).status).toBe(401)
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body: init })).status).toBe(401)
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${TOKEN}x` }, body: init })).status).toBe(401)
    expect((await fetch(`${base}/mcp`, { method: 'GET', headers })).status).toBe(401)
  })

  it('refuses DNS rebinding: a foreign Host or Origin, even with the token', async () => {
    const auth = { ...headers, authorization: `Bearer ${TOKEN}` }
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...auth, origin: 'https://evil.example' }, body: init })).status).toBe(403)
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...auth, origin: 'http://127.0.0.1.evil.example' }, body: init })).status).toBe(403)
    expect(await postWithHost('evil.example')).toBe(403)
    expect(await postWithHost(`evil.example:${(http.address() as AddressInfo).port}`)).toBe(403)
    expect((await fetch(`${base}/other`, { method: 'POST', headers: auth, body: init })).status).toBe(404)
  })

  it('refuses an unknown session id', async () => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${TOKEN}`, 'mcp-session-id': 'not-a-session' }, body: init })
    expect(r.status).toBe(404)
  })

  it('keeps approval requests inside the session that raised them', async () => {
    const owner = await session()
    const other = await session()
    const req = structured<{ status: string; request_id: string }>(await owner.callTool({ name: 'slicerx_printer_pause', arguments: { printerId: 'bay-1' } }))
    expect(req.status).toBe('approval_required')

    // Another session cannot see the request or approve it.
    expect(structured<{ pending: unknown[] }>(await other.callTool({ name: 'slicerx_pending_approvals', arguments: {} })).pending).toEqual([])
    const stolen = (await other.callTool({ name: 'slicerx_approve', arguments: { request_id: req.request_id, approve: true } })) as CallToolResult
    expect(stolen.isError).toBe(true)
    const state = structured<{ output: { state: string } }>(await other.callTool({ name: 'slicerx_printer_status', arguments: { printerId: 'bay-1' } }))
    expect(state.output.state).toBe('printing')

    // The session that raised it still can.
    expect(structured<{ pending: { request_id: string }[] }>(await owner.callTool({ name: 'slicerx_pending_approvals', arguments: {} })).pending.map((p) => p.request_id)).toEqual([req.request_id])
    const done = (await owner.callTool({ name: 'slicerx_approve', arguments: { request_id: req.request_id, approve: true } })) as CallToolResult
    expect(done.isError).toBeFalsy()
    await owner.close()
    await other.close()
  })

  it('refuses to start without a long enough token', async () => {
    const ctx = await createContext({ engine: 'stub', policy: DEFAULT_POLICY })
    await expect(startHttp(() => createSlicerxServer(ctx), { host: '127.0.0.1', port: 0, token: '' })).rejects.toThrow(/bearer token/)
    await expect(startHttp(() => createSlicerxServer(ctx), { host: '0.0.0.0', port: 0, token: 'short' })).rejects.toThrow(/bearer token/)
  })
})
